import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(APP, '..', '..');
const expand = (s) => s === '~' ? HOME : s.startsWith('~/') ? path.join(HOME, s.slice(2)) : s;
export const SETTINGS_DATA = path.resolve(expand(process.env.LF_V2_DATA || path.join(APP, '.data')));
export const CONFIG_FILE = path.join(SETTINGS_DATA, 'config.json');
const exists = (p, kind) => { try { const s = fs.statSync(p); return kind === 'dir' ? s.isDirectory() : s.isFile(); } catch { return false; } };
const read = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const dirs = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } };
const error = (message) => Object.assign(new Error(message), { code: 400 });
const plain = (v) => v && typeof v === 'object' && !Array.isArray(v);

const APP_IDS = ['chatgpt', 'claude', 'claudeCode', 'codex', 'science', 'obsidian', 'anki'];
export function readConfig() {

  const off = Object.fromEntries(APP_IDS.map((id) => [id, false]));
  if (!fs.existsSync(CONFIG_FILE)) return { apps: off };
  const c = read(CONFIG_FILE);
  if (!plain(c)) throw error('Settings could not be read. Restore a valid config.json before saving.');
  c.apps = Object.fromEntries(APP_IDS.map((id) => [id, plain(c.apps) && c.apps[id] === true]));
  return c;
}

export function discoverVaults() {
  const registry = process.platform === 'darwin' ? path.join(HOME, 'Library/Application Support/obsidian/obsidian.json')
    : process.platform === 'win32' ? path.join(process.env.APPDATA || path.join(HOME, 'AppData/Roaming'), 'obsidian/obsidian.json')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'obsidian/obsidian.json');
  const data = read(registry);
  return Object.entries(data?.vaults || {}).filter(([, v]) => v && typeof v.path === 'string').map(([id, v]) => ({
    id, name: path.basename(v.path), path: v.path, exists: exists(v.path, 'dir'), open: !!v.open, lastOpened: Number(v.ts) || 0,
  })).sort((a, b) => Number(b.open) - Number(a.open) || b.lastOpened - a.lastOpened);
}

export function detectScienceDb() {
  const base = path.join(HOME, '.claude-science/orgs');
  return dirs(base).map((d) => path.join(base, d, 'operon-cli.db')).filter((p) => exists(p, 'file'))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || '';
}

export function effectivePaths() {
  const c = readConfig(), p = plain(c.paths) ? c.paths : {};
  const registeredVault = c.obsidian?.vaultId ? discoverVaults().find((v) => v.id === c.obsidian.vaultId && v.exists) : null;
  const resolved = (key, env, fallback) => expand(String(process.env[env] || p[key] || fallback));
  const root = resolved('root', 'LF_V2_ROOT', REPO);
  return {
    root,
    papersDir: resolved('papersDir', 'LF_V2_PAPERS', path.join(root, 'research/library')),
    inboxDir: resolved('inboxDir', 'LF_V2_INBOX', path.join(HOME, 'Papers/Inbox')),
    claudeProjects: resolved('claudeProjects', 'LF_V2_CLAUDE_PROJECTS', path.join(HOME, '.claude/projects')),
    codexSessions: resolved('codexSessions', 'LF_V2_CODEX_SESSIONS', path.join(HOME, '.codex/sessions')),
    scienceDb: resolved('scienceDb', 'LF_V2_SCIENCE_DB', detectScienceDb()),
    claudeLimits: resolved('claudeLimits', 'LF_V2_CLAUDE_LIMITS', path.join(HOME, '.cache/lancetfish/claude-limits.json')),
    calendar: resolved('calendar', 'LF_V2_CALENDAR', path.join(root, 'data/calendar/google-calendar.json')),
    obsidianVault: registeredVault?.path || expand(String(c.obsidian?.vaultPath || '')),
    obsidianFolder: String(c.obsidian?.paperFolder || 'Papers'),
    hubUrl: c.hubUrl || '',
    timezone: c.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  };
}

const APP_DEFS = [
  ['chatgpt', 'ChatGPT', 'ChatGPT', 'Link a conversation URL from a paper. History is not read from the app.'],
  ['claude', 'Claude', 'Claude', 'Link a conversation URL from a paper. History is not read from the app.'],
  ['claudeCode', 'Claude Code', null, 'Reads local conversation files.'],
  ['codex', 'Codex', 'Codex', 'Reads local conversation files.'],
  ['science', 'Claude Science', 'Claude Science', 'Reads a local database copy.'],
  ['obsidian', 'Obsidian', 'Obsidian', 'Links paper, study and write-up files in the chosen vault. Notes open in Obsidian.'],
  ['anki', 'Anki', 'Anki', 'Translate and vocabulary cards are available directly from the reader through AnkiConnect.'],
];

export function settings() {
  const config = readConfig(), effective = effectivePaths(), vaults = discoverVaults();
  const available = {
    claudeCode: exists(effective.claudeProjects, 'dir'), codex: exists(effective.codexSessions, 'dir'),
    science: exists(effective.scienceDb, 'file'), obsidian: vaults.some((v) => v.exists),
  };
  const apps = APP_DEFS.map(([id, name, appName, detail]) => {
    const installed = !!appName && [path.join('/Applications', `${appName}.app`), path.join(HOME, 'Applications', `${appName}.app`)].some((p) => exists(p, 'dir'));
    const detected = available[id] || installed;
    const enabled = typeof config.apps?.[id] === 'boolean' ? config.apps[id] : !!detected;
    return { id, name, detected: !!detected, installed, enabled, detail };
  });
  const selected = (id) => apps.find((a) => a.id === id)?.enabled;
  const source = (id, name, file, kind = 'dir', enabled = true) => {
    const found = !!file && exists(file, kind);
    return { id, name, path: file, enabled, available: found, status: !enabled ? 'Off' : found ? (kind === 'file' ? 'File available' : 'Folder available') : 'Not found' };
  };
  return {
    config, effective, configFile: CONFIG_FILE, dataDir: SETTINGS_DATA, detected: { vaults, scienceDb: detectScienceDb() }, apps,
    sources: [
      source('library', 'Library files', effective.papersDir),
      source('paperRecords', 'Paper records', path.join(effective.root, 'research/library/papers')),
      source('inbox', 'Paper inbox', effective.inboxDir),
      source('claudeCode', 'Claude Code history', effective.claudeProjects, 'dir', selected('claudeCode')),
      source('codex', 'Codex history', effective.codexSessions, 'dir', selected('codex')),
      source('science', 'Claude Science database', effective.scienceDb, 'file', selected('science')),
      source('calendar', 'Calendar cache', effective.calendar, 'file'),
      source('obsidian', 'Obsidian vault', effective.obsidianVault, 'dir', selected('obsidian')),
    ],
  };
}

export function saveSettings(input) {
  if (!plain(input)) throw error('Settings must be an object.');
  const next = readConfig();
  if (input.paths !== undefined) {
    if (!plain(input.paths)) throw error('Paths must be an object.');
    next.paths = { ...(next.paths || {}) };
    for (const key of ['root', 'papersDir', 'inboxDir', 'claudeProjects', 'codexSessions', 'scienceDb', 'claudeLimits', 'calendar']) {
      if (input.paths[key] === undefined) continue;
      if (typeof input.paths[key] !== 'string' || input.paths[key].length > 4096) throw error(`Invalid ${key} path.`);
      const value = expand(input.paths[key].trim());
      if (value && !path.isAbsolute(value)) throw error(`${key} needs an absolute path or a path starting with ~/.`);
      next.paths[key] = value;
    }
  }
  if (input.apps !== undefined) {
    if (!plain(input.apps)) throw error('Apps must be an object.');
    next.apps = { ...(next.apps || {}) };
    for (const [id] of APP_DEFS) if (input.apps[id] !== undefined) {
      if (typeof input.apps[id] !== 'boolean') throw error('App selection must be true or false.');
      next.apps[id] = input.apps[id];
    }
  }
  if (input.obsidian !== undefined) {
    if (!plain(input.obsidian)) throw error('Obsidian settings must be an object.');
    next.obsidian = { ...(next.obsidian || {}) };
    if (input.obsidian.vaultPath !== undefined) {
      if (typeof input.obsidian.vaultPath !== 'string' || input.obsidian.vaultPath.length > 4096) throw error('Invalid vault path.');
      const value = expand(input.obsidian.vaultPath.trim());
      if (value && (!path.isAbsolute(value) || !exists(value, 'dir') || !exists(path.join(value, '.obsidian'), 'dir'))) throw error('Choose an existing Obsidian vault with a .obsidian folder.');
      next.obsidian.vaultPath = value;
      next.obsidian.vaultId = value ? discoverVaults().find((v) => path.resolve(v.path) === path.resolve(value))?.id || '' : '';
    }
    if (input.obsidian.paperFolder !== undefined) {
      const value = String(input.obsidian.paperFolder).trim();
      if (!value || value.length > 300 || path.isAbsolute(value) || value.split(/[\\/]/).some((s) => !s || s === '.' || s === '..' || s.startsWith('.'))) throw error('Paper notes need a relative folder inside the vault, such as Papers.');
      next.obsidian.paperFolder = value;
    }
  }
  if (input.hubUrl !== undefined) {
    if (input.hubUrl === '' || input.hubUrl === null) { next.hubUrl = ''; } else {
    let u;
    try { u = new URL(input.hubUrl); } catch { throw error('Enter a valid research hub URL.'); }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw error('Research hub needs an http or https URL without credentials.');
    next.hubUrl = u.toString();
    }
  }
  if (input.timezone !== undefined) {
    if (typeof input.timezone !== 'string') throw error('Invalid time zone.');
    try { new Intl.DateTimeFormat('en-US', { timeZone: input.timezone }).format(); } catch { throw error('Enter a valid time zone, such as America/Chicago.'); }
    next.timezone = input.timezone;
  }

  fs.mkdirSync(SETTINGS_DATA, { recursive: true });
  const tmp = path.join(SETTINGS_DATA, `.config-${crypto.randomUUID()}.tmp`);
  try { fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, CONFIG_FILE); }
  finally { try { fs.unlinkSync(tmp); } catch {  } }
  return settings();
}
