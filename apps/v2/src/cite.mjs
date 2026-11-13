import path from 'node:path';
import { DATA, ensureDir, readJSON, writeJSON, surname } from './util.mjs';

const DIR = ensureDir(path.join(DATA, 'cite-cache'));
const UA = 'LancetfishV2/0.1';

async function negotiate(doi, accept, retry = 1) {
  try {
    const res = await fetch(`https://doi.org/${doi}`, { headers: { Accept: accept, 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = (await res.text()).trim();
    return text.startsWith('<') ? '' : text;
  } catch {
    if (retry > 0) { await new Promise((r) => setTimeout(r, 800)); return negotiate(doi, accept, retry - 1); }
    return '';
  }
}

function localBibtex(p) {
  const key = `${(surname(p.authors[0] || 'anon') || 'anon').normalize('NFKD').toLowerCase().replace(/[^a-z]/g, '')}${p.year || ''}`;
  const f = [
    ['title', p.title], ['author', p.authors.join(' and ')], ['year', p.year], ['journal', p.venue],
    ['volume', p.volume], ['number', p.issue], ['pages', p.pageRange], ['publisher', p.publisher], ['url', p.url],
  ].filter(([, v]) => v);
  return `@article{${key},\n${f.map(([k, v]) => `  ${k} = {${v}}`).join(',\n')}\n}`;
}

export async function cite(p) {
  const file = path.join(DIR, `${p.id}.json`);
  const hit = readJSON(file);
  if (hit && (hit.bibtex || hit.apa)) return hit;
  const doi = p.doi || (p.arxiv ? `10.48550/arXiv.${p.arxiv}` : '');
  let bibtex = '', apa = '';
  if (doi) {

    bibtex = await negotiate(doi, 'application/x-bibtex');
    apa = await negotiate(doi, 'text/x-bibliography; style=apa');
  }
  const out = { id: p.id, doi, bibtex: bibtex || localBibtex(p), apa, source: bibtex ? 'doi.org' : 'record', at: new Date().toISOString() };
  if (bibtex && (apa || !doi)) writeJSON(file, out);
  return out;
}
