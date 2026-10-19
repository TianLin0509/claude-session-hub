'use strict';
// 读 CodeAgent 登录凭证（core/codeagent-pool.js readCredentials，2026-10-19）：公司 2.1.15 直查个人账号「凭证读不到」，
// 要能分清原因；BOM 不算读不懂；CodeAgent 自己的登录项优先于 Claude 的 claudeAiOauth。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pool = require('../core/codeagent-pool');

function dirWith(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-creds-'));
  if (content !== null) fs.writeFileSync(path.join(dir, '.credentials.json'), content);
  return dir;
}

test('文件开头有 BOM 照样读出登录项', () => {
  const creds = pool.readCredentials(dirWith('﻿' + JSON.stringify({ idaasOAuth: { accountId: 'w00111111', expiresAt: Date.now() + 3600000 } })));
  assert.equal(creds.present, true);
  assert.equal(creds.method, 'idaas');
  assert.equal(pool.accountState(creds), 'ready');
});

test('同时有 Claude 的 claudeAiOauth 和 CodeAgent 的 idaasOAuth：用 CodeAgent 的', () => {
  const creds = pool.readCredentials(dirWith(JSON.stringify({ claudeAiOauth: { accessToken: 'x' }, idaasOAuth: { accountId: 'w00111111', expiresAt: Date.now() + 3600000 } })));
  assert.equal(creds.method, 'idaas');
  assert.equal(creds.accountId, 'w00111111');
});

test('只有大小写不同的登录项（xxxOauth）也认', () => {
  const creds = pool.readCredentials(dirWith(JSON.stringify({ w3Oauth: { accountId: 'w00111111' } })));
  assert.equal(creds.present, true);
  assert.equal(creds.method, 'w3');
});

test('读不懂时带原因，不带凭证内容', () => {
  const noLogin = pool.readCredentials(dirWith(JSON.stringify({ note: 'expired', token: 'SECRET-VALUE' })));
  assert.equal(pool.accountState(noLogin), 'unreadable');
  assert.match(noLogin.detail, /没有登录项（顶层键：note、token）/);
  assert.doesNotMatch(noLogin.detail, /SECRET/);
  const notJson = pool.readCredentials(dirWith('AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA'));
  assert.equal(pool.accountState(notJson), 'unreadable');
  assert.match(notJson.detail, /不是 JSON（\d+ 字节）/);
  assert.equal(pool.readCredentials(dirWith('')).detail, '文件是空的');
  const missing = pool.readCredentials(dirWith(null));
  assert.equal(pool.accountState(missing), 'login-required');
  assert.equal(missing.detail, undefined);
});
