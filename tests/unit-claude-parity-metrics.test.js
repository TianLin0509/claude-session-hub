'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {ClaudeNativeSession, digest} = require('../core/claude-native-session');
const {claudeTranscriptTurns} = require('../core/claude-native-transcript');
const {displayTurns} = require('../core/conversation-display');
const {claudeTurnMetrics} = require('../core/claude-turn-metrics');

function record() {
  const content = [{type:'text', text:'question'}];
  return {submissionId:'s', userMessageId:'u', providerSessionId:randomUUID(), text:'question', content,
    promptFingerprint:digest(content), status:'completed', createdAt:1000, completedAt:10000, finalText:'answer',
    result:{usage:{input_tokens:500, cache_read_input_tokens:40000, output_tokens:80}, duration_ms:8000,
      modelUsage:{'claude-test':{contextWindow:1000000}}},
    transcriptMessages:[{type:'assistant', uuid:'a', hubObservedAt:9000,
      message:{id:'m', model:'claude-test', usage:{input_tokens:100,cache_read_input_tokens:9900,output_tokens:30},
        stop_reason:'end_turn', content:[{type:'text',text:'answer'}]}}]};
}
test('journal restoration recovers result tokens, model and duration on exactly the final card', async () => {
  const saved = record();
  const driver = new ClaudeNativeSession({sessionId:saved.providerSessionId, restoredRecords:[saved]});
  try {
    const cards = displayTurns(driver.transcript());
    const final = cards.find(c => c.phase === 'final_answer');
    assert.equal(final.model,'claude-test');
    assert.equal(final.durationMs,8000);
    assert.deepEqual(final.usage,{input_tokens:40500, output_tokens:80, context_tokens:10000, context_window:1000000});
    assert.equal(cards.filter(c => c.usage).length,1);
  } finally {await driver.close();}
});
test('missing context never borrows aggregate inputs; duplicate and child messages do not inflate usage', () => {
  assert.equal(claudeTurnMetrics({result:{usage:{input_tokens:900000}}},[]).usage.context_tokens,null);
  const message={type:'assistant',message:{id:'m',usage:{input_tokens:10,output_tokens:2}}};
  const child={type:'assistant',parent_tool_use_id:'tool',message:{id:'child',usage:{input_tokens:999}}};
  assert.deepEqual(claudeTurnMetrics({},[message,message,child]).usage,{input_tokens:10,output_tokens:2,context_tokens:10});
});
test('continuations sum consumption while retaining the newest context observation and one result owner', () => {
  const first=record(); first.messages=new Map(first.transcriptMessages.map(f=>[f.uuid,f]));
  const next={...record(),nativeActivity:true,origin:{kind:'task-notification'},userMessageId:'next',createdAt:11000,completedAt:15000};
  next.messages=new Map(next.transcriptMessages.map(f=>[f.uuid,f]));
  const cards=displayTurns(claudeTranscriptTurns([first,next]));
  const owner=cards.find(c=>c.usage);
  assert.equal(cards.filter(c=>c.usage).length,1);
  assert.equal(owner.usage.input_tokens,81000);
  assert.equal(owner.usage.context_tokens,10000);
  assert.equal(owner.durationMs,14000);
});
