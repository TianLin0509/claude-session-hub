'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const HUB_ROOT = path.resolve(__dirname, '..');
const ARTIFACT_PATH = path.join(HUB_ROOT, 'artifacts', 'usage-refresh-e2e-20260711.png');

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
          primary: { usedPercent: 7, resetsAt: ${primaryResetSec} },
          secondary: { usedPercent: 1, resetsAt: ${weeklyResetSec} }
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
    await waitFor(cdp, `document.querySelectorAll('#account-usage .acc-usage-row').length === 2`);

    const before = await cdp.eval(`(() => {
      const rows = [...document.querySelectorAll('#account-usage .acc-usage-row')];
      return rows.map(row => ({
        text: row.innerText,
        title: row.title,
        values: [...row.querySelectorAll('.acc-bar-pct')].map(el => el.textContent),
      }));
    })()`);
    assert.deepStrictEqual(before[1].values, ['100%', '28%'],
      'the controlled stale JSONL/cache fixture must be visible before refresh');

    const clicked = await cdp.eval(`(() => {
      const buttons = document.querySelectorAll('[data-action="refresh-usage"]');
      if (buttons.length < 2) return false;
      buttons[1].click();
      return true;
    })()`);
    assert.strictEqual(clicked, true, 'Codex refresh button should be clickable');

    await waitFor(cdp, `(() => {
      const rows = document.querySelectorAll('#account-usage .acc-usage-row');
      return rows[1] && rows[1].querySelector('.acc-refresh-status')?.textContent === '实时';
    })()`, 25000);

    // Let the 5-second background JSONL scanner run once. A stale/incompatible
    // file snapshot must not overwrite the just-fetched account result.
    await _waitMs(6000);

    const after = await cdp.eval(`(() => {
      const rows = [...document.querySelectorAll('#account-usage .acc-usage-row')];
      const summarize = row => ({
        text: row.innerText,
        title: row.title,
        status: row.querySelector('.acc-refresh-status')?.textContent || '',
        widths: [...row.querySelectorAll('.acc-bar-fill')].map(el => el.style.width),
        values: [...row.querySelectorAll('.acc-bar-pct')].map(el => el.textContent),
      });
      return rows.map(summarize);
    })()`);

    assert.strictEqual(after[0].status, '无新快照', 'Claude must report that manual refresh only re-read the same statusline snapshot');
    assert.ok(after[0].values.includes('101%'), 'Claude raw over-limit percentage should remain visible');
    assert.ok(after[0].widths.every(width => Number.parseFloat(width) <= 100), 'Usage bars must not overflow 100% width');
    assert.strictEqual(after[1].status, '实时', 'Codex must report a live app-server refresh');
    assert.ok(after[1].title.includes('app-server'), 'Codex row must expose the live source');
    assert.deepStrictEqual(after[1].values, ['7%', '1%'],
      'controlled app-server values must replace 100/28 and survive the background JSONL scan');

    await cdp.send('Page.bringToFront');
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await _waitMs(500);
    const clip = await cdp.eval(`(() => {
      const rect = document.querySelector('#account-usage').getBoundingClientRect();
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
