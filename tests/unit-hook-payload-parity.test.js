'use strict';

// 社区版 hook 链路（PowerShell 原样转发 → Hub 内 core/hook-payload.js 提取）
// 必须与私人版的 session-hub-hook.py 发出的请求体逐字段一致。
// 同一批载荷分别喂给两条真实链路，比较 Hub 最终拿到的对象。

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { normalizeHookPayload } = require('../core/hook-payload');

const ROOT = path.join(__dirname, '..');
const PY_HOOK = path.join(ROOT, 'scripts', 'session-hub-hook.py');
const PS_HOOK = path.join(ROOT, 'scripts', 'session-hub-hook.ps1');
const SESSION = 'hub-session-parity';
const TOKEN = 'token-parity-0123';

const pythonAvailable = (() => {
  const probe = spawnSync('python', ['-c', 'print(1)'], { encoding: 'utf8', windowsHide: true });
  return !probe.error && probe.status === 0 && probe.stdout.trim() === '1';
})();

const longChinese = '中文输出😀'.repeat(900);
const CASES = [
  ['stop', { session_id: 'cc-1', cwd: 'C:\\work\\项目', transcript_path: 'C:\\t\\a.jsonl', hook_event_name: 'Stop',
    last_assistant_message: '完成了。'.repeat(500),
    background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'npm test' }, 'bad', { id: null }],
    session_crons: [{ id: 'c1', schedule: '*/5 * * * *', recurring: true }, { id: 'c2' }] }],
  ['prompt', { session_id: 'cc-1', prompt: '继续，帮我看看这个 bug 😀', hook_event_name: 'UserPromptSubmit' }],
  ['session-start', { session_id: 'cc-2', source: 'resume', agent_id: 'agent-x', prompt_id: 'p1', cwd: 'D:\\a b' }],
  ['session-end', { session_id: 'cc-2', reason: 'prompt_input_exit', prompt_id: 'p2' }],
  ['pre-compact', { session_id: 'cc-2', trigger: 'manual', custom_instructions: '保留'.repeat(1500), prompt_id: 'p3' }],
  ['instructions-loaded', { session_id: 'cc-3', file_path: 'C:\\x\\CLAUDE.md', load_reason: 'session_start', memory_type: 'Project' }],
  ['tool-start', { session_id: 'cc-4', tool_name: 'Bash', tool_use_id: 'tu-1', tool_input: { command: 'ls', description: '列目录' } }],
  ['tool-start', { session_id: 'cc-4', tool_name: 'Write', tool_use_id: 'tu-2', tool_input: { file_path: 'a.md', content: longChinese } }],
  ['tool-complete', { session_id: 'cc-4', tool_name: 'Read', tool_use_id: 'tu-3', tool_input: { file_path: 'a' },
    tool_response: { content: longChinese, lines: [1, 2.5, true, null] } }],
  ['tool-failed', { session_id: 'cc-4', tool_name: 'Bash', tool_call_id: 'tu-4', tool_output: 'x'.repeat(7000), error: 'exit 1' }],
  ['subagent-stop', { session_id: 'cc-5', agent_id: 'sub-1', agent_name: 'Explore', turn_id: 't9' }],
  ['task-start', { session_id: 'cc-5', task_id: 'task-1', subject: '跑测试' }],
  ['notification', { session_id: 'cc-6', notification_type: 'permission_prompt', message: '需要批准', title: 'Claude' }],
  ['stop-failure', { session_id: 'cc-6', error: 'rate_limit', error_details: 'x'.repeat(2000) }],
  ['stop', {}],
];

function captureServer() {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200); res.end('{}');
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, received, port: server.address().port })));
}

function runHook(command, args, stdin, port) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, CLAUDE_HUB_SESSION_ID: SESSION, CLAUDE_HUB_TOKEN: TOKEN, CLAUDE_HUB_PORT: String(port),
      PYTHONIOENCODING: 'utf-8' };
    const child = spawn(command, args, { env, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${command} exit ${code}: ${stderr}`))));
    child.stdin.end(stdin);
  });
}

test('PowerShell relay + Hub extraction equals session-hub-hook.py for every case', { skip: !pythonAvailable && 'python not installed' }, async () => {
  const capture = await captureServer();
  try {
    for (const [event, payload] of CASES) {
      const stdin = Buffer.from(JSON.stringify(payload), 'utf8');
      capture.received.length = 0;
      await runHook('python', [PY_HOOK, event], stdin, capture.port);
      await runHook('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS_HOOK, event], stdin, capture.port);
      assert.equal(capture.received.length, 2, `${event}: both hooks must post once`);
      const [py, ps] = capture.received;
      assert.equal(py.url, `/api/hook/${event}`);
      assert.equal(ps.url, `/api/hook-raw/${event}`);
      assert.equal(ps.headers['x-hub-session'], SESSION);
      assert.equal(ps.headers['x-hub-token'], TOKEN);
      assert.ok(ps.body.equals(stdin), `${event}: PowerShell must forward the payload byte-for-byte`);
      const expected = JSON.parse(py.body.toString('utf8'));
      const actual = normalizeHookPayload(event, ps.body, { sessionId: ps.headers['x-hub-session'], token: ps.headers['x-hub-token'] });
      assert.deepEqual(actual, expected, `${event}: extracted body differs from Python`);
    }
  } finally {
    capture.server.close();
  }
});

test('hooks stay silent outside Hub sessions and for tool-use', async () => {
  const capture = await captureServer();
  try {
    const env = { ...process.env, CLAUDE_HUB_PORT: String(capture.port) };
    delete env.CLAUDE_HUB_SESSION_ID;
    const run = args => new Promise((resolve, reject) => {
      const child = spawn('powershell', args, { env, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', reject);
      child.on('exit', resolve);
      child.stdin.end('{"session_id":"x"}');
    });
    const psArgs = event => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS_HOOK, event];
    assert.equal(await run(psArgs('stop')), 0);
    assert.equal(capture.received.length, 0, 'no CLAUDE_HUB_SESSION_ID → no request');
    assert.equal(normalizeHookPayload('tool-use', '{}', { sessionId: 's' }), null);
  } finally {
    capture.server.close();
  }
});

test('the relay script stays ASCII for Windows PowerShell 5.1', () => {
  const text = require('fs').readFileSync(PS_HOOK);
  assert.ok(text.every(byte => byte < 0x80), 'session-hub-hook.ps1 must be ASCII');
});
