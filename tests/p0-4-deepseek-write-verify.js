'use strict';
// DeepSeek 写 memory 能力验证：
// 1. CDP attach Hub
// 2. 创建 DeepSeek 单 AI 群聊
// 3. 通过 groupchat:turn IPC 发"请记住 P04DS-VERIFY-20260601"
// 4. 等 DeepSeek 响应 + memory 写入
// 5. 关掉 meeting 触发 cleanup
//
// 验证：~/.claude-deepseek/projects/<cwd-escape>/memory/ 是否出现新 md / mtime 更新

const WebSocket = require('ws');
const http = require('http');

const CDP = 'http://127.0.0.1:9231';

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
  const ts = JSON.parse(await get(`${CDP}/json/list`));
  const t = ts.find(x => x.type === 'page');
  const cdp = await newCdp(t.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  console.log('=== Step 1: 创建 DeepSeek 单成员群聊 ===');
  const r1 = await cdp.send('Runtime.evaluate', {
    expression: `
      (async () => {
        const { ipcRenderer } = require('electron');
        const result = await ipcRenderer.invoke('create-meeting', {
          title: 'P04 DeepSeek write verify',
          groupChat: true,
          slots: [{ kind: 'deepseek', model: null }],
        });
        return { mid: result.id, subs: (result.subSessions || []).map(s => typeof s === 'string' ? s : s.id) };
      })()
    `,
    awaitPromise: true, returnByValue: true,
  });
  const { mid, subs } = r1.result.value;
  console.log(`  meeting=${mid}, subs=${JSON.stringify(subs)}`);

  console.log('\n=== Step 2: 等 5s 让 DeepSeek sub 就绪 ===');
  await sleep(5000);

  console.log('\n=== Step 3: 发"请记住 P04DS-VERIFY-20260601" 到群聊 ===');
  const r2 = await cdp.send('Runtime.evaluate', {
    expression: `
      (async () => {
        const { ipcRenderer } = require('electron');
        try {
          const turn = await ipcRenderer.invoke('groupchat:turn', {
            meetingId: '${mid}',
            userInput: '请记住这个测试编号：P04DS-VERIFY-20260601，是立花验证 DeepSeek auto-memory 写入能力用的。请你显式使用 memory 工具把它存到你的 memory 目录。完成后用一句话告诉我"已存入 memory: <文件路径>"',
          });
          return { ok: true, turnNum: turn && turn.turnNum, results: turn && (turn.results || []).map(r => ({ sid: r.sid, status: r.status, textLen: (r.text||'').length, textHead: (r.text||'').slice(0, 200) })) };
        } catch (e) {
          return { ok: false, err: e.message };
        }
      })()
    `,
    awaitPromise: true, returnByValue: true,
  });
  console.log('  ' + JSON.stringify(r2.result.value, null, 2));

  console.log('\n=== Step 4: 等 40s 让 DeepSeek 真实响应 + 写 memory ===');
  await sleep(40000);

  // 拿最新 turn 结果
  console.log('\n=== Step 5: 看最新 turn 结果 ===');
  const r3 = await cdp.send('Runtime.evaluate', {
    expression: `
      (async () => {
        const { ipcRenderer } = require('electron');
        const ms = await ipcRenderer.invoke('get-meetings');
        const m = ms.find(x => x.id === '${mid}');
        return { meeting: m ? { id: m.id, title: m.title, subSessions: m.subSessions } : null };
      })()
    `,
    awaitPromise: true, returnByValue: true,
  });
  console.log('  ' + JSON.stringify(r3.result.value, null, 2));

  cdp.close();
  console.log('\n=== DeepSeek 测试 CDP 部分 done，PowerShell 验证 memory 写入 ===');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
