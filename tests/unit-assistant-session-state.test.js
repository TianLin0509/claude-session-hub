'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {AssistantService}=require('../core/hub-assistant/service');
function fixture(t){
  const now=Date.now(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-state-'));
  const sessions=[{id:'assistant',kind:'codex',status:'idle'},
    {id:'open-idle',kind:'codex',status:'idle',lastMessageTime:now},
    {id:'run',kind:'codex',status:'idle',agentRuntime:'pty',runtimeTruth:{state:'running',source:'codex-hook',confidence:'authoritative',observedAt:now}},
    {id:'reply',kind:'codex',status:'idle',unreadCount:2,attentionState:'reply-ready',lastMessageTime:now},
    {id:'wait',kind:'codex',status:'idle',attentionState:'needs-input',lastMessageTime:now},
    {id:'sleep',kind:'codex',status:'dormant',unreadCount:1,lastMessageTime:now},
    {id:'error',kind:'codex',status:'failed',lastMessageTime:now}];
  const service=new AssistantService({dataDir:dir,getSession:id=>sessions.find(s=>s.id===id),getAllSessions:()=>sessions,
    listKnownSessions:()=>[{id:'closed',status:'running',unreadCount:4,attentionState:'reply-ready'}]});
  service.store.set('sessionId','assistant');
  t.after(()=>service.close());return{service,sessions};
}
test('assistant reports Hub runtime truth, unread and active classification instead of opened/raw status',async t=>{
 const {service}=fixture(t),rows=await service.invokeTool({name:'list_sessions'}),row=id=>rows.find(s=>s.id===id);
 assert.equal(row('run').hubState.state,'run');
 assert.equal(row('run').hubState.isActive,true);
 assert.equal(row('open-idle').hubState.isActive,false);
 assert.equal(row('reply').hubState.hasUnread,true);assert.equal(row('reply').hubState.unreadCount,2);
 assert.equal(row('wait').hubState.needsUserInput,true);assert.equal(row('wait').hubState.isActive,true);
 assert.equal(row('sleep').hubState.hasUnread,true);assert.equal(row('sleep').hubState.isActive,false);
 assert.equal(row('closed').hubState.hasUnread,null);assert.equal(row('closed').hubState.state,'unknown');
 assert.equal(row('error').hubState.state,'error');
 const board=service.context().workbench;assert.equal(board.openedCount,6);assert.equal(board.activeCount,2);
 assert.equal(board.inventory.length,6);assert.match(board.markdown,/未读/);assert.match(board.markdown,/已打开.*活跃/);
});
test('mark-read changes the dossier revision without a new reply',t=>{
 const {service,sessions}=fixture(t),first=service.context().workbench;
 service.dossier.noteServed(first);
 const reply=sessions.find(s=>s.id==='reply');reply.unreadCount=0;reply.attentionState='none';
 const next=service.context().workbench;
 assert.notEqual(first.revision,next.revision);assert(next.changedSessionIds.includes('reply'));
 assert.equal(next.inventory.find(s=>s.id==='reply').hubState.hasUnread,false);
});
test('sidebar projection carries the real count despite a stale main process copy; native identity changes discard it',t=>{
 const {service,sessions}=fixture(t),live=sessions.find(s=>s.id==='reply');
 live.codexSid='native-one';live.unreadCount=0;live.attentionState='none';
 const {createSessionViewPublisher}=require('../core/hub-assistant/session-state');
 const packets=[],publish=createSessionViewPublisher(packet=>{packets.push(packet);service.setSessionViews(packet);});
 const renderer=[{...live,unreadCount:3,attentionState:'reply-ready'}];
 publish(renderer);publish(renderer);assert.equal(packets.length,1,'unchanged state is not transferred again');
 let row=service.context().workbench.inventory.find(s=>s.id==='reply');
 assert.equal(row.hubState.unreadCount,3);assert.equal(row.hubState.hasUnread,true);
 renderer[0].unreadCount=0;renderer[0].attentionState='none';publish(renderer);
 row=service.context().workbench.inventory.find(s=>s.id==='reply');assert.equal(row.hubState.hasUnread,false);
 live.codexSid='native-two';live.unreadCount=1;live.attentionState='reply-ready';
 assert.equal(service.context().workbench.inventory.find(s=>s.id==='reply').hubState.unreadCount,1);
 publish([]);assert.equal(service.sessionViews.has('reply'),false);
});
