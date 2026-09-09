'use strict';
/**
 * 抓一份**真实**的 Codex PTY 原始样本，给就绪检测当回归夹具。
 *
 * 为什么要真样本：合并位报的根因是「已经被清屏的启动文本仍留在 buffer 末尾，
 * 于是 Codex 永远被判未就绪」。这种问题只能拿真实字节流验证 —— 自己编一段
 * 带 \x1b[2J 的假数据，很可能和 Codex 实际写的东西不是一回事。
 *
 * 用法：node tests/capture-codex-ready-sample.js [输出文件]
 * 默认写到 tests/fixtures/codex-ready-sample.txt（原样保留控制字符）。
 */
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const OUT = process.argv[2] || path.join(__dirname, 'fixtures', 'codex-ready-sample.txt');
const RUN_ID = `codex-sample-${Date.now()}`;
const ROOT = path.join(os.tmpdir(), 'hub-sample', RUN_ID);
const DATA_DIR = path.join(ROOT, 'data');
const WORK = path.join(ROOT, 'repo');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function main() {
  fs.mkdirSync(path.join(WORK, '.git'), { recursive: true });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const hub = await launchIsolatedHub({
    dataDir: DATA_DIR, port: await freePort(), label: 'codex-sample', windowMode: 'hidden',
  });
  console.log(`[sample] 隔离 Hub PID=${hub.child.pid}`);
  let cdp = null;
  try {
    cdp = await connectFirstPage(hub, (t) => t.type === 'page' && /index\.html/.test(t.url));
    await cdp.send('Runtime.enable');
    const invoke = async (channel, args) => cdp.eval(
      `require('electron').ipcRenderer.invoke(${JSON.stringify(channel)}, ${JSON.stringify(args === undefined ? null : args)})`,
    );
    for (let i = 0; i < 60; i += 1) {
      if (await cdp.eval('!!window.WorkflowTemplates').catch(() => false)) break;
      await sleep(500);
    }
    const meeting = await invoke('create-meeting', {
      mode: 'dev', title: RUN_ID, groupChat: true, workspace: WORK,
      slots: [{ index: 0, kind: 'codex', memberId: 'm1' }],
    });
    const sid = (meeting && meeting.subSessions && meeting.subSessions[0]) || null;
    if (!sid) throw new Error('没拿到 codex 会话');
    console.log('[sample] codex sid =', sid);

    // 一直抓，直到 buffer 稳定不再增长为止 —— 那时候屏幕上就是输入框。
    let last = '';
    let stableFor = 0;
    for (let i = 0; i < 90; i += 1) {
      await sleep(1000);
      const buf = (await invoke('get-ring-buffer', sid)) || '';
      const ready = await invoke('cli-ready-status', sid);
      if (buf === last) stableFor += 1; else { stableFor = 0; last = buf; }
      if (i % 5 === 0) console.log(`[sample] t=${i}s len=${buf.length} ready=${ready} stable=${stableFor}s`);
      if (stableFor >= 6 && buf.length > 500) break;
    }
    fs.writeFileSync(OUT, last, 'utf8');
    const readyNow = await invoke('cli-ready-status', sid);
    console.log(`[sample] 已写入 ${OUT}（${last.length} 字节），此刻 cli-ready-status=${readyNow}`);
    console.log('[sample] 末尾 400 字节（转义显示）：');
    console.log(JSON.stringify(last.slice(-400)));
  } finally {
    try { if (cdp) await cdp.close(); } catch (e) {}
    try { await gracefulQuit(hub, { allowAlreadyExited: true }); } catch (e) {
      console.warn('[sample] 关闭隔离 Hub 报错：', e && e.message);
    }
  }
}

main().catch((error) => { console.error('[sample] 失败：', error); process.exit(2); });
