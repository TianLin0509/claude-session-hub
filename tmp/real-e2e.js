'use strict';
// 真 E2E：模拟用户在 Hub 圆桌发 prompt → Claude 真回复 HTML → 验证 iframe 渲染
// 不 commit，跑完保留新 Hub 让用户切过去验证

const fs = require('fs');
const path = require('path');
const http = require('http');
const { connectCDP } = require('../tests/helpers/cdp-client');

const PORT = 9224;

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
  console.log('[step 0] discover main page target');
  const list = await gj(`http://127.0.0.1:${PORT}/json/list`);
  if (!list) throw new Error('CDP /json/list failed');
  const main = list.find(t => t.type === 'page' && (t.url || '').includes('index.html'));
  if (!main) {
    console.log('available targets:', JSON.stringify(list.map(t => ({ type: t.type, url: t.url })), null, 2));
    throw new Error('no main page target');
  }
  console.log('  main page:', main.url);
  const client = await connectCDP(main.webSocketDebuggerUrl);
  await client.send('Page.enable');
  await client.send('Runtime.enable');

  console.log('[step 1] wait renderer ready');
  let rendererReady = false;
  for (let i = 0; i < 60; i++) {
    const ok = await client.eval(`(() => ({ hasFn: typeof window.openMeetingCreateModal === 'function', hasBtn: !!document.getElementById('btn-roundtable') }))()`).catch(() => ({ hasFn: false, hasBtn: false }));
    if (ok.hasFn && ok.hasBtn) { rendererReady = true; break; }
    await new Promise(r => setTimeout(r, 500));
  }
  if (!rendererReady) throw new Error('renderer not ready in 30s');
  console.log('  renderer ready');

  await shot(client, '01-loaded');

  console.log('[step 2] open create-meeting modal');
  await client.eval(`document.getElementById('btn-roundtable').click()`);
  await new Promise(r => setTimeout(r, 2000));
  await shot(client, '02-modal-open');

  console.log('[step 3] inspect default slots');
  const slotState = await client.eval(`(() => {
    const mcm = document.getElementById('meeting-create-modal');
    if (!mcm) return null;
    return Array.from(mcm.querySelectorAll('.mcm-slot')).map((s, i) => ({
      idx: i,
      kind: (s.querySelector('.mcm-ai-select') || {}).value || null,
      hasRemove: !!s.querySelector('.mcm-remove, [class*="remove"], button[title*="删除"]'),
      slotHtml: s.outerHTML.slice(0, 300),
    }));
  })()`);
  console.log('  slots:', JSON.stringify(slotState?.map(s => ({ idx: s.idx, kind: s.kind, hasRemove: s.hasRemove })), null, 2));

  console.log('[step 4] reduce to 1 slot (claude only)');
  // 倒序删 slot 2 / slot 1，保留 slot 0 = claude
  const removeResult = await client.eval(`(() => {
    const mcm = document.getElementById('meeting-create-modal');
    const slots = Array.from(mcm.querySelectorAll('.mcm-slot'));
    let removed = 0;
    for (let i = slots.length - 1; i >= 1; i--) {
      const removeBtn = slots[i].querySelector('.mcm-remove, [class*="remove"], button[title*="删除"]');
      if (removeBtn) { removeBtn.click(); removed++; }
    }
    return { removed, remaining: mcm.querySelectorAll('.mcm-slot').length };
  })()`);
  console.log('  remove result:', JSON.stringify(removeResult));
  await new Promise(r => setTimeout(r, 1000));

  // 如果删不掉 slot，保留 3 槽（gemini/codex 不缺 API key 也行——但用户铁律：本 dataDir 干净，本测试只看 claude 卡片）
  const finalSlots = await client.eval(`(() => {
    const mcm = document.getElementById('meeting-create-modal');
    return Array.from(mcm.querySelectorAll('.mcm-slot')).map(s => (s.querySelector('.mcm-ai-select') || {}).value || null);
  })()`);
  console.log('  final slots before submit:', JSON.stringify(finalSlots));

  console.log('[step 5] submit create');
  const submitResult = await client.eval(`(() => {
    const btn = document.querySelector('#meeting-create-modal .mcm-create');
    if (!btn) {
      const all = Array.from(document.querySelectorAll('#meeting-create-modal button')).map(b => ({ cls: b.className, txt: (b.textContent || '').trim().slice(0, 30) }));
      return { error: 'no .mcm-create btn', all };
    }
    btn.click();
    return { clicked: true };
  })()`);
  console.log('  submit:', JSON.stringify(submitResult));
  if (submitResult.error) throw new Error('submit failed: ' + JSON.stringify(submitResult));
  await new Promise(r => setTimeout(r, 2000));
  await shot(client, '03-after-submit');

  console.log('[step 6] wait meeting created (up to 30s)');
  let meeting = null;
  for (let i = 0; i < 60; i++) {
    const r = await client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const ms = await ipcRenderer.invoke('get-meetings');
      return (ms && ms.length) ? ms[ms.length - 1] : null;
    })()`).catch(() => null);
    if (r && Array.isArray(r.subSessions) && r.subSessions.length > 0) {
      meeting = r;
      console.log(`  meeting created @ ${(i * 0.5).toFixed(1)}s, subs=${r.subSessions.length}, mid=${r.id}`);
      break;
    }
    if (i % 10 === 0) console.log(`  +${(i * 0.5).toFixed(0)}s no meeting yet`);
    await new Promise(r => setTimeout(r, 500));
  }
  if (!meeting) {
    const dbg = await client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const ms = await ipcRenderer.invoke('get-meetings');
      const mcm = document.getElementById('meeting-create-modal');
      return { meetings: ms, modalOpen: !!mcm, modalErr: mcm?.querySelector('.mcm-error')?.textContent };
    })()`);
    console.log('  dbg:', JSON.stringify(dbg).slice(0, 500));
    throw new Error('meeting not created');
  }

  console.log('[step 7] wait Claude session cli-ready (up to 60s)');
  let claudeReady = false;
  let claudeSid = null;
  const startReady = Date.now();
  for (let iter = 0; iter < 120; iter++) {
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
    })()`, { awaitPromise: true }).catch(() => null);
    if (r) {
      // 找 claude 的 sid
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
      if (iter % 10 === 0) {
        console.log(`  +${((Date.now() - startReady) / 1000).toFixed(0)}s ready=${JSON.stringify(r.ready)}, kinds=${JSON.stringify(r.kinds)}`);
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  if (!claudeReady) {
    const dbg = await client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const ms = await ipcRenderer.invoke('get-meetings');
      const m = ms[ms.length - 1];
      const out = {};
      for (const sid of (m?.subSessions || [])) {
        out[sid] = await ipcRenderer.invoke('cli-ready-status', sid);
      }
      return out;
    })()`).catch(() => null);
    console.log('  cli-ready debug:', JSON.stringify(dbg));
    throw new Error('claude not ready in 60s');
  }
  await shot(client, '04-claude-ready');

  console.log('[step 8] verify roundtable input box ready');
  const inputState = await client.eval(`(() => {
    const ib = document.getElementById('mr-input-box');
    return ib ? {
      contenteditable: ib.contentEditable,
      placeholder: ib.dataset.placeholder,
      visible: ib.getBoundingClientRect().width > 0,
    } : null;
  })()`);
  console.log('  input:', JSON.stringify(inputState));
  if (!inputState || !inputState.visible) throw new Error('mr-input-box not visible');

  console.log('[step 9] inspect view mode (card vs PTY)');
  const viewState = await client.eval(`(() => {
    // 视图切换按钮可能在 .mr-view-toggle / .mr-view-btn / 工具栏内
    const btns = Array.from(document.querySelectorAll('button, .mr-view-toggle button, [class*="view-toggle"], [class*="view-btn"]'));
    const labels = btns.map(b => ({ cls: b.className, txt: (b.textContent || '').trim().slice(0, 20), active: b.classList.contains('active') || b.classList.contains('mr-view-active') })).filter(b => b.txt && b.txt.length < 20);
    // 卡片可见情况
    const cards = document.querySelectorAll('.mr-ft[data-ft-sid]');
    return { btnsHint: labels.slice(0, 30), cardCount: cards.length };
  })()`);
  console.log('  view state:', JSON.stringify(viewState, null, 2));

  console.log('[step 10] inject prompt + Enter to send');
  const prompt = '请用 HTML 给我画一个 4x4 的"AI CLI 工具对比"决策矩阵：横轴=上下文窗口/联网/费用/速度,纵轴=Claude/Gemini/Codex/DeepSeek。注意:必须用 ```html ... ``` 三反引号包起来,这样 Hub 圆桌可以渲染.';

  const sentResult = await client.eval(`(async () => {
    const inputBox = document.getElementById('mr-input-box');
    if (!inputBox) return { error: 'input not found' };
    inputBox.focus();
    // contenteditable 用 textContent 设值（doSend 用 innerText.trim() 取值，等价）
    inputBox.textContent = ${JSON.stringify(prompt)};
    inputBox.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    // 模拟 Enter 提交（meeting-room.js 4228: e.key === 'Enter' && !e.shiftKey → doSend）
    const evt = new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true,
    });
    inputBox.dispatchEvent(evt);
    return { sent: true, valueAfter: inputBox.innerText.slice(0, 50), valueLen: inputBox.innerText.length };
  })()`);
  console.log('  send:', JSON.stringify(sentResult));
  if (sentResult.error) throw new Error('send failed: ' + JSON.stringify(sentResult));

  // input 应该被 doSend 清空（meeting-room.js 3846: inputBox.textContent = ''）
  await new Promise(r => setTimeout(r, 1500));
  const inputAfter = await client.eval(`document.getElementById('mr-input-box')?.innerText || ''`);
  console.log('  input after send (should be empty):', JSON.stringify(inputAfter));

  await shot(client, '05-prompt-sent');

  console.log('[step 11] wait Claude streaming response (up to 240s)');
  let claudeResponded = false;
  let firstHitState = null;
  for (let iter = 0; iter < 480; iter++) {  // 240s
    const r = await client.eval(`(() => {
      const iframes = document.querySelectorAll('iframe.rt-html-block');
      const preCodeHtml = document.querySelectorAll('pre code.language-html');
      const tooLarge = document.querySelectorAll('.rt-html-too-large');
      const allMsgs = document.querySelectorAll('.mr-ft-msg, .rt-msg, [class*="message"], [class*="bubble"]');
      // 找 claude 卡片或消息内容
      const claudeCards = document.querySelectorAll('.mr-ft[data-ft-kind="claude"]');
      let claudeContentLen = 0;
      let claudeContentPreview = '';
      let hasHtmlMarker = false;
      for (const c of claudeCards) {
        const t = c.textContent || '';
        claudeContentLen += t.length;
        if (!claudeContentPreview && t.length > 50) claudeContentPreview = t.slice(0, 200);
        if (/\x60\x60\x60html|<!DOCTYPE|<html|<table/i.test(t)) hasHtmlMarker = true;
      }
      return {
        iframeCount: iframes.length,
        preCodeHtmlCount: preCodeHtml.length,
        tooLargeCount: tooLarge.length,
        msgCount: allMsgs.length,
        claudeCardCount: claudeCards.length,
        claudeContentLen,
        claudeContentPreview,
        hasHtmlMarker,
      };
    })()`);
    // 触发条件：有 iframe / 或 pre code.language-html / 或卡片有 HTML 关键词
    if (r.iframeCount > 0 || r.preCodeHtmlCount > 0 || (r.claudeContentLen > 200 && r.hasHtmlMarker)) {
      claudeResponded = true;
      firstHitState = r;
      console.log(`  ✓ response detected @ ${(iter * 0.5).toFixed(1)}s:`, JSON.stringify(r));
      // 多等 8s 让流式完成 + iframe 渲染
      await new Promise(r => setTimeout(r, 8000));
      break;
    }
    if (iter % 20 === 0) console.log(`  +${(iter * 0.5).toFixed(0)}s claudeLen=${r.claudeContentLen} cards=${r.claudeCardCount} iframe=${r.iframeCount} preCode=${r.preCodeHtmlCount}`);
    await new Promise(r => setTimeout(r, 500));
  }

  await shot(client, '06-after-response');

  console.log('[step 12] final inspect');
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
        srcdocPreview: (iframes[0].srcdoc || '').slice(0, 200),
      };
    }
    let preCode0Preview = null;
    if (preCodeHtml[0]) {
      preCode0Preview = (preCodeHtml[0].textContent || '').slice(0, 200);
    }
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
      claudeTextHead: claudeText.slice(0, 300),
      claudeTextTail: claudeText.slice(-300),
      iframe0,
      preCode0Preview,
    };
  })()`);
  console.log('FINAL STATE:', JSON.stringify(final, null, 2));

  await shot(client, '07-final');

  console.log('\n========== VERDICT ==========');
  if (final.iframeCount > 0) {
    console.log('PASS: Claude HTML 块渲染为 iframe.rt-html-block (count=' + final.iframeCount + ')');
    if (final.iframe0 && final.iframe0.sandbox) {
      console.log('  iframe sandbox attr: ' + final.iframe0.sandbox);
      console.log('  iframe srcdoc length: ' + final.iframe0.srcdocLen);
    }
  } else if (final.preCodeHtmlCount > 0) {
    console.log('FAIL: 找到 pre code.language-html (count=' + final.preCodeHtmlCount + ') 但未转 iframe');
    console.log('  preCode preview: ' + final.preCode0Preview);
  } else if (claudeResponded) {
    console.log('INCONCLUSIVE: Claude 回复了但既无 iframe 也无 pre code.language-html');
    console.log('  hasHtmlMarker=' + (firstHitState?.hasHtmlMarker));
    console.log('  claudeText head: ' + final.claudeTextHead);
  } else {
    console.log('FAIL: Claude 240s 内没回复');
    console.log('  claudeTextLen: ' + final.claudeTextLen);
  }

  await client.close();
})().catch(e => {
  console.error('FATAL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
