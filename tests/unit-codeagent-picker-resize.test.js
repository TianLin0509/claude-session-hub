'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { SessionManager } = require('../core/session-manager');
const { TerminalSnapshot } = require('../core/terminal-snapshot');
const picker = require('../core/codeagent-model-picker');

// 2026-10-15 GUI 受控 CLI 的真实 PTY 记录：ConPTY 为 36 行菜单逐行清屏。
// 缺少 30→36 resize 时，30 行观察镜像把菜单头和模型行滚走，只剩 footer。
const MENU = ['Select model', '', '  ❯ 1. GLM-5.2-WX-Auto', '    2. MiniMax-M2.7', '',
  '  Enter to set as default · s to use this session only · Esc to cancel'];
const repaint = rows => '\x1b[2J\x1b[H' + Array.from({ length: rows }, (_, i) => (MENU[i] || '') + '\x1b[K').join('\r\n') + '\x1b[9;1H';

function harness() {
  const manager = new SessionManager(), sid = 'resize-picker';
  const terminalSnapshot = new TerminalSnapshot({ cols: 120, rows: 30 });
  const pty = { resize() {} };
  manager.sessions.set(sid, { info: { id: sid, kind: 'codeagent' }, pty, terminalSnapshot,
    outputChars: 0, ringBuffer: '', lastOutputSeq: 0 });
  function output(data) {
    const seq = ++manager._outputSeq;
    manager.sessions.get(sid).lastOutputSeq = seq;
    manager._appendToRingBuffer(sid, data);
    terminalSnapshot.write(data, seq);
    manager.emit('output', { sessionId: sid, seq, data });
  }
  return { manager, sid, output, terminalSnapshot };
}

test('实时 resize 与输出共用序号：36 行菜单顶部保留，尺寸变化不伪造新输出字符', async () => {
  const h = harness();
  h.output('before resize');
  const mark = h.manager.getSessionOutputMark(h.sid);
  const screen = await picker.openSessionScreen(h.manager, h.sid);
  try {
    let resize;
    h.manager.once('terminal-resized', event => { resize = event; });
    h.manager.resizeSession(h.sid, 126, 36);
    assert.equal(resize?.seq, 2);
    assert.equal((await h.manager.getSessionBufferSnapshot(h.sid)).seq, 2);
    assert.equal(h.manager.getSessionOutputMark(h.sid), mark);
    assert.equal(h.manager.getSessionOutputSince(h.sid, mark), '');
    h.output(repaint(36));
    const lines = await screen.lines();
    assert.equal(lines.length, 36);
    assert.deepEqual(picker.parsePicker(lines).rows.map(row => row.label), ['GLM-5.2-WX-Auto', 'MiniMax-M2.7']);
    assert.equal(picker.promptInputReady(lines), false);
  } finally { screen.dispose(); h.terminalSnapshot.dispose(); }
  assert.equal(h.manager.listenerCount('output'), 0);
  assert.equal(h.manager.listenerCount('terminal-resized'), 0);
});

test('初始化快照 barrier 后的 resize 和重绘按原顺序补放', async () => {
  const h = harness(), original = h.manager.getSessionBufferSnapshot.bind(h.manager);
  const snapshot = await original(h.sid);
  let release;
  h.manager.getSessionBufferSnapshot = () => new Promise(resolve => { release = () => resolve(snapshot); });
  const opening = picker.openSessionScreen(h.manager, h.sid);
  h.manager.resizeSession(h.sid, 126, 36);
  h.output(repaint(36));
  release();
  const screen = await opening;
  try {
    const lines = await screen.lines();
    assert.equal(lines.length, 36);
    assert.ok(picker.parsePicker(lines));
  } finally { screen.dispose(); h.terminalSnapshot.dispose(); }
});

test('已包含在初始快照内的 resize 和输出不得重复回放，同尺寸强制刷新也推进 barrier', async () => {
  const h = harness(), original = h.manager.getSessionBufferSnapshot.bind(h.manager);
  let release;
  h.manager.getSessionBufferSnapshot = () => new Promise(resolve => { release = resolve; });
  const opening = picker.openSessionScreen(h.manager, h.sid);
  h.manager.resizeSession(h.sid, 126, 36);
  h.output('ONCE');
  h.manager.resizeSession(h.sid, 126, 36);
  const snapshot = await original(h.sid);
  assert.equal(snapshot.seq, 3);
  release(snapshot);
  const screen = await opening;
  try {
    assert.equal((await screen.lines()).join('\n').match(/ONCE/g)?.length, 1);
    assert.equal((await screen.lines()).length, 36);
  } finally { screen.dispose(); h.terminalSnapshot.dispose(); }
});

test('快照读取失败必须传播并释放 output/resize 监听', async () => {
  const h = harness();
  h.manager.getSessionBufferSnapshot = async () => { throw new Error('snapshot unavailable'); };
  await assert.rejects(picker.openSessionScreen(h.manager, h.sid), /snapshot unavailable/);
  assert.equal(h.manager.listenerCount('output'), 0);
  assert.equal(h.manager.listenerCount('terminal-resized'), 0);
  h.terminalSnapshot.dispose();
});

test('/model 的发送回执使用实际 36 行菜单，不能被固定 30 行运行探针误判为 stuck', async () => {
  const { EventEmitter } = require('node:events');
  const watcher = require('../core/group-chat-watcher');
  const h = harness();
  const writes = [];
  Object.assign(h.manager, {
    getSession: () => ({ id: h.sid, kind: 'codeagent' }),
    getGroupChatReady: () => true,
    getGroupChatLastActivity: () => 0,
    getAgentTurnStartSeq: () => 0,
    writeToSession(_sid, data) {
      writes.push(data);
      if (data === '\r') { h.manager.resizeSession(h.sid, 126, 36); h.output(repaint(36)); }
    },
  });
  watcher.init({ sessionManager: h.manager, transcriptTap: new EventEmitter(),
    cliReadyDetector: { isReady: () => true }, bracketedPasteSettleMs: 1 });
  try {
    const result = await watcher.sendToPty(h.sid, '/model', 'codeagent', { codeagentModelPick: true, requireReady: false });
    assert.equal(result.sendStatus, 'ok');
    assert.equal(result.acknowledgementSource, 'cli-model-command');
    assert.equal(writes.filter(data => data === '\r').length, 1);
    assert.equal(h.manager.listenerCount('output'), 0);
    assert.equal(h.manager.listenerCount('terminal-resized'), 0);
  } finally { h.terminalSnapshot.dispose(); }
});

test('/model 开始前快照失败是明确未发送，不能写命令或遗留监听', async () => {
  const { EventEmitter } = require('node:events');
  const watcher = require('../core/group-chat-watcher');
  const h = harness(), writes = [];
  Object.assign(h.manager, {
    getSession: () => ({ id: h.sid, kind: 'codeagent' }),
    getGroupChatReady: () => true,
    getGroupChatLastActivity: () => 0,
    getAgentTurnStartSeq: () => 0,
    getSessionBufferSnapshot: async () => { throw new Error('snapshot unavailable'); },
    writeToSession: (_sid, data) => writes.push(data),
  });
  watcher.init({ sessionManager: h.manager, transcriptTap: new EventEmitter(),
    cliReadyDetector: { isReady: () => true }, bracketedPasteSettleMs: 1 });
  try {
    await assert.rejects(watcher.sendToPty(h.sid, '/model', 'codeagent', { codeagentModelPick: true, requireReady: false }),
      error => error.notSent === true && /snapshot unavailable/.test(error.message));
    assert.deepEqual(writes, []);
    assert.equal(h.manager.listenerCount('output'), 0);
    assert.equal(h.manager.listenerCount('terminal-resized'), 0);
    assert.equal(h.manager.listenerCount('agent-turn-started'), 0);
  } finally { h.terminalSnapshot.dispose(); }
});
