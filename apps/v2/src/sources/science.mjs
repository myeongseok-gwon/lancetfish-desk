import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { P, DATA, ensureDir, stat, trimText } from '../util.mjs';
import { blockText, TOOL_CAP, DOC_CAP, SESSION_CAP, MSG_INDEX_CAP, SESSION_INDEX_CAP } from './stream.mjs';

const DOC_TOOLS = new Set(['edit_file', 'write_file', 'create_file']);
const DOC_EXT = /\.(md|markdown|txt|tex|qmd|rmd)$/i;

const DIR = path.join(DATA, 'science');
let lastCheck = 0, lastSig = '', copiedAt = 0;

export const scienceCopiedAt = () => copiedAt || stat(path.join(DIR, 'operon-cli.db'))?.mtimeMs || 0;

const sig = (src) => ['', '-wal', '-shm'].map((e) => { const st = stat(src + e); return st ? `${st.size}:${st.mtimeMs}` : '-'; }).join('|');

export function copyScienceDb(minIntervalMs = 0) {
  const src = P.science;
  if (!stat(src)) return null;
  const dst = path.join(ensureDir(DIR), 'operon-cli.db');
  const now = Date.now();
  if (stat(dst) && now - lastCheck < minIntervalMs) return dst;
  lastCheck = now;
  const before = sig(src);
  if (stat(dst) && before === lastSig) return dst;
  for (let attempt = 0; attempt < 3; attempt++) {
    const s0 = sig(src);
    for (const ext of ['', '-wal', '-shm']) {
      const from = src + ext, to = dst + ext;
      if (stat(from)) fs.copyFileSync(from, to);
      else { try { fs.unlinkSync(to); } catch {  } }
    }
    if (sig(src) === s0) { lastSig = s0; copiedAt = Date.now(); return dst; }
  }
  lastSig = '';
  return dst;
}

export function openScience(minIntervalMs = 0) { return open(minIntervalMs); }

function open(minIntervalMs) {
  const file = copyScienceDb(minIntervalMs);
  if (!file) return null;
  try { return new DatabaseSync(file, { readOnly: true }); } catch { return null; }
}

export function loadScience() {
  const db = open(0);
  if (!db) return [];
  try {
    const projects = new Map(db.prepare('select id, name from projects').all().map((r) => [r.id, r.name]));
    const roots = db.prepare(`select id, name, status, created_at, updated_at, project_id from frames
      where parent_frame_id is null and conversation_type = 'agent' order by updated_at desc`).all();
    const msgStmt = db.prepare(`select m.msg_json from frame_messages m join frames f on f.id = m.frame_id
      where f.id = ? or f.root_frame_id = ? order by f.created_at, m.idx`);
    return roots.map((r) => {
      const messages = [], chunks = [];
      let total = 0, indexChars = 0, prompts = 0, firstPrompt = '';
      const push = (role, text) => {
        total += text.length;
        if (indexChars < SESSION_INDEX_CAP) { const t = text.slice(0, MSG_INDEX_CAP); indexChars += t.length; messages.push({ role, text: t }); }
      };
      for (const row of msgStmt.iterate(r.id, r.id)) {
        if (total > SESSION_CAP) break;
        let m; try { m = JSON.parse(row.msg_json); } catch { continue; }
        if (!m || m._harness_notice) continue;
        const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
        for (const b of blocks) {
          if (b.type === 'text' && b.text) {
            const t = b.text.trim();
            if (m.role === 'user') {
              if (/^\[(System|Memory)\]/.test(t)) continue;
              prompts++;
              if (!firstPrompt) firstPrompt = t;
              push('user', t); chunks.push({ text: t, from: 'prompt' });
            } else if (m.role === 'assistant') { push('assistant', t); chunks.push({ text: t, from: 'reply' }); }
          } else if (b.type === 'tool_use' && b.input) {
            const inp = b.input;
            const prose = [inp.new_string, inp.content].filter((x) => typeof x === 'string').join('\n');
            if (DOC_TOOLS.has(b.name) && DOC_EXT.test(String(inp.file_path || '')) && prose && prose.length <= DOC_CAP) {
              chunks.push({ text: prose, from: 'doc', tool: b.name });
              continue;
            }
            const t = JSON.stringify(inp);
            if (t.length <= TOOL_CAP) chunks.push({ text: t, from: 'tool', tool: b.name });
          } else if (b.type === 'tool_result') {
            const t = blockText(b.content);
            if (t && t.length <= TOOL_CAP) { chunks.push({ text: t, from: 'result' }); total += t.length; }
          }
        }
      }
      return {
        app: 'science',
        id: r.id,
        title: trimText(r.name || firstPrompt || 'Claude Science conversation', 80),
        firstPrompt: trimText(firstPrompt, 200),
        project: projects.get(r.project_id) || '',
        status: r.status,
        started: new Date(r.created_at).toISOString(),
        updated: new Date(r.updated_at).toISOString(),
        prompts,
        messages,
        chunks,
      };
    });
  } finally { db.close(); }
}

export function scienceRunning() {
  const db = open(60000);
  if (!db) return [];
  try {
    const projects = new Map(db.prepare('select id, name from projects').all().map((r) => [r.id, r.name]));
    return db.prepare(`select id, name, status, updated_at, project_id from frames
      where parent_frame_id is null and status in ('running','in_progress','active','pending') order by updated_at desc`).all()
      .map((r) => ({ id: r.id, title: r.name || 'Conversation', project: projects.get(r.project_id) || '', updatedAt: r.updated_at, status: r.status }));
  } catch { return []; } finally { db.close(); }
}
