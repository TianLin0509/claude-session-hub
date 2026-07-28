const assert = require('assert');
const { _private } = require('../core/session-manager.js');
const { DEFAULT_MODEL_BY_KIND } = require('../core/model-options.js');

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

// "隐式默认"的判定基准是 DEFAULT_MODEL_BY_KIND.claude —— 群聊创建器即使用户没碰过
// model picker 也会把它提交上来，所以这个值等同于"没选"。原测试把它写死成
// claude-opus-4-8[1m]，订阅默认升到 claude-opus-5[1m] 后哨兵失效、断言随之过期。
// 这里改为引用真实默认值，默认再变也不会假失败。
test('Claude launch model follows backend default while explicit selection wins', () => {
  const SUBSCRIPTION_DEFAULT = DEFAULT_MODEL_BY_KIND.claude;
  const apiEnv = {
    CLAUDE_BACKEND: 'api',
    CLAUDE_API_KEY: 'sk-test-claude',
    CLAUDE_API_MODEL: 'claude-fable-5',
  };

  // 没传 model → API 后端的 CLAUDE_API_MODEL 生效
  assert.strictEqual(_private.resolveClaudeLaunchModel(apiEnv), 'claude-fable-5');

  // 传的就是订阅默认值 → 视为"没真正选过"，仍由 CLAUDE_API_MODEL 接管
  assert.strictEqual(
    _private.resolveClaudeLaunchModel(apiEnv, SUBSCRIPTION_DEFAULT), 'claude-fable-5');

  // 订阅后端 → CLAUDE_API_MODEL 不参与，回落订阅默认值
  assert.strictEqual(_private.resolveClaudeLaunchModel({
    CLAUDE_BACKEND: 'subscription',
    CLAUDE_API_KEY: 'sk-test-claude',
    CLAUDE_API_MODEL: 'claude-fable-5',
  }), SUBSCRIPTION_DEFAULT);

  // 真正选了别的（新建会话弹窗的模型选择器就走这条）→ 显式选择必须赢
  assert.strictEqual(
    _private.resolveClaudeLaunchModel(apiEnv, 'claude-opus-4-8'), 'claude-opus-4-8');
  assert.notStrictEqual(SUBSCRIPTION_DEFAULT, 'claude-opus-4-8',
    'sanity: the explicit case must not accidentally equal the implicit sentinel');
});

console.log('Claude API env tests passed.');
