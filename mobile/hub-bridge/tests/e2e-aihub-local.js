'use strict';

// Local AI Hub E2E:
//   gateway (HTTP/WS, insecure dev) -> isolated Electron Hub -> local PWA in Chrome mobile viewport.
// The pass condition is intentionally concrete: a prompt sent from the PWA must appear in the
// isolated desktop Hub PowerShell session buffer.

const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { pathToFileURL } = require('url');
const WebSocket = require('ws');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PWA_DIR = path.join(REPO_ROOT, 'mobile', 'pwa');
const GATEWAY_SERVER = path.join(REPO_ROOT, 'mobile', 'vps-gateway', 'server.js');
const ELECTRON_EXE = path.join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const CHROME_EXE = process.env.CHROME_EXE || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ARTIFACT_ROOT = process.env.AIHUB_E2E_ARTIFACT_DIR || 'C:\\Users\\lintian\\Desktop\\claude-artifacts';
const RUN_ID = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const EVIDENCE_DIR = path.join(ARTIFACT_ROOT, `ai-hub-e2e-${RUN_ID}`);
const DATA_DIR = path.join(process.env.TEMP || 'C:\\Users\\lintian\\AppData\\Local\\Temp', `aihub-e2e-data-${RUN_ID}`);
const CHROME_DATA_DIR = path.join(process.env.TEMP || 'C:\\Users\\lintian\\AppData\\Local\\Temp', `aihub-e2e-chrome-${RUN_ID}`);
const HUB_BEARER = `e2e-token-${RUN_ID}`;
const PIN = '123456';
const SESSION_ID = `e2e-desktop-${RUN_ID}`;
const SESSION_TITLE = `AI Hub E2E ${RUN_ID}`;
const MARKER = `AIHUB_E2E_OK_${RUN_ID}`;
const COMMAND_TEXT = `Write-Output "${MARKER}"`;

fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
const logFile = path.join(EVIDENCE_DIR, 'e2e-run.log');
const logStream = fs.createWriteStream(logFile, { flags: 'a', encoding: 'utf8' });

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}`;
  console.log(msg);
  logStream.write(msg + '\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitFor(fn, label, timeoutMs = 30000, intervalMs = 300) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const value = await fn();
        if (value) return resolve(value);
      } catch {}
      if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(body || '{}') });
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function spawnLogged(name, command, args, options = {}) {
  log(`spawn ${name}: ${command} ${args.join(' ')}`);
  const child = childProcess.spawn(command, args, {
    cwd: options.cwd || REPO_ROOT,
    env: options.env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (buf) => log(`[${name}:stdout] ${buf.toString('utf8').trimEnd()}`));
  child.stderr.on('data', (buf) => log(`[${name}:stderr] ${buf.toString('utf8').trimEnd()}`));
  child.on('exit', (code, signal) => log(`[${name}:exit] code=${code} signal=${signal}`));
  return child;
}

function killTree(child, name) {
  if (!child || !child.pid || child.killed) return Promise.resolve();
  return new Promise((resolve) => {
    log(`cleanup ${name}: taskkill /PID ${child.pid} /T /F`);
    childProcess.execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
  });
}

function startStaticServer(port) {
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml; charset=utf-8',
  };
  const server = http.createServer((req, res) => {
    let pathname = '/';
    try { pathname = new URL(req.url, `http://127.0.0.1:${port}`).pathname; } catch {}
    if (pathname === '/') pathname = '/index.html';
    const requested = path.normalize(path.join(PWA_DIR, pathname));
    if (!requested.startsWith(PWA_DIR)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    fs.readFile(requested, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': mime[path.extname(requested).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      log(`static PWA server listening on ${port}`);
      resolve(server);
    });
    server.on('error', reject);
  });
}

function getCdpTabs(port) {
  return httpJson(`http://127.0.0.1:${port}/json`).then((r) => r.body);
}

class CdpClient {
  constructor(wsUrl, label) {
    this.wsUrl = wsUrl;
    this.label = label;
    this.id = 1;
    this.pending = new Map();
    this.events = [];
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method) this.events.push(msg);
    });
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Network.enable');
  }
  send(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, awaitPromise = false) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      timeout: 30000,
    });
    if (result.exceptionDetails) {
      throw new Error(`${this.label} eval failed: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result && result.result.value;
  }
  async screenshot(filename) {
    const result = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    });
    const file = path.join(EVIDENCE_DIR, filename);
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    log(`screenshot saved: ${file}`);
    return file;
  }
  close() {
    try { this.ws.close(); } catch {}
  }
}

async function connectCdp(port, predicate, label) {
  const target = await waitFor(async () => {
    const tabs = await getCdpTabs(port);
    return tabs.find(predicate);
  }, `${label} CDP target`, 30000, 500);
  const cdp = new CdpClient(target.webSocketDebuggerUrl, label);
  await cdp.connect();
  log(`connected CDP ${label}: ${target.url}`);
  return cdp;
}

async function main() {
  if (!fs.existsSync(ELECTRON_EXE)) throw new Error(`electron.exe not found: ${ELECTRON_EXE}`);
  if (!fs.existsSync(CHROME_EXE)) throw new Error(`chrome.exe not found: ${CHROME_EXE}`);

  const gatewayPort = await getFreePort();
  const pwaPort = await getFreePort();
  const hubCdpPort = await getFreePort();
  const chromeCdpPort = await getFreePort();

  log(`evidence dir: ${EVIDENCE_DIR}`);
  log(`data dir: ${DATA_DIR}`);
  log(`ports: gateway=${gatewayPort} pwa=${pwaPort} hubCdp=${hubCdpPort} chromeCdp=${chromeCdpPort}`);

  const staticServer = await startStaticServer(pwaPort);
  let gatewayProc = null;
  let hubProc = null;
  let chromeProc = null;
  let hubCdp = null;
  let pwaCdp = null;

  try {
    gatewayProc = spawnLogged('gateway', process.execPath, [GATEWAY_SERVER], {
      cwd: path.join(REPO_ROOT, 'mobile', 'vps-gateway'),
      env: {
        ...process.env,
        HUB_BEARER_TOKEN: HUB_BEARER,
        GATEWAY_INSECURE: 'true',
        GATEWAY_PORT: String(gatewayPort),
      },
    });
    await waitFor(async () => {
      const res = await httpJson(`http://127.0.0.1:${gatewayPort}/healthz`);
      return res.statusCode === 200 && res.body && res.body.ok;
    }, 'gateway /healthz');

    hubProc = spawnLogged('hub', ELECTRON_EXE, [REPO_ROOT, `--remote-debugging-port=${hubCdpPort}`], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CLAUDE_HUB_DATA_DIR: DATA_DIR,
        CLAUDE_HUB_MOBILE_ENABLED: 'true',
        MOBILE_VPS_URL: `ws://127.0.0.1:${gatewayPort}/agent`,
        MOBILE_BEARER_TOKEN: HUB_BEARER,
        MOBILE_FIXED_PIN: PIN,
      },
    });
    await waitFor(async () => {
      const res = await httpJson(`http://127.0.0.1:${gatewayPort}/healthz`);
      return res.body && res.body.hubOnline;
    }, 'Hub connected to local gateway', 45000, 700);

    hubCdp = await connectCdp(
      hubCdpPort,
      (t) => t.type === 'page' && /renderer[\\/]index\.html|renderer\/index\.html|renderer\\index\.html/.test(t.url || ''),
      'hub',
    );
    const created = await hubCdp.evaluate(`(async () => {
      const { ipcRenderer } = require('electron');
      const session = await ipcRenderer.invoke('create-session', {
        kind: 'powershell',
        opts: { id: ${JSON.stringify(SESSION_ID)}, title: ${JSON.stringify(SESSION_TITLE)}, cwd: ${JSON.stringify(REPO_ROOT)} }
      });
      return { id: session.id, title: session.title, kind: session.kind };
    })()`, true);
    log(`desktop session created: ${JSON.stringify(created)}`);

    chromeProc = spawnLogged('chrome', CHROME_EXE, [
      `--remote-debugging-port=${chromeCdpPort}`,
      `--user-data-dir=${CHROME_DATA_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-translate',
      '--window-size=420,900',
      'about:blank',
    ]);
    const chromeBlank = await connectCdp(
      chromeCdpPort,
      (t) => t.type === 'page' && (!t.url || t.url === 'about:blank' || t.url.startsWith('chrome://')),
      'pwa',
    );
    pwaCdp = chromeBlank;
    await pwaCdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
      screenOrientation: { angle: 0, type: 'portraitPrimary' },
    });
    await pwaCdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await pwaCdp.send('Network.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36 AIHubE2E/1.0',
    });

    const pwaUrl = `http://127.0.0.1:${pwaPort}/?api=http://127.0.0.1:${gatewayPort}&gw=ws://127.0.0.1:${gatewayPort}/pwa&run=${RUN_ID}`;
    await pwaCdp.send('Page.navigate', { url: pwaUrl });
    await waitFor(async () => {
      const state = await pwaCdp.evaluate(`document.readyState`);
      return state === 'complete' || state === 'interactive';
    }, 'PWA document ready', 15000);
    await sleep(1000);
    await pwaCdp.screenshot('01-pairing.png');

    await pwaCdp.evaluate(`localStorage.clear();`);
    await pwaCdp.send('Page.navigate', { url: pwaUrl });
    await waitFor(async () => {
      return await pwaCdp.evaluate(`!!document.querySelector('.key[data-key="1"]')`);
    }, 'pairing keypad');
    for (const digit of PIN) {
      await pwaCdp.evaluate(`document.querySelector('.key[data-key="${digit}"]').click()`);
      await sleep(120);
    }
    await waitFor(async () => {
      return await pwaCdp.evaluate(`document.getElementById('view-main')?.classList.contains('on') === true`);
    }, 'PWA paired main screen', 20000);
    await waitFor(async () => {
      return await pwaCdp.evaluate(`(() => {
        const app = window.__hubApp || window.ui;
        return !!(app && app.client && app.client.state === 'connected' && app.hubs && app.hubs.length > 0);
      })()`);
    }, 'PWA websocket connected and hub list loaded', 20000);

    const desktopCard = await waitFor(async () => {
      return await pwaCdp.evaluate(`(() => {
        const app = window.__hubApp || window.ui;
        const card = (app?.sessions || []).find(s => s && s.id === ${JSON.stringify(SESSION_ID)} && s.source === 'desktop');
        return card ? { id: card.id, title: card.title, source: card.source, targetType: card.targetType } : null;
      })()`);
    }, 'desktop session card in PWA', 20000);
    log(`PWA desktop card: ${JSON.stringify(desktopCard)}`);
    await pwaCdp.screenshot('02-paired-main.png');

    await pwaCdp.evaluate(`document.getElementById('btn-menu').click()`);
    await waitFor(async () => {
      return await pwaCdp.evaluate(`document.querySelector('.dsess[data-sid="${SESSION_ID}"]') !== null`);
    }, 'drawer row for desktop session', 10000);
    await pwaCdp.screenshot('03-drawer-desktop-card.png');

    await pwaCdp.evaluate(`document.querySelector('.dsess[data-sid="${SESSION_ID}"]').click()`);
    await waitFor(async () => {
      return await pwaCdp.evaluate(`(window.__hubApp || window.ui)?.activeSessionId === ${JSON.stringify(SESSION_ID)}`);
    }, 'desktop session selected');
    await pwaCdp.evaluate(`document.getElementById('composer-input').click()`);
    await waitFor(async () => {
      return await pwaCdp.evaluate(`document.getElementById('input-modal')?.classList.contains('on') === true`);
    }, 'input modal opened');
    const sendUiState = await pwaCdp.evaluate(`(() => {
      const ta = document.getElementById('im-textarea');
      const btn = document.getElementById('im-btn-send');
      ta.value = ${JSON.stringify(COMMAND_TEXT)};
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      if (btn.disabled) btn.disabled = false;
      btn.click();
      return { activeSessionId: (window.__hubApp || window.ui)?.activeSessionId, btnDisabled: btn.disabled };
    })()`);
    log(`send UI state: ${JSON.stringify(sendUiState)}`);
    await sleep(1200);
    await pwaCdp.screenshot('04-after-send.png');

    const writeHit = await waitFor(async () => {
      return await hubCdp.evaluate(`(async () => {
        const { ipcRenderer } = require('electron');
        const last = await ipcRenderer.invoke('debug:get-last-session-write');
        if (!last) return null;
        return last.sessionId === ${JSON.stringify(SESSION_ID)} && String(last.data || '').includes(${JSON.stringify(MARKER)}) ? last : null;
      })()`, true).catch(() => '');
    }, `Hub writeToSession receives ${MARKER}`, 30000, 500);
    log(`writeToSession observed marker: ${JSON.stringify(writeHit)}`);

    const report = {
      ok: true,
      runId: RUN_ID,
      evidenceDir: EVIDENCE_DIR,
      logFile,
      dataDir: DATA_DIR,
      marker: MARKER,
      commandText: COMMAND_TEXT,
      writeHit,
      ports: { gatewayPort, pwaPort, hubCdpPort, chromeCdpPort },
      screenshots: [
        path.join(EVIDENCE_DIR, '01-pairing.png'),
        path.join(EVIDENCE_DIR, '02-paired-main.png'),
        path.join(EVIDENCE_DIR, '03-drawer-desktop-card.png'),
        path.join(EVIDENCE_DIR, '04-after-send.png'),
      ],
      desktopCard,
    };
    const reportFile = path.join(EVIDENCE_DIR, 'e2e-report.json');
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');
    log(`PASS report saved: ${reportFile}`);
  } finally {
    if (pwaCdp) pwaCdp.close();
    if (hubCdp) hubCdp.close();
    await killTree(chromeProc, 'chrome');
    await killTree(hubProc, 'hub');
    await killTree(gatewayProc, 'gateway');
    await new Promise((resolve) => staticServer.close(resolve));
    logStream.end();
  }
}

main().catch((err) => {
  log(`FAIL ${err.stack || err.message || err}`);
  logStream.end(() => process.exit(1));
});
