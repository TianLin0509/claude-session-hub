'use strict';

// 真实模拟用户操作：启动 Chrome with mobile emulation + CDP attach
// 自动化流程：
//   1. navigate https://lthub.xyz:8443/
//   2. 进入配对屏，点 PIN 键盘输入 063551
//   3. 等配对成功 + 进入主屏
//   4. 输入消息 + 点击发送按钮
//   5. 等待 Claude 回复出现在卡片流
//   6. 全程截图存证
//
// 使用 user 现有 chrome.exe (C:\Program Files\Google\Chrome\Application\chrome.exe)
// 隔离 user-data-dir，不影响用户日常 Chrome

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USER_DATA = `C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-e2e-${Date.now()}`;
// 9333 / 9222 / 9229 等常用端口可能被现有 electron / vscode debug 占用，
// 用不常见的高端口避免冲突
const DEBUG_PORT = 28734;
const PWA_URL = 'https://lthub.xyz:8443/';
const PIN = '063551';
const TEST_MESSAGE = '请用一句话告诉我立花道雪是谁';

const EVIDENCE_DIR = 'C:\\Users\\lintian\\Desktop\\claude-artifacts\\hub-mobile-e2e';
if (!fs.existsSync(EVIDENCE_DIR)) fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

function log(...args) { console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...args); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getCdpTabs(port, retries = 20) {
  for (let i = 0; i < retries; i++) {
    try {
      return await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/json`, (res) => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
        }).on('error', reject);
      });
    } catch { await sleep(500); }
  }
  throw new Error('CDP not responding');
}

class CdpClient {
  constructor(wsUrl) { this.wsUrl = wsUrl; this._id = 1; this._pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); });
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && this._pending.has(msg.id)) {
        const { resolve, reject } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = this._id++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error('Eval exception: ' + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  async screenshot(filename, fullPage = false) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage });
    const filepath = path.join(EVIDENCE_DIR, filename);
    fs.writeFileSync(filepath, Buffer.from(r.data, 'base64'));
    log(`screenshot saved: ${filepath}`);
    return filepath;
  }
}

async function main() {
  log(`evidence dir: ${EVIDENCE_DIR}`);
  // 先检查 DEBUG_PORT 是否已被占用 — 防止误 attach
  const portInUse = await new Promise((res) => {
    const sock = require('net').createConnection({ host: '127.0.0.1', port: DEBUG_PORT, timeout: 500 });
    sock.once('connect', () => { sock.destroy(); res(true); });
    sock.once('error', () => res(false));
    sock.once('timeout', () => { sock.destroy(); res(false); });
  });
  if (portInUse) throw new Error(`PORT ${DEBUG_PORT} already in use — REFUSING to spawn (would attach to wrong process)`);

  log(`spawning chrome (user-data-dir=${USER_DATA})`);
  const chromeProc = spawn(CHROME_EXE, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${USER_DATA}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-translate', '--disable-features=Translate',
    '--mute-audio',
    '--window-size=420,900',
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  chromeProc.unref();

  await sleep(3500);

  // 验证 attach 到的是我们启动的 chrome（不是任何 electron app）
  const tabs = await getCdpTabs(DEBUG_PORT);
  log(`tabs from port ${DEBUG_PORT}: ${tabs.length}`);
  for (const t of tabs) log(`  - ${t.type} :: ${t.url || '(no url)'}`);
  // 找一个 about:blank / new-tab 页面 — 我们新启 chrome 的初始 tab
  const tab = tabs.find(t => t.type === 'page' && (t.url === 'about:blank' || t.url.startsWith('chrome://') || t.url === ''));
  if (!tab) {
    // safety check: 如果没有 about:blank，可能 attach 到了别的进程
    throw new Error(`Expected about:blank tab on fresh chrome but found: ${JSON.stringify(tabs.map(t => t.url))}`);
  }
  log(`connected to: ${tab.url} (verified: fresh chrome tab)`);

  const cdp = new CdpClient(tab.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('Runtime.enable');

  // === 1. mobile emulation ===
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
    screenOrientation: { angle: 0, type: 'portraitPrimary' },
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp.send('Network.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (Linux; Android 12; ICL-AL10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36 HubE2ETest/0.1',
  });

  // === 2. navigate PWA ===
  log('navigating to PWA');
  await cdp.send('Page.navigate', { url: PWA_URL });
  await sleep(3500);
  await cdp.screenshot('01-pwa-loaded.png');

  // === 3. 检查 view 状态 ===
  const viewState = await cdp.evaluate(`(() => ({
    pairingOn: document.getElementById('view-pairing')?.classList.contains('on'),
    mainOn: document.getElementById('view-main')?.classList.contains('on'),
    hasDeviceToken: !!localStorage.getItem('hub-mobile/device-token'),
    title: document.title,
    bodyChildren: document.body.children.length,
  }))()`);
  log('initial state:', JSON.stringify(viewState));

  // === 4. 如果已配对，清掉先（强制走配对流程） ===
  if (viewState.hasDeviceToken) {
    log('clearing existing device-token to force re-pairing');
    await cdp.evaluate(`localStorage.clear(); location.reload();`);
    await sleep(3000);
  }

  // === 5. 点 PIN 按钮 0,6,3,5,5,1 ===
  log(`tapping PIN: ${PIN}`);
  for (const digit of PIN) {
    const ok = await cdp.evaluate(`(() => {
      const btn = document.querySelector(\`.key[data-key="${digit}"]\`);
      if (!btn) return { ok: false, reason: 'no key ${digit}' };
      btn.click();
      return { ok: true, pinBuf: window.ui?.pinBuf || 'n/a' };
    })()`);
    log(`  digit ${digit}:`, JSON.stringify(ok));
    await sleep(150);
  }
  await sleep(2500);  // 等配对 fetch
  await cdp.screenshot('02-after-pin-input.png');

  // === 6. 检查是否进入主屏 ===
  const afterPair = await cdp.evaluate(`(() => ({
    pairingOn: document.getElementById('view-pairing')?.classList.contains('on'),
    mainOn: document.getElementById('view-main')?.classList.contains('on'),
    hasDeviceToken: !!localStorage.getItem('hub-mobile/device-token'),
    connText: document.getElementById('conn-text')?.textContent,
    pairError: document.getElementById('pair-error')?.textContent,
  }))()`);
  log('after pairing:', JSON.stringify(afterPair));

  if (!afterPair.mainOn) {
    log('!! NOT on main screen after pairing');
    await cdp.screenshot('02b-pairing-failed.png');
  }

  // === 7. 等待 WSS 连接 ok ===
  log('waiting for WSS conn-state=ok');
  for (let i = 0; i < 30; i++) {
    const s = await cdp.evaluate(`document.getElementById('nav-title')?.getAttribute('data-conn')`);
    if (s === 'ok') { log(`conn-state OK at ${i}s`); break; }
    await sleep(1000);
  }
  await cdp.screenshot('03-main-screen-connected.png');

  // === 8. 输入消息 + 发送 ===
  log(`typing message: "${TEST_MESSAGE}"`);
  await cdp.evaluate(`(() => {
    const input = document.getElementById('composer-input');
    input.innerText = ${JSON.stringify(TEST_MESSAGE)};
    input.focus();
  })()`);
  await sleep(300);
  await cdp.evaluate(`document.getElementById('composer-send').click();`);
  await sleep(500);
  await cdp.screenshot('04-after-send.png');

  // === 9. 等 Claude 回复（最多 120s）===
  log('waiting for Claude reply (timeout 120s)');
  let replyText = null;
  for (let i = 0; i < 120; i++) {
    const turns = await cdp.evaluate(`(() => {
      const claudeBubbles = document.querySelectorAll('.turn-claude .text');
      return Array.from(claudeBubbles).map(el => el.innerText);
    })()`);
    if (turns && turns.length > 0) {
      replyText = turns[turns.length - 1];
      log(`Claude reply received at ${i}s: "${replyText.slice(0, 100)}"`);
      break;
    }
    if (i % 5 === 4) log(`  ${i + 1}s elapsed, still waiting...`);
    await sleep(1000);
  }
  await sleep(2000);
  await cdp.screenshot('05-claude-replied.png');
  await cdp.screenshot('06-final-fullpage.png', true);

  // === 10. consoles ===
  log('checking console errors');
  // (CDP 默认会发 Runtime.consoleAPICalled，我们没监听，只查最后渲染)

  // 总结
  const summary = {
    pwa_url: PWA_URL,
    pin_used: PIN,
    pairing_ok: afterPair.mainOn === true,
    wss_conn_state: await cdp.evaluate(`document.getElementById('nav-title')?.getAttribute('data-conn')`),
    message_sent: TEST_MESSAGE,
    claude_reply: replyText,
    end_to_end_ok: !!replyText,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, 'summary.json'),
    JSON.stringify(summary, null, 2)
  );
  log('=== summary ===');
  console.log(JSON.stringify(summary, null, 2));

  process.exit(summary.end_to_end_ok ? 0 : 1);
}

main().catch(e => { console.error('FATAL', e.message, e.stack); process.exit(2); });
