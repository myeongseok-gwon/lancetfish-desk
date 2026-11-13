import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { APP, DATA, LF } from './util.mjs';

const CODE = path.resolve(APP, '../..');
const ROOT = path.join(DATA, 'reader');
const ID = /^[a-zA-Z0-9_-]{1,120}$/;
const ARRAYS = new Set(['highlights', 'writings', 'drawings', 'contents']);
const MAPS = new Set(['comments', 'rotations']);
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
const plain = (v) => v && typeof v === 'object' && !Array.isArray(v);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hash = (v) => crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const fail = (message, code = 400) => Object.assign(new Error(message), { code });
let config = { paper: () => null, papers: () => [], material: null, changed: () => {} };
export function configureReader(options = {}) { config = { ...config, ...options }; }

function directory(folder) {
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  let current = folder;
  while (current !== path.dirname(DATA)) {
    if (fs.lstatSync(current).isSymbolicLink()) throw fail('Reader storage cannot contain symbolic links');
    if (current === DATA) break;
    current = path.dirname(current);
  }
}
function localFile(folder, name) {
  directory(folder);
  const file = path.join(folder, name);
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw fail('Reader storage cannot contain symbolic links');
  return file;
}
function read(file) {
  if (!fs.existsSync(file)) return null;
  if (fs.statSync(file).size > 20 * 1024 * 1024) throw fail('Annotations exceed the reader size limit');
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw fail('Existing reader data could not be read. Restore it before saving.'); }
  if (!plain(value)) throw fail('Existing reader data is not a JSON object');
  return value;
}
function atomic(file, value) {
  const temporary = localFile(path.dirname(file), `.save-${crypto.randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function pythonBinary() {
  const bundled = path.join(CODE, 'apps/hub/.venv/bin/python');
  return process.env.V2_READER_PYTHON || process.env.LANCETFISH_PYTHON || (fs.existsSync(bundled) ? bundled : 'python3');
}
async function locked(key, fn) {
  const lock = localFile(path.join(ROOT, 'locks'), `${key}.lock`);
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBinary(), ['-B', path.join(APP, 'src/reader_bridge.py'), '--lock', lock],
      { cwd: CODE, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', acquired = false, complete = false, value, failure;
    const timer = setTimeout(() => { failure = fail('The annotation lock helper timed out.', 503); child.kill(); }, 15000);
    child.on('error', () => { clearTimeout(timer); reject(fail('The annotation lock helper could not start.', 503)); });
    child.stdin.on('error', () => {});
    child.stdout.on('data', (part) => {
      buffer += part;
      if (acquired || !buffer.includes('\n')) return;
      let answer;
      try { answer = JSON.parse(buffer.split('\n')[0]); }
      catch { failure = fail('The annotation lock helper returned an invalid response.', 503); child.stdin.end(); return; }
      if (!answer.locked) { failure = fail(answer.error || 'Could not lock annotations', answer.code || 503); child.stdin.end(); return; }
      acquired = true;
      Promise.resolve().then(fn).then((result) => { value = result; complete = true; }, (error) => { failure = error; complete = true; }).finally(() => child.stdin.end());
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (!acquired || !complete) reject(fail('The annotation lock helper stopped before saving completed.', 503));
      else resolve(value);
    });
  });
}
function bridge(op, doc, body = {}, extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBinary(), ['-B', path.join(APP, 'src/reader_bridge.py')], {
      cwd: CODE, env: { ...process.env, LANCETFISH_ROOT: LF, PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', finished = false;
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, ['chat', 'lookup'].includes(op) ? 660000 : 45000);
    const done = (error, value) => { if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    child.stdout.on('data', (part) => { stdout += part; if (stdout.length > 25 * 1024 * 1024) child.kill(); });
    child.stderr.on('data', (part) => { stderr = (stderr + part).slice(-3000); });
    child.on('error', () => done(fail('The local PDF helper could not start. Check the configured Python installation.', 503)));
    child.on('close', (code) => {
      if (code !== 0) return done(fail(`The local PDF helper failed${stderr ? ': ' + stderr.slice(-400) : '.'}`, 503));
      try { const out = JSON.parse(stdout); out.error ? done(fail(out.error, out.code)) : done(null, out.result); }
      catch { done(fail('The local PDF helper returned an unreadable response.', 503)); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ op, runtime: ROOT, ...doc, body, ...extra }));
  });
}
async function documentFor(url) {
  const materialPath = url.searchParams.get('path') || '';
  const paperId = url.searchParams.get('paperId') || '';
  let paper = paperId ? config.paper(paperId) : null, file, title, source;
  if (paperId && (!ID.test(paperId) || !paper)) throw fail('Paper not found', 404);
  if (paper) { file = paper.pdfPath; title = paper.title; source = paper.source; }
  else if (materialPath && config.material) {
    const material = await config.material(materialPath);
    file = material?.file; title = material?.name || path.basename(file || '');
    const real = file && fs.existsSync(file) ? fs.realpathSync(file) : '';
    paper = config.papers().find((p) => p.pdfPath && fs.existsSync(p.pdfPath) && fs.realpathSync(p.pdfPath) === real);
    if (paper) source = paper.source;
    else {
      const relative = path.relative(path.join(LF, 'data/academics'), file || '').split(path.sep);
      if (relative.length >= 4 && relative[0] !== '..') {
        source = { kind: 'course', term: relative[0], slug: relative[1], name: relative.at(-1) };
        if (relative[2] === 'sessions') source.date = relative[3];
      }
    }
  }
  if (!file || path.extname(file).toLowerCase() !== '.pdf' || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw fail('No PDF is available for this document', 404);
  const key = paper?.id || `material-${hash(fs.realpathSync(file)).slice(0, 32)}`;
  if (!ID.test(key)) throw fail('Invalid document identifier');
  return { key, paperId: paper?.id || null, pdfPath: file, source, title: title || paper?.title || path.basename(file), materialPath };
}
const storage = (doc) => localFile(path.join(ROOT, 'documents'), `${doc.key}.json`);
function remember(doc, envelope) {
  const history = localFile(path.join(ROOT, 'history', doc.key), `${envelope.revision}.json`);
  if (!fs.existsSync(history)) atomic(history, envelope.reading);
  atomic(storage(doc), envelope);
}
async function load(doc) {
  const existing = read(storage(doc));
  if (existing) {
    if (!plain(existing.reading) || !/^[a-f0-9]{64}$/.test(existing.revision || '')) throw fail('Reader annotations have an invalid format');
    return existing;
  }
  const seed = await bridge('seed', doc);
  return locked(doc.key, () => {
    const raced = read(storage(doc));
    if (raced) return raced;
    const envelope = { schema: 1, key: doc.key, paperId: doc.paperId, title: doc.title,
      pdfPath: doc.pdfPath, sourcePath: seed.sourcePath, reading: seed.reading,
      revision: hash(seed.reading), updated: seed.reading.updated || null };
    remember(doc, envelope);
    return envelope;
  });
}

function merge(base, current, incoming, where = '') {
  if (equal(base, incoming)) return current;
  if (equal(base, current) || equal(current, incoming)) return incoming;
  if (plain(base) && plain(current) && plain(incoming)) {
    const out = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(current), ...Object.keys(incoming)])) {
      const value = merge(base[key], current[key], incoming[key], `${where}.${key}`);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }
  if (ARRAYS.has(where.split('.').at(-1)) && [base, current, incoming].every(Array.isArray)) {
    const indexed = [base, current, incoming].map((rows) => new Map(rows.map((row) => [row.id, row])));
    if (indexed.some((m, i) => m.size !== [base, current, incoming][i].length || m.has(undefined))) throw fail('Annotations contain repeated or missing IDs');
    const out = [];
    for (const key of new Set([...indexed[1].keys(), ...indexed[2].keys(), ...indexed[0].keys()])) {
      const value = merge(indexed[0].get(key), indexed[1].get(key), indexed[2].get(key), `${where}[${key}]`);
      if (value !== undefined) out.push(value);
    }
    return out;
  }
  throw fail(`Another window changed ${where.replace(/^\./, '') || 'this reading'}. Your edits are preserved; reload after exporting a recovery copy.`, 409);
}
function projected(original, observed, incoming) {

  const result = { ...original };
  for (const key of new Set([...Object.keys(observed), ...Object.keys(incoming)])) {
    if (ARRAYS.has(key)) {
      const before = new Map((observed[key] || []).map((r) => [r.id, r]));
      const after = new Map((incoming[key] || []).map((r) => [r.id, r]));
      const originals = new Map((original[key] || []).map((r) => [r.id, r]));
      for (const id of before.keys()) if (!after.has(id)) originals.delete(id);
      for (const [id, row] of after) {
        if (before.has(id) && !originals.has(id) && !equal(before.get(id), row)) {
          throw fail('Another window deleted this annotation. Your edits are preserved; export a recovery copy before reloading.', 409);
        }
        const value = delta(originals.get(id), before.get(id), row);
        if (value === undefined) originals.delete(id); else originals.set(id, value);
      }
      result[key] = [...originals.values()];
    } else if (MAPS.has(key)) {
      result[key] = { ...(original[key] || {}) };
      for (const name of Object.keys(observed[key] || {})) if (!own(incoming[key] || {}, name)) delete result[key][name];
      for (const [name, value] of Object.entries(incoming[key] || {})) result[key][name] = delta(result[key][name], observed[key]?.[name], value);
    } else if (!['id', 'name', 'updated', 'revision'].includes(key)) {
      if (own(incoming, key)) result[key] = delta(original[key], observed[key], incoming[key]);
      else delete result[key];
    }
  }
  return result;
}
function delta(original, observed, incoming) {

  if (equal(observed, incoming)) return original;
  if (plain(observed) && plain(incoming)) {
    const out = plain(original) ? { ...original } : {};
    for (const key of new Set([...Object.keys(observed), ...Object.keys(incoming)])) {
      if (!own(incoming, key)) delete out[key];
      else out[key] = delta(original?.[key], observed[key], incoming[key]);
    }
    return out;
  }
  return incoming;
}
async function save(doc, body) {
  if (!plain(body.reading) || !plain(body.observed) || !/^[a-f0-9]{64}$/.test(body.revision || '')) throw fail('A reading and its base revision are required');
  for (const key of ARRAYS) {
    if (!Array.isArray(body.reading[key]) || body.reading[key].length > 5000) throw fail(`Invalid ${key}`);
    const ids = body.reading[key].map((r) => r?.id);
    if (ids.some((id) => typeof id !== 'string' || !id || id.length > 128) || new Set(ids).size !== ids.length) throw fail(`Invalid ${key} identifiers`);
  }

  const validating = { ...body.reading };
  const canonical = new Map();
  for (const key of ARRAYS) validating[key] = body.reading[key].map((row) => {
    const id = hash(`${key}:${row.id}`).slice(0, 40);
    canonical.set(`${key}:${id}`, row.id);
    return { ...row, id };
  });
  const normalized = await bridge('normalize', doc, validating);

  for (const key of ARRAYS) if (normalized[key].length !== body.reading[key].length) throw fail(`Some ${key} could not be saved. Export a recovery copy before editing them.`);
  const cleaned = { ...body.reading };
  for (const key of ARRAYS) {
    const valid = new Map(normalized[key].map((row) => {
      const id = canonical.get(`${key}:${row.id}`);
      if (!id) throw fail(`Some ${key} identifiers could not be validated`);
      return [id, { ...row, id }];
    }));
    if (valid.size !== body.reading[key].length) throw fail(`Some ${key} identifiers changed during validation`);
    cleaned[key] = body.reading[key].map((row) => {
      if (!valid.has(row.id)) throw fail(`An annotation identifier could not be validated`);
      return { ...row, ...valid.get(row.id) };
    });
  }
  for (const key of MAPS) {
    if (!plain(body.reading[key])) throw fail(`Invalid ${key}`);
    cleaned[key] = {};
    for (const [name, value] of Object.entries(body.reading[key])) {
      if (own(normalized[key], name)) {
        const valid = normalized[key][name];
        cleaned[key][name] = plain(value) && plain(valid)
          ? { ...(plain(body.observed[key]?.[name]) ? body.observed[key][name] : {}), ...value, ...valid }
          : valid;
      } else if (equal(value, body.observed[key]?.[name])) {

        cleaned[key][name] = value;
      } else throw fail(`Some ${key} could not be saved. Export a recovery copy before editing them.`);
    }
  }
  cleaned.pages = normalized.pages;
  return locked(doc.key, () => {
    const current = read(storage(doc));
    const base = read(localFile(path.join(ROOT, 'history', doc.key), `${body.revision}.json`));
    if (!current || !base) throw fail('The base revision is unavailable. Export your edits before reloading.', 409);
    let reading;
    try { reading = merge(base, current.reading, projected(base, body.observed, cleaned)); }
    catch (error) {
      atomic(localFile(path.join(ROOT, 'conflicts', doc.key), `${Date.now()}-${crypto.randomUUID()}.json`),
        { baseRevision: body.revision, currentRevision: current.revision, reading: body.reading, observed: body.observed });
      throw error;
    }
    reading.updated = new Date().toISOString();
    const saved = { ...current, paperId: doc.paperId, pdfPath: doc.pdfPath, title: doc.title, reading, revision: hash(reading), updated: reading.updated };
    remember(doc, saved);
    config.changed?.({ paperId: doc.paperId, key: doc.key, reading });
    return saved;
  });
}
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
async function bodyOf(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 20 * 1024 * 1024) throw fail('Reader request is too large', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail('Reader request must be JSON'); }
}
function file(req, res, target, download = false) {
  const size = fs.statSync(target).size;
  let start = 0, end = size - 1, code = 200;
  if (req.headers.range) {
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!range || !range[1] && !range[2]) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    if (!range[1]) start = Math.max(0, size - Number(range[2]));
    else { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    code = 206;
  }
  const headers = { 'Content-Type': 'application/pdf', 'Accept-Ranges': 'bytes', 'Content-Length': Math.max(0, end - start + 1),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(path.basename(target))}` };
  if (code === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(code, headers);
  if (req.method === 'HEAD' || !size) { res.end(); return; }
  const stream = fs.createReadStream(target, { start, end });
  stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
}

export function pageLookup(op, body = {}) {
  if (!['lookup', 'lookup-card'].includes(op)) throw fail('Unknown lookup');
  const paper = body.paperId && ID.test(String(body.paperId)) ? config.paper(String(body.paperId)) : null;
  return bridge(op, { key: paper?.id || 'lancetfish-page', paperId: paper?.id || null, title: String(paper?.title || body.where || 'Lancetfish').slice(0, 300) },
    { id: String(body.id || ''), term: String(body.term || '').slice(0, 2000), context: String(body.context || '').slice(0, 3000), provider: 'claude' });
}
export async function handleReader(req, res, url) {
  const page = /^\/reader\/(?:material|[a-zA-Z0-9_-]{1,120})$/.test(url.pathname);
  const asset = /^\/ui\/reader\.(js|css)$/.exec(url.pathname);
  if (req.method === 'GET' && (page || asset)) {
    const target = path.join(APP, 'ui', page ? 'reader.html' : `reader.${asset[1]}`);
    send(res, 200, fs.readFileSync(target), page ? 'text/html; charset=utf-8' : asset[1] === 'css' ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8'); return true;
  }
  if (!url.pathname.startsWith('/api/reader/')) return false;
  try {
    if (!['GET', 'HEAD'].includes(req.method) && !String(req.headers['content-type'] || '').startsWith('application/json')) throw fail('Reader requests must use JSON', 415);
    const doc = await documentFor(url);
    const op = url.pathname.slice('/api/reader/'.length);
    if (op === 'file' && ['GET', 'HEAD'].includes(req.method)) { file(req, res, doc.pdfPath, url.searchParams.get('download') === '1'); return true; }
    const envelope = await load(doc);
    if (op === 'document' && req.method === 'GET') send(res, 200, { ...doc, pdfPath: undefined, source: undefined, reading: undefined,
      back: doc.materialPath ? '/schedule' : '/library', detail: doc.paperId ? `/paper/${encodeURIComponent(doc.paperId)}` : null });
    else if (op === 'reading' && req.method === 'GET') send(res, 200, envelope);
    else if (op === 'reading' && req.method === 'PUT') send(res, 200, await save(doc, await bodyOf(req)));
    else if (op === 'reading.md' && req.method === 'GET') {
      const result = await bridge('markdown', doc, {}, { reading: envelope.reading });
      res.setHeader('Content-Disposition', `attachment; filename="${doc.key}-annotations.md"`);
      send(res, 200, result.text, 'text/markdown; charset=utf-8');
    } else if (op === 'toc' && req.method === 'GET') send(res, 200, await bridge('toc', doc));
    else if (op === 'words' && req.method === 'GET') {
      const page = Number(url.searchParams.get('page'));
      if (!Number.isInteger(page) || page < 1 || page > 20000) throw fail('Invalid PDF page');
      send(res, 200, await bridge('words', doc, { page }));
    } else if (['lookup', 'lookup-card', 'anki-sync'].includes(op) && req.method === 'POST') {
      send(res, 200, await bridge(op, doc, await bodyOf(req)));
    } else if (op === 'chat') {
      const target = localFile(path.join(ROOT, 'chats'), `${doc.key}.json`);
      const rows = read(target)?.messages || [];
      if (req.method === 'GET') send(res, 200, { messages: rows });
      else if (req.method === 'DELETE') {
        await locked(`${doc.key}-chat`, () => atomic(target, { messages: [] })); send(res, 200, { messages: [] });
      } else if (req.method === 'POST') {
        const body = await bodyOf(req);
        if (!String(body.message || '').trim()) throw fail('Write a question first');
        const revision = hash(rows);
        const answer = await bridge('chat', doc, body, { messages: rows });
        const messages = await locked(`${doc.key}-chat`, () => {
          const current = read(target)?.messages || [];
          if (hash(current) !== revision) throw fail('The conversation changed in another window. Please send again.', 409);
          const next = [...current, { role: 'reader', text: String(body.message).slice(0, 6000), page: body.page, selection: body.selection, created: new Date().toISOString() },
            { ...answer, created: new Date().toISOString() }].slice(-120);
          atomic(target, { messages: next }); return next;
        });
        send(res, 200, { messages });
      } else throw fail('Method not allowed', 405);
    } else throw fail('Reader endpoint not found', 404);
  } catch (error) { send(res, error.code || 400, { error: String(error.message || error) }); }
  return true;
}
