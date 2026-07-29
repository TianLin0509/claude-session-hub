'use strict';
// 附着到**已在运行**的隔离测试 Hub（不启动、不关闭任何进程），做只读观察 / 截图 / 断言。
// 用途：真实 AI E2E 跑很久，父进程可能被外层 timeout 掐断，但 electron 还活着 —— 这时
//   用本脚本接上 CDP 9237 继续取证，避免重跑真实 AI 浪费额度。
//
//   node tests/helpers/gc-attach-probe.js <command> [args...]
//     snap  <sid,sid,...>              结构化快照
//     state <meetingId>                groupchat:get-state 摘要
//     shot  <filename>                 截图到 artifacts/
//     meetings                         列出 meetings
//     eval  <js>                       任意表达式（调试用）

const fs = require('fs');
const path = require('path');
const http = require('http');

const { connectCDP } = require('./cdp-client');

const PORT = Number(process.env.GC_REAL_E2E_PORT || 9237);
const ARTIFACT_DIR = path.resolve(__dirname, '..', '..', 'artifacts');

const SNAP_FN = fs.readFileSync(path.join(__dirname, 'gc-snap-fn.js'), 'utf8');

function httpJson(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

(async () => {
  const targets = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
  if (!Array.isArray(targets)) throw new Error(`CDP ${PORT} 无响应（测试 Hub 已退出？）`);
  const t = targets.find(x => x.type === 'page' && /renderer[\\/]index\.html/i.test(x.url || ''));
  if (!t) throw new Error('找不到 renderer/index.html page target');
  const cdp = await connectCDP(t.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.eval(SNAP_FN);

  const [cmd, ...args] = process.argv.slice(2);
  let out;
  if (cmd === 'snap') {
    out = await cdp.eval(`window.__gcSnap(${JSON.stringify(args[0].split(','))})`);
  } else if (cmd === 'state') {
    out = await cdp.eval(`(async () => {
      const r = await require('electron').ipcRenderer.invoke('groupchat:get-state', { meetingId: ${JSON.stringify(args[0])} });
      return { currentTurn: r && r.currentTurn, currentMode: r && r.currentMode,
        messages: (r && r.messages || []).map(m => ({ id: m.id, sid: m.sid, turnNum: m.turnNum,
          role: m.role, status: m.status, len: (m.content||'').length, head: String(m.content||'').slice(0,120) })) };
    })()`);
  } else if (cmd === 'shot') {
    await cdp.send('Page.bringToFront').catch(() => {});
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const f = path.join(ARTIFACT_DIR, args[0]);
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    out = { file: f, bytes: fs.statSync(f).size };
  } else if (cmd === 'meetings') {
    out = await cdp.eval(`(async () => (await require('electron').ipcRenderer.invoke('get-meetings')).map(m => ({ id: m.id, title: m.title, subSessions: m.subSessions, groupChat: m.groupChat })))()`);
  } else if (cmd === 'eval') {
    out = await cdp.eval(args.join(' '));
  } else {
    throw new Error(`unknown command: ${cmd}`);
  }
  console.log(JSON.stringify(out, null, 2));
  await cdp.close().catch(() => {});
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
