import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { effectivePaths, readConfig, discoverVaults } from './settings.mjs';

const NOTE_LIMIT = 1024 * 1024;
const SCAN_LIMIT = 10000;
const BYTE_LIMIT = 64 * 1024 * 1024;
const skipped = new Set(['node_modules', '.git', '.obsidian', '.trash']);
const fail = (message, code = 400) => Object.assign(new Error(message), { code });
const norm = (text) => String(text || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const within = (root, target) => target === root || target.startsWith(root + path.sep);

export function vaultStatus() {
  const c = readConfig(), p = effectivePaths();
  if (c.apps?.obsidian === false) return { ready: false, reason: 'Obsidian is off in Settings.', path: '', name: '' };
  if (!p.obsidianVault) return { ready: false, reason: 'Choose a vault in Settings to search notes.', path: '', name: '' };
  try {
    const real = fs.realpathSync(p.obsidianVault);
    if (!fs.statSync(real).isDirectory() || !fs.statSync(path.join(real, '.obsidian')).isDirectory()) throw new Error();
    const known = discoverVaults().find((v) => path.resolve(v.path) === path.resolve(p.obsidianVault));
    return { ready: true, path: real, name: path.basename(p.obsidianVault), id: known?.id || '', folder: p.obsidianFolder };
  } catch { return { ready: false, reason: 'The selected vault is unavailable. Check its path in Settings.', path: p.obsidianVault, name: path.basename(p.obsidianVault) }; }
}

function vault() {
  const v = vaultStatus();
  if (!v.ready) throw fail(v.reason);
  return v;
}

function noteFile(v, relative) {
  if (typeof relative !== 'string' || !relative || relative.length > 4096 || path.isAbsolute(relative) || !relative.toLowerCase().endsWith('.md')) throw fail('Choose a Markdown note inside the selected vault.');
  if (relative.split(/[\\/]/).some((s) => !s || s.startsWith('.'))) throw fail('That note path is outside the visible vault.');
  const target = path.resolve(v.path, relative);
  if (!within(v.path, target)) throw fail('That note is outside the selected vault.', 403);
  let real;
  try { real = fs.realpathSync(target); } catch { throw fail('Note not found.', 404); }
  if (!within(v.path, real)) throw fail('Linked files outside the selected vault cannot be read.', 403);
  const st = fs.statSync(real);
  if (!st.isFile()) throw fail('Note not found.', 404);
  if (st.size > NOTE_LIMIT) throw fail('This note is larger than 1 MB. Open it in Obsidian to read it.');
  return { file: real, st };
}

function contentOf(text, name) {
  let body = text, frontmatter = '';
  if (text.startsWith('---\n') || text.startsWith('---\r\n')) {
    const end = text.indexOf('\n---', 4);
    if (end !== -1) { frontmatter = text.slice(4, end); body = text.slice(end + 4).replace(/^\s*\n/, ''); }
  }
  const h = body.match(/^#\s+(.+)$/m);
  const title = h ? h[1].trim() : name.replace(/\.md$/i, '');
  const links = [...body.matchAll(/\[\[([^\]\n]+)\]\]/g)].map((m) => m[1].split('|')[0].split('#')[0]).filter(Boolean);
  return { title, body, frontmatter, links: [...new Set(links)] };
}

function filesIn(v) {
  const queue = [''], notes = [];
  let truncated = false, visited = 0;
  while (queue.length && !truncated) {
    const dir = queue.shift();
    let entries;
    try { entries = fs.readdirSync(path.join(v.path, dir), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++visited > SCAN_LIMIT * 5) { truncated = true; break; }
      if (entry.name.startsWith('.') || skipped.has(entry.name) || entry.isSymbolicLink()) continue;
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push(rel);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        notes.push(rel);
        if (notes.length >= SCAN_LIMIT) { truncated = true; break; }
      }
    }
  }
  return { notes, truncated };
}

export function notesSearch(query = '') {
  const v = vaultStatus();
  if (!v.ready) return { vault: v, notes: [], total: 0, scanned: 0, truncated: false };
  const q = String(query).trim().slice(0, 300), tokens = norm(q).split(/\s+/).filter(Boolean);
  const { notes: files, truncated: fileCap } = filesIn(v);
  const matches = [];
  let bytes = 0, scanned = 0, truncated = fileCap, skippedCount = 0;
  for (const relative of files) {
    let st, text;
    try {
      const file = path.join(v.path, relative);
      st = fs.statSync(file);
      if (st.size > NOTE_LIMIT) { skippedCount++; continue; }
      bytes += st.size;
      if (bytes > BYTE_LIMIT) { truncated = true; break; }
      text = fs.readFileSync(file, 'utf8'); scanned++;
    } catch { skippedCount++; continue; }
    const parsed = contentOf(text, path.basename(relative));
    const title = norm(parsed.title), hay = norm(`${relative}\n${text}`);
    if (!tokens.every((t) => hay.includes(t))) continue;
    const at = tokens.length ? norm(parsed.body).indexOf(tokens[0]) : 0;
    const start = Math.max(0, at - 75);
    matches.push({
      path: relative.split(path.sep).join('/'), title: parsed.title,
      excerpt: parsed.body.slice(start, start + 250).replace(/\s+/g, ' ').trim(),
      updated: st.mtimeMs, links: parsed.links.length,
      score: tokens.reduce((n, t) => n + (title.includes(t) ? 10 : 0), 0) + (title === norm(q) ? 20 : 0),
    });
  }
  matches.sort((a, b) => b.score - a.score || b.updated - a.updated || a.title.localeCompare(b.title));
  return { vault: v, notes: matches.slice(0, 40), total: matches.length, scanned, truncated, skipped: skippedCount };
}

export function readNote(relativePath) {
  const v = vault(), { file, st } = noteFile(v, relativePath);
  const text = fs.readFileSync(file, 'utf8');
  return { vault: { name: v.name }, path: relativePath, updated: st.mtimeMs, ...contentOf(text, path.basename(relativePath)) };
}

export function noteUri(relativePath) {
  const v = vault(), { file } = noteFile(v, relativePath);

  return `obsidian://open?path=${encodeURIComponent(file)}`;
}

export async function openNote(relativePath) {
  if (process.platform !== 'darwin') throw fail('Opening Obsidian from the dashboard currently requires macOS.');
  const uri = noteUri(relativePath);
  await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/open', [uri], { stdio: 'ignore' });
    child.once('error', () => reject(fail('Obsidian could not be opened. Check that it is installed.')));
    child.once('close', (code) => code === 0 ? resolve() : reject(fail('Obsidian could not be opened. Open the app once to register its URI handler.')));
  });
  return { opened: relativePath };
}

function exportFolder(v) {
  const parts = String(v.folder || 'Papers').split(/[\\/]/);
  if (parts.some((s) => !s || s.startsWith('.')) || path.isAbsolute(v.folder)) throw fail('Choose a paper folder inside the vault in Settings.');
  let dir = v.path;

  for (const part of parts) {
    dir = path.join(dir, part);
    if (fs.existsSync(dir)) {
      const st = fs.lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory() || !within(v.path, fs.realpathSync(dir))) throw fail('The paper note folder must be a regular folder inside the selected vault.');
    } else fs.mkdirSync(dir);
  }
  return dir;
}

export function exportPaperNote(detail, options = {}) {
  const v = vault(), paper = detail?.paper;
  if (!paper || typeof paper.id !== 'string' || !/^[a-z0-9-]{1,100}$/.test(paper.id)) throw fail('Choose a paper from the library.');
  if (options.concepts !== undefined && !Array.isArray(options.concepts)) throw fail('Concept links must be a list of note names.');
  const concepts = [...new Set((options.concepts || []).map((s) => String(s).trim()).filter(Boolean))];
  if (concepts.length > 30 || concepts.some((s) => s.length > 200 || /[\[\]|#^\r\n\x00-\x1f]/.test(s) || s.split(/[\\/]/).some((p) => !p || p.startsWith('.')))) throw fail('Use up to 30 concept names without brackets, headings or relative paths.');
  const dir = exportFolder(v), file = path.join(dir, `${paper.id}.md`);
  const relative = path.relative(v.path, file).split(path.sep).join('/');
  if (fs.existsSync(file)) {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) throw fail('An existing item blocks this paper note. Nothing was changed.', 409);
    const previous = fs.readFileSync(file, 'utf8');
    const marker = `lancetfish_paper_id: ${JSON.stringify(paper.id)}`;
    if (!previous.startsWith('---\n') || !previous.split('\n---')[0].split('\n').includes(marker)) throw fail('A note already uses this file name. Nothing was changed.', 409);
    return { created: false, path: relative, message: 'This paper note already exists. Your changes were kept.' };
  }
  const plain = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim();
  const citation = `${(paper.authors || []).join(', ')}${paper.year ? ` (${paper.year})` : ''}. ${plain(paper.title)}.${paper.venue ? ` ${plain(paper.venue)}.` : ''}`;
  const lines = [
    '---', `paper: ${JSON.stringify(paper.id)}`, `lancetfish_paper_id: ${JSON.stringify(paper.id)}`,
    `title: ${JSON.stringify(plain(paper.title))}`, `doi: ${JSON.stringify(paper.doi || '')}`,
    `exported: ${JSON.stringify(new Date().toISOString())}`, 'tags: [paper]', '---', '',
    `# ${plain(paper.title)}`, '', citation, '',
    ...(paper.doi ? [`[DOI](https://doi.org/${encodeURI(paper.doi).replace(/[()]/g, (s) => encodeURIComponent(s))})`, ''] : []),
    `Source paper ID: \`${paper.id}\``, '',
    '## Concepts', '', concepts.length ? concepts.map((c) => `[[${c}]]`).join(' · ') : 'No concept links selected.', '',
    '## Highlights and comments', '',
  ];
  const highlights = Array.isArray(detail.highlights) ? detail.highlights : [];
  for (const h of highlights) {
    const id = plain(h.id), page = plain(h.page);
    lines.push(`### ${page ? `Page ${page}` : 'Highlight'}${id ? ` · ${id}` : ''}`, '');
    if (h.text) lines.push(...String(h.text).split('\n').map((line) => `> ${line}`), '');
    if (h.note) lines.push('Comment:', '', String(h.note), '');
    lines.push(`Provenance: paper \`${paper.id}\`${id ? `, highlight \`${id}\`` : ''}${page ? `, page ${page}` : ''}${h.created ? `, created ${plain(h.created)}` : ''}.`, '');
  }
  if (!highlights.length) lines.push('No highlights were recorded at export time.', '');
  lines.push('## Export record', '', 'Created by Lancetfish from the library record and reader marks. This is a snapshot. Later edits in this vault are kept; exports never overwrite an existing note.', '');

  try { fs.writeFileSync(file, lines.join('\n'), { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code === 'EEXIST') throw fail('A note appeared with this file name. Nothing was overwritten.', 409); throw e; }
  return { created: true, path: relative, highlights: highlights.length, concepts: concepts.length, sha256: crypto.createHash('sha256').update(lines.join('\n')).digest('hex') };
}
