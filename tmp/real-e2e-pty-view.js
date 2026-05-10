'use strict';
// 切到 Claude session 的 PTY 视图，看终端实际显示
const fs = require('fs');
const path = require('path');
const http = require('http');
const { connectCDP } = require('../tests/helpers/cdp-client');

const PORT = 9224;
const CLAUDE_SID = '9c377b90-7ac5-4734-ab06-0d5e45f4089b';

function gj(u) {
  return new Promise((r, e) => http.get(u, res => {
    let d = ''; res.on('data', c => d += c);
    res.on('end', () => { try { r(JSON.parse(d)); } catch (x) { r(null); } });
  }).on('error', e));
}

(async () => {
  const list = await gj(`http://127.0.0.1:${PORT}/json/list`);
  const main = list.find(t => t.type === 'page' && (t.url || '').includes('index.html'));
  const client = await connectCDP(main.webSocketDebuggerUrl);
  await client.send('Runtime.enable');

  // 切到 Claude sub session（renderer 函数 selectSession / openSession）
  console.log('[step] try open Claude session via sidebar / direct call');
  const opened = await client.eval(`(() => {
    // 查所有 sidebar 项 + 找 sid 匹配的
    const sidebarItems = document.querySelectorAll('.session-item, [data-sid], [data-session-id]');
    const target = Array.from(sidebarItems).find(el => {
      const sid = el.dataset.sid || el.dataset.sessionId;
      return sid === '${CLAUDE_SID}';
    });
    if (target) {
      target.click();
      return { method: 'sidebar', clicked: true, ds: { ...target.dataset } };
    }
    // 兜底：直接调 selectSession
    if (typeof selectSession === 'function') {
      selectSession('${CLAUDE_SID}');
      return { method: 'selectSession-fn', called: true };
    }
    if (typeof window.selectSession === 'function') {
      window.selectSession('${CLAUDE_SID}');
      return { method: 'window.selectSession', called: true };
    }
    // 列出可能的全局函数
    const globals = Object.keys(window).filter(k => /select|open|switch.*[Ss]ession/i.test(k)).slice(0, 30);
    return { error: 'no entry found', globalFns: globals, sidebarCount: sidebarItems.length };
  })()`);
  console.log('  opened:', JSON.stringify(opened, null, 2));

  await new Promise(r => setTimeout(r, 2000));

  // 截图
  const fp = path.join(__dirname, `pty-view-${Date.now()}.png`);
  const r = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(fp, Buffer.from(r.data, 'base64'));
  console.log('shot:', fp);

  // 找 xterm DOM 拿真实 PTY 文本
  const ptyText = await client.eval(`(() => {
    const xt = document.querySelectorAll('.xterm-rows > div, .xterm-rows span');
    if (!xt || !xt.length) {
      const otherXt = document.querySelector('.xterm-screen, .xterm');
      return { hasXterm: !!otherXt, xtCount: xt ? xt.length : 0, bodyPreview: document.body.innerText.slice(0, 800) };
    }
    let txt = '';
    for (const el of xt) {
      txt += (el.innerText || el.textContent || '') + '\\n';
    }
    return { hasXterm: true, xtRowCount: xt.length, ptyText: txt.slice(0, 3000) };
  })()`);
  console.log('PTY text:');
  console.log(JSON.stringify(ptyText, null, 2));

  await client.close();
})().catch(e => { console.error(e); process.exit(1); });
