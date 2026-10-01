'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { invalidApiCredential, assertUsableCredential } = require('../core/codex-auth-validation');
test('malformed bearer credentials are diagnosed without leaking their contents', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.doesNotThrow(() => assertUsableCredential(dir));
  for (const key of ['请先阅读任务背景', 'key\nvalue', 'key value', 123]) {
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: key }));
    assert.throws(() => assertUsableCredential(dir), error => /重新授权/.test(error.message) && !error.message.includes(String(key)));
    const config = { codexSubscriptionProfile: 'default', codexSubscriptionProfiles: [{ id: 'default', home: dir }] };
    assert.throws(() => require('../core/codex-global-account').prepareLaunch({}, config, {}), /未发送请求/);
    const rows = require('../core/cli-auth').cliAuthStatus({ env: { CLAUDE_HUB_HOME_DIR: dir }, config });
    assert.equal(rows[0].state, 'invalid');
    assert(!JSON.stringify(rows).includes(String(key)));
  }
  assert.equal(invalidApiCredential({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: {} }), false);
  assert.equal(invalidApiCredential({ OPENAI_API_KEY: 'provider-specific-valid-key' }), false);
});
