'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Relay } = require('../lib/relay');
const { MSG, ERR, CONN } = require('../../shared/protocol');

function fakeWs() {
  return {
    readyState: 1,
    _sent: [],
    send(s) { this._sent.push(JSON.parse(s)); },
    close() { this.readyState = 3; },
    on() {},
  };
}

test('starts with no hub and no pwa', () => {
  const r = new Relay();
  assert.equal(r.isHubOnline(), false);
  assert.equal(r.stats().pwaCount, 0);
});

test('setHub marks hub online', () => {
  const r = new Relay();
  r.setHub(fakeWs());
  assert.equal(r.isHubOnline(), true);
});

test('setHub HELLO upgrade replaces legacy id for the same socket', () => {
  const r = new Relay();
  const hub = fakeWs();
  r.setHub(hub);
  r.setHub(hub, { hubId: 'hub-1', hostname: 'local' });
  const stats = r.stats();
  assert.equal(stats.hubCount, 1);
  assert.equal(stats.hubs[0].hubId, 'hub-1');
  assert.equal(stats.hubs[0].isLegacy, false);
});

test('closed hub sockets are purged from online hub list', () => {
  const r = new Relay();
  const hub = fakeWs();
  r.setHub(hub, { hubId: 'hub-closed', hostname: 'local' });
  hub.readyState = 3;
  assert.equal(r.isHubOnline(), false);
  assert.equal(r.listHubs().length, 0);
  assert.equal(r.stats().hubCount, 0);
});

test('removeHub removes every id bound to the same socket', () => {
  const r = new Relay();
  const hub = fakeWs();
  r.hubAgents.set('legacy-old', { ws: hub, info: {}, connectedAt: 1, hubId: 'legacy-old' });
  r.hubAgents.set('hub-new', { ws: hub, info: { hubId: 'hub-new' }, connectedAt: 2, hubId: 'hub-new' });
  r.hubAgent = hub;
  r.removeHub(hub);
  assert.equal(r.stats().hubCount, 0);
  assert.equal(r.isHubOnline(), false);
});

test('adding PWA with hub online sends OK conn-state immediately', () => {
  const r = new Relay();
  r.setHub(fakeWs());
  const pwa = fakeWs();
  r.addPwa('DT1', pwa, '1.2.3.4');
  assert.equal(pwa._sent[0].type, MSG.CONN_STATE);
  assert.equal(pwa._sent[0].state, CONN.OK);
});

test('adding PWA with hub offline sends HUB_OFF conn-state', () => {
  const r = new Relay();
  const pwa = fakeWs();
  r.addPwa('DT1', pwa, '1.2.3.4');
  assert.equal(pwa._sent[0].state, CONN.HUB_OFF);
});

test('forwardToHub injects deviceToken on outbound msg', () => {
  const r = new Relay();
  const hub = fakeWs();
  r.setHub(hub);
  hub._sent.length = 0;
  r.forwardToHub('DT1', { type: MSG.PWA_INPUT, content: 'hi' });
  assert.equal(hub._sent[0].type, MSG.PWA_INPUT);
  assert.equal(hub._sent[0].deviceToken, 'DT1');
  assert.equal(hub._sent[0].content, 'hi');
});

test('forwardToHub returns false and errors PWA when hub offline', () => {
  const r = new Relay();
  const pwa = fakeWs();
  r.addPwa('DT1', pwa, '1.2.3.4');
  pwa._sent.length = 0;
  const ok = r.forwardToHub('DT1', { type: MSG.PWA_INPUT, content: 'x' });
  assert.equal(ok, false);
  assert.equal(pwa._sent[0].type, MSG.ERROR);
  assert.equal(pwa._sent[0].code, ERR.AGENT_OFFLINE);
});

test('forwardToPwa hits correct device, not other devices', () => {
  const r = new Relay();
  const a = fakeWs();
  const b = fakeWs();
  r.addPwa('DT_A', a, '1.1.1.1');
  r.addPwa('DT_B', b, '2.2.2.2');
  a._sent.length = 0; b._sent.length = 0;
  r.forwardToPwa('DT_A', { type: MSG.TURN, seq: 5, content: 'reply' });
  assert.equal(a._sent.length, 1);
  assert.equal(b._sent.length, 0);
});

test('forwardToPwa returns false for unknown device', () => {
  const r = new Relay();
  const ok = r.forwardToPwa('UNKNOWN', { type: MSG.TURN });
  assert.equal(ok, false);
});

test('forwardToPwa updates lastSeq on TURN', () => {
  const r = new Relay();
  const pwa = fakeWs();
  r.addPwa('DT1', pwa, '1.1.1.1');
  r.forwardToPwa('DT1', { type: MSG.TURN, seq: 7 });
  assert.equal(r.stats().devices[0].lastSeq, 7);
  r.forwardToPwa('DT1', { type: MSG.TURN, seq: 3 }); // 不应回退
  assert.equal(r.stats().devices[0].lastSeq, 7);
});

test('hub disconnect broadcasts HUB_OFF to all PWA', () => {
  const r = new Relay();
  const hub = fakeWs();
  const pwa = fakeWs();
  r.setHub(hub);
  r.addPwa('DT1', pwa, '1.1.1.1');
  pwa._sent.length = 0;
  r.removeHub(hub);
  assert.equal(pwa._sent[0].type, MSG.CONN_STATE);
  assert.equal(pwa._sent[0].state, CONN.HUB_OFF);
});

test('replacing PWA closes old socket', () => {
  const r = new Relay();
  const oldWs = fakeWs();
  const newWs = fakeWs();
  r.addPwa('DT1', oldWs, '1.1.1.1');
  r.addPwa('DT1', newWs, '1.1.1.1');
  assert.equal(oldWs.readyState, 3, 'old ws should be closed');
});

test('removePwa only removes when ws matches (no orphan delete)', () => {
  const r = new Relay();
  const oldWs = fakeWs();
  const newWs = fakeWs();
  r.addPwa('DT1', oldWs, '1.1.1.1');
  r.addPwa('DT1', newWs, '1.1.1.1'); // replaces
  r.removePwa('DT1', oldWs); // stale close event, should be no-op
  assert.equal(r.stats().pwaCount, 1);
  r.removePwa('DT1', newWs);
  assert.equal(r.stats().pwaCount, 0);
});
