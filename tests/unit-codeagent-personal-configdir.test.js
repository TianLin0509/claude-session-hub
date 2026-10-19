'use strict';
// 个人账号配置目录的判定与加固（2026-10-19 公司真机事故）：
//   - Hub 进程继承来的 CODEAGENT3_CONFIG_DIR（指向号池号 1 的目录）不再当个人目录，个人目录取 ~/.cac；显式指定仍生效；
//   - 目录比对先 realpath，Windows 上不分大小写和分隔符（junction 也认得出是同一个）；
//   - set-personal-model 遇到个人目录等于号池号目录拒绝；号池同步在来源等于目标时不写；
//   - 直查只回是否和代称，不带路径。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const C = require('../core/codeagent-config');
const pool = require('../core/codeagent-pool');
const { setPersonalModel } = require('../core/codeagent-personal-model');

const GLM = 'GLM-5.2-WX-Auto', DS = 'deepseek-v4-flash-0731';
const POOL_ID = 'acct0001';

function rig(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-personal-configdir-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), dataDir = path.join(root, 'data');
  const personal = path.join(home, '.cac');
  fs.mkdirSync(personal, { recursive: true });
  fs.writeFileSync(path.join(personal, 'settings.json'), JSON.stringify({ model: GLM, env: { KEEP: '1' } }, null, 2));
  fs.mkdirSync(path.join(dataDir, 'codeagent-pool'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'codeagent-pool', 'pool.json'), JSON.stringify({ schema: 1, accounts: [{ id: POOL_ID, note: '同事', createdAt: null }] }));
  const acct = pool.accountDir(dataDir, POOL_ID);
  fs.mkdirSync(acct, { recursive: true });
  fs.writeFileSync(path.join(acct, 'settings.json'), JSON.stringify({ model: DS }, null, 2));
  fs.writeFileSync(path.join(acct, 'hub-models.json'), JSON.stringify({ schema: 1, models: [DS], defaultModel: DS, at: new Date().toISOString() }));
  return { root, home, dataDir, personal, acct };
}
// Windows 上换一种写法：大写、正斜杠、结尾分隔符
const respell = dir => process.platform === 'win32' ? dir.toUpperCase().replace(/\\/g, '/') + '/' : dir + '/';

test('继承来的 CODEAGENT3_CONFIG_DIR 指向号池号目录：个人目录取 ~/.cac，来源标 ignored-inherited-env，说明不带路径', t => {
  const r = rig(t);
  const env = { USERPROFILE: r.home, HOME: r.home, CODEAGENT3_CONFIG_DIR: r.acct };
  const cfg = C.resolveCodeAgentConfig(env, {});
  assert.equal(cfg.configDir, r.personal);
  assert.equal(cfg.configDirEnv, 'CODEAGENT3_CONFIG_DIR', '变量名照旧用于启动时注入');
  assert.equal(C.configDirSource(env, {}), 'ignored-inherited-env');
  const info = C.inheritedConfigDirInfo(env, {}, { dataDir: r.dataDir });
  assert.deepEqual(info, { ignored: true, variable: 'CODEAGENT3_CONFIG_DIR', note: C.INHERITED_NOTE, inPool: true, inPoolAccount: POOL_ID });
  assert.ok(!JSON.stringify(info).includes(r.root), '说明里不带路径');
  assert.match(C.INHERITED_NOTE, /Hub 进程继承了一个指向别处的 CodeAgent 配置目录，已忽略/);
  // 继承来的值指向号池以外的别处
  const other = path.join(r.root, 'elsewhere', '.cac-x');
  const info2 = C.inheritedConfigDirInfo({ ...env, CODEAGENT3_CONFIG_DIR: other }, {}, { dataDir: r.dataDir });
  assert.equal(info2.inPool, false); assert.equal(info2.inPoolAccount, null);
  // 自定义变量名：继承的是自定义名字的变量
  const custom = { USERPROFILE: r.home, AI_HUB_CODEAGENT_CONFIG_ENV: 'MY_CAC_DIR', MY_CAC_DIR: r.acct, CODEAGENT3_CONFIG_DIR: r.personal };
  assert.equal(C.resolveCodeAgentConfig(custom, {}).configDir, r.personal);
  assert.equal(C.inheritedConfigDirInfo(custom, {}, { dataDir: r.dataDir }).variable, 'MY_CAC_DIR');
});

test('继承来的值就是 ~/.cac（大小写、分隔符不同）：不算异常；没有继承：default', t => {
  const r = rig(t);
  const env = { USERPROFILE: r.home, CODEAGENT3_CONFIG_DIR: respell(r.personal) };
  assert.equal(C.configDirSource(env, {}), 'default');
  assert.equal(C.inheritedConfigDirInfo(env, {}, { dataDir: r.dataDir }), null);
  assert.equal(C.configDirSource({ USERPROFILE: r.home }, {}), 'default');
  assert.equal(C.inheritedConfigDirInfo({ USERPROFILE: r.home }, {}, { dataDir: r.dataDir }), null);
});

test('显式指定的个人目录照旧生效（AI_HUB_CODEAGENT_CONFIG_DIR 优先，其次 Hub 设置）；继承的值不同仍标出已忽略', t => {
  const r = rig(t);
  const mine = path.join(r.root, 'my-cac');
  const envDir = { USERPROFILE: r.home, AI_HUB_CODEAGENT_CONFIG_DIR: mine, CODEAGENT3_CONFIG_DIR: r.acct };
  assert.equal(C.resolveCodeAgentConfig(envDir, { configDir: path.join(r.root, 'other') }).configDir, mine);
  assert.equal(C.configDirSource(envDir, {}), 'hub-env');
  assert.equal(C.inheritedConfigDirInfo(envDir, {}, { dataDir: r.dataDir }).inPool, true);
  const viaSettings = { USERPROFILE: r.home, CODEAGENT3_CONFIG_DIR: r.acct };
  assert.equal(C.resolveCodeAgentConfig(viaSettings, { configDir: mine }).configDir, mine);
  assert.equal(C.configDirSource(viaSettings, { configDir: mine }), 'hub-config');
  // 显式指定的目录和继承来的一样：不报
  assert.equal(C.inheritedConfigDirInfo({ USERPROFILE: r.home, CODEAGENT3_CONFIG_DIR: respell(mine) }, { configDir: mine }, { dataDir: r.dataDir }), null);
});

test('目录比对：大小写、分隔符、结尾斜杠不同也认得出同一个；junction 指向同一处也认得出；互相包含算重叠', t => {
  const r = rig(t);
  assert.equal(C.sameDir(r.acct, respell(r.acct)), true);
  assert.equal(C.dirsOverlap(path.join(r.acct, 'sub'), r.acct), true);
  assert.equal(C.dirsOverlap(r.dataDir, r.acct), true, '个人目录包含号的目录也算重叠');
  assert.equal(C.dirsOverlap(r.personal, r.acct), false);
  assert.equal(C.dirsOverlap(path.join(r.home, '.cac-ds'), r.personal), false, '只是前缀相同的兄弟目录不算');
  // Windows 规则在任何平台上都能单独核对（不碰磁盘）
  const noFs = { fsModule: {}, platform: 'win32' };
  assert.equal(C.sameDir('C:\\Users\\A\\.claude-session-hub\\codeagent-pool\\accounts\\x', 'c:/users/a/.CLAUDE-session-hub/codeagent-pool/accounts/x/', noFs), true);
  assert.equal(C.dirsOverlap('C:\\Users\\A\\hub\\codeagent-pool', 'c:/users/a/hub/codeagent-pool/accounts/x', noFs), true);
  assert.equal(C.dirsOverlap('C:\\Users\\A\\.cac', 'C:\\Users\\A\\.cac-ds', noFs), false);
  // junction：另一个路径指向号的目录
  const link = path.join(r.root, 'link-to-acct');
  fs.symlinkSync(r.acct, link, 'junction');
  assert.equal(C.sameDir(link, r.acct), true, 'realpath 解开 junction');
  assert.deepEqual(pool.poolDirMatch(r.dataDir, link), { id: POOL_ID });
  assert.deepEqual(pool.poolDirMatch(r.dataDir, respell(r.acct)), { id: POOL_ID });
  assert.deepEqual(pool.poolDirMatch(r.dataDir, path.join(r.dataDir, 'codeagent-pool', 'probe-cwd')), { id: null }, '落在号池目录里但不是哪个号');
  assert.equal(pool.poolDirMatch(r.dataDir, r.personal), null);
  // 还不存在的目录：按最近的已存在上级解开
  assert.equal(C.sameDir(path.join(link, 'not-yet'), path.join(r.acct, 'not-yet')), true);
});

test('set-personal-model：个人目录等于号池号目录（换写法 / junction）时拒绝，文件不动', t => {
  const r = rig(t);
  const before = fs.readFileSync(path.join(r.acct, 'settings.json'), 'utf8');
  fs.writeFileSync(path.join(r.dataDir, 'codeagent-pool', 'personal-models.json'), JSON.stringify({ schema: 1, models: [GLM], defaultModel: GLM, at: new Date().toISOString() }));
  const link = path.join(r.root, 'link-to-acct');
  fs.symlinkSync(r.acct, link, 'junction');
  for (const dir of [r.acct, respell(r.acct), link]) {
    assert.throws(() => setPersonalModel({ dataDir: r.dataDir, personalDir: dir, model: GLM }), e => e.code === 'in-pool-dir' && !e.message.includes(r.root), dir);
  }
  // 个人目录包含号池（比如指到了 Hub 数据目录）也拒绝
  assert.throws(() => setPersonalModel({ dataDir: r.dataDir, personalDir: r.dataDir, model: GLM }), e => e.code === 'in-pool-dir');
  assert.equal(fs.readFileSync(path.join(r.acct, 'settings.json'), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(r.acct).filter(n => n.includes('hub-backup')), [], '没留下备份文件');
  // 真正的个人目录照常能改
  fs.writeFileSync(path.join(r.personal, 'settings.json'), JSON.stringify({ model: DS }, null, 2));
  const ok = setPersonalModel({ dataDir: r.dataDir, personalDir: r.personal, model: GLM });
  assert.equal(ok.ok, true); assert.equal(ok.after, GLM);
});

test('号池同步：来源等于目标（换写法 / junction / 互相包含）时一个字都不写；正常时照旧同步、不碰个人目录', t => {
  const r = rig(t);
  const file = path.join(r.acct, 'settings.json');
  const before = fs.readFileSync(file, 'utf8');
  const mtime = fs.statSync(file).mtimeMs;
  const link = path.join(r.root, 'link-to-acct');
  fs.symlinkSync(r.acct, link, 'junction');
  for (const src of [r.acct, respell(r.acct), link, r.dataDir]) {
    const res = pool.syncSharedConfig(src, r.acct, undefined, { routeModel: '' });
    assert.equal(res.skipped, true, String(src));
    assert.match(res.errors[0], /同一个/);
    assert.equal(res.model, DS);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.statSync(file).mtimeMs, mtime, 'settings.json 没被重写');
  assert.ok(!fs.existsSync(path.join(r.acct, pool.ROUTE_MARKER)));
  // 正常同步：号目录拿到个人的设置（去掉 model），号自己的模型保留；个人 settings.json 不变
  const personalBefore = fs.readFileSync(path.join(r.personal, 'settings.json'), 'utf8');
  const res = pool.syncSharedConfig(r.personal, r.acct);
  assert.equal(res.skipped, undefined);
  const synced = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(synced.model, DS); assert.deepEqual(synced.env, { KEEP: '1' });
  assert.equal(fs.readFileSync(path.join(r.personal, 'settings.json'), 'utf8'), personalBefore);
});

test('启动个人会话注入的配置目录：继承的值指向号目录时注入的是 ~/.cac', t => {
  const r = rig(t);
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, CODEAGENT3_CONFIG_DIR: process.env.CODEAGENT3_CONFIG_DIR,
    AI_HUB_CODEAGENT_CONFIG_DIR: process.env.AI_HUB_CODEAGENT_CONFIG_DIR };
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  Object.assign(process.env, { USERPROFILE: r.home, HOME: r.home, CODEAGENT3_CONFIG_DIR: r.acct });
  delete process.env.AI_HUB_CODEAGENT_CONFIG_DIR;
  const cfg = C.resolveCodeAgentConfig(process.env, {});
  // session-manager 用的就是这一份：sessionEnv[configDirEnv] = configDir
  const sessionEnv = { ...process.env };
  sessionEnv[cfg.configDirEnv] = cfg.configDir;
  assert.equal(sessionEnv.CODEAGENT3_CONFIG_DIR, r.personal);
  assert.equal(pool.readSettingsModel(sessionEnv.CODEAGENT3_CONFIG_DIR), GLM);
});
