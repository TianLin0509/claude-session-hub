'use strict';
// 测量 codex vs claude 在 mobile PWA 上的 turn 延迟。
//
// 每个 kind 起 1 个 session，发 3 条等价 prompt，记录 send → turn 实际间隔（ms）。
// 输出 markdown 表格。
//
// 用法：node bench-latency-codex-vs-claude.js
//
// 前提：hub5 PID 71724 在跑（dataDir C:/temp/hub-e2e-mobile5），device a503870e5583 已配对。

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const HUB_ID = 'DESKTOP-1CH0TRP-pid71724-1780838465571';
const DATA_DIR = 'C:/temp/hub-e2e-mobile5';
const tokFile = path.join(DATA_DIR, 'mobile-devices.json');
const fullTok = JSON.parse(fs.readFileSync(tokFile, 'utf8')).devices
  .find(d => d.token.startsWith('a503870e5583')).token;

const PROMPTS = ['你好', '今天日期是？', '1+1=?'];

function openWs() {
  return new WebSocket('wss://lthub.xyz:8443/pwa', [`device.${fullTok}`], { rejectUnauthorized: false });
}

function runOneKind(kind, sessionTitle) {
  return new Promise((resolve, reject) => {
    const ws = openWs();
    let sid = null;
    let pendingResolveTurn = null;
    let sentAt = 0;
    const results = [];
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`[${kind}] overall timeout`));
    }, 600000); // 10 分钟兜底
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', sinceSeq: 0 }));
      setTimeout(() => {
        ws.send(JSON.stringify({
          type: 'new-session', kind, title: sessionTitle, hubId: HUB_ID, requestId: `bench-${kind}`,
        }));
      }, 800);
    });
    ws.on('message', async (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'session-created' && !sid) {
        sid = m.session.id;
        console.log(`[${kind}] session created sid=${sid.slice(0, 12)}, 等 ${kind === 'codex' ? 35 : 15}s CLI 就绪…`);
        // 等 CLI 起来（codex 启动稍慢需要 ~30s）
        await new Promise(r => setTimeout(r, kind === 'codex' ? 35000 : 15000));
        for (let i = 0; i < PROMPTS.length; i++) {
          const prompt = PROMPTS[i];
          console.log(`[${kind}] 发 #${i + 1}: "${prompt}"`);
          sentAt = Date.now();
          ws.send(JSON.stringify({ type: 'input', sessionId: sid, content: prompt, clientId: `bench-${kind}-${i}`, hubId: HUB_ID }));
          // 等 turn 回来
          const elapsed = await new Promise((res, rej) => {
            const tt = setTimeout(() => rej(new Error('turn-timeout')), 120000);
            pendingResolveTurn = (ms, preview) => { clearTimeout(tt); res({ ms, preview }); };
          }).catch(e => ({ ms: -1, preview: e.message }));
          results.push({ prompt, elapsedMs: elapsed.ms, preview: elapsed.preview });
          console.log(`[${kind}] #${i + 1} turn 用时 ${elapsed.ms} ms  preview="${(elapsed.preview || '').slice(0, 40)}"`);
          // 间隔 3s
          await new Promise(r => setTimeout(r, 3000));
        }
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve({ kind, sid, results });
      } else if (m.type === 'turn' && sid && m.sessionId === sid && pendingResolveTurn) {
        const elapsed = Date.now() - sentAt;
        const fn = pendingResolveTurn;
        pendingResolveTurn = null;
        fn(elapsed, m.content || '');
      } else if (m.type === 'error') {
        console.warn(`[${kind}] WS error:`, JSON.stringify(m));
      }
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`[${kind}] WS error: ${e.message}`));
    });
  });
}

(async () => {
  console.log('=== Mobile latency bench: codex vs claude ===');
  let claudeRes, codexRes;
  try {
    claudeRes = await runOneKind('claude', 'bench-claude');
  } catch (e) {
    console.error('claude run failed:', e.message);
    claudeRes = { kind: 'claude', results: PROMPTS.map(p => ({ prompt: p, elapsedMs: -1, preview: 'FAIL' })) };
  }
  await new Promise(r => setTimeout(r, 3000));
  try {
    codexRes = await runOneKind('codex', 'bench-codex');
  } catch (e) {
    console.error('codex run failed:', e.message);
    codexRes = { kind: 'codex', results: PROMPTS.map(p => ({ prompt: p, elapsedMs: -1, preview: 'FAIL' })) };
  }
  console.log('\n=== Markdown 对比 ===\n');
  console.log('| # | prompt | claude (ms) | codex (ms) | diff (ms) |');
  console.log('|---|--------|-------------|------------|-----------|');
  for (let i = 0; i < PROMPTS.length; i++) {
    const c = claudeRes.results[i].elapsedMs;
    const x = codexRes.results[i].elapsedMs;
    const d = (c > 0 && x > 0) ? (x - c) : 'n/a';
    console.log(`| ${i + 1} | ${PROMPTS[i]} | ${c} | ${x} | ${d} |`);
  }
  process.exit(0);
})();
