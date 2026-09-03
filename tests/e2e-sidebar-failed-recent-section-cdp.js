'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-sidebar-failed-recent-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'sidebar-sections');
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `sidebar-failed-recent-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `sidebar-failed-recent-${RUN_ID}.json`);

function availablePort(preferred) {
  return new Promise((resolve, reject) => {
    const tryPort = port => {
      const server = net.createServer();
      server.once('error', () => tryPort(port + 1));
      server.once('listening', () => server.close(() => resolve(port)));
      server.listen(port, '127.0.0.1');
    };
    try { tryPort(preferred); } catch (error) { reject(error); }
  });
}

async function waitFor(client, expression, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await client.eval(`Boolean(${expression})`)) return; } catch (_) {}
    await _waitMs(80);
  }
  throw new Error(`timeout waiting for ${expression}`);
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const port = await availablePort(Number(process.env.HUB_SIDEBAR_SECTION_E2E_PORT || 19940));
  const result = { runId: RUN_ID, port, screenshot: SCREENSHOT_PATH, resultPath: RESULT_PATH };
  let hub = null;
  let client = null;
  let failure = null;

  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'sidebar-failed-recent',
      windowMode: 'hidden',
      extraEnv: { CLAUDE_HUB_E2E: '1', DEEPSEEK_API_KEY: '' },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url || ''));
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 780, height: 940, deviceScaleFactor: 1, mobile: false,
    });
    await waitFor(client, `window.__hubE2E && window.__hubE2E.addFakeSessions`);

    const now = Date.now();
    const fixtures = [
      {
        id: 'failed-only-e2e', kind: 'codex', title: '分支任务连接异常', status: 'failed',
        lastError: 'stream disconnected', createdAt: now - 60_000, lastMessageTime: now - 60_000,
        runtimeTruth: {
          state: 'failed', source: 'e2e-stream-disconnect', confidence: 'authoritative',
          observedAt: now - 60_000, evidence: 'stream disconnected',
        },
      },
      { id: 'recent-one-e2e', kind: 'claude', title: 'AI HUB复制失灵问题排查', status: 'idle', createdAt: now - 120_000, lastMessageTime: now - 120_000 },
      { id: 'recent-two-e2e', kind: 'gemini', title: '学习 · 主笔 · Claude', status: 'idle', createdAt: now - 180_000, lastMessageTime: now - 180_000 },
      { id: 'recent-three-e2e', kind: 'claude', title: '组长工作台已就绪。', status: 'idle', createdAt: now - 240_000, lastMessageTime: now - 240_000 },
    ];
    await client.eval(`(() => {
      window.__hubE2E.clearSessions();
      window.__hubE2E.addFakeSessions(${JSON.stringify(fixtures)});
      return true;
    })()`);
    await waitFor(client, `document.querySelectorAll('#session-list > .session-sec-header').length === 2`);

    result.sections = await client.eval(`(() => {
      const rows = Array.from(document.querySelectorAll('#session-list > *'));
      const headers = [];
      const sectionBySession = {};
      let current = null;
      for (const row of rows) {
        if (row.classList.contains('session-sec-header')) {
          current = row.querySelector('span')?.textContent || '';
          headers.push(current);
        } else if (row.dataset && row.dataset.sessionId) {
          sectionBySession[row.dataset.sessionId] = current;
        }
      }
      const sidebar = document.querySelector('.session-sidebar').getBoundingClientRect();
      return {
        headers,
        sectionBySession,
        runningHeaders:headers.filter(value => value === '运行中').length,
        rect:{ x:sidebar.x, y:sidebar.y, width:sidebar.width, height:sidebar.height },
      };
    })()`);
    assert.deepEqual(result.sections.headers, ['⚠ 运行异常', '最近']);
    assert.equal(result.sections.runningHeaders, 0);
    assert.equal(result.sections.sectionBySession['failed-only-e2e'], '⚠ 运行异常');
    assert.equal(result.sections.sectionBySession['recent-one-e2e'], '最近');

    await _waitMs(250);
    const rect = result.sections.rect;
    const shot = await client.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
      clip: {
        x: Math.max(0, rect.x), y: Math.max(0, rect.y),
        width: Math.max(1, rect.width), height: Math.max(1, Math.min(rect.height, 940 - Math.max(0, rect.y))),
        scale: 1,
      },
    });
    fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(shot.data, 'base64'));
    result.success = true;
  } catch (error) {
    failure = error;
    if (hub) console.error('[isolated hub log]\n' + hub.log().slice(-80).join('\n'));
  } finally {
    try {
      if (client) await client.close().catch(() => {});
      if (hub) {
        try { result.teardown = await gracefulQuit(hub); }
        catch (error) { if (!failure) failure = error; }
      }
    } finally {
      const resolved = path.resolve(TEMP_ROOT);
      if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
          && path.basename(resolved).startsWith('hub-sidebar-failed-recent-')) {
        fs.rmSync(resolved, { recursive: true, force: true });
      }
    }
  }

  if (failure) throw failure;
  fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
  console.error(error && (error.stack || error.message));
  process.exit(1);
});
