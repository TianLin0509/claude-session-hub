'use strict';

// 测试 codex/claude 同 session 多次 input 延迟
// 用法：node diagnose-codex-multi-input.js <kind> <deviceTokenPrefix> <hubId>

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const GATEWAY_URL = 'wss://lthub.xyz:8443/pwa';
const kind = process.argv[2] || 'codex';
const deviceTokenPrefix = process.argv[3];
const hubId = process.argv[4];

if (!deviceTokenPrefix || !hubId) {
  console.error('Usage: node diagnose-codex-multi-input.js <kind> <deviceTokenPrefix> <hubId>');
  process.exit(2);
}

// 测试 hub 的 dataDir 也可能是 C:/temp/hub-e2e-mobile2，但 prefix match 后没区别
let fullToken = deviceTokenPrefix;
const candidates = [
  path.join(process.env.USERPROFILE || process.env.HOME, '.claude-session-hub', 'mobile-devices.json'),
  'C:/temp/hub-e2e-mobile2/mobile-devices.json',
];
for (const p of candidates) {
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const match = (data.devices || []).find(d => d.token.startsWith(deviceTokenPrefix));
    if (match) { fullToken = match.token; console.log(`[token] matched in ${p}: ${fullToken.slice(0,8)}…`); break; }
  } catch {}
}

const ws = new WebSocket(GATEWAY_URL, [`device.${fullToken}`], { rejectUnauthorized: false });

const stamp = () => {
  const d = new Date();
  return d.toISOString().slice(11, 23);
};

const events = [];
function rec(tag, extra) {
  events.push({ t: Date.now(), tag, extra });
  console.log(`${stamp()} ${tag}${extra ? ' ' + JSON.stringify(extra).slice(0,160) : ''}`);
}

let sessionId = null;
let inputIdx = 0;
const inputs = ['1+1=?', '2+2=?', '3+3=?'];
const inputTimes = []; // {sentAt, turnAt, durMs}
let pendingTurnIdx = -1;

ws.on('open', () => {
  rec('open');
  ws.send(JSON.stringify({ type: 'hello', sinceSeq: 0 }));
  setTimeout(() => {
    const reqId = 'new-' + Date.now();
    rec('→ new-session', { kind, hubId: hubId.slice(0, 30) });
    ws.send(JSON.stringify({
      type: 'new-session', kind, title: `multi-input-${kind}-${Date.now()}`,
      hubId, requestId: reqId,
    }));
  }, 800);
});

function sendInput() {
  if (inputIdx >= inputs.length) {
    setTimeout(finish, 20000); // 留 20s 接收最后一条 turn
    return;
  }
  const content = inputs[inputIdx];
  pendingTurnIdx = inputIdx;
  inputTimes[inputIdx] = { content, sentAt: Date.now() };
  rec(`→ input #${inputIdx}`, { content });
  ws.send(JSON.stringify({
    type: 'input', sessionId, content, hubId,
    clientId: `c-${Date.now()}-${inputIdx}`,
  }));
  inputIdx++;
}

ws.on('message', (raw) => {
  try {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'session-created' && msg.session && msg.session.kind === kind) {
      sessionId = msg.session.id;
      rec('← session-created', { id: sessionId.slice(0,12), kind: msg.session.kind });
      setTimeout(sendInput, 500);
    } else if (msg.type === 'turn' && msg.sessionId === sessionId) {
      const idx = pendingTurnIdx;
      const dur = idx >= 0 && inputTimes[idx] ? Date.now() - inputTimes[idx].sentAt : null;
      if (idx >= 0 && inputTimes[idx]) inputTimes[idx].turnAt = Date.now();
      rec(`← turn #${idx}`, { textLen: (msg.content||'').length, durMs: dur, preview: (msg.content||'').slice(0,50) });
      // 5 秒后发下一条
      setTimeout(sendInput, 5000);
    } else if (msg.type === 'error') {
      rec('← error', msg);
    } else if (msg.type === 'session-list' || msg.type === 'hub-list' || msg.type === 'conn-state') {
      // 忽略
    } else {
      rec('← ' + msg.type, Object.keys(msg).slice(0,5));
    }
  } catch (e) {
    rec('recv-err', e.message);
  }
});

function finish() {
  console.log('\n=== 测试汇总 ===');
  console.log(`kind=${kind} sessionId=${sessionId}`);
  inputTimes.forEach((it, i) => {
    if (!it) return;
    const dur = it.turnAt ? (it.turnAt - it.sentAt) : null;
    console.log(`  #${i} "${it.content}" → ${dur !== null ? dur + 'ms' : 'NO TURN'}`);
  });
  ws.close(1000, 'done');
  setTimeout(() => process.exit(0), 200);
}

ws.on('close', (code) => { console.log(`[close] code=${code}`); });
ws.on('error', (e) => { console.error('[err]', e.message); process.exit(1); });

setTimeout(() => {
  console.error('[timeout] 90s 超时强制退出');
  finish();
}, 90000);
