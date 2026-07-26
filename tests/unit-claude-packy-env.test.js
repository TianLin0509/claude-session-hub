const assert = require('assert');
const { _private } = require('../core/session-manager.js');

function test(name, fn) {
  try {
    fn();
    console.log(`  OK ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

console.log('Running Claude API env tests...');

test('API mode clears proxy env and injects Anthropic-compatible token env', () => {
  const env = {
    HTTP_PROXY: 'http://127.0.0.1:7890',
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    ALL_PROXY: 'socks5://127.0.0.1:7890',
    NO_PROXY: 'localhost',
    ANTHROPIC_API_KEY: 'old-api-key',
    ANTHROPIC_API_BASE_URL: 'https://old-base.invalid',
  };

  const mode = _private.applyClaudeSessionEnv(env, {
    CLAUDE_BACKEND: 'api',
    CLAUDE_API_KEY: 'sk-test-claude',
    CLAUDE_API_BASE_URL: 'https://claude-gateway.example.com',
  });

  assert.strictEqual(mode, 'api');
  assert.strictEqual(env.ANTHROPIC_BASE_URL, 'https://claude-gateway.example.com');
  assert.strictEqual(env.ANTHROPIC_AUTH_TOKEN, 'sk-test-claude');
  assert.strictEqual(env.CLAUDE_CODE_ATTRIBUTION_HEADER, '0');
  assert.strictEqual(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.strictEqual(env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE, '1');
  assert.strictEqual(env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_API_BASE_URL']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(env, key), `${key} should be removed`);
  }
});

test('subscription mode strips custom endpoint env and keeps configured proxy', () => {
  const env = {
    ANTHROPIC_BASE_URL: 'https://claude-gateway.example.com',
    ANTHROPIC_AUTH_TOKEN: 'sk-test-claude',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'true',
  };

  const mode = _private.applyClaudeSessionEnv(env, {
    CLAUDE_BACKEND: 'subscription',
    CLAUDE_PROXY: 'http://127.0.0.1:7890',
  });

  assert.strictEqual(mode, 'subscription');
  assert.strictEqual(env.HTTP_PROXY, 'http://127.0.0.1:7890');
  assert.strictEqual(env.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.strictEqual(env.NO_PROXY, 'localhost,127.0.0.1');
  assert.ok(!Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_BASE_URL'));
  assert.ok(!Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_AUTH_TOKEN'));
  assert.strictEqual(env.ENABLE_CLAUDEAI_MCP_SERVERS, 'true',
    'subscription mode should preserve an explicit user connector preference');
});

test('API mode disables Claude fast settings injection', () => {
  assert.strictEqual(_private.shouldUseClaudeFastSettings({
    CLAUDE_BACKEND: 'api',
    CLAUDE_API_KEY: 'sk-test-claude',
  }), false);
  assert.strictEqual(_private.shouldUseClaudeFastSettings({
    CLAUDE_BACKEND: 'subscription',
    CLAUDE_API_KEY: '',
  }), true);
});

test('Claude launch model follows backend default while explicit selection wins', () => {
  assert.strictEqual(_private.resolveClaudeLaunchModel({
    CLAUDE_BACKEND: 'api',
    CLAUDE_API_KEY: 'sk-test-claude',
    CLAUDE_API_MODEL: 'claude-fable-5',
  }), 'claude-fable-5');
  assert.strictEqual(_private.resolveClaudeLaunchModel({
    CLAUDE_BACKEND: 'api',
    CLAUDE_API_KEY: 'sk-test-claude',
    CLAUDE_API_MODEL: 'claude-fable-5',
  }, 'claude-opus-4-8[1m]'), 'claude-fable-5');
  assert.strictEqual(_private.resolveClaudeLaunchModel({
    CLAUDE_BACKEND: 'subscription',
    CLAUDE_API_KEY: 'sk-test-claude',
    CLAUDE_API_MODEL: 'claude-fable-5',
  }), 'claude-opus-4-8[1m]');
  assert.strictEqual(_private.resolveClaudeLaunchModel({
    CLAUDE_BACKEND: 'api',
    CLAUDE_API_KEY: 'sk-test-claude',
    CLAUDE_API_MODEL: 'claude-fable-5',
  }, 'claude-opus-4-8'), 'claude-opus-4-8');
});

console.log('Claude API env tests passed.');
