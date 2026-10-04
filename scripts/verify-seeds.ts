// Seed bank check (spec V1-5 PARAMETRIC SEEDS): instantiates 20 of every template in
// media/seed/<lang>.json on this machine's real runtime, and exits 1 when a seed file has problems,
// when fewer than 80% of a template's draws are valid, or when a transform never changes the output.
//
//   npx tsx scripts/verify-seeds.ts [python|javascript|typescript]    (no argument: every seed file)
//
// DELIBERATE_PYTHON=<path to python.exe> picks the interpreter (default: python, python3 on PATH).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Lang, Runtime } from '../src/contracts';
import { detectNode, detectPython, detectTypeScript, LocalRunner, PATH_PYTHON_CANDIDATES } from '../src/runner';
import { Instantiator, parseSeedBank, type TemplateReport } from '../src/atoms/seeds';

const N = 20;
const MIN_VALID = 0.8;
const SEED = 20261003; // fixed: the same draws on every run, so a failure reproduces
const LANGS: Lang[] = ['python', 'javascript', 'typescript'];
const root = path.resolve(__dirname, '..');
const seedDir = path.join(root, 'media', 'seed');
const runnerDir = path.join(root, 'media', 'runner');

async function detect(lang: Lang, cwd: string): Promise<Runtime | undefined> {
  const o = { cwd, log: (m: string) => console.log(`    ${m}`) };
  if (lang === 'python') {
    const pinned = process.env.DELIBERATE_PYTHON;
    return detectPython(pinned ? [{ bin: pinned, source: 'DELIBERATE_PYTHON' }, ...PATH_PYTHON_CANDIDATES] : PATH_PYTHON_CANDIDATES, o);
  }
  const node = await detectNode(o);
  if (!node || lang === 'javascript') return node;
  return detectTypeScript(node, root, { ...o, runnerDir });
}

/** Failure lines for one template ('' entries never). */
function judge(r: TemplateReport): string[] {
  const out: string[] = [];
  if (!r.drawn) out.push('no instance could be drawn');
  else if (r.valid / r.drawn < MIN_VALID) out.push(`only ${r.valid}/${r.drawn} draws valid (need ${MIN_VALID * 100}%)`);
  r.transforms.forEach((t, i) => {
    if (t.applies && t.changed === 0) out.push(`transform ${i} (${t.misconceptionId}) never changes the output (ran ${t.ran}x)`);
    else if (t.applies && t.attributable < t.changed / 2) {
      // compareOutput never names a mutant within one edit of the real output (a probable slip).
      out.push(`transform ${i} (${t.misconceptionId}) is a probable slip in ${t.changed - t.attributable}/${t.changed} runs: its output is within one edit of the original`);
    }
  });
  return out;
}

async function verify(lang: Lang, runRoot: string): Promise<boolean> {
  const file = path.join(seedDir, `${lang}.json`);
  console.log(`\n${lang}: ${path.relative(root, file)}`);
  const { bank, problems } = parseSeedBank(JSON.parse(fs.readFileSync(file, 'utf8')), lang);
  let ok = true;
  for (const p of problems) {
    console.log(`  PROBLEM ${p}`);
    ok = false;
  }
  const runtime = await detect(lang, runRoot);
  if (!runtime) {
    console.log(`  FAIL no ${lang} runtime found: nothing could be verified`);
    return false;
  }
  console.log(`  runtime ${runtime.version} at ${runtime.exe}`);
  const t0 = Date.now();
  const inst = new Instantiator(new LocalRunner(runtime, { runnerDir, runRoot }), SEED);
  const { byTag, reports } = await inst.instantiate(bank.templates, N, { maxRounds: 1, seed: SEED });
  for (const r of reports) {
    const fails = judge(r);
    const reasons = Object.entries(r.rejected).map(([k, v]) => `${k} x${v}`).join(', ');
    const note = r.exhausted ? ` (only ${r.drawn} distinct instances)` : '';
    console.log(`  ${fails.length ? 'FAIL' : 'ok  '} ${r.templateId} [${r.kind} ${r.tag}] ${r.valid}/${r.drawn} valid${note}${reasons ? `; rejected: ${reasons}` : ''}`);
    for (const f of fails) console.log(`         ${f}`);
    if (r.droppedWrongFills) console.log(`         note: ${r.droppedWrongFills} wrongFill run(s) passed and were dropped`);
    if (fails.length) ok = false;
  }
  const items = Object.values(byTag).reduce((n, p) => n + p.probes.length + p.examples.length + p.completions.length + p.contrasts.length + p.tracebacks.length, 0);
  console.log(`  ${items} valid items in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return ok;
}

async function main(): Promise<number> {
  const arg = process.argv[2];
  if (arg && !LANGS.includes(arg as Lang)) {
    console.error(`usage: npx tsx scripts/verify-seeds.ts [${LANGS.join('|')}]`);
    return 2;
  }
  const langs = arg ? [arg as Lang] : LANGS.filter((l) => fs.existsSync(path.join(seedDir, `${l}.json`)));
  if (!langs.length) {
    console.error(`no seed files in ${seedDir}`);
    return 1;
  }
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dlb-verify-'));
  try {
    let ok = true;
    for (const lang of langs) ok = (await verify(lang, runRoot)) && ok;
    console.log(ok ? '\nseeds verified' : '\nseed verification FAILED');
    return ok ? 0 : 1;
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
}

main().then((code) => process.exit(code), (e) => {
  console.error(e);
  process.exit(1);
});
