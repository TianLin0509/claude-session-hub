'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { availableRoutes, requireWebTools, webStatus } = require('../core/chatgpt-web-integration');
const { normalizeCodexSessionModel } = require('../core/model-options');
const { buildCodexModelOptions } = require('../core/codex-model-catalog');
const { isolatedPaths, launcherEnvironment } = require('../core/chatgpt-isolation');
function fixture(root, port = 17861) {
  fs.mkdirSync(path.join(root, 'runtime')); fs.mkdirSync(path.join(root, 'codex-home'));
  fs.writeFileSync(path.join(root, 'isolation.json'), JSON.stringify({ version: 1, purpose: 'ai-hub-chatgpt-only', port }));
  return { AI_HUB_CHATGPT_ROOT: root };
}
const { buildSessionResumeMeta } = require('../core/session-capabilities');

test('launcher ignores inherited shared homes and rejects journals targeting ordinary Codex', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-chatgpt-boundary-'));
  const env = { ...fixture(root), CODEX_HOME: 'C:\\ordinary', CODEX_CHATGPT_WEB_HOME: 'C:\\old-bridge', OPENAI_BASE_URL: 'http://127.0.0.1:17841/v1', OPENAI_API_KEY: 'do-not-inherit', ELECTRON_RUN_AS_NODE: '1' };
  const child = launcherEnvironment(env);
  assert.equal(child.CODEX_HOME, path.join(root, 'codex-home'));
  assert.equal(child.CODEX_CHATGPT_WEB_HOME, path.join(root, 'runtime'));
  assert.equal(child.OPENAI_BASE_URL, undefined);
  assert.equal(child.OPENAI_API_KEY, undefined);
  assert.equal(child.ELECTRON_RUN_AS_NODE, undefined);
  fs.mkdirSync(path.join(root, 'runtime', 'codex'));
  fs.writeFileSync(path.join(root, 'runtime', 'codex', 'integration-journal.json'), JSON.stringify({configPath:path.join(os.homedir(), '.codex', 'config.toml')}));
  assert.throws(() => isolatedPaths(env), /共享配置/);
});

test('missing isolation never falls back to the inherited bridge', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-chatgpt-no-marker-'));
  assert.throws(() => isolatedPaths({ AI_HUB_CHATGPT_ROOT: root, CODEX_CHATGPT_WEB_HOME: root }), /隔离环境未配置/);
});

test('automatic and manual account capability rows match the installed route protocol', () => {
  const models = availableRoutes({ proAvailable: true });
  assert.deepEqual(models.map(m => m.effort), ['low', 'medium', 'high', 'xhigh', 'ultra']);
  assert.equal(availableRoutes({ proAvailable: false }).length, 3);
  assert.deepEqual(availableRoutes({ browserInteractionMode: 'manual' }).map(m => m.id), ['chatgpt-web/zero-risk']);
  assert.equal(availableRoutes({ browserInteractionMode: 'manual', zeroRiskProEnabled: true }).length, 2);
  assert.deepEqual(availableRoutes({ solAvailable: false }).map(m => m.id), ['chatgpt-web/luna', 'chatgpt-web/think']);
});

test('browser-only blocks local-tool launches, while status exposes no credentials', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-chatgpt-config-'));
  const env = fixture(root, 17861);
  const config = { host: '127.0.0.1', port: 17861, mode: 'browser-only', proAvailable: true, controlToken: 'never-expose-this' };
  const save = () => fs.writeFileSync(path.join(root, 'runtime', 'config.json'), JSON.stringify(config));
  save();
  assert.throws(() => requireWebTools('chatgpt-web/pro', env), /Full MCP/);
  const status = await webStatus(env);
  assert.equal(status.online, false);
  assert.equal(status.full, false);
  assert(!JSON.stringify(status).includes(config.controlToken));
  config.mode = 'full'; save();
  assert.equal(requireWebTools('chatgpt-web/pro', env).mode, 'full');
  config.proAvailable = false; save();
  assert.throws(() => requireWebTools('chatgpt-web/pro', env), /不可用/);
  config.host = 'example.com'; save();
  assert.throws(() => requireWebTools('chatgpt-web/high', env), /地址无效/);
});

test('web identity survives resume without entering the ordinary Codex catalog', () => {
  assert.equal(normalizeCodexSessionModel('chatgpt-web/pro'), 'chatgpt-web/pro');
  assert.notEqual(normalizeCodexSessionModel('chatgpt-web/pro;evil'), 'chatgpt-web/pro;evil');
  const models = buildCodexModelOptions([{ id: 'chatgpt-web/pro' }, { id: 'gpt-6-astra' }]);
  assert.deepEqual(models.map(m => m.id), ['gpt-6-astra']);
  const meta = buildSessionResumeMeta({ kind: 'codex', id: 'hub', currentModel: { id: 'chatgpt-web/pro' }, effort: 'ultra', codexSid: 'thread' });
  assert.equal(meta.model, 'chatgpt-web/pro');
  assert.equal(meta.effort, 'ultra');
  assert.equal(meta.codexSid, 'thread');
});

test('native launch uses the local bridge and preserves read/write execution permissions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-chatgpt-native-'));
  const env = fixture(root);
  fs.writeFileSync(path.join(root, 'runtime', 'config.json'), JSON.stringify({ host: '127.0.0.1', port: 17861, mode: 'full', proAvailable: true }));
  const previous = process.env.AI_HUB_CHATGPT_ROOT;
  process.env.AI_HUB_CHATGPT_ROOT = root;
  try {
    const { buildNativeCodexOptions } = require('../core/session-manager')._private;
    const options = buildNativeCodexOptions({ kind: 'codex', cwd: root, currentModel: { id: 'chatgpt-web/pro' }, effort: 'ultra', mcpProfile: 'none', codexSpeedTier: 'inherit' }, {}, { CODEX_HOME: root });
    assert(options.processArgs.includes('model_provider="openai"'));
    assert(options.processArgs.includes('openai_base_url="http://127.0.0.1:17861/v1"'));
    assert.equal(options.threadParams.sandbox, 'danger-full-access');
    assert.equal(options.turnParams.effort, 'ultra');
    assert(!options.processArgs.some(value => value.includes('service_tier')));
  } finally {
    if (previous === undefined) delete process.env.AI_HUB_CHATGPT_ROOT;
    else process.env.AI_HUB_CHATGPT_ROOT = previous;
  }
});
