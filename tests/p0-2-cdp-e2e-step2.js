'use strict';
// CDP E2E Step 2: 真实点击「开始 AI 群聊」+ 探测 IPC 通路
// 目标：让 Hub 真实走到 createMeetingSubAdder 决策路径，看 main 进程 log

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CDP = 'http://127.0.0.1:9229';
const ARTIFACT_DIR = 'C:\\Users\\lintian\\Desktop\\claude-artifacts';

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

function newCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 1;
  const pend = new Map();
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

  console.log('=== Step A: 列出 renderer 真实自定义全局（区别 Chrome 内置） ===');
  const probe = await cdp.send('Runtime.evaluate', {
    expression: `
      JSON.stringify({
        // electron preload 常见挂载名
        candidates: ['api','electronAPI','hub','hubApi','meetings','sessions','ipc','electron']
          .map(k => ({ k, type: typeof window[k] })),
        // require 是否可用（nodeIntegration 路径）
        canRequire: typeof require !== 'undefined',
        // 检查 ipcRenderer
        ipcRendererCheck: (() => {
          try {
            if (typeof require !== 'undefined') {
              const { ipcRenderer } = require('electron');
              return { ok: true, methods: ['invoke','send','on'].filter(m => typeof ipcRenderer[m] === 'function') };
            }
          } catch (e) { return { ok: false, err: e.message }; }
          return { ok: false, err: 'no require' };
        })(),
        // 找按钮 + 文字
        chatBtn: (() => {
          const all = [...document.querySelectorAll('button, [role=button], a')];
          const found = all.filter(el => /开始\\s*AI\\s*群聊|开始群聊/.test(el.textContent || ''));
          return found.map(el => ({ tag: el.tagName, text: (el.textContent||'').trim().slice(0,30), id: el.id, cls: el.className.slice(0,60) }));
        })(),
      })
    `,
    returnByValue: true,
  });
  console.log(probe.result.value);

  console.log('\n=== Step B: 真实点击「开始 AI 群聊」按钮 ===');
  const clickResult = await cdp.send('Runtime.evaluate', {
    expression: `
      (() => {
        const btns = [...document.querySelectorAll('button, [role=button], a, div')];
        const btn = btns.find(el => /^\\s*开始\\s*AI\\s*群聊/.test(el.textContent || ''));
        if (!btn) return { clicked: false, reason: 'no button found' };
        btn.click();
        return { clicked: true, tag: btn.tagName, text: btn.textContent.trim().slice(0, 40) };
      })()
    `,
    returnByValue: true,
  });
  console.log(clickResult.result.value);

  // 等 modal 渲染
  await new Promise(r => setTimeout(r, 600));

  console.log('\n=== Step C: 截屏看 modal 是否打开 ===');
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const shotPath = path.join(ARTIFACT_DIR, 'p0-2-hub-after-click.png');
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  console.log(`  screenshot: ${shotPath} (${(fs.statSync(shotPath).size / 1024).toFixed(1)} KB)`);

  console.log('\n=== Step D: 探测打开后的 DOM 变化 + IPC bound ===');
  const post = await cdp.send('Runtime.evaluate', {
    expression: `
      JSON.stringify({
        modalOpen: !!document.querySelector('.modal, [class*=modal], dialog[open]'),
        dialogCount: document.querySelectorAll('dialog').length,
        bodyTextSnippet: document.body.innerText.slice(0, 800).replace(/\\s+/g, ' '),
      })
    `,
    returnByValue: true,
  });
  console.log(post.result.value);

  cdp.close();
  console.log('\n=== Step 2 done ===');
})().catch((e) => {
  console.error('FAIL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
