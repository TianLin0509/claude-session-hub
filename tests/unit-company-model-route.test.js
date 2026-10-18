'use strict';
// 家里按模型给公司派活（2026-10-18 田哥：GLM / DeepSeek 分流）：模型表聚合、按模型挑号、号的默认模型切换与换回、
// 家里 ask_company 的 model 参数、MCP 工具描述、公司按模型开会话 / 排队 / 拒绝、追问不换模型、老格式兼容。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const pool = require('../core/codeagent-pool');
const probe = require('../core/codeagent-model-probe');
const route = require('../core/codeagent-model-route');
const { rig, pair } = require('./helpers/company-bridge-rig');

const GLM = 'GLM-5.2-WX-Auto', DS = 'deepseek-v4-0731';
const MIN = 60000;
function tmp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-route-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
function login(dir, accountId) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'x', accountId, expiresAt: Date.now() + 72 * 3600000 } }));
}
const settingsModel = dir => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).model; } catch { return undefined; } };

// 磁盘上的一套号：个人账号（GLM）、号池里一个 DS 号、一个和个人同号的、一个重复的、一个 GLM+DS 两个模型的。
function diskAccounts(t) {
  const dataDir = tmp(t), personalDir = path.join(dataDir, 'personal-cac');
  login(personalDir, 'w00111111');
  fs.writeFileSync(path.join(personalDir, 'settings.json'), JSON.stringify({ model: GLM }));
  probe.writeProbed(pool.personalModelsFile(dataDir), { models: [GLM], defaultModel: GLM });
  const add = (note, accountId, models, defaultModel = models[0]) => {
    const id = pool.addAccount(dataDir, { note });
    const dir = pool.accountDir(dataDir, id);
    login(dir, accountId);
    probe.writeProbed(path.join(dir, probe.MODELS_FILE), { models, defaultModel });
    return { id, dir };
  };
  const ds = add('同事张三', 'w00222222', [DS]);
  const same = add('我自己', 'w00111111', [GLM]);
  const dup = add('张三重复', 'w00222222', [DS]);
  const both = add('李四', 'w00333333', [GLM, DS], GLM);
  return { dataDir, personalDir, ds, same, dup, both };
}

test('模型表：个人 + 号池按模型聚合；和个人同号、重复的号不算；不含账号名、工号、备注', t => {
  const d = diskAccounts(t);
  const accounts = route.routeAccounts({ dataDir: d.dataDir, personalDir: d.personalDir, activeCounts: {}, personalActive: 1 });
  assert.deepEqual(accounts.map(a => a.key).sort(), ['personal', d.ds.id, d.both.id].sort());
  assert.equal(accounts.find(a => a.key === 'personal').defaultModel, GLM);
  assert.equal(accounts.find(a => a.key === d.both.id).defaultModel, GLM);
  const table = route.modelTable(accounts, { working: { personal: 1 }, cap: 3, peak: true, parallel: { cap: 5, working: 1 }, at: 1 });
  // GLM：个人（在处理 1 个，还能 2 个）+ 李四的号（默认 GLM、空闲，3 个）= 5；DS：张三的号 3 + 李四的号（空闲，可以切过来）3 = 6；
  // 通道整体上限 5、在处理 1，还能 4 个，取小。
  assert.deepEqual(table.models.map(m => [m.id, m.primary, m.accounts, m.working, m.free]), [[GLM, true, 2, 1, 4], [DS, false, 2, 0, 4]]);
  assert.equal(table.peak, true);
  const text = JSON.stringify(table);
  for (const secret of ['w00', '张三', '李四', '我自己', 'personal', d.ds.id, d.both.id]) assert.ok(!text.includes(secret), '模型表不含 ' + secret);
  // 只用号池关掉时只剩个人账号
  assert.deepEqual(route.routeAccounts({ dataDir: d.dataDir, personalDir: d.personalDir, usePool: false }).map(a => a.key), ['personal']);
});

test('挑号：GLM 只挑有 GLM 的号、DS 只挑有 DS 的号；没有的报 none；号上在跑别的模型就等；到每号上限就等；同等时号池优先', () => {
  const a = (key, models, defaultModel, extra = {}) => ({ key, pool: key !== 'personal', models, defaultModel, activeSessions: 0, lastAssignedAt: 0, ...extra });
  const accounts = [a('personal', [GLM], GLM, { activeSessions: 2 }), a('ds', [DS], DS, { activeSessions: 1 })];
  let p = route.pickRoute(accounts, 'DEEPSEEK-V4-0731');
  assert.equal(p.ok, true); assert.equal(p.account.key, 'ds'); assert.equal(p.model, DS, '按清单里的写法'); assert.equal(p.switchModel, false);
  p = route.pickRoute(accounts, GLM);
  assert.equal(p.account.key, 'personal');
  assert.deepEqual(route.pickRoute(accounts, 'MiniMax-M2.7'), { ok: false, reason: 'none', model: '' });
  // 每号上限：DS 号已有 3 个在处理
  assert.equal(route.pickRoute(accounts, DS, { working: { ds: 3 }, cap: 3 }).reason, 'busy');
  // 个人账号默认 GLM、也有 DS 权限：不切个人账号的默认模型——DS 对它算「不能派」，直接 none（不会永远排队），模型表也不列
  const personalBoth = [a('personal', [GLM, DS], GLM)];
  assert.equal(route.pickRoute(personalBoth, DS).reason, 'none');
  assert.deepEqual(route.modelTable(personalBoth, { cap: 3 }).models.map(m => m.id), [GLM]);
  assert.deepEqual(route.servableNow([a('both', [GLM, DS], GLM, { activeSessions: 1 })]), [GLM], '号池号有会话时只有它的默认模型能直接用');
  // 号池里两个模型都有的号：空闲时可以切；手上有会话、默认又不是它时等
  assert.equal(route.pickRoute([a('both', [GLM, DS], GLM)], DS).switchModel, true);
  assert.equal(route.pickRoute([a('both', [GLM, DS], GLM, { activeSessions: 1 })], DS).reason, 'switch');
  // 会话数相同：号池优先于个人账号；不用切的优先于要切的
  assert.equal(route.pickRoute([a('personal', [GLM], GLM), a('p1', [GLM], GLM)], GLM).account.key, 'p1');
  assert.equal(route.pickRoute([a('both', [GLM, DS], GLM), a('ds', [DS], DS)], DS).account.key, 'ds');
});

test('号的默认模型：指定模型时切过去并记下原值；之后不指定、号上没有会话时换回；有会话时不动', t => {
  const personal = tmp(t), target = tmp(t);
  fs.writeFileSync(path.join(personal, 'settings.json'), JSON.stringify({ model: GLM, permissions: { allow: ['Read'] } }));
  probe.writeProbed(path.join(target, probe.MODELS_FILE), { models: [GLM, DS], defaultModel: GLM });
  assert.equal(pool.syncSharedConfig(personal, target).model, GLM);
  assert.equal(pool.syncSharedConfig(personal, target, undefined, { routeModel: 'DeepSeek-V4-0731' }).model, DS);
  assert.equal(settingsModel(target), DS);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, pool.ROUTE_MARKER), 'utf8')).original, GLM);
  assert.equal(pool.effectiveModel(target), DS);
  // 再指定一次同一模型：不覆盖记下的原值
  pool.syncSharedConfig(personal, target, undefined, { routeModel: DS });
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, pool.ROUTE_MARKER), 'utf8')).original, GLM);
  // 不指定、号上还有会话：保持
  pool.syncSharedConfig(personal, target, undefined, { idle: false });
  assert.equal(settingsModel(target), DS);
  // 不指定、号空闲：换回
  pool.syncSharedConfig(personal, target, undefined, { idle: true });
  assert.equal(settingsModel(target), GLM);
  assert.equal(fs.existsSync(path.join(target, pool.ROUTE_MARKER)), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, 'settings.json'), 'utf8')).permissions, { allow: ['Read'] }, '其余设置照旧同步');
});

test('启动会话：通道指定模型时号池按指定号写默认模型，不传 --model、不走菜单；号上在跑别的模型就拒绝；个人账号默认不是它就拒绝', t => {
  const d = diskAccounts(t);
  const old = { data: process.env.CLAUDE_HUB_DATA_DIR, cfg: process.env.AI_HUB_CODEAGENT_CONFIG_DIR };
  process.env.CLAUDE_HUB_DATA_DIR = d.dataDir; process.env.AI_HUB_CODEAGENT_CONFIG_DIR = d.personalDir;
  t.after(() => { for (const [k, v] of [['CLAUDE_HUB_DATA_DIR', old.data], ['AI_HUB_CODEAGENT_CONFIG_DIR', old.cfg]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const { SessionManager } = require('../core/session-manager');
  const sm = Object.create(SessionManager.prototype);
  sm.sessions = new Map();
  const config = require('../core/codeagent-config').resolveCodeAgentConfig(process.env);
  const cwd = tmp(t);
  const picked = sm._resolveCodeAgentPool({ purpose: 'company-bridge', codeagentAccount: 'pool', codeagentPoolPick: d.both.id, codeagentRouteModel: DS, cwd }, config);
  assert.equal(picked.account.id, d.both.id);
  assert.equal(settingsModel(d.both.dir), DS, '号的默认模型切到 DS');
  // 别的用途（普通会话）不认 codeagentRouteModel
  sm._resolveCodeAgentPool({ purpose: 'chat', codeagentAccount: 'pool', codeagentPoolPick: d.ds.id, codeagentRouteModel: GLM, cwd }, config);
  assert.equal(settingsModel(d.ds.dir), DS);
  // 号上有进行中的会话（在跑 DS）时，GLM 不能切过去
  sm.sessions.set('s1', { info: { codeagentPoolAccount: d.both.id, status: 'idle' } });
  assert.throws(() => sm._resolveCodeAgentPool({ purpose: 'company-bridge', codeagentAccount: 'pool', codeagentPoolPick: d.both.id, codeagentRouteModel: GLM, cwd }, config), /正在用 deepseek-v4-0731 跑会话，不能切到 GLM/);
  assert.throws(() => sm._resolveCodeAgentPool({ purpose: 'company-bridge', codeagentAccount: 'pool', codeagentPoolPick: d.ds.id, codeagentRouteModel: GLM, cwd }, config), /没有 GLM-5\.2-WX-Auto 的权限/);
  // 不传 --model，也不打开 /model 菜单（通道会话）
  const priv = require('../core/session-manager')._private;
  const bridgeOpts = { purpose: 'company-bridge', model: DS, codeagentModelPick: true, codeagentRouteModel: DS };
  assert.equal(priv.shouldPickCodeAgentModel(bridgeOpts), false);
  assert.equal(priv.codeAgentRouteModel(bridgeOpts), DS);
  assert.equal(priv.codeAgentRouteModel({ ...bridgeOpts, purpose: 'chat' }), '', '只认通道会话');
  const launch = priv.buildCodeAgentPtyLaunch('s-x', 'codeagent', { ...bridgeOpts, model: undefined }, cwd, process.env, { ...config, configDir: d.both.dir });
  assert.doesNotMatch(launch.cmd, /--model/);
  // 个人账号：默认 GLM，指定 DS 拒绝（真的 _createSession 在开 PTY 之前就报错）
  const real = new SessionManager();
  t.after(() => real.dispose());
  assert.throws(() => real._createSession('codeagent', { purpose: 'company-bridge', codeagentRouteModel: DS, cwd }), /个人账号没有 deepseek-v4-0731 的权限/);
  probe.writeProbed(pool.personalModelsFile(d.dataDir), { models: [GLM, DS], defaultModel: GLM });
  assert.throws(() => real._createSession('codeagent', { purpose: 'company-bridge', codeagentRouteModel: DS, cwd }), /个人账号此刻的默认模型是 GLM-5\.2-WX-Auto，通道不改个人账号的默认模型/);
  assert.equal(settingsModel(d.personalDir), GLM, '个人账号配置没被改');
});

// ---- 两端（内存通道） ----
// 公司有两个号：个人账号只有 GLM，号池里 ds01 只有 DS（田哥说的「我自己的和同事的」）。
function setup(t, { accounts = null, poolLanes = 1 } = {}) {
  const box = { active: {}, accounts };
  const fake = (key, models, defaultModel) => ({ key, pool: key !== 'personal', models, defaultModel, activeSessions: box.active[key] || 0, lastAssignedAt: 0 });
  const list = ({ usePool = true } = {}) => (box.accounts ? box.accounts() : [fake('personal', [GLM], GLM), fake('ds01', [DS], DS)]).filter(a => usePool || !a.pool);
  const r = rig(t, { companyDeps: { routeAccounts: list, poolLanes: () => poolLanes } });
  const create = r.company.deps.createSession;
  r.company.deps.createSession = async (kind, opts) => { const x = await create(kind, opts); if (opts.codeagentPoolPick) x.codeagentPoolAccount = opts.codeagentPoolPick; return x; };
  r.hs.map.set('home-s', { id: 'home-s', kind: 'claude', status: 'idle' });
  return Object.assign(r, { box, fake });
}
const created = r => r.cs.created.map(c => c.opts);

test('模型表：配对后公司推一次，家里存下并写文件；MCP 工具描述带模型表和主力标记，未知时有提示；工具返回也带', async t => {
  const r = setup(t); await pair(r);
  await r.company.checkNow(); await r.home.checkNow();
  const entry = r.home.companyModels();
  assert.deepEqual(entry.table.models.map(m => [m.id, m.primary]), [[GLM, true], [DS, false]]);
  const file = path.join(r.home.dir, 'company-models.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).table.models.map(m => m.id), [GLM, DS]);
  const { listTools } = require('../scripts/company-bridge-mcp');
  const ask = listTools({ HUB_BRIDGE_ENDPOINT_FILE: r.home.endpointFile }).find(x => x.name === 'ask_company');
  assert.match(ask.description, /发问前先看公司模型表/);
  assert.match(ask.description, new RegExp(`- ${GLM}（日常主力）：1 个号能用`));
  assert.match(ask.description, new RegExp(`- ${DS}：1 个号能用，通道在处理 0 个，还能并行`));
  assert.match(ask.description, /简单查询、定位、只读一两个文件 → 非主力或空闲的模型/);
  assert.ok(ask.inputSchema.properties.model);
  const unknown = listTools({}).find(x => x.name === 'ask_company');
  assert.match(unknown.description, /模型表未知/);
  // 没变化不重推；变了但不到 10 分钟也不推；过了 10 分钟再推
  const posts = () => r.relay.posts;
  let before = posts();
  await r.company.checkNow();
  assert.equal(posts(), before, '没变化不推');
  r.box.accounts = () => [r.fake('personal', [GLM], GLM)];
  r.clock.now += 60000; before = posts(); await r.company.checkNow();
  assert.equal(posts(), before, '不到 10 分钟不推');
  r.clock.now += 10 * MIN; await r.company.checkNow(); await r.home.checkNow();
  assert.deepEqual(r.home.companyModels().table.models.map(m => m.id), [GLM]);
  const view = r.home.view('home-s', {});
  assert.match(view.companyModels, /GLM-5\.2-WX-Auto（日常主力）/);
});

test('家里指定 DS → 公司在 DS 号开会话（号池、按模型）；指定 GLM → 个人账号；回执带模型，家里提示里写明；追问沿用原会话', async t => {
  const r = setup(t); await pair(r); await r.company.checkNow(); await r.home.checkNow();
  const res = await r.home.invoke({ name: 'ask_company', callerSessionId: 'home-s', arguments: { question: '帮我查一下 AirView 里 RSRP 统计的入口文件', model: 'DEEPSEEK-V4-0731' } });
  assert.equal(res.model, DS, '按模型表的写法');
  await r.company.checkNow(); await r.company.checkNow();
  assert.equal(created(r).length, 1);
  assert.equal(created(r)[0].codeagentRouteModel, DS);
  assert.equal(created(r)[0].codeagentAccount, 'pool');
  assert.equal(created(r)[0].codeagentPoolPick, 'ds01');
  assert.match(created(r)[0].title, /^\d{4}-Q\d+-claude$/, '会话名保持 MMDD-Qn-家里AI');
  assert.equal(r.company.thread(res.thread).model, DS);
  const sid = created(r)[0].id;
  Object.assign(r.cs.map.get(sid), { currentModel: { id: DS }, codeagentActualModel: DS });
  r.cs.answer(sid, '入口在 stats/rsrp.cpp 的 collect()。');
  r.clock.now += 20000; await r.company.checkNow(); await r.home.checkNow();
  const round = r.home.thread(res.thread).rounds[0];
  assert.equal(round.meta.model, DS); assert.equal(round.meta.requestedModel, DS); assert.equal(round.meta.actualModel, DS);
  const { replyMessage } = require('../core/company-bridge/home');
  assert.match(replyMessage(r.home.thread(res.thread), round), /不含源码；公司模型 deepseek-v4-0731/);
  // 指定的和实际不是同一家：明说
  assert.match(replyMessage({ ...r.home.thread(res.thread) }, { ...round, meta: { ...round.meta, actualModel: GLM } }), /指定的模型是 deepseek-v4-0731，回答里实际出现的是 GLM-5\.2-WX-Auto/);
  // 线程摘要在回执前就显示指定的模型
  const view = require('../core/bridge-thread-view');
  assert.equal(view.answerSummary({ ...r.company.thread(res.thread), rounds: [{ round: 1, receivedAt: 1 }] }).model, DS);
  // 追问：同一会话，不新开、不换号
  await r.home.invoke({ name: 'followup_company', callerSessionId: 'home-s', arguments: { thread: res.thread, question: '再看一下 collect 的调用方' } });
  await r.company.checkNow(); await r.company.checkNow();
  assert.equal(created(r).length, 1, '追问不新开会话');
  assert.equal(r.cs.sentTo(sid).length, 2);
  // 追问时原会话已休眠：按编号恢复（恢复时沿用 codeagentRouteModel 由 resume-session-handlers 传给 session-manager）
  r.cs.answer(sid, '调用方是 report()。');
  r.clock.now += 20000; await r.company.checkNow(); await r.home.checkNow();
  r.cs.stored.set(sid, { ...r.cs.map.get(sid), status: 'dormant', codeagentRouteModel: DS }); r.cs.map.delete(sid);
  await r.home.invoke({ name: 'followup_company', callerSessionId: 'home-s', arguments: { thread: res.thread, question: '第三轮：report 的输出格式' } });
  await r.company.checkNow(); await r.company.checkNow();
  assert.deepEqual(r.cs.resumed, [sid]); assert.equal(created(r).length, 1);
  // 指定 GLM：个人账号（不带号池参数）
  const glm = await r.home.invoke({ name: 'ask_company', callerSessionId: 'home-s', arguments: { question: '核对一下 L2 调度器的 PF 权重更新公式', model: GLM } });
  await r.company.checkNow(); await r.company.checkNow();
  const o = created(r).find(x => x.codeagentRouteModel === GLM);
  assert.ok(o, glm.thread); assert.equal(o.codeagentAccount, undefined); assert.equal(o.codeagentPoolPick, undefined);
});

test('不认识的模型：家里有模型表时直接报错并列出可选项；家里没有模型表时公司不开会话、回执写明原因和可选模型（并带回模型表）', async t => {
  const r = setup(t); await pair(r);
  // 家里还没收到模型表（例如刚升级）：照发，由公司核对
  r.home.store.set('companyModels', null);
  const sent = await r.home.invoke({ name: 'ask_company', callerSessionId: 'home-s', arguments: { question: '帮我查一下 HARQ 合并逻辑在哪里', model: 'MiniMax-M2.7' } });
  await assert.rejects(r.home.invoke({ name: 'ask_company', callerSessionId: 'home-s', arguments: { question: '帮我查一下 HARQ 合并逻辑在哪里', model: 'bad model!' } }), /模型名格式不对/);
  await r.company.checkNow(); await r.company.checkNow(); await r.home.checkNow();
  assert.equal(created(r).length, 0, '不开会话');
  const err = r.home.thread(sent.thread).rounds[0].error;
  assert.match(err, /指定的模型 MiniMax-M2\.7 在公司这边没有可用的号（可选：GLM-5\.2-WX-Auto、deepseek-v4-0731）；没有开会话/);
  assert.equal(r.company.thread(sent.thread).state, 'failed');
  assert.ok(r.home.companyModels(), '报错时带回了模型表');
  // 现在家里有模型表了：写错直接报错并列出可选项，不发出
  const before = r.relay.posts;
  await assert.rejects(r.home.invoke({ name: 'ask_company', callerSessionId: 'home-s', arguments: { question: '帮我查一下 HARQ 合并逻辑在哪里', model: 'MiniMax-M2.7' } }),
    /公司模型表里没有「MiniMax-M2\.7」。可选：GLM-5\.2-WX-Auto、deepseek-v4-0731/);
  assert.equal(r.relay.posts, before);
});

test('不指定模型：与以前完全相同（号池开、不带模型参数、回执没有指定模型字段）', async t => {
  const r = setup(t); await pair(r);
  const { thread } = await r.home.ask('home-s', { question: '请帮我看一下公司 L2 的 HARQ 合并逻辑' });
  await r.company.checkNow(); await r.company.checkNow();
  const o = created(r)[0];
  assert.equal(o.codeagentAccount, 'pool');
  assert.equal('codeagentRouteModel' in o, false);
  assert.equal('codeagentPoolPick' in o, false);
  assert.equal(r.company.thread(thread).model, undefined);
  r.cs.answer(o.id, 'Chase 合并。'); r.clock.now += 20000;
  await r.company.checkNow(); await r.home.checkNow();
  const meta = r.home.thread(thread).rounds[0].meta;
  assert.equal('requestedModel' in meta, false); assert.equal('actualModel' in meta, false);
  // 老格式的家里消息（没有 model 字段）同样走这里；号池没有可用号时照旧用个人账号
  const r2 = setup(t, { poolLanes: 0 }); await pair(r2);
  await r2.home.ask('home-s', { question: '请帮我看一下公司 L2 的 HARQ 合并逻辑' });
  await r2.company.checkNow(); await r2.company.checkNow();
  assert.equal(created(r2)[0].codeagentAccount, undefined);
});

test('排队按模型：DS 号到了每号上限时 DS 的问题等它空出来，GLM 的问题照常派', async t => {
  const r = setup(t); await pair(r);
  r.company.setSettings({ perAccountPeak: 1, perAccountIdle: 1, maxParallel: 4, maxParallelIdle: 4 });
  const ask = (q, model) => r.home.invoke({ name: 'ask_company', callerSessionId: 'home-s', arguments: { question: q, ...(model ? { model } : {}) } });
  const a = await ask('第一个 DS 问题：AirView 里 SINR 统计的入口', DS);
  await r.company.checkNow(); await r.company.checkNow();
  const sidA = created(r)[0].id; r.cs.busy.add(sidA); r.box.active.ds01 = 1;
  const b = await ask('第二个 DS 问题：AirView 里 RSRP 统计的入口', DS);
  const c = await ask('一个 GLM 问题：L2 调度器的 PF 权重怎么更新', GLM);
  await r.company.checkNow(); await r.company.checkNow(); await r.home.checkNow();
  assert.equal(created(r).length, 2, 'GLM 的派了，DS 的第二个在等');
  assert.equal(created(r)[1].codeagentRouteModel, GLM);
  assert.equal(r.company.thread(b.thread).state, 'queued');
  assert.match(r.home.thread(b.thread).rounds[0].note, /排队：等 deepseek-v4-0731 的号空出来（有它权限的号都在处理 1 个问题）/);
  // DS 号答完、空出来：第二个 DS 问题派出去
  r.cs.busy.delete(sidA); r.cs.answer(sidA, '入口在 sinr.cpp。'); r.clock.now += 4 * MIN;
  await r.company.checkNow(); await r.company.checkNow();
  assert.equal(created(r).length, 3);
  assert.equal(created(r)[2].codeagentRouteModel, DS); assert.equal(created(r)[2].codeagentPoolPick, 'ds01');
  assert.ok(a && c);
});

// 版本兼容：新家里（带 model）发给老公司（9a7b4082 的 company.js，不认 model）→ 忽略、照旧默认开会话、回执照常。
test('老公司收到带 model 的问题：忽略该字段，照旧用默认模型作答', async t => {
  const src = spawnSync('git', ['show', '9a7b4082:core/company-bridge/company.js'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  if (src.status !== 0 || !src.stdout) { t.skip('没有 git 历史，跳过'); return; }
  const Module = require('node:module');
  const file = path.join(__dirname, '..', 'core', 'company-bridge', 'company-9a7b4082.js');
  const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(src.stdout, file);
  const OldCompany = m.exports.CompanyBridge;
  const r = setup(t);
  const deps = r.company.deps;
  r.company.close();
  r.company = new OldCompany({ ...deps });
  await pair(r);
  const res = await r.home.invoke({ name: 'ask_company', callerSessionId: 'home-s', arguments: { question: '帮我查一下 AirView 里 RSRP 统计的入口文件', model: DS } });
  await r.company.checkNow(); await r.company.checkNow();
  assert.equal(created(r).length, 1);
  assert.equal('codeagentRouteModel' in created(r)[0], false, '老公司不知道 model');
  r.cs.answer(created(r)[0].id, '入口在 stats/rsrp.cpp。'); r.clock.now += 20000;
  await r.company.checkNow(); await r.home.checkNow();
  assert.match(r.home.thread(res.thread).rounds[0].reply, /rsrp\.cpp/);
  r.company.close();
});

// ---- 2026-10-18 独立审核的修正 ----
test('隐私：开会话 / 恢复失败时发回家里的报错不含工号掩码、号主备注、号池编号（公司一端统一脱敏）', async t => {
  const r = setup(t); await pair(r); await r.company.checkNow(); await r.home.checkNow();
  r.company.deps.accountSecrets = () => ['w001****11', 'z002****22', '同事张三', 'ds01ab23cd', 'z002****22（同事张三）'];
  r.company.deps.createSession = async () => { throw new Error('号池账号 z002****22（同事张三） 需要号主重新登录，未启动会话；编号 ds01ab23cd'); };
  const res = await r.home.invoke({ name: 'ask_company', callerSessionId: 'home-s', arguments: { question: '帮我查一下 AirView 里 RSRP 统计的入口文件', model: DS } });
  await r.company.checkNow(); await r.company.checkNow(); await r.home.checkNow();
  const err = r.home.thread(res.thread).rounds[0].error;
  assert.match(err, /公司这边没能开始：号池里的一个号 需要号主重新登录/);
  for (const secret of ['z002', '****', '同事张三', 'ds01ab23cd', 'w001']) assert.ok(!err.includes(secret), '回家里的报错不含 ' + secret + '：' + err);
  // 没有登记清单时也按掩码样式换掉
  r.company.deps.accountSecrets = () => [];
  assert.equal(r.company.scrubText('号池账号 w001****11 需要重新登录'), '号池里的一个号 需要重新登录');
});

test('隐私：session-manager 给通道会话的号池报错不带号的显示名（本机日志里才写明）', t => {
  const d = diskAccounts(t);
  const old = process.env.CLAUDE_HUB_DATA_DIR; process.env.CLAUDE_HUB_DATA_DIR = d.dataDir;
  t.after(() => { if (old === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = old; });
  const { SessionManager } = require('../core/session-manager');
  const sm = Object.create(SessionManager.prototype); sm.sessions = new Map();
  const config = { configDir: d.personalDir };
  const warn = console.warn; const logs = []; console.warn = (...a) => logs.push(a.join(' ')); t.after(() => { console.warn = warn; });
  const cwd = tmp(t);
  let msg = '';
  try { sm._resolveCodeAgentPool({ purpose: 'company-bridge', codeagentAccount: 'pool', codeagentPoolPick: d.ds.id, codeagentRouteModel: GLM, cwd }, config); } catch (e) { msg = e.message; }
  assert.match(msg, /^号池里的一个号 没有 GLM-5\.2-WX-Auto 的权限/);
  assert.ok(!/w002|同事张三/.test(msg));
  assert.ok(logs.some(l => /同事张三/.test(l)), '本机日志里写明是哪个号');
  // 普通会话（本机界面）照旧写明
  fs.rmSync(path.join(d.ds.dir, '.credentials.json'));
  assert.throws(() => sm._resolveCodeAgentPool({ codeagentAccount: 'pool', codeagentPoolPick: d.ds.id, cwd }, config), /号池账号 未登录（同事张三） 需要号主重新登录/);
});

test('指定模型等切换最多 10 分钟：号池号一直有会话就不再排队，回执写原因和现在可直接用的模型', async t => {
  const r = setup(t, { accounts: () => [r.fake('both', [GLM, DS], GLM)] });
  r.box.active.both = 1;
  await pair(r);
  const res = await r.home.invoke({ name: 'ask_company', callerSessionId: 'home-s', arguments: { question: '帮我查一下 AirView 里 RSRP 统计的入口文件', model: DS } });
  await r.company.checkNow(); await r.company.checkNow(); await r.home.checkNow();
  assert.equal(r.company.thread(res.thread).state, 'queued');
  assert.match(r.home.thread(res.thread).rounds[0].note, /排队：等 deepseek-v4-0731 的号空出来（有它权限的号正在处理其他会话，空出来后切换）/);
  r.clock.now += 9 * MIN; await r.company.checkNow();
  assert.equal(r.company.thread(res.thread).state, 'queued', '10 分钟内继续等');
  r.clock.now += 2 * MIN; await r.company.checkNow(); await r.home.checkNow();
  assert.equal(created(r).length, 0);
  assert.match(r.home.thread(res.thread).rounds[0].error, /有它权限的号这段时间都在处理其他会话，等了 10 分钟没能空出来切换；没有开会话。现在可直接用的模型：GLM-5\.2-WX-Auto/);
});

test('不指定模型：避开为通道切过模型且还有会话的号；只剩它时照用，回执写明实际模型', async t => {
  const acct = (id, extra) => ({ id, state: 'ready', models: [GLM, DS], modelsAuthoritative: true, activeSessions: 0, lastAssignedAt: 0, sameAsPersonal: false, duplicateOf: null, routeSwitched: false, ...extra });
  assert.equal(pool.pickAccount([acct('switched', { routeSwitched: true, activeSessions: 1, lastAssignedAt: 0 }), acct('plain', { activeSessions: 2, lastAssignedAt: 5 })]).id, 'plain');
  assert.equal(pool.pickAccount([acct('switched', { routeSwitched: true, activeSessions: 1 })]).id, 'switched', '只剩它时照用');
  assert.equal(pool.pickAccount([acct('switched', { routeSwitched: true, activeSessions: 0 }), acct('plain', { activeSessions: 1 })]).id, 'switched', '空闲的会先换回原模型，照常优先');
  // 号目录里有切换标记时 listAccounts 标出来
  const d = diskAccounts(t);
  pool.syncSharedConfig(d.personalDir, d.both.dir, undefined, { routeModel: DS });
  assert.equal(pool.listAccounts(d.dataDir).find(a => a.id === d.both.id).routeSwitched, true);
  // 回执：会话记着 codeagentLaunchModel 时写实际模型
  const r = setup(t); await pair(r);
  const { thread } = await r.home.ask('home-s', { question: '请帮我看一下公司 L2 的 HARQ 合并逻辑' });
  await r.company.checkNow(); await r.company.checkNow();
  const sid = created(r)[0].id;
  r.cs.map.get(sid).codeagentLaunchModel = DS;
  r.cs.answer(sid, 'Chase 合并。'); r.clock.now += 20000;
  await r.company.checkNow(); await r.home.checkNow();
  const round = r.home.thread(thread).rounds[0];
  assert.equal(round.meta.actualModel, DS); assert.equal('requestedModel' in round.meta, false);
  const { replyMessage } = require('../core/company-bridge/home');
  assert.match(replyMessage(r.home.thread(thread), round), /公司模型 deepseek-v4-0731/);
});

test('家里提示：模型表未知时指定模型会提醒可能不生效；回执没确认实际模型 / 公司是旧版时如实写', async t => {
  const r = setup(t); await pair(r);
  r.home.store.set('companyModels', null);
  const res = await r.home.invoke({ name: 'ask_company', callerSessionId: 'home-s', arguments: { question: '帮我查一下 AirView 里 RSRP 统计的入口文件', model: DS } });
  assert.match(res.modelNote, /公司模型表未知（公司 Hub 可能是旧版），指定的模型可能不生效/);
  const { replyMessage } = require('../core/company-bridge/home');
  const t0 = { id: 'Q-1018-09', model: DS };
  assert.match(replyMessage(t0, { round: 1, reply: 'x', meta: { model: GLM } }), /指定了模型 deepseek-v4-0731，但公司 Hub 没有确认按它作答（可能是旧版，不认指定模型），公司会话模型 GLM-5\.2-WX-Auto/);
  assert.match(replyMessage(t0, { round: 1, reply: 'x', meta: { model: DS, requestedModel: DS, actualModel: null } }), /指定模型 deepseek-v4-0731，未从回答里确认实际模型/);
  assert.match(replyMessage({ id: 'Q-1', model: null }, { round: 1, reply: 'x', meta: { model: GLM } }), /公司模型 GLM-5\.2-WX-Auto）/);
});

test('等切模型时：号上只剩答完保温的通道会话就先让它休眠，号空出来后切过去开会话；人自己的会话、在干活的不动', async t => {
  const r = setup(t, { accounts: null });
  r.box.accounts = () => [r.fake('both', [GLM, DS], GLM)];
  r.box.active.both = 1;
  const suspended = [];
  Object.assign(r.company.deps, {
    listSessionIds: () => [...r.cs.map.keys()],
    suspendSession: (id) => { suspended.push(id); const s = r.cs.map.get(id); if (s) s.status = 'dormant'; r.box.active.both = 0; return { ok: true }; },
  });
  await pair(r);
  // 号上一个人自己开的会话（不是通道的）：不休眠，只能等
  r.cs.map.set('mine', { id: 'mine', kind: 'codeagent', status: 'idle', codeagentPoolAccount: 'both' });
  const res = await r.home.invoke({ name: 'ask_company', callerSessionId: 'home-s', arguments: { question: '帮我查一下 AirView 里 RSRP 统计的入口文件', model: DS } });
  await r.company.checkNow(); await r.company.checkNow();
  assert.deepEqual(suspended, []); assert.equal(created(r).length, 0);
  // 换成一个答完保温的通道会话
  r.cs.map.delete('mine');
  r.cs.map.set('warm', { id: 'warm', kind: 'codeagent', status: 'idle', codeagentPoolAccount: 'both' });
  r.company.saveThread({ id: 'Q-1018-90', gen: r.company.link.gen(), title: '旧题', sessionId: 'warm', createdAt: r.clock.now, rounds: [{ round: 1, question: 'q', receivedAt: r.clock.now, sentAt: r.clock.now, reply: 'a', replyAt: r.clock.now }] });
  r.clock.now += MIN + 1000; await r.company.checkNow();
  assert.deepEqual(suspended, ['warm'], '保温的通道会话先休眠');
  await r.company.checkNow();
  assert.equal(created(r).length, 1, '号空出来后切到 DS 开会话');
  assert.equal(created(r)[0].codeagentRouteModel, DS); assert.equal(created(r)[0].codeagentPoolPick, 'both');
  assert.ok(res.thread);
});
