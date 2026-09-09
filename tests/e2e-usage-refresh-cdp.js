'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const HUB_ROOT = path.resolve(__dirname, '..');
const ARTIFACT_DIR = path.join(HUB_ROOT, 'artifacts', '20260907-frost-v2');

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

async function screenshot(cdp, name) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACT_DIR, name), Buffer.from(shot.data, 'base64'));
}

async function verifyRingScenario(cdp, fixture, scenario) {
  const ring = '#rail-usage .rail-usage-button';
  if (scenario === 'empty') {
    await _waitMs(1500);
    assert.strictEqual(await cdp.eval(`document.querySelector('.rail-usage-value').textContent`), '—');
    assert.strictEqual(await cdp.eval(`document.querySelector('.rail-usage-button').dataset.freshness`), 'unknown');
    await click(cdp, ring);
    assert.strictEqual(await cdp.eval(`document.querySelectorAll('.usage-popover .usage-row-age').length`), 3);
    await screenshot(cdp, 'T5-empty.png');
    console.log('T5 real Hub scenario OK:', scenario);
    return;
  }
  const selected = scenario === 'low-balance' ? 'deepseek' : 'codex';
  await waitFor(cdp, `document.querySelector(${JSON.stringify(ring)}).dataset.provider === ${JSON.stringify(selected)}`);
  if (scenario !== 'stale') await waitFor(cdp, `accountUsageController.getSnapshot().codex?.source === 'app-server'`);
  const before = await cdp.eval(`(() => {
    const b = document.querySelector(${JSON.stringify(ring)});
    const r = b.querySelector('.rail-usage-ring');
    return { dataset: {...b.dataset}, label: b.getAttribute('aria-label'), value: r.textContent,
      diameter:r.getBoundingClientRect().width, inner:r.firstElementChild.getBoundingClientRect().width,
      font:getComputedStyle(r.firstElementChild).fontSize, color:getComputedStyle(r).color,
      danger:getComputedStyle(document.documentElement).getPropertyValue('--status-danger').trim(),
      border:getComputedStyle(r).borderStyle, background:getComputedStyle(r).backgroundImage,
      snapshot:accountUsageController.getSnapshot() };
  })()`);
  assert.strictEqual(before.diameter, 26);
  assert.strictEqual(before.inner, 19);
  assert.strictEqual(before.font, '7.5px');
  if (scenario === 'low-balance') {
    assert.strictEqual(before.value, '!');
    assert.strictEqual(before.dataset.level, 'warn');
    assert.ok(before.label.includes('¥10.00'));
  } else {
    assert.strictEqual(before.value, '88%');
    assert.strictEqual(before.dataset.level, 'danger');
  }
  if (scenario === 'stale') {
    assert.strictEqual(before.dataset.freshness, 'stale');
    assert.strictEqual(before.border, 'dashed');
    assert.strictEqual(before.background, 'none');
  } else assert.strictEqual(before.dataset.freshness, 'fresh');

  if (scenario === 'ring') {
    assert.ok(before.background.startsWith('conic-gradient'));
    // Verify actual resolved status color, not only a class/dataset.
    assert.strictEqual(await cdp.eval(`getComputedStyle(document.querySelector('.rail-usage-ring')).color === getComputedStyle(document.querySelector('.usage-window.danger')).color`), true);
    await screenshot(cdp, 'T5-rail-usage-ring.png');
  }
  await pointAt(cdp, ring);
  await waitFor(cdp, `!document.querySelector('.usage-popover').hidden`);
  await pointAt(cdp, '.usage-popover .usage-popover-title');
  await _waitMs(250);
  assert.strictEqual(await cdp.eval(`document.querySelector('.usage-popover').hidden`), false, 'hover bridge remains open');
  await click(cdp, ring); // pin the hovered popover
  if (scenario === 'ring') {
    assert.ok((await cdp.eval(`document.querySelector('.usage-age').textContent`)).includes('数据 11 分钟前'));
    await screenshot(cdp, 'T5-usage-popover.png');
    const themes = await cdp.eval(`Array.from(document.querySelectorAll('#options-theme-picker [data-theme-id]'), b => b.dataset.themeId)`);
    const themeResults = [];
    for (const theme of themes) {
      await click(cdp, '#btn-theme');
      await click(cdp, '[data-theme-id="' + theme + '"]');
      await click(cdp, ring);
      const colors = await cdp.eval(`(() => {
        const b=document.querySelector('.rail-usage-button'), p=document.querySelector('.usage-popover');
        return { theme:document.documentElement.dataset.theme, ring:getComputedStyle(b.querySelector('.rail-usage-ring')).color,
          danger:getComputedStyle(document.querySelector('.usage-window.danger')).color, text:getComputedStyle(p).color, background:getComputedStyle(p).backgroundColor,
          ticker:getComputedStyle(document.querySelector('#quota-ticker')).display };
      })()`);
      assert.strictEqual(colors.theme, theme);
      assert.strictEqual(colors.ring, colors.danger);
      assert.notStrictEqual(colors.text, colors.background);
      assert.strictEqual(colors.ticker, 'none');
      themeResults.push(colors);
      await screenshot(cdp, 'T5-theme-' + theme + '.png');
      await key(cdp, 'Escape', 'Escape', 27);
    }
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'T5-theme-verification.json'), JSON.stringify(themeResults, null, 2));
    await click(cdp, '#btn-theme');
    await click(cdp, '[data-theme-id="frost"]');
    await click(cdp, ring);
    // Updating data preserves the same focused refresh action and open dialog.
    fs.writeFileSync(fixture.controlPath, JSON.stringify({ mode: 'ring', percent: 66, delay: 800 }));
    const requestsBefore = fs.readFileSync(fixture.controlPath + '.requests', 'utf8').trim().split('\n').length;
    await click(cdp, '.usage-popover [data-action="refresh-usage"]');
    await waitFor(cdp, `document.querySelector('.usage-refresh').getAttribute('aria-disabled') === 'true'`);
    await click(cdp, '.usage-popover [data-action="refresh-usage"]');
    await waitFor(cdp, `document.querySelector('.rail-usage-value').textContent === '66%' && !accountUsageController.getSnapshot().refresh.inFlight`);
    assert.strictEqual(fs.readFileSync(fixture.controlPath + '.requests', 'utf8').trim().split('\n').length - requestsBefore, 1);
    assert.strictEqual(await cdp.eval(`document.activeElement === document.querySelector('.usage-refresh') && !document.querySelector('.usage-popover').hidden`), true);
    assert.strictEqual(await cdp.eval(`document.querySelector('.rail-usage-button').dataset.level`), 'warn');
    // Failure is produced by the controlled external app-server, through real IPC.
    fs.writeFileSync(fixture.controlPath, JSON.stringify({ error: true }));
    await click(cdp, '.usage-popover [data-action="refresh-usage"]');
    await waitFor(cdp, `!accountUsageController.getSnapshot().refresh.inFlight && document.querySelector('.usage-refresh-notice').textContent.includes('T5 controlled refresh failure')`);
    await key(cdp, 'Escape', 'Escape', 27);
    assert.strictEqual(await cdp.eval(`document.querySelector('.usage-popover').hidden && document.activeElement === document.querySelector('.rail-usage-button')`), true);
    await key(cdp, 'Enter', 'Enter', 13);
    assert.strictEqual(await cdp.eval(`document.querySelector('.usage-popover').hidden`), false);
    await click(cdp, '.usage-popover [data-action="open-memo"]');
    assert.notStrictEqual(await cdp.eval(`getComputedStyle(document.querySelector('#memo-panel')).display`), 'none');
    await click(cdp, '.usage-popover [data-action="open-memo"]');
    assert.strictEqual(await cdp.eval(`getComputedStyle(document.querySelector('#memo-panel')).display`), 'none');
    await click(cdp, '.usage-home');
    await waitFor(cdp, `document.querySelectorAll('#home-provider-health .home-provider-row').length >= 3`);
    assert.strictEqual(await cdp.eval(`document.querySelector('.usage-popover').hidden`), true);
    assert.ok((await cdp.eval(`document.querySelector('#home-provider-health').textContent`)).includes('Codex'));
    await click(cdp, '#btn-expand-sidebar');
    await click(cdp, ring);
    assert.strictEqual(await cdp.eval(`document.querySelector('.usage-popover').hidden`), false);
    // Narrow viewport placement, using the real layout engine.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 450, deviceScaleFactor: 1, mobile: false });
    await _waitMs(250);
    assert.strictEqual(await cdp.eval(`(() => { const r=document.querySelector('.usage-popover').getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight; })()`), true);
    await key(cdp, 'Escape', 'Escape', 27);
  }
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'T5-' + scenario + '-verification.json'), JSON.stringify({ scenario, before, completed: true }, null, 2));
  console.log('T5 real Hub scenario OK:', scenario);
}

async function run(scenario = 'regression') {
  const ARTIFACT_PATH = path.join(ARTIFACT_DIR, 'T5-' + scenario + '-refresh.png');
  const dataDir = path.join(os.tmpdir(), `claude-session-hub-usage-e2e-${process.pid}-${Date.now()}`);
  const port = await getFreePort();
  let hub = null;
  let cdp = null;
  const fixture = seedUsageData(dataDir, scenario);

  try {
    hub = await launchIsolatedHub({
      dataDir,
      port,
      label: 'usage-refresh-e2e-' + scenario,
      extraEnv: { APPDATA: fixture.fakeAppData },
    });
    cdp = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.bringToFront');
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await waitFor(cdp, `document.querySelectorAll('.usage-popover .usage-provider-row').length >= 3`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    assert.deepStrictEqual(await cdp.eval(`ipcRenderer.invoke('get-meetings')`), []);
    assert.ok(hub.log().some(line => line.includes('hook server listening')));
    assert.strictEqual(await cdp.eval(`getComputedStyle(document.querySelector('#quota-ticker')).display`), 'none');
    if (scenario !== 'regression') {
      await verifyRingScenario(cdp, fixture, scenario);
      return;
    }
    await click(cdp, '#rail-usage button');
    await waitFor(cdp, `!document.querySelector('.usage-popover').hidden`);
    await waitFor(cdp, `(() => {
      const codex = [...document.querySelectorAll('.usage-popover .usage-provider-row')]
        .find(seg => seg.dataset.provider === 'codex');
      const values = codex ? [...codex.querySelectorAll('.usage-window b')].map(el => el.textContent) : [];
      return codex && codex.title.includes('app-server') && values[0] === '—' && values[1] === '7%';
    })()`, 25000);

    const before = await cdp.eval(`(() => {
      return [...document.querySelectorAll('.usage-popover .usage-provider-row')].map(seg => ({
        provider: seg.dataset.provider || '',
        name: seg.querySelector('.usage-provider-name')?.textContent || '',
        text: seg.innerText,
        title: seg.title,
        values: [...seg.querySelectorAll('.usage-window b')].map(el => el.textContent),
      }));
    })()`);
    const beforeCodex = before.find(row => row.provider === 'codex');
    assert.deepStrictEqual(beforeCodex.values, ['—', '7%'],
      'startup app-server refresh must replace the controlled stale 100/28 cache');
    assert.ok(beforeCodex.title.includes('app-server'));
    const beforeManualObservedAt = await cdp.eval(`accountUsageController.getSnapshot().codex.observedAt`);

    await click(cdp, '.usage-popover [data-action="refresh-usage"]');

    await waitFor(cdp, `(() => {
      const codex = [...document.querySelectorAll('.usage-popover .usage-provider-row')]
        .find(seg => seg.dataset.provider === 'codex');
      const values = codex ? [...codex.querySelectorAll('.usage-window b')].map(el => el.textContent) : [];
      const snapshot = accountUsageController.getSnapshot();
      return codex && codex.title.includes('app-server') && values[0] === '—' && values[1] === '7%'
        && snapshot.refresh.lastManualAt > 0
        && snapshot.codex.observedAt >= ${beforeManualObservedAt};
    })()`, 25000);

    // Let the 5-second background JSONL scanner run once. A stale/incompatible
    // file snapshot must not overwrite the just-fetched account result.
    await _waitMs(6000);

    const after = await cdp.eval(`(() => {
      const segments = [...document.querySelectorAll('.usage-popover .usage-provider-row')].map(seg => ({
        provider: seg.dataset.provider || '',
        name: seg.querySelector('.usage-provider-name')?.textContent || '',
        text: seg.innerText,
        title: seg.title,
        values: [...seg.querySelectorAll('.usage-window b')].map(el => el.textContent),
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
      const rect = document.querySelector('.usage-popover').getBoundingClientRect();
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

(async () => {
  for (const scenario of (process.argv[2] ? [process.argv[2]] : ['regression', 'ring', 'low-balance', 'stale', 'empty'])) await run(scenario);
})().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
