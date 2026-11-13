import path from 'node:path';
import { normTitle, normDoi } from './util.mjs';

const LISTING_MAX = 3;
const RULE_ORDER = ['id', 'doi', 'arxiv', 'filename', 'title'];

const READ_TOOLS = new Set(['Read', 'read_file', 'fetch_article_fulltext', 'WebFetch']);
const SHELL_TOOLS = new Set(['Bash', 'bash', 'exec', 'exec_command', 'shell', 'local_shell']);
const HARNESS = /\b(python3?|uv|node|npm|npx|bun|deno|git|pytest|playwright|curl|wget|make|osascript|open)\b|\bbin\/|\.(py|js|mjs|sh)\b/;
const READER = /\b(cat|sed|head|tail|less|pdftotext|pdfinfo|awk|grep|rg|cut|jq)\b/;
export function readsContent(chunk) {
  if (READ_TOOLS.has(chunk.tool)) return true;
  if (!SHELL_TOOLS.has(chunk.tool)) return false;
  let cmd = chunk.text;
  try { const j = JSON.parse(chunk.text); cmd = String(j.command || j.cmd || chunk.text); } catch {  }

  cmd = cmd.replace(/\b(which|command -v)\s+[\w.-]+/g, ' ');
  if (READER.test(cmd) && !HARNESS.test(cmd)) return true;

  const inlinePy = /\bpython3?\s+(-c\b|-\s*<<)/.test(cmd);
  const otherHarness = HARNESS.test(cmd.replace(/\bpython3?\b/g, ' ').replace(/\bopen\(/g, ' ('));
  return inlinePy && !otherHarness && !/\.pdf\b|fitz|pymupdf|subprocess|sys\.path/i.test(cmd) && /\.paper\.json|research\/library\/papers\//.test(cmd);
}

const REF_HEAD = /^\s*(?:#{1,6}\s*|\*\*)?(references|bibliography|works cited|reference list|literature cited)\b[^\n]*$/im;

const REF_LINE = /^\s*(?:[-*]|\d+\.|\[\d+\])?\s*(?:\p{Lu}[\p{L}'’-]+,\s+(?:\p{Lu}\.|\p{Lu}[\p{L}-]+[,.])|<?https?:\/\/(?:dx\.)?doi\.org\/|10\.\d{4,9}\/)/u;
function splitReferences(text) {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length >= 5 && lines.filter((l) => REF_LINE.test(l)).length / lines.length >= 0.6) return { body: '', refs: text };
  const m = text.match(REF_HEAD);
  if (!m) return { body: text, refs: '' };
  return { body: text.slice(0, m.index), refs: text.slice(m.index) };
}
const fold = (s) => String(s || '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function bareList(text) {
  let bare = 0, prose = 0;
  for (const l of text.split('\n')) {
    if (!/10\.\d{4,9}\/|\.pdf\b|[a-z0-9]+(?:-[a-z0-9]+){3,}-[0-9a-f]{8}\b|\d{4}\.\d{4,5}/i.test(l)) continue;
    const words = (l.replace(/https?:\/\/\S+|10\.\d{4,9}\/\S+|\S+\.pdf\b|[a-z0-9]+(?:-[a-z0-9]+){3,}/gi, ' ').match(/\p{L}{2,}/gu) || []).length;
    if (words < 6) bare++; else prose++;
  }
  return bare > prose;
}

export function buildLinker(papers) {
  const bySuffix = new Map();
  const byDoi = new Map();
  const byArxiv = new Map();
  const filenames = [];
  const byTitleHead = new Map();

  const venues = new Set(papers.map((p) => normTitle(p.venue)).filter(Boolean));
  const who = new Map(papers.map((p) => [p.id, { surname: fold(String(p.authors[0] || '').trim().split(/\s+/).pop()), year: String(p.year || '') }]));

  const docHits = (text, hits) => {
    const { body, refs } = splitReferences(text);
    const lowBody = body.toLowerCase(), foldBody = fold(body);
    const out = new Map();
    for (const [id, why] of hits) {
      if (why.rule !== 'id' && why.rule !== 'doi' && why.rule !== 'arxiv') continue;
      const m = String(why.match).toLowerCase();
      if (lowBody.includes(m)) { out.set(id, why); continue; }
      if (!refs) continue;
      const w = who.get(id);
      if (w && w.surname.length > 1 && w.year && new RegExp(`${escRe(w.surname)}[^\\n]{0,80}${w.year}`).test(foldBody)) out.set(id, { ...why, viaReferences: true });
    }
    return out;
  };
  for (const p of papers) {
    const tail = p.id.slice(-8);
    if (/^[0-9a-f]{8}$/.test(tail)) {
      if (!bySuffix.has(tail)) bySuffix.set(tail, []);
      bySuffix.get(tail).push(p.id);
    }
    if (p.doi) byDoi.set(p.doi, p.id);
    if (p.arxiv) byArxiv.set(p.arxiv, p.id);
    const names = new Set([p.sourceName, p.pdfPath ? path.basename(p.pdfPath) : ''].filter(Boolean));
    for (const n of names) if (n.length >= 12) filenames.push([n.toLowerCase(), p.id, n]);
    const nt = normTitle(p.title);
    if (nt.length >= 30 && p.confidence !== 'guessed' && !venues.has(nt)) {
      const toks = nt.split(' ');
      if (toks.length >= 2) {
        const key = toks[0] + ' ' + toks[1];
        if (!byTitleHead.has(key)) byTitleHead.set(key, []);
        byTitleHead.get(key).push({ tokens: toks, id: p.id, text: nt });
      }
    }
  }

  function scanChunk(chunk) {
    const hits = new Map();
    const add = (id, rule, match) => {
      const prev = hits.get(id);
      if (!prev || RULE_ORDER.indexOf(rule) < RULE_ORDER.indexOf(prev.rule)) hits.set(id, { rule, match });
    };
    const lower = chunk.toLowerCase();

    for (const m of lower.matchAll(/-([0-9a-f]{8})(?![0-9a-z])/g)) {
      const ids = bySuffix.get(m[1]);
      if (ids) for (const id of ids) if (lower.includes(id)) add(id, 'id', id);
    }
    if (lower.includes('10.')) {
      for (const m of lower.matchAll(/10\.\d{4,9}\/[^\s"'<>\\`]+/g)) {
        let d = normDoi(m[0]);
        for (let k = 0; k < 3 && d; k++) {
          if (byDoi.has(d)) { add(byDoi.get(d), 'doi', d); break; }
          d = normDoi(d.replace(/\.pdf$|\/(full|abstract|epdf|pdf)$/i, '').replace(/[)\]}]+$/, ''));
        }
      }
    }
    for (const m of lower.matchAll(/(?<![\d.])(\d{4}\.\d{4,5})(?:v\d+)?(?!\d)/g)) {
      const id = byArxiv.get(m[1]);
      if (id) add(id, 'arxiv', m[0]);
    }
    if (lower.includes('.pdf')) {
      for (const [n, id, disp] of filenames) if (lower.includes(n)) add(id, 'filename', disp);
    }
    const toks = normTitle(chunk).split(' ');
    for (let i = 0; i + 1 < toks.length; i++) {
      const cands = byTitleHead.get(toks[i] + ' ' + toks[i + 1]);
      if (!cands) continue;
      for (const c of cands) {
        let ok = true;
        for (let j = 2; j < c.tokens.length; j++) if (toks[i + j] !== c.tokens[j]) { ok = false; break; }
        if (ok) add(c.id, 'title', c.text);
      }
    }
    return hits;
  }

  const PROSE = new Set(['prompt', 'reply', 'handoff']);
  const otherIds = (lower) => {
    const set = new Set();
    if (lower.includes('10.')) for (const m of lower.matchAll(/10\.\d{4,9}\/[^\s"'<>\\`]+/g)) set.add(normDoi(m[0]));
    for (const m of lower.matchAll(/(?<![\d.])(\d{4}\.\d{4,5})(?:v\d+)?(?!\d)/g)) set.add('arxiv:' + m[1]);
    return set;
  };
  const years = (text) => new Set(text.match(/\b(19[5-9]\d|20[0-2]\d)\b/g) || []).size;

  function scan(chunks) {
    const firm = new Map();
    const pending = new Map();
    let dropped = 0;
    const put = (map, id, why, from) => {
      const prev = map.get(id);
      if (!prev) map.set(id, { ...why, from, count: 1 });
      else {
        prev.count++;
        if (RULE_ORDER.indexOf(why.rule) < RULE_ORDER.indexOf(prev.rule)) Object.assign(prev, why, { from });
      }
    };
    for (const c of chunks) {
      if (!c || !c.text || c.from === 'result') continue;
      const hits = scanChunk(c.text);
      if (!hits.size) continue;
      if (c.from === 'doc') {
        for (const [id, why] of docHits(c.text, hits)) put(firm, id, why, 'doc');
        continue;
      }
      if (c.from === 'tool') {
        const lower = c.text.toLowerCase();
        const ids = otherIds(lower);
        for (const [, why] of hits) if (why.rule === 'id' || why.rule === 'filename' || why.rule === 'title') ids.add(why.rule + ':' + why.match);
        const titleHit = [...hits.values()].some((w) => w.rule === 'title');
        if (ids.size > LISTING_MAX || (titleHit && years(c.text) >= 3)) { dropped++; continue; }

        const named = [...hits.values()].every((w) => w.rule === 'id' || w.rule === 'filename') && ids.size === hits.size;
        const oneDoi = ids.size === 1 && hits.size === 1 && [...hits.values()][0].rule === 'doi';
        const direct = (named || oneDoi) && readsContent(c);
        for (const [id, why] of hits) put(direct ? firm : pending, id, why, 'tool');
        continue;
      }
      const from = PROSE.has(c.from) ? c.from : 'reply';
      if (hits.size > LISTING_MAX) {
        if (bareList(c.text)) { dropped++; continue; }
        for (const [id, why] of docHits(c.text, hits)) put(firm, id, why, from);
        continue;
      }
      const inRefsOnly = splitReferences(c.text).refs ? docHits(c.text, hits) : null;
      for (const [id, why] of hits) {
        if (inRefsOnly && (why.rule === 'id' || why.rule === 'doi' || why.rule === 'arxiv') && !inRefsOnly.has(id)) continue;
        put(firm, id, why, from);
      }
    }

    for (const [id, why] of pending) {
      const f = firm.get(id);
      if (f) { f.count += why.count; }
    }
    return { links: firm, dropped };
  }

  return { scan, scanChunk };
}

export function describeWhy(why) {
  if (!why) return '';
  const what = { id: 'Lancetfish id', doi: 'DOI', arxiv: 'arXiv id', filename: 'PDF file name', title: 'full title', reader: 'reader', file: 'file name', manual: 'linked by hand' }[why.rule] || why.rule;
  return `${what}: ${why.match}`;
}
