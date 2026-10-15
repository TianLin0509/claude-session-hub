'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const picker = require('../core/codeagent-model-picker');
const watcher = require('../core/group-chat-watcher');
const readiness = require('../core/group-chat-cli-ready-detector');

// Company frame vocabulary is from the recorded 2026-10-08 screen already
// locked by unit-codeagent-launch; draft text is controlled input content.
const IDLE = [' │ > Anything I can assist you with? (Ctrl+J 换行 · esc×2 清空 · ↑↓ 历史) │',
  ' │ Bypass (Cycle shift+tab) | GLM-5.2-WX-Auto │'];
const MENU = ['Select model', '', ' ❯ 1. GLM-5.2-WX-Auto', '   2. MiniMax-M2.7', '',
  ' Enter to set as default · s to use this session only · Esc to cancel'];
const paintText = lines => '\x1b[2J\x1b[H' + lines.join('\r\n');
function harness(sid, initial = IDLE, { ready = true, fresh = false } = {}) {
  const manager = new EventEmitter(), writes = [];
  let lines = initial, seq = 1, turn = 0, inputTarget = 'prompt';
  let raw = 'native startup banner '.repeat(30) + '\r\n' + paintText(initial);
  const meta = { id: sid, kind: 'codeagent', createdAt: fresh ? Date.now() : 0 };
  const paint = (next, target = 'prompt') => {
    lines = next; inputTarget = target; const data = paintText(next); raw += data;
    manager.emit('output', { sessionId: sid, seq: ++seq, data });
  };
  Object.assign(manager, {
    getSession: () => meta,
    getSessionBufferSnapshot: async () => ({ text: paintText(lines), seq, cols: 120, rows: 30 }),
    getSessionBuffer: () => raw,
    getSessionOutputMark: () => raw.length,
    getSessionOutputSince: (_sid, mark) => raw.slice(mark),
    getGroupChatReady: () => ready,
    setGroupChatReady: (_sid, value) => { ready = value; },
    getGroupChatLastActivity: () => 0,
    getAgentTurnStartSeq: () => turn,
    writeToSession(_sid, data) {
      writes.push({ data, target: inputTarget });
      if (data === '\r' && inputTarget === 'prompt') setImmediate(() => manager.emit('agent-turn-started',
        { sessionId: sid, seq: ++turn, signalSource: 'controlled-native-ack' }));
    },
  });
  const initialize = detector => watcher.init({ sessionManager: manager, transcriptTap: new EventEmitter(),
    cliReadyDetector: detector || readiness, bracketedPasteSettleMs: 1,
    agentTurnStartAckMs: 30, agentTurnStartRecoveryMs: 20 });
  return { manager, sid, paint, writes, initialize };
}

test('未知/空白屏不能当普通输入区，明确 notSent 且零写入', async () => {
  const h = harness('unknown-input-target', ['']); h.initialize();
  await assert.rejects(watcher.sendToPty(h.sid, '保留草稿', 'codeagent', { requireReady: false }),
    error => error.notSent === true);
  assert.deepEqual(h.writes, []);
});

test('丢尺寸的 ring 快照不能把36行模型菜单误判为可发送', async () => {
  const h = harness('ring-without-size', MENU); h.initialize();
  h.manager.getSessionBufferSnapshot = async () => ({ seq: 1, text: '\x1b[2J\x1b[H' +
    Array.from({ length: 36 }, (_, i) => (MENU[i] || '') + '\x1b[K').join('\r\n') + '\x1b[9;1H' });
  await assert.rejects(watcher.sendToPty(h.sid, '不能填进搜索框', 'codeagent', { requireReady: false }),
    error => error.notSent === true);
  assert.deepEqual(h.writes, []);
});

test('正常输入检查后首次ready等待期间才出现菜单，最终粘贴前再次拒绝', async () => {
  const h = harness('late-menu-after-input-check', IDLE, { ready: false, fresh: true }); h.initialize();
  const getReady = h.manager.getGroupChatReady; let injected = false;
  h.manager.getGroupChatReady = () => {
    if (!injected) { injected = true; setTimeout(() => h.paint(MENU, 'model-search'), 10); }
    return getReady();
  };
  await assert.rejects(watcher.sendToPty(h.sid, '晚到菜单时仍保稿', 'codeagent', { requireReady: false }),
    error => error.notSent === true);
  assert.deepEqual(h.writes, []);
});

test('等待屏幕队列期间新排入的菜单必须包含在本次读取中', async () => {
  const h = harness('screen-read-barrier'), screen = await picker.openSessionScreen(h.manager, h.sid);
  try {
    h.paint(IDLE); const reading = screen.lines(); h.paint(MENU, 'model-search');
    assert.equal(picker.modelDialogVisible(await reading), true);
  } finally { screen.dispose(); }
  assert.equal(h.manager.listenerCount('output'), 0);
  assert.equal(h.manager.listenerCount('terminal-resized'), 0);
});

for (const [label, screen] of [
  ['公司已有原生草稿', [' │ > 已有草稿，继续补充 │', IDLE[1]]],
  ['公司忙时补充指令', ['  ⠋ Running…', ' │ > 补充指令（Enter 排队等待发送）...']],
  ['Claude替身已有草稿', ['────────────❯ 已有原生草稿', '──⏵⏵ bypass permissions on (shift+tab to cycle)']],
  ['Claude替身编号草稿', ['❯ 1. 请整理学习资料', '? for shortcuts']],
  ['Claude替身忙时输入', ['✳ Thinking… (esc to interrupt)', '❯ 补充说明', '? for shortcuts']],
]) test(`${label}仍可追加正文，不清空原生输入`, async () => {
  const h = harness('input-surface-' + label, screen); h.initialize();
  const result = await watcher.sendToPty(h.sid, '追加正文', 'codeagent', { requireReady: false });
  assert.equal(result.sendStatus, 'ok');
  assert.equal(h.writes.filter(w => w.data.includes('追加正文')).length, 1);
  assert.equal(h.writes.some(w => ['\x15', '\x1b'].includes(w.data)), false);
});

test('首次ready等待中开始选型：最终检查拒绝正文，后续选型不自锁', async () => {
  const h = harness('pick-during-ready', IDLE, { ready: false, fresh: true });
  let modelTask, calls = 0;
  h.initialize({ isReady: () => {
    if (++calls === 1) {
      modelTask = picker.schedulePick(h.sid, () => watcher.sendToPty(h.sid, '受控选型操作', 'codeagent',
        { codeagentModelPick: true, requireReady: false }));
      return false;
    }
    return true;
  } });
  let rejected;
  try { await watcher.sendToPty(h.sid, '并发正文必须保留', 'codeagent', { requireReady: false }); }
  catch (error) { rejected = error; }
  assert.equal((await modelTask).sendStatus, 'ok');
  assert.equal(rejected?.notSent, true);
  assert.equal(h.writes.some(w => w.data.includes('并发正文必须保留')), false);
});

test('用户显式/model仍经菜单语义回执，只提交一次命令', async () => {
  const h = harness('explicit-model-command'); h.initialize();
  const original = h.manager.writeToSession;
  h.manager.writeToSession = (sid, data) => {
    original(sid, data); if (data === '\r') h.paint(MENU, 'model-search');
  };
  const result = await watcher.sendToPty(h.sid, '/model', 'codeagent', { requireReady: false });
  assert.equal(result.sendStatus, 'ok'); assert.equal(result.acknowledgementSource, 'cli-model-command');
  assert.equal(h.writes.filter(w => w.data.includes('/model')).length, 1);
  assert.equal(h.writes.filter(w => w.data === '\r').length, 1);
});

test('长正文分块与语义确认保留；已写payload后无回执仍为stuck而非notSent', async () => {
  const h = harness('long-unknown-after-write'); h.initialize();
  h.manager.writeToSession = (_sid, data) => h.writes.push({ data, target: 'prompt' });
  const prompt = '多行长正文'.repeat(900);
  const result = await watcher.sendToPty(h.sid, prompt, 'codeagent', { requireReady: false });
  assert.equal(result.sendStatus, 'stuck'); assert.notEqual(result.notSent, true);
  const payload = h.writes.filter(w => w.data !== '\r').map(w => w.data).join('');
  assert.equal(payload, '\x1b[200~' + prompt + '\x1b[201~');
  assert.ok(h.writes.filter(w => w.data !== '\r').length > 1);
});
