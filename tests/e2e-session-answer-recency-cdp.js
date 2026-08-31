'use strict';

// Latest-activity recency E2E: ordinary sessions and group chats must float as
// soon as a new prompt/run starts, while merely opening a card changes no time.
// The sidebar uses the newest real interaction timestamp, not raw PTY output.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const ROOT = path.join(os.tmpdir(), `hub-answer-recency-${Date.now()}-${process.pid}`);
const DATA = path.join(ROOT, 'hub-data');
const HOME = path.join(ROOT, 'home');
const ARTIFACT = path.join(__dirname, '..', 'output', 'playwright', 'session-answer-recency-e2e.png');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitFor(label, fn, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await _waitMs(200);
  }
  throw new Error(`timeout ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function removeTree() {
  const resolved = path.resolve(ROOT);
  const tmpRoot = path.resolve(os.tmpdir()) + path.sep;
  if (resolved.startsWith(tmpRoot) && path.basename(resolved).startsWith('hub-answer-recency-')) {
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
}

(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(path.dirname(ARTIFACT), { recursive: true });
  const port = await reservePort();
  const egressFixture = {
    foreign: { ok: true, ip: '38.246.239.122', countryCode: 'US', country: 'United States', city: 'Los Angeles', region: 'California', locationLabel: '美国·洛杉矶' },
    domestic: { ok: true, ip: '180.158.74.254', countryCode: 'CN', country: 'China', city: 'Shanghai', region: 'Shanghai', locationLabel: '中国·上海' },
  };
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA,
      port,
      label: 'answer-recency',
      extraEnv: {
        CLAUDE_HUB_E2E: '1',
        CLAUDE_HUB_HOME_DIR: HOME,
        CLAUDE_HUB_EGRESS_FIXTURE: JSON.stringify(egressFixture),
        DEEPSEEK_API_KEY: '',
      },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url));
    await waitFor('renderer test api', () => client.eval('!!window.__hubE2E'));

    await client.eval(`(() => {
      const now = Date.now();
      window.__hubE2E.clearSessions();
      for (const key of Object.keys(meetings)) delete meetings[key];
      window.__hubE2E.addFakeSessions([
        { id:'ordinary-new-answer', title:'普通·刚回答', status:'dormant', createdAt:now-60*3600000,
          lastMessageTime:now-50*3600000, lastCompletedAt:now-30*60000 },
        { id:'ordinary-old-answer', title:'普通·旧回答新提问', status:'dormant', createdAt:now-60*3600000,
          lastMessageTime:now-30*60000, lastCompletedAt:now-50*3600000 },
        { id:'ordinary-legacy', title:'普通·旧数据兼容', status:'dormant', createdAt:now-3*3600000,
          lastMessageTime:now-2*3600000, lastCompletedAt:null },
      ]);
      meetings['meeting-new-answer'] = {
        id:'meeting-new-answer', title:'群聊·刚回答', status:'dormant', groupChat:true,
        subSessions:[], participants:[], createdAt:now-60*3600000,
        lastMessageTime:now-40*3600000, lastCompletedAt:now-15*60000,
      };
      meetings['meeting-old-answer'] = {
        id:'meeting-old-answer', title:'群聊·旧回答新提问', status:'dormant', groupChat:true,
        subSessions:[], participants:[], createdAt:now-60*3600000,
        lastMessageTime:now-15*60000, lastCompletedAt:now-40*3600000,
      };
      renderSessionList();
      return true;
    })()`);

    const recent = await waitFor('recent activity ordering', async () => {
      const snapshot = await client.eval(`(() => ({
        rows: [...document.querySelectorAll('#session-list > .session-item')].map(row => ({
          title: (row.querySelector('.sl-title')?.textContent || '').replace(/^[💬🎯📌⚠\s]+/u, '').trim(),
          time: (row.querySelector('.sl-time')?.textContent || '').trim(),
        })),
        groups: window.__hubE2E.sidebarGroups(),
      }))()`);
      return snapshot.rows.length === 5 ? snapshot : null;
    });
    assert.deepStrictEqual(recent.rows.map(row => row.title), [
      '群聊·刚回答',
      '群聊·旧回答新提问',
      '普通·刚回答',
      '普通·旧回答新提问',
      '普通·旧数据兼容',
    ]);
    assert.ok(recent.rows.every(row => !/天前$/.test(row.time)), JSON.stringify(recent.rows));
    assert.deepStrictEqual(recent.groups, [], 'new prompts keep both ordinary and group sessions in recent');

    const sidebar = await client.eval(`(() => {
      const rect = document.getElementById('session-sidebar').getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: Math.min(rect.height, 520) };
    })()`);
    const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, clip: { ...sidebar, scale: 2 } });
    fs.writeFileSync(ARTIFACT, Buffer.from(shot.data, 'base64'));

    console.log(JSON.stringify({
      ok: true,
      recent,
      screenshot: ARTIFACT,
      isolatedHubPid: hub.pid,
      cdpPort: port,
    }, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    if (hub) console.error(hub.log().slice(-50).join('\n'));
    process.exitCode = 1;
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub);
    removeTree();
  }
})();
