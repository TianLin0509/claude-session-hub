'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'session-hub-hook.py');

async function runHook(event, payload) {
  let received = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received = { url: req.url, body: JSON.parse(body || '{}') };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('python', [SCRIPT, event], {
        env: {
          ...process.env,
          CLAUDE_HUB_SESSION_ID: 'hub-session-1',
          CLAUDE_HUB_PORT: String(port),
          CLAUDE_HUB_TOKEN: 'test-token',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`hook exit=${code}: ${stderr}`)));
      child.stdin.end(JSON.stringify(payload));
    });
    for (let index = 0; index < 50 && !received; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return received;
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('Claude Stop hook forwards bounded background task lifecycle fields', async () => {
  const result = await runHook('stop', {
    hook_event_name: 'Stop',
    session_id: 'claude-native-1',
    cwd: 'C:\\work',
    transcript_path: 'C:\\work\\session.jsonl',
    last_assistant_message: 'done',
    background_tasks: [{
      id: 'task-1', type: 'shell', status: 'running', description: 'tail logs', command: 'secret command',
    }],
    session_crons: [{ id: 'cron-1', schedule: '0 9 * * 1-5', recurring: true, prompt: 'private prompt' }],
  });
  assert.equal(result.url, '/api/hook/stop');
  assert.equal(result.body.sessionId, 'hub-session-1');
  assert.equal(result.body.claudeSessionId, 'claude-native-1');
  assert.deepEqual(result.body.backgroundTasks, [{
    id: 'task-1', type: 'shell', status: 'running', description: 'tail logs',
  }]);
  assert.deepEqual(result.body.sessionCrons, [{ id: 'cron-1', schedule: '0 9 * * 1-5', recurring: true }]);
  assert.equal(Object.hasOwn(result.body.backgroundTasks[0], 'command'), false);
  assert.equal(Object.hasOwn(result.body.sessionCrons[0], 'prompt'), false);
});

test('Claude failure, permission and notification hooks forward only runtime evidence', async () => {
  const failure = await runHook('stop-failure', {
    hook_event_name: 'StopFailure',
    session_id: 'claude-native-1',
    error: 'rate_limit',
    error_details: '429 Too Many Requests',
    last_assistant_message: 'API Error',
  });
  assert.equal(failure.body.error, 'rate_limit');
  assert.equal(failure.body.errorDetails, '429 Too Many Requests');

  const permission = await runHook('permission-request', {
    hook_event_name: 'PermissionRequest',
    session_id: 'claude-native-1',
    tool_name: 'PowerShell',
    tool_input: { command: 'should not cross the hook boundary' },
  });
  assert.equal(permission.body.toolName, 'PowerShell');
  assert.equal(Object.hasOwn(permission.body, 'toolInput'), false);

  const notification = await runHook('notification', {
    hook_event_name: 'Notification',
    session_id: 'claude-native-1',
    notification_type: 'agent_needs_input',
    title: 'Input needed',
    message: 'Choose an option',
  });
  assert.equal(notification.body.notificationType, 'agent_needs_input');
  assert.equal(notification.body.title, 'Input needed');
  assert.equal(notification.body.message, 'Choose an option');
});

test('Claude tool hooks forward bounded activity identity, input and result', async () => {
  const started = await runHook('tool-start', {
    hook_event_name: 'PreToolUse',
    session_id: 'claude-native-1',
    turn_id: 'turn-activity-1',
    tool_use_id: 'tool-activity-1',
    tool_name: 'PowerShell',
    tool_input: { command: 'npm test' },
  });
  assert.equal(started.body.turnId, 'turn-activity-1');
  assert.equal(started.body.toolCallId, 'tool-activity-1');
  assert.deepEqual(started.body.toolInput, { command: 'npm test' });

  const completed = await runHook('tool-complete', {
    hook_event_name: 'PostToolUse',
    session_id: 'claude-native-1',
    turn_id: 'turn-activity-1',
    tool_use_id: 'tool-activity-1',
    tool_name: 'PowerShell',
    tool_input: { command: 'npm test' },
    tool_response: { stdout: '12 tests passed', exit_code: 0 },
  });
  assert.equal(completed.body.toolCallId, 'tool-activity-1');
  assert.match(completed.body.toolResult, /12 tests passed/);

  const unicodeHeavy = await runHook('tool-complete', {
    hook_event_name: 'PostToolUse',
    session_id: 'claude-native-1',
    tool_use_id: 'tool-unicode-heavy',
    tool_name: 'PowerShell',
    tool_input: { command: '中'.repeat(5000) },
    tool_response: { stdout: '完'.repeat(5000), exit_code: 0 },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(unicodeHeavy.body), 'utf8') < 16384,
    'bounded hook evidence must stay below the Hub HTTP body limit in UTF-8 bytes');
});
