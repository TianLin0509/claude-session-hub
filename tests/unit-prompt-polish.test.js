'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createPromptPolisher, MAX_INPUT_CHARS } = require('../core/prompt-polish');
const { registerPromptPolishIpc } = require('../main/ipc/prompt-polish-handlers');
const ok = (content = '先讨论，确认后实现。', finish_reason = 'stop') => ({ ok: true, json: async () => ({ choices: [{ finish_reason, message: { content } }] }) });
async function main() {
  let calls = 0;
  const getConfig = () => ({ deepseekApiKey: 'test-secret' });
  const polish = createPromptPolisher({ getConfig, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://api.deepseek.com/chat/completions');
    const request = JSON.parse(options.body);
    assert.equal(request.model, 'deepseek-flash'); assert.equal(request.thinking.type, 'disabled');
    assert.equal(request.messages[1].content, '先讨论，嗯，确认后实现。');
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    return ok();
  } });
  assert.equal((await polish('先讨论，嗯，确认后实现。')).text, '先讨论，确认后实现。');
  await assert.rejects(polish(' '), /先输入/);
  await assert.rejects(polish('中'.repeat(MAX_INPUT_CHARS + 1)), /分段/);
  assert.equal(calls, 1, 'invalid input must not cause a paid request');
  await assert.rejects(createPromptPolisher({ getConfig: () => ({}) })('草稿'), /配置/);
  for (const response of [ok('', 'stop'), ok('partial', 'length'), ok('partial', 'content_filter'), ok('changed')]) {
    const p = createPromptPolisher({ getConfig, fetchImpl: async () => response });
    await assert.rejects(p('保留 `C:/AIWork/文件.md`'), /正文|完整|代码或引用/);
  }
  const error = createPromptPolisher({ getConfig, fetchImpl: async () => ({ ok: false, status: 401, json: () => { throw Error('test-secret'); } }) });
  await assert.rejects(error('草稿'), e => /密钥无效/.test(e.message) && !e.message.includes('test-secret'));
  const hangs = (_url, { signal }) => new Promise((_resolve, reject) => {
    if (signal.aborted) reject(Error('aborted'));
    else signal.addEventListener('abort', () => reject(Error('aborted')), { once: true });
  });
  await assert.rejects(createPromptPolisher({ getConfig, fetchImpl: hangs, timeoutMs: 15 })('草稿'), /超时/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createPromptPolisher({ getConfig, fetchImpl: hangs })('草稿', { signal: controller.signal }), /取消/);
  const handlers = new Map(), pending = [];
  registerPromptPolishIpc({ handle: (name, fn) => handlers.set(name, fn) }, { getConfig, polish: (_text, { signal }) => new Promise((resolve, reject) => {
    pending.push({ signal, resolve }); signal.addEventListener('abort', () => reject(Error('已取消')), { once: true });
  }) });
  const one = Object.assign(new EventEmitter(), { id: 1 }), two = Object.assign(new EventEmitter(), { id: 2 });
  const call = (sender, channel, args) => handlers.get(channel)({ sender }, args);
  const first = call(one, 'prompt:polish', { id: 'a', text: '草稿' });
  assert.equal((await call(one, 'prompt:polish', { id: 'a', text: '草稿' })).ok, false);
  call(two, 'prompt:polish-cancel', 'a'); assert(!pending[0].signal.aborted);
  call(one, 'prompt:polish-cancel', 'a'); assert.equal((await first).ok, false);
  const second = call(one, 'prompt:polish', { id: 'b', text: '草稿' });
  const third = call(one, 'prompt:polish', { id: 'c', text: '草稿' });
  assert.equal((await call(one, 'prompt:polish', { id: 'd', text: '草稿' })).ok, false);
  one.emit('destroyed'); assert.equal((await second).ok, false); assert.equal((await third).ok, false);
  console.log('PASS prompt polish: Flash/non-thinking, input bounds, partial/empty/literal protection, safe errors, timeout/cancel, window ownership/concurrency/cleanup');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
