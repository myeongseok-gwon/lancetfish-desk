import fs from 'node:fs';
import path from 'node:path';
import { P, listDir, stat, tailLines, safeParse, trimText } from '../util.mjs';
import { streamLines, blockText, TOOL_CAP, SESSION_CAP, MSG_INDEX_CAP, SESSION_INDEX_CAP } from './stream.mjs';

export function listCodexFiles() {
  const out = [];
  const walk = (dir, depth) => {
    for (const f of listDir(dir)) {
      const p = path.join(dir, f);
      if (depth < 3) { walk(p, depth + 1); continue; }
      if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
      const st = stat(p);
      const m = f.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
      if (st) out.push({ file: p, id: m ? m[1] : f, mtimeMs: st.mtimeMs, size: st.size });
    }
  };
  walk(P.codexSessions, 0);
  return out;
}

function safeStr(s) { try { return JSON.parse('"' + s + '"'); } catch { return s; } }

function isInjected(text) {
  const t = text.trimStart();
  return t.startsWith('<') || t.startsWith('# AGENTS.md') || t.startsWith('# Context from my IDE');
}

export async function parseCodexSession(entry) {
  const messages = [], chunks = [];
  let id = entry.id, cwd = '', started = '', parent = null, firstPrompt = '', total = 0, indexChars = 0, prompts = 0, handoff = null;
  await streamLines(entry.file, (line) => {
    const head = line.slice(0, 160);
    if (head.includes('"type":"session_meta"')) {
      const d = safeParse(line);
      const p = d && d.payload;
      if (p) {
        id = p.id || p.session_id || id;
        cwd = p.cwd || cwd;
        started = p.timestamp || d.timestamp || started;
        const src = p.source;
        if (src && typeof src === 'object' && src.subagent) {
          parent = (src.subagent.thread_spawn && src.subagent.thread_spawn.parent_thread_id) || null;
        }
      }
      return;
    }
    if (!head.includes('"type":"response_item"')) return;
    const d = safeParse(line);
    const p = d && d.payload;
    if (!p) return;
    const push = (role, text) => {
      total += text.length;
      if (indexChars < SESSION_INDEX_CAP) {
        const t = text.slice(0, MSG_INDEX_CAP);
        indexChars += t.length;
        messages.push({ role, text: t });
      }
    };
    if (p.type === 'message') {
      const text = blockText(p.content).trim();
      if (!text) return;
      if (p.role === 'user' && !isInjected(text)) {

        if (text.startsWith('## Referenced ChatGPT conversation')) {
          const tm = text.match(/"title":"((?:[^"\\]|\\.)*)"/);
          const cm = text.match(/"conversationId":"([0-9a-f-]{20,})"/);
          if (tm && !handoff) handoff = { title: safeStr(tm[1]), url: cm ? `https://chatgpt.com/c/${cm[1]}` : '' };
          chunks.push({ text, from: 'handoff' });
          return;
        }
        prompts++;
        if (!firstPrompt) firstPrompt = text;
        push('user', text);
        chunks.push({ text, from: 'prompt' });
      } else if (p.role === 'assistant') {
        push('assistant', text);
        chunks.push({ text, from: 'reply' });
      }
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      const t = String(p.arguments || p.input || '');
      if (t && t.length <= TOOL_CAP) chunks.push({ text: t, from: 'tool', tool: p.name || 'exec' });
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const t = typeof p.output === 'string' ? p.output : blockText(p.output);
      if (t && t.length <= TOOL_CAP) { chunks.push({ text: t, from: 'result' }); total += t.length; }
    }
    if (total > SESSION_CAP) return false;
  });
  return {
    app: 'codex',
    id,
    parent,
    title: trimText(handoff ? handoff.title : (firstPrompt || 'Codex session'), 80),
    handoff,
    firstPrompt: trimText(firstPrompt, 200),
    project: cwd ? path.basename(cwd) : '',
    cwd,
    started,
    updated: new Date(entry.mtimeMs).toISOString(),
    prompts,
    messages,
    chunks,
    resume: `codex resume ${id}`,
  };
}

export function codexLiveState(file) {
  let state = 'working', lastAt = 0, parent = null, id = '', cwd = '';
  const lines = tailLines(file, 256 * 1024);
  for (let i = lines.length - 1; i >= 0; i--) {
    const head = lines[i].slice(0, 200);
    if (!head.includes('"type":"event_msg"')) continue;
    if (!/"type":"(task_complete|task_started|turn_aborted|user_message)"/.test(lines[i].slice(0, 400))) continue;
    const d = safeParse(lines[i]);
    const t = d && d.payload && d.payload.type;
    lastAt = Date.parse(d.timestamp || '') || lastAt;
    state = (t === 'task_complete' || t === 'turn_aborted') ? 'waiting' : 'working';
    break;
  }
  return { state, lastAt, parent, id, cwd };
}

export function codexMeta(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const first = buf.subarray(0, n).toString('utf8').split('\n')[0];
    if (!first.includes('"type":"session_meta"')) return null;
    return {
      id: (first.match(/"id":"([0-9a-f-]{36})"/) || [])[1] || '',
      cwd: (first.match(/"cwd":"([^"]+)"/) || [])[1] || '',
      parent: (first.match(/"parent_thread_id":"([0-9a-f-]{36})"/) || [])[1] || null,
    };
  } catch { return null; }
}

export function codexLimits(files) {
  const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const f of sorted.slice(0, 8)) {
    const lines = tailLines(f.file, 1024 * 1024);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      const d = safeParse(lines[i]);
      const rl = d && d.payload && d.payload.rate_limits;
      if (rl && (rl.primary || rl.secondary)) return { at: Date.parse(d.timestamp || '') || f.mtimeMs, primary: rl.primary || null, secondary: rl.secondary || null };
    }
  }
  return null;
}
