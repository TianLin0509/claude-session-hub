'use strict';
const fs = require('fs');
const net = require('net');
const path = require('path');
const { _waitMs } = require('./hub-launcher');

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

function seedUsageData(dataDir, scenario) {
  const ringScenario = scenario !== 'regression';
  const claudePct = ringScenario ? 12 : 101;
  const codexPct = scenario === 'low-balance' ? 24 : ringScenario ? 88 : 100;
  const controlPath = path.join(dataDir, 'controlled-app-server.json');
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
      usage5h: { pct: codexPct, resetsAt: primaryResetSec * 1000 },
      usage7d: { pct: 28, resetsAt: weeklyResetSec * 1000 },
      observedAt,
      ts: Date.now(),
      source: 'jsonl',
    },
    deepseek: { totalBalance: scenario === 'low-balance' ? 10 : 60.6, currency: 'CNY', observedAt: Date.now() - (scenario === 'ring' ? 660000 : 0) },
    claude: {
      usage5h: { pct: claudePct, resetsAt: claudePrimaryReset },
      usage7d: { pct: 14, resetsAt: claudeWeeklyReset },
      ts: observedAt,
    },
  }), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'statusline-cache.json'), JSON.stringify({
    'session-usage-e2e': {
      ts: observedAt,
      usage5h: { pct: claudePct, resetsAt: claudePrimaryReset },
      usage7d: { pct: 14, resetsAt: claudeWeeklyReset },
    },
  }), 'utf8');

  fs.writeFileSync(path.join(rolloutDir, 'rollout-stale-e2e.jsonl'), JSON.stringify({
    timestamp: new Date(observedAt).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: codexPct, resets_at: primaryResetSec },
        secondary: { used_percent: 28, resets_at: weeklyResetSec },
      },
    },
  }) + '\n', 'utf8');

  fs.writeFileSync(controlPath, JSON.stringify({ mode: ringScenario ? 'ring' : 'weekly', percent: codexPct, error: scenario === 'stale' || scenario === 'empty', delay: 0 }));
  if (scenario === 'empty') {
    fs.writeFileSync(path.join(dataDir, 'usage-cache.json'), '{}');
    fs.writeFileSync(path.join(dataDir, 'statusline-cache.json'), '{}');
    fs.unlinkSync(path.join(rolloutDir, 'rollout-stale-e2e.jsonl'));
  }
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
    const control = JSON.parse(require('fs').readFileSync(${JSON.stringify(controlPath)}, 'utf8'));
    require('fs').appendFileSync(${JSON.stringify(controlPath + '.requests')}, 'read\\n');
    if (control.error) {
      process.stdout.write(JSON.stringify({ id: request.id, error: { code: -32000, message: 'T5 controlled refresh failure' } }) + '\\n');
      return;
    }
    if (control.mode === 'ring') {
      setTimeout(() => process.stdout.write(JSON.stringify({ id: request.id, result: { rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: control.percent, windowDurationMins: 300, resetsAt: ${primaryResetSec} },
        secondary: { usedPercent: 28, windowDurationMins: 10080, resetsAt: ${weeklyResetSec} }
      } } }) + '\\n'), control.delay || 0);
      return;
    }
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
    controlPath,
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

async function pointAt(cdp, selector) {
  const point = await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('missing target');
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    if (!r.width || !r.height || !el.contains(document.elementFromPoint(x, y))) throw new Error('target is hidden or covered');
    return { x, y };
  })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  return point;
}

async function click(cdp, selector) {
  const point = await pointAt(cdp, selector);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
}

async function key(cdp, key, code, virtualKey) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKey,
    ...(key === 'Enter' ? { text: '\r' } : {}) });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey });
}


module.exports = { getFreePort, seedUsageData, waitFor, click, key };
