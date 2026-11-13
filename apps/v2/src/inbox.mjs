import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { effectivePaths, readConfig } from './settings.mjs';
import { HOME, DATA, ensureDir, readJSON, writeJSON, readJSONL, appendJSONL, listDir, stat, sha1, sha256File,
  normDoi, normTitle, jaccard, surname, normName, pool, trimText } from './util.mjs';

const CACHE = path.join(DATA, 'inbox.json');
const DECISIONS = path.join(DATA, 'inbox-decisions.jsonl');
const META_DIR = ensureDir(path.join(DATA, 'meta-cache'));
const UA = 'LancetfishV2/0.1';

export function sourceDirs() {
  const extra = (Array.isArray(readConfig().scanFolders) ? readConfig().scanFolders : []).filter((d) => typeof d === 'string' && d.trim())
    .map((d) => path.resolve(d.trim().replace(/^~(?=\/|$)/, HOME)));
  return [...new Set([...extra, effectivePaths().inboxDir].filter(Boolean))];
}

const NOT_PAPER_WORDS = new Set(['syllabus', 'assignment', 'assignments', 'answer', 'answers', 'form', 'forms', 'receipt',
  'invoice', 'ticket', 'resume', 'cv', 'schedule', 'handout', 'quiz', 'exam', 'exams', 'midterm', 'homework', 'hw',
  'lecture', 'lectures', 'slides', 'transcript',

  ...(Array.isArray(readConfig().notPaperWords) ? readConfig().notPaperWords.map((w) => String(w).toLowerCase()) : [])]);
const nameWords = (name) => name.replace(/\.pdf$/i, '').toLowerCase().split(/[^\p{L}\p{N}]+|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u).filter(Boolean);

const AUTHOR_YEAR = /^\p{L}[\p{L}'’]+(?:(?: |_|-)?(?:et ?al\.?|and \p{L}+|& ?\p{L}+))?[ _-]\(?(?:19|20)\d{2}\)?[a-z]?(?:[ _.-]|$)/iu;
const NOT_PAPER_TEXT = /\b(call for papers|system card)\b/i;

const CODE_VERSION = sha1(fs.readFileSync(new URL(import.meta.url), 'utf8'));
let cache = readJSON(CACHE, { files: {} });
if (cache.version !== CODE_VERSION) {

  const keepAi = new Map(Object.values(cache.files || {}).filter((e) => e.ai && e.triage).map((e) => [e.triage.sha256, e.ai]));
  cache = { version: CODE_VERSION, files: {}, keepAi: Object.fromEntries(keepAi) };
}
let scanning = null;
const progress = { phase: 'idle', done: 0, total: 0 };
const saveCache = () => writeJSON(CACHE, cache);

function ownName(text) {
  const name = String(readConfig().ownerName || '').trim();
  return name.length > 1 && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
}

function run(cmd, args, timeout = 20000) {
  return new Promise((resolve) => execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, out) => resolve(err ? '' : String(out))));
}

export function listCandidates() {
  const out = [];
  for (const dir of sourceDirs()) {
    for (const f of listDir(dir)) {
      if (!f.toLowerCase().endsWith('.pdf') || f.startsWith('.')) continue;
      const p = path.join(dir, f);
      const st = stat(p);
      if (st && st.isFile()) out.push({ path: p, name: f, dir: path.basename(dir), size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

function findDoi(text) {
  const m = text.match(/\b10\.\d{4,9}\/[-._;()/:A-Za-z0-9<>]+/);
  if (!m) return '';
  return normDoi(m[0].replace(/[<>].*$/, ''));
}

function findArxiv(text, name) {
  const fm = name.match(/^(\d{4}\.\d{4,5})(v\d+)?\.pdf$/i);
  if (fm) return fm[1];
  const tm = text.match(/arXiv:\s?(\d{4}\.\d{4,5})(v\d+)?/i);
  return tm ? tm[1] : '';
}

function findSsrn(text, name = '') {
  const n = name.match(/^ssrn[-_](\d{5,9})/i);
  if (n) return n[1];
  const m = text.match(/ssrn\.com\/abstract=(\d{5,9})/i) || text.match(/abstract_id=(\d{5,9})/i) || text.match(/\bSSRN\b[^0-9]{0,20}(\d{6,9})/);
  return m ? m[1] : '';
}

const SUPPLEMENT_NAME = /[._-](sm\d+|supp(lement(ary)?)?|si|appendix)\b/i;
export function doiFromName(name) {
  const stem = name.replace(/\.pdf$/i, '').replace(/ \(\d+\)$/, '');
  let m = stem.match(/^(isre|mnsc|orsc|mksc|opre|msom|ijoc|stsc|deca|ijds|serv|inte|trsc|moor)\.(\d{4})\.(\d{4,5})/i);
  if (m) return `10.1287/${m[1].toLowerCase()}.${m[2]}.${m[3]}`;
  m = stem.match(/^(\d{7})\.(\d{7})$/);
  if (m) return `10.1145/${m[1]}.${m[2]}`;
  m = stem.match(/^(d41586-0\d\d-\d{5}-\d)$/i);
  if (m) return `10.1038/${m[1].toLowerCase()}`;
  return '';
}

async function titleFromLayout(file) {
  const html = await run('pdftotext', ['-f', '1', '-l', '1', '-bbox-layout', file, '-']);
  if (!html) return '';
  const pageH = Number((html.match(/<page width="[\d.]+" height="([\d.]+)"/) || [])[1]) || 800;
  const lines = [];
  for (const lm of html.matchAll(/<line xMin="[\d.]+" yMin="([\d.]+)" xMax="[\d.]+" yMax="([\d.]+)">([\s\S]*?)<\/line>/g)) {
    const words = [...lm[3].matchAll(/<word[^>]*>([^<]*)<\/word>/g)].map((w) => w[1]);
    const text = words.join(' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, '’').trim();
    lines.push({ y: Number(lm[1]), h: Number(lm[2]) - Number(lm[1]), text, words: words.length });
  }
  const cands = lines.filter((l) => l.y < pageH * 0.6 && l.text.length >= 4 && /[a-z]/i.test(l.text) && !/^(arxiv|doi|http|www\.|vol\.|journal|proceedings|received|accepted|copyright|©)/i.test(l.text));
  if (!cands.length) return '';
  const maxH = Math.max(...cands.map((l) => l.h));
  const idx = lines.findIndex((l) => cands.includes(l) && l.h >= maxH * 0.92);
  const parts = [];
  for (let i = idx; i < lines.length && parts.length < 4; i++) {
    if (lines[i].h < maxH * 0.85) break;
    parts.push(lines[i].text);
  }
  const t = parts.join(' ').replace(/\s+/g, ' ').trim();
  return t.length >= 10 && t.length <= 300 ? t : '';
}

const MONTH = '(january|february|march|april|may|june|july|august|september|october|november|december)';
function looksLikeTitle(t) {
  if (!t) return false;
  if (new RegExp(`^${MONTH}\\b`, 'i').test(t) || /^\d{1,2}\s+\p{L}+\s+\d{4}/u.test(t)) return false;
  if (/downloaded from|electronic copy available|creationdate|all rights reserved/i.test(t)) return false;
  if ((t.match(/,/g) || []).length >= 3 && /\b(19|20)\d{2}\b/.test(t)) return false;
  return true;
}

function usablePdfTitle(t, name) {
  if (!t) return '';
  const s = t.trim().replace(/&apos;|&#39;/g, '’').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
  if (s.length < 12 || s.length > 300) return '';
  if (/^(microsoft word|untitled|document|slide|powerpoint|title|paper|manuscript|main|template)\b/i.test(s)) return '';
  if (/\.(docx?|pdf|tex|indd)$/i.test(s)) return '';
  if (s.replace(/\.pdf$/i, '') === name.replace(/\.pdf$/i, '')) return '';
  if (!/\s/.test(s)) return '';
  return looksLikeTitle(s) ? s : '';
}

async function triage(c) {
  const sha256 = await sha256File(c.path);
  const info = await run('pdfinfo', [c.path], 10000);
  const pages = Number((info.match(/^Pages:\s+(\d+)/m) || [])[1]) || 0;
  const pdfTitle = ((info.match(/^Title:\s+(.*)$/m) || [])[1] || '').trim();
  const size = info.match(/^Page size:\s+([\d.]+) x ([\d.]+)/m);
  const landscape = size ? Number(size[1]) > Number(size[2]) * 1.15 : false;
  const text = (await run('pdftotext', ['-l', '2', '-enc', 'UTF-8', c.path, '-'])).slice(0, 14000);
  const creator = ((info.match(/^Creator:\s+(.*)$/m) || [])[1] || '').trim();
  const nameDoi = doiFromName(c.name);
  const doi = nameDoi || findDoi(text);
  const arxiv = findArxiv(text, c.name);
  const ssrn = findSsrn(text, c.name);
  const hasAbstract = /\babstract\b/i.test(text.slice(0, 6000));
  const authorYear = AUTHOR_YEAR.test(c.name);

  const reasons = [];
  if (!authorYear && nameWords(c.name).some((w) => NOT_PAPER_WORDS.has(w))) reasons.push('file name');
  if (pages && pages < 6 && !hasAbstract && !authorYear) reasons.push(`${pages} page${pages === 1 ? '' : 's'}`);
  if (landscape) reasons.push('slide-shaped pages');
  if (NOT_PAPER_TEXT.test(`${pdfTitle} ${text.slice(0, 400)}`)) reasons.push((text.slice(0, 400) + pdfTitle).match(NOT_PAPER_TEXT)[1].toLowerCase());
  const noText = !text.trim();
  if (noText && (landscape || pages < 8)) reasons.push('no text layer');
  const likelyNotPaper = reasons.length > 0 && !doi && !arxiv && !ssrn;
  const layoutTitle = likelyNotPaper || noText ? '' : await titleFromLayout(c.path);
  return {
    sha256, pages, pdfTitle, creator, doi, nameDoi, arxiv, ssrn, hasAbstract, authorYear,
    titleGuess: usablePdfTitle(pdfTitle, c.name) || (looksLikeTitle(layoutTitle) ? layoutTitle : ''),
    text: text.slice(0, 9000),
    likelyNotPaper,
    reasons,
    landscape, noText,
    supplementName: SUPPLEMENT_NAME.test(c.name.replace(/\.pdf$/i, '')),

    slideLines: landscape ? text.split('\f')[0].split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4) : [],
    mine: /chromium|skia/i.test(creator) || ownName(c.name) || ownName(text.split('\f')[0].slice(0, 600)),
  };
}

async function cachedFetch(url, accept = 'application/json', keyParam = '') {
  const file = path.join(META_DIR, sha1(url + '|' + accept) + '.json');
  const hit = readJSON(file);
  if (hit) return hit;
  let last = { status: 0 };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
    let res;
    try {
      res = await fetch(url + keyParam, { headers: { 'User-Agent': UA, Accept: accept }, signal: AbortSignal.timeout(20000) });
    } catch (e) { last = { status: 0, error: String(e.message || e) }; continue; }
    const body = await res.text();
    last = { status: res.status, url, at: new Date().toISOString(), body: res.ok ? body : body.slice(0, 500) };
    if (res.ok || res.status === 404) { writeJSON(file, last); return last; }
    if (res.status !== 429 && res.status < 500) return last;
  }
  return last;
}

class Retry extends Error {}
const check = (r) => { if (r.status === 0 || r.status === 429 || r.status >= 500) throw new Retry(r.error || `HTTP ${r.status}`); return r; };

function openalexKey() {
  const file = String(readConfig().openalexKeyFile || '').trim().replace(/^~(?=\/|$)/, HOME);
  if (!file) return '';
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

function fromCrossref(w, how, score = null) {
  if (!w) return null;
  const year = ((w['published-print'] || w['published-online'] || w.issued || {})['date-parts'] || [[null]])[0][0];
  return {
    source: 'crossref', how,
    title: (w.title || [])[0] || '',
    authors: (w.author || []).map((a) => [a.given, a.family].filter(Boolean).join(' ') || a.name || '').filter(Boolean),
    year: year || null,
    venue: (w['container-title'] || [])[0] || (w.type === 'posted-content' ? 'Preprint' : ''),
    doi: normDoi(w.DOI || ''),
    type: w.type || '',
    score,
  };
}

function parseArxiv(xml, id) {
  const entry = (xml.match(/<entry>([\s\S]*?)<\/entry>/) || [])[1];
  if (!entry) return null;
  const tag = (t) => ((entry.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || '').replace(/\s+/g, ' ').trim();
  const title = tag('title');
  if (!title || /^Error$/i.test(title)) return null;
  const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => m[1].trim());
  const journal = tag('arxiv:journal_ref');
  const doi = tag('arxiv:doi');
  return { source: 'arxiv', how: 'arXiv id', title, authors, year: Number(tag('published').slice(0, 4)) || null, venue: journal || 'arXiv', doi: normDoi(doi), arxiv: id, type: 'preprint' };
}

async function crossrefDoi(doi, how) {
  const r = check(await cachedFetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`));
  if (r.status !== 200) return null;
  try { return fromCrossref(JSON.parse(r.body).message, how); } catch { return null; }
}

async function identify(t) {
  if (t.doi) { const m = await crossrefDoi(t.doi, t.nameDoi ? 'DOI in the file name' : 'DOI'); if (m) return m; }
  if (t.ssrn) { const m = await crossrefDoi(`10.2139/ssrn.${t.ssrn}`, 'SSRN id'); if (m) return m; }
  if (t.arxiv) {
    const r = check(await cachedFetch(`https://export.arxiv.org/api/query?id_list=${t.arxiv}`, 'application/atom+xml'));
    if (r.status === 200) { const m = parseArxiv(r.body, t.arxiv); if (m) return m; }
  }
  if (!t.titleGuess) return null;
  const guess = t.titleGuess.slice(0, 250);
  let best = null;
  const url = `https://api.crossref.org/works?rows=1&query.bibliographic=${encodeURIComponent(guess)}&select=DOI,title,author,issued,published-print,published-online,container-title,type,score`;
  const r = check(await cachedFetch(url));
  if (r.status === 200) {
    try {
      const item = JSON.parse(r.body).message.items[0];
      if (item) best = fromCrossref(item, 'title search', item.score);
    } catch {  }
  }

  if (!best || jaccard(guess, best.title) < 0.6) {
    const key = openalexKey();
    const q = guess.replace(/[,:;|()]/g, ' ');
    const oa = check(await cachedFetch(`https://api.openalex.org/works?per-page=1&filter=title.search:${encodeURIComponent(q)}&select=doi,title,publication_year,authorships,primary_location`, 'application/json', key ? `&api_key=${encodeURIComponent(key)}` : ''));
    if (oa.status === 200) {
      try {
        const w = JSON.parse(oa.body).results[0];
        if (w && jaccard(guess, w.title) >= 0.6) {
          const doi = normDoi(w.doi || '');
          best = (doi && await crossrefDoi(doi, 'title search')) || {
            source: 'openalex', how: 'title search', title: w.title || '',
            authors: (w.authorships || []).map((a) => a.author && a.author.display_name).filter(Boolean),
            year: w.publication_year || null, venue: (w.primary_location && w.primary_location.source && w.primary_location.source.display_name) || '', doi,
          };
        }
      } catch {  }
    }
  }
  if (best) { best.titleGuess = guess; best.titleSimilarity = Math.round(jaccard(guess, best.title) * 100) / 100; }
  return best;
}

const AI_PROMPT = `You identify academic documents from their first pages. Reply with strict JSON only, no prose, no code fence:
{"title": string, "authors": [string], "year": number or null, "venue": string, "kind": "journal" | "conference" | "preprint" | "working paper" | "book chapter" | "thesis" | "not a paper", "confidence": number from 0 to 1}
Use only what the text shows. Authors in reading order, full names as printed. If it is a syllabus, form, slide deck, assignment, letter or anything that is not a research paper, use kind "not a paper".

First pages:
`;

function claudeJSON(prompt) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    const child = spawn('claude', ['-p', '--model', 'haiku', '--output-format', 'json', '--no-session-persistence', '--tools', ''], {
      env, cwd: ensureDir(path.join(DATA, 'claude-cwd')), stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('claude timed out')); }, 120000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const env = JSON.parse(out);
        if (env.is_error) return reject(new Error(String(env.result || 'claude error').slice(0, 200)));
        const m = String(env.result || '').match(/\{[\s\S]*\}/);
        if (!m) return reject(new Error('no JSON in reply'));
        resolve(JSON.parse(m[0]));
      } catch (e) { reject(new Error(`claude exit ${code}: ${(err || out).slice(0, 200)}`)); }
    });
    child.stdin.end(prompt);
  });
}

let aiRunning = 0;
const aiQueue = [];
function aiSlot(fn) {
  return new Promise((resolve, reject) => {
    const go = async () => {
      aiRunning++;
      try { resolve(await fn()); } catch (e) { reject(e); } finally { aiRunning--; const n = aiQueue.shift(); if (n) n(); }
    };
    if (aiRunning < 2) go(); else aiQueue.push(go);
  });
}

export async function aiRead(p) {
  const entry = cache.files[p];
  if (!entry || !entry.triage) throw new Error('Scan the inbox first');
  if (!entry.triage.text.trim()) throw new Error('This PDF has no text layer');
  entry.aiPending = true;
  try {
    const r = await aiSlot(() => claudeJSON(AI_PROMPT + entry.triage.text.slice(0, 7000)));
    entry.ai = {
      source: 'ai', how: 'Claude Haiku read the first pages',
      title: trimText(r.title || '', 300),
      authors: Array.isArray(r.authors) ? r.authors.map(String).slice(0, 30) : [],
      year: Number(r.year) || null,
      venue: String(r.venue || ''),
      kind: String(r.kind || ''),
      confidence: Number(r.confidence) || 0,
      at: new Date().toISOString(),
    };
    delete entry.aiError;
  } catch (e) {
    entry.aiError = String(e.message || e);
  } finally {
    delete entry.aiPending;
    saveCache();
  }
  return card(p, entry);
}

export async function aiReadNext(n = 5) {
  const view = inboxView();
  const picks = view.cards.filter((c) => c.group === 'identify' && !c.ai && !c.aiPending).slice(0, n);
  for (const c of picks) cache.files[c.path].aiPending = true;
  Promise.all(picks.map((c) => aiRead(c.path).catch(() => null)));
  return { started: picks.map((c) => c.path) };
}

export function scan(librarySha) {
  if (scanning) return scanning;
  scanning = (async () => {
    const cands = listCandidates();
    const next = {};
    progress.phase = 'triage'; progress.done = 0; progress.total = cands.length;
    await pool(cands, 4, async (c) => {
      const old = cache.files[c.path];
      const entry = old && old.size === c.size && old.mtimeMs === c.mtimeMs ? old : { ...c };
      Object.assign(entry, { name: c.name, dir: c.dir, size: c.size, mtimeMs: c.mtimeMs });
      if (!entry.triage) { try { entry.triage = await triage(c); } catch (e) { entry.triage = null; entry.error = String(e.message || e); } }
      if (entry.triage && !entry.ai && cache.keepAi && cache.keepAi[entry.triage.sha256]) entry.ai = cache.keepAi[entry.triage.sha256];
      next[c.path] = entry;
      progress.done++;
    });
    cache.files = next;
    cache.version = CODE_VERSION;
    saveCache();
    const todo = Object.values(next).filter((e) => e.triage && !librarySha.has(e.triage.sha256) && !e.triage.likelyNotPaper && e.det === undefined && !libraryRelation(e.triage, e.name));
    progress.phase = 'identify'; progress.done = 0; progress.total = todo.length;
    await pool(todo, 2, async (e) => {
      try { e.det = await identify(e.triage); delete e.detError; } catch (err) { e.det = undefined; e.detError = String(err.message || err); }
      progress.done++;
      if (progress.done % 10 === 0) saveCache();
    });
    saveCache();
    progress.phase = 'idle';
    return { files: Object.keys(next).length };
  })();
  return scanning.finally(() => { scanning = null; });
}

export const scanState = () => ({ ...progress, scanning: !!scanning });

let LIB = { sha: new Set(), papers: [], byDoi: new Map(), titled: [] };
export function setLibrary(papers) {
  const venues = new Set(papers.map((p) => normTitle(p.venue)).filter(Boolean));
  const list = papers.map((p) => ({ id: p.id, title: p.title, year: p.year, authors: p.authors, doi: p.doi, nt: normTitle(p.title), confidence: p.confidence }));
  LIB = {
    sha: new Set(papers.map((p) => p.sha256).filter(Boolean)),
    papers: list,
    byDoi: new Map(list.filter((p) => p.doi).map((p) => [p.doi, p])),

    titled: list.filter((p) => p.nt.length >= 25 && p.confidence !== 'guessed' && !venues.has(p.nt)).sort((a, b) => b.nt.length - a.nt.length),
  };
}

const foldAI = (s) => normTitle(String(s).replace(/\([^)]*\)/g, ' ')).replace(/\bartificial intelligence\b/g, 'ai');
function tokenSim(a, b) {
  const A = new Set(a.split(' ').filter(Boolean)), B = new Set(b.split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let n = 0; for (const x of A) if (B.has(x)) n++;
  return n / (A.size + B.size - n);
}
function slideTitleMatch(lines) {
  if (!lines || !lines.length) return null;
  const cands = [1, 2, 3, 4].filter((k) => k <= lines.length).map((k) => foldAI(lines.slice(0, k).join(' '))).filter((c) => c.length >= 12);
  let best = null, top = 0;
  for (const lp of LIB.titled) {
    const full = foldAI(lp.title), main = foldAI(lp.title.split(/[:?]\s/)[0]);
    for (const c of cands) for (const t of [full, main]) { const sim = tokenSim(c, t); if (sim > top) { top = sim; best = lp; } }
  }
  return top >= 0.8 ? best : null;
}

function libraryRelation(t, name = '') {
  if (!t) return null;
  let paper = (t.nameDoi && LIB.byDoi.get(t.nameDoi)) || (t.doi && LIB.byDoi.get(t.doi)) || null;
  if (!paper) {
    const top = normTitle(String(t.text || '').split('\f')[0].slice(0, 2000));
    paper = LIB.titled.find((lp) => top.includes(lp.nt)) || null;
  }
  if (!paper && t.landscape) paper = slideTitleMatch(t.slideLines);
  if (!paper) return null;
  const ref = { id: paper.id, title: paper.title, year: paper.year };
  if (t.landscape) return { kind: 'deck', mine: !!t.mine || /chromium|skia/i.test(t.creator || ''), paper: ref };
  if (/^review[-_ ]/i.test(name) || (t.pages <= 6 && /\b(referee report|reviewer report|report on the manuscript)\b/i.test(String(t.text).slice(0, 3000)))) return { kind: 'review', paper: ref };
  if (t.supplementName || /\b(online appendix|supplementary (material|information|appendix)|supplemental material)\b/i.test(String(t.text).slice(0, 1500))) return { kind: 'supplement', paper: ref };
  return { kind: 'version', paper: ref };
}

export function agree(a, b) {
  if (!a || !b || !a.title || !b.title) return false;
  const j = jaccard(a.title, b.title);
  const sa = normName(surname((a.authors || [])[0])), sb = normName(surname((b.authors || [])[0]));
  const yearOk = !a.year || !b.year || Math.abs(Number(a.year) - Number(b.year)) <= 1;
  return j >= 0.85 && !!sa && sa === sb && yearOk;
}

function diffFields(a, b) {
  const d = [];
  if (jaccard(a.title, b.title) < 0.85) d.push('title');
  if (normName(surname((a.authors || [])[0])) !== normName(surname((b.authors || [])[0]))) d.push('authors');
  if (a.year && b.year && Math.abs(Number(a.year) - Number(b.year)) > 1) d.push('year');
  if (normName(a.venue) !== normName(b.venue)) d.push('venue');
  return d;
}

function latestDecisions() {
  const m = new Map();
  for (const d of readJSONL(DECISIONS)) m.set(d.sha256 || d.path, d);
  return m;
}

function question(meta) {
  if (!meta || !meta.title) return '';
  const names = (meta.authors || []).map(surname).filter(Boolean);
  let who = '';
  if (names.length === 1) who = names[0];
  else if (names.length === 2) who = `${names[0]} and ${names[1]}`;
  else if (names.length <= 4 && names.length) who = `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  else if (names.length) who = `${names[0]} et al.`;
  const bits = [who, meta.year ? `(${meta.year})` : ''].filter(Boolean).join(' ');
  return bits ? `${bits}${meta.venue ? `, ${meta.venue}` : ''}` : (meta.venue || '');
}

function card(p, e, decisions = latestDecisions()) {
  const t = e.triage || {};
  const det = e.det || null;

  const detUsable = det && (det.how !== 'title search' || (det.titleSimilarity || 0) >= 0.6) ? det : null;
  const ai = e.ai && e.ai.kind !== 'not a paper' ? e.ai : null;
  let state;
  if ((t.likelyNotPaper && !detUsable && !ai) || (e.ai && e.ai.kind === 'not a paper' && !detUsable)) state = 'not-paper';
  else if (detUsable && ai) state = agree(detUsable, ai) ? 'agree' : 'disagree';
  else if (detUsable || ai) state = 'one';
  else state = 'unknown';
  const best = state === 'agree' ? detUsable : (detUsable || ai);
  let relation = libraryRelation(t, e.name);
  if (!relation && best && best.title) {
    let top = null, topJ = 0;
    for (const lp of LIB.papers) { const j = jaccard(best.title, lp.title); if (j > topJ) { topJ = j; top = lp; } }
    if (top && topJ >= 0.85) relation = { kind: t.supplementName ? 'supplement' : 'version', paper: { id: top.id, title: top.title, year: top.year } };
  }
  if (!relation && t.supplementName && best && best.title) relation = { kind: 'supplement', of: best.title };

  if (!relation && t.landscape && best && best.title) relation = { kind: 'deck', mine: !!t.mine, of: best.title };
  const dec = decisions.get(t.sha256) || decisions.get(p) || null;
  const decided = dec && dec.decision !== 'undo' ? { decision: dec.decision, at: dec.at, topics: dec.topics || [] } : null;
  let group = 'identify';
  if (relation && (relation.kind === 'review' || (relation.kind === 'deck' && relation.mine))) group = 'yours';
  else if (relation) group = 'related';
  else if (state === 'not-paper' || t.landscape) group = 'not-paper';
  if (decided && group === 'identify') group = 'answered';
  return {
    path: p, name: e.name, dir: e.dir, size: e.size, mtimeMs: e.mtimeMs,
    pages: t.pages, sha256: t.sha256, ids: { doi: t.doi, arxiv: t.arxiv, ssrn: t.ssrn },
    reasons: t.reasons || [], titleGuess: t.titleGuess || '',
    state, group, relation,
    det: det, detWeak: det && !detUsable && (det.titleSimilarity || 0) >= 0.4 ? true : undefined,
    ai: e.ai || null, aiPending: !!e.aiPending, aiError: e.aiError || '',
    best, question: question(best),
    diff: state === 'disagree' ? diffFields(detUsable, ai) : [],
    version: relation && relation.kind === 'version' ? relation.paper : null,
    decided,
  };
}

export function inboxView() {
  const decisions = latestDecisions();
  const cards = [];
  let inLibrary = 0;
  for (const [p, e] of Object.entries(cache.files)) {
    if (!e.triage) continue;
    if (LIB.sha.has(e.triage.sha256)) { inLibrary++; continue; }
    cards.push(card(p, e, decisions));
  }
  const order = { agree: 0, disagree: 1, one: 2, unknown: 3, 'not-paper': 4 };
  cards.sort((a, b) => (order[a.state] - order[b.state]) || (b.mtimeMs - a.mtimeMs));
  const counts = {};
  for (const c of cards) counts[c.group] = (counts[c.group] || 0) + 1;
  return { cards, counts, inLibrary, scan: scanState(), aiRunning, aiQueued: aiQueue.length };
}

export function decide(body) {
  const e = cache.files[body.path];
  if (!e || !e.triage) throw new Error('unknown file');
  const decision = ['yes', 'fix', 'not-paper', 'known', 'undo'].includes(body.decision) ? body.decision : null;
  if (!decision) throw new Error('decision must be yes, fix, not-paper, known or undo');
  const rec = {
    at: new Date().toISOString(),
    path: body.path,
    sha256: e.triage.sha256,
    decision,
    meta: body.meta ? {
      title: trimText(body.meta.title || '', 300), authors: (body.meta.authors || []).map(String).slice(0, 30),
      year: Number(body.meta.year) || null, venue: String(body.meta.venue || ''), doi: normDoi(body.meta.doi || ''),
    } : null,
    source: body.source || null,
    topics: Array.isArray(body.topics) ? body.topics.map(String).slice(0, 12) : [],
  };
  appendJSONL(DECISIONS, rec);
  return card(body.path, e);
}

export function forget(p) { if (Object.hasOwn(cache.files, p)) { delete cache.files[p]; saveCache(); } }

export function candidatePath(p) {
  return Object.hasOwn(cache.files, p) ? p : null;
}
