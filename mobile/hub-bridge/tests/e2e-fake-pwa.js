'use strict';

// 模拟 PWA 客户端 → VPS gateway → Hub mobile-bridge → Claude CLI 全链路。
// 不依赖浏览器/Android，直接 node 跑。看是否能让 Claude 回复一条消息。
//
// 用法: node tests/e2e-fake-pwa.js [device_token]

const WebSocket = require('ws');

const DEVICE_TOKEN = process.argv[2] || '2a27b8812f3ef5756c781ab8b7a007fa';
const WS_URL = 'wss://lthub.xyz:8443/pwa';
const TEST_MSG = 'hello, please reply with a short greeting';
const TIMEOUT_MS = 120 * 1000;

console.log(`[fake-pwa] connecting to ${WS_URL}`);
console.log(`[fake-pwa] device token: ${DEVICE_TOKEN.slice(0, 8)}…`);

const ws = new WebSocket(WS_URL, [`device.${DEVICE_TOKEN}`]);

let inputSent = false;
let turnReceived = false;
let connStateCount = 0;

ws.on('open', () => {
  console.log(`[${ts()}] OPEN`);
  ws.send(JSON.stringify({ type: 'hello', sinceSeq: 0 }));
  console.log(`[${ts()}] sent hello`);

  setTimeout(() => {
    if (ws.readyState !== 1) {
      console.log(`[${ts()}] WS not open at send time! state=${ws.readyState}`);
      return;
    }
    const msg = { type: 'input', content: TEST_MSG, clientId: 'fake-pwa-' + Date.now() };
    ws.send(JSON.stringify(msg));
    inputSent = true;
    console.log(`[${ts()}] sent INPUT: "${TEST_MSG}"`);
    console.log(`[${ts()}] waiting for Claude reply...`);
  }, 2000);
});

// 心跳 15s（与 PWA 一致）
const hb = setInterval(() => {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
  }
}, 15000);

ws.on('message', (data) => {
  let msg;
  try { msg = JSON.parse(data.toString()); } catch { console.log(`[${ts()}] RECV raw: ${data}`); return; }
  if (msg.type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
    return;
  }
  if (msg.type === 'pong') return;
  if (msg.type === 'conn-state') {
    connStateCount++;
    console.log(`[${ts()}] CONN-STATE: ${msg.state}`);
    return;
  }
  if (msg.type === 'turn') {
    turnReceived = true;
    console.log(`[${ts()}] *** TURN (Claude replied) ***`);
    console.log(`  seq=${msg.seq} ts=${msg.ts} model=${msg.model}`);
    console.log(`  content: ${(msg.content || '').slice(0, 500)}`);
    console.log(`  duration: ${msg.durationMs}ms`);
    return;
  }
  if (msg.type === 'error') {
    console.log(`[${ts()}] ERROR from gateway: ${msg.code}`);
    return;
  }
  console.log(`[${ts()}] RECV ${msg.type}: ${JSON.stringify(msg).slice(0, 200)}`);
});

ws.on('close', (code, reason) => {
  const r = reason ? reason.toString() : '';
  console.log(`[${ts()}] CLOSE ${code} ${r}`);
  cleanup();
});

ws.on('error', (err) => {
  console.error(`[${ts()}] ERROR: ${err.message}`);
});

const timeoutTimer = setTimeout(() => {
  console.log(`\n[${ts()}] === TIMEOUT after ${TIMEOUT_MS / 1000}s ===`);
  console.log(`inputSent=${inputSent}`);
  console.log(`turnReceived=${turnReceived}`);
  console.log(`connStateCount=${connStateCount}`);
  if (!turnReceived && inputSent) {
    console.log(`\n判断: 消息发出去了，但 Claude 没回复。问题在 Hub 端（mobile-bridge → sessionManager → Claude）`);
  } else if (!inputSent) {
    console.log(`\n判断: 连消息都没发出去，连接太不稳定`);
  } else {
    console.log(`\n判断: 链路 OK`);
  }
  cleanup();
}, TIMEOUT_MS);

function cleanup() {
  clearInterval(hb);
  clearTimeout(timeoutTimer);
  try { ws.close(); } catch {}
  setTimeout(() => process.exit(turnReceived ? 0 : 1), 500);
}

function ts() {
  return new Date().toISOString().slice(11, 23);
}
