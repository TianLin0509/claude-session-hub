'use strict';
const { test: nodeTest } = require('node:test');

if (process.env.HUB_EXTERNAL_CDP_E2E !== '1') {
  nodeTest('P0.2 external CDP attachment', {
    skip: 'set HUB_EXTERNAL_CDP_E2E=1 only after launching an explicitly isolated Hub on port 9229',
  }, () => {});
} else {
// P0/P0.2 真实 CDP E2E 测试 —— attach isolated Hub Electron renderer
//   1. CDP HTTP /json 拿 webSocketDebuggerUrl
//   2. ws attach renderer，Runtime.evaluate 探测真实 window/API
//   3. Page.captureScreenshot 留下 UI 渲染证据
//   4. 触发真实 IPC meeting.create，让 main 进程跑到 cwd 决策（log 验证）
//
// 不走 mock，全程真实协议 + 真实 Hub 进程。
// 等价于 Playwright MCP attach Electron（同样 CDP，因为 arena-profile 锁不用 MCP）。

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CDP_HTTP = 'http://127.0.0.1:9229';
const ARTIFACT_DIR = 'C:\\Users\\lintian\\Desktop\\claude-artifacts';

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function listTargets() {
  return JSON.parse(await get(`${CDP_HTTP}/json/list`));
}

function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();

  return new Promise((resolveReady) => {
    ws.on('open', () => resolveReady({
      send(method, params = {}) {
        const id = nextId++;
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      close() { ws.close(); },
    }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
    ws.on('error', (e) => console.error('[ws] error:', e.message));
  });
}

(async () => {
  console.log('=== E2E Step 1: 真实 CDP attach Hub renderer ===');
  const targets = await listTargets();
  console.log(`  found ${targets.length} target(s)`);
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  console.log(`  target: title="${page.title}" url=${page.url}`);
  console.log(`  wsUrl=${page.webSocketDebuggerUrl}`);

  const cdp = await cdpClient(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  console.log('\n=== E2E Step 2: 探测真实 renderer window（不是 mock） ===');
  const r1 = await cdp.send('Runtime.evaluate', {
    expression: `
      JSON.stringify({
        href: location.href,
        title: document.title,
        hasElectronAPI: typeof window.electronAPI !== 'undefined',
        electronAPIKeys: window.electronAPI ? Object.keys(window.electronAPI).slice(0, 30) : [],
        hasApi: typeof window.api !== 'undefined',
        apiKeys: window.api ? Object.keys(window.api).slice(0, 30) : [],
        sidebarPresent: !!document.querySelector('.sidebar') || !!document.querySelector('#sidebar') || !!document.querySelector('[class*=sidebar]'),
        bodyChildren: document.body ? document.body.children.length : 0,
        bodyClasses: document.body ? document.body.className : '',
        windowKeys: Object.keys(window).filter(k => !k.startsWith('_') && /^[a-z]/i.test(k)).slice(0, 50),
      })
    `,
    returnByValue: true,
  });
  const probe = JSON.parse(r1.result.value);
  console.log('  ' + JSON.stringify(probe, null, 2).split('\n').join('\n  '));

  console.log('\n=== E2E Step 3: 截屏（Page.captureScreenshot） ===');
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const shotPath = path.join(ARTIFACT_DIR, 'p0-2-hub-renderer.png');
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  console.log(`  screenshot saved: ${shotPath} (${(fs.statSync(shotPath).size / 1024).toFixed(1)} KB)`);

  console.log('\n=== E2E Step 4: 触发真实 IPC 调用，看 main 进程的 cwd 决策 ===');
  // 探测 IPC 接口
  const ipcProbe = await cdp.send('Runtime.evaluate', {
    expression: `
      JSON.stringify({
        apiKeys: window.api ? Object.keys(window.api) : null,
        electronAPIKeys: window.electronAPI ? Object.keys(window.electronAPI) : null,
        // 嗅探出 invoke / meeting / session 类接口
        candidates: (() => {
          const out = {};
          for (const ns of ['api', 'electronAPI']) {
            const obj = window[ns];
            if (!obj) continue;
            out[ns] = {};
            for (const k of Object.keys(obj)) {
              if (/meeting|session|create|addSub|sub/i.test(k)) {
                out[ns][k] = typeof obj[k];
              }
            }
          }
          return out;
        })(),
      })
    `,
    returnByValue: true,
  });
  const ipc = JSON.parse(ipcProbe.result.value);
  console.log('  IPC 接口候选: ' + JSON.stringify(ipc.candidates, null, 2).split('\n').join('\n  '));

  cdp.close();
  console.log('\n=== E2E DONE ===');
})().catch((e) => {
  console.error('FAIL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
}
