'use strict';
// 账号即模型（2026-10-19 田哥：「每个账号现在都只有一个模型……起一个会话，直接用默认的模型就可以了」「唯一需要的就是一开始选账号」）
// 与个人账号默认模型被改回 DS 的排查（公司真机 14:17:24，~/.cac/settings.json 的 model 从 GLM-5.2-WX-Auto 变回 deepseek-v4-flash-0731）。
// 覆盖：
//   1. 通道、公司助理、论坛三类自动会话：调用方带来的模型和选型标记不认；2026-10-20 起只按号定下的模型（_createSession 写 codeagentAccountModel）
//      在启动和原地重拉时走 /model 菜单，像真人从启动中心新建那样（公司真机 Q-1020-14：只靠账号配置，个人号启动后仍被写回 DS）；
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

test('1. 自动会话只按号定下的模型走菜单；菜单处理只在启动和原地重拉时放行，会话中途切换照旧拒绝', () => {
  for (const purpose of AUTO) {
    const opts = { purpose, model: GLM, codeagentModelPick: true, codeagentAccountModel: GLM };
    assert.equal(shouldPickCodeAgentModel(opts), true, purpose);
    assert.equal(shouldPickCodeAgentModel({ ...opts, codeagentAccountModel: DS }), false, `${purpose} 号定的不是这个模型`);
    const launch = buildCodeAgentPtyLaunch(`auto-pick-${purpose}`, 'codeagent', opts, root, {}, config);
    assert.match(launch.cmd, / --setting-sources user /, purpose);
    assert.equal(launch.model, GLM);
  }
  const handlers = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'session-handlers.js'), 'utf8');
  // 会话中途切换一律拒绝，只放行启动 / 原地重拉，以及 2026-10-22 起的 model-config-fix（通道报「模型配置有误」后当场换模型）
  assert.match(handlers, /\['company-bridge', 'company-assistant', 'company-forum'\]\.includes\(session\.purpose\)\s*&& reason !== 'launch' && reason !== 'relaunch' && reason !== 'model-config-fix'/);
  // 菜单没选上、输入框已恢复：自动会话照旧发活（不卡住这一轮），并且不把显示模型改成没选上的那个
  // 2026-10-21 起：旧版画面认不出输入框、但菜单已关时（inputUsable）也照常发（core/codeagent-model-picker.js inputUsableAfterPick）
  assert.match(handlers, /const automatic = \['company-bridge', 'company-assistant', 'company-forum'\]\.includes\(session\.purpose\);/);
  assert.match(handlers, /const fallback = !result\.ok && automatic && \(result\.inputReady \|\| result\.inputUsable\);/);
  assert.match(handlers, /if \(fallback\) \{\s*return \{ \.\.\.result, ok: true, fallback: 'cli-default-model' \};/);
  assert.ok(handlers.indexOf("fallback: 'cli-default-model'") < handlers.indexOf('codeagentUserModel: picked'), '回退在记录「用户选中的模型」之前返回');
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
  assert.deepEqual(restored, [{ before: GLM, after: DS, original: DS, restored: true }]);
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


test('2. 遗留标记写回要过校验（审核）：号的 model 切过之后又被改过、原值不在权限清单里、原值为空，都只删标记不写，并给出原因', () => {
  const personal = tmp('personal');
  writeSettings(personal, { model: GLM });
  const run = ({ own, marker, models = null }) => {
    const target = tmp('acct');
    writeSettings(target, own === undefined ? {} : { model: own });
    if (models) fs.writeFileSync(path.join(target, '.cac.json'), JSON.stringify({ enterpriseModelOptionsCache: models.map(value => ({ value })) }));
    fs.writeFileSync(path.join(target, pool.ROUTE_MARKER), JSON.stringify(marker));
    const seen = [];
    pool.syncSharedConfig(personal, target, undefined, { idle: true, onRouteRestore: x => seen.push(x) });
    return { model: settingsModel(target), marker: fs.existsSync(path.join(target, pool.ROUTE_MARKER)), seen };
  };
  let r = run({ own: 'MiniMax-M2.7', marker: { original: DS, model: GLM } });
  assert.deepEqual([r.model, r.marker, r.seen[0].restored, r.seen[0].reason], ['MiniMax-M2.7', false, false, 'model-changed-since-switch'], '切过之后号的 model 被改过：不写');
  r = run({ own: GLM, marker: { original: DS, model: GLM }, models: [GLM] });
  assert.deepEqual([r.model, r.marker, r.seen[0].restored, r.seen[0].reason], [GLM, false, false, 'original-not-in-list'], '原值不在清单里：不写');
  r = run({ own: GLM, marker: { original: '', model: GLM } });
  assert.deepEqual([r.model, r.marker, r.seen[0].restored, r.seen[0].reason], [GLM, false, false, 'original-empty'], '原值为空：不写成 before==after');
  r = run({ own: GLM, marker: { model: GLM } });
  assert.equal(r.seen[0].reason, 'original-empty');
  // 清单未知、号的 model 仍是当初切过去的值：写回
  r = run({ own: GLM, marker: { original: DS, model: GLM } });
  assert.deepEqual([r.model, r.marker, r.seen[0].restored], [DS, false, true]);
  // 清单已知且含原值：写回
  r = run({ own: GLM, marker: { original: DS, model: GLM }, models: [GLM, DS] });
  assert.deepEqual([r.model, r.seen[0].restored], [DS, true]);
});

test('2. 号池号默认模型和个人号一样严格（审核）：写了且在清单里才算已知；没写 / 不在清单里不参与按模型派活，不指定模型时排后兜底，号表标出', () => {
  const d = path.join(root, 'strict-data');
  fs.mkdirSync(path.join(d, 'codeagent-pool'), { recursive: true });
  const ids = ['ok0001', 'miss01', 'bad001'];
  fs.writeFileSync(path.join(d, 'codeagent-pool', 'pool.json'), JSON.stringify({ schema: 1, accounts: ids.map(id => ({ id, note: '', createdAt: '', lastAssignedAt: 0 })) }));
  const probe = require('../core/codeagent-model-probe');
  for (const [id, written] of [['ok0001', DS], ['miss01', undefined], ['bad001', 'GLM-9']]) {
    const dir = pool.accountDir(d, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'x', accountId: 'acc' + id, expiresAt: Date.now() + 72 * 3600000 } }));
    writeSettings(dir, written ? { model: written } : {});
    // 清单只有一个模型时就是它（2026-10-20 例外，见下一条），这里用两个模型的清单测严格判定
    probe.writeProbed(path.join(dir, probe.MODELS_FILE), { models: id === 'ok0001' ? [DS] : [DS, GLM], defaultModel: DS });
  }
  const accounts = route.routeAccounts({ dataDir: d, personalDir: '' });
  const by = id => accounts.find(a => a.key === id);
  assert.equal(by('ok0001').defaultModel, DS);
  assert.equal(by('miss01').defaultModel, '', '没写：未知（不按清单猜成 DS）');
  assert.match(by('miss01').defaultNote, /没写 model/);
  assert.equal(by('bad001').defaultModel, '');
  assert.equal(by('bad001').configModel, 'GLM-9', 'configModel 取号目录里写的值');
  assert.match(by('bad001').defaultNote, /GLM-9 不在权限清单里/);
  // 按模型派活只挑默认已知的号
  const only = accounts.filter(a => a.key !== 'ok0001');
  assert.equal(route.pickRoute(only, DS).reason, 'none');
  assert.equal(route.pickRoute(accounts, DS).account.key, 'ok0001');
  // 不指定模型：默认未知的号排后兜底（哪怕它会话更少）
  const busyOk = accounts.map(a => (a.key === 'ok0001' ? { ...a, activeSessions: 5 } : a));
  assert.equal(route.pickAnyRoute(busyOk).account.key, 'ok0001');
  assert.equal(route.pickAnyRoute(only).ok, true, '只剩它们时照用');
  // 号表标出
  const table = route.modelTable(accounts, { aliases: new Map([['ok0001', '号 1'], ['miss01', '号 2'], ['bad001', '号 3']]) });
  assert.match(table.accountRows.find(r => r.alias === '号 2').defaultNote, /默认模型未知/);
  assert.equal(table.accountRows.find(r => r.alias === '号 1').defaultNote, undefined);
  assert.match(require('../core/company-bridge/model-table-text').describeAccounts(table).join('\n'), /号 3：默认模型未知，.*不在权限清单里），不参与按模型派活/);
  // 开会话时同一口径：没写默认的号，指定 DS 也不开
  const prev = process.env.CLAUDE_HUB_DATA_DIR; process.env.CLAUDE_HUB_DATA_DIR = d;
  try {
    const fake = { codeagentPoolActiveCounts: () => ({}), deployCodeAgentHooks: null };
    const personalDir = tmp('personal'); writeSettings(personalDir, { model: GLM });
    assert.throws(() => SessionManager.prototype._resolveCodeAgentPool.call(fake, { cwd: root, purpose: 'company-bridge', codeagentAccount: 'pool', codeagentPoolPick: 'miss01', codeagentRouteModel: DS },
      { ...config, configDir: personalDir }), /默认模型是 未知，不是 deepseek/);
    assert.equal(settingsModel(pool.accountDir(d, 'miss01')), undefined, '也没替它写');
  } finally { process.env.CLAUDE_HUB_DATA_DIR = prev; }
});

test('2. 探测过的清单只有一个模型时就是它（2026-10-20 公司真机：CodeAgent 把默认模型写回 deepseek，只有 GLM 的个人号和新号被判成未知）', () => {
  const d = path.join(root, 'single-data');
  fs.mkdirSync(path.join(d, 'codeagent-pool'), { recursive: true });
  const ids = ['ds0001', 'glm001', 'glm002'];
  fs.writeFileSync(path.join(d, 'codeagent-pool', 'pool.json'), JSON.stringify({ schema: 1, accounts: ids.map(id => ({ id, note: '', createdAt: '', lastAssignedAt: 0 })) }));
  const probe = require('../core/codeagent-model-probe');
  for (const [id, written, models] of [['ds0001', DS, [DS]], ['glm001', 'deepseek-v4-flash-0731', [GLM]], ['glm002', undefined, [GLM]]]) {
    const dir = pool.accountDir(d, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'x', accountId: 'acc' + id, expiresAt: Date.now() + 72 * 3600000 } }));
    writeSettings(dir, written ? { model: written } : {});
    probe.writeProbed(path.join(dir, probe.MODELS_FILE), { models, defaultModel: '' });
  }
  // 个人号：写的是没权限的 deepseek、清单只有 GLM
  const personalDir = tmp('personal-single');
  fs.writeFileSync(path.join(personalDir, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'x', accountId: 'accpersonal', expiresAt: Date.now() + 72 * 3600000 } }));
  writeSettings(personalDir, { model: 'deepseek-v4-flash-0731' });
  probe.writeProbed(pool.personalModelsFile(d), { models: [GLM], defaultModel: '' });
  const accounts = route.routeAccounts({ dataDir: d, personalDir });
  const by = id => accounts.find(a => a.key === id);
  assert.deepEqual(['personal', 'glm001', 'glm002'].map(k => [by(k).defaultModel, by(k).defaultNote]),
    [[GLM, undefined], [GLM, undefined], [GLM, undefined]], '号的模型是清单里唯一的 GLM，不标未知');
  assert.equal(pool.listAccounts(d).find(a => a.id === 'glm001').defaultNote, undefined, '号表直查同一口径');
  // 按模型派活：三个 GLM 号都能接，DS 号照旧
  assert.equal(route.listModels(accounts).length, 2);
  assert.equal(route.pickRoute(accounts, DS).account.key, 'ds0001');
  assert.ok(['glm001', 'glm002', 'personal'].includes(route.pickRoute(accounts, GLM).account.key));
  // 按写的 deepseek 报过错的记录：不指定模型时照样避让（选不上菜单就会按它跑），直到写的值改对；
  // 指定 GLM 时请求的就是 GLM（开起来在菜单里选中它），不受这条记录拦；没报过错的号不受影响
  const rec = { kind: 'model-config', until: Date.now() + 3600000 };
  const withAvoid = accounts.map(a => (a.key === 'personal' ? { ...a, modelAvoid: { 'deepseek-v4-flash-0731': rec } } : a));
  assert.equal(route.pickAnyRoute(withAvoid, { only: 'personal' }).reason, 'avoid');
  assert.equal(route.pickRoute(withAvoid, GLM, { only: 'personal' }).ok, true);
  assert.equal(route.pickAnyRoute(withAvoid, { only: 'glm001' }).ok, true);
  const fixed = withAvoid.map(a => (a.key === 'personal' ? { ...a, configModel: GLM } : a));
  assert.equal(route.pickAnyRoute(fixed, { only: 'personal' }).ok, true, '写的值改对之后不再避让');
  // 清单没探测过（不权威）或有多个模型：照旧严格，不猜
  assert.equal(pool.personalDefaultModel('deepseek-v4-flash-0731', { models: [GLM], defaultModel: '' }, { single: true }), '');
  assert.equal(pool.personalDefaultModel('deepseek-v4-flash-0731', { models: [GLM], defaultModel: '', authoritative: true }, { single: true }), GLM);
  // 不传 single 照旧严格（2026-10-22 改）：这一档现在只给「清单有多个/未知时不当着用户的面承诺模型」用，
  // 手动会话的启动选型另外走 single（session-manager），不用这个返回值。
  assert.equal(pool.personalDefaultModel('deepseek-v4-flash-0731', { models: [GLM], defaultModel: '', authoritative: true }), '');
  assert.equal(pool.strictDefaultModel('MiniMax-M2.7', [GLM, DS], { authoritative: true }).model, '');
  assert.equal(pool.strictDefaultModel('deepseek-v4-flash-0731', [GLM]).model, '');
});

test('6. 看守改回失败不停在被改后的值（审核）：写失败下一拍重试；一直失败就 verified:false 报出', async t => {
  const dir = tmp('cac-fail');
  writeSettings(dir, { model: GLM });
  const snapshot = picker.snapshotDefaults(dir);
  writeSettings(dir, { model: DS });
  const realWrite = fs.writeFileSync;
  let failures = 2;
  t.mock.method(fs, 'writeFileSync', function (file, ...rest) {
    if (String(file).includes('.hub-model-') && failures > 0) { failures -= 1; throw Object.assign(new Error('EBUSY: 被占用'), { code: 'EBUSY' }); }
    return realWrite.call(fs, file, ...rest);
  });
  const seen = [];
  const r = await picker.guardDefaults(snapshot, { durationMs: 600, intervalMs: 50, onChange: c => seen.push(c) });
  assert.equal(r.verified, true, '前两次写失败，之后重试成功');
  assert.equal(settingsModel(dir), GLM);
  assert.ok(seen.filter(c => c.error).length >= 2 && seen.some(c => c.ok), '失败的那几拍带原因');
  // 一直写不进去：看守结束报 verified:false，after 是被改后的值
  failures = Infinity;
  writeSettings(dir, { model: DS });
  const r2 = await picker.guardDefaults(picker.snapshotDefaults(dir).map(x => ({ ...x, model: GLM })), { durationMs: 300, intervalMs: 50 });
  assert.equal(r2.verified, false);
  assert.equal(r2.after, DS);
});

test('2. 启动中心的预计模型（plannedModel）开关关着时等于号自己写的默认值，和同步配置同一口径', () => {
  const dir = tmp('planned');
  writeSettings(dir, { model: DS });
  require('../core/codeagent-model-probe').writeProbed(path.join(dir, require('../core/codeagent-model-probe').MODELS_FILE), { models: [GLM, DS], defaultModel: GLM });
  assert.equal(pool.plannedModel(dir, { idle: true }), DS, '号自己写的 DS，不按清单的默认 GLM 推断');
  writeSettings(dir, {});
  assert.equal(pool.plannedModel(dir, { idle: true }), '', '没写：未知，不猜');
  writeSettings(dir, { model: 'GLM-9' });
  assert.equal(pool.plannedModel(dir, { idle: true }), '', '写的不在清单里：未知');
  // 遗留标记：满足写回条件且号空闲时是原值；号上有会话时仍是此刻写的值
  writeSettings(dir, { model: GLM });
  fs.writeFileSync(path.join(dir, pool.ROUTE_MARKER), JSON.stringify({ original: DS, model: GLM }));
  assert.equal(pool.plannedModel(dir, { idle: true }), DS);
  assert.equal(pool.plannedModel(dir, { idle: false }), GLM);
  const personal = tmp('personal'); writeSettings(personal, { model: GLM });
  assert.equal(pool.syncSharedConfig(personal, dir, undefined, { idle: true }).model, DS, '同步后实际定下的和预计的一致');
  assert.equal(settingsModel(dir), DS);
});
