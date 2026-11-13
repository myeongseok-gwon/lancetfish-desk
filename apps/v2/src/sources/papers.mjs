import fs from 'node:fs';
import path from 'node:path';
import { P, LF, parseFrontmatter, listDir, normDoi, normArxiv, stat } from '../util.mjs';
import { managedPapers } from '../intake.mjs';

function abstractOf(body) {
  const parts = body.split(/^##\s+/m);
  const abs = parts.find((p) => /^Abstract\s*\n/.test(p));
  return abs ? abs.replace(/^Abstract\s*\n/, '').trim() : '';
}

function pdfPathFor(source, libraryNames) {
  if (!source || !source.name) return '';
  if (typeof source.name !== 'string' || source.name !== path.basename(source.name) || source.name.includes('\\') || !/\.pdf$/i.test(source.name)) return '';
  const scoped = (base, relative) => {
    try {
      const realBase = fs.realpathSync(base), expected = path.resolve(realBase, relative), actual = fs.realpathSync(expected);
      return actual === expected && actual.startsWith(realBase + path.sep) && fs.statSync(actual).isFile() ? actual : '';
    } catch { return ''; }
  };
  if (source.kind === 'course') {
    if (!/^[a-z0-9-]+$/.test(source.term || '') || !/^[a-z0-9-]+$/.test(source.slug || '') || source.date && !/^\d{4}-\d{2}-\d{2}$/.test(source.date)) return '';
    let relative = path.join(source.term, source.slug);
    if (source.date) relative = path.join(relative, 'sessions', source.date);
    return scoped(P.academics, path.join(relative, 'attachments', source.name));
  }
  const direct = scoped(P.libraryFiles, source.name);
  if (direct) return direct;

  const loose = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const want = loose(source.name);
  const hit = libraryNames.find((n) => loose(n) === want);
  return hit ? scoped(P.libraryFiles, hit) : '';
}

export function loadPapers() {
  const libraryNames = listDir(P.libraryFiles).filter((n) => n.toLowerCase().endsWith('.pdf'));
  const papers = [];
  for (const f of listDir(P.papers)) {
    if (!f.endsWith('.md')) continue;
    let text;
    try { text = fs.readFileSync(path.join(P.papers, f), 'utf8'); } catch { continue; }
    const { meta, body } = parseFrontmatter(text);
    const id = meta.id || f.replace(/\.md$/, '');
    const source = meta.source || {};
    papers.push({
      id,
      title: meta.title || id,
      authors: Array.isArray(meta.authors) ? meta.authors : [],
      year: meta.year || '',
      venue: meta.venue || '',
      venueKind: meta.venue_kind || '',
      doi: normDoi(meta.doi || ''),
      arxiv: normArxiv(meta.arxiv || ''),
      ssrn: meta.ssrn || '',
      url: meta.url || '',
      keywords: Array.isArray(meta.keywords) ? meta.keywords : [],
      programs: Array.isArray(meta.programs) ? meta.programs.map((p) => p.philosophy).filter(Boolean) : [],
      status: meta.status || '',
      sha256: meta.sha256 || '',
      source,
      sourceName: source.name || '',
      pdfPath: pdfPathFor(source, libraryNames),
      confidence: meta.meta_confidence || '',
      added: meta.added || '',
      opened: meta.opened || '',
      updated: meta.updated || '',
      pages: meta.pages || '',
      volume: meta.volume || '',
      issue: meta.issue || '',
      pageRange: meta.page_range || '',
      publisher: meta.publisher || '',
      abstract: abstractOf(body),
    });
  }
  return [...papers, ...managedPapers()];
}

export function loadPrograms() {
  const out = [];
  for (const d of listDir(P.programs)) {
    const f = path.join(P.programs, d, 'philosophy.md');
    try {
      const { meta } = parseFrontmatter(fs.readFileSync(f, 'utf8'));
      out.push({ id: d, title: meta.title || d });
    } catch {  }
  }
  return out;
}

export const relLF = (p) => (p && p.startsWith(LF) ? p.slice(LF.length + 1) : p);
