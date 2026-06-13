function createSessionListRenderer(options = {}) {
  const doc = options.document || document;
  const storage = options.localStorage || localStorage;
  const sessionListEl = options.sessionListEl;
  const getSessions = typeof options.getSessions === 'function' ? options.getSessions : () => new Map();
  const getMeetings = typeof options.getMeetings === 'function' ? options.getMeetings : () => ({});
  const getActiveSessionId = typeof options.getActiveSessionId === 'function' ? options.getActiveSessionId : () => null;
  const getActiveMeetingId = typeof options.getActiveMeetingId === 'function' ? options.getActiveMeetingId : () => null;
  const isAiKind = options.isAiKind;
  const modelShort = options.modelShort;
  const modelClass = options.modelClass;
  const escapeHtml = options.escapeHtml;
  const formatTime = options.formatTime;
  const pctClass = options.pctClass;
  const sessionBurnRate = options.sessionBurnRate;
  const selectSession = options.selectSession;
  const selectMeeting = options.selectMeeting;
  const openContextMenu = options.openContextMenu;

// --- Sidebar tree state: which meeting entries are expanded to show their sub-sessions ---
// Persists across reloads. Default = collapsed (白名单未命中即折叠)；用户点 ▶ 后才进
// _expandedMeetings 集合并落盘。2026-05-05 道雪改：新 AI 群聊不再默认展开，折叠态本来
// 就有 3 个迷你头像跳转按钮可用。
const _expandedMeetings = (() => {
  try {
    const raw = storage.getItem('hubExpandedMeetings');
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
})();
function _persistExpandedMeetings() {
  try {
    storage.setItem('hubExpandedMeetings', JSON.stringify([..._expandedMeetings]));
  } catch {}
}
function toggleMeetingExpand(meetingId) {
  if (_expandedMeetings.has(meetingId)) _expandedMeetings.delete(meetingId);
  else _expandedMeetings.add(meetingId);
  _persistExpandedMeetings();
  renderSessionList();
}

// AI mini logo for sidebar sub-session items. Reuses the .ai-logo + .logo-<kind>
// classes already defined in styles.css for the toolbar dropdown.
//   - 'powershell' 不是 AI kind 但侧边栏需展示 logo，在 ALL_AI_KINDS 之外单独保留。
function _aiLogoHtml(kind) {
  let k = String(kind || '').replace(/-resume$/, '');
  // Claude Web 是 Claude 的风格变体，复用同一 logo（卡片视图另叠加 WEB 角标）
  if (k === 'claude-web') k = 'claude';
  if (k === 'codex-web') k = 'codex';
  if (k === 'codex-app') return `<span class="ai-logo logo-codex" aria-hidden="true"></span>`;
  if (k !== 'powershell' && !isAiKind(k)) return '';
  return `<span class="ai-logo logo-${k}" aria-hidden="true"></span>`;
}

// --- Session list rendering ---
// Sort: pinned sessions first (by their own time), then unpinned by lastMessageTime.
// Tree shape: meeting entries optionally expand to show their child sub-sessions.
// Top-level regular sessions (no meetingId) sit alongside meetings in the same sort order.
function renderSessionList() {
  const regularSessions = Array.from(getSessions().values()).filter(s => !s.meetingId);

  const meetingItems = Object.values(getMeetings()).map(m => ({
    id: m.id,
    title: m.title,
    lastMessageTime: m.lastMessageTime,
    createdAt: m.createdAt,
    lastOutputPreview: `${m.subSessions.length} 个子会话`,
    status: m.status || 'idle',
    // 2026-05-05 道雪 修3：AI 群聊 item 接入 unread 机制 —— 全员答完且非 active 时累加，
    //   selectMeeting 时清零。替代旧 Web Notification + title 闪烁，统一走 Hub 侧栏哲学。
    // 2026-05-31 道雪：unread 语义改为"本轮已答 AI 数（Set<sid>.size）" — 任一 AI 答完 +1，
    //   显示"等你 N"（1-3）；turnNum 变 / selectMeeting 时清零（详见 renderer.js partial-update handler）。
    unreadAnsweredSize: m.unreadAnswered instanceof Set ? m.unreadAnswered.size : 0,
    pinned: m.pinned,
    _isMeeting: true,
    _meeting: m,
  }));

  const all = regularSessions.concat(meetingItems);

  const sorted = all.sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return b.lastMessageTime - a.lastMessageTime || b.createdAt - a.createdAt;
  });

  // Hide any leftover legacy background PTY sessions from the removed room path.
  const visible = sorted.filter(s => !s.title || !s.title.startsWith('[Team] '));

  // Preserve scroll position across rebuilds — without this, any re-render
  // (every status-event, silence-timer, or session-updated) snaps the list
  // back to the top, which feels like the sidebar is "fighting" the user.
  const savedScrollTop = sessionListEl.scrollTop;
  sessionListEl.innerHTML = '';

  for (const s of visible) {
    if (s._isMeeting) {
      const isActive = getActiveMeetingId() === s.id;
      const isExpanded = _expandedMeetings.has(s.id);
      const div = doc.createElement('div');
      // 2026-05-05 道雪 修3：AI 群聊 item 也应用 has-unread CSS（跟普通 session 一致），
      //   全员答完且非 active 时高亮提醒；用户点进 AI 群聊后清零。
      const isDormantMeeting = s.status === 'dormant';
      const hasUnread = !isDormantMeeting && !isActive && (s.unreadAnsweredSize > 0);
      div.className = 'session-item meeting' + (isActive ? ' selected' : '')
        + (isExpanded ? ' expanded' : '') + (hasUnread ? ' has-unread' : '')
        + (isDormantMeeting ? ' dormant' : '');
      div.dataset.meetingId = s.id;
      // Phase 8(2026-05-05 道雪): 折叠/展开态都显示 3 个迷你头像跳转按钮(替代旧 "N 个子会话" 文字)。
      //   slot 配色绑定: subSessions[0]=Pikachu(slot1) / [1]=Charmander(slot2) / [2]=Squirtle(slot3),
      //   PNG 图与卡片头像/footer 一致(assets/pokemon/*.png)。
      //   状态点: thinking/streaming(running)=黄, errored=红, idle/completed=绿, 创建中=灰。
      const SLOT_AVATAR_FILES = ['pikachu.png', 'charmander.png', 'squirtle.png'];
      const SLOT_LABELS_M = ['⚡ 皮卡丘', '🔥 小火龙', '💎 杰尼龟'];
      const isGroupChat = !!s._meeting.groupChat;
      const miniSids = isGroupChat ? (s._meeting.subSessions || []) : (s._meeting.subSessions || []).slice(0, 3);
      const miniJumpsHtml = miniSids.map((subId, idx) => {
        const sub = getSessions().get(subId);
        const label = isGroupChat
          ? ((sub && (sub.title || sub.kind)) || `AI ${idx + 1}`)
          : (SLOT_LABELS_M[idx] || `Slot ${idx + 1}`);
        const avatarSrc = isGroupChat && sub && sub.kind
          ? `assets/ai-logos/${sub.kind}.svg`
          : `assets/pokemon/${SLOT_AVATAR_FILES[idx]}`;
        const modelLabel = sub && sub.currentModel ? (typeof modelShort === 'function' ? modelShort(sub.currentModel) : sub.currentModel.id) : '';
        // 状态点配色: 复用 sub.status(running/idle/errored), 配合 cliReadyCache 推断 initializing
        let statusCls = 'mini-st-ready';
        if (!sub) statusCls = 'mini-st-init';
        else if (sub.status === 'dormant') statusCls = 'mini-st-dormant';
        else if (sub.status === 'errored' || sub.status === 'error') statusCls = 'mini-st-error';
        else if (sub.status === 'running') statusCls = 'mini-st-thinking';
        const isActiveChild = subId === getActiveSessionId();
        // 2026-05-31 道雪：群聊侧栏每个 AI logo 右侧贴 Ctx% 小标签，让用户一眼看到上下文占用。
        //   数据已由 statusline → /api/status → sessions.contextPct 注入；为 null 时不渲染。
        const ctxPct = isGroupChat && sub && typeof sub.contextPct === 'number' ? sub.contextPct : null;
        const ctxCls = ctxPct != null && typeof pctClass === 'function' ? pctClass(ctxPct) : '';
        const ctxLabelHtml = ctxPct != null
          ? `<span class="mini-jump-ctx ${ctxCls}" title="Context ${ctxPct}%">${ctxPct}%</span>`
          : '';
        const tooltip = `${label}${modelLabel ? ' · ' + modelLabel : ''}${ctxPct != null ? ' · Ctx ' + ctxPct + '%' : ''} (点击跳转)`;
        return `<span class="mini-jump-cell">
          <button class="mini-jump-btn slot-${idx + 1}${isGroupChat ? ' group' : ''}${isActiveChild ? ' active' : ''}" data-sub-id="${subId}" title="${escapeHtml(tooltip)}">
            <img src="${avatarSrc}" alt="${escapeHtml(label)}" />
            <span class="mini-jump-status-dot ${statusCls}"></span>
          </button>${ctxLabelHtml}
        </span>`;
      }).join('');
      div.innerHTML = `
        <div class="session-item-header">
          <span class="session-title">
            <span class="expand-arrow" data-action="toggle-expand" title="${isExpanded ? '折叠' : '展开'}">▶</span>
            ${s.pinned ? '<span class="pin-icon" title="Pinned">📌</span>' : ''}
            <span class="session-status ${isDormantMeeting ? 'dormant' : 'running'}"></span>${isGroupChat ? '💬' : '🎯'} ${escapeHtml(s.title)}<span class="meeting-badge">${s._meeting.subSessions.length}</span>
          </span>
          <span class="session-header-right">
            ${isDormantMeeting ? `<span class="dormant-badge" title="休眠中，点击唤醒">休眠</span>` : ''}
            ${hasUnread ? `<span class="unread-badge" title="本轮已 ${s.unreadAnsweredSize} 个 AI 答完">⏸ 等你 ${s.unreadAnsweredSize}</span>` : ''}
            <span class="session-time">${formatTime(s.lastMessageTime)}</span>
          </span>
        </div>
        <div class="session-mini-jumps">${miniJumpsHtml}</div>
      `;
      div.addEventListener('click', (e) => {
        // Phase 8: 迷你跳转按钮 click → 跳转对应子 session, 不冒泡到 selectMeeting
        const jumpBtn = e.target.closest('[data-sub-id]');
        if (jumpBtn) {
          e.stopPropagation();
          const subId = jumpBtn.getAttribute('data-sub-id');
          if (subId) selectSession(subId, { forceScrollBottom: true });
          return;
        }
        if (e.target.closest('[data-action="toggle-expand"]')) {
          e.stopPropagation();
          toggleMeetingExpand(s.id);
        } else {
          selectMeeting(s.id);
        }
      });
      div.addEventListener('contextmenu', (e) => { e.preventDefault(); openContextMenu(s.id, e.clientX, e.clientY); });
      sessionListEl.appendChild(div);

      // Render child sub-sessions if expanded (clicking goes straight to shell view).
      if (isExpanded) {
        for (const subId of s._meeting.subSessions) {
          const sub = getSessions().get(subId);
          if (!sub) continue;
          const childDiv = doc.createElement('div');
          const isChildActive = subId === getActiveSessionId();
          const childDormantCls = sub.status === 'dormant' ? ' dormant' : '';
          childDiv.className = 'session-item child' + (isChildActive ? ' selected' : '') + childDormantCls;
          childDiv.dataset.sessionId = subId;
          const modelLabel = sub.currentModel
            ? `<span class="child-model-badge ${modelClass(sub.currentModel.id)}" title="${escapeHtml(sub.currentModel.displayName || sub.currentModel.id)}">${escapeHtml(modelShort(sub.currentModel))}</span>`
            : '';
          childDiv.innerHTML = `
            ${_aiLogoHtml(sub.kind)}
            <span class="child-title">${escapeHtml(sub.title)}</span>
            ${modelLabel}
          `;
          // Use the existing selectSession path: it hides meeting-room-panel,
          // shows terminal-panel, and mounts the cached xterm container.
          // This is exactly the "single-viewer strict switch" the spec calls for.
          childDiv.addEventListener('click', () => selectSession(subId, { forceScrollBottom: true }));
          childDiv.addEventListener('contextmenu', (ev) => { ev.preventDefault(); openContextMenu(subId, ev.clientX, ev.clientY); });
          sessionListEl.appendChild(childDiv);
        }
      }
      continue;
    }

    const isActive = s.id === getActiveSessionId();
    const div = doc.createElement('div');
    const isDormant = s.status === 'dormant';
    const dormantCls = isDormant ? ' dormant' : '';
    const showWaiting = !isDormant && s.isWaiting && !isActive;
    const showUnread = !isDormant && s.unreadCount > 0 && !isActive && !s.isWaiting;
    const waitingCls = showWaiting ? ' is-waiting' : '';
    div.className = 'session-item' + (isActive ? ' selected' : '') + (showUnread ? ' has-unread' : '') + waitingCls + dormantCls;
    const ctxBadge = typeof s.contextPct === 'number'
      ? `<span class="ctx-badge ${pctClass(s.contextPct)}" title="Context ${s.contextPct}%">Ctx ${s.contextPct}%</span>`
      : '';
    const modelBadge = s.currentModel
      ? `<span class="model-badge ${modelClass(s.currentModel.id)}" title="${escapeHtml(s.currentModel.displayName || s.currentModel.id)}">${escapeHtml(modelShort(s.currentModel))}</span>`
      : '';
    // Burn attribution: only show if we have a rate ≥ 0.5%/h; clutter guard.
    const burn = sessionBurnRate(s);
    const burnBadge = (burn && burn.pctPerHour >= 0.5)
      ? `<span class="burn-badge ${burn.pctPerHour >= 5 ? 'danger' : burn.pctPerHour >= 2 ? 'warn' : 'ok'}" title="Est. share of 5h cap / hour at current rate (${Math.round(burn.tokensPerMin).toLocaleString()} tok/min)">🔥 ${burn.pctPerHour.toFixed(1)}%/h</span>`
      : '';
    const statusBadge = isDormant
      ? `<span class="dormant-badge" title="休眠中，点击唤醒">休眠</span>`
      : (showWaiting
        ? `<span class="waiting-badge" title="${escapeHtml(s.waitingText || 'Claude is waiting for your input')}">⏸ 等你</span>`
        : (showUnread
          ? `<span class="unread-badge" title="${escapeHtml(s.lastOutputPreview || 'AI 有新消息')}">⏸ 等你</span>`
          : ''));
    const footerInner = [statusBadge, modelBadge, ctxBadge, burnBadge].filter(Boolean).join('');
    // Claude Web 模式角标：在标题右侧、时间左边附一个小 WEB 标识
    // 复用 .web-badge-inline 样式（在下拉菜单内已使用相同视觉）
    const webBadge = (s.kind === 'claude-web' || s.kind === 'claude-web-resume' || s.kind === 'codex-web' || s.kind === 'codex-web-resume')
      ? '<span class="web-badge-inline" title="Web 模式 — 风格对齐网页端体验">WEB</span>'
      : '';
    div.innerHTML = `
      <div class="session-item-header">
        <span class="session-title">${s.pinned ? '<span class="pin-icon" title="Pinned">📌</span>' : ''}<span class="session-status ${s.status}"></span>${escapeHtml(s.title)}${webBadge}</span>
        <span class="session-header-right">
          <span class="session-time">${formatTime(s.lastMessageTime)}</span>
        </span>
      </div>
      <div class="session-preview">${escapeHtml((!isDormant && s.isWaiting && s.waitingText) || s.lastOutputPreview || 'No output yet')}</div>
      ${footerInner ? `<div class="session-footer">${footerInner}</div>` : ''}
    `;
    div.addEventListener('click', () => selectSession(s.id, { forceScrollBottom: true }));
    div.addEventListener('contextmenu', (e) => { e.preventDefault(); openContextMenu(s.id, e.clientX, e.clientY); });
    sessionListEl.appendChild(div);
  }
  sessionListEl.scrollTop = savedScrollTop;
}

// --- Session card hover light-tracking + click ripple (event delegation) ---
sessionListEl.addEventListener('mousemove', (e) => {
  const item = e.target.closest('.session-item');
  if (!item) return;
  const rect = item.getBoundingClientRect();
  item.style.setProperty('--mx', ((e.clientX - rect.left) / rect.width * 100) + '%');
  item.style.setProperty('--my', ((e.clientY - rect.top) / rect.height * 100) + '%');
});
sessionListEl.addEventListener('mousedown', (e) => {
  const item = e.target.closest('.session-item');
  if (!item) return;
  const rect = item.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  const r = doc.createElement('span');
  r.className = 'ripple-fx';
  r.style.width = r.style.height = size + 'px';
  r.style.left = (e.clientX - rect.left - size / 2) + 'px';
  r.style.top = (e.clientY - rect.top - size / 2) + 'px';
  item.appendChild(r);
  setTimeout(() => r.remove(), 450);
});



  return { renderSessionList };
}

module.exports = { createSessionListRenderer };