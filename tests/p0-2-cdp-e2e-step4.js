'use strict';
// CDP E2E Step 4: 拿 main 进程真实 session 对象，验证 cwd + meetingId 闭环

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');

const CDP = 'http://127.0.0.1:9229';

function get(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej);
  });
}
function newCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 1; const pend = new Map();
  return new Promise((ok) => {
    ws.on('open', () => ok({
      send(method, params = {}) {
        const i = id++;
        return new Promise((res, rej) => {
          pend.set(i, { res, rej });
          ws.send(JSON.stringify({ id: i, method, params }));
        });
      },
      close() { ws.close(); },
    }));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && pend.has(m.id)) {
        const { res, rej } = pend.get(m.id);
        pend.delete(m.id);
        if (m.error) rej(new Error(m.error.message));
        else res(m.result);
      }
    });
  });
}

(async () => {
  const targets = JSON.parse(await get(`${CDP}/json/list`));
  const t = targets.find((x) => x.type === 'page');
  const cdp = await newCdp(t.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  console.log('=== Step 4a: invoke("get-meetings") + invoke("get-sessions") 拿真实 main state ===');
  const r = await cdp.send('Runtime.evaluate', {
    expression: `
      (async () => {
        const { ipcRenderer } = require('electron');
        const meetings = await ipcRenderer.invoke('get-meetings');
        const sessions = await ipcRenderer.invoke('get-sessions');
        return {
          meetingCount: meetings.length,
          meetings: meetings.map(m => ({
            id: m.id,
            title: m.title,
            groupChat: m.groupChat,
            subSessions: (m.subSessions || []).map(s => typeof s === 'string' ? { sid: s } : { sid: s.id, kind: s.kind, cwd: s.cwd })
          })),
          sessionCount: sessions.length,
          sessions: sessions.map(s => ({
            id: s.id,
            title: s.title,
            kind: s.kind,
            cwd: s.cwd,
            meetingId: s.meetingId,
            createdAt: s.createdAt,
          })),
        };
      })()
    `,
    awaitPromise: true,
    returnByValue: true,
  });
  const data = r.result.value;
  console.log(JSON.stringify(data, null, 2));

  console.log('\n=== Step 4b: 关键断言 ===');
  const groupSessions = data.sessions.filter(s => s.meetingId);
  let pass = 0, fail = 0;
  const expectedCwd = process.env.USERPROFILE;
  for (const s of groupSessions) {
    const cwdOk = s.cwd === expectedCwd;
    console.log(`  session "${s.title}" (${s.kind}): cwd=${s.cwd}  ${cwdOk ? '✅' : '❌'} (expected ${expectedCwd})`);
    if (cwdOk) pass++; else fail++;
  }
  console.log(`\n  PASS: ${pass} / FAIL: ${fail} / TOTAL group sub sessions: ${groupSessions.length}`);

  cdp.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('FAIL:', e.message); process.exit(1);
});
