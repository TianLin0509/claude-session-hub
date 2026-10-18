'use strict';
// 模型配置有误的避让与个人账号默认模型修正（2026-10-19）：
//   真实样本（公司 v2.1.13 直查 errors 段）：个人账号只有 GLM-5.2-WX-Auto 权限，settings.json 的 model 却是 deepseek-v4-flash-0731，
//   个人账号开的会话一启动就报「API Error: 模型 "deepseek-v4-flash-0731" 不存在或配置有误，请检查模型配置」。
// 覆盖：规则（原文 + 标点引号变体）、按「号 + 模型」避让、6 小时一次试探、正常答出来解除、换号重做（只一次）、号表与直查写明、
// 个人账号「默认模型和权限不符」、经授权的远程修正 set-personal-model（清单内 / 清单外 / 备份 / 撤销 / 回读失败还原 / 解除避让 / 不碰号池目录 / 限频 / 开关）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Q = require('../core/codeagent-quota');
const route = require('../core/codeagent-model-route');
const pool = require('../core/codeagent-pool');
const probe = require('../core/codeagent-model-probe');
const PM = require('../core/codeagent-personal-model');
const { rig, pair } = require('./helpers/company-bridge-rig');

const GLM = 'GLM-5.2-WX-Auto', DS = 'deepseek-v4-flash-0731', DS_LABEL = 'DeepSeek-V4-Flash-0731';
const HOUR = 3600000;
// 真实样本原文（2026-10-19 00:18 公司 v2.1.13 直查 errors 段）
const SAMPLE = 'API Error: 模型 "deepseek-v4-flash-0731" 不存在或配置有误，请检查模型配置';
const VARIANTS = [
  SAMPLE,
  'API Error：模型 “deepseek-v4-flash-0731” 不存在或配置有误，请检查模型配置',
  'API Error 模型「deepseek-v4-flash-0731」不存在或配置有误',
  "API Error: 模型 'deepseek-v4-flash-0731' 不存在或配置有误。",
  'API Error: 模型deepseek-v4-flash-0731不存在或配置有误',
  'API Error: 模型 ＂deepseek-v4-flash-0731＂ 不 存在 或者 配置 有误',
  'API Error: 400 {"error":{"message":"模型 \\"deepseek-v4-flash-0731\\" 不存在或配置有误，请检查模型配置"}}',
  // Claude Code（替身）把后端 400 写成的完整样子：模型前有 80 多个字符的 JSON 前缀
  'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"模型 \\"deepseek-v4-flash-0731\\" 不存在或配置有误，请检查模型配置"}}',
];
function tmp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-modelcfg-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
const apiErrorLine = (text, at) => JSON.stringify({ type: 'assistant', uuid: 'u-' + Math.random().toString(16).slice(2), timestamp: new Date(at).toISOString(),
  isApiErrorMessage: true, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] } }) + '\n';
const answerLine = (text, model, at) => JSON.stringify({ type: 'assistant', uuid: 'a-' + Math.random().toString(16).slice(2), timestamp: new Date(at).toISOString(),
  message: { role: 'assistant', model, content: [{ type: 'text', text }] } }) + '\n';
const creds = (dir, accountId) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: { accountId, expiresAt: 4_000_000_000_000 } })); };

test('识别规则：真实原文与全角半角冒号、各种引号、空格、JSON 包裹的变体都命中并读出被请求的模型；没有 API Error 的不命中', t => {
  const { rules } = Q.loadRules(tmp(t));
  const rule = rules.find(r => r.id === 'codeagent-model-config-v1');
  assert.ok(rule && rule.builtin && rule.kind === 'model-config');
  assert.equal(Q.BUILTIN_RULES.find(r => r.id === 'codeagent-model-config-v1').sample, SAMPLE, '内置规则的样本就是真机原文');
  for (const text of VARIANTS) {
    const hit = Q.matchText(text, rules, 'transcript');
    assert.ok(hit, '应命中：' + text);
    assert.equal(hit.rule.kind, 'model-config', text);
    assert.equal(hit.model, DS, '读出被请求的模型：' + text);
    assert.ok(Q.matchText('  ⎿  ' + text, rules, 'screen'), '屏幕上也认：' + text);
  }
  for (const text of ['模型 "deepseek-v4-flash-0731" 不存在或配置有误', '为什么会报 模型不存在或配置有误？', 'API Error: 500 internal server error', 'API Error token消耗过快']) {
    const hit = Q.matchText(text, rules, 'transcript');
    assert.ok(!hit || hit.rule.kind !== 'model-config', '不应判成模型配置有误：' + text);
  }
});

test('按「号 + 模型」避让：不设自动到期，6 小时后放行一次试探；再报重新计时；只管那个模型；描述写清请求了什么、该号只有什么', t => {
  const dataDir = tmp(t);
  const now = 1_800_000_000_000;
  const r = Q.markModelAvoid(dataDir, 'personal', { model: DS, have: [GLM], sample: SAMPLE }, now);
  assert.equal(r.changed, true);
  assert.equal(r.entry.until, null, '没有到期时间');
  assert.equal(r.entry.probeAt, now + 6 * HOUR);
  assert.match(Q.describeAvoid(r.entry, now), new RegExp(`^模型配置有误：请求了 ${DS}，该号只有 ${GLM}；配置不变就一直避让，\\d\\d-\\d\\d \\d\\d:\\d\\d 起允许试一次$`));
  assert.ok(Q.activeModelAvoid(dataDir, now + 6 * HOUR - 1).personal[DS]);
  assert.equal(Q.activeModelAvoid(dataDir, now + 6 * HOUR).personal, undefined, '到了试探时间就放行');
  assert.ok(Q.modelAvoidAll(dataDir).personal[DS], '记录还在（不是过期删除）');
  // 整号避让表不受影响
  assert.deepEqual(Q.activeAvoid(dataDir, now), {});
  // 试探：放行一次后推后 6 小时；没到时间的不算试探
  assert.equal(Q.noteModelProbe(dataDir, 'personal', DS, now + HOUR), false);
  assert.equal(Q.noteModelProbe(dataDir, 'personal', DS_LABEL, now + 6 * HOUR), true, '模型名大小写不敏感');
  assert.ok(Q.activeModelAvoid(dataDir, now + 7 * HOUR).personal[DS], '这一次试探之后又避让 6 小时');
  // 试探又报错：重新计时、次数加一
  const again = Q.markModelAvoid(dataDir, 'personal', { model: DS, have: [GLM] }, now + 6 * HOUR + 60000);
  assert.equal(again.entry.hits, 2); assert.equal(again.entry.since, now);
  // 整号避让和模型避让同时存在、互不覆盖；写整号避让时模型避让保留
  Q.markAvoid(dataDir, 'personal', { source: 'manual', until: null }, now);
  assert.ok(Q.modelAvoidAll(dataDir).personal[DS]);
  // 手动恢复派活：统统解除
  assert.equal(Q.clearAvoid(dataDir, 'personal', {}, now).cleared, true);
  assert.deepEqual(Q.modelAvoidAll(dataDir), {});
});

test('挑号：模型配置避让只在请求那个模型时生效；不指定模型时按号配置里实际会请求的模型判断', () => {
  const entry = { source: 'error', kind: 'model-config', model: DS, have: [GLM], probeAt: 5000, until: null };
  const personal = { key: 'personal', pool: false, models: [GLM], defaultModel: '', configModel: DS, activeSessions: 0, lastAssignedAt: 0, modelAvoid: { [DS]: entry } };
  const both = { key: 'p1', pool: true, models: [GLM, DS_LABEL], defaultModel: GLM, configModel: GLM, activeSessions: 3, lastAssignedAt: 0, modelAvoid: { [DS]: { ...entry, have: [GLM, DS_LABEL] } } };
  // 不指定模型：个人账号会请求 DS（避让中）→ 挑号池的号，哪怕它会话多
  assert.equal(route.pickAnyRoute([personal, both]).account.key, 'p1');
  // 号池的号只对 DS 避让：指定 GLM 照常挑；指定 DS 没有可用的号 → avoid，恢复时间是试探时间
  assert.equal(route.pickRoute([personal, both], GLM).account.key, 'p1');
  assert.deepEqual(route.pickRoute([both], DS_LABEL), { ok: false, reason: 'avoid', model: DS_LABEL, until: 5000 });
  // 两个号都避开：不指定模型也排队
  assert.deepEqual(route.pickAnyRoute([personal, { ...both, configModel: DS, defaultModel: DS }]), { ok: false, reason: 'avoid', until: 5000 });
  // 号表：个人账号一行写明避让原因；DS 在号池号上不能并行
  const table = route.modelTable([personal, both], { cap: 2, aliases: new Map([['personal', '个人'], ['p1', '号 1']]), describe: e => Q.describeAvoid(e, 0) });
  const row = table.accountRows.find(x => x.alias === '个人');
  assert.equal(row.avoid.kind, 'model-config');
  assert.match(row.avoid.reason, new RegExp(`模型配置有误：请求了 ${DS}，该号只有 ${GLM}`));
  assert.equal(row.avoid.until, 5000);
  assert.equal(table.models.find(m => m.id === DS_LABEL).free, 0);
  assert.equal(table.models.find(m => m.id === GLM).free, 2, 'GLM 不受 DS 的避让影响');
});

test('个人账号「默认模型和权限不符」：settings 里写了没权限的模型、清单只有一个模型时标出来，带上写的值；写对了、或清单有多个时不标', t => {
  const dataDir = tmp(t), personalDir = path.join(dataDir, 'personal-cac');
  fs.mkdirSync(personalDir, { recursive: true });
  probe.writeProbed(pool.personalModelsFile(dataDir), { models: [GLM], defaultModel: GLM });
  fs.writeFileSync(path.join(personalDir, 'settings.json'), JSON.stringify({ model: DS }));
  let p = route.personalModels({ dataDir, personalDir });
  assert.equal(p.defaultModel, '');
  assert.deepEqual(p.configMismatch, { written: DS, models: [GLM], suggest: GLM });
  assert.equal(route.describeMismatch(p.configMismatch), `默认模型和权限不符：settings.json 里写的是 ${DS}，权限只有 ${GLM}`);
  creds(personalDir, 'w00123456');
  const acct = route.personalAccount({ dataDir, personalDir });
  assert.equal(acct.configModel, DS, '不指定模型时它会请求的是写的那个');
  const table = route.modelTable([acct], { aliases: new Map([['personal', '个人']]) });
  assert.equal(table.accountRows[0].configNote, `默认模型和权限不符：settings.json 里写的是 ${DS}，权限只有 ${GLM}`);
  assert.ok(route.avoidSignature(table), '号表签名带上配置提示，变化时推给对端');
  fs.writeFileSync(path.join(personalDir, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX' }));
  assert.equal(route.personalModels({ dataDir, personalDir }).configMismatch, null, '分档名归到 -Auto，不算不符');
  probe.writeProbed(pool.personalModelsFile(dataDir), { models: [GLM, 'MiniMax-M2.7'], defaultModel: '' });
  fs.writeFileSync(path.join(personalDir, 'settings.json'), JSON.stringify({ model: DS }));
  assert.equal(route.personalModels({ dataDir, personalDir }).configMismatch, null, '清单有多个模型时不替人选');
});

// ---- 修正个人账号默认模型（core/codeagent-personal-model.js） ----
function personalFixture(t, settings = { model: DS, permissions: { allow: ['Bash'] }, env: { A: '1' } }) {
  const dataDir = tmp(t), personalDir = path.join(dataDir, 'personal-cac');
  fs.mkdirSync(personalDir, { recursive: true });
  probe.writeProbed(pool.personalModelsFile(dataDir), { models: [GLM], defaultModel: GLM });
  if (settings) fs.writeFileSync(path.join(personalDir, 'settings.json'), JSON.stringify(settings, null, 4));
  return { dataDir, personalDir, file: path.join(personalDir, 'settings.json') };
}
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));

test('set-personal-model：清单内的模型写进去，只改 model 一个键、其余原样；改前整份备份；能撤销；清单外拒绝并列出可选', t => {
  const f = personalFixture(t);
  const original = fs.readFileSync(f.file, 'utf8');
  assert.throws(() => PM.setPersonalModel({ ...f, model: DS }), new RegExp(`${DS} 不在个人账号的权限清单里，可选：${GLM}`));
  assert.throws(() => PM.setPersonalModel({ ...f, model: 'bad model;' }), /要是模型名/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), original, '拒绝时不动文件');
  const r = PM.setPersonalModel({ ...f, model: 'glm-5.2-wx-auto', now: 1_800_000_000_000 });
  assert.equal(r.ok, true); assert.equal(r.changed, true); assert.equal(r.before, DS); assert.equal(r.after, GLM, '按清单里的写法');
  assert.deepEqual(read(f.file), { model: GLM, permissions: { allow: ['Bash'] }, env: { A: '1' } });
  assert.match(r.backup, /^settings\.json\.hub-backup-\d{8}-\d{6}-\d{3}$/);
  assert.equal(fs.readFileSync(path.join(f.personalDir, r.backup), 'utf8'), original, '备份是原文件原样');
  assert.equal(PM.setPersonalModel({ ...f, model: GLM, now: 1_800_000_001_000 }).changed, false, '已经是它就不改、不再备份');
  // 撤销：用最近一次备份里的值；连点两次结果一样
  const u = PM.setPersonalModel({ ...f, restore: true, now: 1_800_000_002_000 });
  assert.equal(u.ok, true); assert.equal(u.after, DS); assert.equal(u.restoredFrom, r.backup);
  assert.deepEqual(read(f.file), { model: DS, permissions: { allow: ['Bash'] }, env: { A: '1' } });
  assert.match(u.backup, /-undo$/);
  assert.equal(PM.setPersonalModel({ ...f, restore: true, now: 1_800_000_003_000 }).changed, false);
  // 原来没有 settings.json：写进 { model }，撤销时去掉
  const g = personalFixture(t, null);
  assert.equal(PM.setPersonalModel({ ...g, model: GLM, now: 1 }).after, GLM);
  assert.deepEqual(read(g.file), { model: GLM });
  PM.setPersonalModel({ ...g, restore: true, now: 2 });
  assert.deepEqual(read(g.file), {});
  assert.throws(() => PM.setPersonalModel({ ...personalFixture(t), restore: true }), /没有可以撤销的备份/);
});

test('set-personal-model：回读核对不一致就从备份还原并报失败；坏 JSON 不改；个人目录落在号池目录里拒绝', t => {
  const f = personalFixture(t);
  const original = fs.readFileSync(f.file, 'utf8');
  let writes = 0;
  // 写入后第一次回读拿到的不是刚写的（例如别的程序同时改了）
  const flaky = { ...fs, renameSync: (a, b) => { writes += 1; return fs.renameSync(a, b); },
    readFileSync: (file, enc) => (file === f.file && writes === 1 && !flaky.lied ? (flaky.lied = true, JSON.stringify({ model: 'other' })) : fs.readFileSync(file, enc)) };
  const r = PM.setPersonalModel({ ...f, model: GLM, fsModule: flaky });
  assert.equal(r.ok, false); assert.equal(r.rolledBack, true);
  assert.match(r.error, /写入后核对不一致（回读到的 model 是 other.*已从备份还原/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), original, '已从备份还原');
  // 坏 JSON
  fs.writeFileSync(f.file, '{ "model": ');
  assert.throws(() => PM.setPersonalModel({ ...f, model: GLM }), /不是有效的 JSON，没改/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{ "model": ');
  // 号池目录
  const poolDir = pool.accountDir(f.dataDir, 'abc123def');
  fs.mkdirSync(poolDir, { recursive: true });
  fs.writeFileSync(path.join(poolDir, 'settings.json'), JSON.stringify({ model: DS }));
  assert.throws(() => PM.setPersonalModel({ dataDir: f.dataDir, personalDir: poolDir, model: GLM }), /落在号池目录里/);
  assert.deepEqual(read(path.join(poolDir, 'settings.json')), { model: DS }, '号池账号目录不动');
});

// ---- 通道：真实 routeAccounts（个人账号目录 + 号池目录），假会话带原生记录 ----
function setup(t, { personalModel = DS } = {}) {
  let r;
  const box = { personalDir: null };
  r = rig(t, { companyDeps: {
    routeAccounts: ({ usePool = true } = {}) => route.routeAccounts({ dataDir: path.join(r.root, 'company'), personalDir: box.personalDir, usePool,
      activeCounts: box.active || {}, personalActive: box.personalActive || 0 }),
    poolLanes: () => 1, personalConfigDir: () => box.personalDir, accountSecrets: () => [], appUpdate: () => null, currentVersion: '2.1.14',
  } });
  const dataDir = path.join(r.root, 'company');
  box.personalDir = path.join(r.root, 'personal-cac');
  creds(box.personalDir, 'w00123456');
  fs.writeFileSync(path.join(box.personalDir, 'settings.json'), JSON.stringify({ model: personalModel, theme: 'dark' }, null, 2));
  probe.writeProbed(pool.personalModelsFile(dataDir), { models: [GLM], defaultModel: GLM });
  // 号池号 1：同事的 DS 号
  const id = pool.addAccount(dataDir, { note: '同事' });
  creds(pool.accountDir(dataDir, id), 'z00999999');
  probe.writeProbed(path.join(pool.accountDir(dataDir, id), probe.MODELS_FILE), { models: [DS_LABEL], defaultModel: DS_LABEL });
  fs.writeFileSync(path.join(pool.accountDir(dataDir, id), 'settings.json'), JSON.stringify({ model: DS }));
  const create = r.company.deps.createSession;
  r.company.deps.createSession = async (kind, opts) => {
    const x = await create(kind, opts);
    if (opts.codeagentPoolPick) x.codeagentPoolAccount = opts.codeagentPoolPick;
    x.purpose = opts.purpose;
    x.transcriptPath = path.join(r.root, 'tx-' + opts.id + '.jsonl');
    fs.writeFileSync(x.transcriptPath, '');
    return x;
  };
  r.company.deps.listSessionIds = () => [...r.cs.map.keys()];
  r.hs.map.set('home-s', { id: 'home-s', kind: 'claude', status: 'idle' });
  const created = () => r.cs.created.map(c => c.opts);
  const account = opts => (opts.codeagentPoolPick ? 'pool' : 'personal');
  const inject = (sid, line) => fs.appendFileSync(r.cs.map.get(sid).transcriptPath, line);
  return Object.assign(r, { box, dataDir, poolId: id, created, account, inject });
}
const step = async (r, ms = 20000) => { r.clock.now += ms; await r.company.checkNow(); await r.company.hubAdmin.actTask; await r.home.checkNow(); };

test('通道：个人账号会话报模型配置有误 → 只对它请求的 DS 避让 → 这一轮换号重做拿到回执；新问题不再派给个人账号；6 小时后放行一次试探；正常答出来就解除', async t => {
  const r = setup(t); await pair(r);
  // 个人账号默认模型不确定（写的 DS 不在权限里），自动路由会把它排在号池后面；这里像真机那样让个人账号开会话：指定个人账号
  await step(r, 1000);
  const asked = await r.home.ask('home-s', { question: 'AirView 里 RSRP 统计的入口在哪个文件？', account: '个人' });
  await r.company.checkNow(); await r.company.checkNow();
  const first = r.created()[0];
  assert.equal(r.account(first), 'personal');
  r.inject(first.id, apiErrorLine(SAMPLE, r.clock.now));
  await step(r, 2000);
  const entry = Q.modelAvoidAll(r.dataDir).personal[DS];
  assert.ok(entry, '个人账号对 DS 进入避让');
  assert.deepEqual(entry.have, [GLM]);
  assert.deepEqual(Q.activeAvoid(r.dataDir, r.clock.now), {}, '不是整号避让');
  const second = r.created()[1];
  assert.ok(second, '换号新开会话');
  assert.equal(r.account(second), 'pool');
  assert.match(r.cs.sentTo(second.id).at(-1).text, /那个会话所用的号（个人）因模型配置有误中断，现换到新会话重做/);
  r.cs.answer(second.id, '入口在 stats/rsrp.cpp。');
  await step(r); await step(r, 1000);
  const hr = r.home.thread(asked.thread).rounds[0];
  assert.match(hr.reply, /stats\/rsrp\.cpp/);
  assert.equal(hr.meta.rehomeKind, 'model-config');
  assert.match(require('../core/company-bridge/home').replyMessage(r.home.thread(asked.thread), hr), /原先的号（个人）报模型配置有误（请求的模型它没有权限），公司自动换到号 1\s?新开会话重做了这一轮/);
  // 号表：个人一行写明请求了什么、该号只有什么，并带「默认模型和权限不符」
  await step(r, 31000);
  const row = r.home.companyModels().table.accountRows.find(x => x.alias === '个人');
  assert.match(row.avoid.reason, new RegExp(`模型配置有误：请求了 ${DS}，该号只有 ${GLM}`));
  assert.match(row.configNote, new RegExp(`settings.json 里写的是 ${DS}，权限只有 ${GLM}`));
  assert.match(require('../core/company-bridge/model-table-text').describeAccounts(r.home.companyModels().table).join('\n'), /个人.*避让中：模型配置有误.*默认模型和权限不符/);
  // 新问题：指定个人账号直接报避让、不发出；不指定的派给号 1
  await assert.rejects(r.home.ask('home-s', { question: '第二个问题：还想在个人账号上问', account: '个人' }), e => e.code === 'account-avoided' && /个人.*在避让中.*模型配置有误/.test(e.message));
  await r.home.ask('home-s', { question: '第二个问题：HARQ 合并逻辑在哪里实现' });
  await r.company.checkNow(); await r.company.checkNow();
  assert.equal(r.account(r.created().at(-1)), 'pool');
  // 直查 pool 段与 codeagent 段写明
  const D = require('../core/company-bridge/diag');
  r.company.deps.poolDiag = () => ({ personal: { state: 'ready', models: [GLM], defaultModel: '', activeSessions: 0, configModel: DS, configMismatch: { written: DS, models: [GLM], suggest: GLM } }, accounts: [] });
  const out = await D.collect({ bridge: r.company, sections: ['pool', 'codeagent'], sys: { ...D.defaultSys(), clock: () => r.clock.now, codeagentVersion: async () => '1.0' } });
  const p = out.pool.accounts.find(a => a.alias === '个人');
  assert.equal(p.avoid.kind, 'model-config'); assert.equal(p.avoid.model, DS); assert.deepEqual(p.avoid.have, [GLM]);
  assert.match(p.avoid.label, new RegExp(`请求了 ${DS}，该号只有 ${GLM}`));
  assert.equal(p.configMismatch.suggest, GLM);
  assert.match(out.codeagent.personal.configNote, /默认模型和权限不符/);
  assert.ok(out.codeagent.avoid.some(a => a.account === '个人' && a.kind === 'model-config'));
  // 6 小时后：放行一次试探（只放一个）
  r.clock.now = entry.probeAt + 1000;
  await step(r, 31000);
  const third = await r.home.ask('home-s', { question: '第三个问题：试探个人账号', account: '个人' });
  await r.company.checkNow(); await r.company.checkNow();
  const probeSession = r.created().at(-1);
  assert.equal(r.account(probeSession), 'personal', '到时间放行一次');
  assert.ok(Q.activeModelAvoid(r.dataDir, r.clock.now).personal, '放行一次后又避让，不会一窝蜂派过去');
  // 同时到的另一题也点名个人账号：公司这边已经又在避让中，不发出（家里号表还没更新时由公司拒绝）
  const fourth = await r.home.ask('home-s', { question: '第四个问题：同时到的', account: '个人' });
  await r.company.checkNow(); await r.company.checkNow();
  assert.match(r.company.thread(fourth.thread).rounds[0].error, /指定的个人在避让中：模型配置有误/);
  // 试探成功（比如号主自己把配置改好了）：用 DS 正常答出来 → 解除
  r.inject(probeSession.id, answerLine('已找到。', DS, r.clock.now));
  r.cs.answer(probeSession.id, '已找到。');
  await step(r, 2000);
  assert.deepEqual(Q.modelAvoidAll(r.dataDir), {}, '用那个模型正常答出来就解除');
  void third;
});

test('通道：换号重做只一次——重做的号也报模型配置有误就如实报失败', async t => {
  const r = setup(t); await pair(r);
  await step(r, 1000);
  const asked = await r.home.ask('home-s', { question: '查一下 PF 权重的更新位置', account: '个人' });
  await r.company.checkNow(); await r.company.checkNow();
  r.inject(r.created()[0].id, apiErrorLine(SAMPLE, r.clock.now));
  await step(r, 2000);
  const second = r.created()[1];
  assert.equal(r.account(second), 'pool');
  r.inject(second.id, apiErrorLine('API Error: 模型 "DeepSeek-V4-Flash-0731" 不存在或配置有误，请检查模型配置', r.clock.now));
  await step(r, 2000);
  assert.equal(r.created().length, 2, '没有第三个会话');
  assert.match(r.home.thread(asked.thread).rounds[0].error, /已经因模型配置有误换过一次号，换到号 1\s?重做后，号 1\s?也撞到了模型配置有误.*只换号重做一次/);
});

test('远程维护 set-personal-model：改成清单内的模型、回报前后值与「只影响之后新开的会话」、轻提示中性、审计；之后个人账号重新接活；清单外拒绝；限频；开关关闭拒绝；老公司不发', async t => {
  const r = setup(t); await pair(r);
  Q.markModelAvoid(r.dataDir, 'personal', { model: DS, have: [GLM] }, r.clock.now);
  await step(r, 31000);
  // 家里先核参数
  await assert.rejects(r.home.hubAdmin({ op: 'act', action: 'set-personal-model', params: {} }), /要给出模型名 model/);
  await assert.rejects(r.home.hubAdmin({ op: 'act', action: 'set-personal-model', params: { model: GLM, restore: true } }), /只能给一个/);
  // 清单外：公司拒绝，文件不动
  let sent = await r.home.hubAdmin({ op: 'act', action: 'set-personal-model', params: { model: DS } });
  await step(r, 1000); await step(r, 1000);
  let v = r.home.actView(sent.id);
  assert.equal(v.act.ok, false); assert.match(v.note, new RegExp(`不在个人账号的权限清单里，可选：${GLM}`));
  assert.equal(read(path.join(r.box.personalDir, 'settings.json')).model, DS);
  // 限频：60 秒内只做一次
  r.clock.now += 61000;
  sent = await r.home.hubAdmin({ op: 'act', action: 'set-personal-model', params: { model: GLM } });
  await step(r, 1000); await step(r, 1000);
  v = r.home.actView(sent.id);
  assert.equal(v.status, '已执行', JSON.stringify(v));
  assert.equal(v.act.ok, true); assert.equal(v.act.before, DS); assert.equal(v.act.after, GLM);
  assert.match(v.note, new RegExp(`个人账号默认模型 ${DS} → ${GLM}.*改前已备份为 settings\\.json\\.hub-backup-.*只影响之后新开的会话，已在跑的会话不动.*已解除个人账号的模型配置避让`));
  assert.deepEqual(read(path.join(r.box.personalDir, 'settings.json')), { model: GLM, theme: 'dark' });
  assert.deepEqual(Q.modelAvoidAll(r.dataDir), {}, '写入成功后解除模型配置避让');
  const n = r.notices.find(x => /对端修改了个人账号默认模型/.test(x.title));
  assert.ok(n && n.quiet, JSON.stringify(r.notices.map(x => x.title)));
  assert.ok(n.title.endsWith(`对端修改了个人账号默认模型：${DS} → ${GLM}`), n.title);
  assert.ok(!r.notices.some(x => /家里/.test(String(x.title) + String(x.text))), '公司侧文案不出现「家里」');
  assert.match(fs.readFileSync(path.join(r.dataDir, 'logs', 'company-act.log'), 'utf8'), new RegExp(`done ${sent.id} set-personal-model`));
  const again = await r.home.hubAdmin({ op: 'act', action: 'set-personal-model', params: { restore: true } });
  await step(r, 1000); await step(r, 1000);
  assert.match(r.home.actView(again.id).note, /60 秒内只做一次/);
  // 号池账号目录没被动过
  assert.deepEqual(read(path.join(pool.accountDir(r.dataDir, r.poolId), 'settings.json')), { model: DS });
  // 之后新开的会话：个人账号会请求 GLM，不再避开
  r.box.active = { [r.poolId]: 1 };
  await r.home.ask('home-s', { question: '修正之后：个人账号接一个问题' });
  await r.company.checkNow(); await r.company.checkNow();
  assert.equal(r.account(r.created().at(-1)), 'personal');
  // 开关关闭：拒绝
  r.company.setSettings({ allowRemoteMaintain: false });
  r.clock.now += 61000;
  const off = await r.home.hubAdmin({ op: 'act', action: 'set-personal-model', params: { restore: true } });
  await step(r, 1000); await step(r, 1000);
  assert.match(r.home.actView(off.id).note, /没允许对端远程维护/);
  assert.equal(read(path.join(r.box.personalDir, 'settings.json')).model, GLM);
  // 老公司（没报 personal-model 能力）：家里直接说明，不白发
  const st = r.home.store.get('hubAdmin');
  r.home.store.set('hubAdmin', { ...st, company: { ...(st.company || {}), current: '2.1.13', caps: ['diag', 'act', 'quota'] } });
  await assert.rejects(r.home.hubAdmin({ op: 'act', action: 'set-personal-model', params: { model: GLM } }), /版本过旧.*不支持远程修改个人账号默认模型/);
});

test('MCP company_act 与命令行：带 set-personal-model 的 model / restore 参数', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'company-bridge-mcp.js'), 'utf8');
  assert.match(src, /'set-personal-model'\]/);
  assert.match(src, /model: \{ type: 'string', description: 'set-personal-model/);
  assert.match(src, /restore: \{ type: 'boolean'/);
  const cli = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'company-ask.js'), 'utf8');
  assert.match(cli, /set-personal-model --model GLM-5\.2-WX-Auto \| set-personal-model --restore/);
  assert.match(cli, /a\.restore = true/);
});
