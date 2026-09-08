'use strict';
/**
 * 仅测试启用的钩子必须在生产里彻底不存在。
 *
 * I 层要在真实 Hub 上跑闸门逻辑，就得有一个地方替掉「派发一轮」和「席位就绪」。
 * 任务书允许这种故障注入点，但写死了一条：**不得默认启用或影响生产**。
 * 这个文件就是那条线的看守。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadTestHooks } = require('../main/groupchat/test-dispatch-stub.js');

let pass = 0;
function test(name, fn) { fn(); pass++; console.log('  ✓ ' + name); }

console.log('test-hooks 生产惰性');

test('生产（非隔离实例）无论 env 怎么设都拿不到钩子', () => {
  const before = process.env.CLAUDE_HUB_TEST_DISPATCH_SCRIPT;
  process.env.CLAUDE_HUB_TEST_DISPATCH_SCRIPT = 'C:/whatever/script.js';
  try {
    assert.strictEqual(loadTestHooks({ isIsolatedHub: () => false, getHubDataDir: () => 'C:/x', meetingManager: {} }), null,
      '不是隔离实例 → 一律 null，哪怕 env 已经设了');
  } finally {
    if (before === undefined) delete process.env.CLAUDE_HUB_TEST_DISPATCH_SCRIPT;
    else process.env.CLAUDE_HUB_TEST_DISPATCH_SCRIPT = before;
  }
});

test('隔离实例但没显式给脚本 → 同样拿不到钩子', () => {
  const before = process.env.CLAUDE_HUB_TEST_DISPATCH_SCRIPT;
  delete process.env.CLAUDE_HUB_TEST_DISPATCH_SCRIPT;
  try {
    assert.strictEqual(loadTestHooks({ isIsolatedHub: () => true, getHubDataDir: () => 'C:/x', meetingManager: {} }), null,
      '两个条件必须同时成立');
  } finally {
    if (before !== undefined) process.env.CLAUDE_HUB_TEST_DISPATCH_SCRIPT = before;
  }
});

test('两个条件都成立时才给出钩子，且只包含这几件东西', () => {
  const before = process.env.CLAUDE_HUB_TEST_DISPATCH_SCRIPT;
  process.env.CLAUDE_HUB_TEST_DISPATCH_SCRIPT = 'C:/whatever/script.js';
  try {
    const hooks = loadTestHooks({
      isIsolatedHub: () => true, getHubDataDir: () => 'C:/x',
      meetingManager: { getMeeting: () => null }, logger: { warn: () => {} },
    });
    assert.ok(hooks && typeof hooks.dispatcher.dispatchGroupChatTurn === 'function');
    assert.ok(typeof hooks.wrapSessionManager === 'function');
    assert.ok(typeof hooks.registerIpc === 'function');
    assert.ok(hooks.stepTextWait && hooks.stepTextWait.docCapMs > 0);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_HUB_TEST_DISPATCH_SCRIPT;
    else process.env.CLAUDE_HUB_TEST_DISPATCH_SCRIPT = before;
  }
});

test('席位外壳只对合成 sid 兜底，真实会话与未知 sid 行为不变', () => {
  const before = process.env.CLAUDE_HUB_TEST_DISPATCH_SCRIPT;
  process.env.CLAUDE_HUB_TEST_DISPATCH_SCRIPT = 'C:/whatever/script.js';
  try {
    const hooks = loadTestHooks({
      isIsolatedHub: () => true, getHubDataDir: () => 'C:/x',
      meetingManager: { getMeeting: () => null }, logger: { warn: () => {} },
    });
    const real = { getSession: (sid) => (sid === 'real-1' ? { id: 'real-1', status: 'idle' } : null), other: () => 42 };
    const wrapped = hooks.wrapSessionManager(real);
    assert.strictEqual(wrapped.getSession('real-1').id, 'real-1', '真实会话原样返回');
    assert.strictEqual(wrapped.getSession('someone-else'), null, '未知 sid 仍然是「不存在」，不许凭空造一个');
    assert.ok(wrapped.getSession('teststub-a'), '只有合成前缀才兜底');
    assert.strictEqual(wrapped.other(), 42, '其余方法照常透传');
  } finally {
    if (before === undefined) delete process.env.CLAUDE_HUB_TEST_DISPATCH_SCRIPT;
    else process.env.CLAUDE_HUB_TEST_DISPATCH_SCRIPT = before;
  }
});

test('main.js 里这条路必须同时受隔离判断和 env 约束，且失败不影响启动', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const region = main.slice(main.indexOf('__testHooks = require'), main.indexOf('__testHooks = require') + 600);
  assert.ok(/isIsolatedHub: require\('\.\/core\/data-dir\.js'\)\.isIsolatedHub/.test(region),
    '隔离判断必须传进去，不能在模块里自己猜');
  assert.ok(/catch \(e\) \{ console\.warn\('\[test-hooks\] 加载失败/.test(main),
    '钩子加载失败不能拖垮 Hub 启动');
  assert.ok(/__testHooks \? __testHooks\.dispatcher : groupChatDispatcher/.test(main),
    '没有钩子时必须是真 dispatcher');
  assert.ok(/__testHooks \? __testHooks\.wrapSessionManager\(sessionManager\) : sessionManager/.test(main),
    '没有钩子时必须是真 sessionManager');
});

console.log(`\n${pass} passed`);
