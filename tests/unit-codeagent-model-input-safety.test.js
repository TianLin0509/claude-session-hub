'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const picker = require('../core/codeagent-model-picker');

// 输入框来自 unit-codeagent-launch / trust-screen 的公司实录样本。
const IDLE = [' │ > Anything I can assist you with? (Ctrl+J 换行 · esc×2 清空 · ↑↓ 历史) │',
  ' │ Bypass (Cycle shift+tab) | GLM-5.2-WX-Auto │'];
// 故障注入：菜单标题已知，选项布局故意不可解析；不宣称这是公司真机菜单。
const UNKNOWN_MENU = ['  Select model', '  搜索模型：', '  (unrecognized options)'];
const KNOWN_MENU = ['  Select model', '  ❯ 1. GLM-5.2-WX-Auto', '    2. MiniMax-M2.7',
  '  Enter to set as default · s to use this session only · Esc to cancel'];

function harness(sid, initial = IDLE, { escapeWorks = true } = {}) {
  const manager = new EventEmitter();
  const writes = [];
  let lines = initial, seq = 0;
  function paint(next) {
    lines = next;
    manager.emit('output', { sessionId: sid, data: '\x1b[2J\x1b[H' + lines.join('\r\n'), seq: ++seq });
  }
  manager.getSessionBufferSnapshot = async () => ({ text: lines.join('\r\n'), seq, cols: 120, rows: 30 });
  manager.getSessionBuffer = () => lines.join('\n');
  manager.writeToSession = (_sid, data) => {
    writes.push(data);
    if (data === '\x1b' && escapeWorks) setTimeout(() => paint(IDLE), 10);
  };
  return { manager, writes, paint };
}

function sender(sid, h) {
  const watcher = require('../core/group-chat-watcher');
  const { registerPromptSubmitIpc } = require('../main/ipc/prompt-submit-handlers');
  let turn = 0;
  const write = h.manager.writeToSession;
  Object.assign(h.manager, {
    getSession: () => ({ id: sid, kind: 'codeagent' }),
    getGroupChatReady: () => true,
    setGroupChatReady() {},
    getGroupChatLastActivity: () => 0,
    getAgentTurnStartSeq: () => turn,
    writeToSession(id, data) {
      write(id, data);
      if (data === '\r') setImmediate(() => h.manager.emit('agent-turn-started', { sessionId: sid, seq: ++turn, signalSource: 'test-ack' }));
    },
  });
  watcher.init({ sessionManager: h.manager, transcriptTap: new EventEmitter(),
    cliReadyDetector: { isReady: () => true }, bracketedPasteSettleMs: 1,
    agentTurnStartAckMs: 100, agentTurnStartRecoveryMs: 40 });
  const handlers = new Map();
  registerPromptSubmitIpc({ handle: (name, fn) => handlers.set(name, fn) },
    { sessionManager: h.manager, logger: { log() {}, warn() {} } });
  return text => handlers.get('session:send-prompt')(null, { sessionId: sid, text });
}

test('菜单已打开但布局不能解析：退出必须靠普通输入框恢复，不能把 parsePicker=null 当作关闭', async () => {
  const h = harness('unknown-close');
  const result = await picker.pickModel({ manager: h.manager, sid: 'unknown-close', kind: 'codeagent',
    modelId: 'MiniMax-M2.7', screenTimeoutMs: 30, env: {},
    sendToPty: async () => { h.paint(UNKNOWN_MENU); return { ok: true, sendStatus: 'stuck' }; } });
  assert.equal(result.ok, false);
  assert.deepEqual(h.writes, ['\x1b']);
  assert.equal(result.inputReady, true);
});

test('选模型失败不能被 waitForPick 转成普通完成', async () => {
  let finish;
  const task = picker.schedulePick('pick-failed', () => new Promise(resolve => { finish = resolve; }));
  const waiting = assert.rejects(picker.waitForPick('pick-failed'), error => error.notSent === true);
  await new Promise(resolve => setImmediate(resolve));
  finish({ ok: false, inputReady: false, message: '菜单未退出' });
  await task;
  await waiting;
});

test('选模型等待超时是明确未发送，不能放正文穿过仍在运行的菜单操作', async () => {
  let finish;
  const task = picker.schedulePick('pick-timeout', () => new Promise(resolve => { finish = resolve; }));
  const waiting = assert.rejects(picker.waitForPick('pick-timeout', 10), error => error.notSent === true && error.code === 'codeagent-model-pick-timeout');
  await new Promise(resolve => setTimeout(resolve, 20));
  finish({ ok: true });
  await task;
  await waiting;
});

test('Esc 没有生效时失败状态不能伪装成输入已恢复', async () => {
  const h = harness('escape-ignored', UNKNOWN_MENU, { escapeWorks: false });
  let commands = 0;
  const result = await picker.pickModel({ manager: h.manager, sid: 'escape-ignored', kind: 'codeagent',
    modelId: 'MiniMax-M2.7', screenTimeoutMs: 30, env: {},
    sendToPty: async () => { commands++; return { ok: true }; } });
  assert.equal(commands, 0, '已有菜单不能再次把 /model 写进它的搜索框');
  assert.deepEqual(h.writes, ['\x1b']);
  assert.equal(result.ok, false);
  assert.equal(result.inputReady, false);
});

test('晚到正文：pending 已删除仍保护菜单，手动退出后一次重发可接上', async () => {
  const sid = 'late-after-failure', h = harness(sid, UNKNOWN_MENU);
  const send = sender(sid, h);
  await picker.schedulePick(sid, async () => ({ ok: false, inputReady: false, message: '不能识别模型菜单' }));
  assert.equal(picker.isPicking(sid), false);
  const blocked = await send('正文保留');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.notSent, true);
  assert.deepEqual(h.writes, [], '没有任何正文、回车或清空按键进入搜索框');
  h.paint(IDLE);
  const retried = await send('正文保留');
  assert.equal(retried.ok, true);
  assert.equal(retried.sendStatus, 'ok');
  assert.equal(h.writes.filter(data => data.includes('正文保留')).length, 1);
  assert.equal(h.writes.filter(data => data === '\r').length, 1);
});

test('失败已自动退出：首条仍说明未选中模型并保留，用户再次发送才沿用当前模型', async () => {
  const sid = 'safe-default-retry', h = harness(sid), send = sender(sid, h);
  await picker.schedulePick(sid, async () => ({ ok: false, inputReady: true, message: '所选模型未切换' }));
  const blocked = await send('不能悄悄换模型');
  assert.equal(blocked.notSent, true);
  assert.match(blocked.message, /再次发送/);
  assert.equal(h.writes.length, 0);
  assert.equal((await send('不能悄悄换模型')).sendStatus, 'ok');
});

test('ready 已缓存、也没有 pending 时，当前 Select model 仍拦住普通发送', async () => {
  const sid = 'manual-menu-ready-cache', h = harness(sid, UNKNOWN_MENU), send = sender(sid, h);
  const result = await send('不是模型搜索词');
  assert.equal(result.notSent, true);
  assert.equal(h.writes.length, 0);
  h.paint(IDLE);
  assert.equal((await send('不是模型搜索词')).sendStatus, 'ok');
});

test('正文已经入队后再开始选模型：正文明确未发，菜单命令随后完成而不自锁', async () => {
  const sid = 'pick-after-prompt-enqueue', h = harness(sid), send = sender(sid, h);
  const snapshot = h.manager.getSessionBufferSnapshot;
  let releaseSnapshot;
  h.manager.getSessionBufferSnapshot = () => new Promise(resolve => { releaseSnapshot = async () => {
    h.manager.getSessionBufferSnapshot = snapshot;
    resolve(await snapshot());
  }; });
  const ordinary = send('必须保留的正文');
  while (!releaseSnapshot) await new Promise(resolve => setImmediate(resolve));
  const modelTask = picker.schedulePick(sid, () => require('../core/group-chat-watcher').sendToPty(
    sid, '模型操作占位', 'codeagent', { codeagentModelPick: true, requireReady: false }));
  await new Promise(resolve => setImmediate(resolve));
  await releaseSnapshot();
  const [normalResult, modelResult] = await Promise.all([ordinary, modelTask]);
  assert.equal(normalResult.notSent, true);
  assert.equal(modelResult.ok, true);
  assert.equal(h.writes.some(data => data.includes('必须保留的正文')), false);
  assert.equal(h.writes.filter(data => data.includes('模型操作占位')).length, 1);
});

test('选项可识别且有切换回显，也必须恢复普通输入框后才成功', async () => {
  const sid = 'confirmed-picker', h = harness(sid);
  let output = '';
  h.manager.getSessionOutputMark = () => 0;
  h.manager.getSessionOutputSince = () => output;
  h.manager.writeToSession = (_sid, data) => {
    h.writes.push(data);
    if (data === 's') { output = 'Set model to MiniMax-M2.7'; h.paint(IDLE); }
  };
  const result = await picker.pickModel({ manager: h.manager, sid, kind: 'codeagent', modelId: 'MiniMax-M2.7',
    screenTimeoutMs: 500, env: {}, sendToPty: async () => { h.paint(KNOWN_MENU); return { ok: true }; } });
  assert.equal(result.ok, true);
  assert.equal(result.confirmed, true);
  assert.equal(result.inputReady, true);
  assert.deepEqual(h.writes, ['\x1b[B', 's']);
});

test('选择后变成不可解析的菜单不能伪装成成功，哪怕选项解析已经返回 null', async () => {
  const sid = 'changed-menu', h = harness(sid, IDLE, { escapeWorks: false });
  h.manager.writeToSession = (_sid, data) => { h.writes.push(data); if (data === 's') h.paint(UNKNOWN_MENU); };
  const result = await picker.pickModel({ manager: h.manager, sid, kind: 'codeagent', modelId: 'MiniMax-M2.7',
    screenTimeoutMs: 30, env: {}, sendToPty: async () => { h.paint(KNOWN_MENU); return { ok: true }; } });
  assert.equal(result.ok, false);
  assert.equal(result.inputReady, false);
  assert.deepEqual(h.writes, ['\x1b[B', 's', '\x1b']);
});
