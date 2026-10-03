'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {partitionSidebarSessions}=require('../renderer/session-list-renderer');
const {buildSidebarView}=require('../renderer/session-list-view-policy');
const {normalizeNavigationOrder}=require('../renderer/navigation-order');
const now=Date.now(),day=86400000;
const row=(id,extra={})=>Object.freeze({id,kind:'codex',status:'idle',lastMessageTime:now,...extra});
const ids=rows=>rows.map(e=>e.id);
function view(rows,days=1,sessionMap=new Map()){const parts=partitionSidebarSessions(rows,{now,sessionMap});return buildSidebarView(parts,{now,days,sessionMap,hasUnread:(e,map)=>!!e.unreadCount||!!e.unreadAnsweredSize||e._meeting?.subSessions.some(id=>map.get(id)?.unreadCount)});}
test('置顶及未读提升到时间分组顶部，保留置底，输入状态不变',()=>{
 const rows=Object.freeze([row('normal'),row('read',{unreadCount:1,lastMessageTime:now-8*day}),row('pin',{pinned:true,lastMessageTime:now-10*day}),row('bottom',{bottomed:true})]);
 assert.deepEqual(ids(view(rows).today),['pin','read','normal','bottom']);
 assert.equal(rows[1].unreadCount,1);
});
test('24与72小时严格回溯；运行、等待、异常和有未读的老群聊保持可见',()=>{
 const members=new Map([['member',row('member',{status:'running',unreadCount:1})]]);
 const rows=[row('fresh'),row('24h',{lastMessageTime:now-day}),row('72h',{lastMessageTime:now-3*day}),row('sleep',{status:'dormant'}),row('wait',{attentionState:'needs-input',lastMessageTime:now-20*day}),row('fail',{status:'failed'}),row('group',{_isMeeting:true,_meeting:{subSessions:['member'],groupChat:true},lastMessageTime:now-20*day})];
 const v=view(rows,1,members);assert.deepEqual(ids(v.today),['fresh','sleep']);assert.deepEqual(ids(v.active),['wait','group']);assert.deepEqual(ids(v.failed),['fail']);assert.deepEqual(ids(v.archive),['24h','72h']);
 const three=view(rows,3,members);assert(ids(three.today).includes('24h'));assert(!ids(three.today).includes('72h'));assert.equal(three.archiveCount,1);
});
test('新功能与删除功能合并到旧自定义顺序，不接受重复及未知节点',()=>{
 assert.deepEqual(normalizeNavigationOrder(['assistant','home','assistant','gone'],['home','assistant','accounts']),['assistant','home','accounts']);
 assert.deepEqual(normalizeNavigationOrder({bad:true},['home','assistant']),['home','assistant']);
});
test('置顶筛选只展示置顶会话和群聊，运行及异常仍各归原分组',()=>{
 const member=row('member',{status:'running'}),sessionMap=new Map([['member',member]]);
 const rows=[row('old-pin',{pinned:true,lastMessageTime:now-20*day}),row('run-pin',{pinned:true,status:'running'}),
  row('bad-pin',{pinned:true,status:'failed'}),row('group-pin',{pinned:true,_isMeeting:true,_meeting:{subSessions:['member'],groupChat:true}}),
  row('plain'),row('unread',{unreadCount:1}),row('unpinned-run',{status:'running'})];
 const parts=partitionSidebarSessions(rows,{now,sessionMap});
 const result=buildSidebarView(parts,{now,pinnedOnly:true,sessionMap});
 assert.deepEqual(ids(result.today),['old-pin']);assert.deepEqual(ids(result.failed),['bad-pin']);
 assert.deepEqual(ids(result.active).sort(),['group-pin','run-pin']);assert.equal(result.archiveCount,0);
 assert.equal(rows[5].unreadCount,1);assert.equal(member.status,'running');
 assert.equal(buildSidebarView(partitionSidebarSessions([row('plain')],{now}),{now,pinnedOnly:true}).today.length,0);
});
