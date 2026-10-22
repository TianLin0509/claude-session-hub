'use strict';
// 模型「权限兜底」（2026-10-22 公司真机 v3.1.1 的根因）：
// 号池号导入时会把源 .cac 目录 settings 的 model 抄进新号，公司那个目录常年写着 GLM-5.2-WX-Auto，
// 只有 DeepSeek 权限的号因此每轮通道会话都去请求 GLM → 后端报「模型不存在或配置有误」→ 记成模型配置避让，
// 这种避让不自动到期（6 小时才放行一次试探），看起来就是「一直避让」。
// 覆盖：
//   A 启动前：permissionSafeModel / syncSharedConfig 把号写的、不在清单里的模型换成清单里唯一的那个；
//   A 导入时：importLocal 抄来的模型同样按清单纠正；
//   B 报错后：quota-watch 当场把号池号的配置改对，并且不记「一直避让」（同一个号同一个模型 6 小时内只修一次）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pool = require('../core/codeagent-pool');
const probe = require('../core/codeagent-model-probe');
const Q = require('../core/codeagent-quota');
const { rig } = require('./helpers/company-bridge-rig');

const GLM = 'GLM-5.2-WX-Auto', DS = 'deepseek-v4-flash-0731', DS_LABEL = 'DeepSeek-V4-Flash-0731';
const HOUR = 3600000;
const SAMPLE = 'API Error: 模型 "GLM-5.2-WX-Auto" 不存在或配置有误，请检查模型配置';

function tmp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-modelfix-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
function creds(dir, accountId) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: { accountId, expiresAt: 4_000_000_000_000 } }));
}
const modelOf = dir => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).model;

test('A：号写的模型不在权限清单里、清单只有一个模型时换成它；清单多个、清单不权威、本来就在清单里都不动', () => {
  const authoritative = models => ({ models, authoritative: true });
  assert.deepEqual(pool.permissionSafeModel(GLM, authoritative([DS])), { changed: true, model: DS, from: GLM });
  assert.deepEqual(pool.permissionSafeModel(DS, authoritative([DS])), { changed: false, model: DS }, '本来就在清单里：不动');
  assert.deepEqual(pool.permissionSafeModel(GLM, authoritative([GLM, DS])), { changed: false, model: GLM }, '清单有两个模型：不知道该用哪个，不动');
  assert.deepEqual(pool.permissionSafeModel(GLM, { models: [DS], authoritative: false }), { changed: false, model: GLM }, '清单不权威：不动');
  assert.deepEqual(pool.permissionSafeModel('', authoritative([DS])), { changed: false, model: '' }, '号没写模型：不动');
});

test('A：启动前同步配置时把号写的 GLM 改成权限里的 DeepSeek，并回报 modelFix；清单有多个模型时只报告不改', t => {
  const personal = tmp(t), poolDir = tmp(t);
  fs.writeFileSync(path.join(personal, 'settings.json'), JSON.stringify({ theme: 'dark' }, null, 2));
  fs.writeFileSync(path.join(poolDir, 'settings.json'), JSON.stringify({ model: GLM, theme: 'dark' }, null, 2));
  probe.writeProbed(path.join(poolDir, probe.MODELS_FILE), { models: [DS_LABEL], defaultModel: DS_LABEL });
  const r = pool.syncSharedConfig(personal, poolDir, undefined, { routeSwitch: false, idle: true });
  assert.deepEqual(r.modelFix, { from: GLM, to: DS_LABEL });
  assert.equal(r.model, DS_LABEL);
  assert.equal(modelOf(poolDir), DS_LABEL, '写进配置的就是权限内的模型');
  assert.equal(JSON.parse(fs.readFileSync(path.join(poolDir, 'settings.json'), 'utf8')).theme, 'dark', '其余键原样保留');

  const multi = tmp(t);
  fs.writeFileSync(path.join(multi, 'settings.json'), JSON.stringify({ model: GLM }, null, 2));
  probe.writeProbed(path.join(multi, probe.MODELS_FILE), { models: [GLM, DS_LABEL], defaultModel: '' });
  const r2 = pool.syncSharedConfig(personal, multi, undefined, { routeSwitch: false, idle: true });
  assert.equal(r2.modelFix, null, '清单有多个模型：不擅自改');
  assert.equal(modelOf(multi), GLM);
});

test('A：导入号池时抄来的模型也按权限清单纠正（不再把源目录的 GLM 抄进只有 DeepSeek 权限的号）', t => {
  const dataDir = tmp(t), home = tmp(t);
  const env = { CLAUDE_HUB_DATA_DIR: dataDir, AI_HUB_CODEAGENT_POOL_SCAN_ROOT: home };
  const personal = path.join(home, '.cac');
  creds(personal, 'y00000002');
  const source = path.join(home, '.cac-company');
  creds(source, 'z00111111');
  fs.writeFileSync(path.join(source, 'settings.json'), JSON.stringify({ model: GLM }, null, 2));
  probe.writeProbed(path.join(source, probe.MODELS_FILE), { models: [DS_LABEL], defaultModel: DS_LABEL });
  const id = pool.importLocal(dataDir, source, { personalDir: personal, env });
  assert.equal(modelOf(pool.accountDir(dataDir, id)), DS_LABEL);
  assert.equal(JSON.parse(fs.readFileSync(path.join(source, 'settings.json'), 'utf8')).model, GLM, '源目录不动');
});

test('B：fixPoolModel 只改号池号的配置，只动 model 一个键；清单不唯一、本来就在清单里都不改', t => {
  const dataDir = tmp(t);
  const id = pool.addAccount(dataDir, { note: '同事' });
  const dir = pool.accountDir(dataDir, id);
  creds(dir, 'z00222222');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: GLM, theme: 'dark' }, null, 2));
  probe.writeProbed(path.join(dir, probe.MODELS_FILE), { models: [DS_LABEL], defaultModel: DS_LABEL });
  const r = pool.fixPoolModel(dataDir, id);
  assert.deepEqual(r, { ok: true, from: GLM, to: DS_LABEL });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')), { model: DS_LABEL, theme: 'dark' });
  assert.equal(pool.fixPoolModel(dataDir, id).reason, 'in-list', '已经改对：不再动');

  const other = pool.addAccount(dataDir, { note: '同事二' });
  const otherDir = pool.accountDir(dataDir, other);
  creds(otherDir, 'z00333333');
  fs.writeFileSync(path.join(otherDir, 'settings.json'), JSON.stringify({ model: GLM }, null, 2));
  probe.writeProbed(path.join(otherDir, probe.MODELS_FILE), { models: [GLM, DS_LABEL], defaultModel: '' });
  assert.equal(pool.fixPoolModel(dataDir, other).reason, 'no-single-model');
  assert.equal(modelOf(otherDir), GLM);
});

// ---- 通道：真实 routeAccounts（个人账号目录 + 号池目录），直接喂一条模型配置报错给额度看护 ----
function setup(t) {
  let r;
  const box = { personalDir: null };
  r = rig(t, { companyDeps: {
    routeAccounts: ({ usePool = true } = {}) => require('../core/codeagent-model-route').routeAccounts({ dataDir: path.join(r.root, 'company'), personalDir: box.personalDir, usePool,
      activeCounts: box.active || {}, personalActive: box.personalActive || 0 }),
    poolLanes: () => 1, personalConfigDir: () => box.personalDir, accountSecrets: () => [], appUpdate: () => null, currentVersion: '3.1.2',
  } });
  const dataDir = path.join(r.root, 'company');
  box.personalDir = path.join(r.root, 'personal-cac');
  creds(box.personalDir, 'w00123456');
  fs.writeFileSync(path.join(box.personalDir, 'settings.json'), JSON.stringify({ model: GLM }, null, 2));
  probe.writeProbed(pool.personalModelsFile(dataDir), { models: [GLM], defaultModel: GLM });
  // 号池号 1：只有 DeepSeek 权限，配置里却写着 GLM（导入时从源目录抄来的，真机 v3.1.1 现场）
  const id = pool.addAccount(dataDir, { note: '同事' });
  const dir = pool.accountDir(dataDir, id);
  creds(dir, 'z00999999');
  probe.writeProbed(path.join(dir, probe.MODELS_FILE), { models: [DS_LABEL], defaultModel: DS_LABEL });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: GLM }), undefined);
  return Object.assign(r, { box, dataDir, poolId: id, poolDir: dir });
}
const hitOf = text => ({ rule: { id: 'codeagent-model-config-v1', kind: 'model-config' }, text, model: GLM });

test('B：号池号报「GLM 不存在」→ 当场把配置改成 DeepSeek，并且不记「一直避让」（下一次直接重试）', async t => {
  const r = setup(t);
  const marked = [];
  r.company.quota.applyHit({ id: 'sess-0001', key: r.poolId, hit: hitOf(SAMPLE), at: r.clock.now, cfg: {}, marked, s: { id: 'sess-0001', purpose: 'company-bridge' } });
  assert.equal(modelOf(r.poolDir), DS_LABEL, '号的默认模型已改对');
  const entry = Q.modelAvoidAll(r.dataDir)[r.poolId][GLM.toLowerCase()];
  assert.ok(entry, '仍留一条记录，能看出历史');
  assert.equal(entry.fixAt, r.clock.now);
  assert.equal(entry.fixTo, DS_LABEL);
  assert.deepEqual(Q.activeModelAvoid(r.dataDir, r.clock.now), {}, '不处于避让中：下一次直接重试');
  assert.match(Q.describeAvoid(entry, r.clock.now), /号的默认模型已自动改成 DeepSeek-V4-Flash-0731/);

  // 6 小时内再报同样的错：不再自动修（配置已经是 DS 了，说明问题不在配置），照旧按 6 小时试探避让
  r.clock.now += 60000;
  fs.writeFileSync(path.join(r.poolDir, 'settings.json'), JSON.stringify({ model: GLM }), undefined);
  r.company.quota.applyHit({ id: 'sess-0002', key: r.poolId, hit: hitOf(SAMPLE), at: r.clock.now, cfg: {}, marked: [], s: { id: 'sess-0002', purpose: 'company-bridge' } });
  assert.equal(modelOf(r.poolDir), GLM, '6 小时内不重复改配置');
  const again = Q.modelAvoidAll(r.dataDir)[r.poolId][GLM.toLowerCase()];
  assert.ok(again.probeAt > r.clock.now, '照旧避让，到点才允许试一次');
  assert.equal(Q.activeModelAvoid(r.dataDir, r.clock.now)[r.poolId] ? r.poolId : '', r.poolId);
  assert.equal(again.fixAt, entry.fixAt, '修过的记录留着');
});

test('B：个人账号报错不自动改配置（号主自己的配置，只提示），照旧避让', async t => {
  const r = setup(t);
  r.company.quota.applyHit({ id: 'sess-1001', key: 'personal', hit: hitOf(SAMPLE), at: r.clock.now, cfg: {}, marked: [], s: { id: 'sess-1001', purpose: 'company-bridge' } });
  const entry = Q.modelAvoidAll(r.dataDir).personal[GLM.toLowerCase()];
  assert.ok(entry && !entry.fixAt, '个人账号不自动修');
  assert.ok(entry.probeAt > r.clock.now, '照旧 6 小时后才允许试一次');
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.box.personalDir, 'settings.json'), 'utf8')).model, GLM, '个人配置没被动过');
});
