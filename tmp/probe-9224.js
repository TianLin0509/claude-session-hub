'use strict';
const http = require('http');
const { connectCDP } = require('../tests/helpers/cdp-client');

(async () => {
  const list = await new Promise((r) => {
    http.get('http://127.0.0.1:9224/json/list', (res) => {
      let buf=''; res.on('data',c=>buf+=c); res.on('end',()=>{ try{r(JSON.parse(buf))}catch{r([])} });
    }).on('error',()=>r([]));
  });
  const main = list.find(t => t.type === 'page' && t.url.includes('index.html'));
  if (!main) { console.error('no main page'); process.exit(1); }
  const client = await connectCDP(main.webSocketDebuggerUrl);

  const r = await client.eval(`(() => {
    const cards = Array.from(document.querySelectorAll('.rt-card, [class*="rt-slot-card"], .meeting-card'));
    const cardInfo = cards.map(c => {
      const kind = c.dataset && c.dataset.kind;
      const status = (c.querySelector('.rt-card-status, [class*="status"]') || {}).textContent;
      return { kind, status: (status||'').trim().slice(0, 40), classes: c.className };
    });
    const allIframes = document.querySelectorAll('iframe.rt-html-block');
    const allPreCodeHtml = document.querySelectorAll('pre code.language-html');
    const allTooLarge = document.querySelectorAll('.rt-html-too-large');
    // 看消息卡内容（不限于卡片 view）
    const allMessages = Array.from(document.querySelectorAll('[class*="message"], .rt-msg, [class*="card-content"], [class*="msg-body"]')).slice(0, 10);
    const msgPreviews = allMessages.map(m => (m.textContent || '').slice(0, 60).replace(/\\s+/g, ' '));
    // 看是否有 active 圆桌或 普通 session 列表
    const sidebarItems = Array.from(document.querySelectorAll('[class*="sidebar"] [class*="item"], [class*="session"]')).slice(0, 8);
    const sidebarPreviews = sidebarItems.map(s => (s.textContent || '').slice(0, 50).replace(/\\s+/g, ' '));
    // view mode
    const viewToggle = Array.from(document.querySelectorAll('button')).filter(b => /^(卡片|PTY|简洁|并排|Tab)$/.test((b.textContent||'').trim()));
    const activeView = viewToggle.find(b => /active|selected/.test(b.className) || b.style.backgroundColor)?.textContent;
    return {
      cardCount: cards.length,
      cardInfo,
      iframeRtHtmlBlock: allIframes.length,
      preCodeHtml: allPreCodeHtml.length,
      tooLarge: allTooLarge.length,
      msgPreviews,
      sidebarPreviews,
      viewModeButtons: viewToggle.map(b => b.textContent.trim()),
      currentURL: location.href,
      bodyTextHead: (document.body.innerText||'').slice(0, 200).replace(/\\s+/g, ' '),
    };
  })()`);
  console.log(JSON.stringify(r, null, 2));
  await client.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
