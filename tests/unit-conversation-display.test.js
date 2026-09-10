'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {displayTurns,userTextIdentity}=require('../core/conversation-display');
const {nativeTranscriptTurns}=require('../core/codex-native-transcript');
const {parseCodexRolloutText}=require('../core/codex-transcript-parser');
const {parseClaudeTranscriptText}=require('../core/claude-transcript-parser');
const {captureConversationMessages}=require('../core/conversation-capture');

test('native incremental reads retain all current items without projecting older turns',()=>{
  const {CodexNativeSession}=require('../core/codex-native-session');
  const old={id:'old',status:'completed',items:[{id:'old-final',type:'agentMessage',text:'Old'}]};
  const latest={id:'latest',status:'completed',items:[
    {id:'u',type:'userMessage',content:[{type:'text',text:'New input'}]},
    {id:'p',type:'agentMessage',phase:'commentary',text:'Progress'},
    {id:'f',type:'agentMessage',phase:'final_answer',text:'Final'}]};
  const session={threadId:'thread',runtime:{turnId:null},history:new Map([['old',old],['latest',latest]])};
  const read=options=>displayTurns(CodexNativeSession.prototype.readTranscript.call(session,options));
  assert.deepEqual(read({latestTurn:true,limit:Infinity}).map(m=>m.text),['New input','Progress','Final']);
  assert.deepEqual(read({turnId:'old',latestTurn:true,limit:Infinity}).map(m=>m.text),['Old']);
  assert.deepEqual(read({turnId:'missing',latestTurn:true,limit:Infinity}),[]);
});

test('steering within one native turn preserves item order and attempt ownership',()=>{
  const items=[{id:'u1',type:'userMessage',clientId:'attempt-one',content:[{type:'text',text:'First input'}]},
    {id:'p1',type:'agentMessage',phase:'commentary',text:'Same words'},
    {id:'u2',type:'userMessage',clientId:'attempt-two',content:[{type:'text',text:'Follow up'}]},
    {id:'p2',type:'agentMessage',phase:'commentary',text:'Same words'}];
  const turns=nativeTranscriptTurns('thread',[{id:'turn',status:'inProgress',items}]);
  assert.deepEqual(displayTurns(turns).map(m=>m.text),['First input','Same words','Follow up','Same words']);
  const native={readTranscript:()=>turns};
  const captured=captureConversationMessages({native,providerTurnId:'turn',clientSubmissionId:'attempt-two'});
  assert.equal(captured.length,1);assert.equal(captured[0].itemId,'p2');
});

test('App Server items retain identity and progress when a final item arrives',()=>{
  const items=[{id:'p1',type:'agentMessage',phase:'commentary',text:'Investigating'},
    {id:'p2',type:'agentMessage',phase:'commentary',text:'Testing'}];
  const project=(status,extra=[])=>displayTurns(nativeTranscriptTurns('thread',[
    {id:'turn',status,items:[...items,...extra]}]));
  const live=project('inProgress');
  const done=project('completed',[{id:'f',type:'agentMessage',phase:'final_answer',text:'Done'}]);
  assert.deepEqual(done.slice(0,2).map(m=>[m.id,m.text]),live.map(m=>[m.id,m.text]));
  assert.deepEqual(done.map(m=>m.text),['Investigating','Testing','Done']);
  items[1].text+=' successfully';
  assert.equal(project('inProgress')[1].id,live[1].id);
  assert.equal(nativeTranscriptTurns('thread',[{id:'turn',status:'completed',items:[...items,
    {id:'f',type:'agentMessage',phase:'final_answer',text:'Done'}]}])[0].text,'Done');
});

const event=(type,extra={},n=0)=>({type:'event_msg',timestamp:`2026-09-10T10:00:0${n}.000Z`,payload:{type,...extra}});
test('rollout completion receipt does not erase progress or duplicate the last message',()=>{
  const records=[event('task_started',{turn_id:'t'}),event('agent_message',{message:'First'},1),
    event('agent_message',{message:'Second'},2),event('task_complete',{last_agent_message:'Second'},3)];
  const live=displayTurns(parseCodexRolloutText(records.slice(0,3).map(JSON.stringify).join('\n')));
  const done=displayTurns(parseCodexRolloutText(records.map(JSON.stringify).join('\n')));
  assert.deepEqual(done.map(m=>m.text),['First','Second']);
  assert.deepEqual(done.map(m=>m.id),live.map(m=>m.id));
  assert.equal(done[1].phase,'final_answer');
});

test('image envelope echo becomes one user card, intentional repeated submissions remain two',()=>{
  const records=[{type:'response_item',timestamp:'2026-09-10T10:00:00.000Z',payload:{id:'raw',type:'message',role:'user',
    content:[{type:'input_text',text:'<image name=[Image #1] path="C:\\photo.png">\n\n</image>\nCheck this'}]}},
    event('item_completed',{item:{id:'u1',type:'UserMessage',content:[{type:'text',text:'Check this'}]}}),
    event('item_completed',{item:{id:'u2',type:'UserMessage',content:[{type:'text',text:'Check this'}]}},1)];
  const users=parseCodexRolloutText(records.map(JSON.stringify).join('\n')).filter(m=>m.role==='user');
  assert.equal(users.length,2);
  assert.equal(userTextIdentity('literal <image> and </image>'),'literal <image> and </image>');
});

test('Claude display splits actual assistant records but not paragraphs inside a message',()=>{
  const records=[{type:'assistant',uuid:'a',timestamp:'2026-09-10T10:00:00Z',message:{content:[{type:'text',text:'Step one\n\nDetails'}],stop_reason:'tool_use'}},
    {type:'assistant',uuid:'b',timestamp:'2026-09-10T10:00:01Z',message:{content:[{type:'text',text:'Result'}],stop_reason:'end_turn'}}];
  const logical=parseClaudeTranscriptText(records.map(JSON.stringify).join('\n'));
  assert.equal(logical.length,1);
  assert.deepEqual(displayTurns(logical).map(m=>m.text),['Step one\n\nDetails','Result']);
});
