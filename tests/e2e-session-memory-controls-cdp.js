'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const ROOT = path.resolve(__dirname, '..');

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

async function waitFor(client, expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await client.eval(`Boolean(${expression})`)) return;
    } catch {}
    await _waitMs(120);
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

async function main() {
  const runId = `${Date.now()}-${process.pid}`;
  const tempRoot = path.join(os.tmpdir(), `hub-session-memory-${runId}`);
  const dataDir = path.join(tempRoot, 'hub-data');
  const artifactDir = path.join(ROOT, 'output', 'playwright', 'session-memory');
  const screenshotPath = path.join(artifactDir, `memory-controls-${runId}.png`);
  const port = await reservePort();
  fs.mkdirSync(artifactDir, { recursive: true });

  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir,
      port,
      label: 'session-memory-controls',
      extraEnv: { CLAUDE_HUB_E2E: '1' },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /index\.html/i.test(target.url || ''));
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1365, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await waitFor(client, "window.__hubE2E && window.WorkspaceController && document.querySelector('#btn-new')");
    await client.eval(`(() => {
      window.__memoryE2eErrors = [];
      window.addEventListener('error', event => window.__memoryE2eErrors.push(String(event.error || event.message)));
      window.addEventListener('unhandledrejection', event => window.__memoryE2eErrors.push(String(event.reason)));
      document.querySelector('#btn-new').click();
      document.querySelector('.new-session-option[data-kind="codex"]').click();
      const select = document.querySelector('#new-session-mcp');
      select.value = 'browser';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await _waitMs(150);

    const controls = await client.eval(`(() => ({
      mcpVisible: !document.querySelector('#new-session-mcp-field').hidden,
      mcpValue: document.querySelector('#new-session-mcp').value,
      mcpChoices: Array.from(document.querySelector('#new-session-mcp').options).map(option => option.value),
      summary: document.querySelector('#new-session-summary').textContent,
      hasBulkSuspend: !!document.querySelector('#options-suspend-idle'),
      hasDuplicateSuspendAction: !!document.querySelector('#context-menu [data-action="suspend"]'),
      closeLabel: document.querySelector('#context-menu [data-action="close"]')?.textContent.trim() || '',
      deleteLabel: document.querySelector('#context-menu [data-action="delete"]')?.textContent.trim() || '',
    }))()`);
    assert.strictEqual(controls.mcpVisible, true);
    assert.strictEqual(controls.mcpValue, 'browser');
    assert.deepStrictEqual(controls.mcpChoices, ['lean', 'browser', 'wireless', 'full']);
    assert.match(controls.summary, /Browser MCP/);
    assert.strictEqual(controls.hasBulkSuspend, true);
    assert.strictEqual(controls.hasDuplicateSuspendAction, false);
    assert.strictEqual(controls.closeLabel, '关闭并休眠');
    assert.strictEqual(controls.deleteLabel, '永久删除记录');

    const screenshot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));

    const suspended = await client.eval(`(async () => {
      document.querySelector('#new-session-cancel').click();
      const api = window.__hubE2E;
      const now = Date.now();
      api.addFakeSession({
        id: 'memory-live', kind: 'codex', codexSid: 'memory-native', title: 'Memory live',
        status: 'running', _agentWorking: true, gcWorking: true,
        createdAt: now, lastMessageTime: now,
      });
      const electronIpc = require('electron').ipcRenderer;
      const originalInvoke = electronIpc.invoke;
      const closeCalls = [];
      electronIpc.invoke = function(channel, ...args) {
        if (channel === 'close-session') {
          closeCalls.push([channel, ...args]);
          return Promise.resolve({ ok: true, action: 'suspended' });
        }
        return originalInvoke.call(this, channel, ...args);
      };
      const sidebarItem = document.querySelector('[data-session-id="memory-live"]');
      sidebarItem.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 100, clientY: 100,
      }));
      document.querySelector('#context-menu [data-action="close"]').click();
      await new Promise(resolve => setTimeout(resolve, 30));
      electronIpc.invoke = originalInvoke;
      await api.selectSession('memory-live');
      await new Promise(resolve => setTimeout(resolve, 80));
      sessions.get('memory-live').unreadCount = 4;
      sessions.get('memory-live').lastOutputPreview = '后台任务已经完成';
      require('electron').ipcRenderer.emit('session-suspended', {}, {
        sessionId: 'memory-live',
        session: {
          id: 'memory-live', kind: 'codex', codexSid: 'memory-native', title: 'Memory live',
          status: 'dormant', suspendedAt: Date.now(), suspendReason: 'idle-timeout',
        },
      });
      await new Promise(resolve => setTimeout(resolve, 80));
      const item = document.querySelector('[data-session-id="memory-live"]');
      return {
        exists: sessions.has('memory-live'),
        status: sessions.get('memory-live')?.status,
        suspendReason: sessions.get('memory-live')?.suspendReason,
        unreadCount: sessions.get('memory-live')?.unreadCount,
        unreadBadge: item?.querySelector('.sl-un')?.textContent.trim() || '',
        tooltip: item?.querySelector('.sl-title')?.title || '',
        hasUnreadClass: !!item?.classList.contains('need-unread'),
        closeCalls,
        cacheSize: api.terminalCacheStats().size,
        emptyVisible: getComputedStyle(document.querySelector('#empty-state')).display !== 'none',
        errors: window.__memoryE2eErrors,
      };
    })()`);
    assert.deepStrictEqual(suspended, {
      exists: true,
      status: 'dormant',
      suspendReason: 'idle-timeout',
      unreadCount: 4,
      unreadBadge: '● 4',
      tooltip: 'Memory live · 自动休眠，有 4 条未读，点击唤醒',
      hasUnreadClass: true,
      closeCalls: [['close-session', 'memory-live']],
      cacheSize: 0,
      emptyVisible: true,
      errors: [],
    });

    const resumedUnread = await client.eval(`(async () => {
      const now = Date.now();
      meetings['memory-room'] = {
        id: 'memory-room', title: 'Memory room', groupChat: true,
        subSessions: ['memory-live'], lastMessageTime: now, createdAt: now,
      };
      sessions.get('memory-live').meetingId = 'memory-room';
      require('electron').ipcRenderer.emit('session-created', {}, {
        session: {
          id: 'memory-live', kind: 'codex', codexSid: 'memory-native',
          title: 'Memory live', meetingId: 'memory-room', status: 'idle',
          lastMessageTime: now, unreadCount: 0,
        },
      });
      await new Promise(resolve => setTimeout(resolve, 80));
      const afterWake = {
        status: sessions.get('memory-live')?.status,
        unreadCount: sessions.get('memory-live')?.unreadCount,
        suspendReason: sessions.get('memory-live')?.suspendReason,
      };
      await window.__hubE2E.selectSession('memory-live');
      await new Promise(resolve => setTimeout(resolve, 80));
      return {
        afterWake,
        afterEnterUnread: sessions.get('memory-live')?.unreadCount,
        errors: window.__memoryE2eErrors,
      };
    })()`);
    assert.deepStrictEqual(resumedUnread, {
      afterWake: { status: 'idle', unreadCount: 4, suspendReason: null },
      afterEnterUnread: 0,
      errors: [],
    });

    console.log(JSON.stringify({ ok: true, port, screenshotPath, controls, suspended, resumedUnread }, null, 2));
  } finally {
    if (client) { try { client.close(); } catch {} }
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(tempRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
        && path.basename(resolved).startsWith('hub-session-memory-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
