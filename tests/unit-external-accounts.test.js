'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { externalSite, githubStatus, readExternalState } = require('../core/external-accounts');
const { HubAccounts } = require('../core/hub-accounts');
const { main: githubBrowser } = require('../scripts/open-hub-github-auth');
test('GitHub JSON exit zero is not authentication success, and secrets never escape', async () => {
  const response = rows => (cmd, args, opts, done) => { assert.equal(opts.windowsHide, true); assert.equal(opts.timeout, 20000); done(null, JSON.stringify({ hosts: { 'github.com': rows } })); };
  const ok = await githubStatus({}, response([{ login: 'TianLin0509', state: 'success', active: true, token: 'SECRET' }]));
  assert.equal(ok.account, 'TianLin0509'); assert.equal(ok.state, 'signed_in'); assert.ok(!JSON.stringify(ok).includes('SECRET'));
  assert.equal((await githubStatus({}, response([{ login: 'x', state: 'error', active: true }]))).state, 'unknown');
  assert.equal((await githubStatus({}, response([]))).state, 'signed_out');
  const bad = await githubStatus({}, (cmd, args, opts, done) => done(Object.assign(Error('SECRET'), { code: 'ENOENT' }), 'SECRET'));
  assert.equal(bad.state, 'unknown'); assert.ok(!JSON.stringify(bad).includes('SECRET'));
});
test('external status projects known fields and rejects malformed stores', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'external-accounts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'external-accounts.json');
  fs.writeFileSync(file, JSON.stringify({ github: { state: 'signed_in', account: 'test-user', token: 'SECRET', message: 'SECRET', checkedAt: 42 }, yuque: { cookie: 'SECRET' } }));
  assert.ok(!JSON.stringify(readExternalState(root)).includes('SECRET'));
  fs.writeFileSync(file, '[]'); assert.throws(() => readExternalState(root), /无法读取/);
});
test('external websites and official GitHub device flow are pinned to managed main profile', async () => {
  assert.equal(externalSite('yuque').url, 'https://www.yuque.com/login');
  assert.throws(() => externalSite('__proto__'));
  const calls = [], chrome = { openWebsite: async (...args) => calls.push(args) };
  await githubBrowser(['https://github.com/login/device'], chrome);
  assert.deepEqual(calls, [['main', 'githubDevice']]);
  for (const url of ['http://github.com/login/device', 'https://github.com.evil/login/device', 'https://user@github.com/login/device', 'https://github.com/settings', 'file:///x']) await assert.rejects(githubBrowser([url], chrome));
  assert.equal(calls.length, 1);
});
test('isolated instances refuse native authorization and unsupported service actions', async () => {
  const fake = { env: { CLAUDE_HUB_HOME_DIR: 'isolated' }, chrome: {}, setup: {}, fixture: () => null };
  for (const action of ['check', 'authorize']) await assert.rejects(HubAccounts.prototype.external.call(fake, { service: 'github', action }), /隔离/);
  await assert.rejects(HubAccounts.prototype.external.call(fake, { service: 'yuque', action: 'authorize' }), /专属/);
  await assert.rejects(HubAccounts.prototype.external.call(fake, { service: 'githubDevice', action: 'open' }), /无效/);
});
