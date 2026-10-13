'use strict';
// 公司 CodeAgent 选模型（2026-10-13 公司真机排查）：
// - Qwen3.6-27B-CodeAgent-VL 是 CodeAgent 自己的模型，选了不能被换回 GLM-5.2-WX-Auto；
// - 可用模型清单在 .cac.json 的 enterpriseModelOptionsCache，值是对象数组或再编码过一次的 JSON 文本都能读出；
// - 实际模型除了回合结束事件，CodeAgent 的 Stop hook 也会读一次；请求、命令里的模型、实际模型记到证据日志。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const models = require('../core/codeagent-models');
const config = require('../core/codeagent-config');
let failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (error) { failed++; console.error('  ✗ ' + name + '\n    ' + (error.stack || error.message)); }
}
const ENTERPRISE = ['GLM-5.2', 'GLM-5.2-WX', 'GLM-5.2-WX-Auto', 'MiniMax-M2.7', 'MiniMax-M2.7-CodeAgentCLI', 'Qwen3.6-27B-CodeAgent-VL'];
function configDir(cacJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-select-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX-Auto' }));
  fs.writeFileSync(path.join(dir, '.cac.json'), JSON.stringify(cacJson));
  return dir;
}
const options = ENTERPRISE.map(m => ({ value: m, label: m, description: `${m}，比 GLM-9.9 更快` }));

test('Qwen：CodeAgent 自己的 Qwen 模型原样保留，别家 CLI 的模型名仍回到默认', () => {
  assert.strictEqual(config.normalizeCodeAgentModel('Qwen3.6-27B-CodeAgent-VL'), 'Qwen3.6-27B-CodeAgent-VL');
  for (const id of ENTERPRISE) assert.strictEqual(config.normalizeCodeAgentModel(id), id, id);
  for (const other of ['claude-opus-5', 'gpt-5.5', 'gemini-3-pro', 'kimi-code/k3', 'sonnet']) {
    assert.strictEqual(config.normalizeCodeAgentModel(other), 'GLM-5.2-WX-Auto', other);
  }
});

test('enterpriseModelOptionsCache 是对象数组：6 个模型全部列出，描述里提到的名字不算', () => {
  const dir = configDir({ hasCompletedOnboarding: true, enterpriseModelOptionsCache: options });
  const ids = models.modelOptions(null, { configDir: dir }).map(option => option.id);
  assert.deepStrictEqual(new Set(ids), new Set(ENTERPRISE));
  assert(!ids.includes('GLM-9.9'));
});

test('enterpriseModelOptionsCache 是再编码过一次的 JSON 文本：同样列出 6 个模型', () => {
  const dir = configDir({ enterpriseModelOptionsCache: JSON.stringify(options) });
  const ids = models.modelOptions(null, { configDir: dir }).map(option => option.id);
  assert.deepStrictEqual(new Set(ids), new Set(ENTERPRISE));
});

test('不在模型段里的 JSON 文本不展开（聊天记录里的片段不算模型）', () => {
  const dir = configDir({ projects: { 'D:/w': { lastPrompt: JSON.stringify([{ value: 'GLM-7.7' }]) } }, tipsHistory: JSON.stringify(['deepseek-v9']) });
  const ids = models.configuredModels(dir).models;
  assert(!ids.includes('GLM-7.7') && !ids.includes('deepseek-v9'), ids.join(','));
});

test('证据日志：一行一件事，只有会话号前 8 位与模型名，超过 256 KB 轮转', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-log-'));
  assert(models.appendModelLog(dataDir, { event: 'launch', session: 'abcdef12', requested: 'MiniMax-M2.7', model: 'MiniMax-M2.7', note: 'a\nb' }));
  const file = path.join(dataDir, 'logs', 'codeagent-model.log');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /event=launch session=abcdef12 requested=MiniMax-M2\.7 model=MiniMax-M2\.7 note=a b$/);
  fs.writeFileSync(file, 'x'.repeat(300 * 1024));
  models.appendModelLog(dataDir, { event: 'observe' });
  assert(fs.existsSync(file + '.1'));
  assert(fs.statSync(file).size < 1024);
  assert.strictEqual(models.appendModelLog(null, { event: 'x' }), false);
});

test('启动命令：选的模型原样进 --model，并记一行 launch 证据', () => {
  const src = fs.readFileSync(path.join(root, 'core/session-manager.js'), 'utf8');
  const fn = src.slice(src.indexOf('function buildCodeAgentPtyLaunch'), src.indexOf('function applyClaudeSessionEnv'));
  assert.match(fn, /'--model', normalizeCodeAgentModel\(opts\.model\)/);
  assert.match(fn, /appendModelLog\(hubDataDir, \{\s*event: 'launch'/);
});

test('实际模型：CodeAgent 的 Stop hook 也读一次，不只靠回合结束事件', () => {
  const src = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(src, /async function observeCodeAgentModel\(hubSessionId, ev, transcriptPath, source = 'turn-complete'\)/);
  assert.match(src, /notifyClaudeStop\(parsed\.sessionId[^\n]*\n\s*if \(isCodeAgentKind\(hookTargetSession\.kind\)\) void observeCodeAgentModel\(parsed\.sessionId, \{\}, parsed\.transcriptPath, 'stop-hook'\);/);
  assert.match(src, /event: 'observe', via: source/);
});

test('同一条回答两条路先后到达：第二次不再改会话、不再弹提示', () => {
  const session = { kind: 'codeagent', currentModel: { id: 'MiniMax-M2.7' } };
  const first = models.observeModel(session, 'deepseek0731-wx-chat');
  assert(first && first.mismatch);
  Object.assign(session, first.fields);
  assert.strictEqual(models.observeModel(session, 'deepseek0731-wx-chat'), null);
});

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('unit-codeagent-model-select: all passed');
