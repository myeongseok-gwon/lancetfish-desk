import { api, icon, esc, clock, timeOf, dayOf, dateOf, dayKey, toast, enableTips, topbar, APP_LABEL } from '/ui/common.js';

document.getElementById('top').innerHTML = topbar('dashboard');
enableTips();

const stage = document.getElementById('stage');
let data = null, fetchedAt = 0, shown = '', busy = false;

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {  } },
};

async function refresh() {
  try {
    data = await api('/api/dashboard');
    fetchedAt = Date.now();
    renderStage();
    renderRail();
  } catch (e) {  }
}

function renderStage() {
  const f = data.focus;
  const key = f.status + (f.id || '');
  if (key !== shown) {
    shown = key;
    if (f.status === 'idle') stage.innerHTML = idleHTML(f);
    else if (f.status === 'running' || f.status === 'paused') stage.innerHTML = runningHTML(f);
    else if (f.status === 'complete') stage.innerHTML = completeHTML(f);
    else if (f.status === 'break') stage.innerHTML = breakHTML(f);
    bindStage(f);
  }
  tick();
}

function idleHTML(f) {
  const kind = store.get('lf.kind', 'Reading');
  const mins = Number(store.get('lf.minutes', '50'));
  return `<div class="idle">
    <input class="intent-input" id="intent" autocomplete="off" spellcheck="false" placeholder="What are you locking in on?" aria-label="What are you locking in on?">
    <div class="chips" id="kinds">${f.kinds.map((k) => `<button class="chip" data-kind="${esc(k)}" aria-pressed="${k === kind}">${esc(k)}</button>`).join('')}</div>
    <div class="chips" id="lengths">${f.lengths.map((m) => `<button class="chip small" data-min="${m}" aria-pressed="${m === mins}">${m} min</button>`).join('')}</div>
    <div class="hint"><span class="kbd">Enter</span> to start</div>
  </div>`;
}

function runningHTML(f) {
  return `<div class="running ${f.status === 'paused' ? 'paused' : ''}" id="run">
    <div class="run-kind"><span class="dot"></span>${esc(f.kind)} · ${f.minutes} min</div>
    <div class="run-intent">${esc(f.intent)}</div>
    <div class="clock" id="clock">${clock(f.remainingMs)}</div>
    <div class="progress"><i id="prog" style="width:0%"></i></div>
    <div class="paused-label" id="pausedLabel"></div>
    <div class="run-meta">
      <div class="score" id="score"><span class="num" id="scoreNum">…</span><span class="lbl">Focus<br>score</span><svg class="spark" id="spark" viewBox="0 0 120 30" preserveAspectRatio="none"></svg></div>
      <div class="controls">
        ${f.status === 'paused'
          ? `<button class="btn" data-act="resume">${icon('play')}Resume</button>`
          : `<button class="btn" data-act="pause">${icon('pause')}Pause</button>`}
        <button class="btn" data-act="finish">${icon('check')}Finish</button>
        <button class="btn quiet" data-act="discard">${icon('x')}Discard</button>
      </div>
    </div>
  </div>`;
}

function completeHTML(f) {
  const b = f.block || {};
  const score = b.meanScore != null ? ` · focus ${b.meanScore}` : '';
  return `<div class="complete">
    <div class="run-kind"><span class="dot"></span>${esc(b.kind || '')}</div>
    <h2>${b.completed ? 'Block complete' : 'Block saved'}</h2>
    <p>${esc(b.intent || '')}</p>
    <p class="muted" style="font-size:14px">${Math.round(b.actualMinutes || 0)} of ${b.plannedMinutes} min${score}</p>
    <div class="controls" style="margin-top:10px">
      <button class="btn" data-act="break" data-min="5">Break 5 min</button>
      <button class="btn" data-act="break" data-min="10">Break 10 min</button>
      <button class="btn quiet" data-act="dismiss">Done</button>
    </div>
  </div>`;
}

function breakHTML() {
  return `<div class="breaking">
    <div class="run-kind">Break</div>
    <div class="break-clock" id="clock"></div>
    <button class="btn quiet" data-act="dismiss">End break</button>
  </div>`;
}

function bindStage(f) {
  if (f.status === 'idle') {
    const input = document.getElementById('intent');
    setTimeout(() => input.focus(), 50);
    const pick = (sel, attr, key) => stage.querySelector(sel).addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      stage.querySelectorAll(`${sel} button`).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      store.set(key, b.dataset[attr]);
      input.focus();
    });
    pick('#kinds', 'kind', 'lf.kind');
    pick('#lengths', 'min', 'lf.minutes');
    input.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter' || busy) return;
      const intent = input.value.trim();
      if (!intent) { input.focus(); return; }
      const kind = stage.querySelector('#kinds [aria-pressed="true"]')?.dataset.kind || 'Reading';
      const minutes = Number(stage.querySelector('#lengths [aria-pressed="true"]')?.dataset.min || 50);
      await act('start', { intent, kind, minutes });
    });
    return;
  }
  stage.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
    const a = b.dataset.act;
    if (a === 'discard') {

      if (!b.dataset.armed) { b.dataset.armed = '1'; b.innerHTML = `${icon('x')}Discard block?`; setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.innerHTML = `${icon('x')}Discard`; } }, 3000); return; }
    }
    act(a, a === 'break' ? { minutes: Number(b.dataset.min) } : {});
  }));
}

async function act(name, body = {}) {
  busy = true;
  try {
    const f = await api(`/api/focus/${name}`, body);
    data.focus = f; fetchedAt = Date.now(); shown = '';
    renderStage();
    if (name === 'finish' || name === 'dismiss' || name === 'discard') refresh();
  } catch (e) { toast(e.message); } finally { busy = false; }
}

function tick() {
  if (!data) return;
  const f = data.focus;
  const dt = Date.now() - fetchedAt;
  const el = document.getElementById('clock');
  if (f.status === 'running' || f.status === 'paused') {
    const rem = f.status === 'running' ? Math.max(0, f.remainingMs - dt) : f.remainingMs;
    if (el) el.textContent = clock(rem);
    const prog = document.getElementById('prog');
    if (prog) prog.style.width = `${Math.min(100, 100 * (1 - rem / (f.minutes * 60000)))}%`;
    const pl = document.getElementById('pausedLabel');
    if (pl) pl.textContent = f.status === 'paused' ? `Paused ${clock(f.pausedForMs + dt)}` : '';
    const sn = document.getElementById('scoreNum');
    if (sn) sn.textContent = f.score == null ? '…' : String(f.score);
    drawSpark(f.spark || []);
    const sc = document.getElementById('score');
    if (sc && f.lastSample) {
      const s = f.lastSample;
      sc.dataset.tip = `Presence ${s.p.toFixed(2)} (idle ${s.idle ?? '?'} s) · ${s.c === 1 ? 'on-task app' : 'off-list app'}${s.app ? ` (${s.app})` : ''} · substance +${s.b.toFixed(2)}${f.substance ? `, ${f.substance} act${f.substance === 1 ? '' : 's'}` : ''}`;
    } else if (sc) sc.dataset.tip = 'Sampled every 15 seconds from presence, the frontmost app and real acts';
    if (f.status === 'running' && rem <= 0 && !tick.pending) { tick.pending = true; setTimeout(() => { tick.pending = false; refresh(); }, 600); }
  } else if (f.status === 'break') {
    const rem = Math.max(0, f.remainingMs - dt);
    if (el) el.textContent = clock(rem);
    if (rem <= 0 && !tick.pending) { tick.pending = true; setTimeout(() => { tick.pending = false; refresh(); }, 600); }
  }
}

function drawSpark(vals) {
  const svg = document.getElementById('spark');
  if (!svg) return;
  const key = vals.join(',');
  if (svg.dataset.k === key) return;
  svg.dataset.k = key;
  if (vals.length < 2) { svg.innerHTML = ''; return; }
  const n = vals.length, W = 120, H = 30;
  const pts = vals.map((v, i) => [(i / (n - 1)) * (W - 4) + 2, H - 3 - (Math.max(0, Math.min(100, v)) / 100) * (H - 6)]);
  svg.innerHTML = `<polyline points="${pts.map((p) => p.join(',')).join(' ')}"/><circle cx="${pts[n - 1][0]}" cy="${pts[n - 1][1]}" r="2.4"/>`;
}

function renderRail() {
  const A = document.querySelector('#agents .body');
  A.innerHTML = data.agents.length ? data.agents.slice(0, 6).map((a) => `
    <div class="agent">
      ${icon(a.app)}
      <div class="t" data-tip="${esc(APP_LABEL[a.app])}: ${esc(a.title)}">${esc(a.title)}</div>
      <div class="ago">${a.minutesAgo ? `${a.minutesAgo}m` : 'now'}</div>
      <div class="s"><span class="state-dot ${a.state}"></span>${a.state === 'waiting' ? '<span class="waiting-txt">waiting for you</span>' : 'working'}${a.project ? ` · ${esc(a.project)}` : ''}</div>
    </div>`).join('') : '<div class="empty-line">No agents active</div>';

  const L = data.limits;
  const asof = [L.claude && L.claude.at, L.codex && L.codex.at].filter(Boolean);
  document.querySelector('#limits .asof').textContent = asof.length ? `as of ${timeOf(Math.min(...asof))}` : '';
  document.querySelector('#limits .body').innerHTML = [['Claude', L.claude], ['Codex', L.codex]].map(([name, v]) => {
    if (!v || v.absent) return `<div class="limit-group"><div class="limit-name">${name}</div><div class="empty-line" style="font-size:12px">${esc(v ? v.message : 'Unavailable')}</div></div>`;
    const stale = v.at && Date.now() - v.at > 2 * 3600 * 1000 ? ` <span class="muted">· as of ${timeOf(v.at)}</span>` : '';
    return `<div class="limit-group"><div class="limit-name"><span>${name}${stale}</span></div>
      ${limitRow('5h', v.fiveHour, false)}${limitRow('7d', v.sevenDay, true)}</div>`;
  }).join('');

  const T = data.today;
  const ev = T.events.length ? T.events.map((e) => `<div class="event"><span class="when">${e.allDay ? 'All day' : (dayKey(e.start) === dayKey(Date.now()) ? timeOf(e.start) : `${dayOf(e.start)} ${timeOf(e.start).replace(':00', '')}`)}</span><span class="what" data-tip="${esc(e.title)}${e.location ? ` · ${esc(e.location)}` : ''}">${esc(e.title)}</span></div>`).join('')
    : '<div class="empty-line">Nothing else on the calendar</div>';
  const done = T.completed, goal = T.goal;
  const dots = Array.from({ length: Math.max(goal, done) }, (_, i) => `<i class="${i < done ? 'on' : ''}"></i>`).join('');
  const blockTip = T.blocks.length ? T.blocks.map((b) => `${b.completed ? '●' : '○'} ${b.intent} (${Math.round(b.actualMinutes)} min)`).join('\n') : 'No blocks yet today';
  document.querySelector('#today .body').innerHTML = `${ev}<div class="dots" data-tip="${esc(blockTip)}" style="margin-top:6px">${dots}<span>${done} of ${goal} blocks</span></div>`;

  const H = data.heatmap;
  const level = (m) => (m <= 0 ? 0 : m < 30 ? 1 : m < 90 ? 2 : m < 180 ? 3 : 4);
  const total = H.days.slice(-7).reduce((a, d) => a + d.minutes, 0);
  document.querySelector('#history .asof').textContent = `${hm(total)} in 7 days`;
  document.querySelector('#history .body').innerHTML = `<div class="heat">${H.days.map((d) => {
    const t = Date.parse(d.day + 'T12:00:00');
    const tip = d.suspect ? `${dateOf(t)}: ${hm(d.logged)} logged, more than a day, so shown as 24 h` : `${dateOf(t)}: ${d.minutes ? hm(d.minutes) : 'nothing logged'}`;
    return `<i class="l${level(d.minutes)}${d.day === H.today ? ' today' : ''}${d.suspect ? ' suspect' : ''}" data-tip="${tip}"></i>`;
  }).join('')}</div>
  <div class="heat-legend">less <i style="background:var(--heat-0)"></i><i style="background:var(--heat-1)"></i><i style="background:var(--heat-2)"></i><i style="background:var(--heat-3)"></i><i style="background:var(--heat-4)"></i> more</div>`;
}

function hm(min) {
  min = Math.round(min);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function limitRow(label, w, weekly) {
  if (!w || w.used == null) return '';
  const pct = Math.round(w.used);
  let reset = '';
  if (w.rolled) reset = 'reset since';
  else if (w.resetsAt) {
    const soon = w.resetsAt - Date.now() < 20 * 3600 * 1000;
    reset = `resets ${weekly && !soon ? dayOf(w.resetsAt) : timeOf(w.resetsAt)}`;
  }
  return `<div class="limit"><span>${label}</span><span class="bar"><i class="${pct >= 80 ? 'high' : ''}" style="width:${pct}%"></i></span><span class="pct">${pct}%</span><span class="reset">${reset}</span></div>`;
}

refresh();
setInterval(tick, 250);
setInterval(refresh, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
