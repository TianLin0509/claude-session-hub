'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { THEME_SLUG, CLAUDE_THEME, ensureClaudeWarmGoldTheme, ensureCodexWarmGoldTheme } = require('../core/cli-warm-gold-theme');

test('Hub CLI themes are scoped to their own profiles and leave user settings alone', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cli-theme-'));
  try {
    const claude = path.join(root, 'claude');
    const codex = path.join(root, 'codex');
    fs.mkdirSync(claude);
    fs.mkdirSync(codex);
    fs.writeFileSync(path.join(claude, 'settings.json'), '{"theme":"light"}');
    fs.writeFileSync(path.join(codex, 'config.toml'), 'model = "gpt-5.6-sol"\n');
    assert.equal(ensureClaudeWarmGoldTheme({ CLAUDE_CONFIG_DIR: claude }), `custom:${THEME_SLUG}`);
    assert.equal(ensureCodexWarmGoldTheme({ CODEX_HOME: codex }), THEME_SLUG);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(claude, 'themes', THEME_SLUG + '.json'), 'utf8')), CLAUDE_THEME);
    assert.match(fs.readFileSync(path.join(codex, 'themes', THEME_SLUG + '.tmTheme'), 'utf8'), /<key>scope<\/key>/);
    assert.equal(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'), '{"theme":"light"}');
    assert.equal(fs.readFileSync(path.join(codex, 'config.toml'), 'utf8'), 'model = "gpt-5.6-sol"\n');
    assert.equal(ensureClaudeWarmGoldTheme({ CLAUDE_CONFIG_DIR: claude }), `custom:${THEME_SLUG}`);
    assert.equal(ensureCodexWarmGoldTheme({ CODEX_HOME: codex }), THEME_SLUG);
    fs.writeFileSync(path.join(claude, 'themes', THEME_SLUG + '.json'), '{"name":"mine"}');
    assert.throws(() => ensureClaudeWarmGoldTheme({ CLAUDE_CONFIG_DIR: claude }), /Existing CLI theme differs/);
    assert.equal(fs.readFileSync(path.join(claude, 'themes', THEME_SLUG + '.json'), 'utf8'), '{"name":"mine"}');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
