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

// 2026-10-16 田哥定：往 CodeAgent 粘贴前清掉剪贴板里的图片，只此一次、不放回（core/company-bridge/clipboard-guard.js）。
test('真实发送路径：剪贴板有图片时先清掉再粘贴，发完不放回；纯文字剪贴板不碰', async () => {
  for (const [formats, expectCleared] of [[['image/png'], true], [['text/plain'], false]]) {
    const h = harness('clipboard-' + formats[0].replace('/', '-'));
    const events = [];
    const clipboard = { formats: [...formats],
      availableFormats: () => clipboard.formats, readText: () => '',
      clear: () => { events.push('clear'); clipboard.formats = []; },
      writeText: () => events.push('writeText'), writeImage: () => events.push('writeImage') };
    const write = h.manager.writeToSession;
    h.manager.writeToSession = function (sid, data) { if (!events.includes('paste')) events.push('paste'); return write.call(this, sid, data); };
    watcher.init({ sessionManager: h.manager, transcriptTap: new EventEmitter(), cliReadyDetector: readiness, clipboard,
      bracketedPasteSettleMs: 1, agentTurnStartAckMs: 30, agentTurnStartRecoveryMs: 20 });
    const result = await watcher.sendToPty(h.sid, '请回答本轮问题', 'codeagent', { requireReady: false });
    assert.notEqual(result.notSent, true);
    assert.deepEqual(events, expectCleared ? ['clear', 'paste'] : ['paste'], formats.join(','));
  }
});

// 2026-10-16 同事反馈：2.1.0 在 Hub 输入框发消息被弹回、底部出提示，CLI 里直接发正常。复现出两种误拦：
// ① 输入框里已有草稿、底栏权限模式名带连字符（只认纯字母）；② 上一条回答里有「> 1. GLM… / 2. MiniMax…」
// 这类编号列表，被当成模型菜单。画面框架取自公司真机第 9 轮逐行原文。
const READY_FRAME = [
  '                       ╭──────────────────────────────────────────────────────────────────────╮',
  '                       │ > Anything I can assist you with? (Ctrl+J 换行 · esc×2 清空 · ↑↓ 历史) │',
  '                       │                                                                      │',
  '                       │ Bypass (Cycle shift+tab) | GLM-5.2-WX-Auto              @  ✲  ↵  ▷   │',
  '                       ╰──────────────────────────────────────────────────────────────────────╯'];
const withDraftAndMode = READY_FRAME.map(l => l.replace('> Anything I can assist you with? (Ctrl+J 换行 · esc×2 清空 · ↑↓ 历史)', '> 帮我看一下这个函数                                          ')
  .replace('Bypass (Cycle', 'Auto-Accept (Cycle'));
const answerWithList = ['  模型对比结论：', '  > 1. GLM-5.2-WX-Auto 更快', '    2. MiniMax-M2.7 更稳', '', ...READY_FRAME];
for (const [name, screen] of [['草稿 + 带连字符的权限模式', withDraftAndMode], ['回答里有带 > 的模型编号列表', answerWithList]]) {
  test(`不误拦：${name}，消息照常发出`, async () => {
    assert.equal(picker.modelDialogVisible(screen), false);
    assert.equal(picker.promptInputAvailable(screen), true);
    const h = harness('no-false-bounce-' + name.length, screen); h.initialize();
    const result = await watcher.sendToPty(h.sid, '请继续', 'codeagent', { requireReady: false });
    assert.notEqual(result.notSent, true, result.message);
    assert.ok(h.writes.some(w => w.data === '\r'), '按了回车提交');
  });
}

test('真的模型菜单开着（有标题）仍然拦下，正文不进搜索框', async () => {
  const h = harness('real-menu-still-blocks', ['  Select model', '  ❯  1. GLM-5.2-WX-Auto default ✓   0x',
    '  Navigate ↑ ↓ | Config ctrl+a | Default ctrl+b | Select enter | Back esc']); h.initialize();
  await assert.rejects(watcher.sendToPty(h.sid, '不能填进搜索框', 'codeagent', { requireReady: false }), error => error.notSent === true);
  assert.deepEqual(h.writes, []);
});

// 2026-10-16 同事反馈：CodeAgent 1.2605.05.01（旧版）在 2.1.0 里每条消息都以「尚未确认 CodeAgent 的普通输入框」退回，
// 1.0.6 可用、CLI 里直接打字也能发。田哥：「输入框不一样就不敢发了，很蠢……没法保证所有用户都是最新版本」。
// 现在只在明确看到菜单或选择框时才拦；认不出的输入框照常发。下面的画面是「和规则对不上」的假设样式，不是旧版实录。
const UNKNOWN_FRAMES = {
  '中文提示语、没有 shift+tab 底栏': ['  ┌────────────────────────────────────┐', '  │ › 请输入你的问题…                  │', '  └────────────────────────────────────┘', '  默认模式 · GLM-5.2-WX-Auto'],
  '没有任何框线和提示符': ['CodeAgent 1.2605.05.01', '', '已就绪，等待输入', ''],
};
for (const [name, screen] of Object.entries(UNKNOWN_FRAMES)) test(`认不出的输入框照常发：${name}`, async () => {
  const h = harness('unknown-frame-' + name.length, screen); h.initialize();
  const result = await watcher.sendToPty(h.sid, '请继续', 'codeagent', { requireReady: false });
  assert.notEqual(result.notSent, true, result.message);
  assert.ok(h.writes.some(w => w.data === '\r'), '按了回车提交');
});

test('当前屏幕上有选择框（升级提醒等）仍然拦下；历史里出现过、现在已关掉的框不拦', async () => {
  const dialog = harness('choice-dialog-on-screen', ['  版本更新提醒', '  发现新版本 1.2615.02.01，是否更新？', '  ❯ 1. 立即更新', '    2. 稍后', '  Select ↑ ↓ | Confirm Enter | 退出 Esc']);
  dialog.initialize();
  await assert.rejects(watcher.sendToPty(dialog.sid, '不能替人选', 'codeagent', { requireReady: false }), error => error.notSent === true);
  assert.deepEqual(dialog.writes, []);
  const closed = harness('choice-dialog-closed', ['  已跳过更新', '  › 请输入你的问题…']);
  closed.manager.getSessionBuffer = () => '版本更新提醒 Select ↑ ↓ | Confirm Enter | 退出 Esc\r\n' + '\x1b[2J\x1b[H  已跳过更新\r\n  › 请输入你的问题…';
  closed.initialize();
  const result = await watcher.sendToPty(closed.sid, '请继续', 'codeagent', { requireReady: false });
  assert.notEqual(result.notSent, true, result.message);
});

test('选模型失败只退回一次：提示过、菜单也关了以后，认不出的输入框照常发', async () => {
  const h = harness('pick-failed-then-unknown', UNKNOWN_FRAMES['中文提示语、没有 shift+tab 底栏']); h.initialize();
  picker.resetFailure(h.sid);
  await picker.schedulePick(h.sid, async () => ({ ok: false, inputReady: false, message: '当前 CodeAgent 模型菜单的布局无法自动识别' }));
  await assert.rejects(watcher.sendToPty(h.sid, '第一条', 'codeagent', { requireReady: false }), error => error.notSent === true);
  const result = await watcher.sendToPty(h.sid, '第二条', 'codeagent', { requireReady: false });
  assert.notEqual(result.notSent, true, result.message);
});

// 2026-10-16 公司真机 Q-1016-01 第 10 轮，CodeAgent 1.2615.02.01 逐行原文（行号与高亮标记已去掉，取输入框附近）：
// 有草稿、运行中的「补充指令」输入框、带「系统可用内存不足」警告条，三种都必须当作可发送。
const REAL_DRAFT = [
  '                        ● 系统可用内存不足（剩余 1897 MB，占比 6%），CodeAgent 可能响应卡顿，请关闭其他     Ctrl+Q ✕',
  '                          CodeAgent 进程或高内存占用程序后继续使用',
  '                       ╭────────────────────────────────────────────────────────────────────────────────────────────╮',
  '                       │ > 测试草稿 draft                                                                           │',
  '                       │                                                                                            │',
  '                       │                                                                                            │',
  '                       │ Bypass (Cycle shift+tab) | GLM-5.2-WX-Auto                                    @  ✲  ↵  ▷   │',
  '                       ╰────────────────────────────────────────────────────────────────────────────────────────────╯'];
const REAL_RUNNING = [
  ' ┃  只回复两个字：好的                                                                                        ━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '  ⠇ Running…',
  '  ● 系统可用内存不足（剩余 2351 MB，占比 7%），CodeAgent 可能响应卡顿，请关闭其他 CodeAgent     Ctrl+Q ✕',
  '    进程或高内存占用程序后继续使用',
  ' ╭──────────────────────────────────────────────────────────────────────────────────────────────────────╮',
  ' │ > 补充指令（Enter 排队等待发送）...                                                                  │     ──────────────────────────',
  ' │                                                                                                      │     SESSION 8d3cd8d3-1082-4299-9',
  ' │                                                                                                      │             403-112931f67810',
  ' │ Bypass (Cycle shift+tab) | GLM-5.2-WX-Auto                                              @  ✲  ↵  ▷   │     VERSION         1.2615.02.01',
  ' ╰──────────────────────────────────────────────────────────────────────────────────────────────────────╯',
  '  Interrupt esc                                                       Alt+P switch model │ Ctrl+G editor'];
const REAL_RUNNING_DRAFT = REAL_RUNNING.map(l => l.replace('> 补充指令（Enter 排队等待发送）...                                  ', '> 第二条草稿                                                         '));
test('公司真机输入框实录（有草稿 / 运行中 / 运行中有草稿，带内存警告条）：直接认作可发送，不靠兜底', () => {
  for (const [name, screen] of [['有草稿', REAL_DRAFT], ['运行中', REAL_RUNNING], ['运行中有草稿', REAL_RUNNING_DRAFT]]) {
    assert.equal(picker.modelDialogVisible(screen), false, name);
    assert.equal(picker.promptInputAvailable(screen), true, name);
  }
});
