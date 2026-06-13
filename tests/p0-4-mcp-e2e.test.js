'use strict';
// P0.4 全自动 E2E：替立花跑，不让他动手
// 1. CDP attach isolated Hub (port 9230)
// 2. IPC invoke create-meeting 带 Claude + DeepSeek + Codex 三个 sub
// 3. 等 sub spawn 完，截图
// 4. 查 Win32_Process 子进程命令行，验 --append-system-prompt-file 拼到了
// 5. 退出 (清理由外层 PS 做)

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CDP = 'http://127.0.0.1:9230';
const ARTIFACT_DIR = 'C:\\Users\\lintian\\Desktop\\claude-artifacts';

function get(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(d)); }).on('error', rej);
  });
}
function newCdp(u) {
  const ws = new WebSocket(u); let id=1; const p=new Map();
  return new Promise(ok => {
    ws.on('open', () => ok({
      send(m, x={}) { const i=id++; return new Promise((r,rj)=>{p.set(i,{r,rj});ws.send(JSON.stringify({id:i,method:m,params:x}));}); },
      close() { ws.close(); },
    }));
    ws.on('message', raw => {
      const m=JSON.parse(raw.toString());
      if (m.id && p.has(m.id)) { const {r,rj}=p.get(m.id); p.delete(m.id); if (m.error) rj(new Error(m.error.message)); else r(m.result); }
    });
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('=== Step 1: CDP attach ===');
  const ts = JSON.parse(await get(`${CDP}/json/list`));
  const t = ts.find(x => x.type === 'page');
  console.log(`  target: ${t.title} @ ${t.url}`);
  const cdp = await newCdp(t.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  console.log('\n=== Step 2: 真实 IPC invoke("create-meeting") with Claude + DeepSeek + Codex ===');
  const r = await cdp.send('Runtime.evaluate', {
    expression: `
      (async () => {
        try {
          const { ipcRenderer } = require('electron');
          const result = await ipcRenderer.invoke('create-meeting', {
            title: 'P0.4 MCP E2E',
            groupChat: true,
            scene: null,
            slots: [
              { kind: 'claude', model: null },
              { kind: 'deepseek', model: null },
              { kind: 'codex', model: null },
            ],
          });
          return { ok: true, mid: result && result.id, subCount: result && (result.subSessions || []).length };
        } catch (e) {
          return { ok: false, err: e.message };
        }
      })()
    `,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log('  ' + JSON.stringify(r.result.value));

  console.log('\n=== Step 3: 等 6s 让 sub spawn 完 ===');
  await sleep(6000);

  console.log('\n=== Step 4: invoke("get-sessions") 看 main 端 session 对象 ===');
  const r2 = await cdp.send('Runtime.evaluate', {
    expression: `
      (async () => {
        const { ipcRenderer } = require('electron');
        const ss = await ipcRenderer.invoke('get-sessions');
        return ss.map(s => ({
          id: s.id, kind: s.kind, title: s.title, cwd: s.cwd,
          meetingId: s.meetingId, pid: s.pid || null,
          appendSystemPromptFile: s.appendSystemPromptFile || null,
        }));
      })()
    `,
    awaitPromise: true,
    returnByValue: true,
  });
  const sessions = r2.result.value;
  console.log('  sessions:');
  for (const s of sessions) console.log('    ' + JSON.stringify(s));

  console.log('\n=== Step 5: 截图 Hub UI 当前状态 ===');
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const shotPath = path.join(ARTIFACT_DIR, 'p0-4-hub-mcp-e2e.png');
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  console.log(`  saved: ${shotPath} (${(fs.statSync(shotPath).size/1024).toFixed(1)} KB)`);

  // 把 session 信息存盘供后续 PS 命令行对照
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'p0-4-sessions.json'), JSON.stringify(sessions, null, 2));

  cdp.close();
  console.log('\n=== E2E (CDP 部分) done ===');
})().catch(e => { console.error('FAIL:', e.message, e.stack); process.exit(1); });
