'use strict';

// E2E artifact-fetch 测试：模拟 PWA 通过 WSS 请求 Hub 读本地 HTML，验证内容透明返回。
// 用本地 mock gateway (127.0.0.1:9081) + 隔离 Hub。

const WebSocket = require('ws');
const http = require('http');

const GATEWAY = 'ws://127.0.0.1:9081';
const PAIR_URL = 'http://127.0.0.1:9081/api/pair';
const PIN = '000000';

const TEST_PATHS = [
  // 应该成功：在白名单内
  'C:\\Users\\lintian\\Desktop\\claude-artifacts\\artifact-test-sample.html',
  // 应该成功：使用正斜杠
  'C:/Users/lintian/Desktop/claude-artifacts/artifact-test-sample.html',
  // 应该失败：路径不在白名单
  'C:\\Windows\\System32\\drivers\\etc\\hosts',
  // 应该失败：扩展名不允许
  'C:\\Users\\lintian\\Desktop\\claude-artifacts\\test.exe',
  // 应该失败：路径遍历尝试
  'C:\\Users\\lintian\\Desktop\\claude-artifacts\\..\\..\\.bashrc',
  // 应该失败：文件不存在
  'C:\\Users\\lintian\\Desktop\\claude-artifacts\\nonexistent-12345.html',
];

function log(...a) { console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a); }

async function pair() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ pin: PIN, deviceName: 'ArtifactTest' });
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

async function main() {
  log('Pairing...');
  const { deviceToken } = await pair();
  log(`got token: ${deviceToken.slice(0,8)}…`);

  const ws = new WebSocket(`${GATEWAY}/pwa`, [`device.${deviceToken}`]);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  log('WSS open');

  const results = [];
  let pendingRequestId = null;
  let pendingResolve = null;

  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong', ts: Date.now() })); return; }
    if (msg.type === 'pong' || msg.type === 'conn-state') return;
    if ((msg.type === 'artifact-content' || msg.type === 'artifact-error') && msg.requestId === pendingRequestId) {
      if (pendingResolve) { pendingResolve(msg); pendingResolve = null; }
    }
  });

  // 等 hello 跑完
  ws.send(JSON.stringify({ type: 'hello' }));
  await new Promise(r => setTimeout(r, 1500));

  for (const path of TEST_PATHS) {
    const requestId = 'art-test-' + Math.random().toString(36).slice(2, 8);
    pendingRequestId = requestId;
    ws.send(JSON.stringify({ type: 'artifact-fetch', path, requestId }));
    log(`→ FETCH ${path}`);

    const result = await new Promise((res) => {
      pendingResolve = res;
      setTimeout(() => res({ type: 'timeout' }), 10000);
    });

    const summary = {
      path,
      type: result.type,
      ok: result.type === 'artifact-content',
      error: result.error,
      size: result.size,
      mimeType: result.mimeType,
      base64Preview: result.contentBase64 ? result.contentBase64.slice(0, 40) + '…' : null,
    };
    results.push(summary);
    log(`  ← ${result.type} ${result.error ? `(${result.error})` : result.size + 'B'}`);
  }

  ws.close();

  console.log('\n=== Results ===');
  console.log(JSON.stringify(results, null, 2));

  // 验证预期
  const expected = [
    { idx: 0, expectOk: true },   // 反斜杠样本：应该成功
    { idx: 1, expectOk: true },   // 正斜杠：应该成功
    { idx: 2, expectOk: false },  // 系统目录：应该拒绝
    { idx: 3, expectOk: false },  // exe 扩展名：应该拒绝
    { idx: 4, expectOk: false },  // 路径遍历：应该拒绝
    { idx: 5, expectOk: false },  // 不存在：应该拒绝
  ];

  let allCorrect = true;
  for (const e of expected) {
    const r = results[e.idx];
    const correct = r.ok === e.expectOk;
    if (!correct) {
      console.log(`!! MISMATCH at index ${e.idx}: expected ok=${e.expectOk}, got ok=${r.ok}`);
      allCorrect = false;
    }
  }
  console.log(`\nAll cases correct: ${allCorrect}`);
  process.exit(allCorrect ? 0 : 1);
}

main().catch(e => { console.error('FATAL', e.message, e.stack); process.exit(2); });
