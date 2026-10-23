'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {displayChatTurns}=require('../renderer/simple-chat-display');
const {nativeTranscriptTurns}=require('../core/codex-native-transcript');
const {parseCodexRolloutText}=require('../core/codex-transcript-parser');
const {parseKimiWireRecords}=require('../core/kimi-transcript-parser');
const {ALL_AI_KINDS}=require('../core/ai-kinds');
const ts=1792764000000;

test('all registered agents retain long Unicode thinking, times and answer separately without mutating source',()=>{
  for(const kind of ALL_AI_KINDS){
    const thinking='中文进展 🧪\n'.repeat(600);
    const raw={id:kind,role:'assistant',kind,thinking,text:'最终答案',ts};
    const card=displayChatTurns([Object.freeze(raw)])[0];
    assert.equal(card.text,'最终答案');
    assert.deepEqual(card.chatProcessMessages.map(m=>[m.text,m.ts]),[[thinking,ts]]);
    assert.equal(raw.thinking,thinking);
  }
});
test('Codex and ACP reasoning items retain native timestamps and identities across live completion',()=>{
  const items=[{id:'r',type:'reasoning',hubStartedAt:ts+1000,summary:['先查配置。']},
    {id:'p',type:'agentMessage',phase:'commentary',hubStartedAt:ts+2000,text:'现在验证。'}];
  const project=status=>displayChatTurns(nativeTranscriptTurns('t',[{id:'turn',status,hubStartedAt:ts,items}]))[0];
  const live=project('inProgress');
  items.push({id:'f',type:'agentMessage',phase:'final_answer',text:'完成。',hubStartedAt:ts+3000});
  const done=project('completed');
  assert.equal(done.id,live.id);
  assert.equal(done.text,'完成。');
  assert.deepEqual(done.chatProcessMessages.map(m=>[m.text,m.ts]),[['先查配置。',ts+1000],['现在验证。',ts+2000]]);
});
test('DeepSeek disk reasoning_text survives line filter; encrypted-only content is never displayed',()=>{
  const record=(type,payload,n)=>({type,payload,timestamp:new Date(ts+n*1000).toISOString()});
  const rows=[record('event_msg',{type:'user_message',message:'问题'},0),
    record('response_item',{type:'reasoning',summary:[],content:[{type:'reasoning_text',text:'中文思考'}]},1),
    record('response_item',{type:'reasoning',encrypted_content:'SECRET'},2),
    record('event_msg',{type:'agent_message',message:'最后结果',phase:'final_answer'},3)];
  const turns=parseCodexRolloutText(rows.map(JSON.stringify).join('\n'));
  const card=displayChatTurns(turns).at(-1);
  assert.equal(card.text,'最后结果');
  assert.deepEqual(card.chatProcessMessages.map(m=>[m.text,m.ts]),[['中文思考',ts+1000]]);
  assert(!JSON.stringify(turns).includes('SECRET'));
});
test('Kimi native think chunks appear before step.end with stable id and first-chunk timestamp',()=>{
  const ev=(event,n)=>({type:'context.append_loop_event',time:ts+n*1000,event});
  const rows=[{type:'turn.prompt',time:ts,input:[{type:'text',text:'检查'}]},
    ev({type:'step.begin',uuid:'s'},1),
    ev({type:'content.part',stepUuid:'s',part:{type:'think',think:'先看'}},2),
    ev({type:'content.part',stepUuid:'s',part:{type:'think',think:'配置。'}},3)];
  const live=displayChatTurns(parseKimiWireRecords(rows)).at(-1);
  assert.equal(live.text,'');
  assert.equal(live.chatProcessMessages[0].text,'先看配置。');
  assert.equal(live.chatProcessMessages[0].ts,ts+2000);
  rows.push(ev({type:'content.part',stepUuid:'s',part:{type:'text',text:'验证通过。'}},4),ev({type:'step.end',uuid:'s',finishReason:'stop'},5));
  const done=displayChatTurns(parseKimiWireRecords(rows)).at(-1);
  assert.equal(done.id,live.id);
  assert.equal(done.chatProcessMessages[0].id,live.chatProcessMessages[0].id);
  assert.equal(done.text,'验证通过。');
});
test('Kimi clearing a turn also clears thinking before the next prompt arrives',()=>{
  const {KimiTap}=require('../core/kimi-transcript-tap');
  const bound={streamingText:'old answer',steps:new Map([['s',{thinking:'旧轮思考'}]])};
  const tap={_bound:new Map([['hub',bound]])};
  assert.equal(KimiTap.prototype.getStreamingText.call(tap,'hub')[0].thinking,'旧轮思考');
  KimiTap.prototype.clearStreamingBuf.call(tap,'hub');
  assert.equal(KimiTap.prototype.getStreamingText.call(tap,'hub'),null);
});
