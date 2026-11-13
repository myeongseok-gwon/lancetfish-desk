import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA } from './util.mjs';
import { vaultStatus } from './obsidian.mjs';

export const fail = (message, code = 400) => Object.assign(new Error(message), { code });
export const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
export const normalized = (value) => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const slash = (value) => value.split(path.sep).join('/');
export const within = (root, file) => file === root || file.startsWith(root + path.sep);
export const plain = (value) => String(value || '').replace(/[\r\n]+/g, ' ').trim();
export const START = '<!-- lancetfish:managed:start -->';
export const END = '<!-- lancetfish:managed:end -->';

function scalar(raw) {
  const value = raw.trim();
  try { return JSON.parse(value); } catch {  }
  if (value.startsWith('[') && value.endsWith(']')) return value.slice(1, -1).split(/,\s*/).map((s) => scalar(s)).filter(Boolean);
  return value.replace(/\s+#.*$/, '').replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
}

export function markdown(text, filename = '') {
  const meta = {}; let body = text;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (fm) {
    body = text.slice(fm[0].length); let key;
    for (const line of fm[1].split(/\r?\n/)) {
      const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
      if (field) { key = field[1]; meta[key] = field[2] ? scalar(field[2]) : []; }
      else if (key && /^\s+-\s+/.test(line)) {
        if (!Array.isArray(meta[key])) meta[key] = [];
        meta[key].push(scalar(line.replace(/^\s+-\s+/, '')));
      }
    }
  }
  const title = plain(meta.title || /^#\s+(.+)$/m.exec(body)?.[1] || path.basename(filename, '.md'));
  const links = [...text.matchAll(/\[\[([^\]\n|#^]+)(?:[^\]\n]*)\]\]/g)].map((m) => m[1].trim());
  return { meta, body, title, links: [...new Set(links)] };
}

export function listMarkdown(root, { skipDirectory = () => false, includeFile = () => true } = {}) {
  if (!fs.existsSync(root)) return [];
  const realRoot = fs.realpathSync(root); const result = []; const queue = ['']; let bytes = 0;
  while (queue.length) {
    const dir = queue.shift();
    for (const entry of fs.readdirSync(path.join(realRoot, dir), { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || ['node_modules', '90 Templates'].includes(entry.name) || entry.isSymbolicLink()) continue;
      const rel = path.join(dir, entry.name); const file = path.join(realRoot, rel);
      if (entry.isDirectory()) { if (!skipDirectory(slash(rel))) queue.push(rel); continue; }
      if (!entry.isFile() || !/\.md$/i.test(entry.name) || ['AGENTS.md', 'CLAUDE.md', 'README.md'].includes(entry.name)) continue;
      if (!includeFile(slash(rel))) continue;
      const stat = fs.statSync(file);
      if (stat.size > 1024 * 1024) throw fail(`The note ${rel} is larger than the 1 MB sync limit.`);
      bytes += stat.size;
      if (result.length >= 10000 || bytes > 64 * 1024 * 1024) throw fail('This Markdown collection exceeds the sync limit.');
      const text = fs.readFileSync(file, 'utf8');
      result.push({ path: slash(rel), file, text, sha: hash(text), ...markdown(text, rel) });
    }
  }
  return result;
}

export function selectedVault() {
  const v = vaultStatus();
  if (!v.ready) throw fail(v.reason);
  return v;
}

export function vaultPath(v, relative, { createParents = false } = {}) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || !/\.md$/i.test(relative)) throw fail('Choose a Markdown note inside the selected vault.');
  const parts = relative.split(/[\\/]/);
  if (parts.some((p) => !p || p.startsWith('.') || /[\x00-\x1f]/.test(p))) throw fail('The note path is outside the visible vault.', 403);
  let file = v.path;
  for (let i = 0; i < parts.length; i++) {
    file = path.join(file, parts[i]);
    let s; try { s = fs.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (s) {
      if (s.isSymbolicLink() || !within(v.path, fs.realpathSync(file)) || (i < parts.length - 1 ? !s.isDirectory() : !s.isFile())) throw fail('A linked or incompatible item blocks this note.', 409);
    } else if (createParents && i < parts.length - 1) fs.mkdirSync(file);
  }
  return file;
}

function manifestFile(v) { return path.join(DATA, 'knowledge', `${hash(v.path).slice(0, 16)}.json`); }
export function readManifest(v) {
  const file = manifestFile(v);
  if (!fs.existsSync(file)) return { version: 1, vault: v.path, nodes: {}, studies: {} };
  let m; try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw fail('Knowledge sync history is unreadable. Restore its JSON before syncing.', 409); }
  if (m.version !== 1 || m.vault !== v.path || !m.nodes || !m.studies) throw fail('Knowledge sync history does not match the selected vault.', 409);
  return m;
}
export function saveManifest(v, manifest) {
  const file = manifestFile(v); fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, file);
}
export const wiki = (relative, label = '') => `[[${relative.replace(/\.md$/i, '')}${label ? `|${plain(label).replace(/[\[\]|]/g, '')}` : ''}]]`;
export const uri = (v, relative) => `obsidian://open?path=${encodeURIComponent(vaultPath(v, relative))}`;

export function managedWrite(v, manifest, { id, relative, meta, body, links = [], sourceSha = '' }, dryRun = true) {
  const file = vaultPath(v, relative); const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const previous = manifest.nodes[id];
  const block = `${START}\n${body.replace(/\s+$/, '')}\n${END}`;
  let next;
  if (old !== null) {
    if (!previous || previous.path !== relative) return { id, path: relative, action: 'conflict', reason: 'Existing note is not managed by this sync.' };
    const start = old.indexOf(START), end = old.indexOf(END, start + START.length);
    if (start < 0 || end < 0 || old.indexOf(START, start + START.length) !== -1 || old.indexOf(END, end + END.length) !== -1) return { id, path: relative, action: 'conflict', reason: 'Managed markers changed. Your note was kept.' };
    const oldBlock = old.slice(start, end + END.length);
    if (hash(oldBlock) !== previous.blockSha) return { id, path: relative, action: 'conflict', reason: 'The managed content was edited in Obsidian. Your note was kept.' };
    next = old.slice(0, start) + block + old.slice(end + END.length);
  } else {
    const frontmatter = Object.entries({ ...meta, lancetfish_id: id, read: false }).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
    next = `---\n${frontmatter}\n---\n\n${block}\n\n## Personal notes\n\n`;
  }
  const action = old === null ? 'create' : next === old ? 'unchanged' : 'update';
  if (!dryRun) {
    if (action !== 'unchanged') {
      vaultPath(v, relative, { createParents: true });
      if (old === null) fs.writeFileSync(file, next, { flag: 'wx', mode: 0o600 });
      else {

        const backup = path.join(DATA, 'knowledge/backups', hash(v.path).slice(0,16), hash(old) + '.md');
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        if (!fs.existsSync(backup)) fs.writeFileSync(backup, old, { flag: 'wx', mode: 0o600 });
        if (fs.readFileSync(file, 'utf8') !== old) throw fail('A note changed during sync. Retry to keep that edit.', 409);
        const temporary = path.join(path.dirname(file), `.lancetfish-${crypto.randomUUID()}.tmp`);
        try {
          fs.writeFileSync(temporary, next, { flag: 'wx', mode: 0o600 });
          if (fs.readFileSync(file, 'utf8') !== old) throw fail('A note changed during sync. Retry to keep that edit.', 409);
          fs.renameSync(temporary, file);
        } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      }
    }
    manifest.nodes[id] = { path: relative, nodeType: meta.node_type, blockSha: hash(block), sourceSha, links, updated: new Date().toISOString() };
  }
  return { id, path: relative, nodeType: meta.node_type, action, links: links.length };
}
