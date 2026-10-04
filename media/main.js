// @ts-check
// Deliberate sidebar. Learning happens in the editor (the practice pad, the gate popups, specs on
// save); this view is a compact log of what happened, the task card with its interface and spec
// ladder, the composer for Ask and the optional own plan, the Roadmap and the Progress tab.
// CSP: scripts only by nonce, styles only from main.css. Inline style attributes are blocked, so
// meter widths and indents are set through the CSSOM after rendering (applyStyles).
(function () {
  // @ts-ignore - provided by VS Code
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));
  const saved = vscode.getState() || {};
  let tab = saved.tab || 'coach';
  /** @type {any} */
  let state = null;
  let lastCardCount = 0;
  let lastTaskId = null;
  /** Log cards the learner expanded. */
  const expanded = new Set(Array.isArray(saved.expanded) ? saved.expanded.slice(-50) : []);

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
  const send = (msg) => vscode.postMessage(msg);
  const persist = (extra) => vscode.setState({ ...vscode.getState(), tab, expanded: [...expanded], ...extra });
  const pct = (x) => Math.max(0, Math.min(100, Math.round(x)));

  /** Composer modes whose submit is a question to the coach (a foreground model call). */
  const ASK_MODES = new Set(['ask', 'building', 'placement', 'waiting', 'atom']);

  const MODE_LABELS = {
    placement: 'Placement open in the editor',
    waiting: 'Your roadmap is being designed',
    atom: 'Practice open in the editor',
    gate: 'Answer in the popup (or explain your own plan)',
    explain: 'Your own plan',
    'explain-back': 'Explain it back',
    building: 'Building: ask anything',
    ask: 'Ask the coach',
  };

  app.innerHTML = `
    <div id="onboarding" hidden></div>
    <div id="main" hidden>
      <nav class="tabs" role="tablist">
        <button data-tab="coach" role="tab">Coach</button>
        <button data-tab="roadmap" role="tab">Roadmap</button>
        <button data-tab="progress" role="tab">Progress</button>
      </nav>
      <section id="status"></section>
      <section id="tab-coach" class="tab">
        <div id="feed" aria-live="polite"></div>
        <div id="busy" hidden>
          <span class="spinner" id="busy-spin" hidden></span>
          <span id="busy-label"></span>
          <span id="bg-label" class="muted"></span>
          <button id="pww" data-command="practiceWhileWaiting" hidden>Practice while you wait</button>
        </div>
        <div id="composer">
          <div id="mode-label"></div>
          <textarea id="input" rows="3"></textarea>
          <div id="composer-buttons"></div>
          <div class="hint-text">Ctrl+Enter to send</div>
        </div>
      </section>
      <section id="tab-roadmap" class="tab"></section>
      <section id="tab-progress" class="tab"></section>
    </div>`;

  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const input = /** @type {HTMLTextAreaElement} */ ($('input'));
  input.value = saved.draft || '';
  input.addEventListener('input', () => persist({ draft: input.value }));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit('submit');
    }
  });

  // ------------------------------------------------------------ busy semantics

  const fgBusy = () => !!(state && state.status && state.status.busy);

  /** Only actions that start a foreground model call wait while one runs: Ask, Reveal, Teach, spec-less Check. */
  function isFg(command) {
    if (command === 'reveal' || command === 'teach' || command === 'noIdea' || command === 'ask') return true;
    if (command === 'checkWork') return !(state && state.task && state.task.specsApplicable);
    return false;
  }

  const fgAttr = (command) => (isFg(command) ? ' data-fg="1"' : '');

  function applyBusy() {
    const busy = fgBusy();
    document.querySelectorAll('[data-fg]').forEach((b) => {
      /** @type {HTMLButtonElement} */ (b).disabled = busy;
      if (busy) b.setAttribute('title', 'Waiting for the coach to finish');
      else b.removeAttribute('title');
    });
  }

  /** Meter widths and indents through the CSSOM (inline style attributes are blocked by the CSP). */
  function applyStyles(root) {
    root.querySelectorAll('[data-w]').forEach((el) => {
      /** @type {HTMLElement} */ (el).style.width = `${pct(Number(el.getAttribute('data-w')) || 0)}%`;
    });
    root.querySelectorAll('[data-indent]').forEach((el) => {
      /** @type {HTMLElement} */ (el).style.paddingLeft = `${8 + Math.min(4, Number(el.getAttribute('data-indent')) || 0) * 14}px`;
    });
  }

  function submit(kind) {
    const text = input.value.trim();
    if (!text || !state) return;
    const asks = kind === 'ask' || ASK_MODES.has(state.input.mode);
    if (asks && fgBusy()) return;
    send({ type: kind, text });
    input.value = '';
    persist({ draft: '' });
  }

  // ------------------------------------------------------------ rendering

  function render() {
    if (!state) return;
    $('onboarding').hidden = state.hasProject;
    $('main').hidden = !state.hasProject;
    if (!state.hasProject) return renderOnboarding();
    if ($('onboarding').dataset.ready) {
      // A project exists: the next 'New goal' starts from a fresh form.
      delete $('onboarding').dataset.ready;
      $('onboarding').innerHTML = '';
    }
    document.querySelectorAll('.tabs button').forEach((b) => {
      const on = b.getAttribute('data-tab') === tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('.tab').forEach((s) => ((/** @type {HTMLElement} */ (s)).hidden = s.id !== `tab-${tab}`));
    renderStatus();
    renderBusy();
    renderFeed();
    renderComposer();
    renderRoadmap();
    renderProgress();
    applyStyles(app);
    applyBusy();
  }

  function renderOnboarding() {
    const el = $('onboarding');
    const busy = fgBusy();
    if (el.dataset.ready) {
      $('ob-busy').hidden = !busy;
      $('ob-busy-label').textContent = (state && state.status.busy) || '';
      return;
    }
    el.dataset.ready = '1';
    el.innerHTML = `
      <h2>What do you want to build?</h2>
      <p class="muted">I plan your roadmap (~1-2 min) while you answer ~10 quick predict-the-output checks in the editor. No essays.</p>
      <textarea id="ob-goal" rows="4" placeholder="e.g. A CLI todo app in Python that saves to a JSON file and supports due dates"></textarea>
      <label class="muted" for="ob-bg">Your background (optional)</label>
      <textarea id="ob-bg" rows="2" placeholder="e.g. Know basic JS, never used Python, struggle with recursion"></textarea>
      <button class="primary" id="ob-start">Start</button>
      <div id="ob-busy" hidden><span class="spinner"></span><span id="ob-busy-label"></span></div>
      <ul class="how">
        <li><b>Quick checks, 1-minute fixes.</b> Each concept starts with a question in a practice tab beside your code. Know it already? You are through in about 25 s. A wrong answer gets a fix aimed at that one belief.</li>
        <li><b>Specs turn green as you build.</b> Each task comes with small behaviour checks that run when you save. You write all the code.</li>
        <li><b>Help on your own line.</b> When you are stuck, a hint ladder points at the line you are working on: question, concept, steps, skeleton, smallest piece.</li>
        <li><b>Never idle.</b> While the coach prepares the next thing, short sprints keep earlier concepts fast.</li>
      </ul>`;
    const start = /** @type {HTMLButtonElement} */ ($('ob-start'));
    const go = () => {
      const goal = /** @type {HTMLTextAreaElement} */ ($('ob-goal')).value.trim();
      const background = /** @type {HTMLTextAreaElement} */ ($('ob-bg')).value.trim();
      if (!goal) return $('ob-goal').focus();
      start.disabled = true;
      setTimeout(() => (start.disabled = false), 2000);
      send({ type: 'startProject', goal, background });
    };
    start.addEventListener('click', go);
    $('ob-goal').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        go();
      }
    });
    renderOnboarding();
  }

  function meterRow(label, value, fillClass, text, title) {
    return `<div class="meter-row"${title ? ` title="${esc(title)}"` : ''}>
        <span class="meter-label">${esc(label)}</span>
        <div class="meter"><div class="fill ${fillClass}" data-w="${value}"></div></div>
        <span class="meter-val">${esc(text)}</span>
      </div>`;
  }

  function ladderHtml(t) {
    const l = t.ladder;
    if (!l) {
      if (t.solo) return '<div class="muted small">Solo task: no spec titles, hints up to rung 2.</div>';
      return '';
    }
    const icon = { passed: '✓', failed: '✗', 'not-yet': '○', 'not-run': '○' };
    const rows = (l.titles || [])
      .map((x) => `<li class="spec spec-${esc(x.display)}"><span class="sicon" aria-hidden="true">${icon[x.display] || '○'}</span><span>${esc(x.title)}</span></li>`)
      .join('');
    const fill = l.total && l.passed === l.total ? 'good' : 'cool';
    return `<div class="ladder">
        ${meterRow('Specs', l.total ? (l.passed / l.total) * 100 : 0, fill, `${l.passed}/${l.total}`, l.summary)}
        ${rows ? `<ol class="specs">${rows}</ol>` : `<div class="muted small">${esc(l.summary)}</div>`}
        ${l.target ? `<div class="target small"><span class="muted">failing:</span> <code>${esc(l.target)}</code></div>` : ''}
      </div>`;
  }

  function renderStatus() {
    const el = $('status');
    const s = state.status;
    const p = state.project;
    const t = state.task;
    if (!t || !s.taskTitle) {
      let html = p ? `<div class="status-title">${esc(p.title)}</div>` : '';
      if (p && p.planError) {
        html += `<div class="notice error">Roadmap failed: ${esc(p.planError)} <button class="primary" data-command="retryPlan">Retry</button></div>`;
      } else if (p && p.planPending) {
        html += `<div class="notice"><span class="spinner"></span><span>Designing your roadmap (~1-2 min)${p.placement && p.placement.running ? ' · placement is open in the editor' : ''}</span></div>`;
      }
      el.innerHTML = html;
      return;
    }
    const over = s.estimate && s.activeMin > s.estimate;
    let stuckHtml = '';
    if (s.stuck) {
      const cls = s.stuck.score >= 1 ? 'hot' : s.stuck.score >= 0.6 ? 'warm' : 'cool';
      stuckHtml = meterRow('Stuck', s.stuck.score * 100, cls, `${Math.round(s.stuck.minutes)}/${Math.round(s.stuck.threshold)}m`,
        (s.stuck.reasons || []).join(', ') || `Last progress: ${s.stuck.since}`);
    }
    const pills = [
      `<span class="pill phase-${esc(t.phase)}">${esc(t.phase)}</span>`,
      t.solo ? '<span class="pill solo">solo</span>' : '',
      t.kind === 'followup' ? '<span class="pill">follow-up</span>' : '',
    ].join(' ');
    el.innerHTML = `
      <div class="status-title">${esc(t.title)} ${pills}</div>
      ${t.interface ? `<div class="iface"><code>${esc(t.interface)}</code></div>` : ''}
      ${ladderHtml(t)}
      ${meterRow('Time', s.estimate ? (s.activeMin / s.estimate) * 100 : 0, over ? 'warm' : 'cool', `${Math.floor(s.activeMin)}/${s.estimate}m`)}
      ${stuckHtml}
      ${s.hints ? `<div class="muted small">${s.hints} hint${s.hints > 1 ? 's' : ''} used</div>` : ''}
      ${t.notUnderstood ? '<div class="muted small">Some of your predictions about your own code missed: a few more what-if questions at the end.</div>' : ''}`;
    applyStyles(el);
    applyBusy();
  }

  function renderBusy() {
    const s = state.status;
    const bg = s.background || {};
    const n = (bg.running || 0) + (bg.queued || 0);
    const paused = bg.pausedUntil && bg.pausedUntil > Date.now();
    const bgText = paused
      ? `background prep paused (plan limit) until ${new Date(bg.pausedUntil).toTimeString().slice(0, 5)}`
      : n ? `${n} preparing in background` : '';
    const show = !!s.busy || !!bgText || !!s.practiceWhileWaiting;
    $('busy').hidden = !show;
    $('busy-spin').hidden = !(s.busy || (bg.running && !paused));
    $('busy-label').textContent = s.busy ? `${s.busy}…` : '';
    $('bg-label').textContent = s.busy && bgText ? ` · ${bgText}` : bgText;
    $('pww').hidden = !s.practiceWhileWaiting;
  }

  function time(at) {
    if (!at) return '';
    const d = new Date(at);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function actionsHtml(c) {
    return (c.actions || [])
      .map((a) => `<button class="${a.primary ? 'primary' : ''}" data-command="${esc(a.command)}" data-arg="${esc(a.arg || '')}"${fgAttr(a.command)}>${esc(a.label)}</button>`)
      .join('');
  }

  function renderFeed() {
    const feed = $('feed');
    const cards = state.feed || [];
    const taskId = state.task ? state.task.id : null;
    feed.innerHTML = cards
      .map((c) => {
        const actions = actionsHtml(c);
        if (c.kind === 'log') {
          const open = expanded.has(c.id);
          return `<article class="log${open ? ' open' : ''}" data-log="${esc(c.id)}" tabindex="0" role="button" aria-expanded="${open}">
              <span class="log-time">${esc(time(c.at))}</span>
              <span class="log-title">${esc(c.title)}</span>
              <div class="log-body">${c.html}</div>
              ${actions ? `<div class="actions">${actions}</div>` : ''}
            </article>`;
        }
        return `<article class="card kind-${esc(c.kind)}">
            <header>${esc(c.title)}</header>
            <div class="body">${c.html}</div>
            ${actions ? `<div class="actions">${actions}</div>` : ''}
          </article>`;
      })
      .join('');
    if (cards.length !== lastCardCount || taskId !== lastTaskId) feed.lastElementChild?.scrollIntoView({ block: 'start' });
    lastCardCount = cards.length;
    lastTaskId = taskId;
  }

  function renderComposer() {
    const m = state.input;
    $('composer').hidden = m.mode === 'none';
    $('mode-label').textContent = m.label || MODE_LABELS[m.mode] || '';
    input.placeholder = m.placeholder || '';
    const asks = ASK_MODES.has(m.mode);
    const askBtn = asks ? '' : '<button data-ask="1" data-fg="1">Ask instead</button>';
    $('composer-buttons').innerHTML =
      `<button class="primary" data-submit="1"${asks ? ' data-fg="1"' : ''}>${esc(m.submitLabel || 'Send')}</button>` +
      (m.extras || []).map((x) => `<button data-command="${esc(x.command)}" data-arg="${esc(x.arg || '')}"${fgAttr(x.command)}>${esc(x.label)}</button>`).join('') +
      askBtn;
  }

  function renderRoadmap() {
    const p = state.project;
    const icon = { done: '✓', active: '●', todo: '○', skipped: '–' };
    let html = `<h3>${esc(p.title)}</h3><p class="muted">${esc(p.goal)}</p>`;
    if (p.language) html += `<div class="muted small">Language: ${esc(p.language)}</div>`;
    if (p.planError) html += `<div class="notice error">Roadmap failed: ${esc(p.planError)} <button class="primary" data-command="retryPlan">Retry</button></div>`;
    else if (p.planPending) html += '<div class="notice"><span class="spinner"></span><span>Designing your roadmap (~1-2 min)</span></div>';
    html += (p.milestones || [])
      .map((m, i) => {
        const tasks = (m.tasks || [])
          .map(
            (t) => `<button class="task-row status-${esc(t.status)}${t.current ? ' current' : ''}" data-indent="${Number(t.depth) || 0}"
                data-command="startTask" data-arg="${esc(t.id)}" title="${t.current ? 'Current task' : 'Open this task'}">
              <span class="ticon">${icon[t.status] || '○'}</span>
              <span class="tname">${t.kind === 'followup' ? '↳ ' : ''}${esc(t.title)}</span>
              ${t.solo ? '<span class="pill solo">solo</span>' : ''}
            </button>`,
          )
          .join('');
        const empty = m.preparing
          ? '<div class="muted small"><span class="spinner inline"></span> preparing tasks…</div>'
          : '<div class="muted small">Tasks are written when you get close to this milestone.</div>';
        return `<div class="milestone"><div class="ms-title">${i + 1}. ${esc(m.title)}</div>
            ${m.goal ? `<div class="muted small">${esc(m.goal)}</div>` : ''}
            ${tasks || empty}</div>`;
      })
      .join('');
    html += '<div class="actions"><button data-command="sprint" title="Interleaved due, fragile and audit items in the practice tab (Ctrl+Alt+S)">Sprint (3 min)</button><button data-command="newProject">New goal…</button></div>';
    $('tab-roadmap').innerHTML = html;
  }

  const CHIP_FILL = { Misconception: 'hot', Fixing: 'warm', Unknown: 'hot', Fragile: 'warm', Learning: 'cool', Solid: 'good', Fluent: 'good' };

  function conceptHtml(c) {
    const p = Math.round((c.mastery || 0) * 100);
    const chip = c.chip || (c.mastered ? 'Solid' : 'Learning');
    const trend =
      c.trend == null ? '' : c.trend < -0.1 ? `<span class="good-text">▼ ${Math.round(-c.trend * 100)}% faster</span>` : c.trend > 0.1 ? '<span class="warm-text">▲ slower</span>' : '';
    const flags = [
      c.inferred ? '<span class="flag" title="Inferred from concepts that build on it, not tested directly">inferred</span>' : '',
      !c.tested && !c.inferred ? '<span class="flag" title="Not tested yet">untested</span>' : '',
      c.due ? '<span class="flag">review due</span>' : '',
    ].join('');
    const beliefs = (c.misconceptions || [])
      .map((m) => `<li class="belief belief-${esc(m.status)}"><span class="bstat">${esc(m.status)}</span> “${esc(m.belief || m.id)}”</li>`)
      .join('');
    const meta = [
      c.attempts ? `${c.attempts} task${c.attempts > 1 ? 's' : ''}` : '',
      c.hints ? `${c.hints} hint${c.hints > 1 ? 's' : ''}` : '',
      c.avgMin != null ? `avg ${Math.round(c.avgMin)}m` : '',
    ].filter(Boolean).join(' · ');
    return `<div class="concept">
        <div class="concept-head"><span><span class="chip chip-${esc(chip.toLowerCase())}">${esc(chip)}</span> ${esc(c.name)} ${flags}</span><span class="muted">P ${p}%</span></div>
        <div class="meter"><div class="fill ${CHIP_FILL[chip] || 'cool'}" data-w="${p}"></div></div>
        ${beliefs ? `<ul class="beliefs">${beliefs}</ul>` : ''}
        ${meta || trend ? `<div class="muted small">${esc(meta)} ${trend}</div>` : ''}
      </div>`;
  }

  function deckHtml(deck) {
    if (!deck || !deck.length) return '<p class="muted small">Patterns you meet in practice collect here, with when to use them.</p>';
    return `<div class="deck">${deck
      .map(
        (d) => `<div class="pcard">
          <div class="pcard-head"><b>${esc(d.name)}</b> <span class="pill">${d.kind === 'semantics' ? 'rule' : 'pattern'}</span></div>
          ${d.useWhen ? `<div class="small">Use when: ${esc(d.useWhen)}</div>` : ''}
          ${d.kind === 'semantics' ? (d.rule ? `<div class="small">Rule: ${esc(d.rule)}</div>` : '') : d.template ? `<pre class="tpl">${esc(d.template)}</pre>` : ''}
          ${d.pitfall ? `<div class="muted small">Pitfall: ${esc(d.pitfall)}</div>` : ''}
        </div>`,
      )
      .join('')}</div>`;
  }

  function fmtSec(sec) {
    if (sec == null || !isFinite(sec)) return '–';
    if (sec < 90) return `${Math.round(sec)} s`;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return s ? `${m} min ${s} s` : `${m} min`;
  }

  /** value against a target: ok when at or under it (or at or over, for `atLeast`). */
  function vs(value, target, text, atLeast) {
    if (value == null || !isFinite(value)) return '<span class="muted">–</span>';
    const ok = atLeast ? value >= target : value <= target;
    return `<span class="${ok ? 'good-text' : 'warm-text'}">${esc(text)}</span>`;
  }

  function paceHtml(pace, extra) {
    extra = extra || {};
    const b = extra.blocks || {};
    const block = (k, target) => {
      const x = b[k] || { count: 0 };
      return x.count ? `${vs(x.medianSec, target, fmtSec(x.medianSec))} <span class="muted">(${x.count})</span>` : '<span class="muted">–</span>';
    };
    const solo = extra.solo || { count: 0, unaided: 0 };
    const rows = [
      ['Start to first keystroke', vs(extra.firstKeystrokeSec, 240, fmtSec(extra.firstKeystrokeSec)), 'Goal: 4 min or less'],
      ['Concept block, known', block('known', 30), 'Median; goal 30 s or less'],
      ['Concept block, misconception', block('misconception', 70), 'Median; goal 70 s or less'],
      ['Concept block, new concept', block('unknown', 120), 'Median; goal 120 s or less'],
      ['Model wait per task', vs(extra.waitPerTaskSec, 5, fmtSec(extra.waitPerTaskSec)), 'Median time you waited on the model; goal 5 s or less'],
      [
        'Solo tasks',
        solo.count
          ? `${solo.count} done · ${vs(solo.rate, 0.5, `${Math.round((solo.rate || 0) * 100)}% unaided`, true)} · median ${esc(fmtSec((solo.medianMin || 0) * 60))}`
          : '<span class="muted">–</span>',
        'Unaided: no hint past rung 1, no reveal, under 120 pasted or assisted characters',
      ],
    ];
    if (pace && pace.prefetchedHints != null) rows.push(['Hints ready before you asked', vs(pace.prefetchedHints, 0.7, `${Math.round(pace.prefetchedHints * 100)}%`, true), 'Goal: 70% or more']);
    if (pace && pace.bitsPerTask != null) rows.push(['Evidence per task', esc(`${pace.bitsPerTask} bits`), 'Median information each finished task gave the learner model']);
    if (pace && pace.placement && pace.placement.items) rows.push(['Placement', esc(`${pace.placement.items} items`), 'Goal: 14 or fewer']);
    const flags = pace ? [
      pace.conflictFlags ? `${pace.conflictFlags} fast-green-but-unsure task${pace.conflictFlags > 1 ? 's' : ''}` : '',
      pace.overfitFlags ? `${pace.overfitFlags} hidden-spec miss${pace.overfitFlags > 1 ? 'es' : ''}` : '',
      pace.deadlineMisses ? `${pace.deadlineMisses} late preparation${pace.deadlineMisses > 1 ? 's' : ''}` : '',
    ].filter(Boolean) : [];
    const ms = pace && pace.milestones && pace.milestones.some((m) => m.tasksDone)
      ? `<table class="pace-ms"><thead><tr><th>Milestone</th><th>Tasks</th><th>Active</th><th>Model wait</th></tr></thead><tbody>${pace.milestones
          .filter((m) => m.tasksDone)
          .map((m) => `<tr><td>${esc(m.title)}</td><td>${m.tasksDone}</td><td>${m.activeMin} min</td><td>${fmtSec(m.waitSec)}</td></tr>`)
          .join('')}</tbody></table>`
      : '';
    const soloList = pace && pace.solo && pace.solo.length
      ? `<ul class="solo-list">${pace.solo.map((s) => `<li>${esc(s.title)} <span class="muted">· ${s.activeMin} min ·</span> ${s.unaided ? '<span class="good-text">unaided</span>' : '<span class="muted">with help</span>'}</li>`).join('')}</ul>`
      : '';
    return `<table class="pace">${rows.map(([k, v, title]) => `<tr title="${esc(title)}"><td>${esc(k)}</td><td>${v}</td></tr>`).join('')}</table>
      ${ms}${soloList}
      ${flags.length ? `<div class="muted small">${esc(flags.join(' · '))}</div>` : ''}`;
  }

  function renderProgress() {
    const pr = state.progress;
    const t = pr.totals || { tasksDone: 0, hintsUsed: 0, reveals: 0, activeMinutes: 0 };
    const hpt = t.tasksDone ? (t.hintsUsed / t.tasksDone).toFixed(1) : '–';
    const concepts = (pr.concepts || []).map(conceptHtml).join('');
    const mistakes = (pr.mistakes || []).length
      ? pr.mistakes.map((m) => `<li><b>${esc(m.pattern)}</b> ×${m.count}<div class="muted small">${esc(m.detail)}</div></li>`).join('')
      : '<li class="muted">No mistakes recorded yet.</li>';
    const cal = pr.calibration || {};
    const audits = pr.audits || {};
    const auditLine = audits.passed || audits.failed
      ? `Mastery audits: ${audits.passed || 0} passed, ${audits.failed || 0} failed${audits.falseMastery ? ` (${audits.falseMastery} revoked)` : ''}`
      : '';
    const shell = state.shell || {};
    $('tab-progress').innerHTML = `
      <div class="stats">
        <div><b>${t.tasksDone}</b><span>tasks done</span></div>
        <div><b>${t.activeMinutes}</b><span>active min</span></div>
        <div><b>${hpt}</b><span>hints / task</span></div>
        <div><b>${t.reveals}</b><span>reveals</span></div>
      </div>
      ${cal.text || auditLine ? `<div class="muted small calib">${esc(cal.text || '')}${cal.text && auditLine ? '<br>' : ''}${esc(auditLine)}</div>` : ''}
      <h3>Concepts <span class="muted small">(weakest first)</span></h3>
      ${concepts || '<p class="muted">No concepts yet.</p>'}
      <h3>Pattern Deck</h3>
      ${deckHtml(pr.deck)}
      <h3>Pace</h3>
      ${paceHtml(pr.pace, shell.pace)}
      <h3>Mistake journal</h3>
      <ul class="mistakes">${mistakes}</ul>
      ${shell.execution ? `<div class="exec muted small">${esc(shell.execution)} <button class="link" data-command="chooseExecution">Change</button> <button class="link" data-command="showLog">Log</button></div>` : ''}`;
  }

  // ------------------------------------------------------------ events

  function toggleLog(el) {
    const id = el.getAttribute('data-log');
    if (!id) return;
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    el.classList.toggle('open', expanded.has(id));
    el.setAttribute('aria-expanded', String(expanded.has(id)));
    persist({});
  }

  document.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const button = target.closest('button');
    if (!button) {
      const log = target.closest('[data-log]');
      if (log && !target.closest('a')) toggleLog(/** @type {HTMLElement} */ (log));
      return;
    }
    if (button.hasAttribute('disabled')) return;
    const t = button.getAttribute('data-tab');
    if (t) {
      tab = t;
      persist({});
      if (t === 'progress') send({ type: 'tab', tab: t });
      return render();
    }
    if (button.hasAttribute('data-submit')) return submit('submit');
    if (button.hasAttribute('data-ask')) return submit('ask');
    const command = button.getAttribute('data-command');
    if (command) {
      if (isFg(command) && fgBusy()) return;
      send({ type: 'command', command, arg: button.getAttribute('data-arg') || undefined });
      if (command === 'startTask') {
        tab = 'coach';
        persist({});
        render();
      }
    }
  });

  document.addEventListener('keydown', (e) => {
    const el = /** @type {HTMLElement} */ (e.target);
    if ((e.key === 'Enter' || e.key === ' ') && el.hasAttribute && el.hasAttribute('data-log')) {
      e.preventDefault();
      toggleLog(el);
    }
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'state') {
      state = msg.state;
      render();
    } else if (msg.type === 'status' && state) {
      state.status = msg.status;
      if (!state.hasProject) return renderOnboarding();
      renderStatus();
      renderBusy();
      applyBusy();
    } else if (msg.type === 'focusComposer') {
      tab = 'coach';
      persist({});
      render();
      input.focus();
    }
  });

  send({ type: 'ready' });
  if (tab === 'progress') send({ type: 'tab', tab });
})();
