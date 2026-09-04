'use strict';
// 剪贴板只允许一个写入方（2026-09-04）。
//
// 用户现象：点右上角「复制对话」之后，再在界面里选一小段按 Ctrl+C，
// 浮层明明报「已复制 13 字」，Ctrl+V 粘出来的却还是刚才那整段对话。
//
// 根因是全 app 有两个剪贴板写入方：
//   - 「复制对话」按钮走 navigator.clipboard.writeText（渲染进程 / Chromium 自己的异步剪贴板）
//   - Ctrl+C 走 Electron 原生 clipboard.writeText（主进程侧）
// navigator 那次写入让 Chromium 认为自己仍持有剪贴板；随后的原生写入不会让它作废，
// 于是「写后读回校验」看到的是原生剪贴板（已更新、所以报成功），
// 而浮动输入框的原生粘贴拿的是 Chromium 的旧缓存（还是那段对话）。
//
// 这里锁住的不变量：**「复制对话」必须和 Ctrl+C 用同一个写入方**。
// 只要有人把它改回 navigator.clipboard，或忘了在 renderer 里接线，这些断言就红。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createRecentTurnCopyController } = require('../renderer/recent-turn-copy.js');
const { createClipboardController } = require('../renderer/clipboard-controller.js');

const ROOT = path.resolve(__dirname, '..');

// 最小 DOM 替身。必须真的产出一个完整轮次（问 + 答），否则 copyRecent 会在
// 「暂无完整轮次」处提前返回，写剪贴板那段根本不执行 —— 断言就成了空转。
function mkNode(id, extra = {}) {
  return {
    id,
    hidden: false,
    textContent: '复制对话',
    dataset: {},
    classList: { add() {}, remove() {} },
    value: '1',
    options: [],
    addEventListener() {},
    appendChild() {},
    querySelectorAll: () => [],
    querySelector: () => null,
    ...extra,
  };
}

function fakeDomWithOneRound() {
  const turns = new Map([
    ['t1', { role: 'user' }],
    ['t2', { role: 'assistant', kind: 'claude', model: 'claude-opus-5' }],
  ]);
  const texts = new Map([['t1', '这是我的问题'], ['t2', '这是 AI 的回答']]);
  const card = (turnId) => mkNode(turnId, {
    dataset: { turnId, sessionId: 's1' },
    querySelector: () => mkNode(`${turnId}-body`, { __turnId: turnId }),
  });
  const overlay = mkNode('msg-overlay', {
    querySelectorAll: () => [card('t1'), card('t2')],
  });
  const nodes = {
    'recent-turn-copy': mkNode('recent-turn-copy'),
    'recent-turn-copy-count': mkNode('recent-turn-copy-count'),
    'recent-turn-copy-button': mkNode('recent-turn-copy-button'),
    'msg-overlay': overlay,
  };
  return {
    document: {
      getElementById: (id) => (id in nodes ? nodes[id] : null),
      createElement: () => mkNode('created'),
      querySelectorAll: () => [],
      addEventListener() {},
    },
    getTurnById: (id) => turns.get(id),
    extractVisibleCardText: (body) => texts.get(body && body.__turnId) || '',
  };
}

test('「复制对话」走注入的 copyText，绝不碰 navigator.clipboard', async () => {
  const dom = fakeDomWithOneRound();
  const copied = [];
  let navigatorWrites = 0;

  const controller = createRecentTurnCopyController({
    document: dom.document,
    window: { navigator: {}, MutationObserver: null },
    navigator: {
      clipboard: {
        writeText: async () => { navigatorWrites += 1; },
      },
    },
    storage: null,
    getActiveSessionId: () => 's1',
    getTurnById: dom.getTurnById,
    extractVisibleCardText: dom.extractVisibleCardText,
    copyText: async (text, options) => {
      copied.push({ text, options });
      return { ok: true, length: text.length };
    },
  });
  controller.init();

  const result = await controller.copyRecent();

  // 先证明这次真的走到了写剪贴板那一步，否则下面全是空转。
  assert.ok(result && result.text, 'fixture 必须产出可复制的正文，否则本用例是空转');
  assert.equal(copied.length, 1, '必须且只能经由注入的 copyText 写一次');
  assert.match(copied[0].text, /这是我的问题[\s\S]*这是 AI 的回答/);
  assert.equal(navigatorWrites, 0,
    'navigator.clipboard 是第二个写入方，正是这个 bug 的根源，一次都不许调用');
  assert.equal(copied[0].options && copied[0].options.silent, true,
    '按钮自带反馈，注入的写入方要静默，否则同一次复制弹两处提示');
  assert.equal(copied[0].options && copied[0].options.source, 'recent-turn-copy',
    '来源要可辨认，出问题时才能从反馈里认出是哪条路径');
});

test('注入的写入方失败时，按钮必须显示失败而不是假成功', async () => {
  const dom = fakeDomWithOneRound();
  const controller = createRecentTurnCopyController({
    document: dom.document,
    window: { navigator: {}, MutationObserver: null },
    navigator: { clipboard: { writeText: async () => {} } },
    storage: null,
    getActiveSessionId: () => 's1',
    getTurnById: dom.getTurnById,
    extractVisibleCardText: dom.extractVisibleCardText,
    copyText: async () => ({ ok: false, reason: 'clipboard verification mismatch' }),
  });
  controller.init();
  const result = await controller.copyRecent();
  assert.ok(result.error, '写入方报 ok:false 时必须冒泡成错误，不能当成功');
  assert.match(result.error, /mismatch/);
});

test('silent 只关浮层，不影响写入与校验结果', async () => {
  const writes = [];
  let stored = '';
  const feedback = [];
  const controller = createClipboardController({
    document: null,
    window: null,
    clipboard: {
      writeText(text) { writes.push(text); stored = text; },
      readText() { return stored; },
    },
    retryDelaysMs: [0],
    renderFeedback: false,
    onFeedback: (payload) => feedback.push(payload),
  });

  const loud = await controller.copyText('第一段', { source: 'unit' });
  assert.equal(loud.ok, true);
  assert.equal(feedback.length, 1, '默认仍然上报反馈');

  const quiet = await controller.copyText('第二段', { source: 'unit', silent: true });
  assert.equal(quiet.ok, true, 'silent 不得影响写入结果');
  assert.equal(stored, '第二段', 'silent 仍然要真的写进剪贴板');
  assert.equal(feedback.length, 1, 'silent 不得再触发反馈');
  assert.deepEqual(writes, ['第一段', '第二段']);
});

test('silent 失败时也如实返回 ok:false，不会被静默吞掉', async () => {
  const controller = createClipboardController({
    document: null,
    window: null,
    // 写进去但读回来永远是别的内容 → 校验失败
    clipboard: { writeText() {}, readText() { return '别的内容'; } },
    retryDelaysMs: [0, 0],
    renderFeedback: false,
  });
  const result = await controller.copyText('要复制的', { silent: true });
  assert.equal(result.ok, false, 'silent 只关提示，不关结果 —— 否则按钮会把失败显示成成功');
  assert.equal(result.attempts, 2);
});

test('renderer 必须把 clipboardController 接到「复制对话」上', () => {
  // 单测只能证明模块支持注入；真正的接线在 renderer.js 里，漏接就等于 bug 复发。
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
  const start = src.indexOf('createRecentTurnCopyController({');
  assert.ok(start > 0, '定位不到 createRecentTurnCopyController 调用');
  const block = src.slice(start, src.indexOf('});', start) + 3);
  assert.match(block, /copyText:\s*\(text,\s*options\)\s*=>\s*clipboardController\.copyText\(/,
    '「复制对话」必须复用 clipboardController.copyText，不能自己写剪贴板');
  assert.ok(src.indexOf('const clipboardController = createClipboardController') < start,
    'clipboardController 必须先于此处定义，否则运行时 undefined');
});

test('recent-turn-copy 不得再把 navigator.clipboard 当主路径', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'recent-turn-copy.js'), 'utf8');
  const start = src.indexOf('async function copyRecent()');
  assert.ok(start > 0, '定位不到 copyRecent');
  const body = src.slice(start, src.indexOf('\n  function onCountChanged', start));
  assert.ok(body.length > 200, 'copyRecent 片段定位失败');
  assert.ok(!/nav\.clipboard\.writeText/.test(body),
    'copyRecent 里不得直接写 navigator.clipboard —— 那正是第二个写入方');
  assert.match(body, /writeClipboardText\(/,
    'copyRecent 必须经由统一的 writeClipboardText 写剪贴板');
});
