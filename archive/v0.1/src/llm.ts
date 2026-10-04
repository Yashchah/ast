import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { CodexError, resolveCodexBin, runCodex } from './codex';

export type Effort = 'low' | 'medium' | 'high';

export interface JsonRequest<S extends z.ZodType> {
  system: string;
  prompt: string;
  schema: S;
  effort?: Effort;
}

export const SECRET_KEY = 'deliberate.anthropicApiKey';

// Models that accept the server-side refusal fallback ("default" mode).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

export class LlmError extends Error {}

/**
 * Small provider abstraction: every coach call asks for JSON matching a zod schema.
 * - "codex" (default): `codex exec` with --output-schema, billed to the ChatGPT/Codex plan.
 * - "anthropic": Claude API with structured outputs (constrained decoding).
 * - "vscode-lm": any chat model exposed through VS Code's Language Model API
 *   (e.g. GitHub Copilot), prompted for JSON and validated with zod.
 */
export class Llm {
  private client: Anthropic | undefined;
  private clientKey: string | undefined;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  private config() {
    const c = vscode.workspace.getConfiguration('deliberate');
    return {
      provider: c.get<'codex' | 'anthropic' | 'vscode-lm'>('provider', 'codex'),
      model: c.get<string>('model', 'claude-opus-5-5'),
      lmFamily: c.get<string>('vscodeLmFamily', ''),
      codexModel: c.get<string>('codexModel', 'gpt-6.1-sol'),
      codexFast: c.get<boolean>('codexFast', true),
      codexPath: c.get<string>('codexPath', ''),
    };
  }

  async json<S extends z.ZodType>(req: JsonRequest<S>, token?: vscode.CancellationToken): Promise<z.infer<S>> {
    const cfg = this.config();
    switch (cfg.provider) {
      case 'vscode-lm':
        return this.viaVscodeLm(req, cfg.lmFamily, token);
      case 'anthropic':
        return this.viaAnthropic(req, cfg.model);
      default:
        return this.viaCodex(req, cfg);
    }
  }

  private async viaCodex<S extends z.ZodType>(
    req: JsonRequest<S>,
    cfg: { codexModel: string; codexFast: boolean; codexPath: string },
  ): Promise<z.infer<S>> {
    const { $schema: _drop, ...schema } = z.toJSONSchema(req.schema) as Record<string, unknown>;
    try {
      const bin = await resolveCodexBin(cfg.codexPath);
      const effort = req.effort ?? 'medium';
      const out = await runCodex(
        { bin, model: cfg.codexModel, effort, fast: cfg.codexFast, timeoutMs: effort === 'high' ? 300_000 : 180_000 },
        req.system,
        req.prompt,
        schema,
      );
      const parsed = req.schema.safeParse(extractJson(out));
      if (!parsed.success) throw new LlmError('Codex returned output that did not match the expected format. Try again.');
      return parsed.data;
    } catch (err) {
      if (err instanceof CodexError) throw new LlmError(err.message);
      throw err;
    }
  }

  private async anthropic(): Promise<Anthropic> {
    const stored = await this.secrets.get(SECRET_KEY);
    const key = stored || process.env.ANTHROPIC_API_KEY;
    if (!this.client || this.clientKey !== key) {
      // With no stored key, the SDK falls back to env vars / `ant auth login` profiles.
      this.client = key ? new Anthropic({ apiKey: key }) : new Anthropic();
      this.clientKey = key;
    }
    return this.client;
  }

  private async viaAnthropic<S extends z.ZodType>(req: JsonRequest<S>, model: string): Promise<z.infer<S>> {
    const client = await this.anthropic();
    const supportsEffort = !/haiku/.test(model);
    const useFallback = FALLBACK_MODELS.has(model);
    try {
      const response = await client.beta.messages.parse({
        model,
        max_tokens: 16000,
        ...(useFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: req.prompt }],
        output_config: {
          ...(supportsEffort ? { effort: req.effort ?? 'medium' } : {}),
          format: betaZodOutputFormat(req.schema),
        },
      });
      if (response.stop_reason === 'refusal') {
        throw new LlmError('The model declined this request. Try rephrasing.');
      }
      if (response.stop_reason === 'max_tokens') {
        throw new LlmError('The response was cut off (max_tokens). Try again with a narrower request.');
      }
      if (response.parsed_output == null) {
        throw new LlmError('The model returned output that did not match the expected format.');
      }
      return response.parsed_output as z.infer<S>;
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (err instanceof Anthropic.AuthenticationError) {
        throw new LlmError('Anthropic API key missing or invalid. Run "Deliberate: Set Anthropic API Key".');
      }
      if (err instanceof Anthropic.RateLimitError) {
        throw new LlmError('Rate limited by the Anthropic API. Wait a moment and retry.');
      }
      if (err instanceof Anthropic.APIConnectionError) {
        throw new LlmError('Could not reach the Anthropic API. Check your connection.');
      }
      if (err instanceof Anthropic.APIError) {
        throw new LlmError(`Anthropic API error ${err.status ?? ''}: ${err.message}`);
      }
      if (err instanceof Error && /api key|apiKey|authentication/i.test(err.message)) {
        throw new LlmError('No Anthropic API key found. Run "Deliberate: Set Anthropic API Key".');
      }
      throw err;
    }
  }

  private async viaVscodeLm<S extends z.ZodType>(
    req: JsonRequest<S>,
    family: string,
    token?: vscode.CancellationToken,
  ): Promise<z.infer<S>> {
    const models = await vscode.lm.selectChatModels(family ? { family } : {});
    if (!models.length) {
      throw new LlmError('No VS Code language model available. Install/sign in to a chat extension (e.g. Copilot) or switch deliberate.provider to "anthropic".');
    }
    const model = models[0];
    const schemaText = JSON.stringify(z.toJSONSchema(req.schema));
    const base =
      `${req.system}\n\n---\n\n${req.prompt}\n\n---\n\n` +
      `Respond with ONLY a JSON object (no prose, no code fences) matching this JSON Schema:\n${schemaText}`;
    let prompt = base;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {},
        token ?? new vscode.CancellationTokenSource().token,
      );
      let text = '';
      for await (const chunk of res.text) text += chunk;
      const parsed = req.schema.safeParse(extractJson(text));
      if (parsed.success) return parsed.data;
      prompt = `${base}\n\nYour previous reply was invalid: ${parsed.error.message.slice(0, 800)}\nReturn corrected JSON only.`;
    }
    throw new LlmError('The language model did not return valid JSON. Try again or switch provider.');
  }
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
