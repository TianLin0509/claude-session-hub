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
