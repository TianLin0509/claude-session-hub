'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const HUB_ROOT = path.resolve(__dirname, '..');
const SCREENSHOT_PATH = path.join(HUB_ROOT, 'output', 'playwright', 'sidebar-resource-strip-e2e.png');
const EGRESS_FIXTURE = JSON.stringify({
  foreign: { ok: true, ip: '38.246.239.122', countryCode: 'US', country: 'United States', countryZh: '美国', city: 'Los Angeles', cityZh: '洛杉矶', region: 'California', locationLabel: '美国·洛杉矶' },
  domestic: { ok: true, ip: '180.158.74.254', countryCode: 'CN', country: 'China', countryZh: '中国', city: 'Shanghai', cityZh: '上海', region: 'Shanghai', locationLabel: '中国·上海' },
});

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

async function waitFor(client, expression, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await client.eval(`Boolean(${expression})`)) return; } catch {}
    await _waitMs(250);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

(async () => {
  const dataDir = path.join(os.tmpdir(), `claude-session-hub-resource-strip-${process.pid}-${Date.now()}`);
  const workDir = path.join(dataDir, 'work');
  const port = await getFreePort();
  let hub = null;
  let client = null;
  const sessionIds = [];

  try {
    fs.mkdirSync(workDir, { recursive: true });
    hub = await launchIsolatedHub({
      dataDir,
      port,
      label: 'sidebar-resource-strip',
      extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_HUB_EGRESS_FIXTURE: EGRESS_FIXTURE },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url));
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await waitFor(client, `document.querySelector('#sidebar-strip')`);

    for (const title of ['Resource strip A', 'Resource strip B']) {
      const session = await client.eval(`require('electron').ipcRenderer.invoke('create-session', {
        kind: 'powershell',
        opts: { title: ${JSON.stringify(title)}, cwd: ${JSON.stringify(workDir)} }
      })`);
      assert.ok(session && session.id, JSON.stringify(session));
      sessionIds.push(session.id);
    }

    await waitFor(client, `(() => {
      const el = document.querySelector('#sidebar-strip');
      return el?.querySelectorAll('.strip-route-row').length === 2
        && /2\\s+活跃/.test(el.querySelector('.strip-active')?.innerText || '')
        && /CPU\\s+\\d+%.*M\\s+\\d+%/.test(el.querySelector('.strip-resource')?.innerText || '');
    })()`);

    const beforeClose = await client.eval(`(() => {
      const el = document.querySelector('#sidebar-strip');
      return {
        text: el.innerText.replace(/\\s+/g, ' ').trim(),
        foreignTitle: el.querySelector('.strip-route-foreign')?.title || '',
        domesticTitle: el.querySelector('.strip-route-domestic')?.title || '',
        display: getComputedStyle(el).display,
      };
    })()`);
    assert.ok(!/等你|ctx|🔥|%\/h/.test(beforeClose.text), beforeClose.text);
    assert.match(beforeClose.foreignTitle, /实测公网 IPv4/);
    assert.match(beforeClose.domesticTitle, /实测公网 IPv4/);
    assert.strictEqual(beforeClose.display, 'flex');

    await client.eval(`require('electron').ipcRenderer.invoke('close-session', ${JSON.stringify(sessionIds.pop())})`);
    await waitFor(client, `/1\\s+活跃/.test(document.querySelector('#sidebar-strip .strip-active')?.innerText || '')`);

    const afterClose = await client.eval(`(() => {
      const el = document.querySelector('#sidebar-strip');
      const rect = el.getBoundingClientRect();
      return {
        text: el.innerText.replace(/\\s+/g, ' ').trim(),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
    })()`);
    const shot = await client.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      clip: { ...afterClose.rect, scale: 1 },
    });
    fs.mkdirSync(path.dirname(SCREENSHOT_PATH), { recursive: true });
    fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(shot.data, 'base64'));

    console.log(JSON.stringify({
      ok: true,
      beforeClose,
      afterClose,
      screenshot: SCREENSHOT_PATH,
      isolatedDataDir: dataDir,
      isolatedHubPid: hub.pid,
      cdpPort: port,
      hubLogTail: hub.log().slice(-12),
    }, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    if (hub) console.error(hub.log().slice(-50).join('\n'));
    process.exitCode = 1;
  } finally {
    if (client) {
      for (const sessionId of sessionIds) {
        try { await client.eval(`require('electron').ipcRenderer.invoke('close-session', ${JSON.stringify(sessionId)})`); } catch {}
      }
      try { await client.close(); } catch {}
    }
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(dataDir);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
        && path.basename(resolved).startsWith('claude-session-hub-resource-strip-')) {
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  }
})();
