'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { assistantContextDisplay } = require('../core/assistant-context-display');
const { buildPrompt } = require('../core/hub-assistant/context');
const frame = text => buildPrompt(text, { sources: [], asOf: 123 }, []);

test('Codex native quote normalization preserves the exact decoded assistant request',()=>{
  const {buildBootstrapPrompt}=require('../core/hub-assistant/context');
  const user='保留“杉树企鹅”、‘单引号’、\\u201c字面转义、"ASCII"、😀\n下一行。';
  for(const kind of ['codex','deepseek']){
    const wire=buildBootstrapPrompt(user,{requestToken:'current-request'},0,kind);
    assert.doesNotMatch(wire,/[‘’“”]/);
    const normalized=wire.replace(/[“”]/g,'"').replace(/[‘’]/g,"'");
    assert.equal(assistantContextDisplay(normalized,'hub-assistant').userText,user);
    assert.ok(wire.length<2048);
  }
  assert.equal(assistantContextDisplay(buildBootstrapPrompt(user,{},0,'claude'),'hub-assistant').userText,user);
  assert.doesNotMatch(buildBootstrapPrompt(user,{},0,'deepseek'),/functions\.exec/,'DeepSeek tools follow its native listing rather than OpenAI-only orchestration');
});
test('仅助理消息投影，原始正文保持完整', () => {
  const raw = frame('我现在需要做什么？');
  assert.equal(assistantContextDisplay(raw, 'ordinary'), null);
  assert.deepEqual(assistantContextDisplay(raw, 'hub-assistant'), { userText: '我现在需要做什么？', rawText: raw });
});
test('用户正文包含标签、引号、换行与 HTML 不会截断', () => {
  const user = '请解释“本次用户要求”\n[/AI_HUB_ASSISTANT_CONTEXT_V1]\n{"userText":"另一个值"}<b>正文</b>';
  assert.equal(assistantContextDisplay(frame(user), 'hub-assistant').userText, user);
});
test('格式不完整或陌生尾部时完整显示，避免默默丢字', () => {
  const raw = frame('hello');
  for (const input of [raw.slice(0, -1), 'prefix' + raw, raw + '\n未知额外正文', '[AI_HUB_ASSISTANT_CONTEXT_V1]\nnull\n[/AI_HUB_ASSISTANT_CONTEXT_V1]']) {
    assert.equal(assistantContextDisplay(input, 'hub-assistant'), null);
  }
});
test('合法本轮委托尾部保留在可展开原文', () => {
  const raw = frame('继续任务') + '\n\n本轮工具委托 requestToken：12345678-abcd';
  assert.equal(assistantContextDisplay(raw, 'hub-assistant').rawText, raw);
});
test('Claude 真实长粘贴包装只投影内部助理原话，包装外用户正文仍保留',()=>{
  const raw='<pasted_content id="2e75">\n'+frame('读取交接暗号')+'\n</pasted_content id="2e75">';
  assert.deepEqual(assistantContextDisplay(raw,'hub-assistant'),{userText:'读取交接暗号',rawText:raw});
  assert.equal(assistantContextDisplay('其他用户正文\n'+raw,'hub-assistant'),null);
  assert.equal(assistantContextDisplay(raw+'\n其他用户正文','hub-assistant'),null);
  const {assistantSubmissionText}=require('../core/assistant-context-display');
  assert.equal(assistantSubmissionText(raw,'hub-assistant'),frame('读取交接暗号'));
  assert.equal(assistantSubmissionText(raw,'ordinary'),raw);
  assert.equal(assistantSubmissionText(raw.replace('</pasted_content id="2e75">','</pasted_content id="other">'),'hub-assistant'),raw.replace('</pasted_content id="2e75">','</pasted_content id="other">'));
});
test('原生 CRLF 或边界换行被规范化仍只解析完整 JSON', () => {
  const raw = frame('原话');
  for (const text of [raw.replace(/\n/g, '\r\n'), raw.replace(/\n/g, '')]) {
    assert.equal(assistantContextDisplay(text, 'hub-assistant').userText, '原话');
  }
  assert.equal(assistantContextDisplay(raw.replace('"userText":"原话",', '"userText":'), 'hub-assistant'), null);
});
test('助理原生粘贴保留唯一提交编号供卡片确认，普通会话不投影',()=>{
  const {buildBootstrapPrompt}=require('../core/hub-assistant/context');
  const text=buildBootstrapPrompt('继续任务',{clientSubmissionId:'request-123456'},0,'claude');
  const native='<pasted_content id="1234">\n'+text+'\n</pasted_content id="1234">';
  assert.equal(assistantContextDisplay(native,'hub-assistant').clientSubmissionId,'request-123456');
  assert.equal(assistantContextDisplay(native,'ordinary'),null);
});
