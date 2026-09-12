'use strict';
// Real capability probe for the Claude command channel: the engine runs its own
// slash commands when they arrive as user text and answers locally, so no model
// call is made. Isolated profile; no production Hub process is touched.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ClaudeNativeSession } = require('../core/claude-native-session');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-claude-command-probe-'));
  const configDir = path.join(root, 'config');
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(configDir); fs.mkdirSync(cwd);
  const executable = process.platform === 'win32'
    ? path.join(os.homedir(), '.local', 'bin', 'claude.exe') : 'claude';
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
  const source = path.join(os.homedir(), '.claude', '.credentials.json');
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(configDir, '.credentials.json'));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_HUB_') || key.startsWith('ARENA_HUB_')) delete env[key];
  }
  const session = new ClaudeNativeSession({ id: 'command-probe', kind: 'claude', cwd, env, executable,
    launchArgs: ['--model', 'claude-opus-5[1m]', '--permission-mode', 'default'],
    initializeTimeoutMs: 60000, submissionTimeoutMs: 120000 });
  const result = { provider: 'claude', version, scope: 'engine command channel only; no model turn' };
  try {
    await session.start();
    result.commands = (session.client.initialization.commands || []).map(item => item.name);
    for (const command of ['/effort high', '/effort banana', '/plan', '/plan off']) {
      const at = Date.now();
      let answer; try { answer = await session.slash(command); } catch (error) { answer = { ok: false, commandOutput: 'ERR ' + error.message }; }
      (result.runs ||= []).push({ command, ok: answer.ok, durationMs: Date.now() - at,
        output: String(answer.commandOutput || '').slice(0, 200) });
    }
    result.permissionMode = session.runtime.permissionMode;
    // A local command must not have cost a model turn.
    result.cardCount = session.transcript().length;
  } finally { await session.close(); }
  const dir = path.resolve(__dirname, '..', 'artifacts', 'native-agent');
  fs.mkdirSync(dir, { recursive: true });
  const evidencePath = path.join(dir, 'claude-commands-' + Date.now() + '.json');
  fs.writeFileSync(evidencePath, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify({ pass: result.runs.every(run => run.ok), version,
    commandCount: result.commands.length, runs: result.runs.map(r => [r.command, r.durationMs + 'ms']),
    permissionMode: result.permissionMode, evidencePath }));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
