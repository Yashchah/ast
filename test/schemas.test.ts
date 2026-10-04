import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { FailureSignature, GatePattern, GatePlan, SpecItem, TaskInterface } from '../src/contracts';
import * as S from '../src/schemas';

// Every exported zod schema must convert for both providers: Codex (z.toJSONSchema) and the
// Anthropic structured-output helper. Constrained decoding needs every property required.

const schemas = Object.entries(S as Record<string, unknown>).filter((e): e is [string, z.ZodType] => e[1] instanceof z.ZodType);

const NEW_SCHEMAS = [
  'AtomPackSchema', 'MisconceptionGuessSchema', 'EscalationLessonSchema', 'PlanOutlineSchema', 'TaskOutSchema',
  'TaskBatchSchema', 'TaskPrepSchema', 'GatePartSchema', 'SpecLadderPartSchema', 'SpecItemSchema', 'HintLadderSchema',
  'OwnCodeProbeSchema', 'ConceptSchema',
];

/** Every object node in a JSON schema, with its path. */
function objects(node: unknown, path = '$', out: { path: string; node: Record<string, unknown> }[] = []) {
  if (Array.isArray(node)) node.forEach((n, i) => objects(n, `${path}[${i}]`, out));
  else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (o.type === 'object') out.push({ path, node: o });
    for (const [k, v] of Object.entries(o)) objects(v, `${path}.${k}`, out);
  }
  return out;
}

test('the new v0.2 schemas are all exported', () => {
  const names = new Set(schemas.map(([n]) => n));
  for (const n of NEW_SCHEMAS) assert.ok(names.has(n), `${n} is exported`);
});

for (const [name, schema] of schemas) {
  test(`${name} converts with z.toJSONSchema and betaZodOutputFormat`, () => {
    const json = z.toJSONSchema(schema) as Record<string, unknown>;
    assert.equal(json.type, 'object');
    const format = betaZodOutputFormat(schema) as unknown as { type: string; schema: Record<string, unknown> };
    assert.equal(format.type, 'json_schema');
    assert.ok(format.schema && typeof format.schema === 'object');
    // All fields required, no optional properties (the constrained-decoding convention).
    for (const { path, node } of objects(json)) {
      const props = Object.keys((node.properties as Record<string, unknown>) ?? {});
      assert.deepEqual([...((node.required as string[]) ?? [])].sort(), props.sort(), `${name} ${path}: every property required`);
      assert.equal(node.additionalProperties, false, `${name} ${path}: closed object`);
    }
  });
}

test('AtomPackSchema parses a full atom and rejects a missing field', () => {
  const atom = {
    conceptId: 'list-slicing', tag: 'list-slicing',
    pattern: { kind: 'shape', name: 'Slice a sequence', useWhen: 'part of a list', template: 'xs[<a>:<b>]', rule: '', howItRuns: '', pitfall: 'stop excluded', useCases: ['a', 'b', 'c', 'd', 'e', 'f'] },
    probes: [{ id: 'p1', siblingGroup: 'names', code: 'print([1, 2, 3][1:2])', answer: '[2]', parSec: 5,
      mutants: [{ misconceptionId: 'slice-end-included', belief: 'stop is included', refutation: 'stop is left out', code: 'print([1, 2, 3][1:3])', prints: '[2, 3]' }] }],
    example: { code: '', subgoals: [] },
    completion: { code: '', solutions: [], wrongFills: [], harness: '', parSec: 0 },
    contrast: { wrong: '', right: '', misconceptionId: '', rule: '' },
  };
  assert.equal(S.AtomPackSchema.parse({ atoms: [atom] }).atoms[0].probes[0].mutants[0].prints, '[2, 3]');
  const { example: _drop, ...noExample } = atom;
  assert.throws(() => S.AtomPackSchema.parse({ atoms: [noExample] }));
});

test('ConceptSchema has tag; the v0.1 PlanSchema and its tag-less concepts are gone (stage 2)', () => {
  const c = { id: 'x', name: 'X', description: 'd', prerequisites: [] };
  assert.throws(() => S.ConceptSchema.parse(c));
  assert.equal(S.ConceptSchema.parse({ ...c, tag: 'other' }).tag, 'other');
  for (const gone of ['PlanSchema', 'DiagnosticSchema', 'LessonSchema', 'RecallSchema']) assert.equal(gone in S, false, gone);
  assert.throws(() => S.PlanOutlineSchema.parse({ summary: 's', milestones: [], concepts: [c], milestone1Tasks: [] }));
});

test('zod outputs stay assignable to the shared contracts', () => {
  // Compile-time checks: these fail typecheck when a schema drifts from src/contracts.ts.
  const spec: SpecItem = {} as S.SpecItemOut;
  const sig: FailureSignature = {} as S.SpecItemOut['failureSignatures'][number];
  const pat: GatePattern = {} as S.GatePart['patterns'][number];
  const plan: GatePlan = {} as S.GatePart['plans'][number];
  const iface: TaskInterface = {} as S.TaskOut['interface'];
  assert.ok([spec, sig, pat, plan, iface].length === 5);
});

test('HintLadderSchema, TaskPrepSchema and OwnCodeProbeSchema parse sample outputs', () => {
  const ladder = S.HintLadderSchema.parse({
    diagnosis: 'd', stuckType: 'concept-gap', conceptIds: ['a'], misconceptionId: '', mistakePattern: '',
    anchor: { file: 'cli.py', line: 3, lineText: 'x = 1' }, rungs: [{ rung: 1, text: 'Which line?' }],
  });
  assert.equal(ladder.anchor.line, 3);
  assert.throws(() => S.HintLadderSchema.parse({ ...ladder, stuckType: 'bored' }));
  const spec = { id: 's1', title: 'empty input', conceptId: 'a', call: 'f([])', expected: '[]', expectError: '', parSec: 30,
    failureSignatures: [{ match: 'error', value: 'IndexError', misconceptionId: 'm', nudge: 'What if it is empty?' }] };
  const prep = S.TaskPrepSchema.parse({ tasks: [{
    taskTitle: 't',
    gate: { patterns: [{ name: 'n', conceptId: 'a', required: true, competesWith: '', useWhen: 'u', whyNot: '' }],
      plans: [{ text: 'p', workable: true, flawConceptId: '', misconceptionId: '', whyFlawed: '' }] },
    specs: { applicable: true, reason: '', specs: [spec], hidden: [], reference: 'def f(x): return x' },
  }] });
  assert.equal(prep.tasks[0].specs.specs[0].failureSignatures[0].match, 'error');
  const own = S.OwnCodeProbeSchema.parse({ probes: [{ file: 'a.py', functionName: 'f', callExpr: 'f(0)', conceptId: 'a', edgeCase: 'zero', misconceptionIfWrong: '' }] });
  assert.equal(own.probes.length, 1);
});
