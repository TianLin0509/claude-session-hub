'use strict';
// CodeAgent 号池（core/codeagent-pool.js）：挑号、凭证读取、配置同步、工作目录凭证拦截、登记增删。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pool = require('../core/codeagent-pool');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ca-pool-')); }
function writeCreds(dir, key, fields) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ [key]: { accessToken: 'AQAAANCMnd8x', ...fields } }));
}
function acct(overrides) {
  return { id: 'a', state: 'ready', models: [], modelsAuthoritative: false, activeSessions: 0, lastAssignedAt: 0, sameAsPersonal: false, duplicateOf: null, ...overrides };
}

test('pickAccount prefers accounts without active sessions, then fewest, then least recently assigned', () => {
  const picked = pool.pickAccount([
    acct({ id: 'busy', activeSessions: 2 }),
    acct({ id: 'idle-old', activeSessions: 0, lastAssignedAt: 100 }),
    acct({ id: 'idle-new', activeSessions: 0, lastAssignedAt: 200 }),
  ]);
  assert.equal(picked.id, 'idle-old');
  assert.equal(pool.pickAccount([acct({ id: 'x', activeSessions: 3 }), acct({ id: 'y', activeSessions: 1 })]).id, 'y');
});

test('pickAccount skips accounts that need login, duplicate the personal account, or lack the requested model', () => {
  const accounts = [
    acct({ id: 'expired', state: 'expired' }),
    acct({ id: 'mine', sameAsPersonal: true }),
    acct({ id: 'glm-only', models: ['GLM-5.2-WX-Auto'], modelsAuthoritative: true }),
    acct({ id: 'deepseek', models: ['deepseek-v4-flash-0731'], modelsAuthoritative: true, activeSessions: 1 }),
  ];
  assert.equal(pool.pickAccount(accounts, { model: 'deepseek-v4-flash-0731' }).id, 'deepseek');
  assert.equal(pool.pickAccount(accounts).id, 'glm-only');
  assert.equal(pool.pickAccount(accounts, { model: 'MiniMax-M2.7' }), null);
  // 模型清单未知的号可以兜底，但排在明确有这个模型的号后面
  const unknown = [acct({ id: 'unknown' }), acct({ id: 'known', models: ['M'], modelsAuthoritative: true, activeSessions: 5 })];
  assert.equal(pool.pickAccount(unknown, { model: 'M' }).id, 'known');
  assert.equal(pool.pickAccount([acct({ id: 'unknown' })], { model: 'M' }).id, 'unknown');
});

test('readCredentials only reads plaintext fields and accountState treats expired account-password logins as expired', () => {
  const dir = tmp();
  assert.deepEqual(pool.readCredentials(dir), { present: false, reason: 'missing' });
  writeCreds(dir, 'idaasOAuth', { accountId: 'x00000001', xAuthExpires: 1000, expiresAt: 5000 });
  const creds = pool.readCredentials(dir);
  assert.equal(creds.method, 'idaas');
  assert.equal(creds.accountId, 'x00000001');
  assert.equal(creds.expiresAt, 1000, 'x-auth expiry wins for account-password logins');
  assert.equal(pool.accountState(creds, 999), 'ready');
  assert.equal(pool.accountState(creds, 1001), 'expired');
  writeCreds(dir, 'devUCOAuth', { accountId: 'y00000002', expiresAt: 1000 });
  assert.equal(pool.accountState(pool.readCredentials(dir), 5000), 'ready', 'browser logins renew themselves');
  fs.writeFileSync(path.join(dir, '.credentials.json'), '{broken');
  assert.equal(pool.accountState(pool.readCredentials(dir)), 'unreadable');
  assert.equal(pool.maskAccountId('x00000001'), 'x000****01');
});

test('listAccounts reports active sessions, personal duplicates and repeated accounts', () => {
  const data = tmp();
  const a = pool.addAccount(data, { note: '同事甲' });
  const b = pool.addAccount(data, { note: '本人' });
  const c = pool.addAccount(data, { note: '重复' });
  writeCreds(pool.accountDir(data, a), 'idaasOAuth', { accountId: 'x00000001', expiresAt: Date.now() + 3600e3 });
  writeCreds(pool.accountDir(data, b), 'devUCOAuth', { accountId: 'y00000002', expiresAt: Date.now() + 3600e3 });
  writeCreds(pool.accountDir(data, c), 'idaasOAuth', { accountId: 'x00000001', expiresAt: Date.now() + 3600e3 });
  const list = pool.listAccounts(data, { activeCounts: { [a]: 2 }, personalAccountId: 'y00000002' });
  const byId = Object.fromEntries(list.map(x => [x.id, x]));
  assert.equal(byId[a].activeSessions, 2);
  assert.equal(byId[a].note, '同事甲');
  assert.equal(byId[a].accountLabel, 'x000****01');
  assert.equal(byId[b].sameAsPersonal, true);
  assert.equal(byId[c].duplicateOf, a);
  assert.equal(pool.pickAccount(list).id, a, 'only the first distinct, non-personal account is usable');
});

test('removeAccount drops the registry entry and the local credentials but keeps session history', () => {
  const data = tmp();
  const id = pool.addAccount(data, {});
  const dir = pool.accountDir(data, id);
  writeCreds(dir, 'idaasOAuth', { accountId: 'x1' });
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  pool.removeAccount(data, id);
  assert.equal(pool.readRegistry(data).accounts.length, 0);
  assert.equal(fs.existsSync(path.join(dir, '.credentials.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'projects')), true);
  assert.throws(() => pool.removeAccount(data, id), /没有这个账号/);
  assert.throws(() => pool.accountDir(data, '../escape'), /编号无效/);
});

test('syncSharedConfig copies personal settings without hooks or model, keeps the account model, and mirrors rules and skills', () => {
  const personal = tmp(), target = tmp();
  fs.writeFileSync(path.join(personal, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX-Auto', permissions: { allow: ['Bash'] }, hooks: { Stop: [{ hooks: [{ command: 'personal-hook' }] }] } }));
  fs.writeFileSync(path.join(personal, 'AGENTS.md'), '# rules');
  fs.mkdirSync(path.join(personal, 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(personal, 'skills', 'demo', 'SKILL.md'), 'skill');
  fs.writeFileSync(path.join(target, 'settings.json'), JSON.stringify({ model: 'deepseek-v4-flash-0731', hooks: { Stop: [{ hooks: [{ command: 'pool-hook' }] }] } }));
  assert.deepEqual(pool.syncSharedConfig(personal, target).errors, []);
  const synced = JSON.parse(fs.readFileSync(path.join(target, 'settings.json'), 'utf8'));
  assert.equal(synced.model, 'deepseek-v4-flash-0731');
  assert.deepEqual(synced.permissions, { allow: ['Bash'] });
  assert.equal(JSON.stringify(synced.hooks).includes('personal-hook'), false);
  assert.equal(JSON.stringify(synced.hooks).includes('pool-hook'), true);
  assert.equal(fs.readFileSync(path.join(target, 'AGENTS.md'), 'utf8'), '# rules');
  assert.equal(fs.readFileSync(path.join(target, 'skills', 'demo', 'SKILL.md'), 'utf8'), 'skill');
});

test('syncSharedConfig defaults a fresh account to the first model of its own account list', () => {
  const personal = tmp(), target = tmp();
  fs.writeFileSync(path.join(personal, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX-Auto' }));
  fs.writeFileSync(path.join(target, '.cac.json'), JSON.stringify({ enterpriseModelOptionsCache: [{ value: 'deepseek-v4-flash-0731', contextWindow: 128000 }] }));
  pool.syncSharedConfig(personal, target);
  const synced = JSON.parse(fs.readFileSync(path.join(target, 'settings.json'), 'utf8'));
  assert.equal(synced.model, 'deepseek-v4-flash-0731', 'never inherit the personal model the pool account may not have');
});

// 2026-10-17 公司实测：两个号分别只有 GLM、只有 DeepSeek v4；通道开到 DS 号上报「找不到 GLM」。
// 原因：定模型时只看配置文件，没读「一键获取模型权限」探测到的清单，DS 号没定下模型就退回 CodeAgent 默认的 GLM。
test('syncSharedConfig uses the probed model list: a DeepSeek-only account gets its own model, and a stale GLM setting is replaced', () => {
  const probe = require('../core/codeagent-model-probe');
  const personal = tmp(), target = tmp();
  fs.writeFileSync(path.join(personal, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX-Auto' }));
  probe.writeProbed(path.join(target, probe.MODELS_FILE), { models: ['deepseek-v4-0731'], defaultModel: '' });
  pool.syncSharedConfig(personal, target);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'settings.json'), 'utf8')).model, 'deepseek-v4-0731');
  // 号自己存过一个它没有权限的模型（例如早先手动选过 GLM）：换成清单里的
  fs.writeFileSync(path.join(target, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX-Auto' }));
  pool.syncSharedConfig(personal, target);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'settings.json'), 'utf8')).model, 'deepseek-v4-0731');
  // 清单里有的、号主自己选的模型保留
  probe.writeProbed(path.join(target, probe.MODELS_FILE), { models: ['deepseek-v4-0731', 'deepseek-v4-flash-0731'], defaultModel: 'deepseek-v4-0731' });
  fs.writeFileSync(path.join(target, 'settings.json'), JSON.stringify({ model: 'deepseek-v4-flash-0731' }));
  pool.syncSharedConfig(personal, target);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'settings.json'), 'utf8')).model, 'deepseek-v4-flash-0731');
});

test('pickAccount without a model prefers accounts whose model list is known over ones that may fall back to a default they lack', () => {
  const picked = pool.pickAccount([
    acct({ id: 'unknown', models: [], modelsAuthoritative: false, activeSessions: 0 }),
    acct({ id: 'ds', models: ['deepseek-v4-0731'], modelsAuthoritative: true, activeSessions: 1 }),
  ]);
  assert.equal(picked.id, 'ds');
  // 只有清单未知的号时仍可用（问题不卡住）
  assert.equal(pool.pickAccount([acct({ id: 'unknown' })]).id, 'unknown');
});

test('projectCredentialsOverride flags a working directory whose .cac credentials would win over the pool account', () => {
  const cwd = tmp();
  assert.equal(pool.projectCredentialsOverride(cwd), null);
  writeCreds(path.join(cwd, '.cac'), 'devUCOAuth', { accountId: 'l1' });
  assert.equal(pool.projectCredentialsOverride(cwd), path.join(cwd, '.cac', '.credentials.json'));
});

test('openLoginWindow writes fixture credentials only in an isolated test Hub and otherwise opens the CLI login', () => {
  const data = tmp();
  const id = pool.addAccount(data, {});
  const config = { command: 'codeagent', configDirEnv: 'CODEAGENT3_CONFIG_DIR' };
  const fixture = pool.openLoginWindow(data, id, config, { env: { CLAUDE_HUB_DATA_DIR: data, AI_HUB_CODEAGENT_POOL_LOGIN_FIXTURE: 'w00123' } });
  assert.equal(fixture.fixture, true);
  assert.equal(pool.readCredentials(pool.accountDir(data, id)).present, true);
  if (process.platform !== 'win32') return;
  const calls = [];
  const spawnFn = (file, args, options) => { calls.push({ file, args, options }); return { on() {}, unref() {} }; };
  pool.openLoginWindow(data, id, config, { env: { PATH: 'x', CODEAGENT_HUB_PORT: '1' }, spawnFn });
  assert.equal(calls.length, 1);
  assert.match(calls[0].args.join(' '), /auth login --method idaas/);
  assert.equal(calls[0].options.env.CODEAGENT3_CONFIG_DIR, pool.accountDir(data, id));
  assert.equal(calls[0].options.cwd, pool.accountDir(data, id));
  assert.equal('CODEAGENT_HUB_PORT' in calls[0].options.env, false);
});

test('localCandidates lists logged-in .cac* dirs under the scan root and importLocal copies them into the pool', () => {
  const data = tmp(), home = tmp();
  const env = { CLAUDE_HUB_DATA_DIR: data, AI_HUB_CODEAGENT_POOL_SCAN_ROOT: home };
  const personalDir = path.join(home, '.cac');
  writeCreds(personalDir, 'devUCOAuth', { accountId: 'y00000002', expiresAt: Date.now() + 3600e3 });
  const second = path.join(home, '.cac-deepseek');
  writeCreds(second, 'idaasOAuth', { accountId: 'x00000001', expiresAt: Date.now() + 3600e3 });
  fs.writeFileSync(path.join(second, 'settings.json'), JSON.stringify({ model: 'deepseek-v4-flash-0731', hooks: { Stop: [] } }));
  fs.writeFileSync(path.join(second, '.cac.json'), JSON.stringify({ enterpriseModelOptionsCache: [{ value: 'deepseek-v4-flash-0731' }] }));
  fs.mkdirSync(path.join(home, '.cac-empty'));
  fs.mkdirSync(path.join(home, 'Documents'));
  const list = pool.localCandidates(data, { personalDir, env });
  assert.deepEqual(list.map(c => c.name), ['.cac', '.cac-deepseek'], 'only .cac* dirs with credentials');
  assert.equal(list[0].isPersonal, true);
  assert.equal(list[1].accountLabel, 'x000****01');
  assert.throws(() => pool.importLocal(data, personalDir, { personalDir, env }), /个人账号/);
  assert.throws(() => pool.importLocal(data, path.join(home, 'Documents'), { personalDir, env }), /不在本机已登录/);
  const id = pool.importLocal(data, second, { personalDir, env });
  const imported = pool.listAccounts(data, { personalAccountId: 'y00000002' }).find(a => a.id === id);
  assert.equal(imported.state, 'ready');
  assert.equal(imported.accountLabel, 'x000****01');
  assert.equal(imported.note, '.cac-deepseek');
  assert.deepEqual(imported.models, ['deepseek-v4-flash-0731'], 'account model list comes along');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(pool.accountDir(data, id), 'settings.json'), 'utf8')), { model: 'deepseek-v4-flash-0731' });
  assert.equal(fs.existsSync(path.join(second, '.credentials.json')), true, 'source dir is left untouched');
  assert.equal(pool.localCandidates(data, { personalDir, env })[1].alreadyInPool, true);
  assert.throws(() => pool.importLocal(data, second, { personalDir, env }), /已经在号池里/);
});

test('model probe parses the CodeAgent model menu and probed lists win over config caches', () => {
  const probe = require('../core/codeagent-model-probe');
  const picker = require('../core/codeagent-model-picker');
  // 公司 CodeAgent 1.2615 菜单的形状（core/codeagent-model-picker.js 注释里的逐行原文）
  const lines = ['  Select model    ✕', '  ⌕ Search…', '  模型名称  Credit消耗系数', '  Built-in',
    '  ❯  1. GLM-5.2-WX-Auto default ✓   0x  Day', '     2. MiniMax-M2.7   1x', '', '  Navigate ↑ ↓ | Select enter | Back esc'];
  const parsed = probe.modelsFromPicker(picker.parsePicker(lines));
  assert.deepEqual(parsed, { models: ['GLM-5.2-WX-Auto', 'MiniMax-M2.7'], defaultModel: 'GLM-5.2-WX-Auto' });
  assert.equal(probe.cleanModelId('deepseek-v4 default ✓'), 'deepseek-v4');
  assert.equal(probe.cleanModelId('rm -rf /'), '');
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.cac.json'), JSON.stringify({ enterpriseModelOptionsCache: [{ value: 'GLM-5.2-WX-Auto' }] }));
  assert.deepEqual(pool.accountModels(dir).models, ['GLM-5.2-WX-Auto']);
  probe.writeProbed(path.join(dir, probe.MODELS_FILE), { models: ['deepseek-v4-flash-0731'], defaultModel: 'deepseek-v4-flash-0731' });
  const probed = pool.accountModels(dir);
  assert.deepEqual(probed.models, ['deepseek-v4-flash-0731']);
  assert.equal(probed.authoritative, true);
  assert.ok(probed.probedAt);
});

test('model probe drives a CLI through its own /model menu and reports login prompts', async () => {
  const probe = require('../core/codeagent-model-probe');
  const { EventEmitter } = require('node:events');
  const makePty = script => ({ spawn: () => {
    const ee = new EventEmitter(); let killed = false;
    const p = { onData: f => ee.on('data', f), onExit: f => ee.on('exit', f), write: data => script.onInput(data, d => ee.emit('data', d)), kill: () => { killed = true; ee.emit('exit'); } };
    setTimeout(() => script.onStart(d => ee.emit('data', d)), 10);
    p.killed = () => killed; return p;
  } });
  const ready = { onStart: emit => emit('> Anything I can assist you with?\r\n'), onInput: (data, emit) => {
    if (data === '\r') emit('\x1b[2J\x1b[H  Select model    ✕\r\n  ❯  1. deepseek-v4-flash-0731 default ✓\r\n\r\n  Navigate ↑ ↓ | Select enter | Back esc\r\n');
  } };
  const ok = await probe.probeModels({ command: 'codeagent', configDirEnv: 'CODEAGENT3_CONFIG_DIR', configDir: tmp(), cwd: path.join(tmp(), 'cwd'), ptyModule: makePty(ready), readyTimeoutMs: 3000, menuTimeoutMs: 3000 });
  assert.deepEqual(ok, { ok: true, models: ['deepseek-v4-flash-0731'], defaultModel: 'deepseek-v4-flash-0731' });
  const login = { onStart: emit => emit('Starting IDaaS login...\r\nW3 用户名: '), onInput: () => {} };
  const needs = await probe.probeModels({ command: 'codeagent', configDirEnv: 'CODEAGENT3_CONFIG_DIR', configDir: tmp(), cwd: path.join(tmp(), 'cwd'), ptyModule: makePty(login), readyTimeoutMs: 3000 });
  assert.equal(needs.ok, false);
  assert.match(needs.error, /重新登录/);
});
