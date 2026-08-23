'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const HUB_ROOT = path.resolve(__dirname, '..');
const ARTIFACT_PATH = path.join(HUB_ROOT, 'output', 'playwright', 'usage-refresh', 'usage-refresh-e2e.png');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function seedUsageData(dataDir) {
  const observedAt = Date.now() - 5 * 60 * 1000;
  const primaryResetSec = Math.floor((Date.now() + 4 * 60 * 60 * 1000) / 1000);
  const weeklyResetSec = Math.floor((Date.now() + 6 * 86400 * 1000) / 1000);
  const claudePrimaryReset = Date.now() + 60 * 60 * 1000;
  const claudeWeeklyReset = Date.now() + 6 * 86400 * 1000;
  const codexHome = path.join(dataDir, 'codex-e2e-home');
  const sessionsRoot = path.join(codexHome, 'sessions');
  const fakeAppData = path.join(dataDir, 'fake-appdata');
  const fakeNpmDir = path.join(fakeAppData, 'npm');
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  const rolloutDir = path.join(
    sessionsRoot,
    String(now.getFullYear()),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  );
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(rolloutDir, { recursive: true });
  fs.mkdirSync(fakeNpmDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    providers: {
      codex: {
        backend: 'subscription',
        subscription_profile: 'default',
        subscription_profiles: [
          { id: 'default', label: 'E2E account', home: codexHome },
        ],
      },
    },
  }), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'usage-cache.json'), JSON.stringify({
    codex: {
      usage5h: { pct: 100, resetsAt: primaryResetSec * 1000 },
      usage7d: { pct: 28, resetsAt: weeklyResetSec * 1000 },
      observedAt,
      ts: Date.now(),
      source: 'jsonl',
    },
    claude: {
      usage5h: { pct: 101, resetsAt: claudePrimaryReset },
      usage7d: { pct: 14, resetsAt: claudeWeeklyReset },
      ts: observedAt,
    },
  }), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'statusline-cache.json'), JSON.stringify({
    'session-usage-e2e': {
      ts: observedAt,
      usage5h: { pct: 101, resetsAt: claudePrimaryReset },
      usage7d: { pct: 14, resetsAt: claudeWeeklyReset },
    },
  }), 'utf8');

  fs.writeFileSync(path.join(rolloutDir, 'rollout-stale-e2e.jsonl'), JSON.stringify({
    timestamp: new Date(observedAt).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 100, resets_at: primaryResetSec },
        secondary: { used_percent: 28, resets_at: weeklyResetSec },
      },
    },
  }) + '\n', 'utf8');

  const fakeServerPath = path.join(fakeNpmDir, 'fake-codex-app-server.js');
  fs.writeFileSync(fakeServerPath, `'use strict';
const readline = require('readline');
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: request.id, result: { userAgent: 'usage-e2e' } }) + '\\n');
  } else if (request.method === 'account/rateLimits/read') {
    process.stdout.write(JSON.stringify({
      id: request.id,
      result: {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: ${weeklyResetSec} },
          secondary: null
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: 'codex',
            primary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: ${weeklyResetSec} },
            secondary: null
          },
          codex_bengalfox: {
            limitId: 'codex_bengalfox',
            primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: ${primaryResetSec} },
            secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: ${weeklyResetSec} }
          }
        }
      }
    }) + '\\n');
  }
});
`, 'utf8');
  fs.writeFileSync(path.join(fakeNpmDir, 'codex.cmd'),
    `@echo off\r\n"${process.execPath}" "${fakeServerPath}" %*\r\n`, 'utf8');

  return {
    codexHome,
    fakeAppData,
    rolloutPath: path.join(rolloutDir, 'rollout-stale-e2e.jsonl'),
  };
}

async function waitFor(client, expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await client.eval(expression)) return;
    await _waitMs(250);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function run() {
  const dataDir = path.join(os.tmpdir(), `claude-session-hub-usage-e2e-${process.pid}-${Date.now()}`);
  const port = await getFreePort();
  let hub = null;
  let cdp = null;
  const fixture = seedUsageData(dataDir);

  try {
    hub = await launchIsolatedHub({
      dataDir,
      port,
      label: 'usage-refresh-e2e',
      extraEnv: { APPDATA: fixture.fakeAppData },
    });
    cdp = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await waitFor(cdp, `document.querySelectorAll('#quota-ticker .qt-seg').length >= 3`);
    await waitFor(cdp, `(() => {
      const codex = [...document.querySelectorAll('#quota-ticker .qt-seg')]
        .find(seg => seg.dataset.provider === 'codex');
      const values = codex ? [...codex.querySelectorAll('.qt-win b')].map(el => el.textContent) : [];
      return codex && codex.title.includes('app-server') && values[0] === '—' && values[1] === '7%';
    })()`, 25000);

    const before = await cdp.eval(`(() => {
      return [...document.querySelectorAll('#quota-ticker .qt-seg')].map(seg => ({
        provider: seg.dataset.provider || '',
        name: seg.querySelector('.qt-name')?.textContent || '',
        text: seg.innerText,
        title: seg.title,
        values: [...seg.querySelectorAll('.qt-win b')].map(el => el.textContent),
      }));
    })()`);
    const beforeCodex = before.find(row => row.provider === 'codex');
    assert.deepStrictEqual(beforeCodex.values, ['—', '7%'],
      'startup app-server refresh must replace the controlled stale 100/28 cache');
    assert.ok(beforeCodex.title.includes('app-server'));
    const beforeManualObservedAt = await cdp.eval(`accountUsageController.getSnapshot().codex.observedAt`);

    const clicked = await cdp.eval(`(() => {
      const buttons = document.querySelectorAll('[data-action="refresh-usage"]');
      if (buttons.length < 1) return false;
      buttons[0].click();
      return true;
    })()`);
    assert.strictEqual(clicked, true, 'Codex refresh button should be clickable');

    await waitFor(cdp, `(() => {
      const codex = [...document.querySelectorAll('#quota-ticker .qt-seg')]
        .find(seg => seg.dataset.provider === 'codex');
      const values = codex ? [...codex.querySelectorAll('.qt-win b')].map(el => el.textContent) : [];
      const snapshot = accountUsageController.getSnapshot();
      return codex && codex.title.includes('app-server') && values[0] === '—' && values[1] === '7%'
        && snapshot.refresh.lastManualAt > 0
        && snapshot.codex.observedAt >= ${beforeManualObservedAt};
    })()`, 25000);

    // Let the 5-second background JSONL scanner run once. A stale/incompatible
    // file snapshot must not overwrite the just-fetched account result.
    await _waitMs(6000);

    const after = await cdp.eval(`(() => {
      const segments = [...document.querySelectorAll('#quota-ticker .qt-seg')].map(seg => ({
        provider: seg.dataset.provider || '',
        name: seg.querySelector('.qt-name')?.textContent || '',
        text: seg.innerText,
        title: seg.title,
        values: [...seg.querySelectorAll('.qt-win b')].map(el => el.textContent),
      }));
      return { segments, snapshot: accountUsageController.getSnapshot() };
    })()`);

    const afterClaude = after.segments.find(row => row.provider === 'claude');
    const afterCodex = after.segments.find(row => row.provider === 'codex');
    assert.ok(afterClaude.values.includes('101%'), 'Claude raw over-limit percentage should remain visible');
    assert.ok(afterCodex.title.includes('app-server'), 'Codex segment must expose the live source');
    assert.deepStrictEqual(afterCodex.values, ['—', '7%'],
      'weekly-only app-server values must be labeled 7d and survive the background JSONL scan');
    assert.strictEqual(after.snapshot.codex.source, 'app-server');

    await cdp.send('Page.bringToFront');
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await _waitMs(500);
    const clip = await cdp.eval(`(() => {
      const rect = document.querySelector('#quota-ticker').getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })()`);
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      clip: { ...clip, scale: 1 },
    });
    fs.mkdirSync(path.dirname(ARTIFACT_PATH), { recursive: true });
    fs.writeFileSync(ARTIFACT_PATH, Buffer.from(shot.data, 'base64'));

    console.log(JSON.stringify({
      ok: true,
      workdir: HUB_ROOT,
      cdpPort: port,
      dataDir,
      controlledCodexHome: fixture.codexHome,
      controlledRollout: fixture.rolloutPath,
      before,
      after,
      screenshot: ARTIFACT_PATH,
      hubLogTail: hub.log().slice(-12),
    }, null, 2));
  } finally {
    if (cdp) await cdp.close();
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(dataDir);
    const tempRoot = path.resolve(os.tmpdir());
    if (resolved.toLowerCase().startsWith((tempRoot + path.sep).toLowerCase())) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

run().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
