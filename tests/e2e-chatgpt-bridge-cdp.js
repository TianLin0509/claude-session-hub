'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const HUB_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(HUB_ROOT, 'output', 'playwright', 'chatgpt-bridge');

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
  const dataDir = path.join(os.tmpdir(), `claude-session-hub-chatgpt-bridge-${process.pid}-${Date.now()}`);
  const port = await getFreePort();
  let hub = null;
  let cdp = null;
  try {
    hub = await launchIsolatedHub({
      dataDir,
      port,
      label: 'chatgpt-bridge-e2e',
      windowMode: 'hidden',
    });
    cdp = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await waitFor(cdp, `document.getElementById('card-selection-context-menu') !== null`);

    const bridgeStatus = await cdp.eval(`require('electron').ipcRenderer.invoke('chatgpt-bridge:status')`);
    assert.equal(bridgeStatus.ok, true, bridgeStatus.error || 'bridge status failed');
    assert.equal(bridgeStatus.logged_in, true, 'dedicated ChatGPT browser must be logged in');

    await cdp.eval(`(() => {
      document.getElementById('terminal-panel').classList.add('card-view-active');
      const overlay = document.getElementById('msg-overlay');
      overlay.style.display = 'block';
      overlay.innerHTML = '<div class="turn-card" data-turn-id="bridge-e2e-turn"><div class="turn-content"><div class="turn-head"><span class="turn-who">Codex</span><div class="turn-actions"><button class="ta-btn ta-company" data-action="sync-chatgpt" title="同步此回答到公司 ChatGPT">公司</button></div></div><div class="turn-body">Hub UI E2E：最近回答自动同步可用。</div></div></div>';
      window._sessionTurns = window._sessionTurns || new Map();
      window._sessionTurns.set('bridge-e2e-turn', { id: 'bridge-e2e-turn', role: 'assistant', text: 'Hub UI E2E：最近回答自动同步可用。' });
      return true;
    })()`);

    const cardState = await cdp.eval(`(() => {
      const action = document.querySelector('.turn-card [data-action="sync-chatgpt"]');
      const rect = action.getBoundingClientRect();
      return {
        topBridgeExists: !!document.getElementById('chatgpt-bridge-actions'),
        actionText: action.textContent.trim(),
        actionTitle: action.title,
        actionWidth: rect.width,
        actionHeight: rect.height,
      };
    })()`);
    assert.equal(cardState.topBridgeExists, false, 'the obsolete top bridge toolbar must be removed');
    assert.equal(cardState.actionText, '公司');
    assert.match(cardState.actionTitle, /同步此回答/);
    assert.ok(cardState.actionWidth > 30 && cardState.actionHeight > 15);

    const cardRect = await cdp.eval(`(() => {
      const rect = document.querySelector('.turn-card').getBoundingClientRect();
      return { x: rect.right - 24, y: rect.top + 18 };
    })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cardRect.x, y: cardRect.y });
    const companyButtonScreenshot = await capture(cdp, '00-chatgpt-card-company-button.png');

    await cdp.eval(`document.querySelector('.turn-card [data-action="sync-chatgpt"]').click()`);
    await waitFor(cdp, `(() => {
      const el = document.getElementById('chatgpt-bridge-status');
      return el && (el.dataset.state === 'success' || el.dataset.state === 'error');
    })()`, 120000);
    const pushStatus = await cdp.eval(`(() => {
      const el = document.getElementById('chatgpt-bridge-status');
      return { state: el.dataset.state, text: el.textContent };
    })()`);
    assert.equal(pushStatus.state, 'success', pushStatus.text);
    assert.match(pushStatus.text, /已同步到公司 ChatGPT/);

    await cdp.eval(`(() => {
      const body = document.querySelector('.turn-card .turn-body');
      const range = document.createRange();
      range.selectNodeContents(body);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const rect = body.getBoundingClientRect();
      body.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles:true, cancelable:true, clientX:rect.left + 30, clientY:rect.top + 15,
      }));
      return selection.toString();
    })()`);
    await waitFor(cdp, `document.getElementById('card-selection-context-menu').style.display === 'block'`);
    const selectionMenuItems = await cdp.eval(`[...document.querySelectorAll('#card-selection-context-menu .context-menu-item')]
      .map(el => el.textContent.trim())`);
    assert.deepEqual(selectionMenuItems, ['复制', '同步到公司 ChatGPT']);
    const cardScreenshot = await capture(cdp, '01-chatgpt-card-company-selection.png');
    await cdp.eval(`document.getElementById('card-selection-context-menu').style.display = 'none'`);

    await cdp.eval(`(() => {
      const link = document.createElement('a');
      link.id = 'chatgpt-bridge-url-fixture';
      link.className = 'rt-file-link';
      link.dataset.path = 'https://example.test/company-context';
      link.href = '#';
      link.textContent = 'https://example.test/company-context';
      Object.assign(link.style, { position: 'fixed', left: '320px', top: '180px', zIndex: '12000', padding: '12px', background: '#fff' });
      document.body.appendChild(link);
      link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 360, clientY: 200 }));
      return true;
    })()`);
    await waitFor(cdp, `document.getElementById('path-link-context-menu').style.display === 'block'`);
    const menuItems = await cdp.eval(`[...document.querySelectorAll('#path-link-context-menu .context-menu-item')]
      .filter(el => el.style.display !== 'none').map(el => el.textContent.trim())`);
    assert.ok(menuItems.includes('同步内容到公司 ChatGPT'));
    const pathScreenshot = await capture(cdp, '02-chatgpt-path-actions.png');

    console.log(JSON.stringify({
      ok: true,
      bridgeStatus,
      cardState,
      pushStatus,
      selectionMenuItems,
      menuItems,
      companyButtonScreenshot,
      cardScreenshot,
      pathScreenshot,
      isolatedDataDir: dataDir,
      cdpPort: port,
      hubLogTail: hub.log().slice(-20),
    }, null, 2));
  } finally {
    if (cdp) await cdp.close();
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(dataDir);
    const tempRoot = path.resolve(os.tmpdir()) + path.sep;
    if (resolved.toLowerCase().startsWith(tempRoot.toLowerCase())
        && path.basename(resolved).startsWith('claude-session-hub-chatgpt-bridge-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
