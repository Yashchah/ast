import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexArgs, codexErrorMessage, codexTimeoutMs, compareVersions } from '../src/codex';
import { extractJson } from '../src/llm';
import { EscalationLessonSchema, RevealSchema } from '../src/schemas';

test('exec args: isolated, read-only, schema-constrained, prompt on stdin', () => {
  const args = codexArgs({ model: 'gpt-6.1-sol', effort: 'low', fast: true }, '/tmp/d', '/tmp/d/s.json', '/tmp/d/o.json');
  assert.equal(args[0], 'exec');
  for (const flag of ['--ignore-user-config', '--ephemeral', '--skip-git-repo-check']) assert.ok(args.includes(flag), flag);
  const after = (f: string) => args[args.indexOf(f) + 1];
  assert.equal(after('--sandbox'), 'read-only');
  assert.equal(after('-C'), '/tmp/d');
  assert.equal(after('-m'), 'gpt-6.1-sol');
  assert.equal(after('--output-schema'), '/tmp/d/s.json');
  assert.equal(after('-o'), '/tmp/d/o.json');
  assert.ok(args.includes('model_reasoning_effort=low'));
  assert.ok(args.includes('service_tier=priority'));
  assert.equal(args.at(-1), '-');
});

test('fast off omits the priority tier', () => {
  const args = codexArgs({ model: 'm', effort: 'high', fast: false }, 'd', 's', 'o');
  assert.ok(!args.some((a) => a.startsWith('service_tier')));
  assert.ok(args.includes('model_reasoning_effort=high'));
});

test('timeouts: the standard tier (background calls) gets room for large structured answers', () => {
  // A medium PlanOutline (~3.1k output tokens) ran 100 s and once past 180 s on the standard tier.
  assert.ok(codexTimeoutMs('medium', false) >= 400_000);
  assert.ok(codexTimeoutMs('low', false) >= 400_000);
  assert.ok(codexTimeoutMs('high', false) > codexTimeoutMs('medium', false));
  // Priority tier (calls the learner waits on) keeps the short limits.
  assert.equal(codexTimeoutMs('medium', true), 180_000);
  assert.equal(codexTimeoutMs('high', true), 300_000);
});

test('extractJson: bare Codex JSON whose strings hold markdown fences parses whole', () => {
  // A live EscalationLesson came back as valid JSON with a fenced example and was rejected as
  // 'did not match the expected format' because the fence was searched for first.
  const lesson = { title: 'T', explanation: 'x', example: "```python\nd = {}\nd['a'] = 1\nprint(d)\n```\nOutput: {'a': 1}", rule: 'r' };
  assert.deepEqual(extractJson(JSON.stringify(lesson)), lesson);
  assert.equal(EscalationLessonSchema.safeParse(extractJson(`${JSON.stringify(lesson, null, 2)}\n`)).success, true);
  const reveal = { explanation: 'Use a dict.', code: '```js\nconst m = {};\n```', rebuildChallenge: 'Count letters.' };
  assert.equal(RevealSchema.safeParse(extractJson(JSON.stringify(reveal))).success, true);
  // Chatty providers (vscode-lm): a ```json block, prose around one object, or a plain fence.
  assert.deepEqual(extractJson('Here you go:\n```json\n{"a": 1}\n```\nDone.'), { a: 1 });
  assert.deepEqual(extractJson('Sure. {"a": {"b": "```x```"}} Hope that helps.'), { a: { b: '```x```' } });
  assert.deepEqual(extractJson('```\n{"a": 2}\n```'), { a: 2 });
  assert.equal(extractJson('no json here'), undefined);
});

test('error messages are actionable', () => {
  const unsupported = 'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6.1-sol\' model is not supported when using Codex with a ChatGPT account."}}';
  assert.match(codexErrorMessage(unsupported, 1), /too old.*codexPath/);
  assert.match(codexErrorMessage('ERROR: {"error":{"message":"You have hit your usage limit"}}', 1), /plan limit/);
  assert.match(codexErrorMessage('Error: Not logged in', 1), /Sign in to Codex/);
  const generic = codexErrorMessage('ERROR codex_core: failed to load skill X\nsomething broke\n', 2);
  assert.match(generic, /code 2: something broke/);
  assert.doesNotMatch(generic, /failed to load skill/);
});

test('version comparison picks the newest client', () => {
  assert.ok(compareVersions([0, 159, 2], [0, 147, 0]) > 0);
  assert.ok(compareVersions([1, 0, 0], [0, 160, 0]) > 0);
  assert.equal(compareVersions([0, 1, 2], [0, 1, 2]), 0);
});
