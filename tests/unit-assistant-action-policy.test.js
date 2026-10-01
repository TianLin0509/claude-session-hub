'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { actionIntent, requireAuthorizedTarget, bindOperation } = require('../core/hub-assistant/action-policy');
const { AssistantStore } = require('../core/hub-assistant/store');
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-policy-'));
  const store = new AssistantStore(dir);
  t.after(() => { store.close(); assert(fs.realpathSync(dir).startsWith(fs.realpathSync(os.tmpdir()) + path.sep)); fs.rmSync(dir, { recursive: true, force: true }); });
  return store;
}
test('historical questions and negation do not grant action authority', () => {
  for (const text of ['桌宠研究之前发送过什么要求？', '我不想让桌宠研究继续', '请汇报桌宠研究进展', '之前让桌宠研究继续了吗？', '请告诉我怎么创建一个会话', '创建一个会话要多久？', '创建一个会话是什么意思？', '不要创建会话', '我不需要恢复会话']) {
    assert.equal(actionIntent(text, 'send'), false, text); assert.equal(actionIntent(text, 'create'), false, text);
  }
});
test('explicit polite action commands remain usable', () => {
  assert.equal(actionIntent('能不能帮我创建一个会话研究企鹅', 'create'), true);
  assert.equal(actionIntent('你能不能帮我创建一个会话研究企鹅', 'create'), true);
  assert.equal(actionIntent('请让桌宠研究继续做设计', 'send'), true);
  assert.equal(actionIntent('把这个要求转交给桌宠研究', 'send'), true);
  assert.equal(actionIntent('继续桌宠研究', 'send'), true);
  assert.equal(actionIntent('能不能帮我让桌宠研究继续？', 'send'), true);
  assert.equal(actionIntent('让桌宠研究继续之前先读最新交付', 'send'), true);
});

test('prerequisite and advisability questions cannot dispatch even with an exact target', () => {
  const sessions = [{ id: 'id-alpha', title: '桌宠研究' }];
  const questions = [
    '让桌宠研究继续之前有什么需要确认的？',
    '让桌宠研究继续前，还有哪些需要确认的？',
    '让桌宠研究继续之前需要注意什么？',
    '让桌宠研究继续是否合适？',
    '让桌宠研究继续是不是更合适？',
    '让桌宠研究继续合适吗？',
    '让 id-alpha 继续是否合适？',
    '创建一个会话之前有什么需要确认的？',
    '创建一个会话是否合理？',
  ];
  for (const text of questions) {
    assert.equal(actionIntent(text, 'send'), false, text);
    assert.equal(actionIntent(text, 'create'), false, text);
    assert.throws(() => requireAuthorizedTarget({ text }, { type: 'send', targetSessionId: 'id-alpha', text: '继续' }, sessions), /本轮未明确委托/, text);
  }
});
test('duplicate titles need an exact stable ID', () => {
  const sessions = [{ id: 'id-alpha', title: '桌宠研究' }, { id: 'id-beta', title: '桌宠研究' }];
  const action = { type: 'send', targetSessionId: 'id-beta', text: '继续' };
  assert.throws(() => requireAuthorizedTarget({ text: '让桌宠研究继续' }, action, sessions), /同名会话/);
  assert.doesNotThrow(() => requireAuthorizedTarget({ text: '让 id-beta 继续' }, action, sessions));
  assert.doesNotThrow(() => requireAuthorizedTarget({ text: '让桌宠研究继续' }, action, sessions.slice(1)));
});
test('one operation key cannot change payload, target, or action type', t => {
  const store = setup(t), current = { id: 'request-one' }, action = { type: 'send', targetSessionId: 'a', text: '做设计' };
  const first = bindOperation(store, current, 'one', action);
  assert.equal(bindOperation(store, current, 'one', action), first);
  for (const changed of [{ ...action, text: '做设计。' }, { ...action, targetSessionId: 'b' }, { type: 'create', title: '设计', text: action.text }]) {
    assert.throws(() => bindOperation(store, current, 'one', changed), /operationKey.*不同/);
  }
});
test('business shorthand dispatches only to a unique host-verified title', () => {
  const sessions = [{ id:'orders', title:'订单同步验收-1001' }, { id:'customers', title:'客户回访-1001' }];
  const action = { type:'send', targetSessionId:'orders', text:'推进' };
  for (const text of ['请推进「订单同步」业务，完成后提醒我', '请推进订单同步业务：读取需求继续完成', '请让订单同步继续处理', '推进昨天的订单同步']) {
    assert.doesNotThrow(() => requireAuthorizedTarget({text}, action, sessions), text);
    assert.throws(() => requireAuthorizedTarget({text}, {...action,targetSessionId:'customers'}, sessions), /未绑定/);
  }
  assert.throws(() => requireAuthorizedTarget({text:'推进订单同步'}, action, [...sessions,{id:'other',title:'订单同步旧版本'}]), /多个会话/);
  assert.throws(() => requireAuthorizedTarget({text:'订单同步推进到哪里了？'}, action, sessions), /未明确委托/);
  assert.throws(() => requireAuthorizedTarget({text:'推进订单同步是否合适？'}, action, sessions), /未明确委托/);
});
test('different operation keys for same payload share the same durable intent', t => {
  const store = setup(t), current = { id: 'request-two' }, action = { type: 'send', targetSessionId: 'a', text: '做设计' };
  assert.equal(bindOperation(store, current, 'one', action), bindOperation(store, current, 'retry-other-key', action));
  assert.notEqual(bindOperation(store, current, 'one', action), bindOperation(store, { id: 'new-user-request' }, 'one', action));
});
test('create is limited to one stable task per user request, with readable refusal', t => {
  const store = setup(t), current = { id: 'request-three' }, action = { type: 'create', title: '研究企鹅', text: '研究企鹅' };
  const first = bindOperation(store, current, 'one', action);
  assert.equal(bindOperation(store, current, 'another-key', action), first);
  assert.throws(() => bindOperation(store, current, 'new-key', { ...action, text: '研究企鹅。' }), /每轮创建一个/);
  assert.doesNotThrow(() => bindOperation(store, { id: 'next-request' }, 'one', { ...action, text: '研究企鹅。' }));
});
test('operation binding survives another store connection', t => {
  const store = setup(t), current = { id: 'durable-request' }, action = { type: 'send', targetSessionId: 'a', text: '继续' };
  const first = bindOperation(store, current, 'one', action);
  const second = new AssistantStore(path.dirname(store.db.location()));
  try {
    assert.equal(bindOperation(second, current, 'one', action), first);
    assert.throws(() => bindOperation(second, current, 'one', { ...action, text: '不同要求' }), /operationKey.*不同/);
  } finally { second.close(); }
});
