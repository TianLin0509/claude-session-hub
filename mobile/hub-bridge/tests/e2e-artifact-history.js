'use strict';

// 测 ARTIFACT_LIST_REQUEST → ARTIFACT_LIST 端到端：PWA 请求历史列表，hub 返回最近 N 个 .html

const WebSocket = require('ws');
const http = require('http');

const GATEWAY = 'ws://127.0.0.1:9081';
const PAIR_URL = 'http://127.0.0.1:9081/api/pair';
const PIN = '000000';

function pair() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ pin: PIN, deviceName: 'HistoryTest' });
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
    req.on('error', reject); req.write(body); req.end();
  });
}

async function main() {
  console.log('Pairing...');
  const { deviceToken } = await pair();
  console.log(`got token: ${deviceToken.slice(0, 8)}…`);

  const ws = new WebSocket(`${GATEWAY}/pwa`, [`device.${deviceToken}`]);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  console.log('WSS open');

  const requestId = 'hist-' + Date.now();
  const result = await new Promise((res) => {
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'artifact-list' && msg.requestId === requestId) {
          res(msg);
        }
      } catch {}
    });
    ws.send(JSON.stringify({ type: 'artifact-list-req', requestId, limit: 20 }));
    setTimeout(() => res({ error: 'timeout' }), 10000);
  });

  ws.close();

  console.log('\n=== Result ===');
  if (result.error) {
    console.log('ERROR:', result.error);
    process.exit(1);
  }
  console.log(`Returned ${result.items.length} items:`);
  for (const item of result.items.slice(0, 10)) {
    const date = new Date(item.mtimeMs).toISOString().slice(0, 19);
    console.log(`  - ${item.name.padEnd(50)} ${(item.size / 1024).toFixed(1).padStart(8)} KB · ${date}`);
  }
  process.exit(result.items.length > 0 ? 0 : 1);
}

main().catch(e => { console.error('FATAL', e.message, e.stack); process.exit(2); });
