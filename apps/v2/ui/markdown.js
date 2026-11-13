const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => /^(https?:\/\/|mailto:|#|\/(?![\/\\]))/i.test(u);

const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)/;
const TABLE_RULE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const QUOTE = /^\s{0,3}>\s?/;

const LINK = /(!?)\[((?:[^\[\]\\]|\\.|\[[^\[\]]*\])*)\]\(\s*(\{\{[^}\s\u0000]+\}{1,2}|<[^>\s\u0000]+>|(?:[^\s()\\\u0000]|\\[^\u0000]|\([^\s()\u0000]*\))+)(?:\s+"([^"\u0000]*)")?\s*\)/g;
const BARE = /(^|[\s(])((?:https?:\/\/)[^\s<>\u0000]+[^\s<>\u0000.,;:!?)\]'"])/g;

const indentOf = (line) => line.match(/^\s*/)[0].replace(/\t/g, '    ').length;
const isTableStart = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('-') && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes('|');
const startsBlock = (lines, i) => FENCE.test(lines[i]) || HEADING.test(lines[i]) || RULE.test(lines[i]) || QUOTE.test(lines[i]) || ITEM.test(lines[i]) || isTableStart(lines, i);

const interrupts = (lines, i) => { const m = ITEM.exec(lines[i]); return m ? !/\d/.test(m[2]) || /^1[.)]$/.test(m[2]) : startsBlock(lines, i); };

export function renderMarkdown(source, opts = {}) {
  const headings = [];
  const slugs = new Map();
  const slug = (text) => {
    const base = text.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'section';
    const n = slugs.get(base) || 0; slugs.set(base, n + 1);
    return n ? `${base}-${n + 1}` : base;
  };

  function inline(raw, held = []) {
    const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
    let s = String(raw);
    s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (m, t, code) => hold(`<code>${esc(code.trim())}</code>`));
    s = s.replace(LINK, (m, bang, text, target, title) => {
      let href = target.replace(/^<|>$/g, '').replace(/\\([()])/g, '$1');
      if (bang) {
        const own = opts.image && opts.image(href, text);
        if (typeof own === 'string') return hold(own);
        return safeUrl(href) ? hold(`<img src="${esc(href)}" alt="${esc(text)}" loading="lazy">`) : hold(esc(text));
      }
      const inner = inline(text, held);
      const own = opts.link && opts.link(href, inner, title || '');
      if (typeof own === 'string') return hold(own);
      if (!safeUrl(href)) return hold(inner);
      const out = /^https?:/i.test(href) ? ' target="_blank" rel="noopener"' : '';
      return hold(`<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ''}${out}>${inner}</a>`);
    });
    s = s.replace(/<(https?:\/\/[^\s<>\u0000]+)>/g, (m, href) => hold(bareLink(href)));
    s = s.replace(BARE, (m, lead, href) => lead + hold(bareLink(href)));
    s = s.replace(/\\([\\`*_{}\[\]()#+\-.!|~>])/g, (m, c) => hold(esc(c)));
    s = esc(s)
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\p{L}\p{N}_])__(?=\S)([\s\S]*?\S)__(?![\p{L}\p{N}_])/gu, '$1<strong>$2</strong>')
      .replace(/\*(?=[^\s*])([^*]*?[^\s*])\*/g, '<em>$1</em>')
      .replace(/(^|[^\p{L}\p{N}_])_(?=[^\s_])([^_]*?[^\s_])_(?![\p{L}\p{N}_])/gu, '$1<em>$2</em>')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');

    for (let pass = 0; pass < 4 && s.includes('\u0000'); pass++) s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => held[Number(i)] ?? '');
    return s;
  }

  function bareLink(href) {
    const own = opts.link && opts.link(href, esc(href), '');
    return typeof own === 'string' ? own : `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(href)}</a>`;
  }

  function cells(line) {
    const out = []; let cur = '';
    const body = line.trim().replace(/^\|/, '').replace(/\|\s*$/, '');
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '\\' && body[i + 1] === '|') { cur += '|'; i++; }
      else if (body[i] === '|') { out.push(cur.trim()); cur = ''; }
      else cur += body[i];
    }
    out.push(cur.trim());
    return out;
  }

  function table(lines) {
    const head = cells(lines[0]);
    const align = cells(lines[1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : ''));
    const at = (i) => (align[i] ? ` style="text-align:${align[i]}"` : '');
    const rows = lines.slice(2).map(cells);
    return `<div class="md-table"><table><thead><tr>${head.map((c, i) => `<th${at(i)}>${inline(c)}</th>`).join('')}</tr></thead><tbody>${
      rows.map((r) => `<tr>${head.map((_, i) => `<td${at(i)}>${inline(r[i] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  function list(lines, i) {
    const first = ITEM.exec(lines[i]);
    const base = indentOf(lines[i]);
    const ordered = /\d/.test(first[2]);
    const items = [];
    let loose = false, j = i;
    while (j < lines.length) {
      const m = ITEM.exec(lines[j]);
      if (!m || indentOf(lines[j]) > base + 1 || /\d/.test(m[2]) !== ordered) break;
      const width = m[0].length;
      const body = [lines[j].slice(width)];
      j++;
      while (j < lines.length) {
        const line = lines[j];
        if (!line.trim()) {

          let k = j; while (k < lines.length && !lines[k].trim()) k++;
          if (k < lines.length && indentOf(lines[k]) > base + 1) { for (; j < k; j++) body.push(''); continue; }
          break;
        }
        const ind = indentOf(line);
        if (ind <= base + 1 && (ITEM.test(line) || startsBlock(lines, j))) break;
        if (ind <= base + 1 && !body[body.length - 1].trim()) break;
        body.push(line.slice(Math.min(ind, width)));
        j++;
      }
      items.push(body);

      let k = j; while (k < lines.length && !lines[k].trim()) k++;
      const next = k < lines.length ? ITEM.exec(lines[k]) : null;
      if (k > j && next && indentOf(lines[k]) <= base + 1 && /\d/.test(next[2]) === ordered) { loose = true; j = k; }
    }
    const start = ordered ? Number(first[2].replace(/\D/g, '')) : 1;
    const html = items.map((body) => {
      let inner = blocks(body);
      if (!loose) inner = inner.replace(/^<p>([\s\S]*?)<\/p>/, '$1');
      return `<li>${inner}</li>`;
    }).join('');
    return [ordered ? `<ol${start !== 1 ? ` start="${start}"` : ''}>${html}</ol>` : `<ul>${html}</ul>`, j];
  }

  function blocks(lines) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      let m;
      if ((m = FENCE.exec(line))) {
        const close = new RegExp(`^\\s{0,3}${m[1][0]}{${m[1].length},}\\s*$`);
        const body = []; i++;
        while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
        i++;
        out.push(`<pre><code${m[2] ? ` data-lang="${esc(m[2])}"` : ''}>${esc(body.join('\n'))}</code></pre>`);
        continue;
      }
      if ((m = HEADING.exec(line))) {
        const level = m[1].length, html = inline(m[2]);
        const text = html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        const id = slug(text);
        headings.push({ level, text, id });
        out.push(`<h${level} id="${esc(id)}">${html}</h${level}>`);
        i++; continue;
      }
      if (RULE.test(line)) { out.push('<hr>'); i++; continue; }
      if (isTableStart(lines, i)) {
        const rows = [lines[i], lines[i + 1]]; i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(lines[i++]);
        out.push(table(rows));
        continue;
      }
      if (QUOTE.test(line)) {
        const body = [];
        while (i < lines.length && lines[i].trim() && (QUOTE.test(lines[i]) || !startsBlock(lines, i))) body.push(lines[i++].replace(QUOTE, ''));
        out.push(`<blockquote>${blocks(body)}</blockquote>`);
        continue;
      }
      if (ITEM.test(line)) { const [html, next] = list(lines, i); out.push(html); i = next; continue; }
      const para = [line.trimStart()]; i++;
      while (i < lines.length && lines[i].trim() && !interrupts(lines, i)) para.push(lines[i++].trimStart());

      const html = inline(para.join('\n').trimEnd()).replace(/ {2,}\n|\\\n/g, '<br>\n').replace(/ +\n/g, '\n');
      out.push(/^<(img|figure)\b[^>]*>(<\/figure>)?$/.test(html) || /^<figure[\s\S]*<\/figure>$/.test(html) ? html : `<p>${html}</p>`);
    }
    return out.join('\n');
  }

  const html = blocks(String(source || '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'));
  return { html, headings };
}

export function parseCSV(text) {
  const rows = []; let row = [], cur = '', quoted = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else quoted = false; }
      else cur += c;
    } else if (c === '"' && cur === '') quoted = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
