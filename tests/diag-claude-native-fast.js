'use strict';
// Real capability probe for the Claude speed switch. No model turn is sent and
// no production Hub process is touched: it starts one isolated transport, reads
// the engine's own fast-mode state and exercises apply_flag_settings.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ClaudeStreamClient } = require('../main/claude-stream-client');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-claude-fast-probe-'));
  const configDir = path.join(root, 'config');
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(configDir); fs.mkdirSync(cwd);
  const executable = process.platform === 'win32'
    ? path.join(os.homedir(), '.local', 'bin', 'claude.exe') : 'claude';
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
  // Subscription credentials are what decide whether Fast is even offered, so
  // the probe copies them into the isolated profile exactly like the real one.
  const source = path.join(os.homedir(), '.claude', '.credentials.json');
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(configDir, '.credentials.json'));
  const settingsFile = path.join(configDir, 'overlay.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ fastMode: false }), 'utf8');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_HUB_') || key.startsWith('ARENA_HUB_')) delete env[key];
  }
  const client = new ClaudeStreamClient({ executable, env, cwd,
    launchArgs: ['--model', 'claude-opus-5[1m]', '--settings', settingsFile], initializeTimeoutMs: 60000 });
  const result = { provider: 'claude', version, executable, scope: 'speed switch control only; no model turn' };
  try {
    const info = await client.start();
    result.initialFastModeState = info.fast_mode_state ?? null;
    result.fastModeDisabledReason = info.fast_mode_disabled_reason ?? null;
    for (const enabled of [true, false, true]) {
      const at = Date.now();
      const response = await client.control({ subtype: 'apply_flag_settings', settings: { fastMode: enabled } });
      (result.switches ||= []).push({ enabled, response, durationMs: Date.now() - at });
    }
  } finally { await client.close(); }
  const dir = path.resolve(__dirname, '..', 'artifacts', 'native-agent');
  fs.mkdirSync(dir, { recursive: true });
  const evidencePath = path.join(dir, 'claude-fast-' + Date.now() + '.json');
  fs.writeFileSync(evidencePath, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify({ pass: result.switches.length === 3, version,
    initialFastModeState: result.initialFastModeState, evidencePath }));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
