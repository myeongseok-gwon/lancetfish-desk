import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { effectivePaths, SETTINGS_DATA } from './settings.mjs';

export const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export let LF = effectivePaths().root;
export const HOME = os.homedir();
export const DATA = SETTINGS_DATA;
export let TZ = effectivePaths().timezone;

export const P = {
  papers: path.join(LF, 'research/library/papers'),
  libraryFiles: path.join(LF, 'research/library'),
  readings: path.join(LF, 'data/research/readings'),
  academics: path.join(LF, 'data/academics'),
  chats: path.join(LF, 'data/research/chats'),
  decks: path.join(LF, 'research/presentations'),
  takeaways: path.join(LF, 'research/takeaways'),
  referee: path.join(LF, 'research/reviews/referee'),
  reviews: path.join(LF, 'research/reviews'),
  programs: path.join(LF, 'research/programs'),
  sittings: path.join(LF, 'data/research/sessions.jsonl'),
  calendar: path.join(LF, 'data/calendar/google-calendar.json'),
  claudeProjects: path.join(HOME, '.claude/projects'),
  codexSessions: path.join(HOME, '.codex/sessions'),
  science: '',
  claudeLimits: path.join(HOME, '.cache/lancetfish/claude-limits.json'),
};

export function refreshPaths() {
  const p = effectivePaths();
  LF = p.root; TZ = p.timezone;
  for (const [key, rel] of Object.entries({ papers: 'research/library/papers', readings: 'data/research/readings',
    academics: 'data/academics', chats: 'data/research/chats', decks: 'research/presentations', takeaways: 'research/takeaways',
    referee: 'research/reviews/referee', reviews: 'research/reviews', programs: 'research/programs', sittings: 'data/research/sessions.jsonl' })) P[key] = path.join(LF, rel);
  Object.assign(P, { libraryFiles: p.papersDir, calendar: p.calendar, claudeProjects: p.claudeProjects,
    codexSessions: p.codexSessions, science: p.scienceDb, claudeLimits: p.claudeLimits });
}
refreshPaths();

export function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); return d; }
ensureDir(DATA);

export function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJSON(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
}

export function readJSONL(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {  }
  }
  return out;
}

export function appendJSONL(file, value) {
  fs.appendFileSync(file, JSON.stringify(value) + '\n');
}

export function listDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

export function stat(file) {
  try { return fs.statSync(file); } catch { return null; }
}

export function parseFrontmatter(text) {
  const meta = {};
  let body = text;
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end > 0) {
      const head = text.slice(3, end);
      body = text.slice(end + 4).replace(/^\s*\n/, '');
      for (const line of head.split('\n')) {
        const m = line.match(/^([A-Za-z0-9_]+):\s?(.*)$/);
        if (!m) continue;
        const raw = m[2].trim();
        try { meta[m[1]] = JSON.parse(raw); } catch { meta[m[1]] = raw.replace(/^["']|["']$/g, ''); }
      }
    }
  }
  return { meta, body };
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

export const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

export function normTitle(s) {
  return String(s || '')
    .normalize('NFKD').replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function titleTokens(s) {
  return normTitle(s).split(' ').filter(Boolean);
}

export function jaccard(a, b) {
  const A = new Set(titleTokens(a)), B = new Set(titleTokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export function surname(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  if (s.includes(',')) return s.split(',')[0].trim();
  const parts = s.split(/\s+/);
  return parts[parts.length - 1];
}

export function normName(s) {
  return String(s || '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z]/g, '');
}

export function normDoi(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '').replace(/^doi:\s*/, '')
    .replace(/[.,;:)\]}>'"]+$/, '');
}

export function normArxiv(s) {
  const m = String(s || '').match(/(\d{4}\.\d{4,5})/);
  return m ? m[1] : '';
}

export function trimText(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

export function dayKey(d = new Date(), tz = TZ) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(d);
}

export function toMs(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { error: String(e && e.message || e) }; }
    }
  });
  await Promise.all(workers);
  return out;
}

export function tailLines(file, bytes = 65536) {
  const st = stat(file);
  if (!st) return [];
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(bytes, st.size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    const lines = buf.toString('utf8').split('\n');
    if (len < st.size) lines.shift();
    return lines.filter((l) => l.trim());
  } finally { fs.closeSync(fd); }
}

export function headLines(file, cap = 2 * 1024 * 1024) {
  const st = stat(file);
  if (!st) return [];
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(cap, st.size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    const lines = buf.toString('utf8').split('\n');
    if (len < st.size) lines.pop();
    return lines;
  } finally { fs.closeSync(fd); }
}

export function safeParse(line) {
  try { return JSON.parse(line); } catch { return null; }
}
