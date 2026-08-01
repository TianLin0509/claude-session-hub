'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  hasManagedHook,
  ensureClaudeHookIntegration,
  startClaudeHookIntegrationWatchdog,
} = require('../core/claude-hook-integration.js');

function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-hook-integration-'));
  const claudeDir = path.join(root, '.claude');
  const sourceScriptsDir = path.join(root, 'source-scripts');
  fs.mkdirSync(sourceScriptsDir, { recursive: true });
  for (const name of ['session-hub-hook.py', 'claude-hub-statusline.js', 'deepseek_repl.py']) {
    fs.writeFileSync(path.join(sourceScriptsDir, name), `managed:${name}\n`, 'utf8');
  }
  return { root, claudeDir, sourceScriptsDir };
}

test('repairs missing Hub hooks without deleting unrelated user hooks', () => {
  const h = makeHarness();
  try {
    fs.mkdirSync(h.claudeDir, { recursive: true });
    const settingsPath = path.join(h.claudeDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'python user-guard.py' }] }],
        UserPromptSubmit: [],
      },
      customKey: { keep: true },
    }, null, 2), 'utf8');

    const first = ensureClaudeHookIntegration(h);
    assert.equal(first.settingsUpdated, true);
    assert.deepEqual(first.scriptsUpdated.sort(), [
      'claude-hub-statusline.js',
      'deepseek_repl.py',
      'session-hub-hook.py',
    ]);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(settings.customKey.keep, true);
    assert.equal(settings.hooks.Stop[0].hooks[0].command, 'python user-guard.py');
    assert.equal(hasManagedHook(settings, 'Stop'), true);
    assert.equal(hasManagedHook(settings, 'UserPromptSubmit'), true);

    const second = ensureClaudeHookIntegration(h);
    assert.equal(second.settingsUpdated, false);
    assert.deepEqual(second.scriptsUpdated, []);
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test('malformed settings are reported and never replaced with an empty file', () => {
  const h = makeHarness();
  try {
    fs.mkdirSync(h.claudeDir, { recursive: true });
    const settingsPath = path.join(h.claudeDir, 'settings.json');
    const broken = '{ "hooks": ';
    fs.writeFileSync(settingsPath, broken, 'utf8');
    const result = ensureClaudeHookIntegration(h);
    assert.equal(result.settingsUpdated, false);
    assert.match(result.errors.join('\n'), /有效 JSON/);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), broken);
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test('watchdog repairs hooks removed after startup', () => {
  const h = makeHarness();
  try {
    ensureClaudeHookIntegration(h);
    const settingsPath = path.join(h.claudeDir, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings.hooks.UserPromptSubmit = [];
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

    let scheduled = null;
    let stopped = false;
    const watchdog = startClaudeHookIntegrationWatchdog({
      claudeDirs: [h.claudeDir],
      sourceScriptsDir: h.sourceScriptsDir,
      setIntervalFn: (fn) => { scheduled = fn; return { unref() {} }; },
      clearIntervalFn: () => { stopped = true; },
      logger: { log() {}, warn() {} },
    });
    assert.equal(typeof scheduled, 'function');
    const results = watchdog.audit();
    assert.equal(results[0].settingsUpdated, true);
    const repaired = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(hasManagedHook(repaired, 'UserPromptSubmit'), true);
    watchdog.stop();
    assert.equal(stopped, true);
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});
