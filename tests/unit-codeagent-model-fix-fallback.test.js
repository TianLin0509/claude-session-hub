'use strict';
// 「模型配置有误」的两处兜底（2026-10-22 田哥，公司真机 Q-1022-*：明明是 DeepSeek 账号、却按 GLM 打开，报模型配置有误）：
//   1. 发第一条问题之前：将要请求的模型不在这个号的权限清单里时，开菜单改选清单里的模型（不再只是记一行日志照发）；
//   2. 报错之后：通道让 Hub 在同一个会话里用 /model 切到清单里的模型，再把这一轮重发一次（core/company-bridge/company.js
//      的 fixModelInSession → 这里返回的 fixCodeAgentModel）；这里覆盖 main 侧的这两个入口。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const picker = require('../core/codeagent-model-picker');
const probe = require('../core/codeagent-model-probe');

const GLM = 'GLM-5.2-WX-Auto', DS = 'deepseek-v4-flash-0731';
const tmp = (t, name) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `hub-modelfix-${name}-`)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

// 一个号池号的会话：配置目录里有探测到的权限清单（hub-models.json ⇒ authoritative）
function harness(t, { models = [DS], account = 'acct-1', purpose = 'company-bridge', pickResults = [] } = {}) {
  const dataDir = tmp(t, 'data');
  const cfg = tmp(t, 'cfg');
  fs.writeFileSync(path.join(cfg, 'hub-models.json'), JSON.stringify({ schema: 1, models, defaultModel: models[0] || '', at: new Date().toISOString() }));
  fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ model: models[0] || '' }));
  const prev = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = dataDir;
  t.after(() => { if (prev === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = prev; });
  const calls = [];
  t.mock.method(picker, 'pickModel', async opts => {
    calls.push({ modelId: opts.modelId, allowedModels: opts.allowedModels, readyFirstMs: opts.readyFirstMs });
    return pickResults[calls.length - 1] || { ok: true, confirmed: true, menu: models.slice() };
  });
  const session = { id: 'ca-1', kind: 'codeagent', purpose, id2: undefined, codeagentConfigDir: cfg, codeagentPoolAccount: account };
  const manager = new EventEmitter();
  const patched = [];
  manager.getSession = id => (id === session.id ? session : null);
  manager.updateSessionMeta = (id, patch) => { patched.push(patch); return null; };
  manager.getAllSessions = () => [session];
  manager.codeagentPoolActiveCounts = () => ({});
  const sent = [];
  const ops = require('../main/ipc/session-handlers').registerSessionIpc({ handle() {}, on() {} },
    { sendToRenderer: (e, d) => sent.push([e, d]), sessionManager: manager });
  return { dataDir, cfg, session, manager, calls, patched, sent, ops, models, log: () => fs.readFileSync(path.join(dataDir, 'logs', 'codeagent-model.log'), 'utf8') };
}

test('发第一条问题前：目标模型不在权限清单里 → 第二次开菜单改选清单里的模型，并按选中模型记账', async t => {
  const h = harness(t, { models: [DS] });
  h.manager.emit('codeagent-model-pick', { sessionId: h.session.id, modelId: GLM, reason: 'launch' });
  const result = await picker.waitForPick(h.session.id);
  assert.equal(result.ok, true);
  assert.equal(result.model, DS, '结果是清单里的模型');
  assert.deepEqual(h.calls.map(c => c.modelId), [GLM, DS], '先按目标选，发现没权限后改选清单里的');
  assert.deepEqual(h.calls[0].allowedModels, [DS], '清单是权威的：菜单里只认清单里的模型');
  assert.equal(h.calls[0].readyFirstMs, 45000, '启动时等输入框出来再敲 /model');
  assert.equal(h.calls[1].readyFirstMs, 45000, '改选这一趟同样等输入框');
  assert.deepEqual(h.patched.at(-1).currentModel, { id: DS, displayName: require('../core/codeagent-models').modelLabel(DS) }, '会话按选中的模型记账');
  assert.equal(h.patched.at(-1).codeagentUserModel, DS);
  assert.match(h.log(), /off-permission：GLM-5\.2-WX-Auto 不在这个号的权限清单里，改选清单里的 deepseek-v4-flash-0731/);
  assert.equal(h.sent.some(([e]) => e === 'session-notice'), false, '没报「没切成功」的提示');
});

test('发第一条问题前：改选也选不上（菜单坏了）→ 照旧按「能发就发」走，并留下一行诊断', async t => {
  const h = harness(t, { models: [DS], pickResults: [
    { ok: true, confirmed: true },
    { ok: false, inputUsable: true, message: '模型命令尚未确认' },
  ] });
  h.manager.emit('codeagent-model-pick', { sessionId: h.session.id, modelId: GLM, reason: 'launch' });
  const result = await picker.waitForPick(h.session.id);
  assert.equal(result.ok, true, '自动会话照旧把问题发出去（不卡这一轮）');
  assert.equal(result.fallback, 'cli-default-model');
  assert.deepEqual(h.calls.map(c => c.modelId), [GLM, DS]);
  assert.match(h.log(), /off-permission：会请求的模型不在权限清单里，菜单没能用上，照旧发出/);
});

test('目标模型本来就在权限清单里：不动，只开一次菜单（回归）', async t => {
  const h = harness(t, { models: [DS] });
  h.manager.emit('codeagent-model-pick', { sessionId: h.session.id, modelId: DS, reason: 'launch' });
  const result = await picker.waitForPick(h.session.id);
  assert.equal(result.ok, true);
  assert.deepEqual(h.calls.map(c => c.modelId), [DS]);
  assert.equal(h.sent.length, 0);
});

test('报错后的兜底入口：fixCodeAgentModel 在同一个会话里选清单里第一个不是刚报错那个的模型', async t => {
  const h = harness(t, { models: [DS] });
  const result = await h.ops.fixCodeAgentModel(h.session.id, { avoidModel: GLM });
  assert.equal(result.ok, true);
  assert.equal(result.model, DS);
  assert.deepEqual(h.calls.map(c => c.modelId), [DS]);
  assert.equal(h.calls[0].readyFirstMs, 0, '会话已经在跑，不用等输入框');
  assert.deepEqual(h.patched.at(-1).currentModel, { id: DS, displayName: require('../core/codeagent-models').modelLabel(DS) });
  assert.match(h.log(), /reason=model-config-fix/, '日志写明是报错后的兜底');
});

test('报错后的兜底入口：清单里只有刚报错的那个模型 / 读不到清单 → 不切，交回通道换号或报错', async t => {
  const same = harness(t, { models: [GLM] });
  const noWay = await same.ops.fixCodeAgentModel(same.session.id, { avoidModel: GLM });
  assert.equal(noWay.ok, false);
  assert.equal(noWay.error, 'no-model');
  assert.match(noWay.message, /只有刚报错的 GLM-5\.2-WX-Auto/);
  assert.deepEqual(same.calls, [], '没有开菜单');

  const blank = harness(t, { models: [] });
  const none = await blank.ops.fixCodeAgentModel(blank.session.id, { avoidModel: GLM });
  assert.equal(none.error, 'no-model');
  assert.match(none.message, /读不到这个号的权限清单/);
});

test('报错后的兜底入口：会话已经关了 / 菜单正在切 → 明确回不行，不抛错', async t => {
  const h = harness(t, { models: [DS] });
  const gone = await h.ops.fixCodeAgentModel('ca-nope', { avoidModel: GLM });
  assert.equal(gone.ok, false);
  assert.equal(gone.error, 'session-closed');
  // 正在切模型（pending 里有这个会话）：第二次进来直接拒绝
  picker.schedulePick(h.session.id, () => new Promise(resolve => setTimeout(() => resolve({ ok: true }), 30)));
  const busy = await h.ops.fixCodeAgentModel(h.session.id, { avoidModel: GLM });
  assert.equal(busy.ok, false);
  assert.equal(busy.error, 'busy');
  await picker.waitForPick(h.session.id);
});

test('报错后的兜底入口：菜单选不上 → ok=false 带原因，通道据此照旧换号（每轮只试一次由通道记）', async t => {
  // 「能发就发」的老兜底在这里必须算没切成：否则通道会以为切好了、重发一轮又撞同一条报错
  const h = harness(t, { models: [DS], pickResults: [{ ok: false, inputReady: true, message: '模型命令尚未确认' }] });
  const result = await h.ops.fixCodeAgentModel(h.session.id, { avoidModel: GLM });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'pick-failed');
  assert.equal(result.model, DS);
  assert.match(result.message, /模型菜单没能用上，会话还是当前模型/);
  assert.equal(result.fallback, undefined);
});

test('权限清单来自探测文件：号池号用自己目录里的 hub-models.json（回归）', t => {
  const h = harness(t, { models: [GLM, DS] });
  assert.deepEqual(probe.readProbed(path.join(h.cfg, probe.MODELS_FILE)).models, [GLM, DS]);
});