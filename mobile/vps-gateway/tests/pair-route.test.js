'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { handlePair, onPairResultFactory } = require('../routes/pair');
const { Relay } = require('../lib/relay');
const { PinRateLimiter, DeviceTokenCache } = require('../lib/auth');
const { MSG, ERR } = require('../../shared/protocol');

function fakeWs() {
  return {
    readyState: 1,
    _sent: [],
    send(s) { this._sent.push(JSON.parse(s)); },
    close() { this.readyState = 3; },
  };
}

function fakeReq(body) {
  const req = new EventEmitter();
  req.method = 'POST';
  req.socket = { remoteAddress: '127.0.0.1' };
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function fakeRes() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    writableEnded: false,
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers || {};
    },
    end(body = '') {
      this.body = String(body || '');
      this.writableEnded = true;
    },
    json() {
      return this.body ? JSON.parse(this.body) : {};
    },
  };
}

function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timeout'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test('POST /api/pair routes request only to selected hubId and returns that hubId', async () => {
  const relay = new Relay();
  const hubA = fakeWs();
  const hubB = fakeWs();
  relay.setHub(hubA, { hubId: 'hub-a', pid: 111 });
  relay.setHub(hubB, { hubId: 'hub-b', pid: 222 });
  hubA._sent.length = 0;
  hubB._sent.length = 0;

  const pendingPairs = new Map();
  const rateLimiter = new PinRateLimiter();
  const deviceTokenCache = new DeviceTokenCache();
  const res = fakeRes();

  handlePair({ relay, rateLimiter, pendingPairs })(
    fakeReq({ pin: '063551', deviceName: 'Phone', hubId: 'hub-b' }),
    res,
  );

  await waitFor(() => hubB._sent.length === 1);
  assert.equal(hubA._sent.length, 0);
  assert.equal(hubB._sent[0].type, MSG.PAIR_REQUEST);
  assert.equal(hubB._sent[0].pin, '063551');
  assert.equal(pendingPairs.size, 1);

  const requestId = hubB._sent[0].requestId;
  onPairResultFactory({ rateLimiter, pendingPairs, deviceTokenCache })({
    type: MSG.PAIR_RESULT,
    requestId,
    ok: true,
    deviceToken: '0123456789abcdef0123456789abcdef',
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    deviceToken: '0123456789abcdef0123456789abcdef',
    hubId: 'hub-b',
  });
});

test('POST /api/pair rejects selected hubId when that hub is offline', async () => {
  const relay = new Relay();
  const hubA = fakeWs();
  relay.setHub(hubA, { hubId: 'hub-a', pid: 111 });

  const res = fakeRes();
  handlePair({
    relay,
    rateLimiter: new PinRateLimiter(),
    pendingPairs: new Map(),
  })(fakeReq({ pin: '063551', hubId: 'missing-hub' }), res);

  await waitFor(() => res.writableEnded);
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, ERR.AGENT_OFFLINE);
  assert.equal(hubA._sent.length, 0);
});
