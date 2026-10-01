'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const {SLUG, CLAUDE_THEME, CODEX_THEME, ensureClaudeTheme, ensureCodexTheme} = require('../core/cli-coldwhite-theme');
const gold = require('../core/cli-warm-gold-theme');

test('light CLI themes remain per-launch, preserve user preferences and protect existing files', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-coldwhite-theme-'));
  const env={CLAUDE_CONFIG_DIR:path.join(root,'claude'),CODEX_HOME:path.join(root,'codex')};
  for(const home of Object.values(env))fs.mkdirSync(home);
  const original='{"theme":"dark","unrelated":true}';
  fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR,'settings.json'),original);
  fs.writeFileSync(path.join(env.CODEX_HOME,'config.toml'),'[tui]\ntheme = "user-choice"\n');
  try {
    assert.equal(ensureClaudeTheme(env,'codex'),'custom:'+SLUG);
    assert.equal(ensureCodexTheme(env,'codex'),SLUG);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR,'themes',SLUG+'.json'),'utf8')),CLAUDE_THEME);
    assert.equal(CLAUDE_THEME.base,'light');
    assert.equal(fs.readFileSync(path.join(env.CODEX_HOME,'themes',SLUG+'.tmTheme'),'utf8'),CODEX_THEME);
    assert.equal(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR,'settings.json'),'utf8'),original);
    assert.equal(fs.readFileSync(path.join(env.CODEX_HOME,'config.toml'),'utf8'),'[tui]\ntheme = "user-choice"\n');
    assert.equal(ensureClaudeTheme(env,'dark'),'custom:'+gold.THEME_SLUG);
    assert.equal(ensureCodexTheme(env,'frost'),gold.THEME_SLUG);
    const file=path.join(env.CODEX_HOME,'themes',SLUG+'.tmTheme');
    fs.writeFileSync(file,'user replacement');
    assert.throws(()=>ensureCodexTheme(env,'codex'),/Existing CLI theme differs/);
    assert.equal(fs.readFileSync(file,'utf8'),'user replacement');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
