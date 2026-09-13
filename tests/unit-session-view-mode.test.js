'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');

const {
  CARD,
  PTY,
  LIMIT,
  STORAGE_KEY,
  forgetViewMode,
  normalizeViewMode,
  readCardViewSessions,
  rememberViewMode,
  selectionViewModeFor,
  viewModeFor,
  writeCardViewSessions,
} = require(path.join(__dirname, '..', 'core', 'session-view-mode.js'));

function makeStore(initial) {
  const data = initial === undefined ? {} : { [STORAGE_KEY]: initial };
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem(k, v) { data[k] = String(v); },
    _data: data,
  };
}

test('默认是 PTY，只有记过的会话才是卡片', () => {
  const set = new Set();
  assert.equal(viewModeFor(set, 's1'), PTY);
  rememberViewMode(set, 's1', CARD);
  assert.equal(viewModeFor(set, 's1'), CARD);
  assert.equal(viewModeFor(set, 's2'), PTY, '记住 s1 不该影响 s2');
  rememberViewMode(set, 's1', PTY);
  assert.equal(viewModeFor(set, 's1'), PTY);
  assert.equal(set.size, 0, '退回 PTY 应当把条目删掉，而不是留一条 pty 记录');
});

test('会话之间互不干扰（这就是本次修的 bug）', () => {
  const set = new Set();
  rememberViewMode(set, 'A', CARD);
  rememberViewMode(set, 'B', PTY);
  assert.equal(viewModeFor(set, 'A'), CARD);
  assert.equal(viewModeFor(set, 'B'), PTY);
  // 从 B 切回 A，A 仍应是卡片
  assert.equal(viewModeFor(set, 'A'), CARD);
});

test('rememberViewMode 只在真的变化时返回 true（调用方据此决定落盘）', () => {
  const set = new Set();
  assert.equal(rememberViewMode(set, 's', CARD), true);
  assert.equal(rememberViewMode(set, 's', CARD), false, '重复设同一个值不该反复写盘');
  assert.equal(rememberViewMode(set, 's', PTY), true);
  assert.equal(rememberViewMode(set, 's', PTY), false);
  assert.equal(rememberViewMode(set, '', CARD), false);
  assert.equal(rememberViewMode(null, 's', CARD), false);
});

test('未知模式一律归一到 PTY', () => {
  assert.equal(normalizeViewMode('card'), CARD);
  assert.equal(normalizeViewMode('pty'), PTY);
  assert.equal(normalizeViewMode('banana'), PTY);
  assert.equal(normalizeViewMode(undefined), PTY);
  const set = new Set(['s']);
  rememberViewMode(set, 's', 'banana');
  assert.equal(set.has('s'), false, '脏值应当按 PTY 处理，把条目删掉');
});

test('落盘与读回', () => {
  const store = makeStore();
  const set = new Set(['a', 'b']);
  assert.equal(writeCardViewSessions(store, set), true);
  assert.deepEqual([...readCardViewSessions(store)].sort(), ['a', 'b']);
});

test('脏数据 / 存储不可用都不该抛', () => {
  assert.deepEqual([...readCardViewSessions(makeStore('不是 json'))], []);
  assert.deepEqual([...readCardViewSessions(makeStore('{"a":1}'))], [], '不是数组就当空');
  assert.deepEqual([...readCardViewSessions(makeStore('[1,2,null]'))], [], '非字符串项要滤掉');
  assert.deepEqual([...readCardViewSessions(null)], []);
  assert.equal(writeCardViewSessions(null, new Set(['a'])), false);
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.doesNotThrow(() => readCardViewSessions(throwing));
  assert.equal(writeCardViewSessions(throwing, new Set(['a'])), false);
});

test('超过上限只保留最近加入的，不会把 localStorage 撑爆', () => {
  const store = makeStore();
  const set = new Set();
  for (let i = 0; i < LIMIT + 25; i++) set.add('s' + i);
  writeCardViewSessions(store, set);
  const back = readCardViewSessions(store);
  assert.equal(back.size, LIMIT);
  assert.equal(back.has('s' + (LIMIT + 24)), true, '最近加入的要留下');
  assert.equal(back.has('s0'), false, '最早加入的先丢');
});

test('会话关闭后清掉记忆', () => {
  const set = new Set(['gone', 'stay']);
  assert.equal(forgetViewMode(set, 'gone'), true);
  assert.equal(forgetViewMode(set, 'gone'), false, '再删一次不该报变化');
  assert.equal(viewModeFor(set, 'gone'), PTY);
  assert.equal(viewModeFor(set, 'stay'), CARD);
});

// —— 下面锁的是 renderer.js 的接线，光有纯函数正确还不够 ——
test('renderer 必须在 selectSession 里计算默认卡片视图，并且选择时不写记忆', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  // 所有普通 AI session 都走同一个默认入口；PowerShell 由 helper 明确留在 PTY。
  assert.match(src, /const targetView = selectionViewModeForSession\(id, session\);/,
    'selectSession 必须先算出该会话的视图');
  assert.match(src, /applyViewMode\(targetView, \{ remember: false, skipPreviousCardCapture: true \}\);/,
    '选择视图由 showTerminal 单次加载历史，不能由 applyViewMode 再并发加载');
  assert.match(src, /const shouldFocusTerminal = switching \|\| targetView === 'pty';/,
    '卡片视图下不该抢终端焦点');
  // 搜索跳转与启动兜底都不能改写用户的视图偏好
  assert.match(src, /applyViewMode\('card', \{ remember: false \}\)/);
  assert.match(src, /applyViewMode\('pty', \{ remember: false \}\)/);
  assert.match(src, /forgetViewModeForSession\(sessionId\)/, '会话关闭要清记忆');
});

test('renderer 必须在打开会话时清掉断连标记', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const select = src.slice(src.indexOf('async function selectSession'));
  const body = select.slice(0, select.indexOf('\n}\n'));
  // 2026-08-28 起收紧为 acknowledgeSessionFailureState：光清 connectionIssue 不够，
  // 断连同时把 runtimeTruth 打成了 RUNTIME_FAILED（终态），不一起降级的话会话仍然
  // 挂在「⚠ 运行异常」分区里；它内部照旧调 clearSessionConnectionIssue。
  assert.match(body, /acknowledgeSessionFailureState\(session\)/,
    '「运行异常/断连」是提醒信号，用户点开看过就该消失');
  const ack = src.slice(src.indexOf('function acknowledgeSessionFailureState'));
  const ackBody = ack.slice(0, ack.indexOf('\n}\n'));
  assert.match(ackBody, /clearSessionConnectionIssue\(session,/);
  assert.match(ackBody, /RUNTIME_FAILED/);
  assert.match(ackBody, /RUNTIME_IDLE/);
});


test('所有可生成卡片的会话每次点开都默认进卡片，终端会话仍进 PTY', () => {
  const set = new Set();
  assert.equal(selectionViewModeFor(set, 's1', { cardCapable: true }), CARD);
  rememberViewMode(set, 's1', PTY);
  assert.equal(selectionViewModeFor(set, 's1', { cardCapable: true }), CARD,
    '上次手动看后台不能改变下次点开时的默认卡片视图');
  assert.equal(selectionViewModeFor(set, 'shell', { cardCapable: false }), PTY);
  assert.equal(set.size, 0, '默认视图判定本身不应写入偏好');
});

test('renderer 的 selectSession 和 session-created 走同一默认卡片规则', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const select = src.slice(src.indexOf('async function selectSession'));
  const body = select.slice(0, select.indexOf('\n}\n'));
  assert.match(body, /selectionViewModeForSession\(id, session\)/,
    '点击打开必须经过统一视图判断');
  const helper = src.slice(src.indexOf('function selectionViewModeForSession'));
  const helperBody = helper.slice(0, helper.indexOf('\n}\n'));
  assert.match(helperBody, /cardCapable/,
    '选择视图必须显式区分结构化卡片会话与 PowerShell');
  assert.match(helperBody, /selectionViewModeFor\(cardViewSessions/);
  assert.match(src, /requestedView \|\| selectionViewModeForSession\(session\.id, session\)/,
    '新建和休眠恢复也必须走同一条默认卡片规则');
});

console.log('unit-session-view-mode OK');

test('成员首次卡片初始化记录与普通视图记忆使用独立存储，不互相覆盖', () => {
  const data = new Map();
  const store = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  writeCardViewSessions(store, new Set(['normal']));
  writeCardViewSessions(store, new Set(['member']), 'hub.memberCardDefaults');
  assert.deepEqual([...readCardViewSessions(store)], ['normal']);
  assert.deepEqual([...readCardViewSessions(store, 'hub.memberCardDefaults')], ['member']);
});
