'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  readCodexAuthInfo,
  resolveCodexUsageScope,
  filterUsageCacheForCodexScope,
  attachCodexUsageScope,
  sameCodexUsageScope,
} = require('../core/codex-usage-scope.js');

function test(name, fn) {
  try {
    fn();
    console.log(`  OK ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

const homeDir = path.join('C:\\', 'Users', 'lintian');
const hubDataDir = path.join(homeDir, '.claude-session-hub');
const secondHome = path.join(homeDir, '.codex-profiles', 'second');

console.log('Running codex usage scope tests...');

function fakeJwt(payload) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `header.${encoded}.signature`;
}

function writeAuth(home, data) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(data), 'utf8');
}

test('subscription default resolves to ~/.codex/sessions', () => {
  const scope = resolveCodexUsageScope({
    codexBackend: 'subscription',
    codexSubscriptionProfile: 'default',
    codexSubscriptionProfiles: [
      { id: 'default', label: 'Main', home: '' },
      { id: 'second', label: 'Second', home: secondHome },
    ],
  }, { homeDir, hubDataDir });
  assert.strictEqual(scope.profileId, 'default');
  assert.strictEqual(scope.sessionsRoot, path.join(homeDir, '.codex', 'sessions'));
});

test('subscription scope reads current CODEX_HOME auth identity', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codex-auth-'));
  const lastRefresh = '2026-06-08T16:23:11.373Z';
  writeAuth(tmpHome, {
    tokens: {
      account_id: 'acct-current',
      id_token: fakeJwt({ email: 'current@example.com', name: 'Current User', sub: 'auth0|current' }),
    },
    last_refresh: lastRefresh,
  });
  const auth = readCodexAuthInfo(tmpHome);
  assert.strictEqual(auth.accountId, 'acct-current');
  assert.strictEqual(auth.accountEmail, 'current@example.com');
  assert.strictEqual(auth.authSinceMs, new Date(lastRefresh).getTime());

  const scope = resolveCodexUsageScope({
    codexBackend: 'subscription',
    codexSubscriptionProfile: 'default',
    codexSubscriptionProfiles: [{ id: 'default', label: 'Main', home: tmpHome }],
  }, { homeDir, hubDataDir });
  assert.strictEqual(scope.accountEmail, 'current@example.com');
  assert.ok(scope.scopeKey.includes(':auth:acct-current'));
});

test('subscription second resolves to configured CODEX_HOME sessions', () => {
  const scope = resolveCodexUsageScope({
    codexBackend: 'subscription',
    codexSubscriptionProfile: 'second',
    codexSubscriptionProfiles: [
      { id: 'default', label: 'Main', home: '' },
      { id: 'second', label: 'Second', home: secondHome },
    ],
  }, { homeDir, hubDataDir });
  assert.strictEqual(scope.profileId, 'second');
  assert.strictEqual(scope.sessionsRoot, path.join(secondHome, 'sessions'));
});

test('api backend resolves to isolated hub codex profile', () => {
  const scope = resolveCodexUsageScope({
    codexBackend: 'api',
    codexApiKey: 'sk-test',
  }, { homeDir, hubDataDir });
  assert.strictEqual(scope.profileId, 'api');
  assert.strictEqual(scope.sessionsRoot, path.join(hubDataDir, 'codex-api-profile', 'sessions'));
});

test('legacy unscoped cache is accepted only for default profile', () => {
  const legacyCache = { codex: { usage5h: { pct: 81 }, usage7d: { pct: 96 } } };
  const defaultScope = resolveCodexUsageScope({
    codexBackend: 'subscription',
    codexSubscriptionProfile: 'default',
    codexSubscriptionProfiles: [{ id: 'default', label: 'Main', home: '' }],
  }, { homeDir, hubDataDir });
  const secondScope = resolveCodexUsageScope({
    codexBackend: 'subscription',
    codexSubscriptionProfile: 'second',
    codexSubscriptionProfiles: [
      { id: 'default', label: 'Main', home: '' },
      { id: 'second', label: 'Second', home: secondHome },
    ],
  }, { homeDir, hubDataDir });
  assert.ok(filterUsageCacheForCodexScope(legacyCache, defaultScope).codex);
  assert.ok(!filterUsageCacheForCodexScope(legacyCache, secondScope).codex);
});

test('scoped cache survives same profile and is removed for another profile', () => {
  const secondScope = resolveCodexUsageScope({
    codexBackend: 'subscription',
    codexSubscriptionProfile: 'second',
    codexSubscriptionProfiles: [
      { id: 'default', label: 'Main', home: '' },
      { id: 'second', label: 'Second', home: secondHome },
    ],
  }, { homeDir, hubDataDir });
  const defaultScope = resolveCodexUsageScope({
    codexBackend: 'subscription',
    codexSubscriptionProfile: 'default',
    codexSubscriptionProfiles: [{ id: 'default', label: 'Main', home: '' }],
  }, { homeDir, hubDataDir });
  const scoped = attachCodexUsageScope({ usage5h: { pct: 1 }, usage7d: { pct: 0 } }, secondScope);
  assert.ok(sameCodexUsageScope(scoped, secondScope));
  assert.ok(!sameCodexUsageScope(scoped, defaultScope));
  assert.ok(filterUsageCacheForCodexScope({ codex: scoped }, secondScope).codex);
  assert.ok(!filterUsageCacheForCodexScope({ codex: scoped }, defaultScope).codex);
});

console.log('All codex usage scope tests passed.');
