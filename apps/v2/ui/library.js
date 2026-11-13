import { api, toast, icon, esc, snippetHTML, firstAuthor, when, enableTips, topbar, APP_LABEL } from '/ui/common.js';

document.getElementById('top').innerHTML = topbar('library');
document.getElementById('searchIcon').innerHTML = icon('search').replace(/^<span[^>]*>|<\/span>$/g, '');
document.getElementById('clear').innerHTML = icon('x');
enableTips();

const $q = document.getElementById('q');
const $out = document.getElementById('out');
const $lib = document.getElementById('lib');
const TYPES = [['all', 'All'], ['papers', 'Papers'], ['highlights', 'Highlights'], ['chats', 'Chats'], ['decks', 'Decks'], ['notes', 'Notes']];
const SORTS = [['relevance', 'Relevance'], ['recent', 'Recently touched'], ['year', 'Year']];
const params = new URLSearchParams(location.search);
let type = params.get('type') || 'all', sort = params.get('sort') || 'relevance', sel = -1, seq = 0, timer = null;

document.getElementById('types').innerHTML = TYPES.map(([k, l]) => `<button class="chip small" data-type="${k}" aria-pressed="${k === type}">${l}</button>`).join('');
document.getElementById('sort').innerHTML = SORTS.map(([k, l]) => `<button data-sort="${k}" aria-pressed="${k === sort}">${l}</button>`).join('');

const BADGES = [
  ['highlights', 'highlights', 'highlight', 'highlights'],
  ['claude-code', 'claude-code', 'Claude Code session', 'Claude Code sessions'],
  ['codex', 'codex', 'Codex session', 'Codex sessions'],
  ['science', 'science', 'Claude Science conversation', 'Claude Science conversations'],
  ['marlin', 'marlin', 'Marlin reader chat', 'Marlin reader chats'],
  ['web', 'web', 'linked web chat', 'linked web chats'],
  ['decks', 'decks', 'deck', 'decks'],
  ['notes', 'notes', 'note', 'notes'],
];

function badges(counts) {
  return BADGES.filter(([k]) => counts[k]).map(([k, ic, one, many]) =>
    `<span class="cnt" data-tip="${counts[k]} ${counts[k] === 1 ? one : many}">${icon(ic)}${counts[k]}</span>`).join('');
}

function confBadge(c) {
  if (c === 'matched') return '<span class="badge" data-tip="Metadata matched by search, not confirmed by an identifier">matched</span>';
  if (c === 'guessed') return '<span class="badge warn" data-tip="Metadata guessed from the PDF, unverified">unverified</span>';
  if (c === 'own') return '<span class="badge accent" data-tip="Your own draft">yours</span>';
  return '';
}

function matchHTML(m) {
  const ic = m.kind === 'chat' ? m.sub : m.kind === 'paper' ? 'paper' : m.kind;
  let src = '';
  if (m.kind === 'paper') src = m.sub === 'doi' ? 'DOI' : 'Paper record';
  else if (m.kind === 'highlight') src = `Highlight · p. ${m.page ?? '?'}`;
  else if (m.kind === 'chat') src = `${esc(m.appLabel || APP_LABEL[m.sub] || 'Chat')} · ${esc(m.title)}`;
  else if (m.kind === 'deck') src = `Deck · ${esc(m.title)}`;
  else if (m.kind === 'note') src = esc(m.title);
  const why = m.why ? `<span class="why" data-tip="Why this chat is linked">${esc(m.why)}</span>` : '';
  const snip = m.snippet ? snippetHTML(m.snippet) : '<span class="muted">Matched in the title</span>';
  return `<div class="match">${icon(ic)}<div><div class="src"><span>${src}</span>${why}</div><div class="snip">${snip}</div></div></div>`;
}

function cardHTML(p, i) {
  const meta = [firstAuthor(p.authors), p.year, p.venue].filter(Boolean).map(esc);

  const withHit = p.matches.filter((m) => /\uE000/.test(m.snippet || '') && !(p.titleSnippet && m.kind === 'paper'));
  let best = withHit[0] || null;
  if (!best && !p.titleSnippet) best = p.matches[0] || null;
  const rest = p.matches.filter((m) => m !== best && !(m.kind === 'paper' && !m.snippet && p.titleSnippet));
  return `<a class="card" href="/reader/${encodeURIComponent(p.id)}" data-i="${i}">
    <h3>${p.titleSnippet ? snippetHTML(p.titleSnippet) : esc(p.title)}</h3>
    <div class="meta">${meta.join('<span class="sep">·</span>')} ${confBadge(p.confidence)}</div>
    ${best ? `<div class="best">${matchHTML(best)}</div>` : ''}
    <div class="badges">${badges(p.counts)}${p.touched ? `<span class="cnt" data-tip="Last touched">${when(p.touched)}</span>` : ''}<button class="cnt reveal" data-reveal="${esc(p.id)}" data-tip="Show this paper’s PDF in Finder">${icon('folder')}Show in Finder</button>${rest.length ? `<span class="cnt more-hint">${rest.length} more match${rest.length === 1 ? '' : 'es'}</span>` : ''}</div>
    ${rest.length ? `<div class="matches"><div>${rest.map(matchHTML).join('')}</div></div>` : ''}
  </a>`;
}

function otherHTML(m) {
  const ic = m.kind === 'chat' ? m.sub : m.kind;
  const label = m.kind === 'chat' ? (m.appLabel || APP_LABEL[m.sub]) : m.kind === 'deck' ? 'Deck' : m.kind === 'note' ? (m.sub === 'review' ? 'Literature review' : 'Note') : '';
  const extra = m.linkedTo ? ` · mentions ${m.linkedTo} papers` : '';
  return `<div class="other">${icon(ic)}<div><div class="t">${m.kind === 'note' ? `<button class="writeup-link" data-note-source="${esc(m.ref)}">${esc(m.title || 'Write-up')} ↗</button>` : esc(m.title || '(untitled)')}</div><div class="snip"><span class="muted">${esc(label)}${extra}${m.date ? ` · ${when(m.date)}` : ''}</span>${m.snippet ? ` · ${snippetHTML(m.snippet)}` : ''}</div></div></div>`;
}

$out.addEventListener('click', async (event) => {
  const reveal = event.target.closest('[data-reveal]');
  if (reveal) {
    event.preventDefault(); event.stopPropagation();
    try { await api('/api/reveal', { paperId: reveal.dataset.reveal }); } catch (error) { toast(error.message); }
    return;
  }
  const button = event.target.closest('[data-note-source]');
  if (!button) return;
  button.disabled = true;
  try { await api('/api/knowledge/open-source', { noteId: button.dataset.noteSource }); }
  catch (error) { button.textContent = error.message; }
  finally { button.disabled = false; }
});

async function run() {
  const q = $q.value.trim();
  const url = new URL(location.href);
  q ? url.searchParams.set('q', q) : url.searchParams.delete('q');
  type !== 'all' ? url.searchParams.set('type', type) : url.searchParams.delete('type');
  sort !== 'relevance' ? url.searchParams.set('sort', sort) : url.searchParams.delete('sort');
  history.replaceState(null, '', url);
  $lib.classList.toggle('has-q', !!q);
  if (!q) { $out.innerHTML = ''; sel = -1; return; }
  const my = ++seq;
  const r = await api(`/api/search?q=${encodeURIComponent(q)}&type=${type}&sort=${sort}`);
  if (my !== seq) return;
  if (!r.ready) { $out.innerHTML = '<div class="noresult">Indexing, one moment</div>'; setTimeout(run, 800); return; }
  sel = -1;
  if (!r.papers.length && !r.standalone.length) { $out.innerHTML = `<div class="noresult">Nothing matches “${esc(q)}”</div>`; return; }
  $out.innerHTML = `
    ${r.papers.length ? `<div class="result-count">${r.total} paper${r.total === 1 ? '' : 's'}</div><div class="results">${r.papers.map(cardHTML).join('')}</div>` : ''}
    ${r.standalone.length ? `<div class="others"><h4 class="section-label">${r.papers.length ? 'Not tied to a paper' : 'Matches not tied to a paper'}</h4>${r.standalone.map(otherHTML).join('')}</div>` : ''}`;
}

function select(i) {
  const cards = [...$out.querySelectorAll('.card')];
  if (!cards.length) return;
  sel = Math.max(0, Math.min(cards.length - 1, i));
  cards.forEach((c, k) => c.classList.toggle('sel', k === sel));
  cards[sel].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

$q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 120); });
$q.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); select(sel + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); select(sel - 1); }
  else if (e.key === 'Enter') {
    const cards = $out.querySelectorAll('.card');
    const c = cards[sel >= 0 ? sel : 0];
    if (c) location.href = c.getAttribute('href');
  } else if (e.key === 'Escape') { $q.value = ''; run(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== $q) { e.preventDefault(); $q.focus(); $q.select(); }
  else if (e.key === 'Escape' && document.activeElement !== $q) { $q.value = ''; run(); $q.focus(); }
});
document.getElementById('clear').addEventListener('click', (e) => { e.preventDefault(); $q.value = ''; run(); $q.focus(); });
document.getElementById('types').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  type = b.dataset.type;
  document.querySelectorAll('#types button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  run();
});
document.getElementById('sort').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  sort = b.dataset.sort;
  document.querySelectorAll('#sort button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  run();
});

api('/api/stats').then((s) => {
  if (!s.ready) { document.getElementById('stats').textContent = 'Indexing…'; setTimeout(() => location.reload(), 1500); return; }
  document.getElementById('stats').textContent = `${s.papers} papers · ${s.highlights.toLocaleString('en-US')} highlights · ${s.decks} decks · ${s.conversations} conversations`;
}).catch(() => {});

if (params.get('q')) { $q.value = params.get('q'); run(); }
$q.focus();
