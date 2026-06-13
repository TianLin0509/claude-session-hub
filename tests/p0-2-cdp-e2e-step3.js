'use strict';
// CDP E2E Step 3: 真实 IPC invoke('create-meeting') 触发 P0.2 改动路径
// 让 main 进程真实跑到 createMeetingSubAdder cwd 决策 + session-manager Codex env 决策

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CDP = 'http://127.0.0.1:9229';
const ARTIFACT_DIR = 'C:\\Users\\lintian\\Desktop\\claude-artifacts';

function get(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(d));
    }).on('error', rej);
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
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  console.log('=== Step 3a: 真实 ipcRenderer.invoke("create-meeting") with codex + gemini ===');
  const r = await cdp.send('Runtime.evaluate', {
    expression: `
      (async () => {
        try {
          const { ipcRenderer } = require('electron');
          const result = await ipcRenderer.invoke('create-meeting', {
            title: 'P0.2 CDP E2E test',
            groupChat: true,
            scene: null,
            slots: [
              { kind: 'codex', model: null },
              { kind: 'gemini', model: null },
            ],
          });
          return { ok: true, meeting: { id: result && result.id, subSessions: result && (result.subSessions || []).map(s => ({ id: s.id, kind: s.kind, cwd: s.cwd, title: s.title })) } };
        } catch (e) {
          return { ok: false, err: e.message, stack: (e.stack || '').slice(0, 500) };
        }
      })()
    `,
    awaitPromise: true,
    returnByValue: true,
  });
  const resultStr = JSON.stringify(r.result.value, null, 2);
  console.log(resultStr);

  // 写到 artifacts 供查
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'p0-2-ipc-result.json'), resultStr);

  console.log('\n=== Step 3b: 主工作台 memory 变化检查（理论上 spawn 失败前已设 cwd） ===');
  const memDir = 'C:\\Users\\lintian\\.claude\\projects\\C--Users-lintian\\memory';
  const memMtime = fs.statSync(path.join(memDir, 'MEMORY.md')).mtime.toISOString();
  console.log(`  MEMORY.md mtime: ${memMtime}`);

  // 等 1 秒让 main 进程的 spawn fail 日志写完
  await new Promise(r => setTimeout(r, 1000));

  cdp.close();
  console.log('\n=== Step 3 done ===');
})().catch((e) => {
  console.error('FAIL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
