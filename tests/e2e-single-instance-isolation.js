'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const HUB_ROOT = path.resolve(__dirname, '..');
const ARTIFACT_DIR = path.join(HUB_ROOT, 'output', 'playwright', 'multi-instance');

async function capture(client, filePath) {
  const shot = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  fs.writeFileSync(filePath, Buffer.from(shot.data, 'base64'));
}

async function inspectRenderer(client, label, pid) {
  return await client.eval(`(async () => {
    const deadline = Date.now() + 10000;
    while (!document.getElementById('app-container') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    document.getElementById('multi-instance-e2e-badge')?.remove();
    const badge = document.createElement('div');
    badge.id = 'multi-instance-e2e-badge';
    badge.textContent = ${JSON.stringify(label)} + ' · main PID ' + ${JSON.stringify(pid)};
    badge.style.cssText = 'position:fixed;right:18px;top:58px;z-index:100000;padding:9px 14px;border-radius:10px;background:#16a34a;color:white;font:600 14px sans-serif;box-shadow:0 6px 20px #0008';
    document.body.appendChild(badge);
    return {
      title: document.title,
      shellPresent: !!document.getElementById('app-container'),
      badge: badge.textContent,
      url: location.href,
    };
  })()`);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-single-instance-'));
  const dataDir = path.join(root, 'data');
  const runId = `${Date.now()}-${process.pid}`;
  const firstPort = 19431;
  const secondPort = 19432;
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const primaryScreenshot = path.join(ARTIFACT_DIR, `primary-${runId}.png`);
  const secondaryScreenshot = path.join(ARTIFACT_DIR, `secondary-${runId}.png`);
  const resultPath = path.join(ARTIFACT_DIR, `result-${runId}.json`);
  const primary = await launchIsolatedHub({
    dataDir,
    port: firstPort,
    label: 'multi-instance-primary',
    extraEnv: { CLAUDE_HUB_E2E: '1' },
  });
  let secondary = null;
  let primaryClient = null;
  let secondaryClient = null;
  try {
    secondary = await launchIsolatedHub({
      dataDir,
      port: secondPort,
      label: 'multi-instance-secondary',
      extraEnv: { CLAUDE_HUB_E2E: '1' },
    });
    assert.equal(primary.isAlive(), true, 'primary isolated Hub must remain alive');
    assert.equal(secondary.isAlive(), true, 'second Hub sharing the data directory must remain alive');
    const [firstVersion, secondVersion] = await Promise.all([
      fetch(`http://127.0.0.1:${firstPort}/json/version`).then(response => response.json()),
      fetch(`http://127.0.0.1:${secondPort}/json/version`).then(response => response.json()),
    ]);
    assert.ok(firstVersion.webSocketDebuggerUrl, 'primary CDP remains responsive');
    assert.ok(secondVersion.webSocketDebuggerUrl, 'secondary CDP remains responsive');
    primaryClient = await connectFirstPage(primary, target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url || ''));
    secondaryClient = await connectFirstPage(secondary, target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url || ''));
    await Promise.all([
      primaryClient.send('Page.enable'),
      secondaryClient.send('Page.enable'),
      primaryClient.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 860, deviceScaleFactor: 1, mobile: false }),
      secondaryClient.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 860, deviceScaleFactor: 1, mobile: false }),
    ]);
    const [primaryUi, secondaryUi] = await Promise.all([
      inspectRenderer(primaryClient, 'Hub A 已启动', primary.pid),
      inspectRenderer(secondaryClient, 'Hub B 已启动', secondary.pid),
    ]);
    assert.equal(primaryUi.shellPresent, true, 'primary renderer shell must be usable');
    assert.equal(secondaryUi.shellPresent, true, 'secondary renderer shell must be usable');
    await Promise.all([
      capture(primaryClient, primaryScreenshot),
      capture(secondaryClient, secondaryScreenshot),
    ]);
    const result = {
      ok: true,
      dataDir,
      primaryPid: primary.pid,
      secondaryPid: secondary.pid,
      primaryAlive: primary.isAlive(),
      secondaryAlive: secondary.isAlive(),
      primaryUi,
      secondaryUi,
      screenshots: [primaryScreenshot, secondaryScreenshot],
    };
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify({ ...result, resultPath }));
  } finally {
    if (secondaryClient) await secondaryClient.close().catch(() => {});
    if (primaryClient) await primaryClient.close().catch(() => {});
    await gracefulQuit(secondary);
    await gracefulQuit(primary);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
