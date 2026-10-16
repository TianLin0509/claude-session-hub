'use strict';
// CodeAgent 在自己的 /model 菜单里选模型（core/codeagent-model-picker.js）：菜单解析、目标定位、默认模型保护、第一条消息的闸门。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const picker = require('../core/codeagent-model-picker');
const { modelCommandType, modelCommandAcknowledged } = require('../core/cli-model-command');

// 2026-10-14 替身（Claude Code 2.1.299）实录的菜单画面
const CLAUDE_MENU = [
  '❯ /model',
  '────────────────────────',
  '  Select model',
  '  Switch between Claude models. Your pick becomes the default for new sessions.',
  '    1. Default (recommended)  Opus 5.5 · Best for everyday, complex tasks',
  '    2. Opus                   Opus 5.5 · Best for everyday, complex tasks',
  '  ❯ 4. Sonnet ✔               Sonnet 5.5 · Efficient for routine tasks',
  '    5. Haiku                  Haiku 5.5 · Fastest for quick answers',
  '  ◐ Medium effort (default) ←/→ to adjust',
  '  Enter to set as default · s to use this session only · Esc to cancel',
];

test('认出菜单、光标行和「s 只用于本会话」', () => {
  const menu = [...CLAUDE_MENU];
  menu.splice(6, 0, '    3. Fable                  Fable 5.1 · Most capable');
  const parsed = picker.parsePicker(menu);
  assert.deepEqual(parsed.rows.map(r => r.label), ['Default (recommended)', 'Opus', 'Fable', 'Sonnet', 'Haiku']);
  assert.equal(parsed.cursor, 3);
  assert.equal(parsed.sessionKey, 's');
  assert.equal(picker.findTarget(parsed, 'Haiku'), 4);
});

test('CodeAgent 式的模型名：完全相同优先于前缀相同', () => {
  const parsed = picker.parsePicker([
    '  选择模型',
    '  ❯ 1. GLM-5.2-WX-Auto ✔   默认',
    '    2. GLM-5.2-WX          ',
    '    3. MiniMax-M2.7        ',
    '  Enter to confirm · Esc to cancel',
  ]);
  assert.equal(parsed.sessionKey, null);
  assert.equal(picker.findTarget(parsed, 'GLM-5.2-WX'), 1);
  assert.equal(picker.findTarget(parsed, 'MiniMax-M2.7'), 2);
  assert.equal(picker.findTarget(parsed, 'DeepSeek-V4'), -1);
});

test('没有编号的菜单按光标行和同缩进的相邻行认', () => {
  const parsed = picker.parsePicker([
    '❯ /model',
    '  Select model',
    '  ❯ GLM-5.2-WX-Auto',
    '    MiniMax-M2.7',
    '    DeepSeek-V4-Pro',
    '',
    '  Enter to confirm',
  ]);
  assert.deepEqual(parsed.rows.map(r => r.label), ['GLM-5.2-WX-Auto', 'MiniMax-M2.7', 'DeepSeek-V4-Pro']);
  assert.equal(parsed.cursor, 0);
});

test('镜像里残留旧画面时取最靠下（最新）的那一份', () => {
  const stale = CLAUDE_MENU.slice(4, 8);
  const latest = stale.map(line => line.replace('  ❯ 4.', '    4.').replace('    5. Haiku', '  ❯ 5. Haiku'));
  const parsed = picker.parsePicker([...stale, 'garbage', '', ...latest]);
  assert.equal(parsed.rows[parsed.cursor].label, 'Haiku');
});

test('行首残留旧字符的菜单行也认得出（替身实录）', () => {
  const parsed = picker.parsePicker([
    'he  1. Default (recommended)  Opus 5.5 · Best',
    'rs (2. Opus                   Opus 5.5 · Best',
    'n   3. Fable                  Fable 5.1 · Most capable',
    'erva4. Sonnet                 Sonnet 5.5 · Efficient',
    '  ❯ 5. Haiku ✔                Haiku 5.5 · Fastest',
  ]);
  assert.deepEqual(parsed.rows.map(r => r.label), ['Default (recommended)', 'Opus', 'Fable', 'Sonnet', 'Haiku']);
  assert.equal(parsed.rows[parsed.cursor].label, 'Haiku');
  assert.equal(picker.findTarget(parsed, 'Sonnet'), 3);
});

test('输入框里的「❯ /model」和信任框不算模型菜单', () => {
  assert.equal(picker.parsePicker(['❯ /model', '']), null);
  assert.equal(picker.parsePicker(['  ❯ No, exit', '    Yes, I trust this folder']), null);
});

test('/model 命令：CodeAgent 不带参数时等菜单出现，不补回车', () => {
  assert.equal(modelCommandType('codeagent', '/model'), 'codeagent-picker');
  assert.equal(modelCommandType('codeagent-resume', ' /model '), 'codeagent-picker');
  assert.equal(modelCommandType('codeagent', '/model MiniMax-M2.7'), null);
  assert.equal(modelCommandAcknowledged('codeagent-picker', CLAUDE_MENU.join('\n'), ''), true);
  assert.equal(modelCommandAcknowledged('codeagent-picker', '❯ /model', ''), false);
});

test('按回车会把选择存成默认模型：只把 model 这个键改回去，其余原样', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-picker-'));
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX-Auto', hooks: { Stop: [1] }, provider: 'w3' }, null, 2));
    fs.writeFileSync(path.join(dir, 'settings.local.json'), JSON.stringify({ other: true }));
    const snapshot = picker.snapshotDefaults(dir);
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'MiniMax-M2.7', hooks: { Stop: [1] }, provider: 'w3' }, null, 2));
    fs.writeFileSync(path.join(dir, 'settings.local.json'), JSON.stringify({ other: true, model: 'MiniMax-M2.7' }));
    const restored = picker.restoreDefaults(snapshot);
    assert.deepEqual(restored.sort(), ['settings.json', 'settings.local.json']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')), { model: 'GLM-5.2-WX-Auto', hooks: { Stop: [1] }, provider: 'w3' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.local.json'), 'utf8')), { other: true });
    assert.deepEqual(picker.restoreDefaults(picker.snapshotDefaults(dir)), [], '没变就不写');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('第一条消息等选模型做完；几个会话的选模型排队，一次只做一个', async () => {
  const order = [];
  let releaseA;
  const a = picker.schedulePick('A', () => new Promise(resolve => { releaseA = () => { order.push('A done'); resolve({ ok: true }); }; order.push('A start'); }));
  const b = picker.schedulePick('B', async () => { order.push('B start'); return { ok: true }; });
  assert.equal(picker.isPicking('A'), true);
  const waiting = picker.waitForPick('A').then(() => order.push('A prompt'));
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(order, ['A start']);
  releaseA();
  await Promise.all([a, b, waiting]);
  assert.deepEqual(order, ['A start', 'A done', 'A prompt', 'B start'].filter(x => order.includes(x)).sort((x, y) => order.indexOf(x) - order.indexOf(y)));
  assert.ok(order.indexOf('B start') > order.indexOf('A done'), 'B 在 A 做完之后才开始');
  assert.equal(picker.isPicking('A'), false);
  await picker.waitForPick('none');
});

test('替身的菜单名映射只认 JSON，真 CodeAgent 不配时就是模型名本身', () => {
  assert.equal(picker.pickerLabelFor('MiniMax-M2.7', {}), 'MiniMax-M2.7');
  assert.equal(picker.pickerLabelFor('minimax-m2.7', { AI_HUB_CODEAGENT_PICKER_LABELS: '{"MiniMax-M2.7":"Haiku"}' }), 'Haiku');
  assert.equal(picker.pickerLabelFor('MiniMax-M2.7', { AI_HUB_CODEAGENT_PICKER_LABELS: 'not json' }), 'MiniMax-M2.7');
});

test('菜单里没有要选的模型：按 Esc 后等菜单关掉再返回，排队的第一条消息才不会被当成 Alt+键吞掉', async () => {
  const { EventEmitter } = require('node:events');
  const manager = new EventEmitter();
  const writes = [];
  let closedAt = 0;
  manager.getSessionBufferSnapshot = async () => ({ text: CLAUDE_MENU.join('\r\n'), seq: 0, cols: 120, rows: 30 });
  manager.writeToSession = (sid, data) => {
    writes.push({ data, at: Date.now() });
    if (data === '\x1b') setTimeout(() => { closedAt = Date.now(); manager.emit('output', { sessionId: sid, data: '\x1b[2J\x1b[H  Kept model as Sonnet\r\n❯ \r\n  bypass permissions on (shift+tab to cycle)', seq: 9 }); }, 250);
  };
  const result = await picker.pickModel({ manager, sid: 's1', kind: 'codeagent', modelId: 'GLM-5.2-WX-Auto',
    sendToPty: async () => ({ ok: true }), screenTimeoutMs: 1000, env: {} });
  const returnedAt = Date.now();
  assert.equal(result.ok, false);
  assert.equal(result.inputReady, true);
  assert.match(result.message, /菜单里没有 GLM-5\.2-WX-Auto/);
  assert.deepEqual(writes.map(w => w.data), ['\x1b'], '只按一次 Esc 关自己打开的菜单');
  assert.ok(closedAt > 0 && returnedAt - closedAt >= 300, `菜单关掉之后还要留一拍再返回（关后 ${returnedAt - closedAt}ms 返回）`);
});

// 2026-10-16 公司真机 Q-1016-01 第 9 轮：CodeAgent 1.2615.02.01 按 Alt+P / 输入 /model 回车后的菜单逐行原文
// （行号与高亮标记已去掉；右半边是 Stats / SESSION 面板）。账号只有一个可选模型，菜单只有一行；
// 以前要求至少两行编号，11 次都判成「菜单没出现」，再按 Esc 把菜单关了。
const CODEAGENT_MENU = [
  ' ≡ opentui: C:\\Us… │ C:\\Users\\L00807~1\\AppData\\Local\\Temp\\ca-menu-work-JldESo 9 mcp · 24 hooks │ ? help       Overview      Messages   ⚙',
  '▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀   ────────────────────────────────',
  '                                                                                                             ▾ Stats',
  ' 发送第一条消息开始对话                                                                                      Context                   --',
  '                                                                                                             Credit       2,477.1 (99.1%)',
  '                                                                                                             Runtime             00:00:00',
  '                                                                                                          »',
  '  Select model                                                                                       ✕',
  '  ╭────────────────────────────────────────────────────────────────────────────────────────────────────╮',
  '  │ ⌕ Search…                                                                                          │',
  '  ╰────────────────────────────────────────────────────────────────────────────────────────────────────╯',
  '  Credit用量                                                                         shift + ↓ to detail',
  '  月度: 2836.51/20000,已用每天(忙时): 22.93/2500,已 每天(平时,闲时): 258.03/2500,   距离闲时2折还有1小时',
  '  14.18%                  0.91%                     已用10.32%                     56分钟',
  '        模型名称                          Credit消耗系数  Token用量/配额           ● 负载      模型描述',
  '  Built-in',
  '  ❯  1. GLM-5.2-WX-Auto default ✓         0x              Day 29.16M/400M (7.29%)  ● 低负载    为主模型，',
  '                                                          Hour 2.15M/200M (1.07%)',
  '                                                          Min 89.66K/1M (8.97%)                              ──────────────────────────',
  '                                                                                                             SESSION 6472e0ab-dd31-4693-b',
  '  ────────────────────────────────────────────────────────────────────────────────────────────────────               655-d36a77aa973c',
  '                                                                                                             VERSION         1.2615.02.01',
  '  Navigate ↑ ↓ | Config ctrl+a | Default ctrl+b | Select enter | Back esc',
];

test('公司真机菜单：只有一行也认得出，模型名去掉「default ✓」，菜单回执成立', () => {
  const parsed = picker.parsePicker(CODEAGENT_MENU);
  assert.ok(parsed, '真机菜单必须认得出');
  assert.deepEqual(parsed.rows.map(r => r.label), ['GLM-5.2-WX-Auto']);
  assert.equal(parsed.cursor, 0);
  assert.equal(parsed.codeagentFrame, true);
  assert.equal(picker.findTarget(parsed, 'GLM-5.2-WX-Auto'), 0);
  assert.equal(picker.findTarget(parsed, 'MiniMax-M2.7'), -1);
  assert.equal(picker.modelDialogVisible(CODEAGENT_MENU), true);
  assert.equal(picker.promptInputReady(CODEAGENT_MENU), false);
  assert.equal(modelCommandAcknowledged('codeagent-picker', CODEAGENT_MENU.join('\n'), ''), true);
});

test('公司真机菜单：搜不到时只剩标题和「Clear esc」，仍算菜单开着（不会把正文打进搜索框）', () => {
  const noResults = [...CODEAGENT_MENU.slice(0, 8),
    '  │ ⌕ MiniMax-M2.7│                                                                                    │',
    '  No results found', '  Clear esc'];
  assert.equal(picker.parsePicker(noResults), null);
  assert.equal(picker.modelDialogVisible(noResults), true);
});

test('没有 CodeAgent 外框时，单独一行「❯ 1. 模型」仍不算菜单（正文里的编号列表不误认）', () => {
  assert.equal(picker.parsePicker(['回答正文', '  ❯ 1. GLM-5.2-WX-Auto 是默认模型', '以上']), null);
  // 有底栏没有标题，也不算
  assert.equal(picker.parsePicker(['  ❯  1. GLM-5.2-WX-Auto default ✓   0x', '  Navigate ↑ ↓ | Config ctrl+a | Default ctrl+b | Select enter | Back esc']), null);
});

test('选的模型不在真机菜单里：失败并带回菜单清单，只按一次 Esc 关菜单', async () => {
  const { EventEmitter } = require('node:events');
  const manager = new EventEmitter();
  const writes = [];
  manager.getSessionBufferSnapshot = async () => ({ text: CODEAGENT_MENU.join('\r\n'), seq: 0, cols: 140, rows: 40 });
  manager.writeToSession = (sid, data) => {
    writes.push(data);
    if (data === '\x1b') setTimeout(() => manager.emit('output', { sessionId: sid, seq: 9, data: '\x1b[2J\x1b[H'
      + '  │ > Anything I can assist you with? (Ctrl+J 换行 · esc×2 清空 · ↑↓ 历史) │\r\n'
      + '  │ Bypass (Cycle shift+tab) | GLM-5.2-WX-Auto                       @  ✲  ↵  ▷   │\r\n'
      + '  Alt+P switch model | Ctrl+G editor' }), 200);
  };
  const result = await picker.pickModel({ manager, sid: 's1', kind: 'codeagent', modelId: 'MiniMax-M2.7',
    sendToPty: async () => ({ ok: true }), screenTimeoutMs: 1000, env: {} });
  assert.equal(result.ok, false);
  assert.equal(result.inputReady, true);
  assert.match(result.message, /菜单里没有 MiniMax-M2\.7（菜单里有：GLM-5\.2-WX-Auto）/);
  assert.deepEqual(result.menu, ['GLM-5.2-WX-Auto']);
  assert.deepEqual(writes, ['\x1b'], '只按一次 Esc 关自己打开的菜单');
});

test('选的模型就在真机菜单里：回车选中、菜单关掉即成功，并带回菜单清单', async () => {
  const { EventEmitter } = require('node:events');
  const manager = new EventEmitter();
  const writes = [];
  manager.getSessionBufferSnapshot = async () => ({ text: CODEAGENT_MENU.join('\r\n'), seq: 0, cols: 140, rows: 40 });
  manager.getSessionOutputMark = () => 0;
  manager.getSessionOutputSince = () => '';
  manager.writeToSession = (sid, data) => {
    writes.push(data);
    if (data === '\r') setTimeout(() => manager.emit('output', { sessionId: sid, seq: 9, data: '\x1b[2J\x1b[H'
      + '  │ > Anything I can assist you with? (Ctrl+J 换行 · esc×2 清空 · ↑↓ 历史) │\r\n'
      + '  │ Bypass (Cycle shift+tab) | GLM-5.2-WX-Auto                       @  ✲  ↵  ▷   │\r\n'
      + '  Alt+P switch model | Ctrl+G editor' }), 200);
  };
  const result = await picker.pickModel({ manager, sid: 's1', kind: 'codeagent', modelId: 'GLM-5.2-WX-Auto',
    sendToPty: async () => ({ ok: true }), screenTimeoutMs: 1000, env: {} });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.inputReady, true);
  assert.deepEqual(result.menu, ['GLM-5.2-WX-Auto']);
  assert.deepEqual(writes, ['\r'], '目标就在光标行：不按方向键，只按一次回车');
});
