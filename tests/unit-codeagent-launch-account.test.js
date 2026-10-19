'use strict';
// 启动中心按账号建会话（2026-10-19 审核修正）：
//   1. 「默认模型」和实际启动用同一套口径（core/codeagent-pool.js plannedModel / syncSharedConfig）：为通道切过模型（hub-route-model.json）
//      且号上没有进行中的会话时，启动会换回切之前的模型，启动中心也按它显示；号上还有会话时按当前模型；
//   2. 个人账号点「重新登录」后，凭证出现就推送 codeagent-pool:changed（账号与号池、启动中心据此刷新），并重新获取模型权限。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pool = require('../core/codeagent-pool');

const GLM = 'GLM-5.2-WX-Auto', DS = 'DeepSeek-V4-Flash-0731';
const j = JSON.stringify;

function tmp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-launch-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
function withEnv(t, vars) {
  const before = {};
  for (const [k, v] of Object.entries(vars)) { before[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}
function account(dir, { model, models, marker = null, accountId = 'z00222222' }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), j({ idaasOAuth: { accountId, expiresAt: Date.now() + 3600000 } }));
  fs.writeFileSync(path.join(dir, 'settings.json'), j({ model }));
  fs.writeFileSync(path.join(dir, 'hub-models.json'), j({ schema: 1, models, defaultModel: models[0], at: new Date().toISOString() }));
  if (marker) fs.writeFileSync(path.join(dir, pool.ROUTE_MARKER), j(marker));
  return dir;
}
function ipc(sessionManager, extra = {}) {
  const handlers = new Map(), sent = [];
  require('../main/ipc/session-handlers').registerSessionIpc({ handle: (k, f) => handlers.set(k, f), on() {} },
    { sendToRenderer: (event, data) => sent.push([event, data]), sessionManager, ...extra });
  return { handlers, sent };
}

test('plannedModel 与 syncSharedConfig 同一口径：切过模型且空闲时按切之前的，有会话时按当前的', t => {
  const root = tmp(t);
  const personal = account(path.join(root, 'personal'), { model: GLM, models: [GLM], accountId: 'w00111111' });
  const dir = account(path.join(root, 'acct'), { model: GLM, models: [DS, GLM], marker: { original: DS, model: GLM } });
  assert.equal(pool.plannedModel(dir, { idle: false }), GLM);
  assert.equal(pool.plannedModel(dir, { idle: true }), DS);
  const busy = pool.syncSharedConfig(personal, dir, fs, { idle: false });
  assert.equal(busy.model, GLM, '有会话：不换回');
  const expected = pool.plannedModel(dir, { idle: true });
  const idle = pool.syncSharedConfig(personal, dir, fs, { idle: true });
  assert.equal(idle.model, expected, '空闲：实际启动和预计一致');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).model, DS);
  assert.equal(fs.existsSync(path.join(dir, pool.ROUTE_MARKER)), false, '换回后去掉标记');
});

test('codeagent:models 的默认模型：手动选号、自动挑号都按 plannedModel，号上有会话时按当前模型', t => {
  const data = tmp(t);
  const personalDir = account(path.join(data, 'personal-cac'), { model: GLM, models: [GLM], accountId: 'w00111111' });
  withEnv(t, { CLAUDE_HUB_DATA_DIR: data, AI_HUB_CODEAGENT_CONFIG_DIR: personalDir, AI_HUB_CODEAGENT_COMMAND: 'codeagent-not-installed' });
  fs.mkdirSync(path.join(data, 'codeagent-pool'), { recursive: true });
  fs.writeFileSync(path.join(data, 'codeagent-pool', 'pool.json'), j({ schema: 1, accounts: [{ id: 'acct01', note: '', createdAt: new Date().toISOString(), lastAssignedAt: 0 }] }));
  account(pool.accountDir(data, 'acct01'), { model: GLM, models: [DS, GLM], marker: { original: DS, model: GLM } });
  let active = {};
  const { handlers } = ipc({ codeagentPoolActiveCounts: () => active, getAllSessions: () => [] });
  const models = payload => handlers.get('codeagent:models')(null, payload);
  assert.equal(models({ account: 'pool', poolAccount: 'acct01' }).defaultModel, DS, '空闲：启动会换回 DS');
  assert.equal(models({ account: 'pool' }).defaultModel, DS);
  active = { acct01: 1 };
  assert.equal(models({ account: 'pool', poolAccount: 'acct01' }).defaultModel, GLM, '有会话：仍是 GLM');
  assert.equal(models({ account: 'pool' }).defaultModel, GLM);
});

test('个人账号重新登录：凭证出现后推送 codeagent-pool:changed（loggedIn），再自动获取模型权限并推送结果', async t => {
  const data = tmp(t);
  const personalDir = path.join(data, 'personal-cac');
  fs.mkdirSync(personalDir, { recursive: true });
  fs.writeFileSync(path.join(personalDir, '.credentials.json'), j({ note: 'expired' }));
  withEnv(t, { CLAUDE_HUB_DATA_DIR: data, AI_HUB_CODEAGENT_CONFIG_DIR: personalDir, AI_HUB_CODEAGENT_COMMAND: 'codeagent-not-installed',
    AI_HUB_CODEAGENT_POOL_LOGIN_FIXTURE: 'e2e' });
  const probes = [];
  const { handlers, sent } = ipc({ codeagentPoolActiveCounts: () => ({}), getAllSessions: () => [] }, {
    codeagentLoginPollMs: 20,
    codeagentProbeModels: async opts => { probes.push(opts.configDir); return { ok: true, models: [GLM], defaultModel: GLM, at: new Date().toISOString() }; },
  });
  assert.equal(pool.accountState(pool.readCredentials(personalDir)), 'unreadable');
  const status = handlers.get('codeagent-pool:personal-login')();
  assert.notEqual(status.ok, false, status.error);
  for (let i = 0; i < 100 && !sent.some(([e, d]) => e === 'codeagent-pool:changed' && d.id === 'personal' && d.auto && d.ok); i++) await new Promise(r => setTimeout(r, 20));
  const changes = sent.filter(([e, d]) => e === 'codeagent-pool:changed' && d.id === 'personal').map(([, d]) => d);
  assert.ok(changes.some(d => d.loggedIn), '登录完成推送');
  assert.ok(changes.some(d => d.auto && d.ok && d.models.includes(GLM)), '自动获取模型权限并推送');
  assert.equal(path.resolve(probes[0]), path.resolve(personalDir), '在个人配置目录获取');
  assert.equal(pool.accountState(pool.readCredentials(personalDir)), 'ready');
});
