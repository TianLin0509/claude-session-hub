'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createClaudeUsageRefresh } = require('../main/usage/claude-usage-refresh');
function setup() {
  let time = 1_000_000, calls = 0, cached = null, sessions = [], fail = false, hold;
  const published = [], errors = [];
  const service = createClaudeUsageRefresh({ now: () => time, getSessions: () => sessions,
    getCached: () => cached, publish: value => published.push(value), onError: e => errors.push(e),
    refresh: async () => { calls++; if (hold) await hold; if (fail) throw Error('offline');
      cached = { usage5h: { pct: calls, resetsAt: time + 3600000 }, ts: time };
      return { data: cached, source: 'claude-native' }; } });
  return { service, published, errors, get calls() { return calls; }, get cached() { return cached; },
    advance: ms => { time += ms; }, setCache: value => { cached = value; }, setHold: p => { hold = p; },
    fail: () => { fail = true; }, recover: () => { fail = false; },
    sessions: value => { sessions = value; } };
}
test('startup with no writer does not open one; native connection automatically refreshes', async () => {
  const h = setup(); await h.service.tick(); assert.equal(h.calls, 0);
  h.sessions([{ id: 'ordinary', epoch: 1, state: 'idle' }]);
  await h.service.tick(); assert.equal(h.calls, 1); assert.equal(h.published.at(-1).usage5h.pct, 1);
  h.advance(60000); await h.service.tick(); assert.equal(h.calls, 1);
  h.advance(240000); await h.service.tick(); assert.equal(h.calls, 2);
});
test('ordinary and group activity, completion and focus refresh with one account rate limit', async () => {
  const h = setup(); const session = { id: 'group-member', epoch: 1, state: 'running', userMessageId: 'turn' };
  h.sessions([session]); await h.service.tick();
  h.advance(30000); await h.service.tick(); assert.equal(h.calls, 1);
  h.advance(30000); await h.service.tick(); assert.equal(h.calls, 2);
  session.state = 'completed'; await h.service.tick(); assert.equal(h.calls, 2);
  h.advance(30000); await h.service.tick(); assert.equal(h.calls, 3);
  await h.service.tick('focus'); assert.equal(h.calls, 3);
  h.advance(30000); await h.service.tick(); assert.equal(h.calls, 4);
});
test('manual and background requests share a flight without duplicated transport calls', async () => {
  const h = setup(); h.sessions([{ id: 's', state: 'running' }]);
  let resolve; h.setHold(new Promise(r => { resolve = r; }));
  const a = h.service.tick(), b = h.service.refresh();
  assert.equal(a, b); await Promise.resolve(); assert.equal(h.calls, 1);
  resolve(); await a;
});
test('failure keeps quota timestamp, backs off despite focus, and recovers automatically', async () => {
  const h = setup(); h.sessions([{ id: 's', state: 'running' }]); await h.service.tick();
  const before = h.cached; h.fail(); h.advance(60000); await h.service.tick();
  assert.equal(h.cached, before); assert.equal(h.errors.length, 1);
  h.advance(30000); await h.service.tick('focus'); assert.equal(h.calls, 2);
  h.advance(30000); await h.service.tick(); assert.equal(h.calls, 3);
  h.recover(); h.advance(60000); await h.service.tick(); assert.equal(h.calls, 3);
  h.advance(60000); await h.service.tick(); assert.equal(h.calls, 4);
  assert.ok(h.cached.ts > before.ts);
});
test('reset deadline and shared cache advances update idle windows without resetting quota locally', async () => {
  const h = setup(); h.sessions([{ id: 's', state: 'idle' }]); await h.service.tick();
  h.cached.usage5h.resetsAt = h.cached.ts + 30000;
  h.advance(30000); await h.service.tick(); assert.equal(h.calls, 2);
  h.sessions([]); h.setCache({ usage5h: { pct: 99 }, ts: h.cached.ts + 1000 });
  await h.service.tick(); assert.equal(h.calls, 2); assert.equal(h.published.at(-1).usage5h.pct, 99);
});
test('shutdown prevents polling and late result broadcasts', async () => {
  const h = setup(); h.sessions([{ id: 's', state: 'running' }]);
  let resolve; h.setHold(new Promise(r => { resolve = r; })); const pending = h.service.tick();
  await Promise.resolve(); h.service.stop(); resolve(); await pending;
  await h.service.tick('focus'); assert.equal(h.calls, 1); assert.equal(h.published.length, 0);
});
test('manual errors propagate and a stale fallback is not counted as a successful native read', async () => {
  const h = setup(); h.fail(); await assert.rejects(h.service.refresh(), /offline/);
  const errors = [];
  const service = createClaudeUsageRefresh({ getSessions: () => [{ id: 's' }], getCached: () => null,
    publish: () => assert.fail('must not publish'), refresh: async () => ({ source: 'statusline-cache', data: null }),
    onError: error => errors.push(error) });
  await service.tick(); assert.equal(errors.length, 1);
});
