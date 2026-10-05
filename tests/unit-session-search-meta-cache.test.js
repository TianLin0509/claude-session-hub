'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {SearchSourceMetaCache}=require('../core/search-source-meta-cache');
const {collectSourceDescriptors}=require('../core/session-search-sources');
const {SessionSearchEngine}=require('../core/session-search-engine');
function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-search-meta-cache-'));
 t.after(()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true})});
 const files=[];
 const create=(profile,id='same-sid')=>{const dir=path.join(root,profile,'2026','10','05');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'rollout-'+id+'.jsonl');write(file,id);files.push(file);return {file,sessionsRoot:path.join(root,profile)}};
 const write=(file,id)=>fs.writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id,cwd:root,source:'cli'}})+'\n'+JSON.stringify({type:'event_msg',payload:{type:'user_message',message:'SEARCH_META_USER'}})+'\n');
 return {root,files,create,write};
}
function openedFiles(files,read) {
 const original=fs.openSync,seen=[];
 fs.openSync=function(file,...args){if(files.includes(file))seen.push(file);return original.call(this,file,...args)};
 try{return {result:read(),seen}}finally{fs.openSync=original}
}
function options(roots) {return {codexRoots:roots,claudeRoots:[],kimiRoots:[],geminiRoots:[]}}
test('unchanged headers are reused while current Hub titles and profile bindings are rebuilt',t=>{
 const f=fixture(t),a=f.create('a'),cache=new SearchSourceMetaCache();
 const snapshot={sessions:[{id:'hub-a',kind:'codex',codexSid:'same-sid',codexSessionsRoot:a.sessionsRoot,title:'Original'}]};
 const first=openedFiles(f.files,()=>collectSourceDescriptors(options([a.sessionsRoot]),snapshot,cache));assert.equal(first.seen.length,1);
 const same=openedFiles(f.files,()=>collectSourceDescriptors(options([a.sessionsRoot]),snapshot,cache));assert.equal(same.seen.length,0);assert.deepEqual(same.result.descriptors,first.result.descriptors);
 snapshot.sessions[0]={...snapshot.sessions[0],id:'new-hub-a',title:'Renamed',codexProfile:'new-profile'};
 const renamed=openedFiles(f.files,()=>collectSourceDescriptors(options([a.sessionsRoot]),snapshot,cache));assert.equal(renamed.seen.length,0);
 assert.equal(renamed.result.descriptors[0].hubSession.id,'new-hub-a');assert.notEqual(renamed.result.descriptors[0].signature,first.result.descriptors[0].signature);
});
test('append, removal, recreation and discovery of a new file remain visible',t=>{
 const f=fixture(t),a=f.create('a'),cache=new SearchSourceMetaCache(),opts=options([a.sessionsRoot]);
 const initial=collectSourceDescriptors(opts,{},cache).descriptors[0];
 fs.appendFileSync(a.file,JSON.stringify({type:'event_msg',payload:{type:'agent_message',message:'New reply'}})+'\n');
 const appended=openedFiles(f.files,()=>collectSourceDescriptors(opts,{},cache));assert.equal(appended.seen.length,1);assert.notEqual(appended.result.descriptors[0].signature,initial.signature);
 fs.unlinkSync(a.file);assert.equal(collectSourceDescriptors(opts,{},cache).descriptors.length,0);
 f.write(a.file,'replacement-sid');assert.equal(collectSourceDescriptors(opts,{},cache).descriptors[0].nativeSessionId,'replacement-sid');
 f.create('a','new-sid');assert.equal(collectSourceDescriptors(opts,{},cache).descriptors.length,2);
});
test('failed metadata reads are retried rather than cached',t=>{
 const f=fixture(t),a=f.create('a'),cache=new SearchSourceMetaCache(),opts=options([a.sessionsRoot]);fs.writeFileSync(a.file,'incomplete');
 for(let i=0;i<2;i++){const result=openedFiles(f.files,()=>collectSourceDescriptors(opts,{},cache));assert.equal(result.seen.length,1);assert.equal(result.result.descriptors.length,0);assert.equal(cache.entries.size,0)}
 f.write(a.file,'recovered');assert.equal(collectSourceDescriptors(opts,{},cache).descriptors[0].nativeSessionId,'recovered');
});
test('copied SIDs in different profile roots retain distinct identities and titles',t=>{
 const f=fixture(t),a=f.create('a'),b=f.create('b'),cache=new SearchSourceMetaCache();
 const snapshot={sessions:[{id:'hub-a',kind:'codex',codexSid:'same-sid',codexSessionsRoot:a.sessionsRoot,title:'A'},{id:'hub-b',kind:'codex',codexSid:'same-sid',codexSessionsRoot:b.sessionsRoot,title:'B'}]};
 const opts=options([a.sessionsRoot,b.sessionsRoot]);collectSourceDescriptors(opts,snapshot,cache);
 const result=openedFiles(f.files,()=>collectSourceDescriptors(opts,snapshot,cache));assert.equal(result.seen.length,0);
 assert.equal(new Set(result.result.descriptors.map(d=>d.key)).size,2);assert.deepEqual(result.result.descriptors.map(d=>d.hubSession.id),['hub-a','hub-b']);
});
test('stat identity changes invalidate even when size and modification time match',()=>{
 const cache=new SearchSourceMetaCache(),stat={size:100,mtimeMs:10,ctimeMs:20,birthtimeMs:5,ino:1,dev:1},meta={id:'old'};
 for(const field of ['ctimeMs','birthtimeMs','ino','dev']){cache.set('file',stat,meta);assert.equal(cache.get('file',{...stat,[field]:stat[field]+1}),null)}
});
test('expiry is measured from the file read and memory and entry budgets are bounded',()=>{
 let now=0;const cache=new SearchSourceMetaCache({maxAgeMs:10,maxEntries:2,maxBytes:1000,now:()=>now}),stat={size:1,mtimeMs:1};
 cache.set('a',stat,{id:'a'});now=5;assert.equal(cache.get('a',stat).id,'a');now=10;assert.equal(cache.get('a',stat),null);
 cache.set('a',stat,{id:'a'});cache.set('b',stat,{id:'b'});cache.set('c',stat,{id:'c'});assert.equal(cache.entries.size,2);assert.equal(cache.get('a',stat),null);
 cache.set('oversized',stat,{id:'x'.repeat(2000)});assert.ok(cache.bytes<=1000);assert.equal(cache.get('oversized',stat),null);cache.clear();assert.equal(cache.bytes,0);assert.equal(cache.entries.size,0);
});
test('manual force refresh reopens headers and engine close releases retained metadata',async t=>{
 const f=fixture(t),a=f.create('a'),engine=new SessionSearchEngine({...options([a.sessionsRoot]),databasePath:path.join(f.root,'search.sqlite')});
 try {
  await engine.refresh({}, {force:true});assert.equal(engine._sourceMetaCache.entries.size,1);
  const original=fs.openSync;let reads=0;fs.openSync=function(file,...args){if(file===a.file)reads++;return original.call(this,file,...args)};
  try {await engine.refresh({}, {immediate:true});assert.equal(reads,0);await engine.refresh({}, {force:true});assert.ok(reads>0)}finally{fs.openSync=original}
 }finally {await engine.close()}
 assert.equal(engine._sourceMetaCache.entries.size,0);
});
