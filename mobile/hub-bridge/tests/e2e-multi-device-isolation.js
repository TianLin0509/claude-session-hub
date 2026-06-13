'use strict';

// 验证 multi-device session 隔离：
//   - 2 个 PWA 设备同时连上同一 session
//   - 只有发 input 的设备应该收到 turn 回复
//   - 另一个设备不应收到（不订阅）
//   - 然后 device B 也发 input → 之后 turn 推送给 A 和 B（都订阅了）

const WebSocket = require('ws');
const http = require('http');

const GATEWAY = 'ws://127.0.0.1:9081';
const PAIR_URL = 'http://127.0.0.1:9081/api/pair';
const PIN = '000000';
const SESSION = 'mobile-default';

function log(...a) { console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a); }

async function pair(name) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ pin: PIN, deviceName: name });
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

class Device {
  constructor(name, token) {
    this.name = name;
    this.token = token;
    this.turns = [];
    this.ws = null;
  }
  async connect() {
    this.ws = new WebSocket(`${GATEWAY}/pwa`, [`device.${this.token}`]);
    await new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); });
    this.ws.on('message', (data) => {
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'ping') { this.ws.send(JSON.stringify({ type: 'pong', ts: Date.now() })); return; }
      if (msg.type === 'turn' && msg.sessionId === SESSION) {
        this.turns.push({ seq: msg.seq, content: msg.content.slice(0, 60), ts: msg.ts });
        log(`[${this.name}] RECV turn seq=${msg.seq}: ${msg.content.slice(0, 80)}`);
      }
    });
    this.ws.send(JSON.stringify({ type: 'hello' }));
  }
  sendInput(text) {
    this.ws.send(JSON.stringify({ type: 'input', sessionId: SESSION, content: text }));
    log(`[${this.name}] SEND: ${text.slice(0, 60)}`);
  }
  close() { try { this.ws.close(); } catch {} }
}

async function main() {
  log('Pairing 2 devices');
  const tokenA = (await pair('Device-A')).deviceToken;
  const tokenB = (await pair('Device-B')).deviceToken;
  log(`A=${tokenA.slice(0,8)}…  B=${tokenB.slice(0,8)}…`);

  const A = new Device('A', tokenA);
  const B = new Device('B', tokenB);
  await A.connect();
  await B.connect();
  log('Both connected. Waiting 5s for handshake + claude warmup');
  await new Promise(r => setTimeout(r, 5000));

  // Step 1: A 发 input，应该只有 A 收到 turn
  log('=== STEP 1: A sends, B should NOT receive ===');
  A.sendInput('请用一句话告诉我 1+1 等于几');
  log('Waiting 100s for Claude reply (first call cold start)...');
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (A.turns.length > 0 || B.turns.length > 0) break;
    if (i % 10 === 9) log(`  ${i+1}s waited, A=${A.turns.length} B=${B.turns.length}`);
  }

  const turnsA_step1 = A.turns.length;
  const turnsB_step1 = B.turns.length;
  log(`After step 1: A=${turnsA_step1} turns, B=${turnsB_step1} turns`);

  log('=== STEP 2: B sends, both should receive ===');
  B.sendInput('再用一句话告诉我 2+2 等于几');
  log('Waiting 80s for Claude reply...');
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (A.turns.length > turnsA_step1 || B.turns.length > turnsB_step1) break;
    if (i % 10 === 9) log(`  ${i+1}s waited, A=${A.turns.length} B=${B.turns.length}`);
  }

  const turnsA_step2 = A.turns.length - turnsA_step1;
  const turnsB_step2 = B.turns.length - turnsB_step1;
  log(`After step 2: A=${turnsA_step2} new turns (since A still subscribes), B=${turnsB_step2} new turns`);

  A.close(); B.close();

  const summary = {
    step1_A_recv: turnsA_step1,
    step1_B_recv: turnsB_step1,
    step2_A_recv: turnsA_step2,
    step2_B_recv: turnsB_step2,
    expected: {
      step1: 'A receives 1, B receives 0',
      step2: 'A receives 1 (still subscribed), B receives 1 (now subscribed)',
    },
    isolation_ok: turnsA_step1 === 1 && turnsB_step1 === 0 && turnsA_step2 === 1 && turnsB_step2 === 1,
    A_all_turns: A.turns,
    B_all_turns: B.turns,
  };
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.isolation_ok ? 0 : 1);
}

main().catch(e => { console.error('FATAL', e.message, e.stack); process.exit(2); });
