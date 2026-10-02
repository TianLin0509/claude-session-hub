'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { AssistantDossier } = require('../core/hub-assistant/dossier');
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-dossier-'));
  t.after(()=>{assert(fs.realpathSync(root).startsWith(fs.realpathSync(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});
  const sessions=Array.from({length:15},(_,i)=>({id:'session-'+i,title:'业务'+i,kind:'codex',isOpen:true,status:'idle',nativeSessionId:'native-'+i,
    latestFinal:{ref:'E'+i,id:'final-'+i,text:'当前结果'+i+'：'+ '已核对的材料原文。'.repeat(500),timestamp:100+i,transcriptPath:'bound-'+i}}));
  return {root,sessions,dossier:new AssistantDossier(root)};
}
test('all 15 live sessions survive a package larger than the old global budget',t=>{
  const {sessions,dossier}=fixture(t),board=dossier.publish(sessions,'assistant-native-a');
  assert.equal(board.openedCount,15);assert.equal(board.sources.length,15);assert.equal(board.allActiveSessionsIncluded,true);
  assert(board.sources.reduce((n,s)=>n+s.text.length,0)>24000);
  for(const session of sessions){const row=board.openedInventory.find(r=>r.id===session.id);assert(row);assert(fs.readFileSync(row.document,'utf8').includes(session.latestFinal.text));}
  assert(board.markdown.includes('业务14'));assert.equal(board.mode,'checkpoint');
});
test('unchanged replies use deltas while status inventory remains complete',t=>{
  const {sessions,dossier}=fixture(t),first=dossier.publish(sessions,'same');
  dossier.noteServed(first);
  const second=dossier.publish(sessions,'same');assert.equal(second.sources.length,0);assert.equal(second.openedCount,15);assert.equal(second.revision,first.revision);
  sessions[14].latestFinal={...sessions[14].latestFinal,ref:'Enew',text:'用户确认后归档已完成；等待用户验收。'};
  const third=dossier.publish(sessions,'same');assert.deepEqual(third.changedSessionIds,['session-14']);assert.equal(third.sources[0].ref,'Enew');assert.equal(third.openedCount,15);
  // Old documents remain readable for citations and audit.
  assert(fs.readFileSync(first.openedInventory.find(s=>s.id==='session-14').document,'utf8').includes('当前结果14'));
});
test('restart or backend identity change resets the delivery baseline, preserving files',t=>{
  const {root,sessions,dossier}=fixture(t),first=dossier.publish(sessions,'codex-a');dossier.noteServed(first);
  assert.equal(dossier.publish(sessions,'codex-a').sources.length,0);
  assert.equal(dossier.publish(sessions,'codex-b').sources.length,15);
  const restarted=new AssistantDossier(root),restored=restarted.publish(sessions,'codex-b');
  assert.equal(restored.mode,'checkpoint');assert.equal(restored.sources.length,15);assert(fs.existsSync(first.markdownPath));
});
test('closed sessions remain in the full catalog without pretending their runtime is live',t=>{
  const {sessions,dossier}=fixture(t);sessions.push({id:'closed',title:'旧业务',isOpen:false,status:'closed'});
  const first=dossier.publish(sessions,'same');dossier.noteServed(first);sessions[0].isOpen=false;
  const next=dossier.publish(sessions,'same');assert.equal(next.openedCount,14);assert.equal(next.knownCount,16);
  assert(fs.readFileSync(path.join(dossier.directory,'ALL-SESSIONS.md'),'utf8').includes('未打开，运行状态未知'));
});
test('missing native records retain a readable archived answer without claiming it is current',t=>{
  const {root,sessions,dossier}=fixture(t);const first=dossier.publish(sessions,'same');
  const old=first.openedInventory.find(s=>s.id==='session-0');sessions[0].latestFinal=null;sessions[0].liveIssue='记录文件暂不可用';
  const after=new AssistantDossier(root).publish(sessions,'new-backend');const row=after.openedInventory.find(s=>s.id==='session-0');
  assert.equal(row.document,old.document);assert.equal(row.latestRef,old.latestRef);assert.equal(row.lastKnownOnly,true);
  assert(fs.readFileSync(row.document,'utf8').includes('当前结果0'));assert.match(after.markdown,/最新未核实/);
  assert(!after.sources.some(source=>source.sessionId==='session-0'),'archived text must not masquerade as new native evidence');
});
