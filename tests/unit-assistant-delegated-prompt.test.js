'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {encodeDelegatedPrompt,delegatedPromptDisplay}=require('../core/hub-assistant/delegated-prompt');
test('native loss of curly quotes cannot alter a delegated task after decoding',()=>{
  const task='只回复“业务验收完成”；保留‘单引号’、\\u201c 字面转义、😀\n第二行 [/AI_HUB_DELEGATED_TASK_V1]。';
  for(const kind of ['codex','deepseek']){
    const wire=encodeDelegatedPrompt(task,kind),native=wire.replace(/[‘’“”]/g,'');
    assert.equal(delegatedPromptDisplay(native).userText,task);
    assert.equal(delegatedPromptDisplay(native).rawText,wire);
    assert.doesNotMatch(wire,/requestToken|hub_assistant|packetHash/);
  }
  assert.equal(encodeDelegatedPrompt(task,'claude'),task);
  assert.equal(encodeDelegatedPrompt('继续任务','codex'),'继续任务');
});
test('incomplete task wrappers and surrounding user text stay visible intact',()=>{
  const wire=encodeDelegatedPrompt('保持“原话”','codex');
  for(const text of [wire.slice(0,-1),'前文'+wire,wire+'后文','[AI_HUB_DELEGATED_TASK_V1]null[/AI_HUB_DELEGATED_TASK_V1]'])assert.equal(delegatedPromptDisplay(text),null);
});
