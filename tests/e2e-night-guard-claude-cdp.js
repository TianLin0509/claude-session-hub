'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { RECOVERY_PROMPT_MARKER } = require('../core/night-guard-controller.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-night-guard-claude-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const HOME_DIR = path.join(TEMP_ROOT, 'home');
const WORK_DIR = path.join(TEMP_ROOT, 'workspace');
const FAKE_BIN = path.join(TEMP_ROOT, 'fake-bin');
const TRANSCRIPT_PATH = path.join(TEMP_ROOT, 'claude-transcript.jsonl');
const PROMPT_LOG = path.join(TEMP_ROOT, 'prompts.jsonl');
const INVOCATION_LOG = path.join(TEMP_ROOT, 'invocations.jsonl');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'night-guard-e2e');
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `night-guard-claude-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `night-guard-claude-${RUN_ID}.json`);
const NATIVE_SESSION_ID = '33333333-3333-4333-8333-333333333333';
const FIRST_PROMPT = 'Run a long Claude Code task protected by Night Guard.';
const FINAL_ANSWER = 'Claude Code resumed in the same native session and completed.';

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitFor(label, operation, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) { lastError = error; }
    await _waitMs(100);
  }
  throw new Error(`timeout waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function writeFixtures() {
  for (const dir of [DATA_DIR, HOME_DIR, WORK_DIR, FAKE_BIN, ARTIFACT_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify({
    proxy: 'http://127.0.0.1:7890',
    providers: { claude: { backend: 'subscription' } },
  }, null, 2), 'utf8');

  const fakeCli = path.join(FAKE_BIN, 'fake-night-guard-claude.js');
  fs.writeFileSync(fakeCli, `'use strict';
const fs = require('node:fs');
const http = require('node:http');
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-V')) {
  process.stdout.write('2.1.247 (Claude Code)\\n');
  process.exit(0);
}
const nativeSessionId = ${JSON.stringify(NATIVE_SESSION_ID)};
const transcriptPath = process.env.HUB_NIGHT_GUARD_TRANSCRIPT_PATH;
const appendTranscript = value => fs.appendFileSync(transcriptPath, JSON.stringify(value) + '\\n', 'utf8');
fs.appendFileSync(process.env.HUB_NIGHT_GUARD_INVOCATION_LOG, JSON.stringify({
  args, cwd: process.cwd(), at: Date.now(), nativeSessionId,
}) + '\\n', 'utf8');

function postHook(event, detail) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(Object.assign({
      sessionId: process.env.CLAUDE_HUB_SESSION_ID,
      token: process.env.CLAUDE_HUB_TOKEN,
      claudeSessionId: nativeSessionId,
      cwd: process.cwd(),
      transcriptPath,
    }, detail || {}));
    const request = http.request({
      host: '127.0.0.1',
      port: Number(process.env.CLAUDE_HUB_PORT),
      path: '/api/hook/' + event,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end(body);
  });
}

let pending = '';
let turn = 0;
const idle = () => process.stdout.write('\\x1b[2J\\x1b[H❯\\r\\n? for shortcuts\\r\\n');
const clean = value => String(value || '')
  .replace(/\\x1b\\[(?:200|201)~/g, '')
  .replace(/\\x1b\\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/\\s+/g, ' ')
  .trim();

async function submit(raw) {
  const text = clean(raw);
  if (!text) return;
  turn += 1;
  const currentTurn = turn;
  const userId = 'claude-user-' + currentTurn;
  const timestamp = new Date().toISOString();
  fs.appendFileSync(process.env.HUB_NIGHT_GUARD_PROMPT_LOG, JSON.stringify({
    turn: currentTurn, text, nativeSessionId,
  }) + '\\n', 'utf8');
  appendTranscript({
    type: 'user', uuid: userId, timestamp,
    message: { role: 'user', content: text },
  });
  await postHook('prompt', { prompt: text });
  process.stdout.write('Working... esc to interrupt\\r\\n');
  if (currentTurn === 1) {
    setTimeout(async () => {
      const errorText = 'API Error: Connection dropped (ECONNRESET)';
      appendTranscript({
        type: 'assistant', uuid: 'claude-api-error-' + currentTurn,
        parentUuid: userId, timestamp: new Date().toISOString(),
        error: 'server_error', isApiErrorMessage: true,
        message: {
          role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence',
          content: [{ type: 'text', text: errorText }],
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      await postHook('stop-failure', {
        error: 'API Error',
        errorDetails: 'Connection dropped (ECONNRESET)',
        lastAssistantMessage: errorText,
      });
      await postHook('stop', { lastAssistantMessage: errorText });
      process.stdout.write('\\x1b[31mAPI Error: Connection dropped (ECONNRESET)\\x1b[0m\\r\\n');
      idle();
    }, 180);
    return;
  }
  setTimeout(async () => {
    const doneAt = new Date().toISOString();
    appendTranscript({
      type: 'assistant', uuid: 'claude-assistant-' + currentTurn,
      parentUuid: userId, timestamp: doneAt,
      message: {
        role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn',
        content: [{ type: 'text', text: ${JSON.stringify(FINAL_ANSWER)} }],
        usage: { input_tokens: 10, output_tokens: 12 },
      },
    });
    process.stdout.write(${JSON.stringify(FINAL_ANSWER + '\r\n')});
    idle();
    await postHook('stop', { lastAssistantMessage: ${JSON.stringify(FINAL_ANSWER)} });
  }, 250);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  pending += chunk;
  while (/[\\r\\n]/.test(pending)) {
    const match = pending.match(/[\\r\\n]/);
    const line = pending.slice(0, match.index);
    pending = pending.slice(match.index + 1);
    void submit(line).catch(error => process.stderr.write(String(error && error.stack || error) + '\\n'));
  }
});
idle();
process.stdout.write('FAKE-CLAUDE-NIGHT-GUARD-READY\\r\\n');
setInterval(() => {}, 1 << 30);
`, 'utf8');
  fs.writeFileSync(
    path.join(FAKE_BIN, 'claude.cmd'),
    `@echo off\r\n"${process.execPath}" "${fakeCli}" %*\r\n`,
    'utf8',
  );
}

async function main() {
  writeFixtures();
  const port = await reservePort();
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path';
  let hub = null;
  let client = null;
  const result = { runId: RUN_ID, port, screenshot: SCREENSHOT_PATH };
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'night-guard-claude-e2e',
      windowMode: 'hidden',
      extraEnv: {
        CLAUDE_HUB_E2E: '1',
        CLAUDE_HUB_NIGHT_GUARD_FAST: '1',
        CLAUDE_HUB_NIGHT_GUARD_FIXTURE: JSON.stringify({
          default: {
            ok: true,
            endpoints: [
              { name: 'claude-web', ok: true, httpCode: 403 },
              { name: 'anthropic-api', ok: true, httpCode: 401 },
            ],
          },
        }),
        CLAUDE_HUB_HOME_DIR: HOME_DIR,
        HUB_CLAUDE_BACKEND: 'subscription',
        HUB_NIGHT_GUARD_TRANSCRIPT_PATH: TRANSCRIPT_PATH,
        HUB_NIGHT_GUARD_PROMPT_LOG: PROMPT_LOG,
        HUB_NIGHT_GUARD_INVOCATION_LOG: INVOCATION_LOG,
        HUB_SESSION_SEARCH_PREWARM: '0',
        USERPROFILE: HOME_DIR,
        HOME: HOME_DIR,
        [pathKey]: `${FAKE_BIN}${path.delimiter}${process.env[pathKey] || ''}`,
      },
    });
    client = await connectFirstPage(hub, target => (
      target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || '')
    ));
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1500, height: 960, deviceScaleFactor: 1, mobile: false,
    });
    await waitFor('Hub renderer', () => client.eval(
      'Boolean(window.__hubE2E && document.getElementById("night-guard-toggle"))',
    ));

    result.session = await client.eval(`require('electron').ipcRenderer.invoke('create-session', {
      kind: 'claude',
      opts: {
        title: 'Claude Night Guard E2E', cwd: ${JSON.stringify(WORK_DIR)},
        model: 'claude-opus-5', effort: 'max', mcpProfile: 'none', fastMode: false
      }
    })`);
    assert.ok(result.session && result.session.id);
    await client.eval(`window.__hubE2E.selectSession(${JSON.stringify(result.session.id)}, { forceScrollBottom: true })`);
    await waitFor('fake Claude ready', () => client.eval(`(async () => {
      const ring = String(await require('electron').ipcRenderer.invoke(
        'debug:get-session-buffer', ${JSON.stringify(result.session.id)}
      ) || '');
      return ring.includes('FAKE-CLAUDE-NIGHT-GUARD-READY');
    })()`));
    await waitFor('Claude night guard toggle available', () => client.eval(`(() => {
      const button = document.getElementById('night-guard-toggle');
      return button && button.dataset.state === 'disabled' && !button.disabled;
    })()`));
    await client.eval("document.getElementById('night-guard-toggle').click()");
    await waitFor('Claude night guard armed', () => client.eval(`(() => {
      const session = sessions.get(${JSON.stringify(result.session.id)});
      return Boolean(session && session.nightGuard && session.nightGuard.enabled
        && session.nightGuard.status === 'armed');
    })()`));

    await client.eval(`(() => {
      const input = document.querySelector('.terminal-panel .floating-input-box');
      input.textContent = ${JSON.stringify(FIRST_PROMPT)};
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText', data: ${JSON.stringify(FIRST_PROMPT)}
      }));
      document.querySelector('.terminal-panel .floating-input-send').click();
      return true;
    })()`);

    try {
      result.completed = await waitFor('Claude automatic same-session recovery', () => client.eval(`(() => {
        const session = sessions.get(${JSON.stringify(result.session.id)});
        if (!session || !session.nightGuard || session.nightGuard.status !== 'completed'
            || session.nightGuard.enabled) return null;
        const button = document.getElementById('night-guard-toggle');
        return {
          ccSessionId: session.ccSessionId,
          state: session.nightGuard,
          buttonState: button.dataset.state,
          buttonLabel: document.getElementById('night-guard-toggle-label').textContent,
        };
      })()`), 20_000);
    } catch (error) {
      result.debug = await client.eval(`(async () => {
        const session = sessions.get(${JSON.stringify(result.session.id)});
        const ring = String(await require('electron').ipcRenderer.invoke(
          'debug:get-session-buffer', ${JSON.stringify(result.session.id)}
        ) || '');
        const guard = await require('electron').ipcRenderer.invoke(
          'night-guard:get', { sessionId: ${JSON.stringify(result.session.id)} }
        );
        return { session, guard, ringTail: ring.slice(-5000) };
      })()`);
      result.hubLogTail = hub.log().slice(-100);
      result.prompts = readJsonl(PROMPT_LOG);
      result.audit = readJsonl(path.join(DATA_DIR, 'diagnostics', 'night-guard.jsonl'));
      fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
      throw error;
    }

    assert.equal(result.completed.ccSessionId, NATIVE_SESSION_ID);
    assert.equal(result.completed.buttonState, 'completed');
    assert.equal(result.completed.buttonLabel, '已完成');

    result.prompts = readJsonl(PROMPT_LOG);
    assert.equal(result.prompts.length, 2, 'one original prompt plus exactly one recovery prompt');
    assert.equal(result.prompts[0].text, FIRST_PROMPT);
    assert.equal(result.prompts[0].nativeSessionId, NATIVE_SESSION_ID);
    assert.equal(result.prompts[1].nativeSessionId, NATIVE_SESSION_ID);
    assert.equal(result.prompts[1].text.startsWith(RECOVERY_PROMPT_MARKER), true);

    result.invocations = readJsonl(INVOCATION_LOG);
    assert.equal(result.invocations.length, 1, 'live recovery must not relaunch Claude or create another session');

    const auditPath = path.join(DATA_DIR, 'diagnostics', 'night-guard.jsonl');
    result.audit = readJsonl(auditPath);
    result.auditTypes = result.audit.map(item => item.type);
    const probes = result.audit.filter(item => item.type === 'network-probe');
    assert.equal(probes.length, 3);
    assert.equal(probes.every(item => item.provider === 'claude' && item.ok === true), true);
    const incident = result.audit.find(item => item.type === 'incident-detected');
    assert.equal(incident && incident.provider, 'claude');
    assert.equal(result.audit.some(item => (
      item.type === 'failure-corroborated' && item.source === 'stop_hook'
    )), true, 'synthetic Claude Stop text must corroborate failure, not resolve it');
    const recoveryAction = result.audit.find(item => item.type === 'recovery-action-sent');
    assert.equal(recoveryAction && recoveryAction.route, 'idle');
    for (const required of ['recovery-prompt-accepted', 'incident-resolved']) {
      assert.equal(result.auditTypes.includes(required), true, `audit must include ${required}`);
    }

    const shot = await client.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: false,
    });
    fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(shot.data, 'base64'));
    result.ok = true;
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify({
      ok: true,
      sessionId: result.session.id,
      ccSessionId: result.completed.ccSessionId,
      prompts: result.prompts.length,
      probes: probes.length,
      screenshot: SCREENSHOT_PATH,
      result: RESULT_PATH,
    }, null, 2));
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub);
    if (process.env.HUB_NIGHT_GUARD_KEEP_TEMP !== '1') {
      const resolved = path.resolve(TEMP_ROOT);
      if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
          && path.basename(resolved).startsWith('hub-night-guard-claude-')) {
        fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      }
    }
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
