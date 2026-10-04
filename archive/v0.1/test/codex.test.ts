import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexArgs, codexErrorMessage, compareVersions } from '../src/codex';

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
