'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events');
const {SqliteSessionSearchIndex}=require('../core/session-search-sqlite-index');
const {HubMemoryService,readJSON}=require('../core/hub-memory-service');
const history=require('../core/memory-history');

function setup(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-memory-unit-'));
  const cwd=path.join(root,'project'),home=path.join(root,'home');
  fs.mkdirSync(cwd);fs.mkdirSync(path.join(cwd,'.git'));fs.mkdirSync(home);
  fs.writeFileSync(path.join(cwd,'AGENTS.md'),'# 手写规则不能被改\n','utf8');
  const index=new SqliteSessionSearchIndex(path.join(root,'search.sqlite'));
  const add=(key,text,cwdOverride=cwd)=>index.replaceSource({key,signature:'sig-'+key,
    session:{key,provider:'codex',kind:'codex',title:key,cwd:cwdOverride,hubSessionId:key,updatedAt:Date.now()},
    docs:[{eventId:key+'-user',scope:'user',role:'user',ordinal:0,timestamp:Date.now(),text}]});
  add('source','用户确认：记忆页不需要会话列表。');
  const sessions=new Map([['normal',{id:'normal',title:'当前会话',kind:'codex',cwd,codexSid:'native-1',nativeRuntime:{state:'idle'}}]]);
  const tap=new EventEmitter();let seq=0;
  const service=new HubMemoryService({dataDir:path.join(root,'data'),homeDir:home,transcriptTap:tap,
    sessionManager:{getSession:id=>sessions.get(id)},workspaceService:{getWorkspaceRoot:()=>cwd},
    getPersistedSessions:()=>[...sessions.values()],
    searchService:{memoryCandidates:r=>history.candidates(index,r),exportMemoryHistory:r=>history.exportHistory(index,r)},
    createSession:async(kind,opts)=>{const s={...opts,id:'dream-'+(++seq),kind,nativeRuntime:{state:'idle'}};sessions.set(s.id,s);return s;},
    sendPrompt:async()=>({ok:true}),logger:console});
  t.after(()=>{index.close();fs.rmSync(root,{recursive:true,force:true});});
  const start=()=>service.start({sessionId:'normal',keys:['source'],kind:'codex',opts:{model:'gpt-6-astra',effort:'medium'}});
  const output=(j,changes={})=>{const dir=path.join(j.dir,'output');fs.mkdirSync(path.join(dir,'topics'),{recursive:true});
    fs.writeFileSync(path.join(dir,'DREAM_INDEX.md'),changes.index||'# 梦境\n- [交互偏好](topics/preferences.md)：设计记忆页时读取\n','utf8');
    fs.writeFileSync(path.join(dir,'topics/preferences.md'),'不显示会话列表。来源 source / source-user。','utf8');
    fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({status:'complete',processedFiles:j.inputFiles,summary:'保留界面偏好',...changes.result}));};
  return {root,cwd,home,index,add,service,sessions,tap,start,output};
}

test('history exports full stored text, provenance and project boundaries from one snapshot',t=>{
  const f=setup(t),large='原始正文'.repeat(45000);f.add('large',large);f.add('foreign','不可导出',f.cwd+'-other');
  assert.deepEqual(new Set(history.candidates(f.index,{cwd:f.cwd}).map(x=>x.key)),new Set(['source','large']));
  const outputDir=path.join(f.root,'raw');const m=history.exportHistory(f.index,{cwd:f.cwd,keys:['large','source'],outputDir});
  const lines=m.files.flatMap(n=>fs.readFileSync(path.join(outputDir,n),'utf8').trim().split('\n').map(JSON.parse));
  assert.equal(lines.find(x=>x.sessionKey==='large').text,large);assert.equal(lines[0].event_id,'large-user');
  assert.equal(m.sessions[0].exportedRecords,1);assert.match(m.coverage,/不是无损/);
  assert.throws(()=>history.exportHistory(f.index,{cwd:f.cwd,keys:['foreign'],outputDir}),/不属于/);
  assert.throws(()=>history.exportHistory(f.index,{cwd:f.cwd,keys:[],outputDir}),/重新选择/);
  assert.equal(f.index.db.isTransaction,false);
});

test('dream uses an actual session request; incomplete output never advances cursor or touches native rules',async t=>{
  const f=setup(t),j=await f.start();
  assert.equal(f.sessions.get(j.sessionId).purpose,'memory-dream');assert.equal(j.effort,'medium');
  assert.match(j.prompt,/manifest.json/);assert.match(j.prompt,/不修改原生 MEMORY.md/);
  await assert.rejects(f.start(),/已有未完成/);
  f.output(j,{result:{processedFiles:[]}});await f.service.finishForSession({sessionId:j.sessionId});
  assert.equal(j.status,'attention');assert.equal(f.service.pointer(j.project),null);
  assert.equal((await f.service.candidates('normal'))[0].processed,false);
  f.output(j);await f.service.finishForSession({sessionId:j.sessionId});
  assert.equal(j.status,'done');assert.equal((await f.service.candidates('normal'))[0].processed,true);
  assert.equal(fs.readFileSync(path.join(f.cwd,'AGENTS.md'),'utf8'),'# 手写规则不能被改\n');
  assert.equal(f.service.snapshot('normal').pending,true);
  assert.equal(f.service.snapshot(j.sessionId).project.id,j.project.id);
  assert.equal(f.service.snapshot(j.sessionId).pending,false);
});

test('publication rejects missing links, outside links and native filenames; retry is atomic',async t=>{
  const f=setup(t),j=await f.start();
  f.output(j,{index:'[bad](../outside.md)'});assert.throws(()=>f.service.publish(j),/相对文件/);
  f.output(j,{index:'[bad](topics/missing.md)'});assert.throws(()=>f.service.publish(j),/不存在/);
  f.output(j);fs.writeFileSync(path.join(j.dir,'output','AGENTS.md'),'must reject');
  assert.throws(()=>f.service.publish(j),/仅允许/);assert.equal(f.service.pointer(j.project),null);
  fs.unlinkSync(path.join(j.dir,'output','AGENTS.md'));f.service.publish(j);
  const first=f.service.pointer(j.project);assert.equal(first.jobId,j.id);assert.equal(j.files.length,2);
  assert.equal((await f.service.finalize(j.id)).status,'done');assert.deepEqual(f.service.pointer(j.project),first);
  await assert.rejects(f.service.finalize('../invalid'),/编号无效/);
});

test('index receipt requires exact submitted text, covers ACP, and new versions are sent on next task',async t=>{
  const f=setup(t),j=await f.start();f.output(j);f.service.publish(j);
  f.sessions.get('normal').kind='deepseek-acp';let sent;
  await f.service.withIndex('normal','继续任务','deepseek-acp',{clientSubmissionId:'one'},async text=>{sent=text;return {ok:true};});
  assert.match(sent,/<ai-hub-dream-index>/);assert.equal(f.service.snapshot('normal').receipts[0].status,'unconfirmed');
  f.tap.emit('prompt-submitted',{sessionId:'normal',text:'wrong'});assert.equal(f.service.snapshot('normal').pending,true);
  f.tap.emit('prompt-submitted',{sessionId:'normal',text:sent});assert.equal(f.service.snapshot('normal').pending,false);
  const receipt={};let next;
  await f.service.withIndex('normal','下一条','deepseek-acp',{submissionReceipt:receipt},async text=>{next=text;return {ok:true};});
  assert.equal(next,'下一条');
  const j2=await f.start();f.output(j2);f.service.publish(j2);
  assert.equal(f.service.snapshot('normal').pending,true);
  await f.service.withIndex('normal','新版','deepseek-acp',{submissionReceipt:receipt},async text=>{next=text;f.tap.emit('prompt-submitted',{sessionId:'normal',text});return {ok:true};});
  assert.match(next,/<ai-hub-dream-index>/);assert.equal(f.service.snapshot('normal').receipts[0].status,'sent');assert.ok(receipt.fingerprint);
  for(const [sid,kind,prompt] of [['normal','codex','/compact'],['normal','powershell','echo x'],[j2.sessionId,'codex','继续整理']]) {
    await f.service.withIndex(sid,prompt,kind,{},async text=>assert.equal(text,prompt));
  }
});

test('concurrent delayed receipts are retained; sent evidence survives later transport rejection',async t=>{
  const f=setup(t),j=await f.start();f.output(j);f.service.publish(j);const texts=[];
  await Promise.all(['a','b'].map(id=>f.service.withIndex('normal',id,'codex',{clientSubmissionId:id},async text=>{texts.push(text);return {ok:true};})));
  texts.reverse().forEach(text=>f.tap.emit('prompt-submitted',{sessionId:'normal',text}));
  assert.equal(f.service.snapshot('normal').receipts.filter(r=>r.status==='sent').length,2);
  f.sessions.get('normal').codexSid='new-native';
  await assert.rejects(f.service.withIndex('normal','third','codex',{},async text=>{f.tap.emit('prompt-submitted',{sessionId:'normal',text});throw Error('late disconnect');}),/late disconnect/);
  assert.equal(f.service.snapshot('normal').receipts[0].status,'sent');
});

test('uncertain or running dream cannot be finalized or abandoned; error does not claim completion',async t=>{
  const f=setup(t),j=await f.start();f.output(j);const s=f.sessions.get(j.sessionId);
  for(const state of ['running','waiting','unknown']) {s.nativeRuntime.state=state;
    await assert.rejects(f.service.finalize(j.id),/停止任务/);await assert.rejects(f.service.abandon(j.id),/停止任务/);}
  s.nativeRuntime.state='failed';f.tap.emit('turn-error',{sessionId:j.sessionId});
  assert.equal(j.status,'attention');assert.equal(f.service.pointer(j.project),null);
  await f.service.abandon(j.id);assert.equal(j.status,'failed');assert.equal(f.service.pointer(j.project),null);
  await assert.rejects(f.service.finalize(j.id),/已结束/);
  const next=await f.start();assert.notEqual(next.id,j.id);
});

test('stale history cannot be marked processed; uncertain send retains the project lock',async t=>{
  const f=setup(t);f.index.db.prepare('UPDATE sources SET stale=1 WHERE key=?').run('source');
  await assert.rejects(f.start(),/重新选择/);assert.equal(f.service.pointer(f.service.project(f.cwd)),null);
  f.index.db.prepare('UPDATE sources SET stale=0 WHERE key=?').run('source');
  f.service.sendPrompt=async()=>{throw Error('connection lost after dispatch');};
  await assert.rejects(f.start(),/connection lost/);
  const j=f.service.allJobs(f.service.project(f.cwd))[0];assert.equal(j.status,'attention');assert.ok(j.sessionId);
  await assert.rejects(f.start(),/已有未完成/);
  await f.service.abandon(j.id);
});

test('registered Git worktrees share a project memory and history scope',async t=>{
  const f=setup(t),worktree=path.join(f.root,'task-worktree'),admin=path.join(f.cwd,'.git','worktrees','task');
  fs.mkdirSync(admin,{recursive:true});fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(worktree,'.git'),'gitdir: '+admin);
  fs.writeFileSync(path.join(admin,'commondir'),'../..');fs.writeFileSync(path.join(admin,'gitdir'),path.join(worktree,'.git'));
  f.add('task','来自工作树',worktree);f.sessions.set('worktree',{id:'worktree',kind:'codex',cwd:worktree});
  assert.equal(f.service.project(worktree).id,f.service.project(f.cwd).id);
  assert.deepEqual(new Set((await f.service.candidates('worktree')).map(s=>s.key)),new Set(['source','task']));
});

test('recovered confirmation and a new native epoch retain truthful receipt state',async t=>{
  const f=setup(t),j=await f.start();f.output(j);f.service.publish(j);let sent;
  await f.service.withIndex('normal','恢复前任务','codex',{},async text=>{sent=text;return {ok:true};});
  f.service.sends.clear();f.tap.emit('prompt-submitted',{sessionId:'normal',text:sent});
  assert.equal(f.service.snapshot('normal').pending,false);
  f.sessions.get('normal').nativeRuntime.epoch=2;assert.equal(f.service.snapshot('normal').pending,true);
  f.service.sessionManager.openOwners={owner:()=>({pid:process.pid+1})};
  const j2=await f.start();f.output(j2);assert.throws(()=>f.service.publish(j2),/另一 Hub/);
  assert.equal(f.service.pointer(j2.project).jobId,j.id);
});

test('index is folded in the chat card and excluded from title text without losing the raw message',()=>{
  const {splitMemoryIndex}=require('../core/memory-index-envelope');
  const text='短任务\n\n<ai-hub-dream-index>\n# 项目索引\n<script>not executable</script>\n</ai-hub-dream-index>';
  const parts=splitMemoryIndex(text);assert.equal(parts.userText,'短任务');assert.equal(parts.userText+'\n\n'+parts.indexText,text);
  const html=require('../renderer/conversation-message-view').renderMessageBody(text,{isUser:true,escapeHtml:s=>s.replace(/</g,'&lt;').replace(/>/g,'&gt;'),renderMarkdown:s=>s});
  assert.match(html,/<details class="conversation-memory-context">/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
});

test('idempotent submission retries keep the exact original index even after a newer dream',async t=>{
  const f=setup(t),j=await f.start();f.output(j);f.service.publish(j);let first,retried;
  const options={clientSubmissionId:'stable-id'};
  await f.service.withIndex('normal','任务','codex',options,async text=>{first=text;f.tap.emit('prompt-submitted',{sessionId:'normal',text});return {ok:true};});
  const next=await f.start();f.output(next);f.service.publish(next);
  await f.service.withIndex('normal','任务','codex',options,async text=>{retried=text;return {ok:true};});
  assert.equal(retried,first);assert.equal(f.service.snapshot('normal').receipts.length,1);
  await assert.rejects(f.service.withIndex('normal','不同任务','codex',options,async()=>assert.fail('must not send')),/原始消息已变化/);
});

test('preparation persistence errors release the claim instead of permanently blocking later dreams',async t=>{
  const f=setup(t),save=f.service.saveJob.bind(f.service);
  f.service.saveJob=()=>{throw Error('controlled disk failure');};
  await assert.rejects(f.start(),/controlled disk failure/);
  assert.equal(fs.existsSync(path.join(f.service.project(f.cwd).dir,'active.json')),false);
  f.service.saveJob=save;assert.equal((await f.start()).status,'running');
});
