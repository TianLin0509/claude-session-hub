'use strict';
// 公司版 v1.0.2（2026-10-13）：本机 CodeAgent 配置里的模型清单、Qwen 画像、会话内换模型的入口、
// 安装版快捷方式换新图标、公司版图标文件。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const models = require('../core/codeagent-models');
let failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (error) { failed++; console.error('  ✗ ' + name + '\n    ' + (error.stack || error.message)); }
}

test('从本机 CodeAgent 配置读模型：只看带 model 的段，不碰聊天记录', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cac-'));
  try {
    // 形状按 2026-10-13 公司探测：settings.json 的 model；.cac.json 的 tieredModelConfig / tierModelParams / modelParam。
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX-Auto', hooks: {} }));
    fs.writeFileSync(path.join(dir, '.cac.json'), JSON.stringify({
      tieredModelConfig: { large: 'GLM-5.2-WX', small: 'GLM-5.2', vision: 'Qwen3.6-27B-CodeAgent-VL' },
      tierModelParams: { 'MiniMax-M2.7-CodeAgentCLI': { temperature: 1 } },
      modelParam: { 'deepseek0731-wx-chat': { maxTokens: 8192 } },
      projects: { 'D:/x': { history: [{ display: '试试 deepseek-v9 和 GLM-9.9 怎么样' }] } },
      otherSetting: 'GLM-7.7-not-a-model-section',
    }));
    const found = models.configuredModels(dir);
    assert.strictEqual(found.defaultModel, 'GLM-5.2-WX-Auto');
    assert.deepStrictEqual(new Set(found.models), new Set(['GLM-5.2-WX', 'GLM-5.2', 'MiniMax-M2.7-CodeAgentCLI', 'deepseek0731-wx-chat', 'GLM-5.2-WX-Auto']));
    const ids = models.modelOptions(null, { configDir: dir }).map(o => o.id);
    assert.deepStrictEqual(ids.slice(0, 2), ['GLM-5.2-WX-Auto', 'MiniMax-M2.7'], '已知模型在前');
    assert(ids.includes('deepseek0731-wx-chat') && !ids.includes('Qwen3.6-27B-CodeAgent-VL'));
    assert.strictEqual(ids.filter(id => id === 'GLM-5.2-WX-Auto').length, 1, '不重复');
    assert(!ids.some(id => /9\.9|v9|7\.7/.test(id)), '聊天记录和无关设置里的字不算');
    assert.deepStrictEqual(models.configuredModels(path.join(dir, 'missing')).models, [], '没有配置目录不报错');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Qwen 模型：卡片画像、侧栏图标跟着换，公司版保留 qwen 画像', () => {
  const { chatAvatarSrc, makeChatAvatarSrc } = require('../renderer/chat-avatar');
  const { makeKindFilter } = require('../core/distribution');
  assert.strictEqual(models.modelFamily('Qwen3.6-27B-CodeAgent-VL'), 'qwen');
  for (const avatar of [chatAvatarSrc, makeChatAvatarSrc(makeKindFilter(['codeagent']))]) {
    assert.strictEqual(avatar('codeagent', { model: 'Qwen3.6-27B-CodeAgent-VL' }), 'assets/ai-avatars/cel-v2/qwen.png');
  }
  const target = JSON.parse(fs.readFileSync(path.join(root, 'community/targets/company/target.json'), 'utf8'));
  for (const name of ['glm', 'deepseek', 'minimax', 'qwen']) assert(!target.drop.includes(`renderer/assets/ai-avatars/cel-v2/${name}.png`), name);
  const src = fs.readFileSync(path.join(root, 'renderer/session-list-renderer.js'), 'utf8');
  assert.match(src, /\['deepseek', 'minimax', 'qwen'\]\.includes\(family\)/);
});

test('CodeAgent 会话内可以换模型：走「用新模型接着原会话重开」', () => {
  const { modelSwitchStrategy, canSwitchInSession } = require('../core/model-options');
  assert.strictEqual(modelSwitchStrategy('codeagent'), 'codeagent-restart');
  assert.strictEqual(modelSwitchStrategy('codeagent-resume'), 'codeagent-restart');
  assert.strictEqual(canSwitchInSession('codeagent'), true);
  const handlers = fs.readFileSync(path.join(root, 'main/ipc/session-handlers.js'), 'utf8');
  assert.match(handlers, /ipcMain\.handle\('codeagent:switch-model'/);
  assert.match(handlers, /restartSession\(sessionId, \{ model: modelId \}\)/, '复用按新模型重启（--resume <会话> --model <新模型>）');
  assert.match(handlers, /当前回答仍在运行，请结束后再切换/);
  // 恢复时带的是原会话号 + 新模型
  const { buildCodeAgentPtyLaunch } = require('../core/session-manager')._private;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-resume-'));
  try {
    const cwd = path.join(dir, 'w'); fs.mkdirSync(cwd);
    const seat = '11111111-2222-4333-8444-555555555555';
    const slug = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
    fs.mkdirSync(path.join(dir, 'projects', slug), { recursive: true });
    fs.writeFileSync(path.join(dir, 'projects', slug, seat + '.jsonl'), '{}\n');
    const launch = buildCodeAgentPtyLaunch('hub-1', 'codeagent', { resumeCCSessionId: seat, model: 'MiniMax-M2.7' }, cwd, {}, { command: 'codeagent', configDir: dir });
    assert.match(launch.cmd, new RegExp(`--resume ${seat} .*--model MiniMax-M2\\.7`));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('安装版快捷方式换新图标：只改指向本程序、图标不同的那几个，只改图标一项', () => {
  const { refreshPackagedShortcutIcons } = require('../core/windows-shell-integration');
  const exe = 'C:\\App\\v1.0.1\\AI Hub Community.exe';
  const ico = 'C:\\App\\v1.0.1\\resources\\app.asar.unpacked\\claude-wx.ico';
  const files = {
    'C:\\Start\\AI HUB-Huawei.lnk': { target: exe, icon: exe, appUserModelId: 'com.ai-hub.community' },
    'C:\\Desk\\AI HUB-Huawei.lnk': { target: exe, icon: '' },
    'C:\\Desk\\别的程序.lnk': { target: 'C:\\Other\\other.exe', icon: '' },
    'C:\\Pinned\\AI HUB-Huawei.lnk': { target: exe, icon: ico + ',0' },
  };
  const writes = [];
  const shell = { readShortcutLink: f => ({ ...files[f] }), writeShortcutLink: (f, op, d) => { writes.push([f, op, d]); return true; } };
  const dirs = { 'C:\\Desk': ['AI HUB-Huawei.lnk', '别的程序.lnk', 'note.txt'], 'C:\\Pinned': ['AI HUB-Huawei.lnk'] };
  const fsModule = { existsSync: p => p === ico || !!files[p] || !!dirs[p], readdirSync: d => dirs[d] || [] };
  const changed = refreshPackagedShortcutIcons({ shell, execPath: exe, iconPath: ico, shortcutFiles: ['C:\\Start\\AI HUB-Huawei.lnk'], dirs: ['C:\\Desk', 'C:\\Pinned', 'C:\\Nope'], fsModule });
  assert.deepStrictEqual(changed.sort(), ['C:\\Desk\\AI HUB-Huawei.lnk', 'C:\\Start\\AI HUB-Huawei.lnk']);
  assert(writes.every(([, op, d]) => op === 'update' && d.icon === ico && d.iconIndex === 0 && Object.keys(d).length === 2), '只改图标，不动目标、参数和 AUMID');
  assert.deepStrictEqual(refreshPackagedShortcutIcons({ shell, execPath: exe, iconPath: exe, dirs: ['C:\\Desk'], fsModule }), [], '没有独立图标文件（老安装包）时什么也不改');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(main, /app\.asar\.unpacked', 'claude-wx\.ico'/);
  assert(require('../package.json').build.asarUnpack.includes('claude-wx.ico'), '图标解包，资源管理器读得到，一键更新也会换掉');
});

test('公司版图标文件：多尺寸、没有 512 条目，替换上游图标', () => {
  const file = path.join(root, 'community/targets/company/overlay/claude-wx.ico');
  const buf = fs.readFileSync(file);
  assert.strictEqual(buf.readUInt16LE(0), 0); assert.strictEqual(buf.readUInt16LE(2), 1);
  const count = buf.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i++) { const w = buf[6 + i * 16]; sizes.push(w === 0 ? 256 : w); }
  assert.deepStrictEqual([...sizes].sort((a, b) => a - b), [16, 24, 32, 48, 64, 128, 256]);
  assert.notDeepStrictEqual(buf, fs.readFileSync(path.join(root, 'claude-wx.ico')), '和自用版图标不同');
});

if (failed) { console.error(`\n${failed} 个用例失败`); process.exit(1); }
console.log('\nunit-company-v102: all passed');
