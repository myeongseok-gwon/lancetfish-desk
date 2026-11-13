import fs from 'node:fs';
import path from 'node:path';
import { P, listDir, parseFrontmatter, normDoi } from '../util.mjs';

function read(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }

export function loadNotes(papers) {
  const ids = new Set(papers.map((p) => p.id));
  const byDoi = new Map(papers.filter((p) => p.doi).map((p) => [p.doi, p.id]));
  const notes = [];
  for (const [dir, kind, label] of [[P.takeaways, 'takeaway', 'Takeaway'], [P.referee, 'referee', 'Referee report']]) {
    for (const f of listDir(dir)) {
      if (!f.endsWith('.md') || f.startsWith('_')) continue;
      const text = read(path.join(dir, f));
      const { meta, body } = parseFrontmatter(text);
      const pid = meta.paper || f.replace(/\.md$/, '');
      notes.push({
        id: `${kind}:${f.replace(/\.md$/, '')}`,
        kind, label,
        title: `${label}: ${meta.title || pid}`,
        paperIds: ids.has(pid) ? [pid] : [],
        why: ids.has(pid) ? { rule: 'file', match: f } : null,
        updated: meta.updated || '',
        status: meta.status || '',
        body,
        file: path.join(dir, f),
      });
    }
  }
  for (const f of listDir(P.reviews)) {
    if (!f.endsWith('.md')) continue;
    const text = read(path.join(P.reviews, f));
    const { body } = parseFrontmatter(text);
    const h1 = (body.match(/^#\s+(.+)$/m) || [])[1] || f.replace(/\.md$/, '');
    const cited = new Map();
    const lower = body.toLowerCase();
    for (const id of ids) if (lower.includes(id)) cited.set(id, { rule: 'id', match: id });
    for (const m of body.matchAll(/10\.\d{4,9}\/[^\s"'<>)\]]+/g)) {
      const doi = normDoi(m[0]);
      const pid = byDoi.get(doi);
      if (pid && !cited.has(pid)) cited.set(pid, { rule: 'doi', match: doi });
    }
    notes.push({
      id: `review:${f.replace(/\.md$/, '')}`,
      kind: 'review', label: 'Literature review',
      title: h1.replace(/\*\*/g, ''),
      paperIds: [...cited.keys()],
      citeWhy: Object.fromEntries(cited),
      why: null,
      updated: (f.match(/^\d{4}-\d{2}-\d{2}/) || [''])[0],
      body,
      file: path.join(P.reviews, f),
    });
  }
  return notes;
}
