'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { SessionManager } = require('../core/session-manager');
const { SessionOpenOwnership, nativeKeys } = require('../core/session-open-ownership');

test('Codex /new retains the previous writer lock until the CLI process exits', () => {
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
    assert.throws(() => owners.claim('history', nativeKeys('codex', {codexSid:'old'}, env)), /已在 AI HUB/);
    assert.throws(() => owners.claim('conflict', nativeKeys('codex', {codexSid:'new'}, env)), /已在 AI HUB/);
    owners.release(lease);
    owners.release(owners.claim('history', nativeKeys('codex', {codexSid:'old'}, env)));
  } finally { owners.close(); }
});
