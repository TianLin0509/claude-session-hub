'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-codex-resume-card-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const HOME_DIR = path.join(TEMP_ROOT, 'home');
const WORK_DIR = path.join(TEMP_ROOT, 'workspace');
const FAKE_BIN = path.join(TEMP_ROOT, 'fake-bin');
const SECOND_CODEX_HOME = path.join(TEMP_ROOT, 'codex-second');
const SECOND_SESSIONS_ROOT = path.join(SECOND_CODEX_HOME, 'sessions');
const INVOCATION_LOG = path.join(TEMP_ROOT, 'codex-invocations.jsonl');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'codex-resume-card-history');
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `codex-resume-card-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `result-${RUN_ID}.json`);

const EXACT_HUB_ID = 'e2e-codex-profile-resume';
const LEGACY_HUB_ID = 'e2e-codex-path-only-resume';
const EXACT_SID = '019faaaa-3333-7333-8333-000000000021';
const LEGACY_SID = '019fbbbb-3333-7333-8333-000000000022';

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitFor(label, fn, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await _waitMs(120);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function writeRollout(sid, question, answer, offsetMs) {
  const startAt = new Date(Date.now() - offsetMs);
  const dayDir = path.join(
    SECOND_SESSIONS_ROOT,
    String(startAt.getFullYear()),
    String(startAt.getMonth() + 1).padStart(2, '0'),
    String(startAt.getDate()).padStart(2, '0'),
  );
  fs.mkdirSync(dayDir, { recursive: true });
  const stamp = startAt.toISOString().replace(/[:.]/g, '-').replace('Z', '').slice(0, 19);
  const rolloutPath = path.join(dayDir, `rollout-${stamp}-${sid}.jsonl`);
  const records = [
    {
      timestamp: startAt.toISOString(),
      type: 'session_meta',
      payload: {
        id: sid,
        session_id: sid,
        timestamp: startAt.toISOString(),
        cwd: WORK_DIR,
        originator: 'codex-tui',
        source: 'cli',
        thread_source: 'user',
      },
    },
    {
      timestamp: new Date(startAt.getTime() + 100).toISOString(),
      type: 'event_msg',
      payload: { type: 'user_message', message: question },
    },
    {
      timestamp: new Date(startAt.getTime() + 200).toISOString(),
      type: 'event_msg',
      payload: { type: 'task_complete', last_agent_message: answer, duration_ms: 100 },
    },
  ];
  fs.writeFileSync(rolloutPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  return rolloutPath;
}

function readInvocations() {
  if (!fs.existsSync(INVOCATION_LOG)) return [];
  return fs.readFileSync(INVOCATION_LOG, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function writeFixtures() {
  for (const dir of [DATA_DIR, HOME_DIR, WORK_DIR, FAKE_BIN, SECOND_CODEX_HOME, ARTIFACT_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const exactPath = writeRollout(
    EXACT_SID,
    'PROFILE RESUME HISTORY QUESTION',
    'PROFILE RESUME HISTORY ANSWER',
    90 * 60 * 1000,
  );
  const legacyPath = writeRollout(
    LEGACY_SID,
    'LEGACY PATH HISTORY QUESTION',
    'LEGACY PATH HISTORY ANSWER',
    60 * 60 * 1000,
  );

  const fakeCli = path.join(FAKE_BIN, 'fake-codex.js');
  fs.writeFileSync(fakeCli, `'use strict';
const fs = require('node:fs');
fs.appendFileSync(process.env.HUB_CODEX_RESUME_E2E_LOG, JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(), at: Date.now()
}) + '\\n', 'utf8');
process.stdout.write('[fake-codex-ready]\\r\\n');
setInterval(() => {}, 1000);
`, 'utf8');
  fs.writeFileSync(
    path.join(FAKE_BIN, 'codex.cmd'),
    `@echo off\r\n"${process.execPath}" "${fakeCli}" %*\r\n`,
    'utf8',
  );

  fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify({
    providers: {
      codex: {
        backend: 'subscription',
        subscription_profile: 'default',
        subscription_profiles: [
          { id: 'default', label: 'Default E2E', home: '' },
          { id: 'second', label: 'Second E2E', home: SECOND_CODEX_HOME },
        ],
      },
    },
  }, null, 2), 'utf8');

  const now = Date.now();
  fs.writeFileSync(path.join(DATA_DIR, 'state.json'), JSON.stringify({
    version: 1,
    cleanShutdown: true,
    sessions: [
      {
        hubId: EXACT_HUB_ID,
        kind: 'codex',
        title: 'Exact profile resume',
        cwd: WORK_DIR,
        codexSid: EXACT_SID,
        codexProfile: 'second',
        // Deliberately omit codexSessionsRoot/transcriptPath: old profile state
        // must discover both before card hydration.
        lastMessageTime: now - 5000,
        lastOutputPreview: 'PROFILE RESUME HISTORY ANSWER',
        updatedAt: now - 5000,
      },
      {
        hubId: LEGACY_HUB_ID,
        kind: 'codex-resume',
        title: 'Legacy path-only resume',
        cwd: WORK_DIR,
        codexSid: null,
        codexProfile: 'second',
        transcriptPath: legacyPath,
        lastMessageTime: now - 4000,
        lastOutputPreview: 'LEGACY PATH HISTORY ANSWER',
        updatedAt: now - 4000,
      },
    ],
    meetings: [],
    immersiveByMeeting: {},
  }, null, 2), 'utf8');

  return { exactPath, legacyPath };
}

async function dispatchMouse(client, selector) {
  const point = await client.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      x, y,
      visible: rect.width > 0 && rect.height > 0 && getComputedStyle(el).display !== 'none',
      topmost: hit === el || el.contains(hit),
    };
  })()`);
  assert.ok(point && point.visible && point.topmost, `${selector} should be visible and topmost`);
  await client.send('Page.bringToFront');
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1,
  });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1,
  });
}

async function waitForCard(client, hubId, expectedQuestion, expectedAnswer) {
  return waitFor(`${hubId} card history`, () => client.eval(`(() => {
    const overlay = document.getElementById('msg-overlay');
    const session = sessions.get(${JSON.stringify(hubId)});
    const text = overlay ? overlay.innerText : '';
    if (!session || activeSessionId !== ${JSON.stringify(hubId)} || currentView !== 'card') return null;
    if (!text.includes(${JSON.stringify(expectedQuestion)}) || !text.includes(${JSON.stringify(expectedAnswer)})) return null;
    return {
      text,
      status: session.status,
      codexSid: session.codexSid || null,
      codexProfile: session.codexProfile || null,
      codexSessionsRoot: session.codexSessionsRoot || null,
      transcriptPath: session.transcriptPath || null,
      cardCount: overlay.querySelectorAll('.turn-card').length,
      placeholder: overlay.querySelector('.msg-overlay-placeholder')?.innerText || null,
    };
  })()`));
}

async function main() {
  const fixtures = writeFixtures();
  const port = await reservePort();
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path';
  let hub = null;
  let client = null;
  const result = { runId: RUN_ID, port, fixtures };
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'codex-resume-card-history',
      extraEnv: {
        CLAUDE_HUB_E2E: '1',
        CLAUDE_HUB_HOME_DIR: HOME_DIR,
        HUB_CODEX_BACKEND: 'subscription',
        HUB_CODEX_PROFILE: 'default',
        HUB_CODEX_RESUME_E2E_LOG: INVOCATION_LOG,
        USERPROFILE: HOME_DIR,
        HOME: HOME_DIR,
        [pathKey]: `${FAKE_BIN}${path.delimiter}${process.env[pathKey] || ''}`,
      },
    });
    await _waitMs(900);
    client = await connectFirstPage(hub, target => target.type === 'page' && /index\.html/i.test(target.url || ''));
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 960, deviceScaleFactor: 1, mobile: false,
    });

    await waitFor('dormant Codex sidebar entries', () => client.eval(`(() => {
      const found = {
        exact: !!document.querySelector('[data-session-id="${EXACT_HUB_ID}"]'),
        legacy: !!document.querySelector('[data-session-id="${LEGACY_HUB_ID}"]'),
      };
      return found.exact && found.legacy ? found : null;
    })()`));
    // Two genuine mouse clicks while the first async selection is still
    // pending must still launch exactly one PTY.
    await dispatchMouse(client, `[data-session-id="${EXACT_HUB_ID}"]`);
    await dispatchMouse(client, `[data-session-id="${EXACT_HUB_ID}"]`);
    await waitFor('exact Codex resume activation', () => client.eval(`(() => {
      const session = sessions.get(${JSON.stringify(EXACT_HUB_ID)});
      return session && session.status !== 'dormant' && activeSessionId === ${JSON.stringify(EXACT_HUB_ID)};
    })()`));
    await dispatchMouse(client, '.view-toggle-btn[data-view="card"]');
    result.exactCard = await waitForCard(
      client,
      EXACT_HUB_ID,
      'PROFILE RESUME HISTORY QUESTION',
      'PROFILE RESUME HISTORY ANSWER',
    );
    await _waitMs(800);
    const exactInvocations = readInvocations().filter(entry => entry.args.includes(EXACT_SID));
    assert.equal(exactInvocations.length, 1, 'double click must launch exactly one exact Codex resume');
    assert.equal(exactInvocations[0].args[0], 'resume');
    assert.equal(exactInvocations[0].args[1], EXACT_SID);
    assert.equal(path.resolve(result.exactCard.codexSessionsRoot), path.resolve(SECOND_SESSIONS_ROOT));
    assert.equal(path.resolve(result.exactCard.transcriptPath), path.resolve(fixtures.exactPath));
    assert.equal(result.exactCard.cardCount, 2);
    assert.equal(result.exactCard.placeholder, null);

    await dispatchMouse(client, `[data-session-id="${LEGACY_HUB_ID}"]`);
    result.legacyCard = await waitForCard(
      client,
      LEGACY_HUB_ID,
      'LEGACY PATH HISTORY QUESTION',
      'LEGACY PATH HISTORY ANSWER',
    );
    assert.equal(result.legacyCard.codexSid, LEGACY_SID,
      'path-only legacy resume must publish the SID learned synchronously by CodexTap');
    assert.equal(path.resolve(result.legacyCard.transcriptPath), path.resolve(fixtures.legacyPath));
    assert.equal(result.legacyCard.cardCount, 2);
    assert.equal(result.legacyCard.placeholder, null);
    await waitFor('legacy Codex picker invocation', () => readInvocations().length === 2);
    const legacyInvocations = readInvocations().filter(entry => !entry.args.includes(EXACT_SID));
    assert.equal(legacyInvocations.length, 1);
    assert.equal(legacyInvocations[0].args[0], 'resume');
    assert.equal(legacyInvocations[0].args.includes(LEGACY_SID), false,
      'a path-only legacy shell learns its SID for card identity but must not rewrite the already-started picker command');

    const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(shot.data, 'base64'));
    result.invocations = readInvocations();
    result.screenshot = SCREENSHOT_PATH;
    result.ok = true;
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify({
      ok: true,
      screenshot: SCREENSHOT_PATH,
      result: RESULT_PATH,
      exactCard: result.exactCard,
      legacyCard: result.legacyCard,
      invocations: result.invocations,
    }, null, 2));
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(TEMP_ROOT);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
        && path.basename(resolved).startsWith('hub-codex-resume-card-')) {
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
