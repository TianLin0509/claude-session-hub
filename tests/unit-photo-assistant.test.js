'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {AssistantService}=require('../core/hub-assistant/service');
const {PhotoAssistant,PURPOSE,isPhotoRequest}=require('../core/hub-assistant/photo-assistant');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'photo-assistant-')),sessions=new Map(),created=[],sent=[];
 const a=new AssistantService({dataDir:dir,noReminderTimer:true,getSession:id=>sessions.get(id),getSessionMetadata:id=>sessions.get(id),getAllSessions:()=>[...sessions.values()],getDefaults:()=>({cwd:dir}),createSession:async(kind,opts)=>{const s={...opts,kind,status:'idle'};created.push(s);sessions.set(s.id,s);return s;},sendPrompt:async(...args)=>{sent.push(args);return{ok:true,receipt:{status:'confirmed'}}}});
 a.store.set('assistantDefaultsVersion',2);a.store.set('backendKind','claude');a.store.set('sessionId','daily-assistant');a.store.set('backendSessions',{claude:'daily-assistant'});
 sessions.set('daily-assistant',{id:'daily-assistant',kind:'claude',purpose:'hub-assistant',status:'running'});
 t.after(()=>a.close());return{a,photo:new PhotoAssistant(a),sessions,created,sent};}
test('photo assistant is a single ordinary visible session independent of a busy daily assistant',async t=>{
 const x=fixture(t),[a,b]=await Promise.all([x.photo.ensureSession(),x.photo.ensureSession()]);assert.equal(a.sessionId,b.sessionId);assert.equal(x.created.length,1);
 assert.equal(a.session.title,'拍图助理');assert.equal(a.session.hiddenFromSidebar,false);assert.equal(a.session.mcpProfile,'none');assert.equal(a.session.purpose,PURPOSE);
 assert.equal(x.a.store.get('sessionId'),'daily-assistant');await x.photo.send({requestId:'photo-request-123456',text:'read image'});assert.equal(x.sent[0][0],a.sessionId);
 assert.equal((await new PhotoAssistant(x.a).ensureSession()).sessionId,a.sessionId);assert.equal(x.created.length,1);
 x.sessions.get(a.sessionId).status='running';await x.photo.send({text:'second image'});assert.equal(x.sent.length,2,'native input accepts photos while the assistant works');
});
test('photo creation retries the reserved identity, and adopts explicitly marked precreated sessions',async t=>{
 const x=fixture(t),create=x.a.deps.createSession;x.a.deps.createSession=async()=>{throw Error('startup failed')};await assert.rejects(x.photo.ensureSession(),/startup failed/);const id=x.photo.saved.id;
 x.a.deps.createSession=create;assert.equal((await x.photo.ensureSession()).sessionId,id);
 const y=fixture(t);y.sessions.set('precreated',{id:'precreated',kind:'claude',purpose:PURPOSE,status:'idle'});assert.equal((await y.photo.ensureSession()).sessionId,'precreated');assert.equal(y.created.length,0);
});
test('photo prompt retains request correlation without business tools, history or delegation',async t=>{
 const x=fixture(t),r=await x.photo.ensureSession();const p=x.photo.preparePrompt({sessionId:r.sessionId,clientSubmissionId:'photo-request-123456',text:'image question'});
 const shown=require('../core/assistant-context-display').assistantContextDisplay(p.text,PURPOSE);assert.equal(shown.userText,'image question');assert.equal(shown.clientSubmissionId,'photo-request-123456');
 assert.doesNotMatch(p.text,/history_context|create_session|assistantContinuity/);assert.equal(x.a.currentRequest,null);
 assert.equal(isPhotoRequest({shared:'115509-capture-400cee7c-6d3f-4862-9bbb-f5b5223e501b.jpg'}),true);assert.equal(isPhotoRequest({shared:'115509-ordinary.jpg'}),false);
});
test('photo resume preserves identity and refuses to replace unavailable history',async t=>{
 const x=fixture(t),ready=await x.photo.ensureSession(),meta={...ready.session};x.sessions.delete(meta.id);
 x.a.deps.getSessionMetadata=id=>id===meta.id?meta:null;
 x.a.deps.resumeSession=async id=>{assert.equal(id,meta.id);x.sessions.set(id,meta);return meta;};
 assert.equal((await x.photo.ensureSession()).sessionId,meta.id);assert.equal(x.created.length,1);
 x.sessions.delete(meta.id);x.a.deps.resumeSession=async()=>null;
 await assert.rejects(x.photo.ensureSession(),/暂未恢复/);assert.equal(x.created.length,1);
});
for(const kind of ['claude','codex','gemini','kimi'])test('photo keeps the selected '+kind+' backend and correlated prompt',async t=>{
 const x=fixture(t);x.a.store.set('backendKind',kind);x.a.store.set('profile:'+kind,{model:'selected-model',effort:'low'});
 const r=await x.photo.ensureSession();assert.equal(r.session.kind,kind);assert.equal(r.session.model,'selected-model');
 const p=x.photo.preparePrompt({sessionId:r.sessionId,clientSubmissionId:'photo-request-123456',text:'看图“43 × 19”'});
 const shown=require('../core/assistant-context-display').assistantContextDisplay(p.text,PURPOSE);assert.equal(shown.userText,'看图“43 × 19”');assert.equal(shown.clientSubmissionId,'photo-request-123456');
});
