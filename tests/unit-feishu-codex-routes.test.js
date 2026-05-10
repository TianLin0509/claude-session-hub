'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const { createFeishuCodexRouter, normalizeEvent } = require('../core/feishu-codex-routes.js');

function req(port, path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

async function withServer(app, fn) {
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    await fn(server.address().port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function testNormalizeEvent() {
  const evt = normalizeEvent({
    event: {
      message: {
        chat_id: 'chat-a',
        thread_id: 'thread-a',
        message_id: 'msg-a',
        content: JSON.stringify({ text: '新建 codex：测试' }),
      },
      sender: { sender_id: { open_id: 'ou-a' } },
    },
  });
  assert.strictEqual(evt.chatId, 'chat-a');
  assert.strictEqual(evt.threadId, 'thread-a');
  assert.strictEqual(evt.messageId, 'msg-a');
  assert.strictEqual(evt.senderId, 'ou-a');
  assert.strictEqual(evt.text, '新建 codex：测试');
  console.log('  ok normalizeEvent');
}

async function testTokenAndDispatch() {
  const calls = [];
  const gateway = {
    async handleIncoming(evt) {
      calls.push(evt);
      return { ok: true, action: 'received', text: evt.text };
    },
  };
  const app = express();
  app.use('/api/feishu/codex', createFeishuCodexRouter({ gateway, token: 'secret' }));

  await withServer(app, async (port) => {
    const bad = await req(port, '/api/feishu/codex/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '状态', chatId: 'c1' }),
    });
    assert.strictEqual(bad.status, 401);

    const good = await req(port, '/api/feishu/codex/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hub-feishu-token': 'secret' },
      body: JSON.stringify({ text: '状态', chatId: 'c1', threadId: 't1' }),
    });
    assert.strictEqual(good.status, 200);
    assert.strictEqual(JSON.parse(good.body).action, 'received');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].threadId, 't1');
  });
  console.log('  ok token + dispatch');
}

(async () => {
  console.log('Running Feishu Codex route tests...');
  testNormalizeEvent();
  await testTokenAndDispatch();
  console.log('All passed.');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
