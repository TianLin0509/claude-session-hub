'use strict';

const assert = require('assert');
const {
  extractTextContent,
  normalizeMessageEvent,
  shouldIgnoreEvent,
  resolveDomain,
} = require('../core/feishu-ws-receiver.js');

function testExtractTextContent() {
  assert.strictEqual(extractTextContent({
    message_type: 'text',
    content: JSON.stringify({ text: '新建 codex：测试' }),
  }), '新建 codex：测试');
  assert.strictEqual(extractTextContent({
    message_type: 'image',
    content: JSON.stringify({ image_key: 'x' }),
  }), '');
  assert.strictEqual(extractTextContent({ content: 'plain' }), 'plain');
  console.log('  ok extractTextContent');
}

function testNormalizeMessageEvent() {
  const evt = normalizeMessageEvent({
    sender: {
      sender_type: 'user',
      sender_id: { open_id: 'ou-user' },
    },
    message: {
      chat_id: 'chat-a',
      root_id: 'root-a',
      parent_id: 'parent-a',
      message_id: 'msg-a',
      message_type: 'text',
      content: JSON.stringify({ text: '状态' }),
    },
  });
  assert.strictEqual(evt.chatId, 'chat-a');
  assert.strictEqual(evt.threadId, 'root-a');
  assert.strictEqual(evt.messageId, 'msg-a');
  assert.strictEqual(evt.senderId, 'ou-user');
  assert.strictEqual(evt.senderType, 'user');
  assert.strictEqual(evt.text, '状态');
  console.log('  ok normalizeMessageEvent');
}

function testShouldIgnoreEvent() {
  assert.strictEqual(shouldIgnoreEvent({ text: '' }), true);
  assert.strictEqual(shouldIgnoreEvent({ text: 'hi', senderType: 'app' }), true);
  assert.strictEqual(shouldIgnoreEvent({ text: 'hi', senderType: 'user', senderId: 'bot' }, { botOpenId: 'bot' }), true);
  assert.strictEqual(shouldIgnoreEvent({ text: 'hi', senderType: 'user', senderId: 'u' }, { botOpenId: 'bot' }), false);
  console.log('  ok shouldIgnoreEvent');
}

function testResolveDomain() {
  const Lark = { Domain: { Feishu: 'feishu-domain', Lark: 'lark-domain' } };
  assert.strictEqual(resolveDomain(Lark, 'feishu'), 'feishu-domain');
  assert.strictEqual(resolveDomain(Lark, 'lark'), 'lark-domain');
  assert.strictEqual(resolveDomain(Lark, 'https://example.test/'), 'https://example.test');
  console.log('  ok resolveDomain');
}

console.log('Running Feishu WS receiver tests...');
testExtractTextContent();
testNormalizeMessageEvent();
testShouldIgnoreEvent();
testResolveDomain();
console.log('All passed.');
