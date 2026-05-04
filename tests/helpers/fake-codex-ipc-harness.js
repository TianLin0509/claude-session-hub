// Fake codex IPC harness — 单测辅助
//
// 用途：mimic Electron ipcMain.handle / ipcRenderer.invoke / sendToRenderer 的双向 IPC，
// 让 Phase 1/2/3 单测能离开真实 BrowserWindow 跑被测的 IPC handler 逻辑。
//
// 覆盖 main.js 当前所有 roundtable-* IPC：
//   handle 类（renderer → main，4 个）
//     - roundtable-manual-extract
//     - roundtable-resend-prompt
//     - roundtable-skip-participant
//     - roundtable-resend-participant
//   push 类（main → renderer，6 个事件）
//     - roundtable-state-update
//     - roundtable-partial-update
//     - roundtable-turn-complete
//     - roundtable-turn-patched
//     - roundtable-soft-alert
//     - roundtable-send-stuck
//
// **本轮（v2）新增 IPC**（plan B3.1-B3.3）：
//     - roundtable-codex-bind-status (handle 类)
// 见 docs/superpowers/plans/2026-05-04-codex-roundtable-equiv.md
//
// 设计原则：
//  - 单 instance 同时模拟 main 端和 renderer 端
//  - 提供 timeline 录制（按时序记录所有 IPC payload 给单测断言）
//  - 提供 waitForEvent / waitForReply 异步原语

const { EventEmitter } = require('events');

class FakeIpcHarness {
  constructor() {
    this._handlers = new Map();      // channel → handler
    this._renderer = new EventEmitter();  // sendToRenderer 推送目标
    this._timeline = [];             // 全量 IPC 流水
  }

  // ------- main 端 API（被测代码用）-------

  // mimic ipcMain.handle
  handle(channel, handler) {
    if (this._handlers.has(channel)) {
      throw new Error(`FakeIpcHarness: channel "${channel}" already registered`);
    }
    this._handlers.set(channel, handler);
  }

  // mimic sendToRenderer(channel, payload)
  sendToRenderer(channel, payload) {
    this._record('main->renderer', channel, payload);
    // setImmediate 模拟跨进程异步边界
    setImmediate(() => this._renderer.emit(channel, payload));
  }

  // ------- renderer 端 API（单测脚本用）-------

  // mimic ipcRenderer.invoke
  async invoke(channel, payload) {
    this._record('renderer->main:invoke', channel, payload);
    const handler = this._handlers.get(channel);
    if (!handler) throw new Error(`FakeIpcHarness: no handler for "${channel}"`);
    const fakeEvent = {};   // ipc handler 第一个参数（this/event）
    const reply = await handler(fakeEvent, payload);
    this._record('main->renderer:reply', channel, reply);
    return reply;
  }

  // mimic ipcRenderer.on
  on(channel, listener) {
    this._renderer.on(channel, listener);
  }

  // 异步等某个 push 事件（带超时）
  async waitForEvent(channel, { timeoutMs = 1000, predicate = null } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._renderer.off(channel, onEvent);
        reject(new Error(`FakeIpcHarness.waitForEvent timeout: ${channel} after ${timeoutMs}ms`));
      }, timeoutMs);
      const onEvent = (payload) => {
        if (predicate && !predicate(payload)) return;
        clearTimeout(timer);
        this._renderer.off(channel, onEvent);
        resolve(payload);
      };
      this._renderer.on(channel, onEvent);
    });
  }

  // ------- 调试 / 断言辅助 -------

  // 取全量 IPC 流水（按时序）
  getTimeline() {
    return [...this._timeline];
  }

  // 过滤 timeline：只看某个 channel 的事件
  getEvents(channel) {
    return this._timeline.filter((e) => e.channel === channel);
  }

  // 取某个 push 事件最后一次的 payload（renderer 端常用）
  getLastEvent(channel, direction = 'main->renderer') {
    const events = this._timeline.filter((e) => e.channel === channel && e.direction === direction);
    return events.length > 0 ? events[events.length - 1].payload : null;
  }

  // 清空 timeline（多个测试 case 之间隔离）
  resetTimeline() {
    this._timeline = [];
  }

  // 卸载所有 handler 与 renderer listener（teardown）
  reset() {
    this._handlers.clear();
    this._renderer.removeAllListeners();
    this._timeline = [];
  }

  _record(direction, channel, payload) {
    this._timeline.push({
      ts: Date.now(),
      direction,
      channel,
      payload: _safeClone(payload),
    });
  }
}

function _safeClone(obj) {
  if (obj === undefined || obj === null) return obj;
  try { return JSON.parse(JSON.stringify(obj)); }
  catch { return String(obj); }  // 含函数 / 循环引用时降级
}

// 已知 IPC channel 清单（用于 schema 校验或 lint）
const KNOWN_CHANNELS = {
  handle: [
    'roundtable-manual-extract',
    'roundtable-resend-prompt',
    'roundtable-skip-participant',
    'roundtable-resend-participant',
    // v2 新增（Phase 3 待落）
    // 'roundtable-codex-bind-status',
  ],
  push: [
    'roundtable-state-update',
    'roundtable-partial-update',
    'roundtable-turn-complete',
    'roundtable-turn-patched',
    'roundtable-soft-alert',
    'roundtable-send-stuck',
  ],
};

module.exports = { FakeIpcHarness, KNOWN_CHANNELS };
