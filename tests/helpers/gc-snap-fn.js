// 群聊气泡结构化快照器 —— 注入到 renderer 里当 window.__gcSnap 用。
// 定位一位成员的气泡：pending 消息 id 是 `pending-<sid>`；**settle 后 id 是
// `a<turn>-<memberId>`（如 a1-m1），不含 sid** —— 只按 id 结尾匹配会漏掉所有历史消息。
// 稳妥锚点：气泡里的 [data-gc-sync-answer="<sid>"]（同步/重新提取按钮）或
// [data-gc-card-sid="<sid>"]（卡片挂载点）都带真 sid。
window.__gcSnap = function (sids) {
  const out = {};
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);
  for (const sid of sids) {
    const arts = [...document.querySelectorAll('.mr-gc-msg')].filter(a =>
      (a.getAttribute('data-gc-msg-id') || '').endsWith(sid)
      || !!a.querySelector('[data-gc-sync-answer="' + esc(sid) + '"]')
      || !!a.querySelector('[data-gc-card-sid="' + esc(sid) + '"]'));
    const el = arts[arts.length - 1] || null;
    const card = el ? el.querySelector('.turn-card') : null;
    const body = card ? card.querySelector('.turn-body') : null;
    out[sid] = {
      article: !!el,
      msgId: el ? el.getAttribute('data-gc-msg-id') : null,
      gcStatus: el ? (el.getAttribute('data-gc-status') || '') : null,
      pending: el ? el.classList.contains('pending') : null,
      hosts: el ? el.querySelectorAll('.mr-gc-card-host').length : 0,
      fallbackHosts: el ? el.querySelectorAll('.mr-gc-card-fallback').length : 0,
      cards: el ? el.querySelectorAll('.turn-card').length : 0,
      thinking: el ? el.querySelectorAll('.turn-thinking').length : 0,
      toolClusters: el ? el.querySelectorAll('.tc-cluster').length : 0,
      toolRows: el ? el.querySelectorAll('.tc-row-name').length : 0,
      codeBlocks: el ? el.querySelectorAll('.code-block-wrap').length : 0,
      codeTokens: el ? el.querySelectorAll('.code-block-wrap .token').length : 0,
      preTags: el ? el.querySelectorAll('pre').length : 0,
      metaPills: el ? el.querySelectorAll('.turn-meta-pills .pill').length : 0,
      avatar: el ? el.querySelectorAll('.mr-gc-avatar').length : 0,
      nameText: el && el.querySelector('.mr-gc-name') ? el.querySelector('.mr-gc-name').innerText : null,
      waiting: el ? el.querySelectorAll('.mr-gc-waiting').length : 0,
      placeholder: el ? el.querySelectorAll('.mr-gc-empty-placeholder, .mr-ft-thinking-placeholder').length : 0,
      cardSessionId: card ? (card.dataset.sessionId || null) : null,
      bodyLen: body ? (body.innerText || '').length : 0,
      bodyHead: body ? (body.innerText || '').slice(0, 140) : '',
      articleTextLen: el ? (el.innerText || '').length : 0,
    };
  }
  out.__global = {
    overlayCards: document.querySelectorAll('#msg-overlay .turn-card').length,
    overlayIndicators: document.querySelectorAll('#msg-overlay .streaming-indicator').length,
    sessionTurnsSize: (window._sessionTurns && window._sessionTurns.size) || 0,
    gcMessages: document.querySelectorAll('.mr-gc-msg').length,
    gcPending: document.querySelectorAll('.mr-gc-msg.pending').length,
    gcWaiting: document.querySelectorAll('.mr-gc-waiting').length,
  };
  return out;
};
true;
