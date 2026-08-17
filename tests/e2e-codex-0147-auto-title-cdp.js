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
const TEMP_ROOT = path.join(os.tmpdir(), `hub-codex-0147-auto-title-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const HOME_DIR = path.join(TEMP_ROOT, 'home');
const WORKSPACE_ROOT = path.join(TEMP_ROOT, 'workspaces');
const CODEX_PROFILE_HOME = path.join(TEMP_ROOT, 'codex-profile');
const FAKE_BIN = path.join(TEMP_ROOT, 'fake-bin');
const PROMPT_LOG = path.join(TEMP_ROOT, 'prompt.json');
const ARTIFACT_DIR = path.join(REPO_ROOT, 'output', 'playwright', 'codex-0147-auto-title');
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `auto-title-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `result-${RUN_ID}.json`);
const PROMPT = '验证Codex自动命名';
const EXPECTED_TITLE = `Codex · ${PROMPT}`;

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

async function waitFor(label, operation, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await _waitMs(150);
  }
  throw new Error(`timeout waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function listJsonlFiles(root) {
  const found = [];
  const visit = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(full);
    }
  };
  visit(root);
  return found;
}

function writeFixtures() {
  for (const dir of [DATA_DIR, HOME_DIR, WORKSPACE_ROOT, CODEX_PROFILE_HOME, FAKE_BIN, ARTIFACT_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify({
    providers: {
      codex: {
        backend: 'subscription',
        subscription_profile: 'auto-title-e2e',
        subscription_profiles: [
          { id: 'auto-title-e2e', label: 'Auto title E2E', home: CODEX_PROFILE_HOME },
        ],
      },
    },
  }, null, 2), 'utf8');

  const fakeCliPath = path.join(FAKE_BIN, 'fake-codex-0147.js');
  fs.writeFileSync(fakeCliPath, `'use strict';
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-V')) {
  process.stdout.write('codex-cli 0.147.0\\n');
  process.exit(0);
}
if (args[0] === 'app-server') process.exit(0);

const codexHome = process.env.CODEX_HOME;
if (!codexHome) throw new Error('isolated CODEX_HOME missing');
const now = new Date();
const sid = '019effff-0147-7000-8000-000000000147';
const turnId = '019effff-0147-7000-8000-000000000148';
const dayDir = path.join(
  codexHome,
  'sessions',
  String(now.getFullYear()),
  String(now.getMonth() + 1).padStart(2, '0'),
  String(now.getDate()).padStart(2, '0'),
);
fs.mkdirSync(dayDir, { recursive: true });
const stamp = now.toISOString().replace(/[:.]/g, '-').replace('Z', '').slice(0, 19);
const rolloutPath = path.join(dayDir, 'rollout-' + stamp + '-' + sid + '.jsonl');
const append = record => fs.appendFileSync(rolloutPath, JSON.stringify(record) + '\\n', 'utf8');
append({
  timestamp: now.toISOString(),
  type: 'session_meta',
  payload: {
    session_id: sid,
    id: sid,
    timestamp: now.toISOString(),
    cwd: process.cwd(),
    originator: 'codex_cli_rs',
    cli_version: '0.147.0',
    source: 'cli',
    thread_source: 'cli',
    model_provider: 'openai',
    base_instructions: { text: '' },
  },
});

let pending = '';
let submitted = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (submitted) return;
  pending += chunk;
  if (!/[\\r\\n]/.test(pending)) return;
  const text = pending
    .replace(/\\x1b\\[200~/g, '')
    .replace(/\\x1b\\[201~/g, '')
    .replace(/\\x1b\\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\\r\\n]+/g, ' ')
    .trim();
  pending = '';
  if (!text) return;
  submitted = true;
  const at = new Date();
  const atMs = at.getTime();
  fs.writeFileSync(process.env.HUB_CODEX_AUTO_TITLE_PROMPT_LOG, JSON.stringify({ text, args }), 'utf8');
  append({
    timestamp: at.toISOString(),
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: turnId, started_at: atMs },
  });
  append({
    timestamp: at.toISOString(),
    type: 'response_item',
    payload: {
      type: 'message',
      id: 'response-user-0147',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  });
  append({
    timestamp: at.toISOString(),
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: sid,
      turn_id: turnId,
      item: {
        type: 'UserMessage',
        id: 'user-message-0147',
        content: [{ type: 'text', text, text_elements: [] }],
      },
      started_at_ms: atMs - 5,
      completed_at_ms: atMs,
    },
  });
  setTimeout(() => {
    const completedAt = new Date();
    append({
      timestamp: completedAt.toISOString(),
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: turnId,
        last_agent_message: '自动命名端到端验证完成',
        duration_ms: completedAt.getTime() - atMs,
      },
    });
    process.stdout.write('AUTO-TITLE-E2E-COMPLETE\\r\\n');
  }, 250);
});
process.stdout.write('FAKE-CODEX-0147-READY\\r\\n');
setInterval(() => {}, 1 << 30);
`, 'utf8');

  fs.writeFileSync(
    path.join(FAKE_BIN, 'codex.cmd'),
    `@echo off\r\n"${process.execPath}" "${fakeCliPath}" %*\r\n`,
    'utf8',
  );
}

async function main() {
  writeFixtures();
  const port = await reservePort();
  let hub = null;
  let client = null;
  const result = { runId: RUN_ID, port, screenshot: SCREENSHOT_PATH, expectedTitle: EXPECTED_TITLE };

  try {
    const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path';
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'codex-0147-auto-title',
      extraEnv: {
        CLAUDE_HUB_E2E: '1',
        CLAUDE_HUB_NO_EFFORT_MAX: '1',
        CLAUDE_HUB_HOME_DIR: HOME_DIR,
        AI_HUB_WORKSPACE_ROOT: WORKSPACE_ROOT,
        DEEPSEEK_API_KEY: '',
        HUB_CODEX_BACKEND: 'subscription',
        HUB_CODEX_PROFILE: 'auto-title-e2e',
        HUB_CODEX_AUTO_TITLE_PROMPT_LOG: PROMPT_LOG,
        [pathKey]: `${FAKE_BIN}${path.delimiter}${process.env[pathKey] || ''}`,
      },
    });
    client = await connectFirstPage(hub, target => (
      target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || '')
    ));
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1500,
      height: 980,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await waitFor('Hub session UI', () => client.eval(
      'Boolean(window.__hubE2E && document.getElementById("btn-new")'
        + ' && document.querySelector(".new-session-option[data-kind=codex]"))',
    ));

    await client.eval(`(() => {
      document.getElementById('btn-new').click();
      document.querySelector('.new-session-option[data-kind="codex"]').click();
      return document.getElementById('new-session-menu').style.display;
    })()`);
    await waitFor('new-session modal', () => client.eval(
      'document.getElementById("new-session-menu").style.display === "flex"',
    ));
    await client.eval('document.getElementById("new-session-submit").click()');

    result.created = await waitFor('Codex session creation', () => client.eval(`(() => {
      const session = [...sessions.values()].find(item => item.kind === 'codex');
      if (!session) return null;
      return {
        id: session.id,
        title: session.title,
        cwd: session.cwd,
        codexProfile: session.codexProfile,
        codexSessionsRoot: session.codexSessionsRoot,
      };
    })()`));
    assert.equal(result.created.title, 'Codex 1');
    assert.equal(result.created.codexProfile, 'auto-title-e2e');
    assert.equal(path.resolve(result.created.codexSessionsRoot), path.resolve(CODEX_PROFILE_HOME, 'sessions'));

    await client.eval(`window.__hubE2E.selectSession(${JSON.stringify(result.created.id)}, { forceScrollBottom: true })`);
    await waitFor('floating input', () => client.eval(
      'Boolean(document.querySelector(".terminal-panel .floating-input-box")'
        + ' && document.querySelector(".terminal-panel .floating-input-send"))',
    ));
    await waitFor('fake Codex CLI readiness', () => client.eval(`(async () => {
      const ring = String(await require('electron').ipcRenderer.invoke(
        'debug:get-session-buffer', ${JSON.stringify(result.created.id)}
      ) || '');
      return ring.includes('FAKE-CODEX-0147-READY');
    })()`));
    await client.eval(`(() => {
      const input = document.querySelector('.terminal-panel .floating-input-box');
      input.textContent = ${JSON.stringify(PROMPT)};
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(PROMPT)} }));
      document.querySelector('.terminal-panel .floating-input-send').click();
      return true;
    })()`);

    try {
      result.renamed = await waitFor('Codex 0.147 auto title', () => client.eval(`(() => {
        const session = sessions.get(${JSON.stringify(result.created.id)});
        if (!session || session.title !== ${JSON.stringify(EXPECTED_TITLE)} || !session.autoTitleGenerated) return null;
        const cardTitle = document.querySelector(
          '.session-item[data-session-id="${result.created.id}"] .sl-title'
        )?.textContent?.trim() || '';
        if (cardTitle !== ${JSON.stringify(EXPECTED_TITLE)}) return null;
        const headerTitle = document.querySelector('.terminal-title')?.textContent?.trim() || '';
        if (headerTitle !== ${JSON.stringify(EXPECTED_TITLE)}) return null;
        return {
          title: session.title,
          autoTitleGenerated: session.autoTitleGenerated,
          transcriptPath: session.transcriptPath,
          codexSid: session.codexSid,
          cardTitle,
          headerTitle,
        };
      })()`), 30000);
    } catch (error) {
      const diagnostics = await client.eval(`(async () => {
        const session = sessions.get(${JSON.stringify(result.created.id)}) || null;
        const authoritative = await require('electron').ipcRenderer.invoke('get-sessions');
        const mainSession = authoritative.find(item => item.id === ${JSON.stringify(result.created.id)}) || null;
        const cardTitle = document.querySelector(
          '.session-item[data-session-id="${result.created.id}"] .sl-title'
        )?.textContent?.trim() || '';
        const ring = String(await require('electron').ipcRenderer.invoke(
          'debug:get-session-buffer', ${JSON.stringify(result.created.id)}
        ) || '');
        return { session, mainSession, cardTitle, ringTail: ring.slice(-1000) };
      })()`).catch(() => null);
      const profileSessions = path.join(CODEX_PROFILE_HOME, 'sessions');
      const rolloutFiles = listJsonlFiles(profileSessions);
      error.message += `\ndiagnostics=${JSON.stringify({
        diagnostics,
        promptLog: fs.existsSync(PROMPT_LOG) ? fs.readFileSync(PROMPT_LOG, 'utf8') : null,
        rolloutFiles,
      })}`;
      throw error;
    }

    result.promptLog = await waitFor('fake Codex prompt log', () => {
      if (!fs.existsSync(PROMPT_LOG)) return null;
      return JSON.parse(fs.readFileSync(PROMPT_LOG, 'utf8'));
    });
    assert.equal(result.promptLog.text, PROMPT);
    assert.ok(result.renamed.codexSid, 'Codex native sid must be bound');
    assert.ok(result.renamed.transcriptPath && fs.existsSync(result.renamed.transcriptPath),
      'Codex rollout path must be bound');

    const authoritative = await client.eval(`require('electron').ipcRenderer.invoke('get-sessions')`);
    const authoritativeSession = authoritative.find(item => item.id === result.created.id);
    assert.equal(authoritativeSession.title, EXPECTED_TITLE);
    assert.equal(authoritativeSession.autoTitleGenerated, true);
    result.authoritative = {
      title: authoritativeSession.title,
      autoTitleGenerated: authoritativeSession.autoTitleGenerated,
      codexSid: authoritativeSession.codexSid,
    };

    result.completed = await waitFor('Codex task completion after rename', () => client.eval(`(() => {
      const session = sessions.get(${JSON.stringify(result.created.id)});
      if (!session || session.status !== 'idle' || session.cardWorkingSource) return null;
      return {
        status: session.status,
        headerStatus: document.querySelector('.terminal-status')?.textContent?.trim() || '',
      };
    })()`));

    const screenshot = await client.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(screenshot.data, 'base64'));
    assert.ok(fs.statSync(SCREENSHOT_PATH).size > 1000, 'screenshot should be non-empty');
    fs.writeFileSync(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ ok: true, resultPath: RESULT_PATH, ...result }, null, 2));
  } catch (error) {
    if (hub) error.logTail = hub.log().slice(-80).join('\n');
    throw error;
  } finally {
    if (client) await client.close().catch(() => {});
    await gracefulQuit(hub);
    const resolvedTemp = path.resolve(TEMP_ROOT);
    const resolvedOsTemp = path.resolve(os.tmpdir()) + path.sep;
    if (resolvedTemp.startsWith(resolvedOsTemp)) {
      fs.rmSync(resolvedTemp, { recursive: true, force: true });
    }
  }
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  if (error && error.logTail) console.error('--- isolated Hub log tail ---\n' + error.logTail);
  process.exitCode = 1;
});
