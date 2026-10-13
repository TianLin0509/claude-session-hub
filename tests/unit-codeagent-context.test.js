'use strict';
// 公司版上下文圆环（2026-10-13）：CodeAgent 没有状态栏回调，按每轮回答记录里的用量 ÷ 账号清单里的上下文上限算。
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
function configDir(cacJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-ctx-'));
  fs.writeFileSync(path.join(dir, '.cac.json'), JSON.stringify(cacJson));
  return dir;
}
const REAL = { enterpriseModelOptionsCache: [
  { value: 'GLM-5.2-WX-Auto', contextWindow: 202752, tieredModelConfig: { large: 'GLM-5.2-WX' } },
  { value: 'MiniMax-M2.7', contextWindow: 192000 },
] };

test('上限取账号清单：先看会话当前模型，再看回答实际模型；都没有按 200K 估', () => {
  const dir = configDir(REAL);
  assert.deepStrictEqual(models.contextWindowFor(dir, ['GLM-5.2-WX-Auto', 'GLM-5.2-WX']), { window: 202752, source: 'account' });
  assert.deepStrictEqual(models.contextWindowFor(dir, ['minimax-m2.7']), { window: 192000, source: 'account' });
  assert.deepStrictEqual(models.contextWindowFor(dir, ['GLM-5.2-WX']), { window: 200000, source: 'estimated' });
  assert.deepStrictEqual(models.contextWindowFor(null, ['GLM-5.2-WX-Auto']), { window: 200000, source: 'estimated' });
});

test('已用 = 输入 + 缓存写入 + 缓存读取 + 输出；占比保留一位小数', () => {
  const ctx = models.contextFromUsage({ input_tokens: 1200, cache_creation_input_tokens: 3000, cache_read_input_tokens: 120000, output_tokens: 800 }, 202752);
  assert.deepStrictEqual(ctx, { contextUsed: 125000, contextEffectiveMax: 202752, contextPct: 61.7 });
  assert.strictEqual(models.contextFromUsage({}, 202752), null);
  assert.strictEqual(models.contextFromUsage(null, 202752), null);
  assert.strictEqual(models.contextFromUsage({ input_tokens: 'x', output_tokens: -5 }, 202752), null);
});

test('接线：每轮观察实际模型时一并算占比，下发 status-event 并落盘', () => {
  const src = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function observeCodeAgentModel'), src.indexOf('// Wire TranscriptTap'));
  assert.match(fn, /contextWindowFor\(configDir, \[session\.currentModel\?\.id, modelId\]\)/);
  assert.match(fn, /sendToRenderer\('status-event', \{ sessionId: hubSessionId, \.\.\.context \}\)/);
  assert.match(fn, /sessionStore\.markDirty\(hubSessionId, withContext\)/);
});

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('unit-codeagent-context: all passed');
