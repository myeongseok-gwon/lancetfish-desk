import path from 'node:path';
import { P, DATA, readJSON, listDir } from '../util.mjs';

export function loadDecks(paperIds) {
  const out = new Map();
  for (const root of [P.decks, path.join(DATA, 'slides')]) for (const d of listDir(root)) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(d)) continue;
    const file = path.join(root, d, 'deck.json');
    const deck = readJSON(file);
    if (!deck || !Array.isArray(deck.slides)) continue;
    const lines = [];
    for (const s of deck.slides) {
      for (const e of s.elements || []) if (e && typeof e.text === 'string' && e.text.trim()) lines.push(e.text.trim());
      if (s.notes) lines.push(String(s.notes));
    }
    const pid = deck.paper_id && paperIds.has(deck.paper_id) ? deck.paper_id : null;
    out.set(deck.id || d, {
      id: deck.id || d,
      title: deck.title || 'Untitled deck',
      paperId: pid,
      created: deck.created_at || '',
      updated: deck.updated_at || '',
      slides: deck.slides.length,
      text: lines.join('\n'),
      file,
    });
  }
  return [...out.values()];
}
