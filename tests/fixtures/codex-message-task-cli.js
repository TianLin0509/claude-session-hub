'use strict';
// Offline CLI fixture: real PTY, hook binding, prompt acknowledgement and
// rollout tail; no model requests. Mirrors the reported 0.159.3 event order.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
if (process.argv.includes('--version')) { console.log('codex-cli 0.159.3'); process.exit(0); }
if (process.argv[2] === 'app-server') process.exit(0);
const sid = '019effff-0159-7000-8000-000000000159', turnId = 'message-task-turn';
const dir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '10', '02');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'rollout-2026-10-02T00-00-00-' + sid + '.jsonl');
const append = payload => fs.appendFileSync(file, JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload }) + '\n');
fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', timestamp: new Date().toISOString(), payload: {
  id: sid, cwd: process.cwd(), timestamp: new Date().toISOString(), cli_version: '0.159.3', source: 'cli', originator: 'codex_cli_rs',
} }) + '\n');
const hook = (event, fields = {}) => new Promise((resolve, reject) => {
  const body = JSON.stringify({ sessionId: process.env.CLAUDE_HUB_SESSION_ID, token: process.env.CLAUDE_HUB_TOKEN,
    claudeSessionId: sid, transcriptPath: file, cwd: process.cwd(), ...fields });
  const req = http.request({ hostname: '127.0.0.1', port: process.env.CLAUDE_HUB_PORT,
    path: '/api/hook/' + event, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
  res => { res.resume(); res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error('hook status ' + res.statusCode))); });
  req.on('error', reject); req.end(body);
});
const message = (phase, text) => append({ type: 'item_completed', turn_id: turnId,
  item: { type: 'AgentMessage', id: phase + '-' + Date.now(), phase, content: [{ type: 'Text', text }] } });
let pending = '', submitted = false, finished = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', async chunk => {
  if (submitted) return;
  pending += chunk;
  if (!/[\r\n]/.test(pending)) return;
  const text = pending.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\r\n]+/g, ' ').trim(); pending = '';
  if (!text) return;
  submitted = true;
  append({ type: 'task_started', turn_id: turnId });
  append({ type: 'item_completed', turn_id: turnId, item: { type: 'UserMessage', content: [{ type: 'Text', text }] } });
  await hook('prompt', { prompt: text, turnId });
  message('final_answer', '方便时补充手机型号；我会先继续研究。');
  message('commentary', '正在继续检索并执行工具。');
  process.stdout.write('\r\n• Working (esc to interrupt)\r\n');
});
setInterval(() => {
  if (!submitted || finished || !fs.existsSync(process.env.HUB_STATUS_RECEIPT_GATE)) return;
  finished = true;
  message('final_answer', '完整方案已交付。');
  append({ type: 'task_complete', turn_id: turnId, last_agent_message: '完整方案已交付。', duration_ms: 10000 });
  process.stdout.write('\r\n› Write your message\r\n');
}, 150);
hook('session-start', { source: 'startup' }).then(() => process.stdout.write('MESSAGE-TASK-READY\r\n› Write your message\r\n'))
  .catch(error => { console.error(error.message); process.exit(1); });
