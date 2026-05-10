'use strict';
// 切回圆桌视图 → 发 prompt → 等 Claude HTML 回复 → 验 iframe
const fs = require('fs');
const path = require('path');
const http = require('http');
const { connectCDP } = require('../tests/helpers/cdp-client');

const PORT = 9224;
const MEETING_ID = 'd9d44843-8840-46a4-ace6-c94742597196';
const CLAUDE_SID = '9c377b90-7ac5-4734-ab06-0d5e45f4089b';

function gj(u) {
  return new Promise((r, e) => http.get(u, res => {
    let d = ''; res.on('data', c => d += c);
    res.on('end', () => { try { r(JSON.parse(d)); } catch (x) { r(null); } });
  }).on('error', e));
}

async function shot(client, label) {
  const fp = path.join(__dirname, `final-${label}-${Date.now()}.png`);
  const r = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(fp, Buffer.from(r.data, 'base64'));
  console.log('  [shot]', fp);
  return fp;
}

(async () => {
  const list = await gj(`http://127.0.0.1:${PORT}/json/list`);
  const main = list.find(t => t.type === 'page' && (t.url || '').includes('index.html'));
  const client = await connectCDP(main.webSocketDebuggerUrl);
  await client.send('Page.enable');
  await client.send('Runtime.enable');

  console.log('[step] switch back to roundtable view by clicking meeting tab');
  await client.eval(`(() => {
    const tabs = document.querySelectorAll('.meeting-tab, [data-meeting-id], [class*="meeting-tab"]');
    for (const t of tabs) {
      const mid = t.dataset.meetingId || t.dataset.mid;
      if (mid === '${MEETING_ID}') { t.click(); return 'clicked meeting tab'; }
    }
    // 兜底：调全局函数
    if (typeof openMeeting === 'function') { openMeeting('${MEETING_ID}'); return 'openMeeting fn'; }
    if (typeof window.selectMeeting === 'function') { window.selectMeeting('${MEETING_ID}'); return 'selectMeeting'; }
    if (typeof activateMeeting === 'function') { activateMeeting('${MEETING_ID}'); return 'activateMeeting'; }
    // 列出可能的全局函数
    const fns = Object.keys(window).filter(k => /[Mm]eeting/i.test(k) && typeof window[k] === 'function').slice(0, 30);
    return { error: 'no meeting tab', fns };
  })()`);
  await new Promise(r => setTimeout(r, 2500));
  await shot(client, 'B1-back-to-rt');

  console.log('[step] verify input box ready');
  const inputState = await client.eval(`(() => {
    const ib = document.getElementById('mr-input-box');
    if (!ib) return null;
    const rect = ib.getBoundingClientRect();
    return { visible: rect.width > 0 && rect.height > 0, w: Math.round(rect.width), h: Math.round(rect.height) };
  })()`);
  console.log('  input:', JSON.stringify(inputState));
  if (!inputState || !inputState.visible) {
    console.log('  ! input not visible, dump body');
    const dump = await client.eval(`document.body.innerHTML.slice(0, 2000)`);
    console.log(dump);
    throw new Error('input not visible after switching back');
  }

  console.log('[step] make sure send target = claude (Pikachu) only — avoid 3-way fanout');
  // 把 sendTarget 改成只 @pikachu
  await client.eval(`(() => {
    const sel = document.getElementById('mr-input-target');
    if (sel) {
      // try set to claude sid or to pikachu slot
      for (const opt of sel.options) {
        if (/claude|pikachu|皮卡丘/i.test(opt.text) || opt.value === '${CLAUDE_SID}') {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return { setTo: opt.value, label: opt.text };
        }
      }
    }
    return { noSelector: true };
  })()`);

  console.log('[step] inject prompt + Enter');
  // 用 @pikachu 显式定向
  const prompt = '@pikachu 请生成一个简单的 HTML 表格用三反引号围栏 ```html ... ``` 包起来,内容是 4x4 的 AI CLI 工具对比(列:上下文窗口/联网/费用/速度,行:Claude/Gemini/Codex/DeepSeek)。表格用 <table> + 内联 CSS,不要外部 CSS/JS。直接给最终代码块即可不用解释。';
  const sentResult = await client.eval(`(async () => {
    const inputBox = document.getElementById('mr-input-box');
    if (!inputBox) return { error: 'input not found' };
    inputBox.focus();
    inputBox.textContent = ${JSON.stringify(prompt)};
    inputBox.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 500));
    const evt = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
    inputBox.dispatchEvent(evt);
    return { sent: true, valueLen: inputBox.innerText.length };
  })()`);
  console.log('  send:', JSON.stringify(sentResult));
  await new Promise(r => setTimeout(r, 1500));

  const inputAfter = await client.eval(`document.getElementById('mr-input-box')?.innerText || ''`);
  console.log('  input after send (should be empty):', JSON.stringify(inputAfter.slice(0, 80)));
  await shot(client, 'B2-prompt-sent');

  console.log('[step] wait Claude streaming response (up to 240s)');
  let claudeResponded = false;
  let firstHit = null;
  for (let iter = 0; iter < 480; iter++) {
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
      };
    })()`);
    if (r.iframeCount > 0 || r.preCodeHtmlCount > 0 || (r.claudeTextLen > 200 && r.hasHtmlMarker)) {
      claudeResponded = true;
      firstHit = r;
      console.log(`  ✓ response detected @ ${(iter * 0.5).toFixed(1)}s:`, JSON.stringify(r));
      // 多等 10s 让流式完成 + iframe 渲染
      await new Promise(r => setTimeout(r, 10000));
      break;
    }
    if (iter % 20 === 0) console.log(`  +${(iter * 0.5).toFixed(0)}s claudeLen=${r.claudeTextLen} cards=${r.claudeCardCount} iframe=${r.iframeCount} preCode=${r.preCodeHtmlCount} marker=${r.hasHtmlMarker}`);
    await new Promise(r => setTimeout(r, 500));
  }

  await shot(client, 'B3-after-response');

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
        srcdocPreview: (iframes[0].srcdoc || '').slice(0, 300),
      };
    }
    let preCode0Preview = null;
    if (preCodeHtml[0]) preCode0Preview = (preCodeHtml[0].textContent || '').slice(0, 300);

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
      claudeTextHead: claudeText.slice(0, 500),
      claudeTextTail: claudeText.slice(-500),
      iframe0,
      preCode0Preview,
    };
  })()`);
  console.log('FINAL STATE:', JSON.stringify(final, null, 2));

  await shot(client, 'B4-final');

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
    console.log('FAIL: Claude 240s 内没回复');
  }

  await client.close();
})().catch(e => { console.error(e); console.error(e.stack); process.exit(1); });
