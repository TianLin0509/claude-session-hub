'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { availableRoutes, requireWebTools, webStatus } = require('../core/chatgpt-web-integration');
const { normalizeCodexSessionModel } = require('../core/model-options');
const { buildCodexModelOptions } = require('../core/codex-model-catalog');
const { buildSessionResumeMeta } = require('../core/session-capabilities');

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
  const env = { CODEX_CHATGPT_WEB_HOME: root };
  const config = { host: '127.0.0.1', port: 1, mode: 'browser-only', proAvailable: true, controlToken: 'never-expose-this' };
  const save = () => fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
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
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ host: '127.0.0.1', port: 17841, mode: 'full', proAvailable: true }));
  const previous = process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  try {
    const { buildNativeCodexOptions } = require('../core/session-manager')._private;
    const options = buildNativeCodexOptions({ kind: 'codex', cwd: root, currentModel: { id: 'chatgpt-web/pro' }, effort: 'ultra', mcpProfile: 'none', codexSpeedTier: 'inherit' }, {}, { CODEX_HOME: root });
    assert(options.processArgs.includes('model_provider="openai"'));
    assert(options.processArgs.includes('openai_base_url="http://127.0.0.1:17841/v1"'));
    assert.equal(options.threadParams.sandbox, 'danger-full-access');
    assert.equal(options.turnParams.effort, 'ultra');
    assert(!options.processArgs.some(value => value.includes('service_tier')));
  } finally {
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
    else process.env.CODEX_CHATGPT_WEB_HOME = previous;
  }
});
