'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {sessionRuntimeIssue}=require('../core/session-runtime-issue');
const {partitionSidebarSessions}=require('../renderer/session-list-renderer');
const {getSessionRuntimeTruth}=require('../core/session-runtime-truth');
for (const [kind,runtimeBackend] of [['codex','codex-app-server'],['claude','claude-stream-json'],['gemini','acp']]) {
  test(kind+' disconnected/failed alerts override unread/pinned and clear on recovery without changing native truth',()=>{
    const s={id:'x',kind,runtimeBackend,pinned:true,unreadCount:2,status:'idle',nativeRuntime:{state:'unknown',connection:'disconnected',reason:'fixture disconnected',requests:[]}};
    const before=JSON.stringify(s);
    assert.equal(sessionRuntimeIssue(s).message,'fixture disconnected');
    let parts=partitionSidebarSessions([s]);
    assert.equal(parts.failed.length,1);assert.equal(parts.unread.length,0);assert.equal(parts.pinned.length,0);
    assert.equal(parts.states.get('x'),'error');assert.equal(getSessionRuntimeTruth(s).state,'unknown');
    assert.equal(JSON.stringify(s),before);
    s.nativeRuntime={state:'running',connection:'connected',requests:[]};
    assert.equal(sessionRuntimeIssue(s),null);assert.equal(partitionSidebarSessions([s]).failed.length,0);
    s.nativeRuntime.state='failed';assert(sessionRuntimeIssue(s));
    s.status='dormant';assert.equal(sessionRuntimeIssue(s),null);
    s.status='idle';s.nativeRuntime={state:'interrupted',connection:'connected',requests:[]};assert.equal(sessionRuntimeIssue(s),null);
    s.nativeRuntime={state:'idle',connection:'unstarted',lazyStart:true,requests:[]};assert.equal(sessionRuntimeIssue(s),null);
  });
}
test('unknown submission/cancellation requires attention but plain startup unknown does not',()=>{
  const s={kind:'claude',runtimeBackend:'claude-stream-json',nativeRuntime:{state:'unknown',connection:'connected',requests:[]}};
  assert.equal(sessionRuntimeIssue(s),null);
  s.nativeRuntime.submission={status:'unknown'};assert(sessionRuntimeIssue(s));
  s.nativeRuntime.submission=null;s.nativeRuntime.cancellation={status:'unknown'};assert(sessionRuntimeIssue(s));
});
test('mixed group keeps its running member, unread and pin while showing one exceptional group',()=>{
  const a={id:'a',kind:'codex',nativeRuntime:{state:'running',connection:'connected',requests:[]}};
  const b={id:'b',kind:'claude',runtimeBackend:'claude-stream-json',nativeRuntime:{state:'unknown',connection:'disconnected',requests:[]}};
  const group={id:'g',pinned:true,unreadAnsweredSize:1,_isMeeting:true,_meeting:{groupChat:true,subSessions:['a','b']}};
  const parts=partitionSidebarSessions([group],{sessionMap:new Map([['a',a],['b',b]])});
  assert.equal(parts.failed[0],group);assert.equal(parts.states.get('g'),'error');assert.equal(a.nativeRuntime.state,'running');
  assert.equal(group.unreadAnsweredSize,1);assert.equal(group.pinned,true);
});
