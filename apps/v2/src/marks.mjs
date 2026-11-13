import path from 'node:path';
import crypto from 'node:crypto';
import { DATA, readJSONL, appendJSONL } from './util.mjs';

const FILE = path.join(DATA, 'marks.jsonl');
export const MARK_COLORS = ['yellow', 'green', 'pink'];
const bad = (message) => Object.assign(new Error(message), { code: 400 });
let marks = null;

function load() {
  if (marks) return marks;
  marks = new Map();
  for (const row of readJSONL(FILE)) {
    if (!row || typeof row.id !== 'string') continue;
    if (row.removed) marks.delete(row.id);
    else if (marks.has(row.id)) Object.assign(marks.get(row.id), row);
    else if (row.page && row.exact) marks.set(row.id, row);
  }
  return marks;
}

const pageKey = (v) => {
  const page = String(v || '');
  if (!/^\/[^\s]{0,600}$/.test(page) || page.startsWith('//')) throw bad('Not a Lancetfish page');
  return page;
};
const color = (v) => { if (!MARK_COLORS.includes(v)) throw bad('Choose yellow, green or pink'); return v; };

export const listMarks = (page) => ({ marks: [...load().values()].filter((m) => m.page === pageKey(page)) });

export function addMark(b) {
  const exact = String(b.exact || '');
  if (!exact.trim() || exact.length > 5000) throw bad('Select between 1 and 5,000 characters');
  const row = { id: crypto.randomUUID(), page: pageKey(b.page), exact, prefix: String(b.prefix || '').slice(-64), suffix: String(b.suffix || '').slice(0, 64),
    color: color(b.color), title: String(b.title || '').slice(0, 200), at: new Date().toISOString() };
  appendJSONL(FILE, row); load().set(row.id, row);
  return { mark: row };
}

export function updateMark(b) {
  const row = load().get(String(b.id || ''));
  if (!row) throw Object.assign(new Error('That highlight is gone'), { code: 404 });
  row.color = color(b.color);
  appendJSONL(FILE, { id: row.id, color: row.color });
  return { mark: row };
}

export function removeMark(b) {
  const id = String(b.id || '');
  if (load().delete(id)) appendJSONL(FILE, { id, removed: true });
  return { removed: id };
}
