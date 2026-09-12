'use strict';
const { getSessionRuntimeTruth, runtimeLabel } = require('../core/session-runtime-truth');
const { effortLabel, speedLabel } = require('./ui-labels');
const { isBlockingModalOpen } = require('./modal-layer-guard');

function excerpt(value, limit = 340) {
  const text = String(value || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length > limit ? chars.slice(0, limit).join('') + '…' : text;
}
function hoverSummary(session = {}) {
  const truth = getSessionRuntimeTruth(session, { now: Date.now() });
  return {
    title: session.title || '未命名会话',
    project: session.cwd || '未提供工作目录',
    excerpt: excerpt(session.replyReadyText || session.lastOutputPreview || session.waitingText) || '暂无摘要，打开会话查看原始消息。',
    status: ['inferred', 'none', 'fallback'].includes(truth.confidence) ? '运行状态未确认' : runtimeLabel(truth.state),
    model: session.currentModel?.displayName || session.currentModel?.id || '未确认',
    context: typeof session.contextPct === 'number' && Number.isFinite(session.contextPct) ? `${session.contextPct}%` : '未知',
    effort: effortLabel(session.effort), speed: speedLabel(session.codexSpeedTier || (session.fastMode === true ? 'fast' : session.fastMode === false ? 'standard' : null)),
  };
}
function attachSessionHoverCard({ document: doc, root, getSession, getMeeting, selectSession, selectMeeting }) {
  let card = null, anchor = null, timer = null, pinnedId = null, restoringFocus = false;
  const win = doc.defaultView;
  function close() {
    clearTimeout(timer);
    if (anchor?.removeAttribute) anchor.removeAttribute('aria-describedby');
    card?.remove(); card = null; anchor = null; pinnedId = null;
  }
  function scheduleClose() { clearTimeout(timer); timer = setTimeout(close, 180); }
  function place() {
    if (!card || !anchor?.isConnected) { close(); return; }
    const a = anchor.getBoundingClientRect(), r = card.getBoundingClientRect();
    const width = win.innerWidth, height = win.innerHeight;
    const x = a.right + 10 + r.width <= width - 12 ? a.right + 10 : Math.max(12, a.left - r.width - 10);
    card.style.left = Math.max(12, Math.min(x, width - r.width - 12)) + 'px';
    card.style.top = Math.max(12, Math.min(a.top - 8, height - r.height - 12)) + 'px';
  }
  function show(row) {
    if (!row?.isConnected || isBlockingModalOpen(doc)) return;
    const id = row.dataset.sessionId || row.dataset.meetingId;
    const meeting = !row.dataset.sessionId ? getMeeting?.(id) : null;
    const session = getSession(id);
    if (!session && !meeting) return;
    close(); anchor = row; pinnedId = id;
    const data = hoverSummary(session || { title: meeting.title, cwd: meeting.cwd, lastOutputPreview: meeting.lastOutputPreview });
    if (meeting) { data.status = meeting.status === 'dormant' ? '群聊休眠中' : '群聊 · ' + (meeting.subSessions?.length || 0) + ' 位成员'; data.model = '群聊成员各自配置'; }
    const node = (tag, cls, value) => { const e = doc.createElement(tag); e.className = cls; if (value != null) e.textContent = value; return e; };
    card = node('section', 'hub-session-peek'); card.id = 'hub-session-peek';
    card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', '会话摘要');
    const heading = node('h3', '', data.title), project = node('div', 'hub-peek-project', data.project);
    const status = node('div', 'hub-peek-status', data.status);
    const text = node('p', 'hub-peek-excerpt', data.excerpt);
    const grid = node('dl', 'hub-peek-meta');
    for (const [name, value] of [['模型',data.model],['上下文已用',data.context],['推理',data.effort],['速度',data.speed]]) {
      const entry = node('div', ''); entry.append(node('dt','',name), node('dd','',value)); grid.append(entry);
    }
    const footer = node('footer', 'hub-peek-footer'), label = node('span','', '当前会话信息');
    const open = node('button','hub-button hub-button-quiet', '打开会话 →'); open.type = 'button';
    open.addEventListener('click', () => { close(); if (meeting) selectMeeting?.(id); else selectSession?.(id); });
    footer.append(label,open); card.append(heading,project,status,text,grid,footer);
    card.addEventListener('pointerenter', () => clearTimeout(timer)); card.addEventListener('pointerleave', scheduleClose);
    card.addEventListener('focusin', () => clearTimeout(timer));
    card.addEventListener('focusout', e => { if (!card?.contains(e.relatedTarget)) scheduleClose(); });
    doc.body.appendChild(card); anchor.setAttribute('aria-describedby',card.id); place();
  }
  function enter(event) {
    if (restoringFocus) return;
    const row = event.target.closest?.('.session-item[data-session-id],.session-item[data-meeting-id]');
    if (!row || event.relatedTarget && row.contains(event.relatedTarget)) return;
    // The OS tooltip cannot be styled. Remove only the summary/title fallback,
    // leaving accessible labels and control-specific help intact.
    row.removeAttribute('title'); row.querySelector('.sl-title')?.removeAttribute('title');
    clearTimeout(timer); timer = setTimeout(() => show(row), 300);
  }
  root.addEventListener('pointerover', enter); root.addEventListener('focusin', enter);
  root.addEventListener('pointerout', event => {
    const row = event.target.closest?.('.session-item');
    if (row && !row.contains(event.relatedTarget)) scheduleClose();
  });
  root.addEventListener('focusout', event => { if (!root.contains(event.relatedTarget) && !card?.contains(event.relatedTarget)) scheduleClose(); });
  root.addEventListener('pointerdown', close);
  doc.addEventListener?.('keydown', event => { if (event.key === 'Escape' && card) { const target=anchor; close(); restoringFocus=true; try { target?.focus({preventScroll:true}); } finally { restoringFocus=false; } } });
  doc.addEventListener?.('pointerdown', event => { if (card && !card.contains(event.target) && !anchor?.contains(event.target)) close(); });
  root.addEventListener('scroll', close, { passive:true }); win?.addEventListener?.('resize', close);
  return { close, refresh() {
    if (!card || !pinnedId) return;
    const replacement = [...root.querySelectorAll('.session-item')].find(e => (e.dataset.sessionId || e.dataset.meetingId) === pinnedId);
    if (!replacement) close(); else {
      anchor = replacement; anchor.removeAttribute('title'); anchor.querySelector('.sl-title')?.removeAttribute('title'); anchor.setAttribute('aria-describedby', card.id);
      const session = getSession(pinnedId);
      if (session) {
        const data = hoverSummary(session);
        for (const [selector, value] of [['h3',data.title],['.hub-peek-project',data.project],['.hub-peek-status',data.status],['.hub-peek-excerpt',data.excerpt]]) card.querySelector(selector).textContent = value;
        [...card.querySelectorAll('dd')].forEach((el,index) => { el.textContent=[data.model,data.context,data.effort,data.speed][index]; });
      }
      place();
    }
  } };
}
module.exports = { attachSessionHoverCard, hoverSummary, excerpt };
