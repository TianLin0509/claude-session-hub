'use strict';
// 号池端到端测试用的假 CodeAgent：记下每次启动拿到的配置目录、工作目录和参数；
// 像真 CLI 一样按「配置目录里 settings.json 登记的 SessionStart hook」向 Hub 报到（顺带验证 Hub 部署到号池目录的 hook 能用），
// 并在 <配置目录>/projects/<转义的工作目录>/<id>.jsonl 写一条会话记录，供 --resume 找到。
// 屏幕照公司 CodeAgent 1.2615 的实录画：空闲时「> Anything I can assist you with?」，输入 /model 回车弹出「Select model」菜单，
// Esc 关闭。菜单里的模型按凭证里的工号定：z 开头的号只有 DeepSeek，其余只有 GLM（模拟各号模型权限不同）。
// 不调用任何模型，也不需要登录。
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
const isProbe = !process.env.CLAUDE_HUB_SESSION_ID;
let transcript = null;
if (configDir && !isProbe) {
  const dir = path.join(configDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  transcript = path.join(dir, `${sessionId}.jsonl`);
  if (!fs.existsSync(transcript)) {
    fs.writeFileSync(transcript, JSON.stringify({ type: 'user', sessionId, cwd, uuid: crypto.randomUUID(),
      timestamp: new Date().toISOString(), message: { role: 'user', content: 'fake' } }) + '\n');
  }
}
if (log) fs.appendFileSync(log, JSON.stringify({ at: Date.now(), cwd, args, configDir: configDir || null,
  hubSession: process.env.CLAUDE_HUB_SESSION_ID || null, sessionId, resumed: !!resumeId, probe: isProbe }) + '\n');

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
if (!isProbe) fireHook('SessionStart', 'session-start');

function accountModels() {
  let accountId = '';
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, '.credentials.json'), 'utf8'));
    const entry = Object.values(raw).find(v => v && typeof v === 'object');
    accountId = String(entry && entry.accountId || '');
  } catch { /* 没登录 */ }
  return /^z/i.test(accountId) ? ['deepseek-v4-flash-0731'] : ['GLM-5.2-WX-Auto'];
}
const out = text => process.stdout.write(text);
const prompt = () => out('\x1b[2J\x1b[H  CodeAgent (fake)\r\n\r\n> Anything I can assist you with?\r\n');
function menu() {
  const models = accountModels();
  out('\x1b[2J\x1b[H  Select model    ✕\r\n\r\n  Built-in\r\n');
  models.forEach((m, i) => out(`  ${i === 0 ? '❯' : ' '}  ${i + 1}. ${m}${i === 0 ? ' default ✓' : ''}   0x\r\n`));
  out('\r\n  Navigate ↑ ↓ | Select enter | Back esc\r\n');
}
if (process.stdin.isTTY) process.stdin.setRawMode(true);
prompt();
let typed = '';
process.stdin.on('data', chunk => {
  const text = chunk.toString('utf8');
  if (text.includes('\x1b')) { typed = ''; prompt(); return; }
  for (const ch of text) {
    if (ch === '\r' || ch === '\n') { if (/\/model\s*$/.test(typed)) menu(); else prompt(); typed = ''; }
    else typed += ch;
  }
});
setInterval(() => {}, 1 << 30);
