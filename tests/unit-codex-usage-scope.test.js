'use strict';

const assert = require('assert');
const path = require('path');
const {
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
