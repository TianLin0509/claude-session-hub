'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const GOAL_MODE = process.env.HUB_NIGHT_GUARD_E2E_GOAL === '1';
const MODE_NAME = GOAL_MODE ? 'goal' : 'manual';
const TEMP_ROOT = path.join(os.tmpdir(), `hub-night-guard-${MODE_NAME}-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const HOME_DIR = path.join(TEMP_ROOT, 'home');
const WORKSPACE_ROOT = path.join(TEMP_ROOT, 'workspaces');
const CODEX_HOME = path.join(TEMP_ROOT, 'codex-profile');
const FAKE_BIN = path.join(TEMP_ROOT, 'fake-bin');
const PROMPT_LOG = path.join(TEMP_ROOT, 'prompts.jsonl');
const ARTIFACT_DIR = path.join(REPO_ROOT, 'output', 'night-guard-e2e');
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `night-guard-${MODE_NAME}-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `night-guard-${MODE_NAME}-${RUN_ID}.json`);
const FIRST_PROMPT = GOAL_MODE ? '/goal 执行一个需要夜间保护的长任务' : '执行一个需要夜间保护的长任务';
const FINAL_ANSWER = '夜间保护已经在同一会话中续跑并完成。';

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

function writeFixtures() {
  for (const dir of [DATA_DIR, HOME_DIR, WORKSPACE_ROOT, CODEX_HOME, FAKE_BIN, ARTIFACT_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify({
    proxy: 'http://127.0.0.1:7890',
    providers: {
      codex: {
        backend: 'subscription',
        subscription_profile: 'night-guard-e2e',
        subscription_profiles: [
          { id: 'night-guard-e2e', label: 'Night guard E2E', home: CODEX_HOME },
        ],
      },
    },
  }, null, 2), 'utf8');

  const fakeCli = path.join(FAKE_BIN, 'fake-night-guard-codex.js');
  fs.writeFileSync(fakeCli, `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const goalMode = ${JSON.stringify(GOAL_MODE)};
if (args.includes('--version') || args.includes('-V')) { process.stdout.write('codex-cli 0.147.0\\n'); process.exit(0); }
if (args[0] === 'app-server') process.exit(0);
const home = process.env.CODEX_HOME;
const sid = '22222222-2222-4222-8222-222222222222';
const now = new Date();
const dir = path.join(home, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
fs.mkdirSync(dir, { recursive: true });
const rollout = path.join(dir, 'rollout-' + now.toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + sid + '.jsonl');
const append = record => fs.appendFileSync(rollout, JSON.stringify(record) + '\\n', 'utf8');
append({ timestamp: now.toISOString(), type: 'session_meta', payload: { session_id: sid, id: sid, timestamp: now.toISOString(), cwd: process.cwd(), originator: 'codex_cli_rs', cli_version: '0.147.0', source: 'cli', thread_source: 'cli', model_provider: 'openai', base_instructions: { text: '' } } });
let pending = '';
let turn = 0;
const idle = () => process.stdout.write('\\x1b[2J\\x1b[H›\\r\\nContext 90% left\\r\\n');
const clean = value => value.replace(/\\x1b\\[(?:200|201)~/g, '').replace(/\\x1b\\[[0-?]*[ -/]*[@-~]/g, '').replace(/\\s+/g, ' ').trim();
function submit(raw) {
  const text = clean(raw);
  if (!text) return;
  turn += 1;
  const turnId = 'night-turn-' + turn;
  const at = new Date();
  fs.appendFileSync(process.env.HUB_NIGHT_GUARD_PROMPT_LOG, JSON.stringify({ turn, text, args }) + '\\n', 'utf8');
  if (goalMode && turn === 1) {
    append({ timestamp: at.toISOString(), type: 'event_msg', payload: { type: 'thread_goal_updated', turn_id: turnId, goal: { objective: text.replace(/^\\/goal(?:\\s+|$)/i, '').trim(), status: 'active' } } });
  } else {
    append({ timestamp: at.toISOString(), type: 'event_msg', payload: { type: 'user_message', turn_id: turnId, message: text } });
  }
  append({ timestamp: at.toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: turnId, started_at: at.getTime() } });
  process.stdout.write('Working... esc to interrupt\\r\\n');
  if (turn === 1) {
    setTimeout(() => {
      const failedAt = new Date();
      append({ timestamp: failedAt.toISOString(), type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId, error: { message: 'stream disconnected before completion: ECONNRESET', codex_error_info: 'other' }, completed_at: failedAt.getTime() } });
      process.stdout.write('\\r\\n\\x1b[31m■ stream disconnected before completion: ECONNRESET\\x1b[0m\\r\\n');
      idle();
    }, 180);
  } else {
    setTimeout(() => {
      const doneAt = new Date();
      append({ timestamp: doneAt.toISOString(), type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId, last_agent_message: ${JSON.stringify(FINAL_ANSWER)}, completed_at: doneAt.getTime(), duration_ms: 250 } });
      if (goalMode) append({ timestamp: new Date(doneAt.getTime() + 5).toISOString(), type: 'event_msg', payload: { type: 'thread_goal_updated', turn_id: turnId, goal: { objective: '执行一个需要夜间保护的长任务', status: 'completed' } } });
      process.stdout.write(${JSON.stringify(FINAL_ANSWER + '\r\n')});
      idle();
    }, 250);
  }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  pending += chunk;
  while (/[\\r\\n]/.test(pending)) {
    const match = pending.match(/[\\r\\n]/);
    const line = pending.slice(0, match.index);
    pending = pending.slice(match.index + 1);
    submit(line);
  }
});
idle();
process.stdout.write('FAKE-NIGHT-GUARD-READY\\r\\n');
setInterval(() => {}, 1 << 30);
`, 'utf8');
  fs.writeFileSync(path.join(FAKE_BIN, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${fakeCli}" %*\r\n`, 'utf8');
}

async function main() {
  writeFixtures();
  const port = await reservePort();
  let hub = null;
  let client = null;
  let primaryError = null;
  const result = { runId: RUN_ID, mode: MODE_NAME, port, screenshot: SCREENSHOT_PATH };
  try {
    const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path';
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'night-guard-e2e',
      windowMode: 'hidden',
      extraEnv: {
        CLAUDE_HUB_E2E: '1',
        CLAUDE_HUB_NIGHT_GUARD_FAST: '1',
        CLAUDE_HUB_NIGHT_GUARD_FIXTURE: JSON.stringify({ default: { ok: true, endpoints: [{ name: 'chatgpt', ok: true, httpCode: 403 }, { name: 'openai-api', ok: true, httpCode: 401 }] } }),
        CLAUDE_HUB_HOME_DIR: HOME_DIR,
        AI_HUB_WORKSPACE_ROOT: WORKSPACE_ROOT,
        DEEPSEEK_API_KEY: '',
        HUB_CODEX_BACKEND: 'subscription',
        HUB_CODEX_PROFILE: 'night-guard-e2e',
        HUB_NIGHT_GUARD_PROMPT_LOG: PROMPT_LOG,
        HUB_SESSION_SEARCH_PREWARM: '0',
        USERPROFILE: HOME_DIR,
        HOME: HOME_DIR,
        [pathKey]: `${FAKE_BIN}${path.delimiter}${process.env[pathKey] || ''}`,
      },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''));
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 960, deviceScaleFactor: 1, mobile: false });
    await waitFor('Hub renderer', () => client.eval('Boolean(window.__hubE2E && document.getElementById("btn-new"))'));
    await client.eval(`(() => {
      document.getElementById('btn-new').click();
      document.querySelector('.new-session-option[data-kind="codex"]').click();
      document.getElementById('new-session-submit').click();
      return true;
    })()`);
    result.session = await waitFor('Codex session', () => client.eval(`(() => {
      const session = [...sessions.values()].find(item => item.kind === 'codex');
      return session ? { id: session.id, codexSid: session.codexSid || null } : null;
    })()`));
    await client.eval(`window.__hubE2E.selectSession(${JSON.stringify(result.session.id)}, { forceScrollBottom: true })`);
    await waitFor('fake Codex ready and bound', () => client.eval(`(async () => {
      const session = sessions.get(${JSON.stringify(result.session.id)});
      const ring = String(await require('electron').ipcRenderer.invoke('debug:get-session-buffer', ${JSON.stringify(result.session.id)}) || '');
      return Boolean(session && session.codexSid && ring.includes('FAKE-NIGHT-GUARD-READY'));
    })()`));
    await waitFor('night guard toggle available', () => client.eval(`(() => {
      const button = document.getElementById('night-guard-toggle');
      return button && button.dataset.state === 'disabled' && !button.disabled;
    })()`));
    if (!GOAL_MODE) {
      await client.eval("document.getElementById('night-guard-toggle').click()");
      await waitFor('night guard armed', () => client.eval(`(() => {
        const session = sessions.get(${JSON.stringify(result.session.id)});
        return Boolean(session && session.nightGuard && session.nightGuard.enabled === true && session.nightGuard.status === 'armed');
      })()`));
    }
    await client.eval(`(() => {
      const input = document.querySelector('.terminal-panel .floating-input-box');
      input.textContent = ${JSON.stringify(FIRST_PROMPT)};
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(FIRST_PROMPT)} }));
      document.querySelector('.terminal-panel .floating-input-send').click();
      return true;
    })()`);
    if (GOAL_MODE) {
      await waitFor('/goal auto protection', () => client.eval(`(() => {
        const session = sessions.get(${JSON.stringify(result.session.id)});
        return Boolean(session && session.nightGuard && session.nightGuard.mode === 'goal');
      })()`));
    }
    try {
      result.completed = await waitFor('automatic same-session recovery', () => client.eval(`(() => {
        const session = sessions.get(${JSON.stringify(result.session.id)});
        if (!session || !session.nightGuard || session.nightGuard.status !== 'completed' || session.nightGuard.enabled) return null;
        const button = document.getElementById('night-guard-toggle');
        return { state: session.nightGuard, buttonState: button.dataset.state, buttonLabel: document.getElementById('night-guard-toggle-label').textContent };
      })()`), 20_000);
    } catch (error) {
      result.debug = await client.eval(`(async () => {
        const session = sessions.get(${JSON.stringify(result.session.id)});
        const ring = String(await require('electron').ipcRenderer.invoke('debug:get-session-buffer', ${JSON.stringify(result.session.id)}) || '');
        const guard = await require('electron').ipcRenderer.invoke('night-guard:get', { sessionId: ${JSON.stringify(result.session.id)} });
        return { session, guard, ringTail: ring.slice(-5000), buttonState: document.getElementById('night-guard-toggle')?.dataset?.state };
      })()`);
      result.hubLogTail = hub.log().slice(-80);
      if (fs.existsSync(PROMPT_LOG)) result.promptLogRaw = fs.readFileSync(PROMPT_LOG, 'utf8');
      const auditPath = path.join(DATA_DIR, 'diagnostics', 'night-guard.jsonl');
      if (fs.existsSync(auditPath)) result.auditRaw = fs.readFileSync(auditPath, 'utf8');
      fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
      throw error;
    }
    assert.equal(result.completed.buttonState, 'completed');
    assert.equal(result.completed.buttonLabel, '已完成');

    const prompts = fs.readFileSync(PROMPT_LOG, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    result.prompts = prompts;
    assert.equal(prompts.length, 2, 'original prompt plus exactly one recovery prompt');
    assert.equal(prompts[0].text, FIRST_PROMPT);
    assert.match(prompts[1].text, /夜间保护自动恢复/);

    const auditPath = path.join(DATA_DIR, 'diagnostics', 'night-guard.jsonl');
    const audit = fs.readFileSync(auditPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    result.auditTypes = audit.map(item => item.type);
    assert.equal(result.auditTypes.filter(type => type === 'network-probe').length, 3);
    for (const required of ['incident-detected', 'recovery-action-sent', 'incident-resolved']) {
      assert.equal(result.auditTypes.includes(required), true, `audit must include ${required}`);
    }

    await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }).then(({ data }) => {
      fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(data, 'base64'));
    });
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (client) { try { client.close(); } catch {} }
    if (hub) {
      try {
        await gracefulQuit(hub);
      } catch (teardownError) {
        const logTail = hub.log().slice(-80).join('\n');
        console.error(`[night-guard-e2e] isolated Hub teardown failed:\n${logTail}`);
        if (!primaryError) throw teardownError;
      }
    }
    if (process.env.HUB_NIGHT_GUARD_KEEP_TEMP !== '1') {
      fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
    } else {
      console.error(`night guard E2E temp preserved at ${TEMP_ROOT}`);
    }
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
