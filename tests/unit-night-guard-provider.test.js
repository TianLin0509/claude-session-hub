'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  nightGuardNativeIdentity,
  nightGuardProvider,
} = require('../core/night-guard-provider.js');

test('night guard supports Claude Code, Codex and current DeepSeek runtime only', () => {
  assert.equal(nightGuardProvider({ kind: 'claude', ccSessionId: 'cc-1' }), 'claude');
  assert.equal(nightGuardProvider({ kind: 'claude-resume', ccSessionId: 'cc-2' }), 'claude');
  assert.equal(nightGuardProvider({ kind: 'codex', codexSid: 'cx-1' }), 'codex');
  assert.equal(nightGuardProvider({ kind: 'deepseek', codexSid: 'ds-1' }), 'codex');
  assert.equal(nightGuardProvider({ kind: 'deepseek', ccSessionId: 'legacy', codexSid: null }), null);
  assert.equal(nightGuardProvider({ kind: 'deepseek-legacy', ccSessionId: 'legacy' }), null);
  assert.equal(nightGuardProvider({ kind: 'gemini' }), null);
});

test('native recovery identity follows the guarded provider', () => {
  assert.deepEqual(nightGuardNativeIdentity({ kind: 'claude', ccSessionId: 'cc-1' }), {
    family: 'claude', field: 'ccSessionId', value: 'cc-1',
  });
  assert.deepEqual(nightGuardNativeIdentity({ kind: 'codex', codexSid: 'cx-1' }), {
    family: 'codex', field: 'codexSid', value: 'cx-1',
  });
});
