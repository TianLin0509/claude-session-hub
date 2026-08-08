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
const TEMP_ROOT = path.join(os.tmpdir(), `hub-groupchat-running-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'groupchat-running-indicator');
const SCREENSHOT = path.join(ARTIFACT_DIR, `claude-running-${RUN_ID}.png`);

function canListen(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function availablePort(preferred) {
  for (let port = preferred; port < preferred + 50; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error('no free CDP port');
}

async function waitFor(client, expression, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await client.eval(`Boolean(${expression})`)) return; } catch {}
    await _waitMs(150);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const port = await availablePort(Number(process.env.HUB_GC_RUNNING_E2E_PORT || 19710));
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'groupchat-running-indicator',
      extraEnv: { CLAUDE_HUB_E2E: '1' },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''));
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 920, deviceScaleFactor: 1, mobile: false,
    });
    await waitFor(client, 'window.__hubE2E', 'Hub E2E API');

    const result = await client.eval(`(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const api = window.__hubE2E;
      const ipc = require('electron').ipcRenderer;
      const now = Date.now();
      const meetingId = 'gc-running-meeting';
      const sids = ['gc-running-claude', 'gc-running-codex', 'gc-running-kimi'];
      api.addFakeSessions(sids.map((id, index) => ({
        id,
        kind: ['claude', 'codex', 'kimi'][index],
        title: ['Claude 1', 'Codex 2', 'Kimi 3'][index],
        status: 'idle',
        meetingId,
        createdAt: now + index,
        lastMessageTime: now + index,
      })));
      meetings[meetingId] = {
        id: meetingId,
        title: '群聊运行灯 E2E',
        scene: 'general',
        groupChat: true,
        status: 'idle',
        subSessions: sids,
        participants: [0, 1, 2],
        createdAt: now,
        updatedAt: now,
        lastMessageTime: now,
      };
      renderSessionList();

      function snapshot() {
        const item = document.querySelector('[data-meeting-id="' + meetingId + '"]');
        const claude = item && item.querySelector('[data-sub-id="' + sids[0] + '"] .mini-jump-status-dot');
        const codex = item && item.querySelector('[data-sub-id="' + sids[1] + '"] .mini-jump-status-dot');
        const kimi = item && item.querySelector('[data-sub-id="' + sids[2] + '"] .mini-jump-status-dot');
        const ring = item && item.querySelector('.sl-ring-dot');
        const state = item && item.querySelector('.sl-state');
        return {
          exists: !!item,
          stateText: state ? state.textContent.trim() : '',
          stateClass: state ? state.className : '',
          ringClass: ring ? ring.getAttribute('class') : '',
          ringAnimation: ring ? getComputedStyle(ring).animationName : '',
          claudeClass: claude ? claude.className : '',
          claudeAnimation: claude ? getComputedStyle(claude).animationName : '',
          codexClass: codex ? codex.className : '',
          kimiClass: kimi ? kimi.className : '',
        };
      }

      await wait(180);
      const initial = snapshot();

      // prompt 已真正发给 Claude，但其 PTY/hook 仍处于 idle：这就是生产截图的复现条件。
      ipc.emit('groupchat-turn-targets', {}, { meetingId, turnNum: 1, sids: [sids[0]] });
      await wait(220);
      const targeted = snapshot();

      // watcher 心跳续期时仍保持运行；随后终态应立即熄灯。
      ipc.emit('groupchat-partial-update', {}, {
        meetingId, turnNum: 1, sid: sids[0], status: 'streaming', text: '正在发言',
      });
      await wait(220);
      const heartbeat = snapshot();

      ipc.emit('groupchat-turn-complete', {}, { meetingId, turnNum: 1, results: [] });
      await wait(220);
      const completed = snapshot();

      // 漏掉 complete 时也不能永久黄灯；8 秒无 1.5 秒心跳后自动回收。
      ipc.emit('groupchat-turn-targets', {}, { meetingId, turnNum: 2, sids: [sids[0]] });
      await wait(220);
      const beforeExpiry = snapshot();
      const expiryDeadline = Date.now() + 12000;
      while (Date.now() < expiryDeadline && snapshot().stateText === '运行中') {
        await wait(150);
      }
      const expired = snapshot();

      // 留一张用户可见的运行态截图作为 GUI 证据。
      ipc.emit('groupchat-turn-targets', {}, { meetingId, turnNum: 3, sids: [sids[0]] });
      await wait(220);
      return { initial, targeted, heartbeat, completed, beforeExpiry, expired, final: snapshot() };
    })()`);

    console.log(JSON.stringify({ diagnostic: result }, null, 2));
    assert.equal(result.initial.stateText, '', JSON.stringify(result.initial));
    for (const state of [result.targeted, result.heartbeat, result.beforeExpiry, result.final]) {
      assert.equal(state.stateText, '运行中', JSON.stringify(state));
      assert.match(state.stateClass, /\brun\b/);
      assert.match(state.ringClass, /\brun\b/);
      assert.match(state.ringAnimation, /sl-pulse/);
      assert.match(state.claudeClass, /mini-st-thinking/);
      assert.match(state.claudeAnimation, /mini-st-pulse/);
      assert.match(state.codexClass, /mini-st-ready/);
      assert.match(state.kimiClass, /mini-st-ready/);
    }
    assert.equal(result.completed.stateText, '', JSON.stringify(result.completed));
    assert.doesNotMatch(result.completed.claudeClass, /mini-st-thinking/);
    assert.equal(result.expired.stateText, '', JSON.stringify(result.expired));
    assert.doesNotMatch(result.expired.claudeClass, /mini-st-thinking/);

    const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(SCREENSHOT, Buffer.from(shot.data, 'base64'));
    console.log(JSON.stringify({ ok: true, port, result, screenshot: SCREENSHOT }, null, 2));
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub).catch(() => {});
    const resolved = path.resolve(TEMP_ROOT);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
        && path.basename(resolved).startsWith('hub-groupchat-running-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

main().catch(error => {
  console.error(error && (error.stack || error.message));
  process.exit(1);
});
