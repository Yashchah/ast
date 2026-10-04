import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { CodexError, codexTimeoutMs, resolveCodexBin, runCodex } from './codex';

export type Effort = 'low' | 'medium' | 'high';

export interface JsonRequest<S extends z.ZodType> {
  system: string;
  prompt: string;
  schema: S;
  effort?: Effort;
}

export interface JsonOptions {
  /** Aborts the call: the Codex process tree is killed, HTTP requests are cancelled. */
  signal?: AbortSignal;
  /** Codex priority service tier. undefined = deliberate.codexFast (foreground calls); false for every bg call. */
  fast?: boolean;
  /** A background call: vscode-lm checks canSendRequest first. Defaults to fast === false. */
  background?: boolean;
}

export const SECRET_KEY = 'deliberate.anthropicApiKey';

// Models that accept the server-side refusal fallback ("default" mode).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

/** limit: the plan/usage limit was hit (the bg lane pauses); auth: sign-in or key problem; format: unusable output. */
export type LlmErrorKind = 'limit' | 'auth' | 'format' | 'other';

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: LlmErrorKind = 'other',
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** Kind of a CodexError, from the sentence codexErrorMessage() produced. */
export function codexErrorKind(message: string): LlmErrorKind {
  if (/^Codex plan limit reached/i.test(message)) return 'limit';
  if (/not signed in|codex login/i.test(message)) return 'auth';
  return 'other';
}

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

  /** lmAccess: ExtensionContext.languageModelAccessInformation (vscode-lm background consent). */
  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly lmAccess?: vscode.LanguageModelAccessInformation,
  ) {}

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

  async json<S extends z.ZodType>(req: JsonRequest<S>, opts: JsonOptions = {}): Promise<z.infer<S>> {
    opts.signal?.throwIfAborted();
    const cfg = this.config();
    switch (cfg.provider) {
      case 'vscode-lm':
        return this.viaVscodeLm(req, cfg.lmFamily, opts);
      case 'anthropic':
        return this.viaAnthropic(req, cfg.model, opts.signal);
      default:
        return this.viaCodex(req, cfg, opts);
    }
  }

  /**
   * vscode-lm only: a background sendRequest must follow a user action, so Start (a user action)
   * makes one tiny request that lets VS Code ask for consent. Other providers need nothing.
   * Resolves true when background calls may run.
   */
  async ensureBackgroundConsent(): Promise<boolean> {
    const cfg = this.config();
    if (cfg.provider !== 'vscode-lm') return true;
    try {
      const [model] = await vscode.lm.selectChatModels(cfg.lmFamily ? { family: cfg.lmFamily } : {});
      if (!model) return false;
      if (this.lmAccess?.canSendRequest(model) === true) return true;
      const cts = new vscode.CancellationTokenSource();
      try {
        const res = await model.sendRequest(
          [vscode.LanguageModelChatMessage.User('Reply with OK.')],
          { justification: 'Deliberate prepares your next exercises in the background while you work.' },
          cts.token,
        );
        for await (const chunk of res.text) void chunk;
      } finally {
        cts.dispose();
      }
      return this.lmAccess ? this.lmAccess.canSendRequest(model) === true : true;
    } catch {
      return false;
    }
  }

  private async viaCodex<S extends z.ZodType>(
    req: JsonRequest<S>,
    cfg: { codexModel: string; codexFast: boolean; codexPath: string },
    opts: JsonOptions,
  ): Promise<z.infer<S>> {
    const { $schema: _drop, ...schema } = z.toJSONSchema(req.schema) as Record<string, unknown>;
    try {
      const bin = await resolveCodexBin(cfg.codexPath);
      const effort = req.effort ?? 'medium';
      // Nobody waits on bg calls, so they never spend priority-tier plan usage.
      const fast = opts.fast ?? cfg.codexFast;
      const out = await runCodex(
        { bin, model: cfg.codexModel, effort, fast, timeoutMs: codexTimeoutMs(effort, fast) },
        req.system,
        req.prompt,
        schema,
        opts.signal,
      );
      const parsed = req.schema.safeParse(extractJson(out));
      if (!parsed.success) throw new LlmError('Codex returned output that did not match the expected format. Try again.', 'format');
      return parsed.data;
    } catch (err) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      if (err instanceof CodexError) throw new LlmError(err.message, codexErrorKind(err.message));
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

  private async viaAnthropic<S extends z.ZodType>(req: JsonRequest<S>, model: string, signal?: AbortSignal): Promise<z.infer<S>> {
    const supportsEffort = !/haiku/.test(model);
    const useFallback = FALLBACK_MODELS.has(model);
    try {
      const client = await this.anthropic();
      const response = await client.beta.messages.parse(
        {
          model,
          max_tokens: 16000,
          ...(useFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: req.prompt }],
          output_config: {
            ...(supportsEffort ? { effort: req.effort ?? 'medium' } : {}),
            format: betaZodOutputFormat(req.schema),
          },
        },
        { signal },
      );
      if (response.stop_reason === 'refusal') {
        throw new LlmError('The model declined this request. Try rephrasing.');
      }
      if (response.stop_reason === 'max_tokens') {
        throw new LlmError('The response was cut off (max_tokens). Try again with a narrower request.', 'format');
      }
      if (response.parsed_output == null) {
        throw new LlmError('The model returned output that did not match the expected format.', 'format');
      }
      return response.parsed_output as z.infer<S>;
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      if (err instanceof LlmError) throw err;
      if (err instanceof Anthropic.AuthenticationError) {
        throw new LlmError('Anthropic API key missing or invalid. Run "Deliberate: Set Anthropic API Key".', 'auth');
      }
      if (err instanceof Anthropic.RateLimitError) {
        throw new LlmError('Rate limited by the Anthropic API. Wait a moment and retry.', 'limit');
      }
      if (err instanceof Anthropic.APIConnectionError) {
        throw new LlmError('Could not reach the Anthropic API. Check your connection.');
      }
      if (err instanceof Anthropic.APIError) {
        const kind: LlmErrorKind =
          err.status === 429 || /credit balance/i.test(err.message) ? 'limit' : err.status === 403 ? 'auth' : 'other';
        throw new LlmError(`Anthropic API error ${err.status ?? ''}: ${err.message}`, kind);
      }
      if (err instanceof Error && /api key|apiKey|authentication/i.test(err.message)) {
        throw new LlmError('No Anthropic API key found. Run "Deliberate: Set Anthropic API Key".', 'auth');
      }
      throw err;
    }
  }

  private async viaVscodeLm<S extends z.ZodType>(req: JsonRequest<S>, family: string, opts: JsonOptions): Promise<z.infer<S>> {
    const models = await vscode.lm.selectChatModels(family ? { family } : {});
    if (!models.length) {
      throw new LlmError('No VS Code language model available. Install/sign in to a chat extension (e.g. Copilot) or switch deliberate.provider to "anthropic".');
    }
    const model = models[0];
    const background = opts.background ?? opts.fast === false;
    // Background requests need consent granted earlier from a user action (ensureBackgroundConsent).
    if (background && this.lmAccess && this.lmAccess.canSendRequest(model) !== true) {
      throw new LlmError('VS Code has not allowed background use of this language model yet; skipped.', 'auth');
    }
    const schemaText = JSON.stringify(z.toJSONSchema(req.schema));
    const base =
      `${req.system}\n\n---\n\n${req.prompt}\n\n---\n\n` +
      `Respond with ONLY a JSON object (no prose, no code fences) matching this JSON Schema:\n${schemaText}`;
    const cts = new vscode.CancellationTokenSource();
    const onAbort = () => cts.cancel();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let prompt = base;
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {}, cts.token);
        let text = '';
        for await (const chunk of res.text) text += chunk;
        const parsed = req.schema.safeParse(extractJson(text));
        if (parsed.success) return parsed.data;
        prompt = `${base}\n\nYour previous reply was invalid: ${parsed.error.message.slice(0, 800)}\nReturn corrected JSON only.`;
      }
      throw new LlmError('The language model did not return valid JSON. Try again or switch provider.', 'format');
    } catch (err) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      if (err instanceof LlmError) throw err;
      const kind = lmErrorKind(err);
      if (kind) throw new LlmError(`Language model error: ${(err as Error).message}`, kind);
      throw err;
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      cts.dispose();
    }
  }
}

/** vscode.LanguageModelError code -> kind. Blocked means the requester hit its quota/limit. */
function lmErrorKind(err: unknown): LlmErrorKind | undefined {
  const LmError = vscode.LanguageModelError as typeof vscode.LanguageModelError | undefined;
  if (!LmError || !(err instanceof LmError)) return undefined;
  if (err.code === LmError.Blocked.name) return 'limit';
  if (err.code === LmError.NoPermissions.name) return 'auth';
  return 'other';
}

/**
 * The JSON object in a model reply. Codex (--output-schema) returns bare JSON whose string fields
 * may themselves hold markdown fences (a lesson example, a Reveal snippet, a rung-4 skeleton), so the
 * whole text is tried first and a fence is only looked for when that fails (chatty vscode-lm replies:
 * a ```json block, or prose around one object).
 */
export function extractJson(text: string): unknown {
  const parse = (s: string | undefined): unknown => {
    if (s === undefined) return undefined;
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  const braces = (s: string): unknown => {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    return start >= 0 && end > start ? parse(s.slice(start, end + 1)) : undefined;
  };
  const t = (text ?? '').trim();
  const whole = parse(t);
  if (whole !== undefined) return whole;
  const json = /```json\s*([\s\S]*?)```/i.exec(t);
  const fromJsonFence = json ? braces(json[1]) : undefined;
  if (fromJsonFence !== undefined) return fromJsonFence;
  const outer = braces(t);
  if (outer !== undefined) return outer;
  const fence = /```\w*\s*([\s\S]*?)```/.exec(t);
  return fence ? braces(fence[1]) : undefined;
}
