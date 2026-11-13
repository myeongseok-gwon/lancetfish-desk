import { api, toast, CLIENT } from '/ui/common.js';

const COLORS = ['yellow', 'green', 'pink'];
const SKIP = '.topbar, .lf-pop, .lf-helper, .toast, .tip, script, style, noscript, textarea, input, select, [contenteditable=""], [contenteditable="true"], #readerHost, [data-no-marks]';
const supported = typeof Highlight === 'function' && CSS.highlights;

if (!document.getElementById('readerHost')) start();

function start() {
  let marks = [], live = [], index = null, key = '', loading = 0;
  let pop = null, popFor = null;
  const sets = supported ? Object.fromEntries(COLORS.map((c) => { const h = new Highlight(); CSS.highlights.set(`lf-${c}`, h); return [c, h]; })) : {};

  const skipped = (node) => { const el = node.nodeType === 1 ? node : node.parentElement; return !el || !!el.closest(SKIP); };
  function build() {
    const nodes = []; let text = '';
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.data && !skipped(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) { nodes.push({ node: n, start: text.length }); text += n.data; }
    return { nodes, text };
  }
  function point(idx, offset, end) {

    let lo = 0, hi = idx.nodes.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (idx.nodes[mid].start <= offset) lo = mid; else hi = mid - 1; }

    if (end && lo > 0 && idx.nodes[lo].start === offset) lo--;
    const n = idx.nodes[lo];
    return n ? [n.node, Math.min(n.node.data.length, offset - n.start)] : null;
  }
  function offsets(range, idx) {
    let s = -1, e = -1;
    for (const { node, start } of idx.nodes) {
      if (!range.intersectsNode(node)) continue;
      const a = node === range.startContainer ? range.startOffset : 0;
      const b = node === range.endContainer ? range.endOffset : node.data.length;
      if (b <= a) continue;
      if (s < 0) s = start + a;
      e = start + b;
    }
    return s < 0 ? null : [s, e];
  }

  function find(idx, m) {
    let best = -1, bestScore = -1;
    for (let at = idx.text.indexOf(m.exact); at >= 0; at = idx.text.indexOf(m.exact, at + 1)) {
      let score = 0;
      const before = idx.text.slice(Math.max(0, at - m.prefix.length), at), after = idx.text.slice(at + m.exact.length, at + m.exact.length + m.suffix.length);
      for (let i = 1; i <= Math.min(before.length, m.prefix.length) && before.at(-i) === m.prefix.at(-i); i++) score++;
      for (let i = 0; i < Math.min(after.length, m.suffix.length) && after[i] === m.suffix[i]; i++) score++;
      if (score > bestScore) { best = at; bestScore = score; }
      if (score === m.prefix.length + m.suffix.length) break;
    }
    return best;
  }

  function draw() {
    if (!supported) return;
    for (const c of COLORS) sets[c].clear();
    live = [];
    if (!marks.length) { index = null; return; }
    index = build();
    for (const m of marks) {
      const at = find(index, m);
      if (at < 0) continue;
      const a = point(index, at, false), b = point(index, at + m.exact.length, true);
      if (!a || !b) continue;
      const range = document.createRange();
      try { range.setStart(a[0], a[1]); range.setEnd(b[0], b[1]); } catch { continue; }
      (sets[m.color] || sets.yellow).add(range);
      live.push({ mark: m, range });
    }
  }
  const pageKey = () => {
    const q = new URLSearchParams(location.search);
    q.sort();
    const s = q.toString();
    return location.pathname + (s ? `?${s}` : '');
  };
  async function load() {
    const mine = ++loading, k = pageKey();
    key = k;
    try { const d = await api(`/api/marks?page=${encodeURIComponent(k)}`); if (mine === loading) { marks = d.marks; draw(); } }
    catch { if (mine === loading) { marks = []; draw(); } }
  }

  let timer = 0;
  const refresh = () => { clearTimeout(timer); timer = setTimeout(() => { if (pageKey() !== key) load(); else if (marks.length) draw(); }, 140); };
  new MutationObserver((list) => { if (list.some((m) => !skipped(m.target))) refresh(); }).observe(document.body, { childList: true, subtree: true, characterData: true });
  window.addEventListener('popstate', refresh);

  function hide() { if (pop) pop.hidden = true; popFor = null; }
  function button(label, title, fn, cls = 'lf-pop-btn') {
    const b = document.createElement('button');
    b.type = 'button'; b.className = cls; b.textContent = label; b.title = title;
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    pop.append(b); return b;
  }
  function show(target, rect) {
    if (!pop) { pop = document.createElement('div'); pop.className = 'lf-pop'; pop.setAttribute('role', 'toolbar'); pop.setAttribute('aria-label', 'Selected text'); document.body.append(pop); }
    popFor = target;
    pop.replaceChildren();
    const mark = target.mark;
    if (supported) COLORS.forEach((c, i) => {
      const b = button('', `${c[0].toUpperCase()}${c.slice(1)} highlight (⌥${i + 1})`, () => (mark ? recolor(mark, c) : add(c)), `lf-swatch lf-${c}`);
      b.setAttribute('aria-label', b.title);
      if (mark && mark.color === c) b.setAttribute('aria-pressed', 'true');
    });
    const text = mark ? mark.exact : target.text, context = mark ? contextOf(live.find((l) => l.mark === mark)?.range, text) : contextOf(target.range, text);
    if (supported && ((CLIENT.features || {}).translate !== false || (CLIENT.features || {}).study !== false)) { const sep = document.createElement('span'); sep.className = 'lf-pop-sep'; pop.append(sep); }
    const can = CLIENT.features || {};
    if (can.translate !== false) button('Translate', 'A dictionary definition and a translation, for the sense used here', () => { hide(); lookup(text, context); });
    if (can.study !== false) button('Study', 'Learn this concept in your Obsidian vault', () => { hide(); study(text, context); });
    if (!supported && can.translate === false && can.study === false) { hide(); return; }
    if (mark) button('Remove', 'Remove this highlight', () => remove(mark), 'lf-pop-btn lf-pop-danger');
    pop.hidden = false;
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let x = rect.left + rect.width / 2 - w / 2, y = rect.top - h - 8;
    if (y < 8) y = rect.bottom + 8;
    pop.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, x))}px`;
    pop.style.top = `${Math.max(8, Math.min(innerHeight - h - 8, y))}px`;
  }
  function contextOf(range, text) {
    if (!range) return text;
    const idx = build(), o = offsets(range, idx);
    return o ? idx.text.slice(Math.max(0, o[0] - 300), o[1] + 300).replace(/\s+/g, ' ').trim() : text;
  }

  function selected() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (skipped(range.startContainer) || skipped(range.endContainer)) return null;
    const text = range.toString().replace(/\s+/g, ' ').trim();
    return text ? { range, text } : null;
  }
  function offer() {
    const s = selected();
    if (!s) { if (popFor && !popFor.mark) hide(); return; }
    const rects = s.range.getClientRects();
    show(s, rects.length ? rects[0] : s.range.getBoundingClientRect());
  }

  async function add(color) {
    const s = popFor && !popFor.mark ? popFor : selected();
    if (!s) return;
    const idx = build(), o = offsets(s.range, idx);
    hide();
    if (!o) return;
    const exact = idx.text.slice(o[0], o[1]);
    if (!exact.trim()) return;
    if (exact.length > 5000) { toast('That is too much to highlight at once (5,000 characters at most)'); return; }
    try {
      const d = await api('/api/marks', { page: pageKey(), exact, prefix: idx.text.slice(Math.max(0, o[0] - 48), o[0]), suffix: idx.text.slice(o[1], o[1] + 48), color, title: document.title });
      marks.push(d.mark);
      getSelection().removeAllRanges();
      draw();
    } catch (e) { toast(e.message); }
  }
  async function recolor(mark, color) {
    hide();
    try { await api('/api/marks/update', { id: mark.id, color }); mark.color = color; draw(); } catch (e) { toast(e.message); }
  }
  async function remove(mark) {
    hide();
    try { await api('/api/marks/remove', { id: mark.id }); marks = marks.filter((m) => m !== mark); draw(); } catch (e) { toast(e.message); }
  }

  function markAt(x, y) {
    if (!live.length) return null;
    let node, offset;
    if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); if (!p) return null; node = p.offsetNode; offset = p.offset; }
    else if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(x, y); if (!r) return null; node = r.startContainer; offset = r.startOffset; }
    else return null;
    for (const l of live) {
      try { if (l.range.comparePoint(node, offset) !== 0) continue; } catch { continue; }

      const hit = [...l.range.getClientRects()].find((r) => x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1);
      if (hit) return { mark: l.mark, rect: hit };
    }
    return null;
  }

  document.addEventListener('mouseup', (e) => { if (e.target.closest?.('.lf-pop, .lf-helper')) return; setTimeout(offer, 0); });
  document.addEventListener('keyup', (e) => { if (e.shiftKey || e.key === 'Shift') setTimeout(offer, 0); });
  document.addEventListener('click', (e) => {
    if (e.target.closest?.('.lf-pop, .lf-helper') || selected()) return;
    const hit = markAt(e.clientX, e.clientY);
    if (hit) show({ mark: hit.mark }, hit.rect); else hide();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pop && !pop.hidden) { hide(); return; }

    if (!e.altKey || e.metaKey || e.ctrlKey || !/^Digit[1-3]$/.test(e.code) || !supported) return;
    const color = COLORS[Number(e.code.slice(5)) - 1];
    if (popFor?.mark) { e.preventDefault(); recolor(popFor.mark, color); }
    else if (selected()) { e.preventDefault(); add(color); }
  });
  window.addEventListener('scroll', () => { if (pop && !pop.hidden) hide(); }, { passive: true, capture: true });
  window.addEventListener('resize', hide);

  let helper = null, body = null, token = 0;
  const el = (tag, text, parent = body, cls = '') => { const n = document.createElement(tag); n.textContent = text; if (cls) n.className = cls; parent.append(n); return n; };
  function open(title) {
    if (!helper) {
      helper = document.createElement('dialog'); helper.className = 'lf-helper';
      const head = el('div', '', helper, 'lf-helper-head');
      el('strong', '', head);
      const close = el('button', 'Close', head, 'btn quiet'); close.type = 'button'; close.addEventListener('click', () => helper.close());
      body = el('div', '', helper);
      helper.addEventListener('close', () => { token++; });
      helper.addEventListener('click', (e) => { if (e.target === helper) helper.close(); });
      document.body.append(helper);
    }
    token++;
    helper.querySelector('strong').textContent = title;
    body.replaceChildren();
    if (!helper.open) helper.showModal();
    return token;
  }
  function action(label, fn, parent = body, primary = false) {
    const b = el('button', label, parent, `btn${primary ? ' primary' : ''}`);
    b.type = 'button';
    b.addEventListener('click', async () => { b.disabled = true; try { await fn(); } catch (e) { toast(e.message); } finally { b.disabled = false; } });
    return b;
  }
  const line = (label, text) => { if (!text) return; const row = el('div', '', body, 'lf-helper-line'); el('small', label, row); el('p', text, row); };
  const paperId = () => (/^\/paper\/([a-z0-9-]{1,100})$/.exec(location.pathname) || [])[1] || '';

  async function lookup(term, context) {
    const mine = open('Translate & vocabulary');
    el('h2', term.length > 140 ? `${term.slice(0, 139)}…` : term);
    const status = el('p', 'Looking up the dictionary and reading this passage with your Claude Code subscription…', body, 'muted');
    try {
      const row = await api('/api/marks/lookup', { term, context, where: document.title, paperId: paperId() });
      if (mine !== token) return;
      body.replaceChildren();
      el('h2', row.headword || row.term || term);
      if (row.ipa) el('p', row.ipa, body, 'muted');
      line('Dictionary', row.entry_definition);
      line('In this passage', row.in_context || row.definition);
      line('Example', row.example);
      if (row.dictionary?.url && /^https?:\/\//.test(row.dictionary.url)) { const a = el('a', 'Dictionary source', body, 'lf-helper-source'); a.href = row.dictionary.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      const states = { added: 'Added to Anki', duplicate: 'Already in Anki', queued: 'Queued locally. It goes to Anki the next time queued cards are synced from the reader.', failed: 'Anki could not save this card.' };
      const card = el('p', states[row.card?.state] || 'Kept as a lookup. You can add its headword to Anki.', body, 'muted');
      if (!['added', 'duplicate', 'queued'].includes(row.card?.state)) action('Add headword to Anki', async () => {
        const out = await api('/api/marks/lookup-card', { id: row.id });
        card.textContent = states[out.card?.state] || 'Anki did not add this card.';
      });
    } catch (e) { if (mine === token) { status.textContent = e.message; action('Try again', () => lookup(term, context)); } }
  }

  function study(term, context) {
    const mine = open('Study a concept');
    const form = el('form', '', body, 'lf-helper-form');
    const name = document.createElement('input'); name.value = term.slice(0, 200); name.required = true; name.maxLength = 200; el('label', 'Concept', form).append(name);
    const question = document.createElement('textarea'); question.rows = 3; question.placeholder = 'Optional question or direction for the write-up'; el('label', 'What would you like to understand?', form).append(question);
    const provider = document.createElement('select');
    for (const [v, t] of [['claude', 'Claude Code'], ['codex', 'Codex']]) { const o = document.createElement('option'); o.value = v; o.textContent = t; provider.append(o); }
    el('label', 'Write with', form).append(provider);
    el('p', 'The study note is written into your connected Obsidian vault.', form, 'muted');
    const status = el('p', '', form, 'lf-helper-status');
    const submit = el('button', 'Study in my vault', form, 'btn primary'); submit.type = 'submit';
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); submit.disabled = true;
      status.textContent = 'Connecting this concept in your vault…';
      try {
        let row = await api('/api/knowledge/study', { paperId: paperId(), term: name.value.trim(), question: question.value.trim(), context, provider: provider.value, sourcePath: `${document.title} (${pageKey()})` });
        while (['queued', 'running'].includes(row.status) && mine === token) {
          status.textContent = 'Writing your study note. You can close this panel and carry on.';
          await new Promise((r) => setTimeout(r, 2500));
          if (mine !== token) return;
          row = await api(`/api/knowledge/study?id=${encodeURIComponent(row.id)}`);
        }
        if (mine !== token) return;
        if (['failed', 'error', 'interrupted'].includes(row.status)) throw new Error(row.error || 'The study note could not be prepared.');
        status.textContent = row.status === 'existing' ? 'You already have a note on this. It is open in Obsidian.' : 'Your study note is ready in Obsidian.';
        const note = row.notePath || row.main;
        if (note) action('Open study note', () => api('/api/knowledge/open', { path: note }), body, true);
      } catch (err) { if (mine === token) status.textContent = err.message; }
      finally { if (mine === token) submit.disabled = false; }
    });
    question.focus();
  }

  load();
}
