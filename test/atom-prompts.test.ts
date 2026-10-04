import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allowedImportsFor, anyTypeSensitive, atomPackPrompt, escalationLessonPrompt, miniAtomPrompt, misconceptionGuessPrompt, packConcept, probesOnlyPrompt,
  repairPrompt, runtimeLabel, tagImports, taxonomyFor, type AtomPackPromptInput,
} from '../src/atoms/prompts';

const input = (over: Partial<AtomPackPromptInput> = {}): AtomPackPromptInput => ({
  runtime: 'Python 3.14.0', lang: 'python',
  concepts: [packConcept('list-slicing', 'list-slicing', 'Take part of a list'), packConcept('csv-rows', 'csv-ish', 'Split CSV rows', 'Parse CSV rows')],
  taxonomy: taxonomyFor(['list-slicing'], 'python'), allowedConstructs: ['for'], allowedImports: ['math'],
  snapshot: '- list-slicing: P 0.30', projectSummary: 'A budget CLI', taskTitles: ['Parse args'], typeSensitive: false, ...over,
});

test('packConcept fills kind and the canonical name from the taxonomy', () => {
  assert.deepEqual(packConcept('aliases', 'alias-copy', 'd'), { id: 'aliases', tag: 'alias-copy', kind: 'semantics', patternName: 'Aliases share one object', description: 'd' });
  assert.deepEqual(packConcept('csv', 'not-a-tag', 'd', 'Parse CSV'), { id: 'csv', tag: 'other', kind: 'shape', patternName: 'Parse CSV', description: 'd' });
  assert.equal(anyTypeSensitive(['list-slicing']), false);
  assert.equal(anyTypeSensitive(['list-slicing', 'str-vs-number']), true);
  assert.deepEqual(tagImports(['alias-copy', 'list-slicing']), ['copy']);
  const py = allowedImportsFor('python', ['collections-counter'], ['numpy']);
  assert.ok(py.includes('math') && py.includes('collections') && py.includes('numpy') && !py.includes('__future__'));
  assert.deepEqual(allowedImportsFor('javascript', ['collections-counter']), []);
  assert.ok(taxonomyFor(['list-slicing'], 'python').some((m) => m.id === 'slice-end-included'));
});

test('runtimeLabel names the interpreter', () => {
  assert.equal(runtimeLabel({ lang: 'python', version: '3.14.0' }), 'Python 3.14.0');
  assert.equal(runtimeLabel({ lang: 'javascript', version: 'v24.11.1' }), 'Node v24.11.1');
  assert.equal(runtimeLabel({ lang: 'typescript', version: '24.11.1', tsMode: 'strip' }), 'Node v24.11.1 (TypeScript, strip mode)');
});

test('ATOMPACK carries the spec text and its variables', () => {
  const p = atomPackPrompt(input());
  assert.ok(p.startsWith('You write practice items for a coding coach. The coach grades the learner by RUNNING your code with Python 3.14.0, so it must be exact and deterministic.'));
  assert.ok(p.includes('- list-slicing, list-slicing, shape, Slice a sequence, Take part of a list'));
  assert.ok(p.includes('- csv-rows, other, shape, Parse CSV rows, Split CSV rows.'));
  assert.ok(p.includes('list-slicing: slice-end-included (The slice includes the item at the stop index)'));
  assert.ok(p.includes('probes may use ONLY these plus the concept itself: for.'));
  assert.ok(p.includes('Allowed imports: math. No input(), files, network, randomness, clock, or dependence on set ordering.'));
  assert.ok(p.includes('Never write code that solves or mirrors these tasks: Parse args.'));
  assert.ok(p.includes('using check(condition, message) (check is predefined; do not use assert, require or process)'));
  assert.ok(p.endsWith('Write for a beginner who reads at most 60 words per atom. Gloss any jargon in 3 words.'));
  // Live packs: mutants one character off the original (3 vs 1) can never name their belief
  // (mutantAttributable treats them as slips), and contrasts without print() print the same.
  assert.ok(p.includes('from the other mutants by more than one character: a one-character difference (3 vs 1) reads as a typo'));
  assert.ok(p.includes('- contrast: two snippets of <= 4 lines that each print their result, identical except for the one feature that matters, so the two print different outputs;'));
  assert.ok(!p.includes('repr()'));
  assert.ok(!p.includes('erasable'));
  assert.ok(!p.includes('  '), 'no double spaces from empty conditionals');
  assert.ok(atomPackPrompt(input({ typeSensitive: true })).includes('several lines over a single small number. Print with repr() / type(x).__name__ (Python) or JSON.stringify / typeof (JS) so the type is visible. answer: the exact output.'));
  assert.ok(atomPackPrompt(input({ lang: 'typescript' })).includes('\nUse only erasable TypeScript syntax: no enum, namespace or parameter properties.\n'));
  assert.ok(atomPackPrompt(input({ compiled: true })).includes('Write each probe, example and contrast as the body of main only, listing imports at the top.'));
  assert.ok(atomPackPrompt(input({ allowedImports: [], taskTitles: [] })).includes('Allowed imports: none.'));
});

test('MINI ATOM and PROBES-ONLY append their instruction', () => {
  assert.ok(miniAtomPrompt(input()).endsWith('\nWrite the pattern, 2 probes (in 2 sibling groups, with mutants) and the completion only; set the example and contrast fields to empty strings and empty arrays.'));
  assert.ok(probesOnlyPrompt(input()).endsWith('\nWrite the pattern and the probes (with mutants) only; set example, completion and contrast to empty strings and empty arrays.'));
});

test('REPAIR lists failures with stderr tails of at most 300 characters, and the last pack', () => {
  const stderr = `${'x'.repeat(400)}\nValueError: bad`;
  const p = repairPrompt('Python 3.14.0', [
    { conceptId: 'list-slicing', itemId: 'p2', kind: 'probe', what: 'your answer: [1]; real output: [1, 2]', stderr },
    { conceptId: 'list-slicing', itemId: 'completion', kind: 'completion', what: 'it passes with the blanks left empty', stderr: '' },
  ], { atoms: [] });
  assert.ok(p.startsWith('These items from your last pack failed when run locally with Python 3.14.0:\n- list-slicing, p2: your answer: [1]; real output: [1, 2]\n  stderr: '));
  const tail = /stderr: (.*)\n/.exec(p)![1];
  assert.ok(tail.length <= 303 && tail.endsWith('ValueError: bad'));
  assert.ok(p.includes('- list-slicing, completion: it passes with the blanks left empty\nReturn the same atoms with ONLY these items corrected.'));
  assert.ok(p.includes('rewrite the probe, its mutants and its refutation from scratch rather than adjusting the answer. Keep items that passed unchanged.'));
  assert.ok(p.endsWith('Your last pack:\n{"atoms":[]}'));
});

test('MISCONCEPTION GUESS and ESCALATION LESSON carry their variables', () => {
  const g = misconceptionGuessPrompt({ lang: 'python', code: 'print([1, 2][0:1])\n', actual: '[1]', answer: '[1, 2]', known: [{ id: 'slice-end-included', belief: 'stop is included' }] });
  assert.ok(g.startsWith('A learner predicted the output of this python code:\n```python\nprint([1, 2][0:1])\n```\nActual output: [1]. Their answer: [1, 2]. Known misconceptions for this concept: slice-end-included: stop is included.'));
  assert.ok(g.endsWith('Set slip true if the answer looks like a typo or careless slip rather than a belief.'));
  const l = escalationLessonPrompt({
    projectBrief: 'Project: Budget', concept: { id: 'list-slicing', name: 'Slicing', description: 'Take part of a list' },
    belief: 'stop is included', misconceptionId: 'slice-end-included', items: [{ code: 'print(1)', answer: '2', actual: '1' }],
  });
  assert.ok(l.startsWith('Project: Budget. Concept: list-slicing - Slicing: Take part of a list. The learner confirmed holding this wrong belief: stop is included (misconception slice-end-included). Evidence: '));
  assert.ok(l.includes('Their answer: 2\nActual output: 1'));
  assert.ok(l.endsWith('No check question, no headings, no general overview of the topic.'));
  // A live lesson came back with an empty title and quoted the id ('The `assign-one-each-time` belief ...').
  assert.ok(l.includes('title: the fact in <= 6 words. Talk to the learner in plain words and never mention the misconception id.'));
});
