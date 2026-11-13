import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { P, DATA, readJSON, listDir } from '../util.mjs';

export function docId(name) {
  const base = path.basename(String(name));
  const stem = base.includes('.') && !base.startsWith('.') ? base.slice(0, base.lastIndexOf('.')) : base;
  let text = stem.normalize('NFKC').toLowerCase();
  text = text.replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, '');
  let slug = text.replace(/[\s_]+/gu, '-').replace(/^-+|-+$/g, '');
  slug = Array.from(slug).slice(0, 60).join('').replace(/-+$/, '') || 'document';
  return `${slug}-${crypto.createHash('sha256').update(String(name)).digest('hex').slice(0, 8)}`;
}

export function readingFileFor(paper) {
  const local = path.join(DATA, 'reader/documents', `${paper.id}.json`);
  if (fs.existsSync(local)) return local;
  const s = paper.source || {};
  if (s.kind === 'course') {
    let base = path.join(P.academics, String(s.term || ''), String(s.slug || ''));
    if (s.date) base = path.join(base, 'sessions', String(s.date));
    const dir = path.join(base, 'readings');
    const guess = path.join(dir, `${docId(s.name || '')}.json`);
    if (fs.existsSync(guess)) return guess;

    for (const f of listDir(dir)) {
      const d = readJSON(path.join(dir, f));
      if (d && d.name === s.name) return path.join(dir, f);
    }
    return '';
  }
  const f = path.join(P.readings, `${paper.id}.json`);
  return fs.existsSync(f) ? f : '';
}

export function allReadingFiles() {
  const out = listDir(P.readings).filter((f) => f.endsWith('.json')).map((f) => path.join(P.readings, f));
  const local = path.join(DATA, 'reader/documents');
  out.push(...listDir(local).filter((f) => f.endsWith('.json')).map((f) => path.join(local, f)));
  for (const term of listDir(P.academics)) {
    const t = path.join(P.academics, term);
    for (const slug of listDir(t)) {
      const sd = path.join(t, slug, 'sessions');
      for (const date of listDir(sd)) {
        const rd = path.join(sd, date, 'readings');
        for (const f of listDir(rd)) if (f.endsWith('.json')) out.push(path.join(rd, f));
      }
      const rd = path.join(t, slug, 'readings');
      for (const f of listDir(rd)) if (f.endsWith('.json')) out.push(path.join(rd, f));
    }
  }
  return out;
}

export function loadHighlights(papers) {
  const byPaper = new Map();
  for (const paper of papers) {
    const file = readingFileFor(paper);
    if (!file) continue;
    const saved = readJSON(file);
    const d = saved?.schema === 1 && saved.reading ? saved.reading : saved;
    if (!d || !Array.isArray(d.highlights)) continue;
    const list = d.highlights
      .filter((h) => (h.text || h.note))
      .map((h) => ({ id: h.id, page: h.page, color: h.color || 'yellow', text: h.text || '', note: h.note || '', created: h.created || '' }))
      .sort((a, b) => (a.page - b.page) || String(a.created).localeCompare(String(b.created)));
    if (list.length) byPaper.set(paper.id, { file, updated: d.updated || '', highlights: list });
  }
  return byPaper;
}
