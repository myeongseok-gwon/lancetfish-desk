import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DATA, parseFrontmatter } from './util.mjs';
import { effectivePaths } from './settings.mjs';
import { vaultStatus, openNote } from './obsidian.mjs';
import { fail, hash, normalized, slash, within, plain, markdown, listMarkdown, selectedVault, vaultPath, readManifest, saveManifest, wiki, uri, managedWrite } from './knowledge-files.mjs';

let adapters = { papers: () => null, paperDetail: () => null };
export function configureKnowledge(options = {}) { adapters = { ...adapters, ...options }; }
const list = (value) => (Array.isArray(value) ? value : value ? [value] : []).map(String);
const repo = () => effectivePaths().root;
const sourceRoots = ['research/takeaways', 'research/reviews', 'research/writeups', 'academics', 'research/programs'];
const programBlocked = new Set(['node_modules', '.venv', 'data', 'lab', 'prototype', 'conversations', 'instructions', 'templates', 'memory']);
const programName = /(?:writeup|write-up|proposal|synthesis|literature|design|report|brief|review)/i;
function blockedProgramDirectory(relative) {
  const parts = relative.split('/');
  if (parts.some((part) => part.startsWith('.') || programBlocked.has(part))) return true;
  const workbench = parts.indexOf('workbench');
  return workbench >= 0 && parts.length > workbench + 1 && parts[workbench + 1] !== 'meetings';
}
function programSource(relative) {
  const parts = relative.split('/');
  if (blockedProgramDirectory(parts.slice(0, -1).join('/')) || parts.some((part) => part.startsWith('_'))) return false;
  return programName.test(path.basename(relative)) || parts.includes('gaps');
}
const conceptTypes = new Set(['concept', 'model', 'method', 'theorem', 'distribution', 'study']);
const validId = (id) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,160}$/.test(id);
const managedPaperPath = (v, id) => slash(path.join(v.folder || 'Papers', `${id}.md`));
const managedWriteupPath = (relative) => `Writeups/${path.basename(relative, '.md').replace(/[\[\]|#^:]/g, '-')}-${hash(relative).slice(0,8)}.md`;

function paperRows() {
  const loaded = adapters.papers();
  if (Array.isArray(loaded)) return loaded;
  const root = path.join(repo(), 'research/library/papers');
  return listMarkdown(root).map((row) => {
    const { meta } = parseFrontmatter(row.text);
    return { ...meta, id: meta.id || path.basename(row.path, '.md'), confidence: meta.meta_confidence || '' };
  });
}
function paperOf(id) {
  const paper = paperRows().find((p) => p.id === id);
  if (!paper || !validId(paper.id)) throw fail('Choose a paper from the library.', 404);
  return paper;
}
function externalNodes(v) {
  return listMarkdown(v.path).filter((n) => !n.meta.lancetfish_id).map((n) => ({ ...n,
    nodeType: conceptTypes.has(String(n.meta.type)) ? 'study' : n.meta.node_type || n.meta.type || 'untyped',
    names: [...new Set([n.title, path.basename(n.path, '.md'), ...list(n.meta.aliases)])],
  }));
}
function existingConcept(nodes, term) {
  const target = normalized(term.replace(/^\[\[|\]\]$/g, '').replace(/\.md$/i, ''));
  const hits = nodes.filter((n) => n.text.trim() && n.nodeType === 'study' && n.names.some((s) => normalized(s) === target || normalized(n.path.replace(/\.md$/i, '')) === target));
  return hits.length === 1 ? hits[0] : null;
}
function readSource(relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some((p) => !p || p.startsWith('.')) || !/\.md$/i.test(relative)) throw fail('Choose a research or academic Markdown source.');
  if (!sourceRoots.some((r) => relative.startsWith(`${r}/`)) || (relative.startsWith('research/programs/') && !programSource(relative.slice('research/programs/'.length)))) throw fail('That source is outside permitted research writeups and academic notes.', 403);
  const root = fs.realpathSync(repo()); const absolute = path.join(root, relative);
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    let s; try { s = fs.lstatSync(current); } catch { throw fail('The source Markdown file was not found.', 404); }
    if (s.isSymbolicLink() || !within(root, fs.realpathSync(current))) throw fail('Linked Markdown outside the source roots is not synced.', 403);
  }
  const stat = fs.statSync(absolute);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw fail('That source is not a Markdown file below 1 MB.');
  const text = fs.readFileSync(absolute, 'utf8');
  return { path: relative, file: absolute, text, sha: hash(text), ...markdown(text, relative) };
}
function sourceRows() {
  const rows = [];
  for (const root of sourceRoots) {
    const absolute = path.join(repo(), root);
    if (!fs.existsSync(absolute)) continue;
    if (fs.lstatSync(absolute).isSymbolicLink() || !within(fs.realpathSync(repo()), fs.realpathSync(absolute))) throw fail('A knowledge source root is linked outside the repository.', 403);
    const options = root === 'research/programs' ? { skipDirectory: blockedProgramDirectory, includeFile: programSource } : {};
    const discovered = listMarkdown(absolute, options);
    if (root === 'research/programs' && discovered.length > 250) throw fail('The program writeup collection exceeds 250 sources. Narrow it before syncing.');
    for (const row of discovered) {
      if (path.basename(row.path).startsWith('_')) continue;
      if (root === 'academics' && !/(?:worked|conventions|midterm|prep|theory|review|writeup)/i.test(path.basename(row.path))) continue;
      rows.push({ ...row, path: `${root}/${row.path}` });
    }
  }
  return rows;
}
function references(source, papers, concepts) {
  const ids = new Set(); const conceptPaths = new Set(); const unresolved = [];
  const explicit = [...list(source.meta.papers), ...list(source.meta.paper), ...list(source.meta.paper_id)];
  const normalizedIds = explicit.map((s) => s.replace(/^\[\[|\]\]$/g, '').split('|')[0].split('/').pop().replace(/\.md$/i,''));
  for (const p of papers) {
    const cleanDoi = (value) => String(value).toLowerCase().replace(/[.,;:)]+$/, '');
    const doi = cleanDoi(p.doi || '');
    const sourceDois = [...source.text.matchAll(/10\.\d{4,9}\/[^\s<>\"\]]+/gi)].map((m) => cleanDoi(m[0]));
    const explicitWiki = source.links.some((target) => target === p.id || target === managedPaperPath({folder:'Papers'},p.id).replace(/\.md$/i,''));
    if (normalizedIds.includes(p.id) || explicitWiki || path.basename(source.path, '.md') === p.id || source.text.includes(`research/library/papers/${p.id}.md`) || (doi.length > 6 && sourceDois.includes(doi))) ids.add(p.id);
  }
  for (const name of [...list(source.meta.concepts), ...source.links]) {
    const hit = existingConcept(concepts, name);
    if (hit) conceptPaths.add(hit.path);
    else if (list(source.meta.concepts).includes(name)) unresolved.push(name);
  }
  for (const id of normalizedIds) if (!papers.some((p) => p.id === id)) unresolved.push(`paper:${id}`);
  return { papers: [...ids], concepts: [...conceptPaths], unresolved: [...new Set(unresolved)] };
}
function writeupPlan(v, source, papers, concepts) {
  const ref = references(source, papers, concepts);
  const explicitType = String(source.meta.node_type || source.meta.type || '');
  const knownAI = new Set(['marlin', 'codex', 'claude', 'claude-code', 'chatgpt', 'openai']);
  const ai = explicitType === 'ai-generated-writeup' || knownAI.has(String(source.meta.generated_by || '').toLowerCase()) || knownAI.has(String(source.meta.revised_by || '').toLowerCase()) || /\*\*Written by:\*\*\s*Marlin|\bWritten by Marlin\b/.test(source.text);
  const nodeType = ai ? 'ai-generated-writeup' : 'study-material';
  const relative = managedWriteupPath(source.path);
  const sourceLink = pathToFileURL(source.file).href;
  const links = [...ref.papers.map((id) => managedPaperPath(v,id)), ...ref.concepts];
  return { id: `writeup:${hash(source.path).slice(0,24)}`, relative, sourceSha: source.sha,
    meta: { type: nodeType, node_type: nodeType, title: source.title, source: source.path, source_path: source.file, source_sha256: source.sha,
      authorship: ai ? source.meta.generated_by || source.meta.revised_by || 'documented AI assistance' : 'unspecified',
      status: source.meta.status || 'reference', paper_ids: ref.papers, concepts: ref.concepts.map((p) => wiki(p)) },
    body: [`# ${source.title}`, '', `Source: [${source.path}](${sourceLink}). Original text is copied unchanged below.`, '',
      source.meta.status === 'draft' ? '> [!warning] Draft\n> This source is a draft. Importing it does not approve its claims or takeaway.' : '', '',
      `Source SHA-256: \`${source.sha}\`.`, '', '## Connections', '', links.length ? links.map((p) => `- ${wiki(p)}`).join('\n') : 'No explicit paper or concept links were found.', '',
      '## Source text', '', source.text].join('\n'), links, unresolved: ref.unresolved,
  };
}
function paperPlan(v, paper, writeups, manifest, detail = null, addConcepts = []) {
  const relative = managedPaperPath(v, paper.id); const previous = manifest.nodes[`paper:${paper.id}`];
  const related = writeups.filter((n) => n.meta.paper_ids.includes(paper.id));
  const conceptLinks = [...new Set([...(previous?.concepts || []), ...addConcepts, ...related.flatMap((n) => n.meta.concepts.map((s) => s.replace(/^\[\[|\]\]$/g, '') + '.md'))])];
  const links = [...new Set([...related.map((n) => n.relative), ...conceptLinks])];
  const lines = [`# ${plain(paper.title || paper.id)}`, '',
    `${list(paper.authors).join(', ')}${paper.year ? ` (${paper.year})` : ''}${paper.venue ? `. ${plain(paper.venue)}` : ''}`, '',
    `Library ID: \`${paper.id}\`. Metadata confidence: **${plain(paper.confidence || paper.meta_confidence || 'unknown')}**.`, '',
    `Metadata comes from the library record; this sync does not verify or approve it.`, '',
    ...(paper.doi ? [`[DOI](https://doi.org/${encodeURI(paper.doi).replace(/[()]/g, encodeURIComponent)})`, ''] : []),
    ...(paper.pdfPath && fs.existsSync(paper.pdfPath) ? [`[PDF](${pathToFileURL(paper.pdfPath).href})`, ''] : []),
    '## Writeups and concepts', '', links.length ? links.map((p) => `- ${wiki(p)}`).join('\n') : 'No explicit connections yet.', '',
  ];
  const highlights = detail?.highlights;
  if (Array.isArray(highlights)) {
    lines.push('## Reader marks', '');
    for (const h of highlights) lines.push(`### Page ${plain(h.page || '?')}${h.id ? ` · ${plain(h.id)}` : ''}`, '', ...(h.text ? String(h.text).split('\n').map((s) => `> ${s}`) : []), '', ...(h.note ? [`Comment: ${String(h.note)}`, ''] : []));
  }
  return { id: `paper:${paper.id}`, relative, meta: { type: 'paper', node_type: 'paper', title: plain(paper.title || paper.id), paper_id: paper.id,
    lancetfish_paper_id: paper.id, doi: paper.doi || '', source: 'Lancetfish library', meta_confidence: paper.confidence || paper.meta_confidence || 'unknown' }, body: lines.join('\n'), links, concepts: conceptLinks };
}

export function knowledgeStatus() {
  const v = vaultStatus();
  if (!v.ready) return { vault: v, ready: false, counts: {}, sources: sourceRoots };
  const m = readManifest(v), external = externalNodes(v), sources = sourceRows();
  const counts = {};
  for (const n of [...external, ...Object.values(m.nodes)]) counts[n.nodeType] = (counts[n.nodeType] || 0) + 1;
  return { ready: true, vault: v, counts, sources: sourceRoots, sourceCount: sources.length, paperCount: paperRows().length, lastSync: m.lastSync || null,
    convention: 'node_type, papers, concepts, generated_by', externalOnly: true };
}

export function syncKnowledge({ dryRun = true, paperIds } = {}) {
  if (typeof dryRun !== 'boolean' || (paperIds !== undefined && (!Array.isArray(paperIds) || paperIds.some((id) => !validId(id))))) throw fail('Use a boolean dryRun and a list of paper IDs.');
  const v = selectedVault(), manifest = readManifest(v), papers = paperRows(), concepts = externalNodes(v);
  const writeups = sourceRows().map((s) => writeupPlan(v,s,papers,concepts));
  const selected = paperIds ? papers.filter((p) => paperIds.includes(p.id)) : papers;
  const relevant = paperIds ? writeups.filter((n) => n.meta.paper_ids.some((id) => paperIds.includes(id))) : writeups;
  const plans = [...relevant, ...selected.map((p) => paperPlan(v,p,writeups,manifest,adapters.paperDetail(p.id)))];
  if (!paperIds) plans.push({ id: 'map:knowledge', relative: 'Lancetfish knowledge.md', meta: { type: 'moc', node_type: 'knowledge-map', title: 'Lancetfish knowledge' },
    body: ['# Lancetfish knowledge', '', 'One vault for papers, writeups and study. Existing concept notes keep their original types and content.', '', '## Papers', '',
      ...selected.map((p) => `- ${wiki(managedPaperPath(v,p.id),p.title)}`), '', '## Writeups and study material', '', ...writeups.map((n) => `- ${wiki(n.relative,n.meta.title)}`), '',
      '## Existing study notes', '', ...concepts.filter((n) => n.nodeType === 'study').map((n) => `- ${wiki(n.path,n.title)}`)].join('\n'), links: plans.map((p) => p.relative) });
  const changes = plans.map((plan) => {
    const result = managedWrite(v,manifest,plan,dryRun);
    if (!dryRun && result.action !== 'conflict' && plan.concepts) manifest.nodes[plan.id].concepts = plan.concepts;
    return result;
  });
  const summary = changes.reduce((out,n) => { out[n.action] = (out[n.action] || 0) + 1; return out; }, {});
  const report = { dryRun, vault: { name: v.name, path: v.path }, summary, sources: writeups.length, papers: selected.length,
    explicitLinks: plans.reduce((n,p) => n+p.links.length,0), unresolved: relevant.flatMap((p) => p.unresolved.map((name) => ({ source:p.meta.source, name }))), changes };
  if (!dryRun) { manifest.lastSync = new Date().toISOString(); manifest.lastReport = { ...summary, explicitLinks: report.explicitLinks }; saveManifest(v,manifest); }
  return report;
}

export function paperKnowledge(paperId) {
  const v = vaultStatus(); if (!v.ready) return { ready: false, reason: v.reason, notes: [] };
  paperOf(paperId); const m = readManifest(v); const n = m.nodes[`paper:${paperId}`];
  return { ready: true, vault: v.name, notePath: n?.path || '', notes: Object.entries(m.nodes).filter(([id,row]) => id === `paper:${paperId}` || row.links?.includes(managedPaperPath(v,paperId))).map(([id,row]) => ({ id, path:row.path, nodeType:row.nodeType, uri:uri(v,row.path) })) };
}

export function ensurePaperNode(detail, { concepts = [] } = {}) {
  const paper = detail?.paper; if (!paper || !validId(paper.id)) throw fail('Choose a paper from the library.');
  const v=selectedVault(), manifest=readManifest(v), nodes=externalNodes(v), papers=paperRows();
  if (!Array.isArray(concepts) || concepts.length > 30) throw fail('Use up to 30 existing concept titles.');
  const conceptPaths=concepts.map((name) => { const hit=existingConcept(nodes,String(name)); if (!hit) throw fail(`No unique existing concept named ${plain(name)}. Study it first.`); return hit.path; });
  const writeups=sourceRows().map((s) => writeupPlan(v,s,papers,nodes));
  const currentDetail=Array.isArray(detail.highlights)?detail:adapters.paperDetail(paper.id)||detail;
  for(const linked of writeups.filter((n)=>n.meta.paper_ids.includes(paper.id))) managedWrite(v,manifest,linked,false);
  const plan=paperPlan(v,paper,writeups,manifest,currentDetail,conceptPaths), result=managedWrite(v,manifest,plan,false);
  if (result.action === 'conflict') throw fail(result.reason,409);
  manifest.nodes[plan.id].concepts=plan.concepts; saveManifest(v,manifest);
  return { ...result, notePath:result.path, uri:uri(v,result.path), created:result.action==='create' };
}
export async function openKnowledge(relative) {
  const v=selectedVault(); const file=vaultPath(v,relative);
  if (!fs.existsSync(file)) throw fail('The linked note was moved or deleted. Sync it again.',404);
  return { ...await openNote(relative), notePath:relative, uri:uri(v,relative) };
}
export async function openKnowledgeSource(relative) {
  const source=readSource(relative), v=selectedVault(), manifest=readManifest(v), papers=paperRows();
  const plan=writeupPlan(v,source,papers,externalNodes(v)), result=managedWrite(v,manifest,plan,false);
  if(result.action === 'conflict') throw fail(result.reason,409);
  saveManifest(v,manifest);
  return { ...result, ...await openKnowledge(result.path) };
}

export { studyKnowledge, knowledgeStudy } from './knowledge-study.mjs';
