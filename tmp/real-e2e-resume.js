'use strict';
// 续跑：Hub 已起、meeting 已建，等 claude ready → 发 prompt → 验 iframe
const fs = require('fs');
const path = require('path');
const http = require('http');
const { connectCDP } = require('../tests/helpers/cdp-client');

const PORT = 9224;
const CLAUDE_SID_HINT = '9c377b90-7ac5-4734-ab06-0d5e45f4089b'; // 上次启动的 claude sid

function gj(u) {
  return new Promise((r, e) => http.get(u, res => {
    let d = ''; res.on('data', c => d += c);
    res.on('end', () => { try { r(JSON.parse(d)); } catch (x) { r(null); } });
  }).on('error', e));
}

async function shot(client, label) {
  const fp = path.join(__dirname, `real-e2e-${label}-${Date.now()}.png`);
  try {
    const r = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(fp, Buffer.from(r.data, 'base64'));
    console.log('  [shot]', fp);
    return fp;
  } catch (e) {
    console.log('  [shot fail]', e.message);
    return null;
  }
}

(async () => {
  const list = await gj(`http://127.0.0.1:${PORT}/json/list`);
  const main = list.find(t => t.type === 'page' && (t.url || '').includes('index.html'));
  const client = await connectCDP(main.webSocketDebuggerUrl);
  await client.send('Page.enable');
  await client.send('Runtime.enable');

  console.log('[step] check current meeting state');
  const cur = await client.eval(`(async () => {
    const { ipcRenderer } = require('electron');
    const ms = await ipcRenderer.invoke('get-meetings');
    const m = ms[ms.length - 1];
    if (!m) return null;
    const out = {};
    for (const sid of m.subSessions) {
      out[sid] = await ipcRenderer.invoke('cli-ready-status', sid);
    }
    const subKinds = {};
    for (const sid of m.subSessions) {
      const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      if (s) subKinds[sid] = s.kind;
    }
    return { mid: m.id, subs: m.subSessions, ready: out, kinds: subKinds, activeMid: typeof activeMeetingId !== 'undefined' ? activeMeetingId : null };
  })()`);
  console.log('  current:', JSON.stringify(cur, null, 2));

  console.log('[step] wait Claude ready (up to 240s)');
  let claudeReady = false;
  let claudeSid = null;
  const startReady = Date.now();
  for (let iter = 0; iter < 480; iter++) {
    const r = await client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const ms = await ipcRenderer.invoke('get-meetings');
      const m = ms[ms.length - 1];
      if (!m) return null;
      const out = {};
      for (const sid of m.subSessions) {
        out[sid] = await ipcRenderer.invoke('cli-ready-status', sid);
      }
      const subKinds = {};
      for (const sid of m.subSessions) {
        const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
        if (s) subKinds[sid] = s.kind;
      }
      return { ready: out, kinds: subKinds, subs: m.subSessions };
    })()`).catch(() => null);
    if (r) {
      for (const sid of (r.subs || [])) {
        if (r.kinds[sid] === 'claude' && r.ready[sid]) {
          claudeReady = true;
          claudeSid = sid;
          break;
        }
      }
      if (claudeReady) {
        console.log(`  claude ready @ ${((Date.now() - startReady) / 1000).toFixed(1)}s, sid=${claudeSid}`);
        break;
      }
      if (iter % 10 === 0) console.log(`  +${((Date.now() - startReady) / 1000).toFixed(0)}s ready=${JSON.stringify(r.ready)}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  if (!claudeReady) {
    console.log('  CLAUDE NOT READY in 240s. dumping diagnostics...');
    const dbg = await client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const ms = await ipcRenderer.invoke('get-meetings');
      const m = ms[ms.length - 1];
      const out = {};
      for (const sid of (m?.subSessions || [])) {
        out[sid] = await ipcRenderer.invoke('cli-ready-status', sid);
      }
      // 查 PTY 输出快照（如果 renderer 有 cache）
      const cards = Array.from(document.querySelectorAll('.mr-ft[data-ft-sid]')).map(c => ({
        sid: c.getAttribute('data-ft-sid'),
        kind: c.getAttribute('data-ft-kind'),
        statusText: c.querySelector('.mr-ft-status')?.textContent,
        contentPreview: (c.textContent || '').slice(0, 300),
      }));
      return { ready: out, cards };
    })()`);
    console.log('  diag:', JSON.stringify(dbg, null, 2));
    await shot(client, 'diag-claude-stuck');
    process.exit(2);
  }
  await shot(client, 'A1-claude-ready');

  console.log('[step] make sure meeting view is active');
  await client.eval(`(() => {
    const m = document.querySelector('.meeting-tab.active') ? null : document.querySelector('.meeting-tab');
    if (m) m.click();
    return null;
  })()`);
  await new Promise(r => setTimeout(r, 1000));

  console.log('[step] verify input box visible');
  const inputState = await client.eval(`(() => {
    const ib = document.getElementById('mr-input-box');
    if (!ib) return null;
    const rect = ib.getBoundingClientRect();
    return { visible: rect.width > 0 && rect.height > 0, w: rect.width, h: rect.height, contenteditable: ib.contentEditable };
  })()`);
  console.log('  input:', JSON.stringify(inputState));

  console.log('[step] inject prompt + Enter');
  const prompt = '请用 HTML 给我画一个 4x4 的 AI CLI 工具对比表格,横轴是上下文窗口/联网/费用/速度,纵轴是 Claude/Gemini/Codex/DeepSeek。重要:必须用三反引号围栏 ```html ... ``` 把代码包起来,不然 Hub 圆桌的 iframe 渲染识别不到。';
  const sentResult = await client.eval(`(async () => {
    const inputBox = document.getElementById('mr-input-box');
    if (!inputBox) return { error: 'input not found' };
    inputBox.focus();
    inputBox.textContent = ${JSON.stringify(prompt)};
    inputBox.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    const evt = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
    inputBox.dispatchEvent(evt);
    return { sent: true, valueLen: inputBox.innerText.length };
  })()`);
  console.log('  send result:', JSON.stringify(sentResult));

  await new Promise(r => setTimeout(r, 1500));
  const inputAfter = await client.eval(`document.getElementById('mr-input-box')?.innerText || ''`);
  console.log('  input after send (should be empty):', JSON.stringify(inputAfter.slice(0, 50)));
  await shot(client, 'A2-prompt-sent');

  console.log('[step] wait Claude streaming response (up to 300s)');
  let claudeResponded = false;
  let firstHit = null;
  for (let iter = 0; iter < 600; iter++) {
    const r = await client.eval(`(() => {
      const iframes = document.querySelectorAll('iframe.rt-html-block');
      const preCodeHtml = document.querySelectorAll('pre code.language-html');
      const tooLarge = document.querySelectorAll('.rt-html-too-large');
      const claudeCards = document.querySelectorAll('.mr-ft[data-ft-kind="claude"]');
      let claudeText = '';
      let hasHtmlMarker = false;
      for (const c of claudeCards) {
        const t = c.textContent || '';
        if (t.length > claudeText.length) claudeText = t;
        if (/\\x60\\x60\\x60html|<!DOCTYPE|<html|<table/i.test(t)) hasHtmlMarker = true;
      }
      return {
        iframeCount: iframes.length,
        preCodeHtmlCount: preCodeHtml.length,
        tooLargeCount: tooLarge.length,
        claudeCardCount: claudeCards.length,
        claudeTextLen: claudeText.length,
        hasHtmlMarker,
        claudeTextHead: claudeText.slice(0, 200),
      };
    })()`);
    if (r.iframeCount > 0 || r.preCodeHtmlCount > 0 || (r.claudeTextLen > 200 && r.hasHtmlMarker)) {
      claudeResponded = true;
      firstHit = r;
      console.log(`  ✓ response detected @ ${(iter * 0.5).toFixed(1)}s:`, JSON.stringify(r));
      // 多等 8s 让流式完成
      await new Promise(r => setTimeout(r, 8000));
      break;
    }
    if (iter % 20 === 0) console.log(`  +${(iter * 0.5).toFixed(0)}s claudeLen=${r.claudeTextLen} cards=${r.claudeCardCount} iframe=${r.iframeCount} preCode=${r.preCodeHtmlCount} marker=${r.hasHtmlMarker}`);
    await new Promise(r => setTimeout(r, 500));
  }

  await shot(client, 'A3-after-response');

  console.log('[step] final inspect');
  const final = await client.eval(`(() => {
    const iframes = document.querySelectorAll('iframe.rt-html-block');
    const preCodeHtml = document.querySelectorAll('pre code.language-html');
    const tooLarge = document.querySelectorAll('.rt-html-too-large');
    const claudeCards = document.querySelectorAll('.mr-ft[data-ft-kind="claude"]');

    let iframe0 = null;
    if (iframes[0]) {
      iframe0 = {
        sandbox: iframes[0].getAttribute('sandbox'),
        clientHeight: iframes[0].clientHeight,
        clientWidth: iframes[0].clientWidth,
        srcdocLen: (iframes[0].srcdoc || '').length,
        srcdocPreview: (iframes[0].srcdoc || '').slice(0, 250),
      };
    }
    let preCode0Preview = null;
    if (preCodeHtml[0]) preCode0Preview = (preCodeHtml[0].textContent || '').slice(0, 250);

    let claudeText = '';
    for (const c of claudeCards) {
      const t = c.textContent || '';
      if (t.length > claudeText.length) claudeText = t;
    }
    return {
      iframeCount: iframes.length,
      preCodeHtmlCount: preCodeHtml.length,
      tooLargeCount: tooLarge.length,
      claudeCardCount: claudeCards.length,
      claudeTextLen: claudeText.length,
      claudeTextHead: claudeText.slice(0, 400),
      claudeTextTail: claudeText.slice(-400),
      iframe0,
      preCode0Preview,
    };
  })()`);
  console.log('FINAL STATE:', JSON.stringify(final, null, 2));

  await shot(client, 'A4-final');

  console.log('\n========== VERDICT ==========');
  if (final.iframeCount > 0) {
    console.log('PASS: Claude HTML 块渲染为 iframe.rt-html-block (count=' + final.iframeCount + ')');
    if (final.iframe0) {
      console.log('  sandbox: ' + final.iframe0.sandbox);
      console.log('  size: ' + final.iframe0.clientWidth + 'x' + final.iframe0.clientHeight);
      console.log('  srcdocLen: ' + final.iframe0.srcdocLen);
    }
  } else if (final.preCodeHtmlCount > 0) {
    console.log('FAIL: 找到 pre code.language-html (count=' + final.preCodeHtmlCount + ') 但未转 iframe');
    console.log('  preCode preview: ' + final.preCode0Preview);
  } else if (claudeResponded) {
    console.log('INCONCLUSIVE: Claude 回复了但既无 iframe 也无 pre code.language-html');
  } else {
    console.log('FAIL: Claude 300s 内没回复');
  }

  await client.close();
})().catch(e => { console.error('FATAL:', e.message); console.error(e.stack); process.exit(1); });
