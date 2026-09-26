'use strict';
// 探针：真实 Claude TUI 里 /clear、/exit 时 SessionStart / SessionEnd hook 的实际顺序与字段。
// 不发任何提问（不耗 token）；登录凭据临时拷进隔离目录，结束即删并核对原文件 hash。
// 用法：node tests/probe-claude-session-hooks.js
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const pty = require('node-pty');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-session-hooks-'));
const config = path.join(root, 'claude'), cwd = path.join(root, 'workspace'), log = path.join(root, 'hooks.jsonl');
fs.mkdirSync(config, { recursive: true }); fs.mkdirSync(cwd, { recursive: true });
const credentials = path.join(os.homedir(), '.claude', '.credentials.json');
const before = hash(credentials);
fs.copyFileSync(credentials, path.join(config, '.credentials.json'));
fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark',
  projects: { [cwd.replace(/\\/g, '/')]: { hasTrustDialogAccepted: true }, [cwd]: { hasTrustDialogAccepted: true } } }));
const recorder = path.join(root, 'record.py');
fs.writeFileSync(recorder, [
  'import sys, json, time, os',
  'data = json.loads(sys.stdin.buffer.read().decode("utf-8") or "{}")',
  'data["_event"] = sys.argv[1]; data["_at"] = time.time(); data["_ppid"] = os.getppid()',
  `open(${JSON.stringify(log)}, "a", encoding="utf-8").write(json.dumps(data, ensure_ascii=False) + "\\n")`,
].join('\n'));
const hook = name => [{ hooks: [{ type: 'command', command: `python "${recorder}" ${name}` }] }];
fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ hooks: { SessionStart: hook('SessionStart'), SessionEnd: hook('SessionEnd'), PreCompact: hook('PreCompact') } }, null, 2));

async function main() {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_HUB_SESSION_ID', 'CLAUDE_HUB_PORT', 'CLAUDE_HUB_TOKEN']) delete env[k];
  const sessionId = crypto.randomUUID();
  const p = pty.spawn('claude.exe', ['--model', 'claude-haiku-4-5-20251001', '--session-id', sessionId], { name: 'xterm-256color', cols: 120, rows: 40, cwd, env, useConpty: true });
  let screen = '';
  p.onData(d => { screen += d; });
  const waitFor = async (re, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (re.test(screen)) return true; await sleep(200); } return false; };
  const events = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
  const result = { launchedSessionId: sessionId, claudePid: p.pid, steps: [] };
  try {
    result.ready = await waitFor(/❯|Try "/, 60000);
    await sleep(2500);
    result.steps.push({ step: 'startup', events: events().length });
    if (process.argv.includes('--compact')) {
      // 需要一轮对话才能压缩：一条极短的 haiku 回答，然后带参数的 /compact。
      p.write('只回复 OK'); await sleep(600); p.write('\r'); await sleep(15000);
      p.write('/compact keep alpha notes'); await sleep(600); p.write('\r'); await sleep(35000);
      result.steps.push({ step: 'after /compact', events: events().length });
    }
    p.write('/clear'); await sleep(600); p.write('\r'); await sleep(6000);
    result.steps.push({ step: 'after /clear', events: events().length });
    p.write('/exit'); await sleep(600); p.write('\r'); await sleep(6000);
    result.steps.push({ step: 'after /exit', events: events().length });
  } finally {
    try { p.kill(); } catch {}
    await sleep(500);
    try { fs.unlinkSync(path.join(config, '.credentials.json')); } catch {}
    result.credentialsUntouched = hash(credentials) === before;
    result.copiedCredentialsRemoved = !fs.existsSync(path.join(config, '.credentials.json'));
    result.events = events().map(e => ({ event: e._event, at: e._at, ppid: e._ppid, session_id: e.session_id, source: e.source, reason: e.reason, trigger: e.trigger, custom_instructions: e.custom_instructions,
      transcript: e.transcript_path && path.basename(e.transcript_path), agent_id: e.agent_id || null, keys: Object.keys(e).filter(k => !k.startsWith('_')) }));
    const out = path.resolve('artifacts/cli-pty-core/probe-claude-session-hooks-' + Date.now() + '.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ out, ...result }, null, 2));
  }
}
main();
