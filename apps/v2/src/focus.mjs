import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DATA, readJSON, writeJSON, readJSONL, appendJSONL, stat, dayKey, safeParse } from './util.mjs';
import { SAMPLE_MS, DEFAULT_ON_TASK, presence, context, bonus, step, toScore } from './score.mjs';
import { allReadingFiles } from './sources/highlights.mjs';
import { listClaudeFiles, parseClaudeLine, promptText } from './sources/claude-code.mjs';
import { listCodexFiles, codexMeta } from './sources/codex.mjs';
import { isAutomatedPrompt, PROBE_SLUG } from './noise.mjs';
import { P, listDir } from './util.mjs';

const ACTIVE = path.join(DATA, 'focus-active.json');
const LOG = path.join(DATA, 'focus.jsonl');
const CONFIG = path.join(DATA, 'config.json');

export const KINDS = ['Reading', 'Lit review', 'Writing', 'Brainstorm', 'Slides', 'Coursework', 'Coding'];
export const LENGTHS = [25, 45, 50];

let active = readJSON(ACTIVE, null);

function onTaskList() {
  const c = readJSON(CONFIG, {});
  return Array.isArray(c.onTask) && c.onTask.length ? c.onTask : DEFAULT_ON_TASK;
}

function save() {
  if (active) writeJSON(ACTIVE, active);
  else { try { fs.unlinkSync(ACTIVE); } catch {  } }
}

function run(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 4000 }, (err, out) => resolve(err ? '' : String(out))));
}

export async function idleSeconds() {
  const out = await run('/usr/sbin/ioreg', ['-c', 'IOHIDSystem']);
  const m = out.match(/"HIDIdleTime"\s*=\s*(\d+)/);
  return m ? Number(m[1]) / 1e9 : null;
}

export async function frontApp() {
  const asn = (await run('/usr/bin/lsappinfo', ['front'])).trim();
  if (!asn) return '';
  const out = await run('/usr/bin/lsappinfo', ['info', '-only', 'name', asn]);
  const m = out.match(/"LSDisplayName"="([^"]*)"/);
  return m ? m[1] : '';
}

const activeMs = (b, now) => now - b.start - b.pausedMs - (b.pausedAt ? now - b.pausedAt : 0);
const plannedMs = (b) => b.minutes * 60000;

function baseline() {
  const sizes = {};
  const apps = readJSON(CONFIG, {}).apps || {};
  for (const f of [...(apps.claudeCode === false ? [] : listClaudeFiles()), ...(apps.codex === false ? [] : listCodexFiles())]) sizes[f.file] = f.size;
  return { sizes, scannedAt: Date.now() };
}

function readRange(file, from, to) {
  if (to <= from) return '';
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(to - from, 8 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, to - len);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

export function isUserPrompt(line, app) {
  if (app === 'claude') {
    const d = parseClaudeLine(line);
    if (!d || d.type !== 'user' || d.isMeta || d.isSidechain) return false;
    return !isAutomatedPrompt(promptText(d));
  }
  if (!line.slice(0, 200).includes('"type":"response_item"') || !line.includes('"role":"user"')) return false;
  const d = safeParse(line);
  const p = d && d.payload;
  if (!p || p.type !== 'message' || p.role !== 'user') return false;
  const text = (p.content || []).map((b) => b.text || '').join('\n').trimStart();
  if (!text || text.startsWith('<') || text.startsWith('# AGENTS.md') || text.startsWith('## Referenced')) return false;
  return !isAutomatedPrompt(text);
}

export function scanSubstance(b) {
  const w = b.watch || (b.watch = baseline());
  const since = w.scannedAt;
  const now = Date.now();
  const events = [];
  for (const f of allReadingFiles()) {
    const st = stat(f);
    if (!st || st.mtimeMs < since) continue;
    const saved = readJSON(f, {});
    const d = saved.reading || saved;
    for (const h of d.highlights || []) {
      const t = Date.parse(h.created || '');
      if (t > since && t <= now) events.push({ t, kind: 'highlight' });
    }
  }
  const apps = readJSON(CONFIG, {}).apps || {};
  const claude = (apps.claudeCode === false ? [] : listClaudeFiles()).filter((f) => !PROBE_SLUG.test(f.slug));
  const codex = (apps.codex === false ? [] : listCodexFiles()).filter((f) => { const m = codexMeta(f.file); return !(m && m.parent); });
  for (const [list, app] of [[claude, 'claude'], [codex, 'codex']]) {
    for (const f of list) {
      const prev = w.sizes[f.file];
      if (prev == null) { w.sizes[f.file] = 0; }
      const from = w.sizes[f.file];
      if (f.size <= from) continue;
      const text = readRange(f.file, from, f.size);
      const lines = text.split('\n');
      if (from > 0) lines.shift();
      for (const line of lines) if (line && isUserPrompt(line, app)) events.push({ t: now, kind: app === 'claude' ? 'claude prompt' : 'codex prompt' });
      w.sizes[f.file] = f.size;
    }
  }
  for (const directory of [P.decks, path.join(DATA, 'slides')]) for (const d of listDir(directory)) {
    if (d.startsWith('.')) continue;
    const f = path.join(directory, d, 'deck.json');
    const st = stat(f);
    if (!st || st.mtimeMs < since) continue;
    const deck = readJSON(f, {});
    const t = Date.parse(deck.updated_at || '');
    if (t > since) events.push({ t: Math.min(t, now), kind: 'deck saved' });
  }
  w.scannedAt = now;
  return events;
}

export function start({ intent, kind, minutes }) {
  if (active && (active.status === 'running' || active.status === 'paused')) throw new Error('A block is already running');
  const m = Number(minutes) || 50;
  active = {
    id: `b${Date.now().toString(36)}`,
    status: 'running',
    intent: String(intent || '').trim().slice(0, 200) || 'Focus',
    kind: KINDS.includes(kind) ? kind : 'Reading',
    minutes: Math.max(1, Math.min(180, m)),
    start: Date.now(),
    pausedMs: 0,
    pausedAt: null,
    samples: [],
    events: [],
    ema: null,
    watch: baseline(),
  };
  save();
  sample().catch(() => {});
  return state();
}

export function pause() {
  if (!active || active.status !== 'running') throw new Error('Nothing is running');
  active.status = 'paused';
  active.pausedAt = Date.now();
  save();
  return state();
}

export function resume() {
  if (!active || active.status !== 'paused') throw new Error('Nothing is paused');
  active.pausedMs += Date.now() - active.pausedAt;
  active.pausedAt = null;
  active.status = 'running';
  save();
  return state();
}

function record(b, endMs, completed) {
  const scores = b.samples.map((s) => s.s);
  const rec = {
    id: b.id,
    start: new Date(b.start).toISOString(),
    end: new Date(endMs).toISOString(),
    intent: b.intent,
    kind: b.kind,
    plannedMinutes: b.minutes,
    actualMinutes: Math.round(activeMs(b, endMs) / 6000) / 10,
    pausedMinutes: Math.round((b.pausedMs + (b.pausedAt ? endMs - b.pausedAt : 0)) / 6000) / 10,
    completed,
    meanScore: scores.length ? Math.round(scores.reduce((a, x) => a + x, 0) / scores.length) : null,
    samples: b.samples.map((s) => ({ t: s.t, s: s.s, p: s.p, c: s.c, b: s.b, app: s.app })),
    events: b.events.length,
  };
  appendJSONL(LOG, rec);
  return rec;
}

export function finish() {
  if (!active || !['running', 'paused'].includes(active.status)) throw new Error('Nothing to finish');
  const now = Date.now();
  const done = activeMs(active, now) >= plannedMs(active) - 30000;
  const rec = record(active, now, done);
  active = { status: 'complete', block: summary(rec), at: now };
  save();
  return state();
}

export function discard() {
  if (!active) throw new Error('Nothing to discard');
  active = null;
  save();
  return state();
}

export function takeBreak(minutes) {
  if (!active || (active.status !== 'complete' && active.status !== 'break')) throw new Error('Finish the block first');
  const m = Number(minutes) === 10 ? 10 : 5;
  active = { status: 'break', start: Date.now(), minutes: m, after: active && active.block ? active.block : null };
  save();
  return state();
}

export function dismiss() {
  if (active && active.status !== 'complete' && active.status !== 'break') throw new Error('A block is running: finish or discard it');
  active = null;
  save();
  return state();
}

function summary(rec) {
  return { id: rec.id, intent: rec.intent, kind: rec.kind, plannedMinutes: rec.plannedMinutes, actualMinutes: rec.actualMinutes, completed: rec.completed, meanScore: rec.meanScore };
}

function checkTime() {
  if (!active) return;
  const now = Date.now();
  if (active.status === 'running' && activeMs(active, now) >= plannedMs(active)) {
    const endMs = active.start + active.pausedMs + plannedMs(active);
    const rec = record(active, Math.min(endMs, now), true);
    active = { status: 'complete', block: summary(rec), at: endMs };
    save();
  } else if (active.status === 'break' && now - active.start >= active.minutes * 60000) {
    active = null;
    save();
  }
}

export async function sample() {
  checkTime();
  if (!active || active.status !== 'running') return;
  const now = Date.now();
  const last = active.samples[active.samples.length - 1];
  if (last && now - last.t < SAMPLE_MS - 500) return;
  const [idle, app] = await Promise.all([idleSeconds(), frontApp()]);
  if (!active || active.status !== 'running') return;
  let fresh = [];
  try { fresh = scanSubstance(active); } catch { fresh = []; }
  active.events.push(...fresh);
  active.events = active.events.filter((e) => now - e.t < 10 * 60000);
  const p = presence(idle), c = context(app, onTaskList()), b = bonus(active.events, now);
  const r = step(active.ema, p, c, b);
  active.ema = r.ema;
  active.samples.push({ t: now, s: toScore(r.ema), raw: Math.round(r.raw * 100) / 100, p: Math.round(p * 100) / 100, c, b: Math.round(b * 100) / 100, app, idle: idle == null ? null : Math.round(idle) });
  save();
}

let timer = null;
export function startTicker() {
  if (timer) return;
  checkTime();
  timer = setInterval(() => { sample().catch(() => {}); }, 5000);
  timer.unref();
}

export function blocks() { return readJSONL(LOG); }

export function todayBlocks(now = new Date()) {
  const today = dayKey(now);
  return blocks().filter((b) => dayKey(new Date(b.start)) === today);
}

export function state() {
  checkTime();
  const now = Date.now();
  if (!active) return { status: 'idle', kinds: KINDS, lengths: LENGTHS, now };
  if (active.status === 'complete') return { status: 'complete', block: active.block, at: active.at, now };
  if (active.status === 'break') return { status: 'break', minutes: active.minutes, remainingMs: Math.max(0, active.minutes * 60000 - (now - active.start)), now };
  const b = active;
  const last = b.samples[b.samples.length - 1];
  return {
    status: b.status,
    id: b.id,
    intent: b.intent,
    kind: b.kind,
    minutes: b.minutes,
    start: b.start,
    elapsedMs: activeMs(b, now),
    remainingMs: Math.max(0, plannedMs(b) - activeMs(b, now)),
    pausedForMs: b.pausedAt ? now - b.pausedAt : 0,
    score: last ? last.s : null,
    spark: b.samples.slice(-40).map((s) => s.s),
    lastSample: last ? { p: last.p, c: last.c, b: last.b, app: last.app, idle: last.idle } : null,
    substance: b.events.length,
    now,
  };
}
