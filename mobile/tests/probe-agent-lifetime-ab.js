'use strict';

// A/B 实验：验证 1006 断连是否由"国内直连 Cloudflare 边缘"引起
// A 路：wss://lthub.xyz:8443/agent（DNS → CF 边缘）
// B 路：wss://138.128.192.245:8443/agent（直连 VPS，SNI/Host 伪装 lthub.xyz）
// 各自每 15s 发 JSON PONG 保活，记录存活时长与断连 code。跑 4 分钟。

const tls = require('tls');
const WebSocket = require('ws');

const BEARER = process.env.MOBILE_BEARER_TOKEN;
if (!BEARER) { console.error('need MOBILE_BEARER_TOKEN env'); process.exit(2); }

const DURATION_MS = 4 * 60 * 1000;
const results = { A: [], B: [] };

function now() { return new Date().toISOString().slice(11, 19); }

function startLeg(name, url, wsOpts) {
  let openedAt = null;
  let hb = null;
  let stopped = false;

  function connect() {
    if (stopped) return;
    const ws = new WebSocket(url, [`bearer.${BEARER}`], { handshakeTimeout: 20000, ...wsOpts });
    ws.on('open', () => {
      openedAt = Date.now();
      console.log(`${now()} [${name}] open`);
      ws.send(JSON.stringify({ type: 'hello', hubId: `probe-${name}-${process.pid}`, pid: process.pid, hostname: 'AB-PROBE', version: 'probe', startedAt: openedAt, friendlyName: `AB-probe-${name}` }));
      hb = setInterval(() => { try { ws.send(JSON.stringify({ type: 'pong', ts: Date.now() })); } catch {} }, 15000);
    });
    ws.on('close', (code) => {
      if (hb) { clearInterval(hb); hb = null; }
      if (openedAt) {
        const lifeSec = Math.round((Date.now() - openedAt) / 1000);
        results[name].push({ lifeSec, code });
        console.log(`${now()} [${name}] CLOSE code=${code} life=${lifeSec}s`);
        openedAt = null;
      } else {
        console.log(`${now()} [${name}] close before open, code=${code}`);
      }
      if (!stopped) setTimeout(connect, 1500);
    });
    ws.on('error', (e) => console.log(`${now()} [${name}] err: ${e.message}`));
  }
  connect();
  return () => { stopped = true; };
}

const stopA = startLeg('A', 'wss://lthub.xyz:8443/agent', {});
const stopB = startLeg('B', 'wss://138.128.192.245:8443/agent', {
  servername: 'lthub.xyz',
  headers: { Host: 'lthub.xyz' },
  checkServerIdentity: (host, cert) => tls.checkServerIdentity('lthub.xyz', cert),
});

setTimeout(() => {
  stopA(); stopB();
  console.log('\n=== 结果汇总 ===');
  for (const leg of ['A', 'B']) {
    const r = results[leg];
    const lives = r.map(x => x.lifeSec);
    console.log(`${leg}: 断连 ${r.length} 次, 存活时长(s)=[${lives.join(',')}], codes=[${r.map(x => x.code).join(',')}]`);
  }
  process.exit(0);
}, DURATION_MS);
