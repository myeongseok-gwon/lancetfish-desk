import { api, icon, esc, when, toast, enableTips, topbar, firstAuthor } from '/ui/common.js';
import { renderMarkdown, parseCSV } from '/ui/markdown.js';
import { PdfPreview } from '/ui/pdf-preview.js';

document.getElementById('top').innerHTML = topbar('science');
enableTips();
const $nav = document.getElementById('nav'), $main = document.getElementById('main');
let TREE = null, seq = 0, preview = null;

const convs = () => TREE.projects.flatMap((p) => p.conversations.map((c) => ({ ...c, project: p })));
const findConv = (id) => convs().find((c) => c.id === id);
const link = (q) => `/science${q ? `?${new URLSearchParams(q)}` : ''}`;
const nav = (q, html, cls = '', current = false) => `<a data-nav class="${cls}" href="${esc(link(q))}"${current ? ' aria-current="true"' : ''}>${html}</a>`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const size = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);
const sep = '<span class="sep">·</span>';
const fileIcon = (a) => (/markdown/.test(a.type) || /\.md$/i.test(a.filename) ? 'notes' : /csv/.test(a.type) ? 'table' : /^image\//.test(a.type) ? 'image' : /pdf/.test(a.type) ? 'pdf' : 'paper');
const rank = (a) => (/\.(md|markdown)$/i.test(a.filename) ? 0 : /\.csv$/i.test(a.filename) ? 1 : 2);
const results = (c) => c.artifacts.filter((a) => a.kind === 'result').sort((x, y) => rank(x) - rank(y));
const working = (c) => c.artifacts.filter((a) => a.kind !== 'result');
const fileUrl = (a, download) => `/api/science/file?id=${encodeURIComponent(a.id)}${download ? '&download=1' : ''}`;

const pick = (map, key) => (Object.hasOwn(map, key) ? map[key] : null);
function paperByDoi(raw) {
  const L = TREE.library;
  const d = String(raw || '').trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').replace(/^doi:\s*/, '').replace(/[.,;:)\]}>'"]+$/, '');
  if (!d) return null;
  let m;
  return pick(L.doi, d) || ((m = /^10\.48550\/arxiv\.(\d{4}\.\d{4,5})/.exec(d)) && pick(L.arxiv, m[1]))
    || ((m = /^10\.2139\/ssrn\.(\d+)/.exec(d)) && pick(L.ssrn, m[1])) || null;
}

function paperByHref(href) {
  let m;
  if ((m = /^https?:\/\/(?:dx\.)?doi\.org\/(.+)$/i.exec(href))) { try { return paperByDoi(decodeURIComponent(m[1])); } catch { return paperByDoi(m[1]); } }
  if ((m = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i.exec(href))) return pick(TREE.library.arxiv, m[1]);
  if ((m = /ssrn\.com\/.*abstract(?:_id)?=(\d+)/i.exec(href))) return pick(TREE.library.ssrn, m[1]);
  return null;
}

function paperByFilename(name) {
  if (!/^10\.\d{4,9}_/.test(name)) return null;
  const stem = name.replace(/\.pdf$/i, '').toLowerCase();
  return paperByDoi(stem.replace('_', '/')) || pick(TREE.library.loose, stem.replace(/[^a-z0-9]/g, '')) || null;
}

function paperTip(id) {
  const p = TREE.library.info[id];
  if (!p) return 'In your library';
  return `In your library: ${p.title} (${[firstAuthor(p.authors), p.year].filter(Boolean).join(' ')})`;
}
const libLink = (id, inner) => `<a class="in-lib" href="/paper/${encodeURIComponent(id)}" data-tip="${esc(paperTip(id))}">${inner}</a>`;

function mdOpts(cited) {
  const version = (target) => (/^\{\{artifact:([0-9a-f-]{36})\}{1,2}$/.exec(target) || [])[1];
  return {
    link(href, inner) {
      const v = version(href);
      if (v) return `<a href="/api/science/file?version=${v}" target="_blank" rel="noopener">${inner}</a>`;
      const isId = /^https?:\/\/((dx\.)?doi\.org|arxiv\.org|(papers\.)?ssrn\.com)\//i.test(href);
      if (!isId) return null;
      const id = paperByHref(href);
      if (cited) { const key = href.toLowerCase(); if (!cited.has(key)) cited.set(key, { id, label: inner.replace(/<[^>]+>/g, '') }); }
      return id ? libLink(id, inner) : null;
    },
    image(src, alt) {
      const v = version(src);
      return v ? `<figure><img src="/api/science/file?version=${v}" alt="${esc(alt)}" loading="lazy">${alt ? `<figcaption>${esc(alt)}</figcaption>` : ''}</figure>` : null;
    },
  };
}

function renderNav(sel) {
  const total = convs().length;
  $nav.innerHTML = `${nav(null, `${icon('science')}All projects`, 'home', !sel.p && !sel.c)}
    ${TREE.projects.map((p) => `<details class="sci-proj" ${!p.example || sel.p === p.id || p.conversations.some((c) => c.id === sel.c) ? 'open' : ''}>
      <summary>${icon('chev')}${nav({ p: p.id }, esc(p.name), '', sel.p === p.id)}<span class="n">${p.conversations.length}</span></summary>
      ${p.conversations.map((c) => nav({ c: c.id }, `<div class="t">${esc(c.title)}</div><div class="s">${[when(c.updated), results(c).length ? plural(results(c).length, 'file') : '', c.status !== 'completed' ? esc(c.status) : ''].filter(Boolean).join(' · ')}</div>`, 'sci-conv', sel.c === c.id)).join('')}
    </details>`).join('')}
    <p class="sci-foot">${plural(total, 'conversation')} read from a copy of the Claude Science database${TREE.copiedAt ? `, taken ${esc(when(TREE.copiedAt))}` : ''}. Nothing here changes Claude Science.</p>`;
  $nav.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
}

const fileChip = (c, a) => nav({ c: c.id, a: a.id }, `${icon(fileIcon(a))}<span>${esc(a.filename.replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' '))}</span>`, 'chip small');

function cardHTML(c) {
  const r = results(c);
  return `<div class="sci-card">
    ${nav({ c: c.id }, `<h3>${esc(c.title)}</h3>`)}
    ${c.request ? `<div class="req">${esc(c.request)}</div>` : ''}
    ${r.length ? `<div class="files">${r.slice(0, 4).map((a) => fileChip(c, a)).join('')}${r.length > 4 ? `<span class="badge">+${r.length - 4}</span>` : ''}</div>` : ''}
    <div class="foot">${[when(c.updated), c.status !== 'completed' ? esc(c.status) : '', working(c).length ? plural(working(c).length, 'working file') : ''].filter(Boolean).join(' · ')}</div>
  </div>`;
}

function renderHome() {
  document.title = 'Science · Lancetfish';
  const all = convs(), files = all.reduce((n, c) => n + c.artifacts.length, 0);
  const mems = TREE.projects.reduce((n, p) => n + p.memories.length, 0);
  $main.innerHTML = `<header class="sci-head"><h1>Science</h1>
    <p class="lede">Everything Claude Science keeps on this Mac: ${plural(TREE.projects.length, 'project')}, ${plural(all.length, 'conversation')}, ${plural(files, 'file')} and ${plural(mems, 'memory', 'memories')}. A citation of a paper in your library leads to the library paper.</p></header>
    ${TREE.projects.map((p) => `<section class="sci-sec"><h2>${nav({ p: p.id }, esc(p.name))}<span class="n">${p.conversations.length}</span></h2>
      ${p.description || p.context ? `<p class="sub">${esc([p.description, p.context].filter(Boolean).join(' '))}</p>` : ''}
      <div class="sci-cards">${p.conversations.map(cardHTML).join('') || '<div class="empty-sec">No conversations yet</div>'}</div></section>`).join('')}`;
}

function fileRow(c, a) {
  const paper = /pdf/.test(a.type) ? paperByFilename(a.filename) : null;
  return `<div class="sci-file">${icon(fileIcon(a))}${c ? nav({ c: c.id, a: a.id }, esc(a.filename), 'name') : `<a class="name" href="${esc(fileUrl(a))}" target="_blank" rel="noopener">${esc(a.filename)}</a>`}
    <span class="s">${paper ? libLink(paper, 'in your library') : ''}<span>${size(a.size)}</span><span>${when(a.updated)}</span></span></div>`;
}

function renderProject(p) {
  document.title = `${p.name} · Science`;
  const title = (id) => findConv(id)?.title;
  $main.innerHTML = `<header class="sci-head"><div class="crumb">${nav(null, 'Science')}</div><h1>${esc(p.name)}</h1>
    <div class="meta">${[plural(p.conversations.length, 'conversation'), `updated ${when(p.updated)}`, p.archived ? 'archived' : ''].filter(Boolean).join(sep)}</div>
    ${p.description ? `<p class="lede">${esc(p.description)}</p>` : ''}${p.context ? `<p class="lede">${esc(p.context)}</p>` : ''}</header>
    <section class="sci-sec"><h2>Conversations<span class="n">${p.conversations.length}</span></h2>
      <div class="sci-cards">${p.conversations.map(cardHTML).join('') || '<div class="empty-sec">None yet</div>'}</div></section>
    ${p.memories.length ? `<section class="sci-sec"><h2>What Claude Science remembers<span class="n">${p.memories.length}</span></h2>
      <p class="sub">Notes the app keeps about this project and recalls in later conversations.</p>
      ${p.memories.map((m) => `<div class="sci-mem"><p>${esc(m.body)}</p><span class="badge" data-tip="${m.evidence === 'stated' ? 'You said this' : m.evidence === 'observed' ? 'Seen in the work itself' : 'Inferred by the app'}">${esc(m.evidence)}</span>
        <div class="s">${[when(m.updated), m.conversationId && title(m.conversationId) ? `from ${nav({ c: m.conversationId }, esc(title(m.conversationId)))}` : ''].filter(Boolean).join(' · ')}</div></div>`).join('')}</section>` : ''}
    ${p.uploads.length ? `<section class="sci-sec"><h2>Uploads<span class="n">${p.uploads.length}</span></h2>${p.uploads.map((a) => fileRow(null, a)).join('')}</section>` : ''}`;
}

function convHead(c, sel) {
  const r = results(c), w = working(c);
  const tab = (q, ic, label, n, on) => nav({ c: c.id, ...q }, `${icon(ic)}<span class="l">${esc(label)}</span>${n != null ? `<span class="n">${n}</span>` : ''}`, '', on);
  const other = sel.a && !r.some((a) => a.id === sel.a);
  return `<header class="sci-head"><div class="crumb">${nav(null, 'Science')}<span>›</span>${nav({ p: c.project.id }, esc(c.project.name))}</div>
    <h1>${esc(c.title)}</h1>
    <div class="meta">${[when(c.updated), c.model ? esc(c.model) : '', c.status !== 'completed' ? esc(c.status) : '', c.prompts ? plural(c.prompts, 'prompt') : '',
      c.cost ? `<span data-tip="${Math.round(c.tokensIn).toLocaleString('en-US')} tokens in, ${Math.round(c.tokensOut).toLocaleString('en-US')} out, at API list prices. Claude Science records this figure; it is not a charge.">$${c.cost.toFixed(2)} of tokens</span>` : ''].filter(Boolean).join(sep)}
      <button class="btn quiet" id="openApp" style="height:26px;padding:0 8px;font-size:12.5px">${icon('ext')}Open Claude Science</button></div></header>
    <div class="sci-tabs" role="tablist">${r.map((a) => tab({ a: a.id }, fileIcon(a), a.filename, null, sel.a === a.id)).join('')}
      ${tab({ view: 'chat' }, 'chat', 'Conversation', null, sel.view === 'chat')}
      ${w.length ? tab({ view: 'files' }, 'folder', 'Working files', w.length, sel.view === 'files' || other) : ''}</div>`;
}

function libraryStrip(cited) {
  const all = [...cited.values()], hits = new Map();
  for (const c of all) if (c.id && !hits.has(c.id)) hits.set(c.id, c.label);
  if (!all.length) return '';
  if (!hits.size) return `<details class="sci-lib none"><summary>${icon('library')}<span><b>${all.length}</b> papers cited, none of them in your library yet.</span></summary></details>`;
  return `<details class="sci-lib"><summary>${icon('library')}<span><b>${hits.size}</b> of ${all.length} cited papers are in your library. Their citations are marked and lead to the library paper.</span>
    <span class="tog"><span class="a">Show them</span><span class="b">Hide</span></span></summary>
    <ul>${[...hits].map(([id, label]) => { const p = TREE.library.info[id] || {}; return `<li><a href="/paper/${encodeURIComponent(id)}">${esc(p.title || id)}</a><span>${label}</span></li>`; }).join('')}</ul></details>`;
}

function versionBar(d, a) {
  const pick = d.versions.length > 1 ? `<label>Version <select id="ver">${d.versions.map((v) => `<option value="${esc(v.id)}" ${v.id === d.artifact.versionId ? 'selected' : ''}>${v.version}${v.id === d.versions[0].id ? ' (latest)' : ''} · ${esc(when(v.created))}</option>`).join('')}</select></label>` : '';
  return `<div class="sci-bar">${pick}<span>${size(d.artifact.size)}</span><span>saved ${esc(when(d.artifact.created))}</span><span class="sp"></span>
    <a class="btn quiet" style="height:28px;font-size:12.5px" href="${esc(`/api/science/file?version=${d.artifact.versionId}&download=1`)}">Download</a></div>`;
}

function tableHTML(text) {
  const rows = parseCSV(text);
  if (!rows.length) return '<p class="sci-empty">This table is empty.</p>';
  const head = rows[0], body = rows.slice(1, 2001);
  const doiCol = head.findIndex((h) => /^doi$/i.test(h.trim())), citeCol = head.findIndex((h) => /^(citation|cite|reference|study|paper)$/i.test(h.trim()));
  const wide = head.map((_, i) => body.some((r) => (r[i] || '').length > 90));
  const bare = (v) => String(v || '').trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
  const idLink = (cell, inner) => {
    const doi = bare(cell);
    if (!/^10\.\d{4,9}\//.test(doi)) return inner;
    const id = paperByDoi(doi);
    return id ? libLink(id, inner) : `<a href="https://doi.org/${esc(encodeURI(doi))}" target="_blank" rel="noopener">${inner}</a>`;
  };
  let inLib = 0;
  const html = body.map((r) => {
    const doi = doiCol >= 0 ? r[doiCol] || '' : '';
    if (/^10\.\d{4,9}\//.test(bare(doi)) && paperByDoi(doi)) inLib++;
    return `<tr>${head.map((_, i) => {
      const v = r[i] ?? '';
      if (i === doiCol) return `<td class="cite">${idLink(v, esc(v))}</td>`;
      if (i === citeCol && doi) return `<td class="cite">${idLink(doi, esc(v))}</td>`;
      return `<td${wide[i] ? ' class="wide"' : ''}>${/^https?:\/\/\S+$/.test(v) ? `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v)}</a>` : esc(v)}</td>`;
    }).join('')}</tr>`;
  }).join('');
  const note = [plural(rows.length - 1, 'row'), doiCol >= 0 ? `${inLib} in your library` : '', rows.length - 1 > body.length ? `first ${body.length} shown` : ''].filter(Boolean).join(' · ');
  return `<div class="sci-table"><table><thead><tr>${head.map((h) => `<th>${esc(h.replace(/_/g, ' '))}</th>`).join('')}</tr></thead><tbody>${html}</tbody></table><div class="tnote">${note}</div></div>`;
}

async function renderArtifact(c, sel, mine) {
  const a = c.artifacts.find((x) => x.id === sel.a);
  const head = convHead(c, sel);
  if (!a) { $main.innerHTML = `${head}<p class="sci-empty">That file is no longer in Claude Science.</p>`; return; }
  $main.innerHTML = `${head}<p class="sci-empty">Opening ${esc(a.filename)}…</p>`;
  const d = await api(`/api/science/artifact?${sel.v ? `version=${encodeURIComponent(sel.v)}` : `id=${encodeURIComponent(a.id)}`}`);
  if (mine !== seq) return;
  document.title = `${a.filename} · Science`;
  const bar = versionBar(d, a);
  const isMd = /markdown/.test(d.artifact.type) || /\.(md|markdown)$/i.test(a.filename);
  const back = a.kind !== 'result' ? `<div class="sci-bar">${nav({ c: c.id, view: 'files' }, '‹ Working files')}<span>${esc(a.filename)}</span></div>` : '';
  let body;
  if (!d.artifact.onDisk) body = '<p class="sci-empty">Claude Science lists this file, but it is not on disk.</p>';
  else if (d.text != null && isMd) {
    const cited = new Map();
    const { html, headings } = renderMarkdown(d.text, mdOpts(cited));
    const outline = headings.filter((h) => h.level === 2 || h.level === 3);
    body = `<div class="sci-doc ${outline.length > 2 ? '' : 'solo'}"><div>${libraryStrip(cited)}<article class="prose" id="doc">${html}</article></div>
      ${outline.length > 2 ? `<aside class="sci-outline" id="outline"><div class="section-label">Contents</div>${outline.map((h) => `<a class="l${h.level}" href="#${esc(h.id)}">${esc(h.text)}</a>`).join('')}</aside>` : ''}</div>`;
  } else if (d.text != null && (/csv/.test(d.artifact.type) || /\.csv$/i.test(a.filename))) body = tableHTML(d.text);
  else if (d.text != null) body = `<pre class="sci-pre">${esc(d.text)}</pre>${d.truncated ? '<p class="sci-empty">Only the first 2 MB is shown. Download the file for the rest.</p>' : ''}`;
  else if (/^image\//.test(d.artifact.type)) body = `<div class="sci-figure"><img src="/api/science/file?version=${esc(d.artifact.versionId)}" alt="${esc(a.filename)}"></div>`;
  else if (/pdf/.test(d.artifact.type)) {
    const paper = paperByFilename(a.filename);
    body = `${paper ? `<div class="sci-bar">${icon('library')}<span>This paper is in your library:</span><a class="in-lib" style="color:var(--accent-ink)" href="/paper/${encodeURIComponent(paper)}">${esc(TREE.library.info[paper]?.title || paper)}</a></div>` : ''}
      <div class="pdf-preview sci-pdf" id="pdf"></div>`;
  } else body = '<p class="sci-empty">This kind of file is not shown here. Download it to open it.</p>';
  $main.innerHTML = head + back + bar + body;
  document.getElementById('ver')?.addEventListener('change', (e) => go({ c: c.id, a: a.id, ...(e.target.value === d.versions[0].id ? {} : { v: e.target.value }) }));
  const pdf = document.getElementById('pdf');
  if (pdf) { preview = new PdfPreview(pdf, () => go({ c: c.id, view: 'files' })); preview.open(`/api/science/file?version=${d.artifact.versionId}`, a.filename); }
  spyOutline();
  toHash();
}

function spyOutline() {
  const outline = document.getElementById('outline');
  if (!outline) return;
  const links = [...outline.querySelectorAll('a')];
  const heads = links.map((l) => document.getElementById(decodeURIComponent(l.getAttribute('href').slice(1))));
  const update = () => {
    if (!outline.isConnected) { window.removeEventListener('scroll', update); return; }
    let on = 0;
    heads.forEach((h, i) => { if (h && h.getBoundingClientRect().top < 120) on = i; });
    links.forEach((l, i) => l.classList.toggle('on', i === on));
  };
  window.addEventListener('scroll', update, { passive: true });
  update();
}

function stepHTML(s) {
  const paper = s.doi ? paperByDoi(s.doi) : null;
  return `<div class="sci-step"><span class="k">${esc(s.kind)}</span><span class="d">${esc(s.label)}${paper ? ` ${libLink(paper, 'in your library')}` : ''}</span></div>`;
}

async function renderChat(c, sel, mine) {
  const head = convHead(c, sel);
  $main.innerHTML = `${head}<p class="sci-empty">Reading the conversation…</p>`;
  const d = await api(`/api/science/conversation?id=${encodeURIComponent(c.id)}`);
  if (mine !== seq) return;
  document.title = `${c.title} · Science`;
  const opts = mdOpts(null);
  const turns = d.turns.map((t) => {
    if (t.role === 'user') return `<div class="sci-turn user">${esc(t.text)}${t.at ? `<span class="at">${esc(when(t.at))}</span>` : ''}</div>`;
    if (t.role === 'steps') return `<details class="sci-steps"><summary>${icon('chev')}${plural(t.items.length, 'step')}: ${esc(t.items[t.items.length - 1].label)}</summary>${t.items.map(stepHTML).join('')}</details>`;
    return `<div class="sci-turn prose">${renderMarkdown(t.text, opts).html}</div>`;
  }).join('');
  $main.innerHTML = `${head}<div class="sci-chat">${turns || '<p class="sci-empty">Claude Science kept no messages for this conversation.</p>'}</div>`;
}

function renderFiles(c, sel) {
  document.title = `${c.title} · Science`;
  const w = working(c);
  $main.innerHTML = `${convHead(c, sel)}<section class="sci-sec"><p class="sub">Search results, fetched full texts and notes the agent kept while working. ${plural(w.length, 'file')}.</p>${w.map((a) => fileRow(c, a)).join('')}</section>`;
}

function current() {
  const q = new URLSearchParams(location.search);
  return { p: q.get('p') || '', c: q.get('c') || '', a: q.get('a') || '', v: q.get('v') || '', view: q.get('view') || '' };
}

function toHash() {
  if (!location.hash) return;
  let id; try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
  document.getElementById(id)?.scrollIntoView();
}

let shown = '';
async function render() {
  const mine = ++seq, sel = current();
  shown = location.pathname + location.search;
  if (preview) { preview.resize.disconnect(); preview.generation++; preview.loading?.destroy().catch(() => {}); preview = null; }
  const c = sel.c ? findConv(sel.c) : null;

  if (c && !sel.a && !sel.view) { const first = results(c).find((a) => /\.(md|markdown)$/i.test(a.filename)) || results(c)[0]; if (first) sel.a = first.id; else sel.view = 'chat';

    history.replaceState(null, '', link(sel.a ? { c: sel.c, a: sel.a } : { c: sel.c, view: sel.view }) + location.hash);
    shown = location.pathname + location.search; }
  renderNav(sel);
  try {
    if (sel.c && !c) $main.innerHTML = `<p class="sci-empty">That conversation is not in Claude Science any more. ${nav(null, 'See all projects', 'writeup-link')}</p>`;
    else if (c && sel.a) await renderArtifact(c, sel, mine);
    else if (c && sel.view === 'files') renderFiles(c, sel);
    else if (c) await renderChat(c, sel, mine);
    else if (sel.p && TREE.projects.some((p) => p.id === sel.p)) renderProject(TREE.projects.find((p) => p.id === sel.p));
    else renderHome();
  } catch (e) { if (mine === seq) $main.innerHTML = `<p class="sci-empty">${esc(e.message)}</p>`; }
}

function go(q) { history.pushState(null, '', link(q)); window.scrollTo(0, 0); render(); }

document.addEventListener('click', async (e) => {
  if (e.target.closest('#openApp')) { try { await api('/api/open-app', { app: 'science' }); toast('Opening Claude Science'); } catch (err) { toast(err.message); } return; }
  const a = e.target.closest('a[data-nav]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
  e.preventDefault();
  history.pushState(null, '', a.getAttribute('href')); window.scrollTo(0, 0); render();
});

window.addEventListener('popstate', () => { if (location.pathname + location.search === shown) toHash(); else render(); });

try {
  TREE = await api('/api/science');
  if (!TREE.enabled) $main.innerHTML = '<p class="sci-empty">Claude Science is turned off. Turn it on in <a class="writeup-link" href="/settings">Settings</a> to see its projects here.</p>';
  else if (!TREE.available) $main.innerHTML = '<p class="sci-empty">No Claude Science database was found on this Mac. If the app keeps it somewhere else, choose the file in <a class="writeup-link" href="/settings">Settings</a>.</p>';
  else render();
} catch (e) { $main.innerHTML = `<p class="sci-empty">${esc(e.message)}</p>`; }
