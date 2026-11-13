import path from 'node:path';
import { P, listDir, stat, tailLines, headLines, safeParse, trimText } from '../util.mjs';
import { streamLines, blockText, cleanPrompt, TOOL_CAP, DOC_CAP, SESSION_CAP, MSG_INDEX_CAP, SESSION_INDEX_CAP } from './stream.mjs';
import { NAMER } from '../noise.mjs';

const WANT = new Set(['user', 'assistant', 'summary', 'ai-title']);
const MAX_LINE = 8 * 1024 * 1024;

const DOC_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const DOC_EXT = /\.(md|markdown|txt|tex|qmd|rmd|org|rst)$/i;

export function parseClaudeLine(line) {
  if (!line || line.length > MAX_LINE) return null;
  if (line.startsWith('{"type":"')) {
    const m = line.slice(0, 48).match(/^\{"type":"([^"]+)"/);
    if (!m || !WANT.has(m[1])) return null;
  }
  const d = safeParse(line);
  return d && WANT.has(d.type) ? d : null;
}

export function promptText(d) {
  const c = d && d.message && d.message.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
  return cleanPrompt(text);
}

export function listClaudeFiles() {
  const out = [];
  for (const slug of listDir(P.claudeProjects)) {
    const dir = path.join(P.claudeProjects, slug);
    for (const f of listDir(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(dir, f);
      const st = stat(file);
      if (st && st.isFile()) out.push({ file, slug, id: f.replace(/\.jsonl$/, ''), mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  return out;
}

export function listClaudeSubagentFiles(sinceMs) {
  const out = [];
  for (const slug of listDir(P.claudeProjects)) {
    const dir = path.join(P.claudeProjects, slug);
    for (const sid of listDir(dir)) {
      const sub = path.join(dir, sid, 'subagents');
      for (const f of listDir(sub)) {
        if (!f.endsWith('.jsonl')) continue;
        const st = stat(path.join(sub, f));
        if (st && st.mtimeMs >= sinceMs) out.push({ parent: sid, slug, mtimeMs: st.mtimeMs });
      }
    }
  }
  return out;
}

export function titleFromTail(file) {
  let title = '', summary = '', cwd = '';
  for (const line of tailLines(file, 512 * 1024).reverse()) {
    if (!summary && line.startsWith('{"type":"summary"')) { const d = safeParse(line); if (d && d.summary) summary = d.summary; }
    if (!title && line.startsWith('{"type":"ai-title"')) { const d = safeParse(line); if (d && d.aiTitle) title = d.aiTitle; }
    if (!cwd && line.includes('"cwd":"')) { const m = line.match(/"cwd":"([^"]+)"/); if (m) cwd = m[1]; }
    if (title && summary && cwd) break;
  }
  return { title: summary || title, cwd };
}

function toolChunk(b) {
  const input = b.input || {};
  const file = String(input.file_path || input.path || '');
  if (DOC_TOOLS.has(b.name) && DOC_EXT.test(file)) {
    const prose = [input.content, input.new_string, ...(Array.isArray(input.edits) ? input.edits.map((e) => e && e.new_string) : [])].filter(Boolean).join('\n');
    if (prose && prose.length <= DOC_CAP) return { text: prose, from: 'doc', tool: b.name };
  }
  const t = JSON.stringify(input);
  return t.length <= TOOL_CAP ? { text: t, from: 'tool', tool: b.name } : null;
}

export async function parseClaudeSession(entry) {
  const messages = [];
  const chunks = [];
  let firstPrompt = '', started = '', cwd = '', total = 0, indexChars = 0, prompts = 0, namer = 0;

  await streamLines(entry.file, (line) => {
    const d = parseClaudeLine(line);
    if (!d || d.isSidechain || d.isMeta || (d.type !== 'user' && d.type !== 'assistant')) return;
    if (d.timestamp && !started) started = d.timestamp;
    if (d.cwd && !cwd) cwd = d.cwd;
    const content = d.message && d.message.content;
    const push = (role, text) => {
      if (!text) return;
      total += text.length;
      if (indexChars < SESSION_INDEX_CAP) {
        const t = text.slice(0, MSG_INDEX_CAP);
        indexChars += t.length;
        messages.push({ role, text: t });
      }
    };
    if (d.type === 'user') {
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
      for (const b of blocks) {
        if (b.type === 'text') {
          const t = cleanPrompt(b.text);
          if (!t || t.startsWith('[Request interrupted')) continue;
          if (NAMER.test(t)) { namer++; continue; }
          prompts++;
          if (!firstPrompt) firstPrompt = t;
          push('user', t);
          chunks.push({ text: t, from: 'prompt' });
        } else if (b.type === 'tool_result') {
          const t = blockText(b.content);
          if (t && t.length <= TOOL_CAP) { chunks.push({ text: t, from: 'result' }); total += t.length; }
        }
      }
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'text' && b.text) { push('assistant', b.text); chunks.push({ text: b.text, from: 'reply' }); }
        else if (b.type === 'tool_use' && b.input) { const c = toolChunk(b); if (c) { chunks.push(c); total += c.text.length; } }
      }
    }
    if (total > SESSION_CAP) return false;
  });

  const tail = titleFromTail(entry.file);
  cwd = cwd || tail.cwd;
  return {
    app: 'claude-code',
    id: entry.id,
    title: trimText(tail.title || firstPrompt || 'Claude Code session', 80),
    firstPrompt: trimText(firstPrompt, 200),
    project: cwd ? path.basename(cwd) : entry.slug,
    cwd,
    started,
    updated: new Date(entry.mtimeMs).toISOString(),
    prompts,
    namerOnly: namer > 0 && prompts === 0,
    slug: entry.slug,
    messages,
    chunks,
    resume: `claude --resume ${entry.id}`,
  };
}

export function claudeHead(file) {
  let firstPrompt = '', cwd = '';
  for (const line of headLines(file, 512 * 1024)) {
    if (!cwd) { const m = line.match(/"cwd":"([^"]+)"/); if (m) cwd = m[1]; }
    if (!firstPrompt) {
      const d = parseClaudeLine(line);
      if (d && d.type === 'user' && !d.isMeta && !d.isSidechain) { const t = promptText(d); if (t) firstPrompt = t; }
    }
    if (firstPrompt && cwd) break;
  }
  return { firstPrompt, cwd };
}

export function claudeLiveState(file) {
  let state = 'working', lastAt = 0;
  const lines = tailLines(file, 512 * 1024);
  for (let i = lines.length - 1; i >= 0; i--) {
    const d = parseClaudeLine(lines[i]);
    if (!d || d.isSidechain || (d.type !== 'user' && d.type !== 'assistant')) continue;
    if (d.type === 'user' && d.isMeta) continue;
    lastAt = Date.parse(d.timestamp || '') || lastAt;
    if (d.type === 'assistant') {
      const c = (d.message && d.message.content) || [];
      const usesTool = Array.isArray(c) && c.some((b) => b.type === 'tool_use');
      state = (!usesTool && d.message.stop_reason === 'end_turn') ? 'waiting' : 'working';
    } else state = 'working';
    break;
  }
  return { state, lastAt };
}
