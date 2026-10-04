// The extension shell (spec v0.2 "fast loop"): builds every module once, wires them together and
// to VS Code, and owns what no module owns: global storage, runtime discovery and local-execution
// consent, the per-language atom caches and seed stock, the commands, the webview, the inline-AI
// offer and shutdown. Decision logic lives in src/shell.ts (pure, tested under node).

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Coach, padSkeleton, vscodeCoachHost, type SpecsLike } from './coach';
import { codexLoginCommand, resetCodexBin, resolveCodexBin } from './codex';
import type { Gen, Lang, Runner } from './contracts';
import { GateUi } from './gate';
import { HintDisplay } from './hints';
import { JobQueue } from './jobs';
import { recordEvidence } from './learner';
import { Llm, SECRET_KEY } from './llm';
import { InteractionLock } from './lock';
import { Monitor } from './monitor';
import { PredictFlow, VscodeQuestionPort, VscodeStrike, WhatIfFlow, type OwnCodeDeps } from './owncode';
import type { DetectedRuntimes, LocalRunner } from './runner';
import { discoverRuntimes, makeRunner } from './runtimeDiscovery';
import * as shell from './shell';
import { SpecController, SpecTestView, documentFunctions, saveTrigger, vscodeSpecHost, type AttachOptions, type AttachResult, type SpecTask } from './specs';
import { DESIGN_DIFFERS } from './specsCore';
import { Store } from './store';
import { LineAnnotationManager } from './annotations';
import { TempoBar, type TempoState } from './tempoBar';
import { CoachViewProvider } from './view';
import { AtomCache, type AtomCacheData, type AtomCachePersistence } from './atoms/cache';
import { AtomPad } from './atoms/pad';
import { closeLeftoverPadTabs, createPadSurface, padContextValues, registerPadCommands } from './atoms/padfs';
import { PlacementRun } from './atoms/placementRun';
import { Sprint } from './atoms/sprint';
import { Stock } from './atoms/stock';
import { concept } from './learner';
import { tagInfo } from './atoms/tags';

const LANGS: readonly Lang[] = ['python', 'javascript', 'typescript'];
const SPRINT_BEST_KEY = 'deliberate.sprintBest';
/** How long a learner action waits for runtime discovery before the consent question. */
const DISCOVERY_WAIT_MS = 8000;

const IDLE_TEMPO: TempoState = { phase: 'idle', stuckScore: 0, lastEditAt: 0, activeMsToday: 0, sprintMsToday: 0 };

/** The extension's exports: `ready` settles when activation's background work is done (tests). */
export interface DeliberateApi {
  ready: Promise<void>;
  /** Only under ExtensionMode.Test (the e2e suite in test/e2e): the live objects behind the commands. */
  test?: DeliberateTestHooks;
}

/** What the e2e suite drives directly: no command or webview message starts a project without the webview. */
export interface DeliberateTestHooks {
  coach: Coach;
  store: Store;
  pad: AtomPad;
  specs: SpecController;
  view: CoachViewProvider;
  caches: Record<Lang, AtomCache>;
  /** Every line written to the 'Deliberate' (and, prefixed 'content: ', 'Deliberate: content') channels. */
  log: string[];
  /** The last value the pad set for each of its context keys. */
  padContext: ReadonlyMap<string, unknown>;
}

let shutdown: (() => Promise<void>) | undefined;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    p.then(
      () => {
        clearTimeout(t);
        resolve();
      },
      () => {
        clearTimeout(t);
        resolve();
      },
    );
  });
}

/** globalStorage/atoms/<lang>.json, written atomically (temp file + rename); a corrupt file is set aside. */
function cacheFile(dir: string, lang: Lang, log: (line: string) => void): AtomCachePersistence {
  const file = path.join(dir, `${lang}.json`);
  return {
    async load() {
      let text: string;
      try {
        text = await fsp.readFile(file, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw err;
      }
      try {
        return JSON.parse(text) as AtomCacheData;
      } catch (err) {
        const aside = `${file}.corrupt-${Date.now()}`;
        log(`atoms ${lang}: ${path.basename(file)} is not valid JSON (${errorText(err)}); moved to ${path.basename(aside)}`);
        await fsp.rename(file, aside).catch(() => undefined);
        return undefined;
      }
    },
    async save(data) {
      await fsp.mkdir(dir, { recursive: true });
      const text = JSON.stringify(data);
      const tmp = `${file}.${process.pid}-${Date.now().toString(36)}.tmp`;
      await fsp.writeFile(tmp, text, 'utf8');
      // Windows: another window may have the file open for a moment; retry, then write in place.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await fsp.rename(tmp, file);
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
        }
      }
      try {
        await fsp.writeFile(file, text, 'utf8');
      } finally {
        await fsp.rm(tmp, { force: true }).catch(() => undefined);
      }
    },
  };
}

export function activate(ctx: vscode.ExtensionContext): DeliberateApi {
  // ------------------------------------------------------------ output and storage
  const out = vscode.window.createOutputChannel('Deliberate');
  const content = vscode.window.createOutputChannel('Deliberate: content');
  const testLog: string[] | undefined = ctx.extensionMode === vscode.ExtensionMode.Test ? [] : undefined;
  const log = (line: string) => {
    out.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
    testLog?.push(line);
  };
  const contentLog = (line: string) => {
    content.appendLine(line);
    testLog?.push(`content: ${line}`);
  };
  ctx.subscriptions.push(out, content);

  const storage = ctx.globalStorageUri.fsPath;
  const dirs = {
    atoms: path.join(storage, 'atoms'),
    specs: path.join(storage, 'specs'),
    verify: path.join(storage, 'verify'),
    run: path.join(storage, 'run'),
  };
  for (const d of [storage, ...Object.values(dirs)]) {
    try {
      fs.mkdirSync(d, { recursive: true });
    } catch (err) {
      log(`cannot create ${d}: ${errorText(err)}`);
    }
  }
  const harnessDir = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'harness').fsPath;
  const cfg = () => vscode.workspace.getConfiguration('deliberate');

  let disposed = false;
  let coachRef: Coach | undefined;
  let viewRef: CoachViewProvider | undefined;

  // ------------------------------------------------------------ runtimes and consent
  let runtimes: DetectedRuntimes = {};
  const runners: Partial<Record<Lang, LocalRunner>> = {};
  let declined = false;
  const computeExec = () =>
    shell.executionState(
      shell.normalizeSetting(cfg().get('localExecution', 'ask')),
      shell.normalizeChoice(ctx.globalState.get(shell.CONSENT_KEY)),
      declined,
      vscode.workspace.isTrusted,
    );
  let exec = computeExec();
  /** Model and seed snippets: gated by consent and workspace trust. */
  const snippetRunner = (lang: Lang): Runner | undefined => (exec.snippets ? runners[lang] : undefined);
  const projectLang = (): Lang | undefined => store.project?.lang ?? undefined;
  const versions = () => shell.runtimeVersions(runtimes);

  // ------------------------------------------------------------ core state
  const store = new Store(ctx);
  const llm = new Llm(ctx.secrets, ctx.languageModelAccessInformation);
  const monitor = new Monitor();
  const lock = new InteractionLock();
  const fallbackGen = (): Gen => ({ projectCreatedAt: store.project?.createdAt ?? 0, taskId: store.project?.currentTaskId, taskSwitch: store.project?.taskSwitch ?? 0 });
  const jobs = new JobQueue({
    ...shell.jobSettings((k) => cfg().get(k)),
    currentGen: () => coachRef?.gen() ?? fallbackGen(),
    log,
  });
  ctx.subscriptions.push(monitor, lock, jobs);

  // ------------------------------------------------------------ editor surfaces
  const annotations = new LineAnnotationManager(ctx.extensionUri, { log });
  const hintDisplay = new HintDisplay(annotations);
  const tempo = new TempoBar({ state: () => coachRef?.tempoState() ?? IDLE_TEMPO, jobs, lock, monitor, log });
  ctx.subscriptions.push(annotations, { dispose: () => hintDisplay.dispose() }, tempo);

  // ------------------------------------------------------------ content: caches and stock
  const caches = Object.fromEntries(
    LANGS.map((l) => [l, new AtomCache(l, cacheFile(dirs.atoms, l, contentLog), { onError: (e) => contentLog(`atoms ${l}: write failed: ${errorText(e)}`) })]),
  ) as Record<Lang, AtomCache>;
  const cachesLoaded = Promise.all(LANGS.map((l) => caches[l].load().catch((e) => contentLog(`atoms ${l}: cannot load: ${errorText(e)}`)))).then(() => undefined);
  const coverage = new shell.CoverageIndex({
    lang: projectLang,
    atom: (l, key) => caches[l].get(key),
    has: (l, key) => caches[l].has(key),
  });
  store.setEvidenceEnv({ coverage: coverage.coverage, taxonomy: coverage.taxonomy });

  const stocks = Object.fromEntries(
    LANGS.map((l) => [
      l,
      new Stock({
        lang: l,
        cache: caches[l],
        readFile: async (rel) => new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(ctx.extensionUri, ...rel.split('/')))),
        runner: () => snippetRunner(l),
        log: contentLog,
      }),
    ]),
  ) as Record<Lang, Stock>;

  // ------------------------------------------------------------ the pad
  const surface = createPadSurface();
  ctx.subscriptions.push(...surface.disposables);
  const pad = new AtomPad({
    editor: surface.editor,
    ui: surface.ui,
    learner: () => store.learner,
    recordEvidence: (e) => recordEvidence(store.learner, e),
    cache: (l) => caches[l],
    runner: (l) => snippetRunner(l),
    canRun: (l) => !!snippetRunner(l),
    lesson: (req) => coachRef?.escalationLesson(req),
    onLog: (card) => coachRef?.pushLogCard(card),
    onExit: (r) => {
      coverage.invalidate();
      coachRef?.onAtomExit(r);
    },
    markProgress: (now, why) => coachRef?.markProgressIfBuilding(now, why),
    lock,
    refill: (l, key) => void stocks[l]?.refillIfLow(key)?.then(() => coverage.invalidate()),
  });
  ctx.subscriptions.push(...registerPadCommands(pad), { dispose: () => pad.dispose() });

  // ------------------------------------------------------------ specs, own code, gate
  const host = vscodeSpecHost();
  const specs = new SpecController({
    ...host,
    annotations,
    actions: tempo,
    harnessDir,
    specDir: dirs.specs,
    verifyDir: dirs.verify,
    conceptInfo: (id) => {
      const c = concept(store.learner, id);
      if (!c) return undefined;
      return { p: c.mastery, pattern: (c.tag ? tagInfo(c.tag)?.patternName : undefined) ?? c.name };
    },
    activeMsSince: (since) => coachRef?.activeMsSince(since) ?? Math.max(0, Date.now() - since),
    commands: { jit: 'deliberate.jitAtom', ladder: 'deliberate.open' },
    log,
  });
  const testView = new SpecTestView(specs);
  ctx.subscriptions.push({ dispose: () => specs.dispose() }, testView);

  /**
   * The coach's view of the SpecController, plus what the shell adds: the Testing view after a
   * successful attach, a re-attach when execution becomes possible mid-task (consent, trust, a new
   * runtime), and the 'spec-green' pause for the tempo bar.
   */
  let lastAttach: { task: SpecTask; lang: Lang; opts: AttachOptions; result: AttachResult } | undefined;
  let greenBefore = new Set<string>();
  const showTests = async (task: SpecTask, lang: Lang) => {
    const file = specs.interfaceFile;
    if (!specs.applicable || !file || specs.taskId !== task.id) {
      testView.clear();
      return;
    }
    const text = await host.readText(file);
    const fns = text !== undefined ? await documentFunctions(vscode.Uri.file(file), text, lang).catch(() => []) : [];
    if (specs.taskId === task.id) testView.show(task, file, fns);
  };
  const specsPort: SpecsLike = {
    get on() {
      return specs.on;
    },
    set on(v) {
      specs.on = v;
    },
    get applicable() {
      return specs.applicable;
    },
    get taskId() {
      return specs.taskId;
    },
    async attach(task, lang, runner, opts) {
      const result = await specs.attach(task, lang, runner, opts);
      lastAttach = { task, lang, opts, result };
      greenBefore = shell.passing(task.spec?.last);
      // In the background: document symbols can take a while when a language server is starting.
      void showTests(task, lang).catch((e) => log(`testing view: ${errorText(e)}`));
      return result;
    },
    detach() {
      lastAttach = undefined;
      greenBefore = new Set();
      specs.detach();
      testView.clear();
    },
    runNow: (trigger) => specs.runNow(trigger),
    setAllowRun: (allow) => specs.setAllowRun(allow),
    addDeferredConcepts: (ids) => specs.addDeferredConcepts(ids),
    ladder: () => specs.ladder(),
  };
  const reattachSpecs = async () => {
    const last = lastAttach;
    if (!last || specs.taskId !== last.task.id || specs.applicable || !exec.learnerCode) return;
    if (!last.task.spec?.applicable || last.result.reason === DESIGN_DIFFERS) return;
    const runner = snippetRunner(last.lang);
    if (!runner) return;
    await specsPort.attach(last.task, last.lang, runner, { ...last.opts, allowRun: true, announce: false });
    coachRef?.refresh();
  };
  ctx.subscriptions.push(
    specs.onDidRun((o) => {
      const turned = shell.newlyGreen(greenBefore, o.results);
      greenBefore = shell.passing(o.results);
      if (turned.length) monitor.notePause('spec-green');
    }),
  );

  const ownDeps: OwnCodeDeps = {
    runner: () => {
      const l = projectLang();
      return l ? snippetRunner(l) : undefined;
    },
    allowRun: () => exec.learnerCode,
    harnessDir,
    workspaceDir: host.workspaceDir,
    uriOf: host.uriOf,
    readText: host.readText,
    functions: host.functions,
    annotations,
    actions: tempo,
    ask: new VscodeQuestionPort(),
    lock,
    log,
  };
  const predict = new PredictFlow(ownDeps);
  const strike = new VscodeStrike();
  const whatIf = new WhatIfFlow({ ...ownDeps, strike });
  const gate = new GateUi({ lock });
  ctx.subscriptions.push({ dispose: () => predict.dispose() }, { dispose: () => whatIf.dispose() }, strike);

  // ------------------------------------------------------------ the coach and the sidebar
  const sprintBest = {
    get: () => ctx.globalState.get<number>(SPRINT_BEST_KEY),
    set: (v: number) => void ctx.globalState.update(SPRINT_BEST_KEY, v),
  };
  const coach = new Coach({
    store,
    llm,
    monitor,
    jobs,
    lock,
    tempo,
    host: vscodeCoachHost({
      monitor,
      globalStoragePath: storage,
      focusComposer: (mode) => viewRef?.focusComposer(mode),
      functionNames: async (f, text, lang) => (await documentFunctions(vscode.Uri.file(f), text, lang)).map((x) => x.name),
    }),
    runtime: { runner: (l) => snippetRunner(l), allowRun: () => exec.learnerCode },
    caches: (l) => caches[l],
    stocks: (l) => stocks[l],
    prefetchDeps: { specs, contentLog },
    pad,
    placement: (l) => (stocks[l] ? new PlacementRun(pad, stocks[l]) : undefined),
    sprint: (l) => (stocks[l] ? new Sprint({ pad, stock: stocks[l], best: sprintBest }) : undefined),
    skeleton: padSkeleton(pad),
    gate,
    specs: specsPort,
    predict,
    whatIf,
    hints: hintDisplay,
    log,
  });
  coachRef = coach;
  ctx.subscriptions.push(coach);

  // ------------------------------------------------------------ consent on first need
  let discovery: Promise<void> = Promise.resolve();
  let discovered = false;
  let consentAsk: Promise<void> | undefined;

  const applyExecution = (why: string) => {
    const prev = exec;
    exec = computeExec();
    const ch = shell.executionChanged(prev, exec);
    if (!ch.snippets && !ch.learnerCode) return;
    log(`${shell.executionSummary(exec, versions())} (${why})`);
    coverage.invalidate();
    if (ch.learnerCode) coach.setAllowRun(exec.learnerCode);
    if (exec.learnerCode) void reattachSpecs().catch((e) => log(`re-attaching specs: ${errorText(e)}`));
    if (ch.snippets && discovered) void stockNow();
    viewRef?.refresh();
  };

  /** The consent modal, at most once at a time, before an action that runs code. */
  const ensureConsent = async (): Promise<void> => {
    if (exec.consent !== 'ask' || !vscode.workspace.isTrusted) return;
    await settleWithin(discovery, DISCOVERY_WAIT_MS);
    applyExecution('consent check');
    if (!shell.shouldAskConsent(exec, Object.keys(runners).length > 0)) return;
    consentAsk ??= (async () => {
      const items: vscode.MessageItem[] = [
        { title: shell.CONSENT_BUTTONS.all },
        { title: shell.CONSENT_BUTTONS.snippets },
        { title: shell.CONSENT_BUTTONS.notNow, isCloseAffordance: true },
      ];
      const pick = await vscode.window.showInformationMessage(shell.CONSENT_MESSAGE, { modal: true }, ...items);
      const choice = shell.choiceFromButton(pick?.title);
      if (choice) await ctx.globalState.update(shell.CONSENT_KEY, choice);
      else declined = true;
      applyExecution(choice ? `chose '${pick?.title}'` : 'not now');
    })().finally(() => {
      consentAsk = undefined;
    });
    await consentAsk;
  };

  /** Command handlers: errors go to the log and one error message, never an unhandled rejection. */
  const command = (id: string, fn: (...args: unknown[]) => unknown, opts: { consent?: boolean } = {}) =>
    vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      try {
        if (opts.consent) await ensureConsent();
        return await fn(...args);
      } catch (err) {
        log(`${id} failed: ${errorText(err)}`);
        void vscode.window.showErrorMessage(`Deliberate: ${errorText(err)}`);
        return undefined;
      }
    });
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

  // ------------------------------------------------------------ webview
  const firstKeystroke = () => ctx.workspaceState.get<shell.FirstKeystroke>(shell.FIRST_KEYSTROKE_KEY);
  const view = new CoachViewProvider(ctx.extensionUri, coach, {
    prepare: () => ensureConsent(),
    extras: () => ({
      pace: shell.paceExtras(coach.project, firstKeystroke()),
      execution: shell.executionSummary(exec, versions()),
    }),
  });
  viewRef = view;
  ctx.subscriptions.push(view, vscode.window.registerWebviewViewProvider(CoachViewProvider.viewId, view, { webviewOptions: { retainContextWhenHidden: true } }));

  // ------------------------------------------------------------ inline AI offer (once per workspace)
  let inlineAiBusy = false;
  const maybeOfferInlineAi = async () => {
    if (inlineAiBusy || disposed || !vscode.workspace.workspaceFolders?.length) return;
    const t = coach.task;
    const building = !!t && t.status === 'active' && t.phase === 'building';
    const offered = ctx.workspaceState.get<boolean>(shell.INLINE_AI_OFFERED_KEY, false);
    if (offered || !building) return;
    const active = shell.INLINE_AI_EXTENSIONS.filter((id) => vscode.extensions.getExtension(id)?.isActive);
    const enabled = vscode.workspace.getConfiguration('editor').get<boolean>('inlineSuggest.enabled', true);
    if (!shell.inlineAiOfferDue({ active, offered, inlineSuggestEnabled: enabled, building })) return;
    inlineAiBusy = true;
    try {
      await ctx.workspaceState.update(shell.INLINE_AI_OFFERED_KEY, true);
      const pick = await vscode.window.showInformationMessage(shell.INLINE_AI_MESSAGE, shell.INLINE_AI_BUTTONS.off, shell.INLINE_AI_BUTTONS.keep);
      if (pick === shell.INLINE_AI_BUTTONS.off) {
        await vscode.workspace.getConfiguration('editor').update('inlineSuggest.enabled', false, vscode.ConfigurationTarget.Workspace);
        await ctx.workspaceState.update(shell.INLINE_AI_DISABLED_KEY, true);
        log(`inline AI suggestions turned off in this workspace (${active.join(', ')} active)`);
      } else {
        log(`inline AI offer: ${pick ?? 'dismissed'} (${active.join(', ')} active)`);
      }
    } catch (err) {
      log(`inline AI offer: ${errorText(err)}`);
    } finally {
      inlineAiBusy = false;
    }
  };
  /** New goal: give inline suggestions back if we took them away (the offer may come again). */
  const restoreInlineAi = async () => {
    if (!ctx.workspaceState.get<boolean>(shell.INLINE_AI_DISABLED_KEY, false)) return;
    try {
      await vscode.workspace.getConfiguration('editor').update('inlineSuggest.enabled', undefined, vscode.ConfigurationTarget.Workspace);
      log('inline AI suggestions restored for this workspace');
    } catch (err) {
      log(`restoring inline AI suggestions: ${errorText(err)}`);
    }
    await ctx.workspaceState.update(shell.INLINE_AI_DISABLED_KEY, false);
    await ctx.workspaceState.update(shell.INLINE_AI_OFFERED_KEY, false);
  };

  // ------------------------------------------------------------ stock, flashes, project changes
  const stockRuns = new Map<Lang, Promise<void>>();
  const stockNow = (langs: readonly Lang[] = shell.stockLanguages(projectLang(), runtimes)): Promise<void> => {
    const runs = langs.map((l) => {
      const run = (stockRuns.get(l) ?? Promise.resolve())
        .then(async () => {
          await cachesLoaded;
          if (disposed) return;
          const r = await stocks[l].ensureStock();
          coverage.invalidate();
          if (r.added || r.problems.length) log(`stock ${l}: ${r.added} items added${r.neutral ? ' (neutral, unverified: nothing may run)' : ''}${r.problems.length ? `, ${r.problems.length} problems (see Deliberate: content)` : ''}`);
        })
        .catch((e) => log(`stock ${l}: ${errorText(e)}`));
      stockRuns.set(l, run);
      return run;
    });
    return Promise.all(runs).then(() => undefined);
  };

  const flashedNoRuntime = new Set<Lang>();
  const maybeFlashNoRuntime = () => {
    const l = projectLang();
    if (!discovered || !l || flashedNoRuntime.has(l)) return;
    const msg = shell.noRuntimeFlash(l, runtimes);
    if (!msg) return;
    flashedNoRuntime.add(l);
    tempo.flash(msg, shell.NO_RUNTIME_FLASH_MS);
    log(msg);
  };

  let knownLang: Lang | undefined = projectLang();
  let firstKeyFor: number | undefined;
  ctx.subscriptions.push(
    coach.onChange(() => {
      const l = projectLang();
      if (l !== knownLang) {
        knownLang = l;
        if (l && discovered) void stockNow([l]);
        maybeFlashNoRuntime();
      }
      void maybeOfferInlineAi();
    }),
  );

  // ------------------------------------------------------------ runtime discovery
  let discoveryAbort: AbortController | undefined;
  const runDiscovery = async (): Promise<void> => {
    discoveryAbort?.abort();
    const ac = new AbortController();
    discoveryAbort = ac;
    try {
      const rts = await discoverRuntimes({ extensionUri: ctx.extensionUri, globalStorageUri: ctx.globalStorageUri, log, signal: ac.signal });
      if (ac.signal.aborted || disposed) return;
      runtimes = rts;
      for (const l of LANGS) {
        const rt = rts[l];
        if (rt) runners[l] = makeRunner(rt, ctx.extensionUri, ctx.globalStorageUri);
        else delete runners[l];
      }
      const v = versions();
      log(`runtimes: ${LANGS.map((l) => `${l} ${v[l] ?? 'not found'}`).join(' · ')}`);
    } catch (err) {
      if (!ac.signal.aborted) log(`runtime discovery failed: ${errorText(err)}`);
    } finally {
      if (discoveryAbort === ac) discoveryAbort = undefined;
    }
  };
  const rediscover = async (why: string) => {
    log(`discovering runtimes again (${why})`);
    discovery = runDiscovery();
    await discovery;
    if (disposed) return;
    discovered = true;
    applyExecution(why);
    if (exec.learnerCode) await reattachSpecs().catch((e) => log(`re-attaching specs: ${errorText(e)}`));
    maybeFlashNoRuntime();
    await stockNow();
    viewRef?.refresh();
  };

  // ------------------------------------------------------------ events
  ctx.subscriptions.push(
    monitor.onSave((e) => {
      specs.onSave({ uri: e.uri.toString(), fsPath: e.uri.fsPath, reason: saveTrigger(e.reason), errorCount: e.errorCount });
      void coach.onSave({ uri: e.uri.toString(), fsPath: e.uri.fsPath }).catch((err) => log(`onSave: ${errorText(err)}`));
    }),
    monitor.onInsert((e) => coach.onInsert(e)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== 'file' || !e.contentChanges.length) return;
      const uri = e.document.uri.toString();
      specs.onEdit({ uri, fsPath: e.document.uri.fsPath });
      const changes = e.contentChanges.map((c) => ({ startLine: c.range.start.line, endLine: c.range.end.line, text: c.text }));
      predict.onEdit(uri, changes);
      whatIf.onEdit(uri, changes);
      const p = coach.project;
      if (p && firstKeyFor !== p.createdAt && shell.firstKeystrokeDue(p, firstKeystroke())) {
        firstKeyFor = p.createdAt;
        void ctx.workspaceState.update(shell.FIRST_KEYSTROKE_KEY, { projectCreatedAt: p.createdAt, at: Date.now() } satisfies shell.FirstKeystroke);
      }
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void rediscover('workspace trusted')),
    vscode.extensions.onDidChange(() => void maybeOfferInlineAi()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('deliberate.codexPath')) resetCodexBin();
      if (e.affectsConfiguration('deliberate.backgroundConcurrency') || e.affectsConfiguration('deliberate.backgroundCallsPerHour')) {
        jobs.configure(shell.jobSettings((k) => cfg().get(k)));
      }
      if (e.affectsConfiguration('deliberate.localExecution')) applyExecution('setting changed');
      if (e.affectsConfiguration('deliberate.pythonPath') || e.affectsConfiguration('python.defaultInterpreterPath')) void rediscover('interpreter setting changed');
    }),
  );

  // ------------------------------------------------------------ commands
  ctx.subscriptions.push(
    command('deliberate.open', () => view.reveal()),
    command('deliberate.hint', () => coach.hint()),
    command('deliberate.gotIt', () => coach.gotIt()),
    command('deliberate.reveal', () => coach.reveal()),
    command('deliberate.retryPlan', () => coach.retryPlan()),
    command('deliberate.gate', () => coach.openGate()),
    command('deliberate.teach', (id) => coach.teach(str(id)), { consent: true }),
    command('deliberate.jitAtom', (id) => coach.jitAtom(str(id)), { consent: true }),
    command('deliberate.checkWork', () => coach.checkWork(), { consent: true }),
    command('deliberate.sprint', () => coach.sprint(), { consent: true }),
    command('deliberate.warmup', () => coach.warmup(), { consent: true }),
    command('deliberate.practiceWhileWaiting', () => coach.practiceWhileWaiting(), { consent: true }),
    command('deliberate.placement', () => coach.placement(), { consent: true }),
    command(
      'deliberate.predictOwn',
      () => {
        const ed = vscode.window.activeTextEditor;
        return coach.predictOwn(ed && ed.document.uri.scheme === 'file' ? ed.selection.active.line : undefined);
      },
      { consent: true },
    ),
    command('deliberate.ask', async () => {
      const q = await vscode.window.showInputBox({ prompt: 'Ask the coach', placeHolder: 'e.g. why does my loop never stop?', ignoreFocusOut: true });
      if (!q?.trim()) return;
      view.reveal();
      await coach.askCoach(q.trim());
    }),
    command('deliberate.explainSelection', async () => {
      const ed = vscode.window.activeTextEditor;
      const text = ed?.document.getText(ed.selection);
      if (!ed || !text?.trim()) {
        void vscode.window.showInformationMessage('Select some code first.');
        return;
      }
      view.reveal();
      await coach.askCoach(
        `Help me understand this code from ${vscode.workspace.asRelativePath(ed.document.uri)}. Ask me what I think it does first if I seem to be guessing:\n\`\`\`\n${text}\n\`\`\``,
      );
    }),
    command('deliberate.newProject', async () => {
      const p = coach.project;
      if (p) {
        const ok = await vscode.window.showWarningMessage(
          `Abandon "${p.title}" and start a new goal in this workspace? Your learner profile (concepts, misconceptions, Pattern Deck) is kept.`,
          { modal: true },
          'Start new goal',
        );
        if (ok !== 'Start new goal') return;
      }
      await coach.newProject();
      await restoreInlineAi();
      view.reveal();
    }),
    command('deliberate.resetProfile', async () => {
      const ok = await vscode.window.showWarningMessage(
        'Erase your learner profile (every concept estimate, misconception, the Pattern Deck, the mistake journal and the evidence log, across all projects)? This cannot be undone.',
        { modal: true },
        'Erase profile',
      );
      if (ok !== 'Erase profile') return;
      await coach.resetProfile();
    }),
    command('deliberate.chooseExecution', async () => {
      const items = shell.CONSENT_PICKS.map((p) => ({ label: p.label, detail: p.detail, choice: p.choice, picked: p.choice === exec.consent }));
      const pick = await vscode.window.showQuickPick(items, {
        title: 'What may Deliberate run on this machine?',
        placeHolder: 'Always in a temp folder with a time limit; your project files are never written',
        ignoreFocusOut: true,
      });
      if (!pick) return;
      await ctx.globalState.update(shell.CONSENT_KEY, pick.choice);
      declined = false;
      const setting = shell.normalizeSetting(cfg().get('localExecution', 'ask'));
      if (setting !== 'ask') {
        void vscode.window.showInformationMessage(`The setting deliberate.localExecution is '${setting}', which overrides this choice until it is set back to 'ask'.`);
      }
      applyExecution('choice changed');
    }),
    command('deliberate.showLog', () => out.show(true)),
    command('deliberate.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Anthropic API key (stored in VS Code SecretStorage)',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'sk-ant-...',
      });
      if (key === undefined) return;
      if (key.trim()) await ctx.secrets.store(SECRET_KEY, key.trim());
      else await ctx.secrets.delete(SECRET_KEY);
      void vscode.window.showInformationMessage(key.trim() ? 'Deliberate: API key saved.' : 'Deliberate: API key removed.');
    }),
    command('deliberate.codexLogin', async () => {
      resetCodexBin();
      const bin = await resolveCodexBin(cfg().get<string>('codexPath', ''));
      const term = vscode.window.createTerminal({ name: 'Codex sign-in' });
      term.show();
      term.sendText(codexLoginCommand(bin));
    }),
  );

  // ------------------------------------------------------------ background start-up
  const init = async (): Promise<void> => {
    void closeLeftoverPadTabs();
    discovery = runDiscovery();
    await Promise.all([cachesLoaded, discovery]);
    if (disposed) return;
    discovered = true;
    exec = computeExec();
    coverage.invalidate();
    log(shell.executionSummary(exec, versions()));
    await coach.reconcile().catch((e) => log(`reconcile: ${errorText(e)}`));
    if (disposed) return;
    knownLang = projectLang();
    maybeFlashNoRuntime();
    await stockNow();
    if (disposed) return;
    coach.offerWarmup();
    void maybeOfferInlineAi();
    view.refresh();
  };
  const ready = init().catch((err) => log(`start-up failed: ${errorText(err)}`));

  shutdown = async () => {
    if (disposed) return;
    disposed = true;
    discoveryAbort?.abort();
    jobs.dispose();
    const results = await Promise.allSettled([store.flush(), ...LANGS.map((l) => caches[l].dispose())]);
    for (const r of results) if (r.status === 'rejected') console.error('[deliberate] flush on shutdown failed', r.reason);
  };

  const api: DeliberateApi = { ready };
  if (testLog) api.test = { coach, store, pad, specs, view, caches, log: testLog, padContext: padContextValues };
  return api;
}

export async function deactivate(): Promise<void> {
  const s = shutdown;
  shutdown = undefined;
  await s?.();
}
