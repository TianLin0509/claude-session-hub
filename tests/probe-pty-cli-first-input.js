'use strict';
// 诊断探针（不进单测）：在隔离配置里起真实 CLI，把 PTY 画面还原成文字，
// 观察第一次粘贴前后屏幕上是什么。用法：
//   node tests/probe-pty-cli-first-input.js codex|claude
const fs = require('fs'), os = require('os'), path = require('path');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { writeBracketedPaste } = require('../core/pty-prompt-submit');

const which = process.argv[2] || 'codex';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-probe-'));
const cwd = path.join(root, 'work'); fs.mkdirSync(cwd);
const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE_') || ['CLAUDECODE', 'CLAUDE_HUB_SESSION_ID', 'CLAUDE_HUB_PORT', 'CLAUDE_HUB_TOKEN', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID'].includes(k)) delete env[k];
let cmd;
if (which === 'codex') {
  const home = path.join(root, 'codex'); fs.mkdirSync(home);
  fs.copyFileSync(path.join(os.homedir(), '.codex', 'auth.json'), path.join(home, 'auth.json'));
  const cache = path.join(os.homedir(), '.codex', 'models_cache.json');
  if (fs.existsSync(cache)) fs.copyFileSync(cache, path.join(home, 'models_cache.json'));
  fs.writeFileSync(path.join(home, 'config.toml'), `model = "gpt-5.5"\nmodel_reasoning_effort = "low"\n\n[tui.model_availability_nux]\n"gpt-5.5" = 4\n\n[projects.'${cwd.toLowerCase()}']\ntrust_level = "trusted"\n`);
  if (process.argv.includes('--hooks')) console.log(JSON.stringify(require('../core/codex-hook-integration').ensureCodexHookIntegration({ codexHome: home, logger: {} })));
  env.CODEX_HOME = home;
  cmd = ' codex --dangerously-bypass-approvals-and-sandbox --model gpt-5.5' + (process.argv.includes('--hooks') ? ' -c features.hooks=true' : '') + '\r\n';
} else {
  cmd = ' claude --model claude-haiku-4-5-20251001 --effort low'
    + (process.argv.includes('--default-mode') ? ' --permission-mode default' : '')
    + (process.argv.includes('--session-id') ? ' --session-id ' + require('crypto').randomUUID() : '') + '\r\n';
}
const term = new Terminal({ cols: 120, rows: 30, allowProposedApi: true });
const p = pty.spawn('powershell.exe', ['-NoProfile', '-NoLogo'], { name: 'xterm-256color', cols: 120, rows: 30, cwd, env, useConpty: true, conptyInheritCursor: false });
let raw = '';
p.onData(d => { raw += d; term.write(d); });
const screen = () => { const b = term.buffer.active; const lines = []; for (let i = 0; i < b.length; i++) lines.push(b.getLine(i).translateToString(true)); return lines.filter(l => l.trim()).slice(-24).join('\n'); };
(async () => {
  await sleep(1500); p.write(cmd);
  await sleep(Number(process.env.PROBE_WAIT_MS || 15000));
  console.log('===== BEFORE PASTE =====\n' + screen());
  const sm = { writeToSession: (_sid, data) => p.write(data) };
  await writeBracketedPaste(sm, 's', '不要调用任何工具，只回复 PROBE_OK。');
  await sleep(1500);
  console.log('===== AFTER PASTE =====\n' + screen());
  p.write('\r');
  await sleep(12000);
  console.log('===== AFTER ENTER =====\n' + screen());
  p.kill();
  setTimeout(() => process.exit(0), 500);
})();
