import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA, readJSON, writeJSON, ensureDir, sha256File, normDoi, listDir } from './util.mjs';
import * as inbox from './inbox.mjs';
import { effectivePaths } from './settings.mjs';
import { cite } from './cite.mjs';

const ROOT = path.join(DATA, 'library');
const RECORDS = path.join(ROOT, 'records');

export const filedDir = () => path.join(effectivePaths().papersDir, 'filed');
let papers = () => [], changed = async () => {};
const pending = new Map();
let queue = Promise.resolve();
const fail = (message, code = 400) => Object.assign(new Error(message), { code });
const clean = (value, max = 400) => String(value || '').replace(/[\r\n\u0000-\u001f]/g, ' ').trim().slice(0, max);
const slug = (value) => String(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'paper';
export function configureIntake(options = {}) { if (options.papers) papers = options.papers; if (options.changed) changed = options.changed; }

function withinRuntime(file) {
  const base = fs.realpathSync(ROOT), target = fs.realpathSync(file);
  const relative = path.relative(path.resolve(ROOT), path.resolve(file));
  if (!target.startsWith(base + path.sep) || target !== path.resolve(base, relative)) throw fail('Invalid managed library path');
  return target;
}

function managedPdf(file) {
  const target = fs.realpathSync(file);
  for (const dir of [filedDir(), ROOT]) {
    let base; try { base = fs.realpathSync(dir); } catch { continue; }
    if (target.startsWith(base + path.sep) && fs.statSync(target).isFile()) return target;
  }
  throw fail('Invalid managed library path');
}

function filedFolder() {
  const dir = ensureDir(filedDir());
  if (fs.lstatSync(dir).isSymbolicLink()) throw fail('The filed-papers folder cannot be a symbolic link');
  return dir;
}

async function freeTarget(dir, name, hash) {
  const plain = path.join(dir, name);
  if (!fs.existsSync(plain) || (fs.lstatSync(plain).isFile() && await sha256File(plain) === hash)) return plain;
  return path.join(dir, `${name.slice(0, -4)} (${hash.slice(0, 6)}).pdf`);
}

async function removeOriginal(source, seen, kept, hash) {
  try {
    const now = fs.lstatSync(source);
    if (!now.isFile() || now.isSymbolicLink() || (seen && (now.ino !== seen.ino || now.size !== seen.size || now.mtimeMs !== seen.mtimeMs))) return false;
    if (fs.realpathSync(source) === fs.realpathSync(kept) || await sha256File(kept) !== hash) return false;
    fs.unlinkSync(source);
    return true;
  } catch { return false; }
}

function managedDir(...parts) {
  let current = ensureDir(ROOT);
  if (fs.lstatSync(current).isSymbolicLink()) throw fail('Managed library folders cannot be symbolic links');
  for (const part of parts) {
    current = ensureDir(path.join(current, part));
    if (fs.lstatSync(current).isSymbolicLink()) throw fail('Managed library folders cannot be symbolic links');
  }
  return current;
}

export function managedPapers() {
  return listDir(RECORDS).filter((name) => /^[a-z0-9-]{1,100}\.json$/.test(name)).flatMap((name) => {
    try {
      const recordFile = withinRuntime(path.join(RECORDS, name));
      if (fs.statSync(recordFile).size > 2 * 1024 * 1024) return [];
      const p = readJSON(recordFile);
      if (!p || p.id !== name.slice(0, -5) || !Array.isArray(p.authors) || !p.pdfPath) return [];
      managedPdf(p.pdfPath);
      return [p];
    } catch { return []; }
  });
}

function metadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('Confirm the paper details before adding it');
  const title = clean(value.title, 500);
  const authors = Array.isArray(value.authors) ? value.authors.map((v) => clean(v, 150)).filter(Boolean).slice(0, 50) : [];
  const year = value.year ? Number(value.year) : null;
  const doi = normDoi(value.doi || '');
  if (!title || title.length < 4) throw fail('Enter the paper title');
  if (!authors.length) throw fail('Enter at least one author, or mark this file as not a paper');
  if (year !== null && (!Number.isInteger(year) || year < 1500 || year > new Date().getFullYear() + 3)) throw fail('Enter a valid publication year');
  if (doi && !/^10\.\d{4,9}\/\S+$/i.test(doi)) throw fail('Enter a valid DOI or leave it blank');
  return { title, authors, year: year || '', venue: clean(value.venue, 250), doi,
    arxiv: clean(value.arxiv, 60), ssrn: clean(value.ssrn, 40), abstract: clean(value.abstract, 30000) };
}

function readableName(p) {
  const surname = p.authors[0].split(/\s+/).pop();
  return clean([surname, p.year, p.title].filter(Boolean).join(' '), 160).replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim() + '.pdf';
}

async function importFile(body) {
  const source = inbox.candidatePath(String(body.path || ''));
  if (!source) throw fail('This file is not in the processed inbox', 404);
  const original = fs.lstatSync(source);
  if (!original.isFile() || original.isSymbolicLink() || !/\.pdf$/i.test(source)) throw fail('Choose a regular PDF from the inbox');
  if (original.size > 200 * 1024 * 1024) throw fail('This PDF exceeds the 200 MB intake limit');
  const meta = metadata(body.meta);
  const hash = await sha256File(source);
  const sameBytes = [...papers(), ...managedPapers()].find((p) => p.sha256 === hash);
  if (sameBytes) {
    if (!papers().some((p) => p.id === sameBytes.id)) await changed();

    const removed = sameBytes.pdfPath && fs.existsSync(sameBytes.pdfPath) ? await removeOriginal(source, original, sameBytes.pdfPath, hash) : false;
    return { paperId: sameBytes.id, duplicate: true, title: sameBytes.title, removed, file: sameBytes.pdfPath || '' };
  }
  const sameDoi = meta.doi && [...papers(), ...managedPapers()].find((p) => normDoi(p.doi) === meta.doi);
  if (sameDoi) throw fail(`This DOI already belongs to “${sameDoi.title}”. Keep this file in the versions group rather than creating another paper.`, 409);
  const id = `${slug(meta.title)}-${hash.slice(0, 8)}`;
  const folder = managedDir('files', id);
  const dest = filedFolder();
  const target = await freeTarget(dest, readableName(meta), hash), name = path.basename(target);
  const recordFile = path.join(managedDir('records'), `${id}.json`);
  if (fs.existsSync(recordFile)) {
    if (readJSON(recordFile)) throw fail('A paper with this content is already recorded', 409);

    fs.renameSync(recordFile, path.join(RECORDS, `.corrupt-${id}-${crypto.randomUUID()}.json`));
  }
  const temp = path.join(dest, `.copy-${crypto.randomUUID()}`);
  let copied = false;
  try {
    fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL);
    const after = fs.lstatSync(source);
    if (!after.isFile() || after.ino !== original.ino || after.dev !== original.dev || after.size !== original.size || after.mtimeMs !== original.mtimeMs || await sha256File(temp) !== hash) throw fail('The download changed during intake. Process the inbox again.');

    if (fs.existsSync(target)) {
      if (!fs.lstatSync(target).isFile() || await sha256File(target) !== hash) throw fail('A different file already exists at this library location', 409);
    } else { fs.linkSync(temp, target); copied = true; }
    const now = new Date().toISOString();
    const topics = Array.isArray(body.topics) ? body.topics.map((v) => clean(v, 100)).filter(Boolean).slice(0, 24) : [];
    const p = { ...meta, id, sha256: hash, pdfPath: target, source: { kind: 'v2', name, originalPath: source },
      sourceName: name, confidence: 'manual', added: now, updated: now, opened: '', status: 'queued',
      keywords: topics, programs: [], pages: Number(inbox.inboxView().cards.find((c) => c.path === source)?.pages) || '',
      volume: '', issue: '', pageRange: '', publisher: '', url: meta.doi ? `https://doi.org/${meta.doi}` : '' };
    const text = `---\n${Object.entries({ node_type: 'paper', paper_id: id, title: meta.title, authors: meta.authors, year: meta.year, doi: meta.doi, sha256: hash, confirmed_by: 'user' }).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n\n# ${meta.title}\n\n${meta.abstract || ''}\n`;
    if (!fs.existsSync(path.join(folder, 'paper.md'))) fs.writeFileSync(path.join(folder, 'paper.md'), text, { flag: 'wx' });
    const recordTemp = path.join(RECORDS, `.record-${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(recordTemp, JSON.stringify(p, null, 2) + '\n', { flag: 'wx' });
      fs.linkSync(recordTemp, recordFile);
    } finally { try { fs.unlinkSync(recordTemp); } catch {} }
    await changed();

    const citation = await cite(p);
    fs.writeFileSync(path.join(folder, 'citation.bib'), citation.bibtex);
    writeJSON(path.join(folder, 'citation.json'), citation);
    const removed = await removeOriginal(source, original, target, hash);
    return { paperId: id, duplicate: false, title: meta.title, citationSource: citation.source, removed, file: target, folder: dest };
  } catch (error) {
    if (copied && !fs.existsSync(recordFile)) { try { fs.unlinkSync(target); } catch {} }
    throw error;
  } finally { try { fs.unlinkSync(temp); } catch {} }
}

export function importCandidate(body) {
  const key = String(body.path || '');
  if (pending.has(key)) return pending.get(key);
  const task = queue.then(() => importFile(body)).finally(() => pending.delete(key));
  queue = task.catch(() => {});
  pending.set(key, task);
  return task;
}

export async function settleFiled() {
  const out = { moved: 0, cleared: 0 };
  for (const name of listDir(RECORDS).filter((n) => /^[a-z0-9-]{1,100}\.json$/.test(n))) {
    try {
      const file = path.join(RECORDS, name), p = readJSON(file);
      if (!p || !p.pdfPath || !p.sha256 || !fs.existsSync(p.pdfPath)) continue;
      let pdf = managedPdf(p.pdfPath);
      if (pdf.startsWith(fs.realpathSync(ROOT) + path.sep)) {
        const dest = filedFolder(), target = await freeTarget(dest, path.basename(pdf).replace(/\s+/g, ' '), p.sha256);
        if (!fs.existsSync(target)) {
          const temp = path.join(dest, `.copy-${crypto.randomUUID()}`);
          try { fs.copyFileSync(pdf, temp, fs.constants.COPYFILE_EXCL); if (await sha256File(temp) !== p.sha256) throw fail('copy differs'); fs.linkSync(temp, target); }
          finally { try { fs.unlinkSync(temp); } catch {} }
        }
        writeJSON(file, { ...p, pdfPath: target, sourceName: path.basename(target), source: { ...p.source, name: path.basename(target) } });
        fs.unlinkSync(pdf); pdf = target; out.moved++;
      }
      const original = p.source?.originalPath;
      if (original && fs.existsSync(original) && await sha256File(original) === p.sha256 && await removeOriginal(original, null, pdf, p.sha256)) { inbox.forget(original); out.cleared++; }
    } catch {  }
  }
  return out;
}
