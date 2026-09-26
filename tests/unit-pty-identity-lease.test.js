'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { SessionManager } = require('../core/session-manager');
const { SessionOpenOwnership, nativeKeys } = require('../core/session-open-ownership');

test('switching CLI threads releases the ended identity while keeping the live thread exclusive', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pty-lease-'));
  const owners = new SessionOpenOwnership({directory:root});
  try {
    const sm = new SessionManager();
    const env = {CODEX_HOME:root};
    const lease = owners.claim('card', nativeKeys('codex', {codexSid:'old'}, env));
    lease.env = env;
    sm.openOwners = owners; sm.openLeases = new Map([['card', lease]]);
    const info = {id:'card',kind:'codex',agentRuntime:'pty',codexSid:'new'};
    sm.sessions.set('card', {info,pty:{pid:process.pid}});
    sm._refreshOpenIdentity('card');
    const old = owners.claim('history', nativeKeys('codex', {codexSid:'old'}, env));
    assert.throws(() => owners.claim('conflict', nativeKeys('codex', {codexSid:'new'}, env)), /已在 AI HUB/);
    owners.release(old); owners.release(lease);
  } finally { owners.close(); }
});
