'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEEPSEEK_CODEX_BASE_URL,
  DEEPSEEK_CODEX_MIN_VERSION,
  DEEPSEEK_CODEX_MODEL,
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

test('isolated profile uses Responses API, an env key, and the official Flash catalog', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ds-codex-'));
  try {
    const project = path.join(root, 'AI', 'demo');
    fs.mkdirSync(project, { recursive: true });
    const profile = ensureDeepSeekCodexProfile(project, { dataDir: path.join(root, 'hub-data') });
    const config = fs.readFileSync(profile.configPath, 'utf8');
    const catalog = JSON.parse(fs.readFileSync(profile.catalogPath, 'utf8'));

    assert.strictEqual(profile.model, 'deepseek-v4-flash');
    assert.strictEqual(DEEPSEEK_CODEX_MODEL, 'deepseek-v4-flash');
    assert.strictEqual(DEEPSEEK_CODEX_BASE_URL, 'https://api.deepseek.com/');
    assert.strictEqual(DEEPSEEK_CODEX_MIN_VERSION, '0.144.0');
    assert.match(config, /model_provider = "deepseek"/);
    assert.match(config, /base_url = "https:\/\/api\.deepseek\.com\/"/);
    assert.match(config, /env_key = "DEEPSEEK_API_KEY"/);
    assert.match(config, /wire_api = "responses"/);
    assert.match(config, /model_catalog_json = /);
    assert.doesNotMatch(config, /experimental_bearer_token|sk-[A-Za-z0-9]/,
      'the API key must never be written into the profile');
    assert.deepStrictEqual(catalog.models.map(model => model.slug), ['deepseek-v4-flash']);
    assert.strictEqual(catalog.models[0].minimal_client_version, '0.144.0');
    assert.strictEqual(catalog.models[0].context_window, 1048576);
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

test('session launch exports only the DeepSeek key and runs codex with Flash', () => {
  assert.match(SESSION_MANAGER_SRC, /sessionEnv\.DEEPSEEK_API_KEY = cv\.DEEPSEEK_API_KEY/);
  assert.match(SESSION_MANAGER_SRC, /delete sessionEnv\.ANTHROPIC_BASE_URL/);
  assert.match(SESSION_MANAGER_SRC, /sessionEnv\.CODEX_HOME = profile\.codexHome/);
  assert.match(SESSION_MANAGER_SRC, /const codexModel = isDeepSeek \? DEEPSEEK_CODEX_MODEL/);
  assert.match(SESSION_MANAGER_SRC, /if \(isCodexRuntime\) \{/);
  assert.match(SESSION_MANAGER_SRC, /cmd = ` codex --dangerously-bypass-approvals-and-sandbox --model \$\{codexModel\}/);
  assert.match(SESSION_MANAGER_SRC, /if \(isDeepSeekLegacy\) \{/,
    'pre-migration Claude transcripts must retain an explicit compatibility branch');
});

if (!process.exitCode) console.log('All DeepSeek Codex profile tests passed.');
