'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const HUB_ROOT = path.resolve(__dirname, '..');
const GUIDE_PATH = 'C:\\Users\\lintian\\公司文件中转-使用说明.html';
const OUTPUT_DIR = path.join(HUB_ROOT, 'output', 'playwright', 'company-drop');

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
    if (await client.eval(expression)) return;
    await _waitMs(250);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function capture(client, filename) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const target = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
  return target;
}

async function run() {
  assert.equal(fs.existsSync(GUIDE_PATH), true, `missing guide: ${GUIDE_PATH}`);
  const dataDir = path.join(os.tmpdir(), `claude-session-hub-company-sync-${process.pid}-${Date.now()}`);
  const port = await getFreePort();
  let hub = null;
  let cdp = null;

  try {
    hub = await launchIsolatedHub({ dataDir, port, label: 'path-company-sync-e2e' });
    cdp = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.bringToFront');
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await waitFor(cdp, `document.querySelector('[data-action="sync-company"]') !== null`);

    const linkRect = await cdp.eval(`(() => {
      const fixture = document.createElement('div');
      fixture.id = 'company-sync-e2e-fixture';
      Object.assign(fixture.style, {
        position: 'fixed', left: '280px', top: '180px', zIndex: '11000',
        padding: '22px', borderRadius: '14px', background: '#fff', color: '#16302b',
        boxShadow: '0 12px 36px rgba(0,0,0,.24)'
      });
      const link = document.createElement('a');
      link.id = 'company-sync-e2e-link';
      link.className = 'rt-file-link';
      link.dataset.path = ${JSON.stringify(GUIDE_PATH)};
      link.href = '#';
      link.textContent = ${JSON.stringify(GUIDE_PATH)};
      fixture.appendChild(link);
      document.body.appendChild(fixture);
      const rect = link.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);

    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: linkRect.x, y: linkRect.y, button: 'right', clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: linkRect.x, y: linkRect.y, button: 'right', clickCount: 1,
    });
    await waitFor(cdp, `document.getElementById('path-link-context-menu').style.display === 'block'`);
    const menuItems = await cdp.eval(`[...document.querySelectorAll('#path-link-context-menu .context-menu-item')]
      .filter(el => el.style.display !== 'none').map(el => el.textContent.trim())`);
    assert.ok(menuItems.includes('同步到公司'), 'context menu should expose 同步到公司');
    const menuScreenshot = await capture(cdp, '01-hub-path-menu-sync-company.png');

    const buttonRect = await cdp.eval(`(() => {
      const rect = document.querySelector('[data-action="sync-company"]').getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: buttonRect.x, y: buttonRect.y, button: 'left', clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: buttonRect.x, y: buttonRect.y, button: 'left', clickCount: 1,
    });
    await waitFor(cdp, `(() => {
      const el = document.getElementById('path-link-sync-status');
      return el && (el.dataset.state === 'success' || el.dataset.state === 'error');
    })()`, 120000);
    const status = await cdp.eval(`(() => {
      const el = document.getElementById('path-link-sync-status');
      return { state: el.dataset.state, text: el.textContent, opacity: el.style.opacity };
    })()`);
    assert.equal(status.state, 'success', status.text);
    assert.match(status.text, /已同步到公司收件箱/);
    const successScreenshot = await capture(cdp, '02-hub-company-sync-success.png');

    console.log(JSON.stringify({
      ok: true,
      guidePath: GUIDE_PATH,
      menuItems,
      status,
      menuScreenshot,
      successScreenshot,
      isolatedDataDir: dataDir,
      cdpPort: port,
      hubLogTail: hub.log().slice(-15),
    }, null, 2));
  } finally {
    if (cdp) await cdp.close();
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(dataDir);
    const tempRoot = path.resolve(os.tmpdir()) + path.sep;
    if (resolved.toLowerCase().startsWith(tempRoot.toLowerCase()) && path.basename(resolved).startsWith('claude-session-hub-company-sync-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
