import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { APP, LF, TZ, stat, refreshPaths } from './src/util.mjs';
import { store, build, search, paperDetail, addManualLink, removeManualLink, refreshDeckIndex, refreshReaderIndex, topicsForInbox } from './src/index.mjs';
import * as focus from './src/focus.mjs';
import * as inbox from './src/inbox.mjs';
import { cite } from './src/cite.mjs';
import { liveAgents } from './src/agents.mjs';
import { loadLimits } from './src/sources/limits.mjs';
import { loadCalendar } from './src/sources/calendar.mjs';
import { heatmap } from './src/sources/sittings.mjs';
import { settings, saveSettings, effectivePaths } from './src/settings.mjs';
import { askPaper, paperPrompt } from './src/chat-apps.mjs';
import { configureIntake, importCandidate, settleFiled } from './src/intake.mjs';
import { configureReader, handleReader, pageLookup } from './src/reader.mjs';
import { listMarks, addMark, updateMark, removeMark } from './src/marks.mjs';
import { configureKnowledge, knowledgeStatus, syncKnowledge, paperKnowledge, ensurePaperNode, openKnowledge,
  openKnowledgeSource, studyKnowledge, knowledgeStudy } from './src/knowledge.mjs';
import { scienceTree, scienceConversation, scienceArtifact, scienceFile } from './src/science-view.mjs';

const ENGINES = path.resolve(APP, '../../lib');
const here = (relative) => fs.existsSync(path.join(APP, relative));
const engine = (name) => fs.existsSync(path.join(ENGINES, `${name}.py`));
const FEATURES = {
  slides: here('src/slides.mjs') && here('ui/slides.html') && engine('presentations'),
  schedule: here('src/schedule.mjs') && here('ui/schedule.html') && engine('academics'),
  translate: engine('vocab'),
  study: here('src/knowledge-concept-worker.py') && engine('concepts'),
  readerChat: engine('llm_runtime'),
};
const absent = (what) => () => { throw Object.assign(new Error(`${what} is not part of this install`), { code: 404 }); };
const { scheduleView, scheduleDetail, scheduleFile, handleSchedule } = FEATURES.schedule ? await import('./src/schedule.mjs')
  : { scheduleView: absent('Schedule'), scheduleDetail: absent('Schedule'), scheduleFile: async () => null, handleSchedule: async () => false };
const { configureSlides, handleSlides } = FEATURES.slides ? await import('./src/slides.mjs') : { configureSlides: () => {}, handleSlides: async () => false };

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 4848;
const UI = path.join(APP, 'ui');
const DAILY_GOAL = 4;
const SCIENCE_CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'";
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.csv': 'text/plain; charset=utf-8', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
const PAGES = { '/': 'dashboard.html', '/library': 'library.html', '/inbox': 'inbox.html', '/science': 'science.html', '/schedule': 'schedule.html', '/slides': 'slides.html', '/settings': 'settings.html' };
configureSlides({ papers: () => store.papers, changed: refreshDeckIndex });
configureIntake({ papers: () => store.papers, changed: async () => {

  if (store.building) await store.building;
  await build(log); inbox.setLibrary(store.papers);
} });
configureReader({ paper: (id) => store.paperById.get(id), papers: () => store.papers,
  material: (relative) => scheduleFile(relative), changed: refreshReaderIndex });
configureKnowledge({ papers: () => store.papers, paperDetail });

const log = (...a) => console.log(new Date().toLocaleTimeString('en-US', { hour12: false }), ...a);

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 1e6) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('bad JSON')); } });
    req.on('error', reject);
  });
}

function serveFile(res, file, headers = {}) {
  const st = stat(file);
  if (!st || !st.isFile()) return send(res, 404, { error: 'not found' });
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(fs.readFileSync(file));
}

function streamFile(req, res, file, download = false, name = path.basename(file)) {
  const st = stat(file);
  if (!st?.isFile()) return send(res, 404, { error: 'not found' });
  let start = 0, end = st.size - 1, status = 200;
  if (req.headers.range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!m || (!m[1] && !m[2])) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    if (!m[1]) start = Math.max(0, st.size - Number(m[2]));
    else { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); }
    if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    status = 206;
  }
  const headers = { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes', 'Content-Length': Math.max(0, end - start + 1),
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}` };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || st.size === 0) return res.end();
  const input = fs.createReadStream(file, { start, end });
  input.on('error', () => res.destroy()); res.on('close', () => input.destroy());
  input.pipe(res);
}

function openPath(p, app = null) {
  const args = app ? ['-a', app] : [p];
  const child = spawn('/usr/bin/open', args, { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}

function dashboard() {
  const blocks = focus.blocks();
  const todays = focus.todayBlocks();
  const cal = loadCalendar();
  const agents = liveAgents().map((a) => {
    if (a.title) return a;
    const c = store.chats.find((x) => x.app === a.app && x.id === a.id);
    return { ...a, title: c ? c.title : (a.project || 'Session') };
  });
  return {
    now: Date.now(),
    focus: focus.state(),
    agents,
    limits: loadLimits(),
    today: {
      events: cal.upcoming,
      syncedAt: cal.syncedAt,
      blocks: todays.map((b) => ({ id: b.id, intent: b.intent, kind: b.kind, completed: b.completed, actualMinutes: b.actualMinutes, meanScore: b.meanScore })),
      completed: todays.filter((b) => b.completed).length,
      goal: DAILY_GOAL,
    },
    heatmap: heatmap(blocks),
  };
}

function found(result, what) {
  if (result.error) throw Object.assign(new Error(result.error), { code: 400 });
  if (result.missing) throw Object.assign(new Error(`No such Claude Science ${what}`), { code: 404 });
  return result;
}

const routes = {
  'GET /api/client-config': () => ({ features: FEATURES, timezone: TZ, hubUrl: effectivePaths().hubUrl, apps: Object.fromEntries(settings().apps.map((a) => [a.id, a.enabled])) }),
  'GET /api/settings': () => settings(),
  'GET /api/knowledge/status': () => knowledgeStatus(),
  'POST /api/knowledge/sync': (q, b) => syncKnowledge({ dryRun: b.dryRun !== false }),
  'GET /api/knowledge/paper': (q) => paperKnowledge(q.get('paperId') || ''),
  'POST /api/knowledge/paper': async (q, b) => {
    const detail = paperDetail(String(b.paperId || ''));
    if (!detail) throw new Error('No such paper');
    const result = ensurePaperNode(detail, { concepts: b.concepts });
    if (b.open) return { ...result, ...await openKnowledge(result.notePath) };
    return result;
  },
  'POST /api/knowledge/open': (q, b) => openKnowledge(String(b.path || '')),
  'POST /api/knowledge/open-source': (q, b) => {
    const note = b.noteId ? store.notes.find((n) => n.id === b.noteId) : null;
    const relative = note?.file ? path.relative(LF, note.file).split(path.sep).join('/') : String(b.path || '');
    return openKnowledgeSource(relative);
  },
  'POST /api/knowledge/study': (q, b) => {
    if (!FEATURES.study) absent('Study')();
    const detail = b.paperId ? paperDetail(String(b.paperId)) : null;
    if (b.paperId && !detail) throw new Error('No such paper');
    return studyKnowledge(detail, b);
  },
  'GET /api/knowledge/study': (q) => knowledgeStudy(q.get('id') || ''),
  'POST /api/settings': async (q, b) => {
    if (store.building) throw new Error('The index is rebuilding. Try saving again in a moment.');
    const result = saveSettings(b); refreshPaths();
    await build(log); inbox.setLibrary(store.papers);
    return result;
  },
  'GET /api/schedule': (q) => scheduleView(q.get('week') || '', q.get('term') || ''),
  'GET /api/schedule/detail': (q) => scheduleDetail(q.get('term') || '', q.get('slug') || ''),
  'GET /api/paper-prompt': (q) => {
    const p = store.paperById.get(q.get('paperId'));
    if (!p) throw new Error('No such paper');
    return { prompt: paperPrompt(p) };
  },
  'POST /api/ask-paper': (q, b) => askPaper(store.paperById.get(String(b.paperId || '')), b.app),
  'GET /api/marks': (q) => listMarks(q.get('page') || ''),
  'POST /api/marks': (q, b) => addMark(b),
  'POST /api/marks/update': (q, b) => updateMark(b),
  'POST /api/marks/remove': (q, b) => removeMark(b),
  'POST /api/marks/lookup': (q, b) => (FEATURES.translate ? pageLookup('lookup', b) : absent('Translate')()),
  'POST /api/marks/lookup-card': (q, b) => pageLookup('lookup-card', b),
  'GET /api/science': () => scienceTree(store.papers),
  'GET /api/science/conversation': (q) => found(scienceConversation(q.get('id') || ''), 'conversation'),
  'GET /api/science/artifact': (q) => found(scienceArtifact({ id: q.get('id'), version: q.get('version') }), 'file'),
  'GET /api/search': (q) => search(q.get('q') || '', q.get('type') || 'all', q.get('sort') || 'relevance'),
  'GET /api/stats': () => ({ ready: store.ready, builtAt: store.builtAt, ...store.stats }),
  'GET /api/dashboard': () => dashboard(),
  'GET /api/inbox': () => ({ ...inbox.inboxView(), inboxDir: effectivePaths().inboxDir, topics: store.ready ? topicsForInbox() : [] }),
  'POST /api/inbox/open-folder': () => { const dir = effectivePaths().inboxDir; fs.mkdirSync(dir, { recursive: true }); openPath(dir); return { opened: dir }; },
  'POST /api/focus/start': (q, b) => focus.start(b),
  'POST /api/focus/pause': () => focus.pause(),
  'POST /api/focus/resume': () => focus.resume(),
  'POST /api/focus/finish': () => focus.finish(),
  'POST /api/focus/discard': () => focus.discard(),
  'POST /api/focus/break': (q, b) => focus.takeBreak(b.minutes),
  'POST /api/focus/dismiss': () => focus.dismiss(),
  'POST /api/inbox/scan': () => { inbox.scan(new Set(store.papers.map((p) => p.sha256))).catch((e) => log('scan failed', e.message)); return inbox.scanState(); },
  'POST /api/inbox/read': (q, b) => inbox.aiRead(String(b.path || '')),
  'POST /api/inbox/read-next': (q, b) => inbox.aiReadNext(Number(b.n) || 5),
  'POST /api/inbox/decide': async (q, b) => {
    const filed = ['yes', 'fix'].includes(b.decision) ? await importCandidate(b) : null;
    const card = inbox.decide(b);
    if (filed?.removed) inbox.forget(String(b.path));
    return { ...card, ...(filed ? { filed } : {}) };
  },
  'POST /api/open': (q, b) => {
    if (b.paperId) {
      const p = store.paperById.get(String(b.paperId));
      if (!p || !p.pdfPath || !stat(p.pdfPath)) throw Object.assign(new Error('No PDF on disk for this paper'), { code: 404 });
      openPath(p.pdfPath);
      return { opened: path.basename(p.pdfPath) };
    }
    if (b.path) {
      const p = inbox.candidatePath(String(b.path));
      if (!p || !stat(p)) throw Object.assign(new Error('Not an inbox file'), { code: 404 });
      openPath(p);
      return { opened: path.basename(p) };
    }
    throw Object.assign(new Error('paperId or path required'), { code: 400 });
  },

  'POST /api/reveal': (q, b) => {
    const p = store.paperById.get(String(b.paperId || ''));
    if (!p || !p.pdfPath || !stat(p.pdfPath)) throw Object.assign(new Error('No PDF on disk for this paper'), { code: 404 });
    const child = spawn('/usr/bin/open', ['-R', p.pdfPath], { stdio: 'ignore', detached: true });
    child.on('error', () => {}); child.unref();
    return { revealed: p.pdfPath };
  },
  'POST /api/open-app': (q, b) => {
    const apps = { science: 'Claude Science' };
    const app = apps[b.app];
    if (!app) throw Object.assign(new Error('unknown app'), { code: 400 });
    if (!settings().apps.find((a) => a.id === b.app)?.enabled) throw new Error('Enable this app in Settings first');
    openPath(null, app);
    return { opened: app };
  },
  'POST /api/link-chat': (q, b) => addManualLink(b),
  'POST /api/unlink-chat': (q, b) => removeManualLink(b),
  'POST /api/reindex': async () => { await build(log); inbox.setLibrary(store.papers); return store.stats; },
};

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const host = String(req.headers.host || '');
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(res, 403, { error: 'forbidden host' });
  const key = `${req.method} ${url.pathname}`;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) return send(res, 403, { error: 'same-origin requests only' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: 'same-origin requests only' });
  }

  if (await handleReader(req, res, url)) return;
  if (await handleSchedule(req, res, url)) return;

  if (req.method === 'GET' && url.pathname === '/science') return serveFile(res, path.join(UI, 'science.html'), { 'Content-Security-Policy': SCIENCE_CSP });
  if (req.method === 'GET' && ((url.pathname === '/schedule' && !FEATURES.schedule) || (url.pathname.startsWith('/slides') && !FEATURES.slides))) { res.writeHead(302, { Location: '/' }); return res.end(); }
  if (req.method === 'GET' && PAGES[url.pathname]) return serveFile(res, path.join(UI, PAGES[url.pathname]));
  if (req.method === 'GET' && /^\/paper\/[a-z0-9-]{1,100}$/.test(url.pathname)) return serveFile(res, path.join(UI, 'paper.html'));
  if (req.method === 'GET' && /^\/slides\/[a-zA-Z0-9_-]{1,100}$/.test(url.pathname)) return serveFile(res, path.join(UI, 'slides.html'));
  if (req.method === 'GET' && url.pathname.startsWith('/ui/') && !['/ui/slides-editor.js', '/ui/slides-editor.css'].includes(url.pathname)) {
    const f = path.normalize(path.join(UI, url.pathname.slice(4)));
    if (!f.startsWith(UI + path.sep)) return send(res, 403, { error: 'forbidden' });
    return serveFile(res, f);
  }
  if (req.method === 'GET' && url.pathname === '/favicon.ico') return serveFile(res, path.join(UI, 'favicon.svg'));

  try {
    if (['GET', 'HEAD'].includes(req.method) && url.pathname.startsWith('/vendor/pdfjs/')) {
      const base = path.resolve(APP, '../hub/hub/static/vendor/pdfjs');
      const f = path.resolve(base, decodeURIComponent(url.pathname.slice('/vendor/pdfjs/'.length)));
      if (!f.startsWith(base + path.sep) || !/\.(mjs|wasm|bcmap|pfb|ttf|icc)$/.test(f)) return send(res, 404, { error: 'not found' });
      return streamFile(req, res, f);
    }
    if (['GET', 'HEAD'].includes(req.method) && url.pathname === '/api/pdf') {
      const p = url.searchParams.get('paperId');
      const file = p ? store.paperById.get(p)?.pdfPath : inbox.candidatePath(url.searchParams.get('path') || '');
      if (!file || path.extname(file).toLowerCase() !== '.pdf') return send(res, 404, { error: 'No PDF found' });
      return streamFile(req, res, file, url.searchParams.get('download') === '1');
    }
    if (['GET', 'HEAD'].includes(req.method) && url.pathname === '/api/schedule/file') {
      const doc = await scheduleFile(url.searchParams.get('path') || '');
      if (!doc) return send(res, 404, { error: 'not found' });
      return streamFile(req, res, doc.file, !doc.inline);
    }
    if (['GET', 'HEAD'].includes(req.method) && url.pathname === '/api/science/file') {
      const doc = scienceFile({ id: url.searchParams.get('id'), version: url.searchParams.get('version') });
      if (!doc) return send(res, 404, { error: 'No such Claude Science file' });

      const inline = /\.(pdf|png|jpe?g|gif|webp)$/i.test(doc.file) && url.searchParams.get('download') !== '1';
      return streamFile(req, res, doc.file, !inline, path.basename(doc.filename));
    }
    if (await handleSlides(req, res, url)) return;
    let m;
    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/paper\/([a-z0-9-]{1,100})$/))) {
      const d = paperDetail(m[1]);
      return d ? send(res, 200, d) : send(res, 404, { error: 'no such paper' });
    }
    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/cite\/([a-z0-9-]{1,100})$/))) {
      const p = store.paperById.get(m[1]);
      return p ? send(res, 200, await cite(p)) : send(res, 404, { error: 'no such paper' });
    }
    const fn = routes[key];
    if (!fn) return send(res, 404, { error: 'not found' });
    let body = {};
    if (req.method === 'POST') {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'JSON only' });
      body = await readBody(req);
    }
    return send(res, 200, await fn(url.searchParams, body));
  } catch (e) {
    return send(res, e.code && Number.isInteger(e.code) ? e.code : 400, { error: String(e.message || e) });
  }
}

const server = http.createServer((req, res) => { handle(req, res).catch((e) => send(res, 500, { error: String(e.message || e) })); });

server.listen(PORT, HOST, async () => {
  log(`Lancetfish v2 on http://${HOST}:${PORT}`);
  focus.startTicker();
  try {
    const settled = await settleFiled();
    if (settled.moved || settled.cleared) log(`filed papers: ${settled.moved} moved into the library folder, ${settled.cleared} originals cleared from the inbox`);
    await build(log);
    inbox.setLibrary(store.papers);

  } catch (e) { log('index build failed', e); }
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); process.exit(0); });
