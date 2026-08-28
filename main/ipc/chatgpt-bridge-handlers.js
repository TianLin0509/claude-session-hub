'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { sendToPty } = require('../../core/group-chat-watcher.js');

const BRIDGE_TIMEOUT_MS = 3 * 60 * 1000;
const BRIDGE_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const BRIDGE_MAX_INPUT_BYTES = 1024 * 1024;

function resolveChatgptBridgeRuntime({
  env = process.env,
  homeDir = os.homedir(),
  existsSync = fs.existsSync,
} = {}) {
  const localAppData = env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
  const pythonCandidates = [
    env.CHATGPT_BRIDGE_PYTHON,
    path.join(localAppData, 'Programs', 'Python', 'Python312', 'python.exe'),
    path.join(localAppData, 'Programs', 'Python', 'Python313', 'python.exe'),
  ].filter(Boolean);
  const bridgeCandidates = [
    env.CHATGPT_BRIDGE_SCRIPT,
    path.join(homeDir, 'tools', 'chatgpt_bridge', 'bridge.py'),
  ].filter(Boolean);
  const pythonPath = pythonCandidates.find(candidate => existsSync(candidate));
  const bridgePath = bridgeCandidates.find(candidate => existsSync(candidate));
  if (!pythonPath) return { error: '未找到 ChatGPT 中转所需的 Python。', code: 'python_missing' };
  if (!bridgePath) return { error: '未找到 ChatGPT 中转工具。', code: 'bridge_missing' };
  return { pythonPath, bridgePath };
}

function parseBridgeOutput(stdout, stderr, exitCode) {
  const lines = String(stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  let envelope = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      envelope = JSON.parse(lines[index]);
      break;
    } catch (_) {
      // Keep looking for the final JSON envelope after any diagnostics.
    }
  }
  if (!envelope || typeof envelope !== 'object') {
    return {
      ok: false,
      error: String(stderr || '').trim() || 'ChatGPT 中转工具没有返回有效结果。',
      code: 'invalid_response',
    };
  }
  if (exitCode !== 0 || envelope.ok !== true) {
    const error = envelope.error && typeof envelope.error === 'object' ? envelope.error : {};
    return {
      ok: false,
      error: error.message || String(stderr || '').trim() || `ChatGPT 中转工具退出码：${exitCode}`,
      code: error.code || 'bridge_failed',
      details: error.details,
    };
  }
  return envelope;
}

function runChatgptBridge(args, {
  input = '',
  spawnImpl = spawn,
  runtimeOptions,
  timeoutMs = BRIDGE_TIMEOUT_MS,
  maxOutputBytes = BRIDGE_MAX_OUTPUT_BYTES,
} = {}) {
  const runtime = resolveChatgptBridgeRuntime(runtimeOptions);
  if (runtime.error) return Promise.resolve({ ok: false, ...runtime });
  return new Promise((resolve) => {
    const child = spawnImpl(runtime.pythonPath, [runtime.bridgePath, ...args], {
      windowsHide: true,
      cwd: path.dirname(runtime.bridgePath),
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const append = (target, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        child.kill();
        finish({ ok: false, error: 'ChatGPT 中转返回内容超过安全上限。', code: 'output_limit' });
        return target;
      }
      return target + chunk.toString('utf8');
    };
    if (child.stdout) child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    if (child.stderr) child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    child.on('error', error => finish({
      ok: false,
      error: `无法启动 ChatGPT 中转工具：${String(error && error.message || error)}`,
      code: 'spawn_failed',
    }));
    child.on('close', code => finish(parseBridgeOutput(stdout, stderr, code)));
    timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: 'ChatGPT 中转操作超时。', code: 'timeout' });
    }, timeoutMs);
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(String(input || ''), 'utf8');
    }
  });
}

function validateText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, error: '没有可同步的文字。', code: 'empty_content' };
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > BRIDGE_MAX_INPUT_BYTES) {
    return { ok: false, error: '文字超过当前 1 MiB 安全上限。', code: 'content_too_large' };
  }
  return { ok: true, text, bytes };
}

function registerChatgptBridgeIpc(ipcMain, deps = {}) {
  const sessionManager = deps.sessionManager;
  const runner = deps.runBridge || runChatgptBridge;
  const sendPrompt = deps.sendPrompt || sendToPty;
  let pullInFlight = false;
  let pushInFlight = false;

  ipcMain.handle('chatgpt-bridge:status', async () => runner(['status']));
  ipcMain.handle('chatgpt-bridge:open', async () => runner(['open']));

  ipcMain.handle('chatgpt-bridge:pull', async (_event, payload = {}) => {
    if (pullInFlight) return { ok: false, error: '正在拉取，请稍候。', code: 'already_pulling' };
    pullInFlight = true;
    try {
      return await runner(['pull', ...(payload.peek === true ? ['--peek'] : [])]);
    } finally {
      pullInFlight = false;
    }
  });

  ipcMain.handle('chatgpt-bridge:push', async (_event, payload = {}) => {
    const checked = validateText(payload.text);
    if (!checked.ok) return checked;
    if (pushInFlight) return { ok: false, error: '正在同步，请稍候。', code: 'already_pushing' };
    pushInFlight = true;
    try {
      return await runner(['push', '--stdin'], { input: checked.text });
    } finally {
      pushInFlight = false;
    }
  });

  ipcMain.handle('chatgpt-bridge:pull-and-send', async (_event, payload = {}) => {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    const session = sessionId && sessionManager && sessionManager.getSession(sessionId);
    if (!session) return { ok: false, error: '请选择一个正在运行的单聊会话。', code: 'session_not_found' };
    if (pullInFlight) return { ok: false, error: '正在拉取，请稍候。', code: 'already_pulling' };
    pullInFlight = true;
    try {
      const pulled = await runner(['pull', '--peek']);
      if (!pulled || pulled.ok !== true) return pulled;
      if (pulled.new !== true || typeof pulled.content !== 'string' || !pulled.content.trim()) {
        return { ok: true, new: false, sent: false };
      }
      const sent = await sendPrompt(sessionId, pulled.content, session.kind);
      const sendOk = sent === true
        || (sent && sent.ok === true && sent.sendStatus !== 'stuck');
      if (!sendOk) {
        return { ok: false, new: true, sent: false, error: '内容已拉取，但当前 AI 未成功接收。', code: 'pty_send_failed' };
      }
      const maxTurn = Number(pulled.max_turn) || Math.max(0, ...(pulled.items || []).map(item => Number(item.turn) || 0));
      const acknowledged = maxTurn > 0 ? await runner(['ack', '--turn', String(maxTurn)]) : { ok: true };
      return {
        ok: true,
        new: true,
        sent: true,
        count: pulled.count,
        acknowledged: acknowledged && acknowledged.ok === true,
        warning: acknowledged && acknowledged.ok === true ? null : '内容已发送，但游标确认失败；下次可能重复拉取。',
      };
    } finally {
      pullInFlight = false;
    }
  });
}

module.exports = {
  BRIDGE_MAX_INPUT_BYTES,
  BRIDGE_MAX_OUTPUT_BYTES,
  BRIDGE_TIMEOUT_MS,
  parseBridgeOutput,
  registerChatgptBridgeIpc,
  resolveChatgptBridgeRuntime,
  runChatgptBridge,
  validateText,
};
