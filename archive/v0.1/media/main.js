// @ts-check
(function () {
  // @ts-ignore - provided by VS Code
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const saved = vscode.getState() || {};
  let tab = saved.tab || 'coach';
  let state = null;
  let lastCardCount = 0;
  let lastTaskId = null;

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const send = (msg) => vscode.postMessage(msg);
  const persist = (extra) => vscode.setState({ ...vscode.getState(), tab, ...extra });

  app.innerHTML = `
    <div id="onboarding" hidden></div>
    <div id="main" hidden>
      <nav class="tabs">
        <button data-tab="coach">Coach</button>
        <button data-tab="roadmap">Roadmap</button>
        <button data-tab="progress">Progress</button>
      </nav>
      <section id="status"></section>
      <section id="tab-coach" class="tab">
        <div id="feed"></div>
        <div id="busy" hidden><span class="spinner"></span><span id="busy-label"></span></div>
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

  function submit(kind) {
    const text = input.value.trim();
    if (!text || (state && state.status.busy)) return;
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
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.getAttribute('data-tab') === tab));
    document.querySelectorAll('.tab').forEach((s) => ((/** @type {HTMLElement} */ (s)).hidden = s.id !== `tab-${tab}`));
    renderStatus(state.status);
    renderFeed();
    renderComposer();
    renderRoadmap();
    renderProgress();
  }

  function renderOnboarding() {
    const el = $('onboarding');
    if (el.dataset.ready) {
      el.querySelector('button').disabled = !!(state && state.status.busy);
      $('ob-busy').hidden = !(state && state.status.busy);
      $('ob-busy-label').textContent = state?.status.busy || '';
      return;
    }
    el.dataset.ready = '1';
    el.innerHTML = `
      <h2>What do you want to build?</h2>
      <p class="muted">Describe the project. I'll turn it into a roadmap, check what you already know in ~5 minutes, then coach you while you build it yourself.</p>
      <textarea id="ob-goal" rows="4" placeholder="e.g. A CLI todo app in Python that saves to a JSON file and supports due dates"></textarea>
      <label class="muted" for="ob-bg">Your background (optional)</label>
      <textarea id="ob-bg" rows="2" placeholder="e.g. Know basic JS, never used Python, struggle with recursion"></textarea>
      <button class="primary" id="ob-start">Start</button>
      <div id="ob-busy" hidden><span class="spinner"></span><span id="ob-busy-label"></span></div>
      <ul class="how">
        <li><b>Explain first.</b> Before each task you describe your approach. Gaps get a 3-minute lesson, not a 10-hour course.</li>
        <li><b>Struggle, then a nudge.</b> I watch errors, failing runs and stalls. When you're stuck I climb a 5-rung hint ladder: question → concept → approach → skeleton → smallest piece.</li>
        <li><b>Follow-ups until it's easy.</b> Each solved task spawns a follow-up on your weakest concept, until you solve them fast and unaided.</li>
        <li><b>Nothing forgotten.</b> Mistakes go in a journal; concepts come back as spaced recall questions.</li>
      </ul>`;
    $('ob-start').addEventListener('click', () => {
      const goal = /** @type {HTMLTextAreaElement} */ ($('ob-goal')).value.trim();
      const background = /** @type {HTMLTextAreaElement} */ ($('ob-bg')).value.trim();
      if (!goal) return $('ob-goal').focus();
      send({ type: 'startProject', goal, background });
    });
    renderOnboarding();
  }

  function renderStatus(s) {
    const el = $('status');
    $('busy').hidden = !s.busy;
    $('busy-label').textContent = s.busy || '';
    if (!s.taskTitle) {
      el.innerHTML = state?.project ? `<div class="status-title">${esc(state.project.title)}</div>` : '';
      return;
    }
    const pct = s.estimate ? Math.min(100, (s.activeMin / s.estimate) * 100) : 0;
    const over = s.estimate && s.activeMin > s.estimate;
    let stuckHtml = '';
    if (s.stuck) {
      const sp = Math.min(100, s.stuck.score * 100);
      const cls = s.stuck.score >= 1 ? 'hot' : s.stuck.score >= 0.6 ? 'warm' : 'cool';
      stuckHtml = `
        <div class="meter-row" title="${esc(s.stuck.reasons.join(', ') || 'Last progress: ' + s.stuck.since)}">
          <span class="meter-label">Stuck</span>
          <div class="meter"><div class="fill ${cls}" style="width:${sp}%"></div></div>
          <span class="meter-val">${s.stuck.minutes.toFixed(0)}/${s.stuck.threshold.toFixed(0)}m</span>
        </div>
        <div class="muted small">last progress: ${esc(s.stuck.since)}</div>`;
    }
    el.innerHTML = `
      <div class="status-title">${esc(s.taskTitle)} <span class="pill phase-${esc(s.phase)}">${esc(s.phase)}</span></div>
      <div class="meter-row">
        <span class="meter-label">Time</span>
        <div class="meter"><div class="fill ${over ? 'warm' : 'cool'}" style="width:${pct}%"></div></div>
        <span class="meter-val">${Math.floor(s.activeMin)}/${s.estimate}m</span>
      </div>
      ${stuckHtml}
      ${s.hints ? `<div class="muted small">${s.hints} hint${s.hints > 1 ? 's' : ''} used</div>` : ''}`;
  }

  function renderFeed() {
    const feed = $('feed');
    const cards = state.feed || [];
    const taskId = state.task ? state.task.id : null;
    const busy = !!state.status.busy;
    // Keep anything typed into inline card answers across re-renders.
    const drafts = {};
    feed.querySelectorAll('textarea[data-card]').forEach((ta) => (drafts[ta.getAttribute('data-card')] = ta.value));
    feed.innerHTML = cards
      .map((c) => {
        const actions = (c.actions || [])
          .map(
            (a) =>
              `<button class="${a.primary ? 'primary' : ''}" data-command="${esc(a.command)}" data-arg="${esc(a.arg || '')}" data-card-id="${esc(c.id)}" ${busy ? 'disabled' : ''}>${esc(a.label)}</button>`,
          )
          .join('');
        const inline = c.input
          ? `<div class="card-input"><textarea rows="2" placeholder="${esc(c.input.placeholder)}" data-card="${esc(c.id)}"></textarea>
             <button class="primary" data-card-submit="${esc(c.id)}" data-card-command="${esc(c.input.command)}" ${busy ? 'disabled' : ''}>Answer</button></div>`
          : '';
        return `<article class="card kind-${esc(c.kind)}">
          <header>${esc(c.title)}</header>
          <div class="body">${c.html}</div>
          ${inline}
          ${actions ? `<div class="actions">${actions}</div>` : ''}
        </article>`;
      })
      .join('');
    feed.querySelectorAll('textarea[data-card]').forEach((ta) => {
      const v = drafts[ta.getAttribute('data-card')];
      if (v) ta.value = v;
    });
    if (cards.length !== lastCardCount || taskId !== lastTaskId) {
      feed.lastElementChild?.scrollIntoView({ block: 'start' });
    }
    lastCardCount = cards.length;
    lastTaskId = taskId;
  }

  const MODE_LABELS = {
    diagnostic: 'Placement answer',
    explain: 'Your approach',
    check: 'Check question',
    'explain-back': 'Explain it back',
    building: 'Building — ask anything',
    ask: 'Ask the coach',
  };

  function renderComposer() {
    const m = state.input;
    const busy = !!state.status.busy;
    $('composer').hidden = m.mode === 'none';
    $('mode-label').textContent = MODE_LABELS[m.mode] || '';
    input.placeholder = m.placeholder;
    const askBtn = m.mode !== 'ask' && m.mode !== 'building' && m.mode !== 'diagnostic'
      ? `<button data-ask="1" ${busy ? 'disabled' : ''} title="Send as a question instead">Ask instead</button>`
      : '';
    $('composer-buttons').innerHTML =
      `<button class="primary" data-submit="1" ${busy ? 'disabled' : ''}>${esc(m.submitLabel)}</button>` +
      m.extras.map((x) => `<button data-command="${esc(x.command)}" data-arg="${esc(x.arg || '')}" ${busy ? 'disabled' : ''}>${esc(x.label)}</button>`).join('') +
      askBtn;
  }

  function renderRoadmap() {
    const p = state.project;
    const icon = { done: '✓', active: '●', todo: '○', skipped: '–' };
    $('tab-roadmap').innerHTML =
      `<h3>${esc(p.title)}</h3><p class="muted">${esc(p.goal)}</p>` +
      p.milestones
        .map(
          (m, i) => `<div class="milestone"><div class="ms-title">${i + 1}. ${esc(m.title)}</div>
            ${m.tasks
              .map(
                (t) => `<button class="task-row status-${t.status} ${t.current ? 'current' : ''}" style="padding-left:${8 + t.depth * 14}px"
                    data-command="startTask" data-arg="${esc(t.id)}">
                  <span class="ticon">${icon[t.status] || '○'}</span>
                  <span>${t.kind === 'followup' ? '↳ ' : t.kind === 'drill' ? '⚡ ' : ''}${esc(t.title)}</span>
                </button>`,
              )
              .join('')}</div>`,
        )
        .join('') +
      `<div class="actions"><button data-command="speedDrill">⚡ Speed drill</button><button data-command="newProject">New goal…</button></div>`;
  }

  function renderProgress() {
    const pr = state.progress;
    const t = pr.totals;
    const hpt = t.tasksDone ? (t.hintsUsed / t.tasksDone).toFixed(1) : '–';
    const concepts = pr.concepts
      .map((c) => {
        const pct = Math.round(c.mastery * 100);
        const cls = c.mastered ? 'good' : c.mastery >= 0.5 ? 'cool' : c.mastery >= 0.3 ? 'warm' : 'hot';
        const trend =
          c.trend == null ? '' : c.trend < -0.1 ? `<span class="good-text" title="Recent solves faster">▼ ${Math.round(-c.trend * 100)}% faster</span>` : c.trend > 0.1 ? `<span class="warm-text">▲ slower</span>` : '';
        return `<div class="concept">
          <div class="concept-head"><span>${esc(c.name)}${c.due ? ' <span class="pill">review due</span>' : ''}</span><span class="muted">${pct}%</span></div>
          <div class="meter"><div class="fill ${cls}" style="width:${pct}%"></div></div>
          <div class="muted small">${c.attempts} tasks · ${c.hints} hints${c.avgMin != null ? ` · avg ${c.avgMin.toFixed(0)}m` : ''} ${trend}</div>
        </div>`;
      })
      .join('');
    const mistakes = pr.mistakes.length
      ? pr.mistakes.map((m) => `<li><b>${esc(m.pattern)}</b> ×${m.count}<div class="muted small">${esc(m.detail)}</div></li>`).join('')
      : '<li class="muted">No mistakes recorded yet.</li>';
    $('tab-progress').innerHTML = `
      <div class="stats">
        <div><b>${t.tasksDone}</b><span>tasks done</span></div>
        <div><b>${t.activeMinutes}</b><span>active min</span></div>
        <div><b>${hpt}</b><span>hints / task</span></div>
        <div><b>${t.reveals}</b><span>reveals</span></div>
      </div>
      <h3>Concepts <span class="muted small">(weakest first)</span></h3>
      ${concepts || '<p class="muted">No concepts yet.</p>'}
      <h3>Mistake journal</h3>
      <ul class="mistakes">${mistakes}</ul>`;
  }

  // ------------------------------------------------------------ events

  document.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target).closest('button');
    if (!target || target.hasAttribute('disabled')) return;
    const t = target.getAttribute('data-tab');
    if (t) {
      tab = t;
      persist({});
      return render();
    }
    if (target.hasAttribute('data-submit')) return submit('submit');
    if (target.hasAttribute('data-ask')) return submit('ask');
    const cardSubmit = target.getAttribute('data-card-submit');
    if (cardSubmit) {
      const ta = /** @type {HTMLTextAreaElement|null} */ (document.querySelector(`textarea[data-card="${cardSubmit}"]`));
      const text = ta ? ta.value.trim() : '';
      if (text) send({ type: 'cardInput', command: target.getAttribute('data-card-command'), cardId: cardSubmit, text });
      return;
    }
    const command = target.getAttribute('data-command');
    if (command) {
      send({
        type: 'command',
        command,
        arg: target.getAttribute('data-arg') || undefined,
        cardId: target.getAttribute('data-card-id') || undefined,
      });
      if (command === 'startTask') {
        tab = 'coach';
        persist({});
      }
    }
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'state') {
      state = msg.state;
      render();
    } else if (msg.type === 'status' && state) {
      state.status = msg.status;
      renderStatus(msg.status);
    }
  });

  send({ type: 'ready' });
})();
