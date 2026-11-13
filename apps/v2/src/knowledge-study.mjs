import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA } from './util.mjs';
import { effectivePaths } from './settings.mjs';
import { fail, hash, plain, wiki, uri, selectedVault, readManifest, saveManifest, managedWrite, listMarkdown, normalized, vaultPath } from './knowledge-files.mjs';
import { ensurePaperNode, openKnowledge } from './knowledge.mjs';

const moduleRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const active=new Map();
const apiVars=['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_API_KEY','OPENAI_API_KEY','CODEX_API_KEY'];

function jobFile(id) {
  if(typeof id!=='string'||!/^study-[a-f0-9-]{36}$/.test(id)) throw fail('No such study request.',404);
  return path.join(DATA,'knowledge/studies',`${id}.json`);
}
function saveJob(job) {
  const file=jobFile(job.id);fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=`${file}.${crypto.randomUUID()}.tmp`;fs.writeFileSync(tmp,JSON.stringify(job,null,2)+'\n',{mode:0o600});fs.renameSync(tmp,file);
}
function requestPlan(job, record=null) {
  const notePath=job.notePath||record?.main_rel||'';
  const links=[job.paperPath,notePath].filter(Boolean);
  const lines=[`# Study: ${plain(job.term)}`,'',`Status: **${plain(job.status)}**. Provider: ${job.provider}.`,'',
    ...(job.paperPath?[`Paper: ${wiki(job.paperPath,job.paperTitle)}`,'']:[]),
    ...(job.sourcePath?[`Writeup source: \`${job.sourcePath}\``,'']:[]),
    ...(job.page?[`Reader page: ${job.page}`,'']:[]),
    ...(job.question?['## Question','',job.question,'']:[]),
    ...(job.context?['## Reading context','',job.context,'']:[]),
    ...(notePath?['## Study note','',wiki(notePath),'']:[]),
    ...(record?.path?.length?['## Prerequisites and reading order','',...record.path.filter((n)=>n.exists&&n.rel).map((n)=>`- ${wiki(n.rel,n.title)}`),'']:[]),
    ...(job.error?['## Result','',job.error,'']:[])];
  return {id:`study:${job.id}`,relative:`Study requests/${job.id}.md`,meta:{type:'study-request',node_type:'study-request',title:`Study: ${plain(job.term)}`,paper_id:job.paperId||'',source:job.sourcePath||'v2-reader',provider:job.provider},body:lines.join('\n'),links};
}
function updateRequest(job,record=null) {
  const v=selectedVault();if(v.path!==job.vault) throw fail('Switch back to this request’s vault to open its result.',409);
  const m=readManifest(v), plan=requestPlan(job,record),result=managedWrite(v,m,plan,false);
  if(result.action!=='conflict') {m.studies[job.id]={path:result.path,term:job.term,paperId:job.paperId,status:job.status};saveManifest(v,m);}
  return result;
}
function publicJob(job) {
  const v=selectedVault();if(v.path!==job.vault) throw fail('This study request belongs to a different vault.',409);
  return {id:job.id,status:job.status,term:job.term,provider:job.provider,notePath:job.notePath||'',path:job.path||[],error:job.error||'',
    requestPath:`Study requests/${job.id}.md`,uri:job.notePath?uri(v,job.notePath):'',conceptRequestId:job.conceptRequestId||''};
}
function exactConcept(v,term) {
  const target=normalized(term);
  const matches=listMarkdown(v.path).filter((n)=>!n.meta.lancetfish_id&&n.text.trim()&&['concept','model','method','theorem','distribution','study'].includes(String(n.meta.type)))
    .filter((n)=>[n.title,path.basename(n.path,'.md'),...(Array.isArray(n.meta.aliases)?n.meta.aliases:n.meta.aliases?[n.meta.aliases]:[])].some((s)=>normalized(s)===target));
  return matches.length===1?matches[0]:null;
}
function finish(job,record) {
  job.status=record.status==='done'?'done':record.status||'error';job.error=record.error||'';
  job.notePath=record.main_rel||'';job.path=record.path||[];
  if(job.status==='done'&&job.notePath) {
    const v=selectedVault();vaultPath(v,job.notePath);
    if(job.paper) {
      try {ensurePaperNode({paper:job.paper}, {concepts:[path.basename(job.notePath,'.md')]});}
      catch(error) {job.linkWarning=error.message;}
    }
  }
  updateRequest(job,record);saveJob(job);active.delete(job.id);
}

export async function studyKnowledge(detail, input={}) {
  const v=selectedVault();const term=String(input.term||'').replace(/\s+/g,' ').trim();
  if(!term||term.length>300) throw fail('Select a concept name of 1–300 characters.');
  const provider=input.provider||'claude';if(!['claude','codex'].includes(provider)) throw fail('Choose Claude or Codex for concept study.');
  const paper=detail?.paper;
  if(paper&&(!paper.id||!/^[-a-z0-9]{1,161}$/.test(paper.id))) throw fail('Choose a paper from the library.');
  const hit=exactConcept(v,term);
  if(hit) {
    if(paper) ensurePaperNode(detail,{concepts:[hit.title]});
    return {id:'',status:'existing',term,notePath:hit.path,path:[{title:hit.title,rel:hit.path,exists:true}],...await openKnowledge(hit.path)};
  }
  const job={id:`study-${crypto.randomUUID()}`,vault:v.path,root:effectivePaths().root,term,provider,status:'queued',created:new Date().toISOString(),
    paper,paperId:paper?.id||'',paperTitle:paper?.title||'',paperPath:'',sourcePath:String(input.sourcePath||'').slice(0,4096),
    question:String(input.question||'').slice(0,2000),context:String(input.context||'').slice(0,3000),page:Number.isInteger(Number(input.page))&&Number(input.page)>0?Number(input.page):null};
  if(paper) job.paperPath=ensurePaperNode(detail).path;
  updateRequest(job);saveJob(job);
  const payload={vault:v.path,runtime:path.join(DATA,'knowledge/concepts'),term,provider,question:job.question,context:job.context,where:[job.paperTitle,job.paperId,job.page?`page ${job.page}`:'',job.sourcePath].filter(Boolean).join(' · ')};
  const env={...process.env,LANCETFISH_ROOT:job.root,PYTHONDONTWRITEBYTECODE:'1'};for(const key of apiVars)delete env[key];
  const child=spawn(process.env.LANCETFISH_PYTHON||'python3',['-B','-u',path.join(moduleRoot,'apps/v2/src/knowledge-concept-worker.py')],{cwd:moduleRoot,env,stdio:['pipe','pipe','pipe']});
  job.pid=child.pid;saveJob(job);active.set(job.id,child);
  let pending='',stderr='',finished=false;
  const timeout=setTimeout(()=>{job.status='error';job.error='Concept study timed out. Retry from the reader.';saveJob(job);child.kill('SIGTERM');},22*60*1000);timeout.unref();
  child.stderr.on('data',(data)=>{stderr=(stderr+data.toString()).slice(-2000);});
  child.stdout.on('data',(data)=>{
    pending+=data.toString();let newline;
    while((newline=pending.indexOf('\n'))>=0){
      const line=pending.slice(0,newline);pending=pending.slice(newline+1);
      let event;try{event=JSON.parse(line);}catch{continue;}
      if(event.event==='queued'){job.conceptRequestId=event.id;job.status='queued';saveJob(job);}
      if(event.event==='running'){job.conceptRequestId=event.id;job.status='running';saveJob(job);}
      if(event.event==='result'){finished=true;try{finish(job,event.record);}catch(error){job.status='error';job.error=error.message;saveJob(job);}}
      if(event.event==='error'){finished=true;job.status='error';job.error=event.error;saveJob(job);try{updateRequest(job);}catch{}}
    }
  });
  child.on('error',(error)=>{finished=true;job.status='error';job.error=`Concept study could not start: ${error.message}`;saveJob(job);active.delete(job.id);});
  child.on('close',(code)=>{clearTimeout(timeout);active.delete(job.id);if(!finished){job.status='error';job.error=job.error||`Concept study stopped (${code??'interrupted'}). ${stderr}`;saveJob(job);try{updateRequest(job);}catch{}}});
  child.stdin.on('error',()=>{});
  child.stdin.end(JSON.stringify(payload));
  return publicJob(job);
}

export function knowledgeStudy(id) {
  let job;try{job=JSON.parse(fs.readFileSync(jobFile(id),'utf8'));}catch(error){if(error.code===404)throw error;throw fail('No such study request.',404);}
  const v=selectedVault();if(v.path!==job.vault)throw fail('This study request belongs to a different vault.',409);
  if(['queued','running'].includes(job.status)) {
    if(job.conceptRequestId&&/^[A-Za-z0-9_-]{6,40}$/.test(job.conceptRequestId)) {
      const file=path.join(DATA,'knowledge/concepts/requests',`${job.conceptRequestId}.json`);
      if(fs.existsSync(file)) {
        const record=JSON.parse(fs.readFileSync(file,'utf8'));
        if(!['queued','running'].includes(record.status))finish(job,record);
      }
    }
    if(['queued','running'].includes(job.status)&&!active.has(job.id)) {
      let alive=false;try{if(job.pid){process.kill(job.pid,0);alive=true;}}catch{}
      if(!alive){job.status='interrupted';job.error='The study worker stopped before finishing. Retry from the reader.';saveJob(job);updateRequest(job);}
    }
  }
  return publicJob(job);
}
