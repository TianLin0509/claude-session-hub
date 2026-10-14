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
