import { api, icon, esc, toast, enableTips, topbar, when } from '/ui/common.js';
import { PdfPreview } from '/ui/pdf-preview.js';

document.getElementById('top').innerHTML = topbar('inbox');
enableTips();

const $out = document.getElementById('out');
const $sub = document.getElementById('sub');
const $scan = document.getElementById('scan');
const $next = document.getElementById('readNext');
const $bar = document.getElementById('scanbar');
const workspace = document.getElementById('workspace');
const preview = new PdfPreview(document.getElementById('pdfPreview'), () => workspace.classList.remove('has-preview'));
$scan.innerHTML = `${icon('inbox')}Process inbox`;
$next.innerHTML = `${icon('sparkle')}Read next 5`;

let V = null, topics = [], poll = null;
const picked = new Map();
const extra = new Map();
const open = new Set();

const STATE = {
  agree: ['ok', 'Agree', 'Crossref (or arXiv) and Claude’s read agree'],
  disagree: ['warn', 'Disagree', 'The two sources disagree; pick one or fix it'],
  one: ['', 'Only one source', 'Only one source so far'],
  unknown: ['', 'Unidentified', 'No identifier found yet'],
};

const fmtSize = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);
const sourceName = (m) => (!m ? '' : m.source === 'ai' ? 'Claude’s read' : m.source === 'arxiv' ? 'arXiv' : `Crossref (${m.how})`);

function metaBlock(m, other, diff) {
  const d = (f, v) => (diff.includes(f) ? `<span class="diff">${v}</span>` : v);
  return `<div>${d('title', esc(m.title || '(no title)'))}</div>
    <div class="muted">${d('authors', esc((m.authors || []).slice(0, 6).join(', ') + ((m.authors || []).length > 6 ? ', …' : '')))}</div>
    <div class="muted">${d('year', esc(m.year || '?'))} · ${d('venue', esc(m.venue || '?'))}</div>`;
}

function topicChips(c) {
  const sel = picked.get(c.path) || new Set();
  const all = [...topics.map((t) => t.label), ...(extra.get(c.path) || [])];
  return `<div class="topics-wrap ${sel.size ? 'has-picks' : ''}"><div><div class="topics"><span class="topics-label">Topics</span>${all.map((t) => `<button class="chip small" data-topic="${esc(t)}" aria-pressed="${sel.has(t)}">${esc(t)}</button>`).join('')}
    <button class="chip small" data-newtopic>+ new</button></div></div></div>`;
}

function fixForm(c) {
  const m = c.best || {};
  return `<form class="fix" data-fix="${esc(c.path)}">
    <input name="title" value="${esc(m.title || c.titleGuess || '')}" placeholder="Title" aria-label="Title">
    <input name="authors" value="${esc((m.authors || []).join(', '))}" placeholder="Authors, comma separated" aria-label="Authors">
    <div class="two"><input name="year" value="${esc(m.year || '')}" placeholder="Year" aria-label="Year"><input name="venue" value="${esc(m.venue || '')}" placeholder="Venue" aria-label="Venue"></div>
    <input name="doi" value="${esc(m.doi || c.ids.doi || '')}" placeholder="DOI (optional)" aria-label="DOI">
    <div class="bar" style="margin-top:4px"><button class="btn primary" type="submit">${icon('check')}Save</button><button class="btn quiet" type="button" data-cancel>Cancel</button></div>
  </form>`;
}

function fileLine(c) {
  const ids = [c.ids.doi && `DOI ${c.ids.doi}`, c.ids.arxiv && `arXiv ${c.ids.arxiv}`, c.ids.ssrn && `SSRN ${c.ids.ssrn}`].filter(Boolean);
  return `<div class="fi"><span>${esc(c.dir)} / ${esc(c.name)}</span><span>·</span><span>${c.pages || '?'} pages · ${fmtSize(c.size)}</span>${ids.length ? `<span>·</span><span>${esc(ids.join(' · '))}</span>` : ''}<span>·</span><button data-open="${esc(c.path)}">open</button></div>`;
}

function cardHTML(c) {
  if (c.decided) {
    const label = { yes: 'Confirmed', fix: 'Fixed', 'not-paper': 'Not a paper' }[c.decided.decision] || c.decided.decision;
    return `<div class="icard done" data-path="${esc(c.path)}"><span class="q">${icon('check')} ${esc(label)}: ${esc((c.best && c.best.title) || c.name)}</span>${['yes', 'fix'].includes(c.decided.decision) ? '<button class="btn" data-file-confirmed>Add to library</button>' : ''}<button class="btn quiet" data-undo>Undo</button></div>`;
  }
  const st = STATE[c.state] || STATE.unknown;
  let body = '';
  if (c.state === 'disagree') {
    body = `<div class="q">Which is it?</div>
      <div class="cmp">
        <div class="side"><span class="who">${esc(sourceName(c.det))}</span>${metaBlock(c.det, c.ai, c.diff)}<button class="btn" data-use="det">Use this</button></div>
        <div class="side"><span class="who">${esc(sourceName(c.ai))}</span>${metaBlock(c.ai, c.det, c.diff)}<button class="btn" data-use="ai">Use this</button></div>
      </div>`;
  } else if (c.best) {
    const q = c.question ? `Is this <em>${esc(c.question)}</em>?` : 'Is this the paper below?';
    body = `<div class="q">${q}</div><div class="ti">${esc(c.best.title)}</div>`;
  } else {
    body = `<div class="q">What is this?</div><div class="ti">${esc(c.titleGuess || c.name)}</div>`;
  }
  const weak = c.detWeak ? `<div class="flag">${icon('warn')}A title search found “${esc(c.det.title)}”, too different to trust</div>` : '';
  const version = c.version ? `<div class="flag">${icon('warn')}Looks like another version of <a href="/paper/${encodeURIComponent(c.version.id)}" target="_blank" rel="noopener" style="text-decoration:underline">${esc(c.version.title)}</a></div>` : '';
  const src = c.state === 'agree' ? 'Crossref and Claude agree' : c.state === 'one' ? `From ${sourceName(c.best === c.ai ? c.ai : c.det)}` : '';
  const aiBtn = c.aiPending ? `<span class="btn quiet"><span class="spin"></span>Reading</span>`
    : !c.ai ? `<button class="btn quiet" data-read>${icon('sparkle')}Read it</button>` : '';
  const err = c.aiError ? `<div class="flag">${icon('warn')}${esc(c.aiError)}</div>` : '';
  return `<div class="icard" data-path="${esc(c.path)}">
    <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start"><div style="min-width:0">${body}</div>
    <span class="badge ${st[0]}" data-tip="${esc(st[2])}">${st[1]}</span></div>
    ${src ? `<div class="fi" style="margin-top:6px"><span>${esc(src)}</span></div>` : ''}
    ${weak}${version}${err}
    ${fileLine(c)}
    ${open.has(c.path) ? fixForm(c) : `<div class="bar">
      ${c.best && c.state !== 'disagree' ? `<button class="btn primary" data-yes>${icon('check')}Confirm &amp; add</button>` : ''}
      <button class="btn" data-fixopen>${icon('edit')}${c.best ? 'Fix' : 'Identify'}</button>
      <button class="btn quiet" data-notpaper>Not a paper</button>
      ${aiBtn}
    </div>`}
    ${topicChips(c)}
  </div>`;
}

function miniHTML(c) {
  const why = c.ai && c.ai.kind === 'not a paper' ? 'Claude: not a paper' : c.reasons.join(', ');
  if (c.decided) return `<div class="mini" data-path="${esc(c.path)}"><span class="nm">${icon('check')} ${esc(c.name)}</span><button class="btn quiet" data-undo>Undo</button></div>`;
  return `<div class="mini" data-path="${esc(c.path)}"><span class="nm" data-tip="${esc(c.dir)} / ${esc(c.name)}">${esc(c.name)}</span>
    <span style="display:flex;gap:6px;align-items:center"><span class="why">${esc(why)}</span>
    <button class="btn quiet" data-notpaper data-tip="Record it as not a paper">${icon('check')}</button>
    ${c.aiPending ? '<span class="spin"></span>' : c.ai ? '' : `<button class="btn quiet" data-read data-tip="Ask Claude to read the first pages">${icon('sparkle')}</button>`}</span></div>`;
}

function relationLabel(r) {
  if (!r) return '';
  const link = r.paper ? `<a href="/paper/${encodeURIComponent(r.paper.id)}" target="_blank" rel="noopener">${esc(r.paper.title)}</a>` : `<span class="of">${esc(r.of || '')}</span>`;
  if (r.kind === 'deck') return r.mine ? `Your deck ${r.paper ? 'of' : 'about'} ${link}` : `Slides about ${link}`;
  if (r.kind === 'review') return `Your review of ${link}`;
  if (r.kind === 'supplement') return `Supplement of ${link}`;
  return `Another version of ${link}`;
}

function relHTML(c) {
  const done = c.decided ? `${icon('check')} ` : '';
  return `<div class="mini rel" data-path="${esc(c.path)}"><span class="nm">${done}${relationLabel(c.relation)}<span class="file" data-tip="${esc(c.dir)} / ${esc(c.name)}">${esc(c.name)}</span></span>
    <span style="display:flex;gap:4px;align-items:center"><button class="btn quiet" data-open="${esc(c.path)}">open</button>
    ${c.decided ? '<button class="btn quiet" data-undo>Undo</button>' : '<button class="btn quiet" data-known data-tip="Record that you have seen it">Noted</button>'}</span></div>`;
}

function render() {
  const cards = V.cards;
  const by = (g) => cards.filter((c) => c.group === g);
  const live = by('identify'), done = by('answered'), yours = by('yours'), related = by('related'), notp = by('not-paper');
  $sub.textContent = V.scan.scanning
    ? `Scanning ${V.scan.phase === 'identify' ? 'identifiers' : 'files'} ${V.scan.done} of ${V.scan.total}`
    : `${live.length} to identify · ${related.length} versions, supplements and slides · ${yours.length} your decks and reviews · ${notp.length} probably not papers`;
  $bar.classList.toggle('hidden', !V.scan.scanning);
  $bar.firstElementChild.style.width = V.scan.total ? `${(100 * V.scan.done) / V.scan.total}%` : '0%';
  $scan.disabled = V.scan.scanning;
  const openGroups = new Set([...document.querySelectorAll('details.group[open]')].map((d) => d.dataset.g));
  const group = (g, label, items, html) => items.length
    ? `<details class="group" data-g="${g}" ${openGroups.has(g) ? 'open' : ''}><summary>${icon('chev', 'chev')}<span class="section-label">${label} · ${items.length}</span></summary>${items.map(html).join('')}</details>` : '';
  $out.innerHTML = `
    ${live.length ? live.map(cardHTML).join('') : '<div class="noresult">No files waiting. Process inbox to check your folders.</div>'}
    ${done.length ? `<div class="group-head"><span class="section-label">Answered</span></div>${done.map(cardHTML).join('')}` : ''}
    ${group('related', 'Versions, supplements and slides', related, relHTML)}
    ${group('yours', 'Your decks and reviews', yours, relHTML)}
    ${group('not-paper', 'Probably not papers', notp, miniHTML)}`;
  const pending = V.scan.scanning || cards.some((c) => c.aiPending);
  clearTimeout(poll);
  if (pending) poll = setTimeout(load, 2000);
}

async function load() {
  try {
    V = await api('/api/inbox');
    document.getElementById('inboxDir').textContent = V.inboxDir || '~/Papers/Inbox';
    if (!topics.length) topics = V.topics || [];
    render();
  } catch (e) { $sub.textContent = e.message; }
}

function cardOf(el) {
  const host = el.closest('[data-path]');
  return host ? V.cards.find((c) => c.path === host.dataset.path) : null;
}

function replace(c) {
  const i = V.cards.findIndex((x) => x.path === c.path);
  if (i >= 0) V.cards[i] = c;
  render();
}

async function decide(c, decision, meta, source) {
  if (c.saving) return;
  c.saving = true;
  const host = document.querySelector(`[data-path="${CSS.escape(c.path)}"]`);
  host?.querySelectorAll('button').forEach((button) => { button.disabled = true; });
  try {
    const r = await api('/api/inbox/decide', { path: c.path, decision, meta, source, topics: [...(picked.get(c.path) || [])] });
    open.delete(c.path);
    if (r.filed) {
      const name = r.filed.file ? r.filed.file.split('/').pop() : r.filed.title;
      toast(r.filed.duplicate ? `Already in your library${r.filed.removed ? '; the extra copy was removed' : ''}: ${r.filed.title}` : `Filed as “${name}”${r.filed.removed ? '' : ' (the original could not be removed)'}`);
      await load();
    }
    else { replace(r); if (decision !== 'undo') toast('Recorded'); }
  } catch (e) { toast(e.message); }
  finally { c.saving = false; host?.querySelectorAll('button').forEach((button) => { button.disabled = false; }); }
}

$out.addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  const c = cardOf(t);
  if (!c) return;
  if (t.dataset.open) {
    workspace.classList.add('has-preview');
    preview.open(`/api/pdf?path=${encodeURIComponent(c.path)}`, c.name);
    if (window.innerWidth < 1100) preview.host.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (t.hasAttribute('data-yes')) return decide(c, 'yes', c.best, c.state === 'agree' ? 'both' : (c.best === c.ai ? 'ai' : 'det'));
  if (t.hasAttribute('data-file-confirmed')) return decide(c, c.decided.decision, c.decided.meta || c.best, c.decided.source || 'manual');
  if (t.dataset.use) return decide(c, 'yes', t.dataset.use === 'ai' ? c.ai : c.det, t.dataset.use);
  if (t.hasAttribute('data-notpaper')) return decide(c, 'not-paper');
  if (t.hasAttribute('data-known')) return decide(c, 'known');
  if (t.hasAttribute('data-undo')) return decide(c, 'undo');
  if (t.hasAttribute('data-fixopen')) { open.add(c.path); render(); document.querySelector(`[data-fix="${CSS.escape(c.path)}"] input`)?.focus(); return; }
  if (t.hasAttribute('data-cancel')) { open.delete(c.path); render(); return; }
  if (t.hasAttribute('data-read')) {
    c.aiPending = true; render();
    try { replace(await api('/api/inbox/read', { path: c.path })); } catch (err) { toast(err.message); load(); }
    return;
  }
  if (t.dataset.topic !== undefined) {
    const s = picked.get(c.path) || new Set();
    s.has(t.dataset.topic) ? s.delete(t.dataset.topic) : s.add(t.dataset.topic);
    picked.set(c.path, s);
    t.setAttribute('aria-pressed', String(s.has(t.dataset.topic)));
    t.closest('.topics-wrap').classList.toggle('has-picks', s.size > 0);
    return;
  }
  if (t.hasAttribute('data-newtopic')) {
    const input = document.createElement('input');
    input.className = 'chip small'; input.style.width = '140px'; input.placeholder = 'New topic';
    t.replaceWith(input); input.focus();
    const commit = () => {
      const v = input.value.trim();
      if (v) { extra.set(c.path, [...(extra.get(c.path) || []), v]); const s = picked.get(c.path) || new Set(); s.add(v); picked.set(c.path, s); }
      render();
    };
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') commit(); if (ev.key === 'Escape') render(); });
    input.addEventListener('blur', commit, { once: true });
  }
});

$out.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target.closest('form[data-fix]');
  if (!f) return;
  const c = V.cards.find((x) => x.path === f.dataset.fix);
  decide(c, 'fix', {
    title: f.title.value.trim(), authors: f.authors.value.split(',').map((s) => s.trim()).filter(Boolean),
    year: f.year.value.trim(), venue: f.venue.value.trim(), doi: f.doi.value.trim(),
  }, 'edit');
});

$scan.addEventListener('click', async () => {
  try { await api('/api/inbox/scan', {}); toast('Processing your PDF inbox'); load(); } catch (e) { toast(e.message); }
});
document.getElementById('openInbox').addEventListener('click', async () => {
  try { await api('/api/inbox/open-folder', {}); } catch (e) { toast(e.message); }
});
$next.addEventListener('click', async () => {
  try {
    const r = await api('/api/inbox/read-next', { n: 5 });
    toast(r.started.length ? `Reading ${r.started.length} with Claude` : 'Nothing left to read');
    load();
  } catch (e) { toast(e.message); }
});

void when;
load();
