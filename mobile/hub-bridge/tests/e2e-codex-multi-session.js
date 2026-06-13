'use strict';

// 完整 E2E 测试多 session 协议 + Codex 支持。
// 用本地 mock gateway (127.0.0.1:9080) + 隔离 Hub (CLAUDE_HUB_DATA_DIR=C:\temp\hub-mobile-test)
//
// 流程：
//   1. POST /api/pair { pin: '000000' } → 拿 deviceToken
//   2. 连 WSS /pwa，子协议 device.<token>
//   3. 发 HELLO → 等 SESSION_LIST
//   4. 给 mobile-default 发消息 → 等 TURN
//   5. NEW_SESSION { kind: 'codex' } → 等 SESSION_CREATED
//   6. 给 codex session 发消息 → 等 TURN
//   7. 全程截图证据 + 写 summary.json

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const GATEWAY = 'ws://127.0.0.1:9080';
const PAIR_URL = 'http://127.0.0.1:9080/api/pair';
const PIN = '000000';
const EVIDENCE_DIR = 'C:\\Users\\lintian\\Desktop\\claude-artifacts\\hub-mobile-e2e';

function log(...args) { console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...args); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function pair() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ pin: PIN, deviceName: 'E2E Test' });
    const req = http.request(PAIR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`pair HTTP ${res.statusCode}: ${buf}`));
        try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

class FakePwaClient {
  constructor(token) {
    this.token = token;
    this.ws = null;
    this.handlers = {};
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${GATEWAY}/pwa`, [`device.${this.token}`]);
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
      this.ws.on('message', (data) => {
        let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
        const handler = this.handlers[msg.type];
        if (handler) handler(msg);
        log(`RECV ${msg.type}: ${JSON.stringify(msg).slice(0, 200)}`);
      });
    });
  }
  send(msg) { this.ws.send(JSON.stringify(msg)); }
  on(type, fn) { this.handlers[type] = fn; }
  off(type) { delete this.handlers[type]; }
  close() { try { this.ws.close(); } catch {} }

  // 等待特定 type 出现，可选 filter
  waitFor(type, predicate = () => true, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const handler = (msg) => {
        if (predicate(msg)) {
          this.off(type);
          resolve(msg);
        }
      };
      this.on(type, handler);
      const timer = setInterval(() => {
        if (Date.now() - t0 > timeoutMs) {
          clearInterval(timer);
          this.off(type);
          reject(new Error(`timeout waiting ${type}`));
        }
      }, 500);
    });
  }
}

async function main() {
  if (!fs.existsSync(EVIDENCE_DIR)) fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const summary = { steps: [], errors: [] };
  const log_evidence = (step, ok, data) => {
    summary.steps.push({ step, ok, ts: new Date().toISOString(), ...data });
    log(`*** ${step}: ${ok ? 'OK' : 'FAIL'}`);
  };

  try {
    // Step 1: pair
    log('1. Pairing with PIN ' + PIN);
    const { deviceToken } = await pair();
    log(`got deviceToken: ${deviceToken.slice(0, 8)}…`);
    log_evidence('pair', true, { deviceToken: deviceToken.slice(0, 8) + '…' });

    // Step 2: connect WSS
    const client = new FakePwaClient(deviceToken);
    await client.connect();
    log_evidence('wss-connect', true);

    // Step 3: send HELLO → expect SESSION_LIST
    log('2. Sending HELLO');
    client.send({ type: 'hello', sinceSeq: 0 });
    const sessList = await client.waitFor('session-list', () => true, 8000);
    log(`session-list received: ${sessList.sessions.length} sessions`);
    for (const s of sessList.sessions) log(`  - ${s.id.slice(0, 8)} kind=${s.kind} status=${s.status} title=${s.title}`);
    log_evidence('hello-and-list', true, { sessionCount: sessList.sessions.length, sessions: sessList.sessions });

    // Step 4: Send to mobile-default (Claude) - 验证 Claude session 工作
    log('3. Sending msg to mobile-default (Claude)');
    client.send({ type: 'input', sessionId: 'mobile-default', content: '你好，请简短回应一句', clientId: 'test-1' });
    const claudeReply = await client.waitFor('turn', (m) => m.sessionId === 'mobile-default', 120000);
    log(`Claude reply: ${claudeReply.content.slice(0, 100)}`);
    log_evidence('claude-reply', true, { content: claudeReply.content.slice(0, 200), seq: claudeReply.seq });

    // Step 5: NEW_SESSION codex
    log('4. Requesting new Codex session');
    const reqId = 'codex-req-' + Date.now();
    client.send({ type: 'new-session', kind: 'codex', title: '测试 Codex', requestId: reqId });
    const created = await client.waitFor('session-created', () => true, 10000);
    log(`new codex session: ${JSON.stringify(created.session)}`);
    log_evidence('new-codex-session', true, { session: created.session });
    const codexId = created.session.id;

    // Step 6: 等几秒 codex CLI 启动
    log('5. Waiting 20s for Codex CLI startup');
    await sleep(20000);

    // Step 7: send to codex
    log(`6. Sending msg to codex session ${codexId.slice(0, 8)}`);
    client.send({ type: 'input', sessionId: codexId, content: 'reply briefly: what year is it', clientId: 'test-2' });
    let codexReply;
    try {
      codexReply = await client.waitFor('turn', (m) => m.sessionId === codexId, 120000);
      log(`Codex reply: ${codexReply.content.slice(0, 200)}`);
      log_evidence('codex-reply', true, { content: codexReply.content.slice(0, 300), seq: codexReply.seq });
    } catch (e) {
      log_evidence('codex-reply', false, { error: e.message });
    }

    // Step 8: destroy session
    log('7. Destroying codex session');
    client.send({ type: 'destroy-session', sessionId: codexId });
    try {
      const destroyed = await client.waitFor('session-destroyed', () => true, 5000);
      log(`destroy result: ${JSON.stringify(destroyed)}`);
      log_evidence('destroy-codex', destroyed.ok === true, { ok: destroyed.ok });
    } catch (e) {
      log_evidence('destroy-codex', false, { error: e.message });
    }

    client.close();
  } catch (e) {
    summary.errors.push({ msg: e.message, stack: e.stack });
    log(`!!! TEST FATAL: ${e.message}`);
  }

  summary.end_to_end_ok = summary.steps.every(s => s.ok) && summary.errors.length === 0;
  summary.endTime = new Date().toISOString();
  const outPath = path.join(EVIDENCE_DIR, 'multi-session-summary.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  log(`summary saved: ${outPath}`);
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.end_to_end_ok ? 0 : 1);
}

main().catch(e => { console.error('FATAL', e.message, e.stack); process.exit(2); });
