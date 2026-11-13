import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA, LF, readJSON, writeJSON, readJSONL, appendJSONL, sha1, normDoi, toMs, trimText } from './util.mjs';
import { loadPapers, loadPrograms } from './sources/papers.mjs';
import { loadHighlights } from './sources/highlights.mjs';
import { loadMarlinChats } from './sources/marlin.mjs';
import { loadDecks } from './sources/decks.mjs';
import { loadNotes } from './sources/notes.mjs';
import { listClaudeFiles, parseClaudeSession } from './sources/claude-code.mjs';
import { listCodexFiles, parseCodexSession } from './sources/codex.mjs';
import { loadScience } from './sources/science.mjs';
import { loadSittings } from './sources/sittings.mjs';
import { buildLinker, describeWhy } from './link.mjs';
import { learnRepeats, isNoiseSession } from './noise.mjs';
import { readConfig } from './settings.mjs';

const DB_FILE = path.join(DATA, 'index.db');
const CHAT_CACHE = path.join(DATA, 'chat-cache.json');
const LINKS_FILE = path.join(DATA, 'links.jsonl');

const CODE_HASH = sha1(['link.mjs', 'noise.mjs', 'sources/claude-code.mjs', 'sources/codex.mjs', 'sources/stream.mjs']
  .map((f) => { try { return fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), f), 'utf8'); } catch { return f; } }).join('\n'));

const GROUP_MAX_PAPERS = 3;

export const KINDS = ['paper', 'highlight', 'chat', 'deck', 'note'];
const APP_LABEL = { 'claude-code': 'Claude Code', codex: 'Codex', science: 'Claude Science', marlin: 'Marlin', 'claude.ai': 'Claude', chatgpt: 'ChatGPT' };

export const store = {
  ready: false,
  building: null,
  builtAt: 0,
  stats: {},
  papers: [],
  paperById: new Map(),
  programs: [],
  highlights: new Map(),
  marlin: [],
  decks: [],
  notes: [],
  chats: [],
  manual: [],
  sittings: [],
  db: null,
};

function linkRecord(rec, linker) {
  const { links, dropped } = linker.scan(rec.chunks || []);
  delete rec.chunks;
  rec.links = [...links].map(([paperId, why]) => ({ paperId, ...why }));
  rec.droppedListings = dropped;
  return rec;
}

async function loadChats(papers, log) {
  const linker = buildLinker(papers);
  const fingerprint = sha1(CODE_HASH + '|' + papers.map((p) => [p.id, p.doi, p.arxiv, p.sourceName, p.title].join('|')).join('\n'));
  const cache = readJSON(CHAT_CACHE, null);
  const old = cache && cache.fingerprint === fingerprint ? cache.entries : {};
  const entries = {};
  const out = [];
  let parsed = 0;

  const enabled = readConfig().apps || {};
  const files = [...(enabled.claudeCode === false ? [] : listClaudeFiles()).map((e) => ({ ...e, app: 'claude-code' })), ...(enabled.codex === false ? [] : listCodexFiles()).map((e) => ({ ...e, app: 'codex' }))];
  for (const e of files) {
    const hit = old[e.file];
    let rec;
    if (hit && hit.size === e.size && hit.mtimeMs === e.mtimeMs) rec = hit.record;
    else {
      rec = e.app === 'claude-code' ? await parseClaudeSession(e) : await parseCodexSession(e);
      linkRecord(rec, linker);
      parsed++;
    }
    rec.file = e.file;
    entries[e.file] = { size: e.size, mtimeMs: e.mtimeMs, record: rec };
    out.push(rec);
  }
  writeJSON(CHAT_CACHE, { fingerprint, entries });

  learnRepeats(out);
  const kept = out.filter((r) => !isNoiseSession(r));
  log && log(`chats: skipped ${out.length - kept.length} automated or empty sessions`);
  out.length = 0; out.push(...kept);

  const byId = new Map(out.filter((r) => r.app === 'codex').map((r) => [r.id, r]));
  const merged = [];
  for (const r of out) {
    if (r.app === 'codex' && r.parent && byId.has(r.parent)) {
      const p = byId.get(r.parent);
      p.subagents = (p.subagents || 0) + 1;
      for (const l of r.links) if (!p.links.some((x) => x.paperId === l.paperId)) p.links.push({ ...l, from: 'subagent' });
      continue;
    }
    merged.push(r);
  }

  for (const r of enabled.science === false ? [] : loadScience()) merged.push(linkRecord(r, linker));
  log && log(`chats: ${merged.length} (${parsed} parsed fresh)`);
  return merged;
}

function loadManualLinks() {
  const links = new Map();
  for (const l of readJSONL(LINKS_FILE)) {
    if (!l || !l.url || !l.paperId) continue;
    const key = l.paperId + '|' + l.url;
    if (l.removed) links.delete(key); else links.set(key, l);
  }
  return [...links.values()].filter((l) => store.paperById.has(l.paperId));
}

export function addManualLink({ paperId, url, title, note }) {
  if (!store.paperById.has(paperId)) throw new Error('unknown paper');
  let u;
  try { u = new URL(String(url).trim()); } catch { throw new Error('not a URL'); }
  const host = u.hostname.replace(/^www\./, '');
  const app = host === 'claude.ai' ? 'claude.ai' : (host === 'chatgpt.com' || host === 'chat.openai.com') ? 'chatgpt' : null;
  const conversation = app === 'claude.ai' ? /^\/(chat|share)\/[a-zA-Z0-9-]+\/?$/ : /^\/(?:g\/[^/]+\/)?(?:c|share)\/[a-zA-Z0-9-]+\/?$/;
  if (!app || u.protocol !== 'https:' || u.username || u.password || u.port || !conversation.test(u.pathname)) throw new Error('Paste a claude.ai or chatgpt.com conversation link');
  u.search = ''; u.hash = ''; u.hostname = host;
  const rec = { paperId, url: u.toString(), title: trimText(title || '', 120), note: String(note || '').trim().slice(0, 100000), app, at: new Date().toISOString() };
  appendJSONL(LINKS_FILE, rec);
  refreshManualLinks();
  return rec;
}

export function removeManualLink({ paperId, url }) {
  const rec = store.manual.find((l) => l.paperId === paperId && l.url === url);
  if (!rec) throw new Error('No saved conversation link');
  appendJSONL(LINKS_FILE, { paperId, url, removed: true, at: new Date().toISOString() });
  refreshManualLinks();
  return { removed: true };
}

function refreshManualLinks() {
  store.manual = loadManualLinks();
  refreshDerivedIndex();
}

export function refreshDeckIndex() {
  store.decks = loadDecks(new Set(store.paperById.keys()));
  refreshDerivedIndex();
}

export function refreshReaderIndex() {
  store.highlights = loadHighlights(store.papers);
  refreshDerivedIndex();
  store.stats.highlights = [...store.highlights.values()].reduce((n, h) => n + h.highlights.length, 0);
}

function refreshDerivedIndex() {
  if (!store.ready) return;
  const tmp = DB_FILE + '.next';
  const rows = writeIndex(tmp);
  store.db.close(); fs.renameSync(tmp, DB_FILE);
  store.db = new DatabaseSync(DB_FILE, { readOnly: true });
  prepareStatements(); computeTouch();
  store.stats.rows = rows;
  store.stats.decks = store.decks.length;
  store.stats.conversations = store.chats.length + store.marlin.length + store.manual.length;
}

const UMLAUT = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss' };
function altSpellings(text) {
  const out = new Set();
  for (const m of text.matchAll(/[\p{L}]*[äöüÄÖÜß][\p{L}]*/gu)) out.add(m[0].replace(/[äöüÄÖÜß]/g, (c) => UMLAUT[c]));
  for (const m of text.matchAll(/\p{L}+(?:['’]\p{L}+)+/gu)) out.add(m[0].replace(/['’]/g, ''));
  return [...out].join(' ');
}

function chatBody(r) {
  return r.messages.map((m) => m.text).join('\n');
}

function writeIndex(file) {
  try { fs.unlinkSync(file); } catch {  }
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;
    CREATE TABLE docs(rowid INTEGER PRIMARY KEY, kind TEXT, sub TEXT, ref TEXT, app TEXT, title TEXT, date TEXT, meta TEXT);
    CREATE TABLE doc_papers(rowid INTEGER, paper_id TEXT);
    CREATE INDEX doc_papers_row ON doc_papers(rowid);
    CREATE VIRTUAL TABLE fts USING fts5(title, body, alt, tokenize='porter unicode61 remove_diacritics 2');
  `);
  const insDoc = db.prepare('INSERT INTO docs(rowid, kind, sub, ref, app, title, date, meta) VALUES (?,?,?,?,?,?,?,?)');
  const insFts = db.prepare('INSERT INTO fts(rowid, title, body, alt) VALUES (?,?,?,?)');
  const insMap = db.prepare('INSERT INTO doc_papers(rowid, paper_id) VALUES (?,?)');
  let rowid = 0;
  const add = (kind, sub, ref, app, title, date, body, paperIds, meta = null) => {
    rowid++;
    insDoc.run(rowid, kind, sub, ref, app || null, title || '', date || '', meta ? JSON.stringify(meta) : null);
    insFts.run(rowid, title || '', body || '', altSpellings(`${title || ''}\n${body || ''}`));
    for (const pid of paperIds || []) insMap.run(rowid, pid);
  };
  db.exec('BEGIN');
  for (const p of store.papers) {
    const body = [p.authors.join(', '), p.venue, p.year, p.keywords.join(', '), p.doi, p.arxiv, p.abstract].filter(Boolean).join('\n');
    add('paper', 'paper', p.id, null, p.title, p.opened || p.added, body, [p.id]);
  }
  for (const [pid, h] of store.highlights) {
    for (const x of h.highlights) add('highlight', 'highlight', x.id, null, '', x.created, [x.text, x.note].filter(Boolean).join('\n'), [pid], { page: x.page, color: x.color, note: x.note });
  }
  for (const d of store.decks) add('deck', 'deck', d.id, null, d.title, d.updated, d.text, d.paperId ? [d.paperId] : [], { slides: d.slides });
  for (const n of store.notes) add('note', n.kind, n.id, null, n.title, n.updated, n.body, n.kind === 'review' ? [] : n.paperIds);
  for (const c of store.marlin) add('chat', 'marlin', c.id, 'marlin', c.title, c.updated, chatBody(c), c.paperId ? [c.paperId] : [], { why: c.why });
  for (const c of store.chats) {
    const pids = c.links.length <= GROUP_MAX_PAPERS ? c.links.map((l) => l.paperId) : [];
    add('chat', c.app, c.id, c.app, c.title, c.updated, chatBody(c), pids, { links: c.links.length });
  }
  for (const m of store.manual) add('chat', m.app, m.url, m.app, m.title || m.url, m.at, [m.url, m.note].filter(Boolean).join('\n'), [m.paperId]);
  db.exec('COMMIT');
  db.close();
  return rowid;
}

export async function build(log = console.log) {
  if (store.building) return store.building;
  store.building = (async () => {
    const t0 = Date.now();
    const papers = loadPapers();
    const ids = new Set(papers.map((p) => p.id));
    const chats = await loadChats(papers, log);
    store.papers = papers;
    store.paperById = new Map(papers.map((p) => [p.id, p]));
    store.programs = loadPrograms();
    store.highlights = loadHighlights(papers);
    store.marlin = loadMarlinChats(ids);
    store.decks = loadDecks(ids);
    store.notes = loadNotes(papers);
    store.chats = chats;
    store.manual = loadManualLinks();
    store.sittings = loadSittings();
    const tmp = DB_FILE + '.next';
    const rows = writeIndex(tmp);
    if (store.db) { try { store.db.close(); } catch {  } }
    fs.renameSync(tmp, DB_FILE);
    store.db = new DatabaseSync(DB_FILE, { readOnly: true });
    prepareStatements();
    computeTouch();
    store.builtAt = Date.now();
    store.ready = true;
    const linked = chats.filter((c) => c.links.length);
    store.stats = {
      papers: papers.length,
      highlights: [...store.highlights.values()].reduce((a, h) => a + h.highlights.length, 0),
      decks: store.decks.length,
      notes: store.notes.length,
      conversations: chats.length + store.marlin.length + store.manual.length,
      chats: { 'claude-code': 0, codex: 0, science: 0, ...Object.fromEntries(['claude-code', 'codex', 'science'].map((a) => [a, chats.filter((c) => c.app === a).length])) },
      chatsLinked: linked.length,
      linksByRule: linked.flatMap((c) => c.links).reduce((a, l) => ({ ...a, [l.rule]: (a[l.rule] || 0) + 1 }), {}),
      rows,
      ms: Date.now() - t0,
    };
    log && log(`index: ${rows} rows in ${store.stats.ms} ms`);
    return store.stats;
  })();
  try { return await store.building; } finally { store.building = null; }
}

let S = {};
function prepareStatements() {
  const db = store.db;
  S = {
    match: db.prepare(`SELECT d.rowid AS rowid, d.kind, d.sub, d.ref, d.app, d.title, d.date, d.meta,
        bm25(fts, 8.0, 1.0, 4.0) AS score, snippet(fts, 1, '', '', '…', 16) AS snip,
        highlight(fts, 0, '\uE000', '\uE001') AS tsnip
      FROM fts JOIN docs d ON d.rowid = fts.rowid WHERE fts MATCH ? ORDER BY score LIMIT 600`),
    papersOf: db.prepare('SELECT paper_id FROM doc_papers WHERE rowid = ?'),
  };
}

function computeTouch() {
  const touch = new Map();
  const bump = (pid, t) => { const ms = toMs(t); if (pid && ms > (touch.get(pid) || 0)) touch.set(pid, ms); };
  for (const p of store.papers) { bump(p.id, p.opened); bump(p.id, p.added); }
  for (const [pid, h] of store.highlights) for (const x of h.highlights) bump(pid, x.created);
  for (const d of store.decks) bump(d.paperId, d.updated);
  for (const n of store.notes) if (n.kind !== 'review') for (const pid of n.paperIds) bump(pid, n.updated);
  for (const c of store.marlin) bump(c.paperId, c.updated);
  for (const c of store.chats) for (const l of c.links) bump(l.paperId, c.updated);
  for (const s of store.sittings) bump(s.paperId, s.ts);
  for (const m of store.manual) bump(m.paperId, m.at);
  store.touch = touch;
}

export function countsFor(pid) {
  const c = { highlights: 0, 'claude-code': 0, codex: 0, science: 0, marlin: 0, web: 0, decks: 0, notes: 0 };
  const h = store.highlights.get(pid);
  if (h) c.highlights = h.highlights.length;
  for (const x of store.chats) if (x.links.some((l) => l.paperId === pid)) c[x.app]++;
  for (const x of store.marlin) if (x.paperId === pid) c.marlin++;
  for (const x of store.manual) if (x.paperId === pid) c.web++;
  for (const d of store.decks) if (d.paperId === pid) c.decks++;
  for (const n of store.notes) if (n.paperIds.includes(pid)) c.notes++;
  return c;
}

export function paperCard(p) {
  return {
    id: p.id, title: p.title, authors: p.authors, year: p.year, venue: p.venue, confidence: p.confidence, status: p.status,
    touched: store.touch.get(p.id) || 0, counts: countsFor(p.id),
  };
}

const words = (s) => String(s).normalize('NFKC').toLowerCase().replace(/['’]/g, '').match(/[\p{L}\p{N}]+/gu) || [];

const stemDb = new DatabaseSync(':memory:');
stemDb.exec("CREATE VIRTUAL TABLE t USING fts5(x, tokenize='porter unicode61 remove_diacritics 2'); CREATE VIRTUAL TABLE v USING fts5vocab(t, 'row');");
const stemDel = stemDb.prepare('DELETE FROM t'), stemIns = stemDb.prepare('INSERT INTO t(x) VALUES (?)'), stemGet = stemDb.prepare('SELECT term FROM v');
function stem(word) { stemDel.run(); stemIns.run(word); const r = stemGet.get(); return r ? r.term : word; }

function ftsQuery(q) {
  const raw = String(q);
  const parts = [];
  for (const m of raw.matchAll(/"([^"]+)"/g)) { const w = words(m[1]); if (w.length) parts.push(`"${w.join(' ')}"`); }
  const rest = raw.replace(/"[^"]*"/g, ' ').replace(/"/g, ' ');
  const toks = words(rest).slice(0, 12);
  const typing = toks.length && !/\s$/.test(raw) && !/"\s*$/.test(raw);
  toks.forEach((t, i) => {
    if (i < toks.length - 1 || !typing) { parts.push(`"${t}"`); return; }
    const alts = new Set([`"${t}"`]);
    for (let k = 0; k <= 2 && t.length - k >= (k ? 5 : 1); k++) {
      const w = k ? t.slice(0, -k) : t;
      if (stem(w) === w) alts.add(`"${w}"*`);
      else if (k) alts.add(`"${w}"`);
    }
    parts.push(alts.size > 1 ? `(${[...alts].join(' OR ')})` : [...alts][0]);
  });
  return parts.join(' AND ');
}

const TYPE_KINDS = { all: null, papers: ['paper'], highlights: ['highlight'], chats: ['chat'], decks: ['deck'], notes: ['note'] };
const KIND_WEIGHT = { paper: 1.6, highlight: 1.0, note: 0.9, deck: 0.9, chat: 0.7 };

function matchView(r, pid) {
  const meta = r.meta ? JSON.parse(r.meta) : {};
  const v = { kind: r.kind, sub: r.sub, app: r.app, ref: r.ref, title: r.title, date: r.date, snippet: r.snip || r.tsnip || '' };
  if (r.kind === 'paper') v.snippet = //.test(r.tsnip) && !//.test(r.snip) ? '' : r.snip;
  if (r.kind === 'highlight') { v.page = meta.page; v.color = meta.color; }
  if (r.kind === 'chat') {
    v.appLabel = APP_LABEL[r.app] || r.app;
    let why = null;
    if (r.sub === 'marlin') why = meta.why;
    else if (pid) {
      const c = store.chats.find((x) => x.id === r.ref && x.app === r.sub);
      const l = c && c.links.find((x) => x.paperId === pid);
      if (l) why = l;
      if (!c) { const m = store.manual.find((x) => x.url === r.ref); if (m) why = { rule: 'manual', match: 'linked by hand' }; }
    }
    v.why = why ? describeWhy(why) : '';
    if (!pid && meta.links) v.linkedTo = meta.links;
  }
  if (r.kind === 'deck') v.slides = meta.slides;
  return v;
}

export function search(q, type = 'all', sort = 'relevance') {
  if (!store.ready) return { ready: false, papers: [], standalone: [] };
  const fq = ftsQuery(q);
  const kinds = TYPE_KINDS[type] || null;
  const groups = new Map();
  const standalone = [];
  const doiQ = (String(q).match(/10\.\d{4,9}\/\S+/) || [])[0];
  if (doiQ) {
    const doi = normDoi(doiQ);
    const p = store.papers.find((x) => x.doi === doi);
    if (p && (!kinds || kinds.includes('paper'))) groups.set(p.id, { score: -1e6, matches: [{ kind: 'paper', sub: 'doi', title: p.title, snippet: `DOI ${p.doi}` }] });
  }
  let rows = [];
  if (fq) { try { rows = S.match.all(fq); } catch { rows = []; } }
  for (const r of rows) {
    if (kinds && !kinds.includes(r.kind)) continue;
    const score = r.score * (KIND_WEIGHT[r.kind] || 1);
    const pids = S.papersOf.all(r.rowid).map((x) => x.paper_id).filter((id) => store.paperById.has(id));
    if (!pids.length) { standalone.push({ score, match: matchView(r, null) }); continue; }
    for (const pid of pids) {
      let g = groups.get(pid);
      if (!g) { g = { score: 0, matches: [] }; groups.set(pid, g); }
      g.score += g.matches.length ? score * 0.15 : score;
      if (r.kind === 'paper' && /\uE000/.test(r.tsnip || '')) g.titleSnippet = r.tsnip;
      if (r.kind === 'paper' && g.matches.some((m) => m.sub === 'doi')) continue;
      if (g.matches.length < 6) g.matches.push(matchView(r, pid));
    }
  }
  let papers = [...groups].map(([pid, g]) => ({ ...paperCard(store.paperById.get(pid)), score: g.score, matches: g.matches, titleSnippet: g.titleSnippet || '' }));
  if (sort === 'recent') papers.sort((a, b) => b.touched - a.touched);
  else if (sort === 'year') papers.sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0) || a.score - b.score);
  else papers.sort((a, b) => a.score - b.score);
  standalone.sort((a, b) => a.score - b.score);
  return { ready: true, q, total: papers.length, papers: papers.slice(0, 60), standalone: standalone.slice(0, 20).map((s) => s.match) };
}

export function paperDetail(id) {
  const p = store.paperById.get(id);
  if (!p) return null;
  const h = store.highlights.get(id);
  const conv = [];
  for (const c of store.marlin) if (c.paperId === id) conv.push({ app: 'marlin', id: c.id, title: c.title, updated: c.updated, turns: c.turns, why: describeWhy(c.why) });
  for (const c of store.chats) {
    const l = c.links.find((x) => x.paperId === id);
    if (!l) continue;
    conv.push({ app: c.app, id: c.id, title: c.title, project: c.project, updated: c.updated, prompts: c.prompts, why: describeWhy(l), whyFrom: l.from, resume: c.resume || null, otherPapers: c.links.length - 1 });
  }
  for (const m of store.manual) if (m.paperId === id) conv.push({ app: m.app, id: m.url, url: m.url, title: m.title || m.url, note: m.note || '', manual: true, updated: m.at, why: 'linked by hand' });
  conv.sort((a, b) => toMs(b.updated) - toMs(a.updated));
  const notes = store.notes.filter((n) => n.paperIds.includes(id)).map((n) => ({
    id: n.id, kind: n.kind, label: n.label, title: n.title, updated: n.updated, status: n.status,
    body: n.kind === 'review' ? reviewExcerpt(n, id) : n.body,
    sourcePath: n.file ? path.relative(LF, n.file).split(path.sep).join('/') : '',
    why: n.kind === 'review' ? describeWhy(n.citeWhy[id]) : '',
  }));
  return {
    paper: { ...p, pdfPath: undefined, hasPdf: !!p.pdfPath, pdfName: p.pdfPath ? path.basename(p.pdfPath) : '', abstract: p.abstract },
    counts: countsFor(id),
    touched: store.touch.get(id) || 0,
    highlights: h ? h.highlights : [],
    conversations: conv,
    decks: store.decks.filter((d) => d.paperId === id).map((d) => ({ id: d.id, title: d.title, slides: d.slides, updated: d.updated })),
    notes,
    sittings: store.sittings.filter((s) => s.paperId === id).reduce((a, s) => a + s.minutes, 0),
  };
}

function reviewExcerpt(n, id) {
  const p = store.paperById.get(id);
  const body = n.body.split(/^#{1,3}\s+(References|Bibliography)\b/im)[0];
  const last = String((p.authors[0] || '').split(/\s+/).pop() || '');
  const paras = body.split(/\n{2,}/).filter((x) => !/^\s*(#|\||- \[)/.test(x));
  const named = last && p.year ? paras.filter((x) => x.includes(last) && x.includes(String(p.year))) : [];
  if (named.length) return named.slice(0, 2).join('\n\n');
  const needles = [id, p.doi].filter(Boolean).map((s) => s.toLowerCase());

  const lines = n.body.split('\n').filter((l) => needles.some((x) => l.toLowerCase().includes(x)))
    .map((l) => (/^\s*\|/.test(l) ? l.replace(/^\s*\||\|\s*$/g, '').split('|').map((c) => c.trim()).filter(Boolean).join(' · ') : l));
  return lines.slice(0, 2).join('\n\n');
}

export function topicsForInbox() {
  const counts = new Map();
  for (const p of store.papers) for (const pr of p.programs) counts.set('program:' + pr, (counts.get('program:' + pr) || 0) + 1);
  const programs = store.programs
    .map((pr) => ({ id: 'program:' + pr.id, label: pr.title.replace(/'/g, '’'), n: counts.get('program:' + pr.id) || 0 }))
    .sort((a, b) => b.n - a.n);

  const broad = new Set(['computer science', 'psychology', 'engineering', 'business', 'economics', 'sociology', 'political science', 'data science', 'mathematics', 'medicine', 'philosophy', 'biology', 'physics', 'art', 'law', 'geography', 'history']);
  const kw = new Map();
  for (const p of store.papers) for (const k of p.keywords) {
    const l = String(k).toLowerCase().trim();
    if (!l || l.includes('(') || broad.has(l)) continue;
    kw.set(l, (kw.get(l) || 0) + 1);
  }
  const keywords = [...kw].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ id: 'kw:' + k, label: k, n }));
  return [...programs.filter((p) => p.n > 0), ...keywords].slice(0, 12);
}
