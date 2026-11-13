import fs from 'node:fs';
import path from 'node:path';
import { P, stat, trimText, normDoi } from './util.mjs';
import { openScience, scienceCopiedAt } from './sources/science.mjs';
import { readConfig } from './settings.mjs';

const TEXT_CAP = 2 * 1024 * 1024;
const TEXT_TYPES = /^(text\/|application\/(json|xml|x-ndjson|x-yaml))/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const iso = (ms) => (ms ? new Date(ms).toISOString() : '');
const parse = (s, fallback = {}) => { try { return JSON.parse(s) ?? fallback; } catch { return fallback; } };
const enabled = () => (readConfig().apps || {}).science !== false;

function withDb(fn, empty) {
  if (!enabled()) return { enabled: false, ...empty };
  const db = openScience(5000);
  if (!db) return { enabled: true, available: false, ...empty };
  try { return { enabled: true, available: true, ...fn(db) }; } finally { db.close(); }
}

const NOT_TYPED = /^\[(System|Memory|document|image)\b/i;
function userPrompts(m) {
  if (!m || m.role !== 'user' || m._harness_notice || m._system_hint) return [];
  const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
  return blocks.filter((b) => b.type === 'text' && b.text && b.text.trim() && !NOT_TYPED.test(b.text.trim())).map((b) => b.text.trim());
}

const artifactsDir = () => path.join(path.dirname(P.science), 'artifacts');

function storedFile(storagePath) {
  try {
    const base = fs.realpathSync(artifactsDir());
    const file = fs.realpathSync(path.resolve(base, String(storagePath || '')));
    return file.startsWith(base + path.sep) && fs.statSync(file).isFile() ? file : '';
  } catch { return ''; }
}

const kindOf = (a) => (a.is_user_upload ? 'upload' : a.is_intermediate ? 'working' : 'result');

function artifactRow(a) {
  return { id: a.id, filename: a.filename, type: a.content_type || '', size: a.size_bytes || 0, kind: kindOf(a),
    version: a.version_number || 1, versionId: a.latest_version_id || '', created: iso(a.created_at), updated: iso(a.version_at || a.created_at) };
}

const ARTIFACT_SQL = `select a.id, a.project_id, a.root_frame_id, a.filename, a.created_at, a.is_user_upload, a.latest_version_id,
  v.version_number, v.content_type, v.size_bytes, v.is_intermediate, v.created_at as version_at, v.storage_path
  from artifacts a left join artifact_versions v on v.id = a.latest_version_id`;

export function libraryKeys(papers) {
  const doi = {}, arxiv = {}, ssrn = {}, loose = {}, info = {};
  for (const p of papers) {
    if (p.doi) { doi[p.doi] = p.id; const k = p.doi.replace(/[^a-z0-9]/g, ''); loose[k] = k in loose && loose[k] !== p.id ? '' : p.id; }
    if (p.arxiv) arxiv[p.arxiv] = p.id;
    if (p.ssrn) ssrn[String(p.ssrn)] = p.id;
    if (p.doi || p.arxiv || p.ssrn) info[p.id] = { title: p.title, authors: p.authors, year: p.year, venue: p.venue };
  }
  return { doi, arxiv, ssrn, loose, info };
}

export function scienceTree(papers) {
  return withDb((db) => {
    const artifacts = db.prepare(`${ARTIFACT_SQL} order by a.created_at`).all();
    const byFrame = new Map();
    for (const a of artifacts) { if (!byFrame.has(a.root_frame_id)) byFrame.set(a.root_frame_id, []); byFrame.get(a.root_frame_id).push(artifactRow(a)); }
    const inputs = new Map(db.prepare(`select frame_id, body from frame_blobs where kind = 'input'`).all().map((r) => [r.frame_id, parse(r.body).request || '']));
    const prompts = new Map();
    for (const r of db.prepare(`select frame_id, msg_json from frame_messages where json_extract(msg_json, '$.role') = 'user'`).iterate()) {
      const n = userPrompts(parse(r.msg_json, null)).length;
      if (n) prompts.set(r.frame_id, (prompts.get(r.frame_id) || 0) + n);
    }
    const frames = db.prepare(`select id, name, status, project_id, conversation_type, model, task_summary, total_cost, input_tokens, output_tokens,
      created_at, updated_at, starred_at from frames where parent_frame_id is null and coalesce(is_hidden, 0) = 0 order by updated_at desc`).all();
    const memories = db.prepare(`select id, body, evidence, origin, subject_project_id, subject_artifact_id, source_frame_id, created_at, updated_at
      from memories where superseded_by is null order by updated_at desc`).all();
    const frameProject = new Map(frames.map((f) => [f.id, f.project_id]));
    const projects = db.prepare('select id, name, description, context, created_at, updated_at, archived_at from projects order by updated_at desc').all().map((p) => {
      const mine = frames.filter((f) => f.project_id === p.id);
      const conversations = mine.filter((f) => f.conversation_type !== 'uploads').map((f) => ({
        id: f.id, title: f.name || trimText(inputs.get(f.id) || 'Conversation', 80), status: f.status, model: f.model || '',
        request: trimText(inputs.get(f.id) || f.task_summary || '', 320), prompts: prompts.get(f.id) || 0,
        cost: f.total_cost || 0, tokensIn: f.input_tokens || 0, tokensOut: f.output_tokens || 0,
        created: iso(f.created_at), updated: iso(f.updated_at), starred: !!f.starred_at, artifacts: byFrame.get(f.id) || [],
      }));
      const uploads = mine.filter((f) => f.conversation_type === 'uploads').flatMap((f) => byFrame.get(f.id) || []);
      return {
        id: p.id, name: p.name || 'Untitled project', description: p.description || '', context: p.context || '',
        example: p.id === 'proj_example', archived: !!p.archived_at, created: iso(p.created_at),
        updated: iso(Math.max(p.updated_at, ...mine.map((f) => f.updated_at))), conversations, uploads,
        memories: memories.filter((m) => m.subject_project_id === p.id || (!m.subject_project_id && frameProject.get(m.source_frame_id) === p.id))
          .map((m) => ({ id: m.id, body: m.body, evidence: m.evidence, origin: m.origin, conversationId: m.source_frame_id || '', artifactId: m.subject_artifact_id || '', updated: iso(m.updated_at) })),
      };
    });

    projects.sort((a, b) => (a.example - b.example) || b.updated.localeCompare(a.updated));
    return { projects, library: libraryKeys(papers), copiedAt: iso(scienceCopiedAt()) };
  }, { projects: [], library: libraryKeys(papers) });
}

const STEP_LABEL = { python: 'Python', bash: 'Shell', repl: 'Host call', read_file: 'Read', edit_file: 'Wrote', write_file: 'Wrote',
  fetch_article_fulltext: 'Fetched full text', save_artifacts: 'Saved files', search_memory: 'Searched memory', read_memory: 'Read memory',
  write_memory: 'Saved a memory', skill: 'Loaded a skill', search_skills: 'Searched skills', web_search: 'Web search' };

function stepOf(b) {
  const inp = b.input || {};
  const detail = inp.doi || inp.file_path || (Array.isArray(inp.files) ? inp.files.join(', ') : '') || inp.query || inp.skill || '';
  return { tool: b.name, kind: STEP_LABEL[b.name] || String(b.name || 'tool').replace(/_/g, ' '),
    label: trimText(inp.human_description || detail || b.name, 160), detail: trimText(detail, 200), doi: inp.doi ? normDoi(inp.doi) : '' };
}

export function scienceConversation(id) {
  if (!UUID.test(String(id))) return { error: 'bad id' };
  return withDb((db) => {
    const f = db.prepare(`select id, name, status, project_id, model, effort, task_summary, total_cost, input_tokens, output_tokens, created_at, updated_at
      from frames where id = ? and parent_frame_id is null`).get(id);
    if (!f) return { missing: true };
    const blobs = Object.fromEntries(db.prepare(`select kind, body from frame_blobs where frame_id = ? and kind in ('input', 'output')`).all(id).map((r) => [r.kind, parse(r.body)]));
    const turns = [];
    let steps = null;
    const flush = () => { if (steps) { turns.push({ role: 'steps', items: steps }); steps = null; } };
    for (const row of db.prepare(`select m.msg_json from frame_messages m join frames f on f.id = m.frame_id
      where f.id = ? or f.root_frame_id = ? order by f.created_at, m.idx`).iterate(id, id)) {
      const m = parse(row.msg_json, null);
      if (!m || m._harness_notice || m._system_hint) continue;
      const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text && b.text.trim()) {
          const text = b.text.trim();
          if (m.role === 'user' && NOT_TYPED.test(text)) continue;
          flush();
          turns.push({ role: m.role === 'user' ? 'user' : 'assistant', text: text.slice(0, 200000), at: iso(m._ts) });
        } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
          (steps ||= []).push(stepOf(b));
        }
      }
    }
    flush();
    const project = db.prepare('select id, name from projects where id = ?').get(f.project_id) || {};
    return {
      conversation: { id: f.id, title: f.name || 'Conversation', status: f.status, model: f.model || '', effort: f.effort || '',
        projectId: f.project_id, project: project.name || '', created: iso(f.created_at), updated: iso(f.updated_at),
        cost: f.total_cost || 0, tokensIn: f.input_tokens || 0, tokensOut: f.output_tokens || 0,
        request: blobs.input?.request || '', response: blobs.output?.response || '', summary: f.task_summary || '' },
      turns,
      artifacts: db.prepare(`${ARTIFACT_SQL} where a.root_frame_id = ? order by a.created_at`).all(id).map(artifactRow),
    };
  }, {});
}

function versionRow(db, { id, version }) {
  if (version) return db.prepare(`select v.*, a.filename, a.project_id, a.root_frame_id, a.is_user_upload, a.latest_version_id
    from artifact_versions v join artifacts a on a.id = v.artifact_id where v.id = ?`).get(version);
  return db.prepare(`select v.*, a.filename, a.project_id, a.root_frame_id, a.is_user_upload, a.latest_version_id
    from artifacts a join artifact_versions v on v.id = a.latest_version_id where a.id = ?`).get(id);
}

export function scienceArtifact(q) {
  const key = { id: String(q.id || ''), version: String(q.version || '') };
  if (!UUID.test(key.id) && !UUID.test(key.version)) return { error: 'bad id' };
  return withDb((db) => {
    const v = versionRow(db, key);
    if (!v) return { missing: true };
    const file = storedFile(v.storage_path);
    const isText = TEXT_TYPES.test(v.content_type || '') || /\.(md|markdown|txt|csv|tsv|json|py|r|tex|bib|ya?ml)$/i.test(v.filename);
    let text = null, truncated = false;
    if (file && isText) {
      const size = fs.statSync(file).size;
      const fd = fs.openSync(file, 'r');
      try { const buf = Buffer.alloc(Math.min(size, TEXT_CAP)); fs.readSync(fd, buf, 0, buf.length, 0); text = buf.toString('utf8'); truncated = size > TEXT_CAP; } finally { fs.closeSync(fd); }
    }
    return {
      artifact: { id: v.artifact_id, filename: v.filename, type: v.content_type || '', size: v.size_bytes || 0, kind: kindOf(v),
        version: v.version_number, versionId: v.id, latest: v.id === v.latest_version_id, created: iso(v.created_at),
        projectId: v.project_id, conversationId: v.root_frame_id, onDisk: !!file },
      versions: db.prepare('select id, version_number, created_at, size_bytes from artifact_versions where artifact_id = ? order by version_number desc').all(v.artifact_id)
        .map((r) => ({ id: r.id, version: r.version_number, created: iso(r.created_at), size: r.size_bytes })),
      text, truncated,
    };
  }, {});
}

export function scienceFile(q) {
  const key = { id: String(q.id || ''), version: String(q.version || '') };
  if (!UUID.test(key.id) && !UUID.test(key.version)) return null;
  if (!enabled()) return null;
  const db = openScience(5000);
  if (!db) return null;
  try {
    const v = versionRow(db, key);
    const file = v ? storedFile(v.storage_path) : '';
    return file ? { file, filename: v.filename, type: v.content_type || '' } : null;
  } finally { db.close(); }
}
