'use strict';

// 通过 CDP attach Hub renderer，调 IPC 'restart-session' 重新 spawn
// mobile-default 的 PTY + Claude CLI。不需要重启 Hub。
//
// Hub PID 69564 的 CDP 端口在 control 文件里：cdpPort

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const HUB_DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR
  || path.join(require('os').homedir(), '.claude-session-hub');
const SESSION_ID = process.argv[2] || 'mobile-default';

function getCdpTabs(port) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function loadHubControl() {
  const dir = path.join(HUB_DATA_DIR, 'control');
  if (!fs.existsSync(dir)) throw new Error(`No control dir: ${dir}`);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const entries = files.map(f => {
    const p = path.join(dir, f);
    try { return { file: f, ...JSON.parse(fs.readFileSync(p, 'utf8')) }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return entries;
}

function cdpClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    ws.on('open', () => {
      const send = (method, params = {}) => new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
      });
      resolve({ send, close: () => ws.close() });
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
    ws.on('error', reject);
  });
}

async function evaluate(cdp, expression, opts = {}) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: !!opts.awaitPromise,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error('Eval exception: ' + JSON.stringify(r.exceptionDetails));
  }
  return r.result.value;
}

async function main() {
  const entries = loadHubControl();
  console.log(`[restart] found ${entries.length} hub-control entries`);
  for (const e of entries) {
    console.log(`  pid=${e.pid} cdpPort=${e.cdpPort} hookPort=${e.hookPort} startedAt=${new Date(e.startedAt).toISOString()}`);
  }
  const target = entries.find(e => e.cdpPort);
  if (!target) throw new Error('No hub with cdpPort found');
  console.log(`[restart] targeting hub pid=${target.pid} cdpPort=${target.cdpPort}`);

  const tabs = await getCdpTabs(target.cdpPort);
  console.log(`[restart] tabs found: ${tabs.length}`);
  for (const t of tabs) console.log(`  - ${t.type} :: ${t.title} :: ${t.url}`);
  const tab = tabs.find(t => t.type === 'page' && (t.url.includes('index.html') || t.url.includes('renderer')));
  if (!tab) throw new Error('No renderer page tab found');
  console.log(`[restart] using tab: ${tab.url}`);

  const cdp = await cdpClient(tab.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  // 探测 IPC 接口
  const probe = await evaluate(cdp, `
    (() => {
      const out = {};
      for (const k of Object.keys(window)) {
        const v = window[k];
        if (typeof v === 'object' && v && (v.invoke || v.ipcRenderer || v.send)) {
          out[k] = { type: 'object', methods: Object.keys(v).filter(m => typeof v[m] === 'function') };
        }
      }
      return out;
    })()
  `);
  console.log('[restart] IPC probe:', JSON.stringify(probe, null, 2));

  // Hub renderer nodeIntegration=true → 直接 require('electron')
  const result = await evaluate(cdp, `
    (async () => {
      try {
        const { ipcRenderer } = require('electron');
        const r = await ipcRenderer.invoke('restart-session', '${SESSION_ID}');
        return { via: 'require(electron).ipcRenderer', ok: true, result: r };
      } catch (e) {
        return { ok: false, error: String(e.message || e), stack: String(e.stack) };
      }
    })()
  `, { awaitPromise: true });

  console.log('[restart] restart-session result:', JSON.stringify(result, null, 2));
  cdp.close();
  process.exit(result && result.ok ? 0 : 1);
}

main().catch(e => { console.error('[restart] FATAL:', e.message); process.exit(2); });
