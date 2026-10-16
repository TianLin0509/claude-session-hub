'use strict';
// 号池端到端测试用的假 CodeAgent：记下每次启动拿到的配置目录、工作目录和参数；
// 像真 CLI 一样按「配置目录里 settings.json 登记的 SessionStart hook」向 Hub 报到（顺带验证 Hub 部署到号池目录的 hook 能用），
// 并在 <配置目录>/projects/<转义的工作目录>/<id>.jsonl 写一条会话记录，供 --resume 找到。不调用任何模型，也不需要登录。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const configDir = process.env.CODEAGENT3_CONFIG_DIR || '';
const log = process.env.CODEAGENT_POOL_FAKE_LOG;
const resumeAt = args.indexOf('--resume');
const resumeId = resumeAt >= 0 && /^[0-9a-f-]{36}$/i.test(args[resumeAt + 1] || '') ? args[resumeAt + 1] : null;
const sessionId = resumeId || crypto.randomUUID();
const cwd = process.cwd();
let transcript = null;
if (configDir) {
  const dir = path.join(configDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  transcript = path.join(dir, `${sessionId}.jsonl`);
  if (!fs.existsSync(transcript)) {
    fs.writeFileSync(transcript, JSON.stringify({ type: 'user', sessionId, cwd, uuid: crypto.randomUUID(),
      timestamp: new Date().toISOString(), message: { role: 'user', content: 'fake' } }) + '\n');
  }
}
if (log) fs.appendFileSync(log, JSON.stringify({ at: Date.now(), cwd, args, configDir: configDir || null,
  hubSession: process.env.CLAUDE_HUB_SESSION_ID || null, sessionId, resumed: !!resumeId }) + '\n');

function fireHook(event, name) {
  let settings = null;
  try { settings = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8')); } catch { return; }
  const groups = settings && settings.hooks && settings.hooks[event];
  if (!Array.isArray(groups)) return;
  const payload = JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd, hook_event_name: event, source: resumeId ? 'resume' : 'startup' });
  for (const group of groups) for (const hook of group.hooks || []) {
    if (hook.type !== 'command' || !hook.command) continue;
    const r = spawnSync(hook.command, { input: payload, shell: true, timeout: 10000, windowsHide: true, env: process.env });
    if (log) fs.appendFileSync(log, JSON.stringify({ at: Date.now(), hook: name, status: r.status, hubSession: process.env.CLAUDE_HUB_SESSION_ID || null }) + '\n');
  }
}
fireHook('SessionStart', 'session-start');
process.stdout.write('CodeAgent (fake) ready\r\n> ');
process.stdin.on('data', () => process.stdout.write('\r\n> '));
setInterval(() => {}, 1 << 30);
