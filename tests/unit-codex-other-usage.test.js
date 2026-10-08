'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { createCodexOtherProfilesUsage } = require('../main/usage/codex-other-profiles-usage');

function setup(t, { current = 'second', authModes = { default: 'chatgpt', second: 'chatgpt' } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-other-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const homes = {};
  for (const id of Object.keys(authModes)) {
    homes[id] = path.join(dir, id);
    fs.mkdirSync(homes[id]);
    fs.writeFileSync(path.join(homes[id], 'auth.json'), JSON.stringify({ auth_mode: authModes[id] }));
  }
  const config = { proxy: 'http://127.0.0.1:7890', codexSubscriptionProfile: current,
    codexSubscriptionProfiles: Object.keys(homes).map(id => ({ id, label: id === 'default' ? '副账号 · DB' : '主账号', home: homes[id] })) };
  const scope = cfg => {
    const p = cfg.codexSubscriptionProfiles.find(x => x.id === cfg.codexSubscriptionProfile);
    return { backend: 'subscription', profileId: p.id, profileLabel: p.label, home: p.home, accountEmail: p.id + '@example.com', scopeKey: 'subscription:' + p.id + ':acct' };
  };
  let clock = 1_000_000;
  const reads = [];
  let fail = null;
  const usage = createCodexOtherProfilesUsage({
    getConfig: () => config, currentScope: () => scope(config), resolveScope: scope,
    readUsage: async opts => { reads.push(opts); if (fail) throw Error(fail); return { usage5h: { pct: 12, resetsAt: '2026-10-08T10:00:00Z' }, usage7d: { pct: 40 }, observedAt: clock }; },
    file: path.join(dir, 'codex-other-usage.json'), now: () => clock,
  });
  return { usage, reads, config, homes, dir, tick: ms => { clock += ms; }, setFail: v => { fail = v; } };
}

test('the account not in use is listed and read through its own CODEX_HOME', async t => {
  const { usage, reads, homes } = setup(t);
  assert.deepEqual(usage.list().map(r => [r.profileId, r.profileLabel, r.observedAt]), [['default', '副账号 · DB', 0]]);
  const list = await usage.refresh();
  assert.deepEqual(reads.map(r => [r.home, r.proxy]), [[homes.default, 'http://127.0.0.1:7890']], 'only the other account, with its own home');
  assert.equal(list[0].usage5h.pct, 12); assert.equal(list[0].usage7d.pct, 40); assert.equal(list[0].accountEmail, 'default@example.com');
});

test('opening the popover again within two minutes does not query again; 刷新 does', async t => {
  const { usage, reads, tick } = setup(t);
  await usage.refresh(); await usage.refresh();
  assert.equal(reads.length, 1);
  tick(60_000); await usage.refresh({ force: true });
  assert.equal(reads.length, 2, 'the person pressed 刷新');
  tick(121_000); await usage.refresh();
  assert.equal(reads.length, 3);
});

test('a failed read keeps the last real numbers and says why', async t => {
  const { usage, tick, setFail } = setup(t);
  await usage.refresh();
  setFail('网络超时'); tick(200_000);
  const [row] = await usage.refresh();
  assert.equal(row.usage7d.pct, 40); assert.equal(row.error, '网络超时');
});

test('an API-key account is listed without a query; switching accounts swaps who is listed', async t => {
  const { usage, reads, config } = setup(t, { authModes: { default: 'apikey', second: 'chatgpt' } });
  const [row] = await usage.refresh();
  assert.equal(row.apiKey, true); assert.equal(reads.length, 0);
  config.codexSubscriptionProfile = 'default';
  assert.deepEqual(usage.list().map(r => r.profileId), ['second']);
});

test('readings survive a Hub restart through the small cache file', async t => {
  const { usage, dir, config } = setup(t);
  await usage.refresh();
  const again = createCodexOtherProfilesUsage({ getConfig: () => config,
    currentScope: () => ({ backend: 'subscription', profileId: 'second', scopeKey: 'subscription:second:acct' }),
    resolveScope: cfg => ({ backend: 'subscription', profileId: cfg.codexSubscriptionProfile, profileLabel: 'x', home: path.join(dir, cfg.codexSubscriptionProfile), scopeKey: 'subscription:' + cfg.codexSubscriptionProfile + ':acct' }),
    readUsage: async () => assert.fail('no query on startup'), file: path.join(dir, 'codex-other-usage.json') });
  assert.equal(again.list()[0].usage7d.pct, 40);
});
