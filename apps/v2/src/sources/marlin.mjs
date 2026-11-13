import path from 'node:path';
import { P, readJSON, listDir } from '../util.mjs';

export function loadMarlinChats(paperIds) {
  const out = [];
  for (const f of listDir(P.chats)) {
    if (!f.endsWith('.json') || f.endsWith('.paper.json')) continue;
    const id = f.replace(/\.json$/, '');
    const turns = readJSON(path.join(P.chats, f));
    if (!Array.isArray(turns) || !turns.length) continue;
    const msgs = turns.filter((t) => t && t.text).map((t) => ({ role: t.role === 'reader' ? 'user' : 'assistant', text: String(t.text), at: t.at || '' }));
    if (!msgs.length) continue;
    const firstUser = msgs.find((m) => m.role === 'user');
    out.push({
      app: 'marlin',
      id,
      paperId: paperIds.has(id) ? id : null,
      title: firstUser ? firstUser.text.slice(0, 80) : 'Reader chat',
      started: msgs[0].at,
      updated: msgs[msgs.length - 1].at,
      turns: msgs.length,
      messages: msgs,
      why: paperIds.has(id) ? { rule: 'reader', match: 'asked inside this paper’s reader' } : null,
    });
  }
  return out;
}
