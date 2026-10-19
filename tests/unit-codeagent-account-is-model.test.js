'use strict';
// 账号即模型（2026-10-19 田哥：「每个账号现在都只有一个模型……起一个会话，直接用默认的模型就可以了」「唯一需要的就是一开始选账号」）
// 与个人账号默认模型被改回 DS 的排查（公司真机 14:17:24，~/.cac/settings.json 的 model 从 GLM-5.2-WX-Auto 变回 deepseek-v4-flash-0731）。
// 覆盖：
//   1. 通道、公司助理、论坛三类自动会话：启动和恢复都不带模型、不驱动 /model 菜单；
//   2. 通道按模型派活只挑默认模型就是它的号，不切号的默认模型；遗留的 hub-route-model.json 空闲时按原值写回一次并删掉；
//   3. 用户手动选模型照旧走菜单；
//   4. 恢复会话绝不「选回」旧模型（存档里带 DS 的 currentModel / requestedModel / actualModel / 选型标记）；
//   5. 通道派活全程不写任何 settings.json 的 model；
//   6. 菜单目标不在账号权限清单里就拒绝；回车后 CodeAgent 后写也能改回，目录先规范化；
//   7. 默认模型每次变化在 codeagent-model.log 留一行：会话、账号代称、写前、写后、来源。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

delete process.env.AI_HUB_CODEAGENT_ROUTE_SWITCH; // 默认关
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-account-model-'));
const previous = process.env.CLAUDE_HUB_DATA_DIR;
const dataDir = path.join(root, 'hub');
process.env.CLAUDE_HUB_DATA_DIR = dataDir;
test.after(() => {
  if (previous === undefined) delete process.env.CLAUDE_HUB_DATA_DIR;
  else process.env.CLAUDE_HUB_DATA_DIR = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

const { SessionManager, _private: { buildCodeAgentPtyLaunch, shouldPickCodeAgentModel } } = require('../core/session-manager');
const { createResumeSessionHandler } = require('../main/ipc/resume-session-handlers');
const route = require('../core/codeagent-model-route');
const pool = require('../core/codeagent-pool');
const picker = require('../core/codeagent-model-picker');
const guard = require('../core/codeagent-default-model-guard');

const GLM = 'GLM-5.2-WX-Auto', DS = 'deepseek-v4-flash-0731';
const AUTO = ['company-bridge', 'company-assistant', 'company-forum'];
const config = { command: 'codeagent', configDir: path.join(root, 'cac'), stateFile: '.cac.json' };
const settingsModel = dir => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).model; } catch { return undefined; } };
const writeSettings = (dir, value) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(value, null, 2)); };
const tmp = name => fs.mkdtempSync(path.join(root, name + '-'));

function resumeHandler(created) {
  return createResumeSessionHandler({ fs, os, path,
    getHookPort: () => 0, getHubDataDir: () => dataDir,
    isClaudeFamily: require('../core/ai-kinds').isClaudeFamily, isCodexBaseKind: () => false,
    meetingManager: { getMeeting: () => null }, slotIds: [], scenes: {},
    findTranscriptByCCSessionId: () => null,
    sessionManager: { createSession: (kind, opts) => { created.push({ kind, opts }); return { id: opts.id, kind, opts }; }, getSession: () => null },
    registerSessionForTap() {}, sendToRenderer() {}, logger: { warn() {}, log() {} },
  });
}

test('1. 通道、公司助理、论坛：启动不带 --model、不驱动菜单（哪怕带着模型和选型标记）', () => {
  for (const purpose of AUTO) {
    const opts = { purpose, model: DS, codeagentModelPick: true };
    assert.equal(shouldPickCodeAgentModel(opts), false, purpose);
    const launch = buildCodeAgentPtyLaunch(`auto-${purpose}`, 'codeagent', opts, root, {}, config);
    assert.doesNotMatch(launch.cmd, /--model/, purpose);
    assert.equal(launch.model, null);
  }
});

test('1/4. 自动会话恢复：不传模型、不选型，启动覆盖里带模型也不认', async () => {
  for (const purpose of AUTO) {
    const created = [];
    await resumeHandler(created)({ hubId: `auto-resume-${purpose}`, kind: 'codeagent', cwd: root, purpose,
      currentModel: { id: DS }, codeagentRequestedModel: DS, codeagentActualModel: DS, codeagentModelPick: true,
      launchOverrides: { model: DS, codeagentModelPick: true } });
    const opts = created[0].opts;
    assert.equal(opts.model, undefined, `${purpose} 恢复不带模型`);
    assert.equal(opts.codeagentModelPick, false, `${purpose} 恢复不选型`);
    assert.equal(shouldPickCodeAgentModel(opts), false);
  }
});

test('4. 普通会话恢复：存档带 DS 的当前模型、请求模型、实际模型和旧选型标记，也不选回 DS', async () => {
  const created = [];
  await resumeHandler(created)({ hubId: 'user-resume-ds', kind: 'codeagent', cwd: root,
    currentModel: { id: DS }, codeagentRequestedModel: DS, codeagentActualModel: DS, codeagentModelPick: true });
  const opts = created[0].opts;
  assert.equal(opts.codeagentModelPick, false);
  assert.equal(shouldPickCodeAgentModel(opts), false);
  assert.doesNotMatch(buildCodeAgentPtyLaunch('user-resume-ds', 'codeagent', opts, root, {}, config).cmd, /--model/);
});

test('3. 用户手动选模型照旧：新建时明确选的、重启时明确换的，才走菜单', async () => {
  assert.equal(shouldPickCodeAgentModel({ model: GLM, codeagentModelPick: true }), true);
  const created = [];
  await resumeHandler(created)({ hubId: 'user-switch', kind: 'codeagent', cwd: root, currentModel: { id: DS },
    launchOverrides: { model: GLM, codeagentModelPick: true } });
  assert.equal(created[0].opts.codeagentModelPick, true);
  assert.equal(created[0].opts.model, GLM);
});

test('2. 通道按模型派活：只挑默认模型就是它的号，不为凑模型切号（开关默认关）', () => {
  assert.equal(route.routeSwitchEnabled(), false);
  const personal = { key: 'personal', pool: false, models: [GLM], defaultModel: GLM, configModel: GLM, activeSessions: 0, lastAssignedAt: 0 };
  const dsPool = { key: 'p1', pool: true, models: [GLM, DS], defaultModel: DS, configModel: DS, activeSessions: 0, lastAssignedAt: 0 };
  const glmPoolWithDs = { key: 'p2', pool: true, models: [GLM, DS], defaultModel: GLM, configModel: GLM, activeSessions: 0, lastAssignedAt: 0 };
  const pick = route.pickRoute([personal, dsPool, glmPoolWithDs], DS);
  assert.equal(pick.ok, true);
  assert.equal(pick.account.key, 'p1');
  assert.equal(pick.switchModel, false);
  // 只剩一个默认是 GLM、清单里有 DS 的空闲号：不切它，回「没有号」
  assert.equal(route.pickRoute([personal, glmPoolWithDs], DS).reason, 'none');
  // 模型表按「号 → 它的默认模型」：每个号只算默认模型
  assert.deepEqual(route.listModels([personal, dsPool, glmPoolWithDs]).sort(), [GLM, DS].sort());
  assert.deepEqual(route.listModels([personal, glmPoolWithDs]), [GLM]);
  // 打开开关恢复旧行为（可以切空闲号的默认模型）
  process.env.AI_HUB_CODEAGENT_ROUTE_SWITCH = '1';
  try { assert.equal(route.pickRoute([personal, glmPoolWithDs], DS).account.key, 'p2'); }
  finally { delete process.env.AI_HUB_CODEAGENT_ROUTE_SWITCH; }
});

test('2. 同步号配置（开关默认关）：号自己的 model 原样保留（没写就不写），指定模型不切、不写 hub-route-model.json', () => {
  const personal = tmp('personal'), target = tmp('acct');
  writeSettings(personal, { model: GLM, env: { A: '1' } });
  writeSettings(target, { model: DS });
  const r = pool.syncSharedConfig(personal, target, undefined, { routeModel: GLM, idle: true });
  assert.equal(settingsModel(target), DS);
  assert.equal(r.model, DS);
  assert.equal(fs.existsSync(path.join(target, pool.ROUTE_MARKER)), false);
  // 号没写默认模型：不替它写
  const bare = tmp('bare');
  fs.writeFileSync(path.join(bare, '.cac.json'), JSON.stringify({ enterpriseModelOptionsCache: [{ value: DS }] }));
  pool.syncSharedConfig(personal, bare, undefined, { idle: true });
  assert.equal(settingsModel(bare), undefined);
});

test('2. 遗留的 hub-route-model.json：号空闲时按原值写回一次再删掉，并回调记日志；号上有会话时不动', () => {
  const personal = tmp('personal'), target = tmp('acct');
  writeSettings(personal, { model: GLM });
  writeSettings(target, { model: GLM });
  fs.writeFileSync(path.join(target, pool.ROUTE_MARKER), JSON.stringify({ original: DS, model: GLM }));
  const restored = [];
  pool.syncSharedConfig(personal, target, undefined, { idle: false, onRouteRestore: x => restored.push(x) });
  assert.equal(settingsModel(target), GLM, '号上有会话：不动');
  assert.equal(fs.existsSync(path.join(target, pool.ROUTE_MARKER)), true);
  pool.syncSharedConfig(personal, target, undefined, { idle: true, onRouteRestore: x => restored.push(x) });
  assert.equal(settingsModel(target), DS, '空闲：写回切之前的原值');
  assert.equal(fs.existsSync(path.join(target, pool.ROUTE_MARKER)), false, '记录删掉');
  assert.deepEqual(restored, [{ before: GLM, after: DS, original: DS }]);
  pool.syncSharedConfig(personal, target, undefined, { idle: true, onRouteRestore: x => restored.push(x) });
  assert.equal(restored.length, 1, '只写回一次');
});

function fixtureAccount(id, model) {
  const dir = pool.accountDir(dataDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'x', accountId: 'acct' + id, expiresAt: Date.now() + 72 * 3600000, env: 'test' } }));
  writeSettings(dir, { model });
  return dir;
}

test('5. 通道派活全程不写任何 settings.json 的 model（新开、指定模型、恢复、指定的模型和号的默认不符）', () => {
  const registry = { schema: 1, accounts: [{ id: 'ds0001', note: '', createdAt: '', lastAssignedAt: 0 }, { id: 'glm001', note: '', createdAt: '', lastAssignedAt: 0 }] };
  fs.mkdirSync(pool.poolRoot(dataDir), { recursive: true });
  fs.writeFileSync(path.join(pool.poolRoot(dataDir), 'pool.json'), JSON.stringify(registry));
  const dsDir = fixtureAccount('ds0001', DS), glmDir = fixtureAccount('glm001', GLM);
  for (const [dir, models] of [[dsDir, [DS]], [glmDir, [GLM, DS]]]) require('../core/codeagent-model-probe').writeProbed(path.join(dir, require('../core/codeagent-model-probe').MODELS_FILE), { models, defaultModel: models[0] });
  const personalDir = tmp('personal');
  writeSettings(personalDir, { model: GLM });
  const dirs = [personalDir, dsDir, glmDir];
  const snapshot = () => dirs.map(settingsModel);
  const before = snapshot();
  const fake = { codeagentPoolActiveCounts: () => ({}), deployCodeAgentHooks: null };
  const resolve = opts => SessionManager.prototype._resolveCodeAgentPool.call(fake, { cwd: root, purpose: 'company-bridge', ...opts }, { ...config, configDir: personalDir });
  assert.equal(resolve({ codeagentAccount: 'pool', codeagentPoolPick: 'ds0001', codeagentRouteModel: DS }).account.id, 'ds0001');
  assert.equal(resolve({ codeagentAccount: 'pool', codeagentPoolPick: 'glm001' }).account.id, 'glm001');
  assert.throws(() => resolve({ codeagentAccount: 'pool', codeagentPoolPick: 'glm001', codeagentRouteModel: DS }), /不改号的默认模型/);
  // 恢复：哪怕当初是按 DS 派到 glm001 上的，也按号此刻的默认模型照常起，不切
  assert.equal(resolve({ codeagentPoolAccount: 'glm001', codeagentRouteModel: DS }).account.id, 'glm001');
  assert.deepEqual(snapshot(), before, 'settings.json 的 model 一个都没变');
  assert.equal(fs.existsSync(path.join(glmDir, pool.ROUTE_MARKER)), false);
});

test('6. 菜单目标不在账号权限清单里：不打开菜单，直接拒绝并列出可选', async () => {
  const writes = [];
  const manager = { writeToSession: (_s, d) => writes.push(d), getSessionBufferSnapshot: async () => { throw new Error('不该读屏'); } };
  const result = await picker.pickModel({ manager, sid: 's1', kind: 'codeagent', modelId: DS, allowedModels: [GLM], sendToPty: async () => { throw new Error('不该发 /model'); } });
  assert.equal(result.ok, false);
  assert.equal(result.notAllowed, true);
  assert.match(result.message, /不在这个账号的模型权限清单里（可选：GLM-5\.2-WX-Auto）/);
  assert.deepEqual(writes, []);
  assert.equal(picker.modelAllowed('glm-5.2-wx-auto', [GLM]), true);
  assert.equal(picker.modelAllowed(DS, null), true, '清单未知不拦');
});

test('6. 回车后 CodeAgent 后写也能改回：看住一段时间，被改就改回，最后核对；目录先规范化', async () => {
  const dir = tmp('cac');
  writeSettings(dir, { model: GLM, hooks: { Stop: [1] } });
  const variant = process.platform === 'win32' ? dir.toUpperCase().replace(/\\/g, '/') + '/' : dir + '/';
  const norm = picker.normalizeConfigDir(variant);
  assert.equal(guard.sameDir(norm, dir), true);
  const snapshot = picker.snapshotDefaults(norm);
  setTimeout(() => writeSettings(dir, { model: DS, hooks: { Stop: [1] } }), 100);
  setTimeout(() => writeSettings(dir, { model: DS, hooks: { Stop: [1] } }), 700); // 改回之后又写一次
  const seen = [];
  const r = await picker.guardDefaults(snapshot, { durationMs: 1200, intervalMs: 50, onChange: c => seen.push(c) });
  assert.equal(r.verified, true);
  assert.equal(settingsModel(dir), GLM);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).hooks, { Stop: [1] });
  assert.ok(seen.length >= 2, `两次后写都改回（看到 ${seen.length} 次）`);
  assert.ok(seen.every(c => c.written === DS && c.restoredTo === GLM && c.ok));
  // 原来没有 settings.local.json、CodeAgent 新建了它写 model：只去掉 model
  const local = path.join(dir, 'settings.local.json');
  const snap2 = picker.snapshotDefaults(dir);
  fs.writeFileSync(local, JSON.stringify({ other: 1, model: DS }));
  const r2 = await picker.guardDefaults(snap2, { durationMs: 200, intervalMs: 50 });
  assert.equal(r2.verified, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(local, 'utf8')), { other: 1 });
});

test('7. 留痕：Hub 自己的写入按登记认来源；认不出的记 external 并带上前后启动的会话；Hub 没在看时被改的启动时补记', () => {
  const dir = tmp('cac-watch');
  writeSettings(dir, { model: GLM });
  const logFile = path.join(dataDir, 'logs', 'codeagent-model.log');
  const watcher = guard.watchPersonal({ dataDir, dir, intervalMs: 60000 });
  try {
    // 一个恢复的个人号会话在改写前 2 秒启动
    require('../core/codeagent-models').appendModelLog(dataDir, { event: 'launch', session: 'abcd1234', account: '个人', resume: '--resume' }, new Date(Date.now() - 2000));
    writeSettings(dir, { model: DS });
    watcher.check();
    let tail = fs.readFileSync(logFile, 'utf8').trim().split('\n').pop();
    assert.match(tail, /event=default-model account=个人 before=GLM-5\.2-WX-Auto after=deepseek-v4-flash-0731 source=external/);
    assert.match(tail, /near=\S*abcd1234@个人\(--resume\)-\d+s/);
    assert.equal(guard.lastChange(dataDir).source, 'external');
    // Hub 自己登记过的写入（例如远程维护）：来源照登记，调用方已记过日志就不重复记
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').length;
    guard.noteHubWrite(dir, GLM, 'remote:set-personal-model', { logged: true });
    writeSettings(dir, { model: GLM });
    watcher.check();
    assert.equal(fs.readFileSync(logFile, 'utf8').trim().split('\n').length, lines);
    assert.equal(guard.lastChange(dataDir).source, 'remote:set-personal-model');
  } finally { watcher.stop(); }
  // Hub 没在看时被改成 DS：下次启动补记一行
  writeSettings(dir, { model: DS });
  guard.watchPersonal({ dataDir, dir, intervalMs: 60000 }).stop();
  const tail = fs.readFileSync(logFile, 'utf8').trim().split('\n').pop();
  assert.match(tail, /before=GLM-5\.2-WX-Auto after=deepseek-v4-flash-0731 source=external-while-hub-not-watching/);
});

test('7. 远程维护 set-personal-model 写入留一行日志（写前、写后、来源），直查能看到最近一次来源', () => {
  const dir = tmp('cac-remote');
  writeSettings(dir, { model: DS });
  fs.writeFileSync(path.join(dir, '.cac.json'), JSON.stringify({ enterpriseModelOptionsCache: [{ value: GLM }] }));
  const r = require('../core/codeagent-personal-model').setPersonalModel({ dataDir, personalDir: dir, model: GLM });
  assert.equal(r.ok, true);
  const tail = fs.readFileSync(path.join(dataDir, 'logs', 'codeagent-model.log'), 'utf8').trim().split('\n').pop();
  assert.match(tail, /event=default-model account=个人 before=deepseek-v4-flash-0731 after=GLM-5\.2-WX-Auto source=remote:set-personal-model/);
  assert.equal(guard.lastChange(dataDir).after, GLM);
});
