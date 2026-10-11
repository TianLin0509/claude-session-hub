'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEEPSEEK_CODEX_BASE_URL,
  DEEPSEEK_CODEX_MIN_VERSION,
  DEEPSEEK_CODEX_MODEL,
  DEEPSEEK_CODEX_MODELS,
  ensureDeepSeekCodexProfile,
} = require('../core/deepseek-codex-profile.js');

const SESSION_MANAGER_SRC = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');

function test(name, fn) {
  try {
    fn();
    console.log(`  OK ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

console.log('Running DeepSeek Codex profile tests...');

test('isolated profile uses Responses API, an env key, and the Pro/Flash catalog', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ds-codex-'));
  try {
    const project = path.join(root, 'AI', 'demo');
    fs.mkdirSync(project, { recursive: true });
    const profile = ensureDeepSeekCodexProfile(project, { dataDir: path.join(root, 'hub-data') });
    const config = fs.readFileSync(profile.configPath, 'utf8');
    const catalog = JSON.parse(fs.readFileSync(profile.catalogPath, 'utf8'));

    assert.strictEqual(profile.model, 'deepseek-v4-flash');
    assert.strictEqual(DEEPSEEK_CODEX_MODEL, 'deepseek-v4-flash');
    assert.deepStrictEqual(DEEPSEEK_CODEX_MODELS, ['deepseek-v4-pro', 'deepseek-v4-flash']);
    assert.strictEqual(DEEPSEEK_CODEX_BASE_URL, 'https://api.deepseek.com/');
    assert.strictEqual(DEEPSEEK_CODEX_MIN_VERSION, '0.144.0');
    assert.match(config, /model_provider = "deepseek"/);
    assert.match(config, /base_url = "https:\/\/api\.deepseek\.com\/"/);
    assert.match(config, /env_key = "DEEPSEEK_API_KEY"/);
    assert.match(config, /wire_api = "responses"/);
    assert.match(config, /model_catalog_json = /);
    assert.doesNotMatch(config, /experimental_bearer_token|sk-[A-Za-z0-9]/,
      'the API key must never be written into the profile');
    assert.deepStrictEqual(catalog.models.map(model => model.slug), ['deepseek-v4-pro', 'deepseek-v4-flash']);
    for (const model of catalog.models) {
      assert.strictEqual(model.minimal_client_version, '0.144.0');
      assert.strictEqual(model.context_window, 1048576);
      assert.strictEqual(model.supported_in_api, true);
      assert.strictEqual(model.tool_mode, 'direct');
      assert.strictEqual(model.supports_search_tool, false);
    }
    assert.strictEqual(catalog.models[0].display_name, 'DeepSeek-V4-Pro');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('trusted cwd entries accumulate instead of replacing another live session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ds-trust-'));
  try {
    const dataDir = path.join(root, 'hub-data');
    const first = path.join(root, 'Wireless', 'one');
    const second = path.join(root, 'Stock', 'two');
    fs.mkdirSync(first, { recursive: true });
    fs.mkdirSync(second, { recursive: true });
    ensureDeepSeekCodexProfile(first, { dataDir });
    const profile = ensureDeepSeekCodexProfile(second, { dataDir });
    const trusted = JSON.parse(fs.readFileSync(profile.trustedProjectsPath, 'utf8'));
    const config = fs.readFileSync(profile.configPath, 'utf8');

    assert.deepStrictEqual(new Set(trusted.map(item => path.resolve(item).toLowerCase())), new Set([
      path.resolve(first).toLowerCase(),
      path.resolve(second).toLowerCase(),
    ]));
    assert.ok(config.includes(JSON.stringify(path.resolve(first))));
    assert.ok(config.includes(JSON.stringify(path.resolve(second))));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function parseToml(text) {
  const result = require('node:child_process').spawnSync('python', ['-c',
    'import sys,json,tomllib;print(json.dumps(tomllib.loads(sys.stdin.read())))'], {
    input: text, encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

// 2026-10-11：每次启动整份重写 config.toml，用户在 /hooks 审核页点的信任和 Codex 写的 [tui]
// 都被抹掉，下次启动又停在审核页。现在只接管 Hub 生成的顶层键。
test('repeated launches keep Codex-written [hooks.state.*] and [tui] while Hub keys are refreshed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ds-keep-'));
  try {
    const dataDir = path.join(root, 'hub-data');
    const first = path.join(root, 'one');
    const second = path.join(root, 'two');
    fs.mkdirSync(first, { recursive: true });
    fs.mkdirSync(second, { recursive: true });
    const profile = ensureDeepSeekCodexProfile(first, { dataDir });
    const hooksJson = path.join(profile.codexHome, 'hooks.json');
    const stateKey = `${hooksJson}:pre_tool_use:0:0`;
    // 模拟 Codex 与用户：信任一条 hook、禁用一条、写 [tui]；同时 Hub 键被改坏、[notice] 多了键。
    const userTail = [
      '',
      '[hooks.state]',
      '',
      `[hooks.state.'${stateKey}']`,
      'trusted_hash = "sha256:user-approved" # 用户在 /hooks 点的信任',
      '',
      `[hooks.state.'${hooksJson}:stop:0:1']`,
      'enabled = false',
      '',
      '[tui]',
      'screen_reader_detection_done = true',
      '',
      '[tui.model_availability_nux]',
      '"deepseek-v4-flash" = 2',
      '',
    ].join('\r\n');
    const tampered = fs.readFileSync(profile.configPath, 'utf8')
      .replace('model = "deepseek-v4-flash"', 'model = "something-else"')
      .replace('hide_full_access_warning = true', 'hide_full_access_warning = false\nextra_notice = 1');
    fs.writeFileSync(profile.configPath, tampered + userTail);

    const again = ensureDeepSeekCodexProfile(second, { dataDir });
    assert.strictEqual(again.configWarning, null);
    const text = fs.readFileSync(again.configPath, 'utf8');
    const doc = parseToml(text);
    assert.strictEqual(doc.model, 'deepseek-v4-flash', 'Hub key refreshed');
    assert.deepStrictEqual(doc.notice, { hide_rate_limit_model_nudge: true, hide_full_access_warning: true }, 'Hub-owned table regenerated');
    assert.strictEqual(doc.projects[path.resolve(second)].trust_level, 'trusted', 'new cwd trusted');
    assert.strictEqual(doc.projects[path.resolve(first)].trust_level, 'trusted', 'old cwd kept');
    assert.deepStrictEqual(doc.hooks.state[stateKey], { trusted_hash: 'sha256:user-approved' });
    assert.deepStrictEqual(doc.hooks.state[`${hooksJson}:stop:0:1`], { enabled: false });
    assert.deepStrictEqual(doc.tui, { screen_reader_detection_done: true, model_availability_nux: { 'deepseek-v4-flash': 2 } });
    assert.ok(text.includes('# 用户在 /hooks 点的信任'), 'preserved tables keep their original text');

    // 第三次：内容稳定，不再改写；Hub 键与保留表都不变。
    const before = fs.readFileSync(again.configPath, 'utf8');
    ensureDeepSeekCodexProfile(second, { dataDir });
    assert.strictEqual(fs.readFileSync(again.configPath, 'utf8'), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unreadable existing config.toml falls back to the plain Hub config instead of a broken merge', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ds-bad-'));
  try {
    const dataDir = path.join(root, 'hub-data');
    const profile = ensureDeepSeekCodexProfile(root, { dataDir });
    const clean = fs.readFileSync(profile.configPath, 'utf8');
    fs.writeFileSync(profile.configPath, clean + '\n[hooks.state\nbroken = \n');
    const again = ensureDeepSeekCodexProfile(root, { dataDir, logger: {} });
    assert.match(again.configWarning, /无法识别/);
    assert.strictEqual(fs.readFileSync(profile.configPath, 'utf8'), clean);
    parseToml(clean);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('session launch exports only the DeepSeek key and preserves the selected DeepSeek model', () => {
  assert.match(SESSION_MANAGER_SRC, /sessionEnv\.DEEPSEEK_API_KEY = cv\.DEEPSEEK_API_KEY/);
  assert.match(SESSION_MANAGER_SRC, /delete sessionEnv\.ANTHROPIC_BASE_URL/);
  assert.match(SESSION_MANAGER_SRC, /sessionEnv\.CODEX_HOME = profile\.codexHome/);
  assert.match(SESSION_MANAGER_SRC, /const codexModel = isDeepSeek[\s\S]{0,120}normalizeDeepSeekModel\(opts\.model\)/);
  assert.match(SESSION_MANAGER_SRC, /if \(isCodexRuntime\) \{/);
  assert.match(SESSION_MANAGER_SRC, /cmd = ` codex --dangerously-bypass-approvals-and-sandbox --model \$\{codexModel\}/);
  assert.match(SESSION_MANAGER_SRC, /if \(isDeepSeekLegacy\) \{/,
    'pre-migration Claude transcripts must retain an explicit compatibility branch');
});

if (!process.exitCode) console.log('All DeepSeek Codex profile tests passed.');
