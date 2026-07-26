'use strict';
// 2026-05-15 道雪 群聊弹顶 bug 修复配套契约测试。
//
// Bug：群聊视图（聊天流模式）下 AI 思考/streaming/完成时，partial-update IPC handler
//   走 line 2937 兜底分支（panel.innerHTML 全量重渲），导致 .mr-gc-messages 容器被
//   销毁重建，scrollTop 丢失（用户感知"弹到最上方最初的问答"）。
//
// 修复：渲染时给每条 .mr-gc-msg 加稳定 anchor data-gc-msg-id；partial-update 在群聊
//   视图下走专属局部 patch 分支，不动 .mr-gc-messages 容器。
//
// 测试方式：renderer/meeting-room.js 是 IIFE 包裹的 renderer 脚本，不便 require 调
//   内部函数。这里用契约测试（grep 源码）锁定关键模式不被回归。行为级验证（真实
//   滚动位置保留）依赖 Playwright + 真实 Hub 实例，已明示用户走 e2e。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC_PATH = path.join(__dirname, '..', 'renderer', 'meeting-room.js');
const src = fs.readFileSync(SRC_PATH, 'utf-8');

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.error('  ✗ ' + name);
    console.error('    ' + (e.message || e));
  }
}

// ---------------- 契约 1：_renderGroupChatMessage 必须输出 data-gc-msg-id ----------------
test('_renderGroupChatMessage 给 article.mr-gc-msg 加 data-gc-msg-id（局部 patch anchor）', () => {
  const fnIdx = src.indexOf('function _renderGroupChatMessage');
  assert.ok(fnIdx > 0, '_renderGroupChatMessage 函数必须存在');
  // 函数体截到下一个函数定义为止（2026-07-12：状态占位逻辑加长了函数，固定 2500
  //   字符窗口截不到 return 模板尾部；按边界截取不再受函数长度影响）
  const fnEnd = src.indexOf('function _renderGroupChatPending', fnIdx);
  const body = src.slice(fnIdx, fnEnd > fnIdx ? fnEnd : fnIdx + 8000);
  assert.ok(/data-gc-msg-id\s*=/.test(body),
    '_renderGroupChatMessage 必须在 article 标签上输出 data-gc-msg-id（让 partial-update 能按 id 找到节点局部更新，不动 .mr-gc-messages 容器）');
  // 必须用 message.id 作 anchor（不能写死或用 sid）。允许中间用变量承接：
  //   const anchorId = escapeHtml(message.id || ''); ... data-gc-msg-id="${anchorId}"
  assert.ok(/escapeHtml\(message\.id/.test(body) || /data-gc-msg-id="\$\{[^}]*message\.id/.test(body),
    'data-gc-msg-id 必须取自 message.id（orchestrator 的 u${n} / a${turnNum}-${sid} / 渲染层 pending-${sid}）');
});

// ---------------- 契约 2：partial-update 群聊视图走专属 patch 路径 ----------------
test('groupchat-partial-update 在群聊视图下走局部 patch 而非全量重渲', () => {
  const handlerIdx = src.indexOf("ipcRenderer.on('groupchat-partial-update'");
  assert.ok(handlerIdx > 0, 'groupchat-partial-update handler 必须存在');
  // 取整个 handler 函数体（足够长覆盖到下一个 ipcRenderer.on）
  const nextIpcIdx = src.indexOf('ipcRenderer.on(', handlerIdx + 1);
  const body = src.slice(handlerIdx, nextIpcIdx > 0 ? nextIpcIdx : handlerIdx + 8000);
  // 必须调用 _patchGroupChatPendingMessage（专属局部 patch 入口，详细 anchor 选择器
  //   字面量由 contract 3 在该函数体里校验）
  assert.ok(/_patchGroupChatPendingMessage\s*\(/.test(body),
    'partial-update handler 必须在群聊视图下调 _patchGroupChatPendingMessage 走局部 patch，不能掉到全量 panel.innerHTML 重渲（会销毁 .mr-gc-messages 容器、丢失 scrollTop）');
  // 必须有群聊视图判断（meeting.groupChat 或 _getGroupViewMode）
  assert.ok(/meeting\.groupChat/.test(body) && /_getGroupViewMode/.test(body),
    'partial-update handler 必须先判断群聊视图模式才走专属分支');
});

// ---------------- 契约 3：群聊专属 patch 不重写 .mr-gc-messages 容器 ----------------
test('群聊 partial-update patch 路径只更新单条 article，不动 .mr-gc-messages', () => {
  // 找出群聊 patch 分支（_patchGroupChatPendingMessage 或类似函数 / 内联块）
  // 我们采用辅助函数命名约定：_patchGroupChatPendingMessage
  const fnIdx = src.indexOf('function _patchGroupChatPendingMessage');
  assert.ok(fnIdx > 0,
    '必须有专属辅助函数 _patchGroupChatPendingMessage 负责群聊局部 patch（保持代码可读性 + 单测可锁）');
  const body = src.slice(fnIdx, fnIdx + 1500);
  // 函数体内禁止出现 .mr-gc-messages 容器级 innerHTML 重写
  assert.ok(!/\.mr-gc-messages[^.]*\.innerHTML\s*=/.test(body),
    'patch 函数禁止直接重写 .mr-gc-messages.innerHTML（违反"局部 patch 不动容器"原则）');
  // 函数体必须按 data-gc-msg-id 查找
  assert.ok(/data-gc-msg-id/.test(body),
    'patch 函数必须用 data-gc-msg-id 选择器找节点');
});

// ---------------- 契约 4：fallback 全量重渲仅在 patch 失败/非群聊视图时走 ----------------
test('partial-update fallback 全量重渲仍保留（兼容卡片视图 + 群聊 patch 失败兜底）', () => {
  const handlerIdx = src.indexOf("ipcRenderer.on('groupchat-partial-update'");
  const nextIpcIdx = src.indexOf('ipcRenderer.on(', handlerIdx + 1);
  const body = src.slice(handlerIdx, nextIpcIdx > 0 ? nextIpcIdx : handlerIdx + 8000);
  // 兜底全量重渲调用必须仍存在（卡片视图 + 群聊兜底用）。允许直接写 panel.innerHTML，
  // 也允许通过 _renderGcPanelInto helper 承接 capture/restore scroll 的统一路径。
  assert.ok(/panel\.innerHTML\s*=\s*_renderGcPanelHtml/.test(body) || /_renderGcPanelInto\s*\(\s*panel\s*,\s*meeting\s*,\s*cached/.test(body),
    '全量重渲分支必须保留作为兜底（用于：① 卡片视图首次渲染 ② 群聊视图 patch 失败时）');
  // 但群聊视图的"找不到 .mr-ft"路径不能再直接掉进全量重渲（必须先尝试群聊 patch）
  // 反向锁：找不到 .mr-ft 时，必须先调 _patchGroupChatPendingMessage 而非直接 fallback
  assert.ok(/_patchGroupChatPendingMessage/.test(body),
    'partial-update handler 必须显式调用 _patchGroupChatPendingMessage（在群聊视图下走它而非 fallback）');
});

console.log('Running unit-group-chat-scroll-preserve contract tests...');
console.log(`\n${failed === 0 ? '✓ all passed' : '✗ ' + failed + ' failed'}`);
process.exit(failed > 0 ? 1 : 0);
