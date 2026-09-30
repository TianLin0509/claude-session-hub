'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const guard = require('../core/web-risk-guard');
function root(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-risk-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('sites are recognised from any of their hosts, unknown hosts are not guessed', () => {
  assert.equal(guard.siteOf('https://chatgpt.com/c/abc'), 'chatgpt');
  assert.equal(guard.siteOf('https://auth.openai.com/log-in'), 'chatgpt');
  assert.equal(guard.siteOf('https://www.doubao.com/chat/'), 'doubao');
  assert.equal(guard.siteOf('https://gemini.google.com/app'), 'google', 'account page key for Gemini');
  assert.equal(guard.siteOf('https://example.org/'), null);
  assert.equal(guard.siteOf('not a url'), null);
});

test('a challenge pauses only that identity and site, with growing backoff', t => {
  const dir = root(t), now = 1_000_000;
  const first = guard.recordChallenge(dir, { identity: 'alt', site: 'chatgpt', kind: 'cloudflare', now });
  assert.equal(first.until - now, guard.BACKOFF_MS[0]);
  const second = guard.recordChallenge(dir, { identity: 'alt', site: 'chatgpt', kind: 'cloudflare', now: now + 1000 });
  assert.equal(second.strikes, 2);
  assert.equal(second.until - (now + 1000), guard.BACKOFF_MS[1]);
  assert.equal(second.since, now, 'a repeated challenge keeps the original start');
  assert.ok(guard.blocked(dir, 'alt', 'chatgpt', now + 2000));
  assert.equal(guard.blocked(dir, 'main', 'chatgpt', now + 2000), null);
  assert.equal(guard.blocked(dir, 'alt', 'gemini', now + 2000), null);
  assert.equal(guard.blocked(dir, 'alt', 'chatgpt', second.until + 1), null, 'backoff expires by itself');
  assert.ok(guard.clearSite(dir, 'alt', 'chatgpt'));
  assert.equal(guard.read(dir).sites['alt:chatgpt'], undefined);
});

test('strikes are forgotten after a quiet day but survive a person releasing the site', t => {
  const dir = root(t), now = 5_000_000;
  guard.recordChallenge(dir, { identity: 'main', site: 'kimi', now });
  assert.equal(guard.recordChallenge(dir, { identity: 'main', site: 'kimi', now: now + 25 * 3600000 }).strikes, 1);
  const later = now + 30 * 3600000;
  guard.recordChallenge(dir, { identity: 'alt', site: 'chatgpt', now: later });
  assert.ok(guard.releaseSite(dir, 'alt', 'chatgpt', later + 1000));
  assert.equal(guard.blocked(dir, 'alt', 'chatgpt', later + 1001), null, 'released: automation may try once');
  const again = guard.recordChallenge(dir, { identity: 'alt', site: 'chatgpt', now: later + 2000 });
  assert.equal(again.strikes, 2);
  assert.equal(again.until - (later + 2000), guard.BACKOFF_MS[1]);
});

test('automation is refused during a handoff and for a challenged site, with stable codes', t => {
  const dir = root(t), now = Date.now();
  assert.doesNotThrow(() => guard.assertAutomationAllowed(dir, { identity: 'main', url: 'https://chatgpt.com/', now }));
  const lease = guard.startHandoff(dir, { identity: 'alt', site: 'chatgpt', now });
  assert.throws(() => guard.assertAutomationAllowed(dir, { identity: 'main', url: 'https://kimi.com/', now }), e => e.code === 'HUB_HUMAN_HANDOFF' && /^Human handoff/.test(e.message));
  assert.equal(guard.endHandoff(dir, 'someone-else'), false, 'only the lease owner ends it');
  assert.ok(guard.endHandoff(dir, lease.id));
  guard.recordChallenge(dir, { identity: 'alt', site: 'chatgpt', now });
  assert.throws(() => guard.assertAutomationAllowed(dir, { identity: 'alt', url: 'https://chatgpt.com/c/x', now }), e => e.code === 'HUB_SITE_CHALLENGED' && /^Site challenged/.test(e.message));
  assert.doesNotThrow(() => guard.assertAutomationAllowed(dir, { identity: 'main', url: 'https://chatgpt.com/', now }));
  assert.doesNotThrow(() => guard.assertAutomationAllowed(dir, { identity: 'alt', now }), 'steps without a URL are not site-gated');
});

test('an abandoned handoff expires so automation cannot stay stopped forever', t => {
  const dir = root(t), now = Date.now();
  guard.startHandoff(dir, { identity: 'alt', site: 'chatgpt', now: now - guard.HANDOFF_MS - 1 });
  assert.equal(guard.handoff(dir, now), null);
  assert.doesNotThrow(() => guard.assertAutomationAllowed(dir, { identity: 'alt', now }));
});

test('a challenged page is recorded and sent to about:blank', async t => {
  const dir = root(t), visited = [];
  const page = { evaluate: async () => ({ challenge: true, kind: 'cloudflare' }), url: () => 'https://chatgpt.com/', goto: async u => visited.push(u) };
  const entry = await guard.inspectAndLeave(dir, { identity: 'alt', page, source: 'unit' });
  assert.equal(entry.site, 'chatgpt');
  assert.deepEqual(visited, ['about:blank']);
  const calm = { evaluate: async () => ({ challenge: false }), url: () => 'https://chatgpt.com/', goto: async u => visited.push(u) };
  assert.equal(await guard.inspectAndLeave(dir, { identity: 'main', page: calm }), null);
  assert.equal(visited.length, 1);
});

test('the probe recognises the observed Cloudflare page and leaves ordinary pages alone', () => {
  const vm = require('vm');
  const run = ({ title = '', html = '', url = 'https://chatgpt.com/', text = '', cf = false }) => vm.runInNewContext(guard.CHALLENGE_PROBE, {
    window: cf ? { _cf_chl_opt: {} } : {},
    document: { title, body: { innerText: text }, querySelector: sel => (html && sel.split(',').some(s => html.includes(s.replace(/[\[\]"*=]/g, '').split(/[#.]/).pop()))) ? {} : null },
    location: { href: url },
  });
  assert.deepEqual({ ...run({ title: 'Just a moment...', cf: true }) }, { challenge: true, kind: 'cloudflare' });
  assert.equal(run({ title: '请稍候…', cf: true }).kind, 'cloudflare', 'Cloudflare localises the title');
  assert.equal(run({ title: 'Just a moment...' }).challenge, false, 'a title without Cloudflare script is not proof');
  assert.equal(run({ title: 'ChatGPT', text: 'Ready when you are.' }).challenge, false);
  assert.equal(run({ url: 'https://www.google.com/sorry/index?continue=x' }).kind, 'google_unusual_traffic');
  assert.equal(run({ text: '请完成安全验证后继续' }).kind, 'text');
});

test('challenge-state cookie names never include login cookies', () => {
  for (const name of ['cf_clearance', '__cf_bm', 'cf_chl_rc_ni', 'cf_chl_rc_i']) assert.match(name, guard.CHALLENGE_COOKIE);
  for (const name of ['__Secure-next-auth.session-token.0', 'oai-did', '_puid', 'SID', '__Secure-1PSID']) assert.doesNotMatch(name, guard.CHALLENGE_COOKIE);
});

test('concurrent writers from several processes keep every record', async t => {
  const dir = root(t);
  const { execFile } = require('child_process');
  const script = `const g=require(${JSON.stringify(path.resolve(__dirname, '../core/web-risk-guard.js'))});for(let i=0;i<10;i++)g.recordChallenge(${JSON.stringify(dir)},{identity:process.argv[1],site:'s'+i});`;
  await Promise.all(['main', 'alt'].map(id => new Promise((resolve, reject) => execFile(process.execPath, ['-e', script, id], e => e ? reject(e) : resolve()))));
  assert.equal(Object.keys(guard.read(dir).sites).length, 20);
});
