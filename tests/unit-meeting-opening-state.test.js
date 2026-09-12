'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
const source=fs.readFileSync(path.join(__dirname,'../renderer/renderer.js'),'utf8');
const selectSource=source.slice(source.indexOf('async function selectMeeting('),source.indexOf('// --- Terminal management ---'));
test('opening uses the completed meeting snapshot after yielding for paint',async()=>{
 const initial={id:'room',subSessions:['one']},latest={id:'room',subSessions:['one','two'],serialWorkflow:{enabled:true}},opened=[];
 const noop=()=>{};
 const context={activeSessionId:'old',activeMeetingId:null,meetings:{room:initial},sessions:new Map(),
  terminalPanelEl:{style:{},classList:{remove:noop}},emptyStateEl:null,completionNotificationToggle:null,window:{},ipcRenderer:{send:noop},
  savePreviewState:noop,suspendInactiveTerminalRenderers:noop,setShellNavActive:noop,clearPreviewUI:noop,
  clearSessionCompletedUnread:()=>false,acknowledgeSessionFailureState:()=>false,paintSidebarActiveTarget:noop,scheduleSessionListRender:noop,
  setTimeout,clearTimeout,requestAnimationFrame:fn=>{context.meetings.room=latest;setTimeout(fn,0);},
  MeetingRoom:{openMeeting:(id,data)=>opened.push(data)},restorePreviewForContext:async()=>{}};
 await vm.runInNewContext(selectSource+"\nselectMeeting('room');",context);
 assert.equal(opened.length,1);assert.equal(opened[0],latest);assert.equal(opened[0].subSessions.length,2);
});
test('final meeting-created snapshot refreshes an already opened room',()=>{
 let handler,refreshed;
 const context={activeMeetingId:'room',meetings:{},renderSessionList(){},ipcRenderer:{on:(_ch,fn)=>{handler=fn;}},MeetingRoom:{updateMeetingData:(id,data)=>{refreshed={id,data};}}};
 const start=source.indexOf("ipcRenderer.on('meeting-created',");
 const end=source.indexOf("ipcRenderer.on('meeting-updated',",start);
 vm.runInNewContext(source.slice(start,end),context);
 const latest={id:'room',subSessions:['one','two']};handler({}, {meeting:latest});
 assert.equal(context.meetings.room,latest);assert.equal(refreshed?.data,latest);
 refreshed=null;handler({}, {meeting:{id:'other',subSessions:[]}});assert.equal(refreshed,null);
});
