'use strict';
// 手动新建的 CodeAgent 会话也核这个号的模型权限（2026-10-22 田哥，公司真机 v3.1.4：用个人账号从启动中心建 codeagent，
// 一开就报「API deepseek 错误」，手动 /model 切一下就好了）。根因：启动中心给 codeagent 收起了模型下拉（一个账号一个模型），
// 建的会话不带 --model、也不开菜单，CLI 就按自己 settings.json 里写的模型起——个人号那份配置里写着 deepseek-v4-flash-0731
// （2026-10-20 起），而它的权限只有 GLM-5.2-WX-Auto（10-23 直查：清单权威、只有 GLM、配置写的 DS）。自动会话早就在启动时
// 按权限清单在菜单里选模型（2026-10-20），手动这条一直没接上。
// 本文件覆盖三处配套改动：
//   1. core/session-manager.js：手动新建（freshLaunch、非通道、非号池）时按同一把尺定启动模型（personalDefaultModel + single），
//      只在「配置里的值定不下权限内的模型、而清单能说出唯一一个模型」时替它选，其余一律不动；
//   2. main/ipc/session-handlers.js：菜单外改选的门放宽到 launch / relaunch（行为在 unit-codeagent-model-fix-fallback.test.js）；
//   3. main/ipc/session-handlers.js 的 codeagent:models：个人账号的「默认」那一项按同一口径给（启动中心的摘要和模型下拉写它）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const pool = require('../core/codeagent-pool');
const probe = require('../core/codeagent-model-probe');
const models = require('../core/codeagent-models');

const GLM = 'GLM-5.2-WX-Auto', DS = 'deepseek-v4-flash-0731';
const login = (dir, accountId) => { fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'x', accountId, expiresAt: Date.now() + 72 * 3600000 } })); };

// 每个用例一套隔离环境：个人号（配置里写的模型、权限清单都由参数定）+ 一个只有 DS 的号池号。
// probed=true 写探测文件（hub 探测过的清单）；probed=false 时可以用 enterprise 造 CodeAgent 自己缓存的
// 企业模型清单（.cac.json 的 enterpriseModelOptionsCache，也算权威）；两个都没有就是「清单不知道」。
function setup(t, { written = DS, models: list = [GLM], probed = true, enterprise = null, pooled = true, breaker = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-manual-model-perm-'));
  const dataDir = path.join(root, 'data'), personal = path.join(root, 'personal-cac');
  const env = { CLAUDE_HUB_DATA_DIR: dataDir, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), AI_HUB_CODEAGENT_CONFIG_DIR: personal,
    AI_HUB_CODEAGENT_COMMAND: 'codeagent', CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex') };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  for (const dir of [dataDir, env.CLAUDE_HUB_HOME_DIR, env.CLAUDE_CONFIG_DIR, env.CODEX_HOME, personal]) fs.mkdirSync(dir, { recursive: true });
  Object.assign(process.env, env);
  require('../core/hub-config').clearConfigCache();
  login(personal, 'w00111111');
  fs.writeFileSync(path.join(personal, 'settings.json'), JSON.stringify({ model: written }));
  if (probed) probe.writeProbed(pool.personalModelsFile(dataDir), { models: list, defaultModel: list[0] || '' });
  else if (enterprise) fs.writeFileSync(path.join(personal, '.cac.json'), JSON.stringify({ enterpriseModelOptionsCache: enterprise.map(id => ({ value: id })) }));
  if (breaker) fs.writeFileSync(path.join(dataDir, require('../core/codeagent-auto-pick').FILE), JSON.stringify({ accounts: { personal: breaker } }));
  let poolId = '';
  if (pooled) {
    poolId = pool.addAccount(dataDir, { note: '同事' });
    login(pool.accountDir(dataDir, poolId), 'w00222222');
    probe.writeProbed(path.join(pool.accountDir(dataDir, poolId), probe.MODELS_FILE), { models: [DS], defaultModel: DS });
    fs.writeFileSync(path.join(pool.accountDir(dataDir, poolId), 'settings.json'), JSON.stringify({ model: DS }));
  }
  const pty = require('node-pty');
  t.mock.method(pty, 'spawn', () => ({ pid: 434343, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, write() {}, resize() {}, kill() {} }));
  const { SessionManager } = require('../core/session-manager');
  const manager = new SessionManager();
  const picks = [];
  manager.on('codeagent-model-pick', event => picks.push(event));
  const cwd = path.join(root, 'work'); fs.mkdirSync(cwd, { recursive: true });
  t.after(() => {
    manager.dispose();
    manager.openOwners?.close();
    require('../core/hub-config').clearConfigCache();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const relative = path.relative(os.tmpdir(), root);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('unsafe test cleanup');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const create = opts => manager.getSession(manager.createSession('codeagent', { cwd, ...opts }).id);
  const settingsModel = () => JSON.parse(fs.readFileSync(path.join(personal, 'settings.json'), 'utf8')).model;
  const modelLog = () => { try { return fs.readFileSync(path.join(dataDir, 'logs', 'codeagent-model.log'), 'utf8'); } catch { return ''; } };
  return { root, dataDir, personal, manager, picks, cwd, poolId, create, settingsModel, modelLog };
}

test('1. 个人账号手动新建：配置里写的 DS 不在权限清单里、清单权威且只有 GLM → 启动时在菜单里选 GLM', t => {
  const h = setup(t);
  const session = h.create({});
  assert.deepEqual(h.picks.map(p => [p.modelId, p.reason]), [[GLM, 'launch']], '启动时按权限清单选模型');
  assert.deepEqual(session.currentModel, { id: GLM, displayName: 'GLM-5.2 Auto' }, '会话的模型就是这个号能用的模型');
  assert.equal(h.settingsModel(), DS, 'Hub 不改个人账号的 settings.json（要改走经授权的远程维护）');
  const log = h.modelLog();
  assert.match(log, /event=launch-model/, '模型日志留下这一行，排查时看得到为什么换了模型');
  assert.match(log, new RegExp(`written=${DS}`));
  assert.match(log, new RegExp(`use=${GLM}`));
  assert.match(log, /reason=off-permission/);
});

test('1. 配置里写的值本来就在权限清单里（含 GLM-5.2-WX 这种分档名）→ 不动，不为没差别的事开菜单', t => {
  // 号只有 GLM 权限、配置里也写着 GLM：CLI 起来就是对的模型
  const same = setup(t, { written: GLM, models: [GLM] });
  same.create({});
  assert.deepEqual(same.picks, [], '不选模型');
  assert.deepEqual(same.create({}).currentModel, { id: '', displayName: 'GLM-5.2 Auto' }, '照旧只写「预计模型」显示名');
  // 配置里写分档名 GLM-5.2-WX：菜单里只能选 -Auto，是同一个模型，不选
  const tier = setup(t, { written: 'GLM-5.2-WX', models: [GLM] });
  tier.create({});
  assert.deepEqual(tier.picks, [], '分档名能归到清单里的 GLM-5.2-WX-Auto，不为它开菜单');
  assert.deepEqual(tier.manager.getAllSessions().map(s => s.currentModel)[0], { id: '', displayName: 'GLM-5.2 Auto' });
  assert.equal(tier.settingsModel(), 'GLM-5.2-WX', '分档名也没被改写');
});

test('1. 清单有多个模型、或清单根本不知道 → 不猜，保持原样（用户自己 /model 切）', t => {
  const many = setup(t, { written: DS, models: [GLM, 'MiniMax-M2.7'] });
  many.create({});
  assert.deepEqual(many.picks, [], '清单有多个模型，不知道这个号该用哪个');
  assert.deepEqual(many.manager.getAllSessions().map(s => s.currentModel)[0], { id: '', displayName: models.PLACEHOLDER_LABEL }, '显示占位');
  const unknown = setup(t, { written: DS, probed: false });
  unknown.create({});
  assert.deepEqual(unknown.picks, [], '清单不知道：不按清单猜');
  // CodeAgent 自己缓存的企业模型清单（.cac.json）也算权威：只有 GLM 时照样选 GLM
  const enterprise = setup(t, { written: DS, probed: false, enterprise: [GLM] });
  enterprise.create({});
  assert.deepEqual(enterprise.picks.map(p => p.modelId), [GLM], '企业清单是唯一的权限依据时也按它选');
});

test('1. 这个号连续 3 次选模型没成功（熔断中）→ 不选，日志写明原因', t => {
  const h = setup(t, { breaker: { failures: 3, lastAt: Date.now(), lastError: '模型命令尚未确认', until: Date.now() + 3600000, since: Date.now() } });
  h.create({});
  assert.deepEqual(h.picks, [], '熔断期间不开菜单');
  assert.match(h.modelLog(), /event=pick-skipped/);
  assert.match(h.modelLog(), /reason=breaker/);
});

test('1. 号池号的手动会话、恢复的会话：这段都不碰', t => {
  const h = setup(t);
  const pooled = h.create({ codeagentAccount: 'pool', codeagentPoolPick: h.poolId });
  assert.deepEqual(h.picks, [], '号池号启动前已按号同步好自己的模型（syncSharedConfig），这里不再选');
  assert.equal(pooled.currentModel.id, '', '号池号照旧只写「预计模型」显示名');
  assert.equal(h.picks.length, 0);
  const resumed = h.create({ resumeCCSessionId: 'ce2b2941-1234-4567-89ab-123456789abc', codeagentActualModel: DS });
  assert.equal(resumed.codeagentActualModel, DS);
  assert.deepEqual(h.picks, [], '恢复的会话按它自己的模型照常起，不「选回」当初的模型');
  assert.equal(resumed.currentModel.id, '');
});

test('3. 启动中心的「默认」项（codeagent:models）：和启动口径一致地给出这个号会用的模型', t => {
  const h = setup(t);
  const handlers = {};
  require('../main/ipc/session-handlers').registerSessionIpc(
    { handle: (name, fn) => { handlers[name] = fn; }, on() {} },
    { sendToRenderer() {}, sessionManager: Object.assign(new EventEmitter(), { codeagentPoolActiveCounts: () => ({}), getAllSessions: () => [], getSession: () => null }) });
  const result = handlers['codeagent:models'](null, { account: 'personal' });
  assert.deepEqual(result.options.map(o => o.id), [GLM], '只列这个号权限内的模型');
  assert.equal(result.defaultModel, GLM, '「默认」那一项写 GLM（启动中心摘要显示它会用的模型），不再是空');
  // 配置里的值能确定时照旧按它（不误报成别的模型）
  setup(t, { written: DS, models: [DS] });
  const result2 = handlers['codeagent:models'](null, { account: 'personal' });
  assert.deepEqual(result2.options.map(o => o.id), [DS]);
  assert.equal(result2.defaultModel, DS);
});