import path from 'node:path';
import { trimText } from './util.mjs';
import { listClaudeFiles, listClaudeSubagentFiles, claudeLiveState, claudeHead, titleFromTail } from './sources/claude-code.mjs';
import { listCodexFiles, codexLiveState, codexMeta } from './sources/codex.mjs';
import { scienceRunning } from './sources/science.mjs';
import { NAMER, PROBE_SLUG } from './noise.mjs';
import { readConfig } from './settings.mjs';

const WINDOW = 15 * 60 * 1000;

export function liveAgents(now = Date.now()) {
  const enabled = readConfig().apps || {};
  const out = [];
  const subs = new Map();
  for (const s of enabled.claudeCode === false ? [] : listClaudeSubagentFiles(now - WINDOW)) subs.set(s.parent, Math.max(subs.get(s.parent) || 0, s.mtimeMs));
  for (const f of enabled.claudeCode === false ? [] : listClaudeFiles()) {
    const last = Math.max(f.mtimeMs, subs.get(f.id) || 0);
    if (now - last > WINDOW || PROBE_SLUG.test(f.slug)) continue;
    const head = claudeHead(f.file);
    if (NAMER.test(head.firstPrompt)) continue;
    const live = claudeLiveState(f.file);
    const subActive = (subs.get(f.id) || 0) > now - 60000;
    out.push({
      app: 'claude-code', id: f.id,
      project: head.cwd ? path.basename(head.cwd) : f.slug,
      title: trimText(titleFromTail(f.file).title || head.firstPrompt || 'Session', 60),
      state: subActive ? 'working' : live.state,
      lastAt: last,
    });
  }
  const codexRows = new Map();
  for (const f of enabled.codex === false ? [] : listCodexFiles()) {
    if (now - f.mtimeMs > WINDOW) continue;
    const meta = codexMeta(f.file) || {};
    const key = meta.parent || meta.id || f.id;
    const live = codexLiveState(f.file);
    const prev = codexRows.get(key);
    const row = {
      app: 'codex', id: key, project: meta.cwd ? path.basename(meta.cwd) : '',
      title: '', state: live.state, lastAt: f.mtimeMs,
    };
    if (prev) {
      prev.lastAt = Math.max(prev.lastAt, row.lastAt);
      if (row.state === 'working' && f.mtimeMs > now - 60000) prev.state = 'working';
      if (!meta.parent) Object.assign(prev, { project: row.project || prev.project, state: prev.state === 'working' ? 'working' : row.state });
    } else codexRows.set(key, row);
  }
  out.push(...codexRows.values());
  for (const s of enabled.science === false ? [] : scienceRunning()) out.push({ app: 'science', id: s.id, project: s.project, title: s.title, state: 'working', lastAt: s.updatedAt });
  out.sort((a, b) => b.lastAt - a.lastAt);
  return out.map((a) => ({ ...a, minutesAgo: Math.max(0, Math.round((now - a.lastAt) / 60000)) }));
}
