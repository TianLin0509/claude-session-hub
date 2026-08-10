'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { _private } = require('../core/session-manager.js');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');

test('overseas proxy policy removes inherited conflicting variables and writes both cases', () => {
  const env = {
    ALL_PROXY: 'socks5://127.0.0.1:9999',
    all_proxy: 'socks5://127.0.0.1:9999',
    HTTP_PROXY: 'http://127.0.0.1:8888',
    http_proxy: 'http://127.0.0.1:7777',
  };
  assert.equal(_private.applyProxyEnv(env, 'http://127.0.0.1:7890'), true);
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7890');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.equal(env.http_proxy, 'http://127.0.0.1:7890');
  assert.equal(env.https_proxy, 'http://127.0.0.1:7890');
  assert.equal(env.ALL_PROXY, undefined);
  assert.equal(env.all_proxy, undefined);
});

test('current launch routing keeps Claude/Codex/Gemini subscription on proxy and Kimi/DeepSeek direct', () => {
  assert.match(SOURCE, /if \(isClaude\)[\s\S]*?applyClaudeSessionEnv\(sessionEnv, cv\)/);
  assert.match(SOURCE, /else if \(isGemini \|\| isCodex\)[\s\S]*?applyProxyEnv\(sessionEnv, cv\.CLAUDE_PROXY\)/);
  assert.match(SOURCE, /else if \(isDeepSeek\)[\s\S]*?clearProxyEnv\(sessionEnv\)/);
  assert.match(SOURCE, /else if \(isKimi\)[\s\S]*?clearProxyEnv\(sessionEnv\)/);
});
