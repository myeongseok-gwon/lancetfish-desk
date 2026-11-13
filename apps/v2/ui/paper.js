import { api, icon, esc, when, toast, copyText, enableTips, topbar, APP_LABEL, CLIENT } from '/ui/common.js';
import { PdfPreview } from '/ui/pdf-preview.js';

document.getElementById('top').innerHTML = topbar('paper');
enableTips();

const root = document.getElementById('paper');
const id = decodeURIComponent(location.pathname.split('/').pop());
const readerLink = (id) => `/reader/${encodeURIComponent(id)}`;
const deckLink = (id) => `/slides/${encodeURIComponent(id)}`;
let D = null;
let preview = null;

const CONF = {
  confirmed: ['ok', 'confirmed', 'Metadata confirmed by its identifier'],
  matched: ['', 'matched', 'Metadata matched by search: a hypothesis, not confirmed by an identifier'],
  guessed: ['warn', 'unverified', 'Metadata guessed from the PDF: unverified'],
  own: ['accent', 'your draft', 'Your own writing'],
  manual: ['ok', 'confirmed by you', 'Paper details confirmed by you during inbox intake'],
};

function section(key, title, n, items, render, limit, extra = '') {
  const shown = items.slice(0, limit);
  const more = items.length > limit ? `<button class="more" data-more="${key}">Show all ${items.length}</button>` : '';
  return `<section class="psec" id="sec-${key}">
    <header><h2>${title}${n != null ? ` <span class="n">${n}</span>` : ''}</h2>${more}</header>
    <div class="list">${items.length ? shown.map(render).join('') : extra || '<div class="empty-sec">None yet</div>'}</div>
  </section>`;
}

function previewHighlights(all) {
  const ranked = [...all].map((h, i) => ({ h, i })).sort((a, b) => (!!b.h.note - !!a.h.note) || (b.h.text.length - a.h.text.length));
  const pick = new Set(ranked.slice(0, 5).map((x) => x.i));
  return [...all.filter((_, i) => pick.has(i)), ...all.filter((_, i) => !pick.has(i))];
}

const hlHTML = (h) => `<div class="hl"><span class="bar ${esc(h.color)}"></span><div><q>${esc(h.text || '')}</q>${h.note ? `<div class="note">${esc(h.note)}</div>` : ''}</div><span class="pg">p. ${esc(h.page)}</span></div>`;

function convHTML(c) {
  const label = APP_LABEL[c.app] || c.app;
  const meta = [label, c.project, when(c.updated)].filter(Boolean).map(esc).join(' · ');
  let act = '';
  if (c.app === 'claude-code' && c.resume) act = `<button class="copy-cmd" data-copy="${esc(c.resume)}" data-tip="Copy the resume command">${icon('copy')}claude --resume</button>`;
  else if (c.app === 'codex' && c.resume) act = `<button class="copy-cmd" data-copy="${esc(c.resume)}" data-tip="Copy the resume command">${icon('copy')}codex resume</button>`;
  else if (c.app === 'science') act = `<a class="btn quiet" href="/science?c=${encodeURIComponent(c.id)}">${icon('science')}Read in Science</a><button class="btn quiet" data-app="science">${icon('ext')}Open Claude Science</button>`;
  else if (c.url) act = `<a class="btn quiet" href="${esc(c.url)}" target="_blank" rel="noopener">${icon('ext')}Open</a>`;
  const others = c.otherPapers ? ` · also mentions ${c.otherPapers} other paper${c.otherPapers === 1 ? '' : 's'}` : '';
  if (c.manual) act += ` <button class="btn quiet" data-unlink="${esc(c.url)}" aria-label="Remove saved conversation link">Remove link</button>`;
  return `<div class="conv">${icon(c.app)}<div class="t">${esc(c.title)}</div><div class="act">${act}</div>
    <div class="s"><span>${meta}${others}</span>${c.why ? `<span class="why" data-tip="${esc(c.manual ? 'Linked by you. The saved title and note are searchable; the URL does not fetch the conversation.' : `Linked because the ${c.whyFrom === 'prompt' ? 'prompt' : c.whyFrom === 'reply' ? 'reply' : c.whyFrom === 'tool' ? 'assistant’s tool call' : 'conversation'} carries this paper’s ${c.why}`)}">why linked</span>` : ''}</div>${c.note ? `<div class="chat-note">${esc(c.note)}</div>` : ''}</div>`;
}

const deckHTML = (d) => `<div class="row"><span>${icon('deck')} ${esc(d.title)}</span><span class="s">${d.slides} slides · ${when(d.updated)} · <a href="${deckLink(d.id)}" target="_blank" rel="noopener" style="color:var(--accent-ink)">open editor</a></span></div>`;

function noteHTML(n) {
  return `<div class="note-card">
    <div class="nt"><span>${icon(n.kind === 'review' ? 'notes' : 'note')} ${esc(n.kind === 'review' ? `Cited in: ${n.title}` : n.label)}</span><span class="s muted" style="font-size:12.5px">${n.status ? `${esc(n.status)} · ` : ''}${when(n.updated)}</span></div>
    <button class="btn quiet" data-source-note="${esc(n.sourcePath)}">Open in Obsidian ↗</button>
  </div>`;
}

function render() {
  if (preview) { preview.close(); preview.resize.disconnect(); preview = null; }
  const p = D.paper;
  document.title = p.title;
  const conf = CONF[p.confidence];
  const authors = p.authors.join(', ');
  const doi = p.doi ? `<a href="https://doi.org/${esc(p.doi)}" target="_blank" rel="noopener">${esc(p.doi)}</a>` : '';
  const arx = !p.doi && p.arxiv ? `<a href="https://arxiv.org/abs/${esc(p.arxiv)}" target="_blank" rel="noopener">arXiv ${esc(p.arxiv)}</a>` : '';
  const vol = [p.volume && `vol. ${p.volume}`, p.issue && `no. ${p.issue}`, p.pageRange && `pp. ${p.pageRange}`].filter(Boolean).join(', ');
  const back = document.referrer && new URL(document.referrer).pathname === '/library' ? document.referrer : '/library';
  root.innerHTML = `
    <a class="back" href="${esc(back)}">${icon('chev', '').replace('class="icon ', 'style="transform:rotate(180deg)" class="icon ')}Library</a>
    <h1>${esc(p.title)}</h1>
    <div class="authors">${esc(authors)}</div>
    <div class="pmeta">${[esc(p.venue), esc(p.year), esc(vol), doi || arx].filter(Boolean).join('<span style="color:var(--ink-4)">·</span>')}
      ${conf ? `<span class="badge ${conf[0]}" data-tip="${esc(conf[2])}">${conf[1]}</span>` : ''}</div>
    <div class="actions">
      <a class="btn primary" href="${readerLink(p.id)}">${icon('book')}Read paper</a>
      <button class="btn" id="citeBtn">${icon('quote')}Copy citation</button>
      <div class="menu" id="citeMenu" style="left:0"></div>
      ${CLIENT.features?.slides === false ? '' : `<a class="btn" href="/slides?paper=${encodeURIComponent(p.id)}" target="_blank" rel="noopener">${icon('deck')}Make a deck</a>`}
      <button class="btn" id="revealPdf" data-tip="Show this paper’s PDF in Finder">${icon('folder')}Show in Finder</button>
      <button class="btn" id="paperNode">${icon('notes')}Open paper node in Obsidian</button>
    </div>
    <aside class="pdf-preview" id="pdfPreview" aria-label="Paper PDF" hidden></aside>
    ${p.abstract ? `<section class="psec"><header><h2>Abstract</h2><button class="more" id="absMore">Show all</button></header><div class="abstract" id="abs">${esc(p.abstract)}</div></section>` : ''}
    ${section('hl', 'Highlights', D.highlights.length, previewHighlights(D.highlights), hlHTML, 5)}
    <section class="psec" id="sec-conv">
      <header><h2>Conversations <span class="n">${D.conversations.length}</span></h2>${D.conversations.length > 5 ? `<button class="more" data-more="conv">Show all ${D.conversations.length}</button>` : ''}</header>
      <div class="list">${D.conversations.length ? D.conversations.slice(0, 5).map(convHTML).join('') : '<div class="empty-sec">No linked conversations</div>'}</div>
      <div class="ask-actions">${CLIENT.apps?.chatgpt !== false ? '<button class="btn" data-ask="chatgpt">Ask in ChatGPT</button>' : ''}${CLIENT.apps?.claude !== false ? '<button class="btn" data-ask="claude">Ask in Claude</button>' : ''}<button class="btn quiet" id="copyPrompt">Copy paper prompt</button></div>
      <p class="chat-guide">Ask copies the PDF for you to paste into the app. Save its private conversation URL below. A link saves the title and your note; it does not read chat history.</p>
      <form class="linkform" id="linkForm" autocomplete="off">
        <input name="url" placeholder="Link a claude.ai or chatgpt.com chat" aria-label="Conversation link">
        <input name="title" class="title-in" placeholder="Title (optional)" aria-label="Title">
        <button class="btn" type="submit">${icon('link')}Link</button>
        <textarea name="note" placeholder="Optional takeaway or pasted excerpt, searchable with this paper" aria-label="Conversation note"></textarea>
      </form>
    </section>
    ${D.decks.length ? section('decks', 'Decks', D.decks.length, D.decks, deckHTML, 3) : ''}
    ${D.notes.length ? `<section class="psec" id="sec-notes"><header><h2>Notes <span class="n">${D.notes.length}</span></h2></header>
      <div class="list">${D.notes.map(noteHTML).join('')}</div></section>` : ''}
    ${D.sittings ? `<p class="muted" style="margin-top:40px;font-size:12.5px">${Math.round(D.sittings)} minutes of reading sittings logged on this paper.</p>` : ''}
  `;
  bind();
}

function bind() {
  const p = D.paper;
  root.querySelector('#openPdf')?.addEventListener('click', async () => {
    if (!preview) preview = new PdfPreview(root.querySelector('#pdfPreview'));
    await preview.open(`/api/pdf?paperId=${encodeURIComponent(p.id)}`, p.pdfName);
    preview.host.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  root.querySelector('#copyPrompt')?.addEventListener('click', async () => {
    try { const r = await api(`/api/paper-prompt?paperId=${encodeURIComponent(p.id)}`); copyText(r.prompt, 'Paper prompt copied'); } catch (e) { toast(e.message); }
  });
  const abs = root.querySelector('#abs');
  root.querySelector('#absMore')?.addEventListener('click', (e) => { abs.classList.toggle('open'); e.target.textContent = abs.classList.contains('open') ? 'Show less' : 'Show all'; });
  root.querySelectorAll('[data-more]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.more;
    const list = b.closest('section').querySelector('.list');
    const items = k === 'hl' ? D.highlights.map(hlHTML) : k === 'conv' ? D.conversations.map(convHTML) : D.decks.map(deckHTML);
    list.innerHTML = items.join('');
    b.remove();
  }));
  root.onclick = async (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) { copyText(c.dataset.copy, 'Command copied'); return; }
    const source = e.target.closest('[data-source-note]');
    if (source) {
      try { await api('/api/knowledge/open-source', { path: source.dataset.sourceNote }); }
      catch (err) { toast(err.message); }
      return;
    }
    if (e.target.closest('#revealPdf')) { try { await api('/api/reveal', { paperId: D.paper.id }); } catch (err) { toast(err.message); } return; }
    if (e.target.closest('#paperNode')) {
      try { await api('/api/knowledge/paper', { paperId: p.id, open: true }); }
      catch (err) { toast(err.message); }
      return;
    }
    const ask = e.target.closest('[data-ask]');
    if (ask) {
      ask.disabled = true;
      try { const r = await api('/api/ask-paper', { paperId: p.id, app: ask.dataset.ask }); toast(r.message); }
      catch (err) { toast(err.message); } finally { ask.disabled = false; }
      return;
    }
    const unlink = e.target.closest('[data-unlink]');
    if (unlink) {
      try { await api('/api/unlink-chat', { paperId: p.id, url: unlink.dataset.unlink }); toast('Link removed'); await load(); }
      catch (err) { toast(err.message); }
      return;
    }
    const a = e.target.closest('[data-app]');
    if (a) { try { await api('/api/open-app', { app: a.dataset.app }); toast('Opening Claude Science'); } catch (err) { toast(err.message); } }
  };
  const menu = root.querySelector('#citeMenu');
  root.querySelector('#citeBtn').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (menu.classList.contains('open')) { menu.classList.remove('open'); return; }
    menu.innerHTML = '<button disabled><span class="spin"></span><small>Fetching</small></button>';
    menu.classList.add('open');
    try {
      const c = await api(`/api/cite/${encodeURIComponent(p.id)}`);
      menu.innerHTML = `<button data-c="bib">BibTeX <small>${c.source === 'doi.org' ? 'doi.org' : 'from the record'}</small></button>${c.apa ? '<button data-c="apa">APA <small>doi.org</small></button>' : ''}`;
      menu.onclick = (ev) => {
        const b = ev.target.closest('[data-c]'); if (!b) return;
        copyText(b.dataset.c === 'bib' ? c.bibtex : c.apa, b.dataset.c === 'bib' ? 'BibTeX copied' : 'APA citation copied');
        menu.classList.remove('open');
      };
    } catch (err) { menu.innerHTML = `<button disabled><small>${esc(err.message)}</small></button>`; }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#citeMenu')) menu.classList.remove('open'); });
  root.querySelector('#linkForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/api/link-chat', { paperId: p.id, url: f.url.value.trim(), title: f.title.value.trim(), note: f.note.value.trim() });
      toast('Chat linked');
      await load();
    } catch (err) { toast(err.message); }
  });
}

async function load() {
  try { D = await api(`/api/paper/${encodeURIComponent(id)}`); render(); }
  catch (e) { root.innerHTML = `<a class="back" href="/library">Library</a><p class="noresult">${esc(e.message)}</p>`; }
}
load();
