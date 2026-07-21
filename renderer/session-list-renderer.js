// 纯函数：按 lastMessageTime 年龄分桶。pinned 永远进 recent（置顶不折叠）。
//   recent: <24h（保持现状 UI 置顶）· mid: 24-72h · old: ≥72h
function partitionSessionsByAge(items, now) {
  const DAY = 86400000;
  const recent = [], mid = [], old = [];
  for (const s of items || []) {
    const t = s.lastMessageTime || s.createdAt || now;
    const age = now - t;
    if (s.pinned || age < DAY) recent.push(s);
    else if (age < 3 * DAY) mid.push(s);
    else old.push(s);
  }
  return { recent, mid, old };
}

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
  // 2026-07-19 方案C：列表渲染完成后的回调（renderer 用来刷新 ctx chip/中断钮/等你响应浮动条）
  const afterRender = typeof options.afterRender === 'function' ? options.afterRender : null;

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

// --- 按时间分组折叠状态（24-72h / 72h+ 两组，默认折叠，落盘）---
//   侧栏过长治理：24h 内保持现状置顶，更久的会话收进可展开的时间组。
const _expandedTimeGroups = (() => {
  try { const raw = storage.getItem('hubExpandedTimeGroups'); return new Set(raw ? JSON.parse(raw) : []); }
  catch { return new Set(); }
})();
function _persistExpandedTimeGroups() {
  try { storage.setItem('hubExpandedTimeGroups', JSON.stringify([..._expandedTimeGroups])); } catch {}
}
function toggleTimeGroup(key) {
  if (_expandedTimeGroups.has(key)) _expandedTimeGroups.delete(key);
  else _expandedTimeGroups.add(key);
  _persistExpandedTimeGroups();
  renderSessionList();
}
function _ensureTimeGroupStyle() {
  if (doc.getElementById('hub-stg-style')) return;
  const st = doc.createElement('style');
  st.id = 'hub-stg-style';
  st.textContent = [
    '.session-time-group-header{display:flex;align-items:center;gap:6px;padding:8px 12px 5px;margin-top:2px;cursor:pointer;user-select:none;font-size:11.5px;font-weight:600;letter-spacing:.02em;color:#8a8a8e;}',
    '.session-time-group-header:hover{color:#0a84ff;}',
    '.session-time-group-header .stg-arrow{display:inline-block;transition:transform .15s;font-size:9px;}',
    '.session-time-group-header.expanded .stg-arrow{transform:rotate(90deg);}',
    '.session-time-group-header .stg-label{flex:1;}',
    '.session-time-group-header .stg-count{background:rgba(128,128,128,.22);border-radius:9px;padding:1px 7px;font-size:10.5px;font-weight:500;}',
  ].join('\n');
  (doc.head || doc.documentElement).appendChild(st);
}

// AI mini logo for sidebar sub-session items. Reuses the .ai-logo + .logo-<kind>
// classes already defined in styles.css for the toolbar dropdown.
//   - 'powershell' 不是 AI kind 但侧边栏需展示 logo，在 ALL_AI_KINDS 之外单独保留。
function _aiLogoHtml(kind) {
  let k = String(kind || '').replace(/-resume$/, '');
  if (k !== 'powershell' && !isAiKind(k)) return '';
  return `<span class="ai-logo logo-${k}" aria-hidden="true"></span>`;
}

// --- 2026-07-19 道雪 · 方案4(ctx 圆环)：15px SVG，圆环弧=ctx 占用，圆心点=会话状态 ---
//   ctxPct 为 null（powershell/群聊父项）时只画空轨道 + 状态圆心；精确 % 进 title tooltip。
const _RING_C = 37.7; // 2πr (r=6)
function _ringHtml(ctxPct, dotCls) {
  const arc = (typeof ctxPct === 'number')
    ? `<circle cx="8" cy="8" r="6" class="sl-ring-arc ${pctClass(ctxPct)}" stroke-dasharray="${(Math.min(100, Math.max(0, ctxPct)) / 100 * _RING_C).toFixed(1)} ${_RING_C}" transform="rotate(-90 8 8)"/>`
    : '';
  return `<svg class="sl-ring" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" class="sl-ring-track"/>${arc}<circle cx="8" cy="8" r="2.2" class="sl-ring-dot ${dotCls}"/></svg>`;
}

// 2026-07-20 道雪：群聊运行中判定 = 任一成员 agent 在运行。
//   行1 状态点/状态词与「运行中」分区共用这一个口径。
// 2026-07-21 道雪 [修状态灯]：运行源 = sub.status==='running'（语义化 running）
//   或 gcWorking（dispatcher watcher 生命周期）——任一成员任一命中即算群聊运行中。
function _meetingAnySubRunning(meeting) {
  const ids = (meeting && meeting.subSessions) || [];
  for (const id of ids) {
    const sub = getSessions().get(id);
    if (sub && (sub.status === 'running' || sub.gcWorking)) return true;
  }
  return false;
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
    lastOutputPreview: m.groupChat
      ? `AI 群聊 · ${(m.participants || m.subSessions || []).length}/${(m.subSessions || []).length} 已选`
      : `${m.subSessions.length} 个子会话`,
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
  _ensureTimeGroupStyle();

  // 单条渲染（会话/会议），供「置顶 recent + 时间组」复用。
  function appendItem(s) {
    if (s._isMeeting) {
      const isActive = getActiveMeetingId() === s.id;
      const isGroupChat = !!s._meeting.groupChat;
      // 2026-07-20 道雪：群聊不再提供展开按钮（行2 mini-jump 已覆盖子会话跳转）；
      //   老式 🎯 meeting 保留展开。canExpand 同时决定箭头渲染与子行挂载。
      const canExpand = !isGroupChat;
      const isExpanded = canExpand && _expandedMeetings.has(s.id);
      const div = doc.createElement('div');
      // 2026-07-19 道雪 · 方案C：群聊两行卡（行1 状态+标题+时间，行2 成员 mini-jump），
      //   不再渲染 badge pill（等你/休眠进 sl-state，已选数进行2 末尾）。
      const isDormantMeeting = s.status === 'dormant';
      const hasUnread = !isDormantMeeting && !isActive && (s.unreadAnsweredSize > 0);
      // 2026-07-20 道雪：群聊运行中 = 任一成员 agent 在运行（成员 running 已语义化）
      const anySubRunning = _meetingAnySubRunning(s._meeting);
      div.className = 'session-item slim meeting' + (isGroupChat ? ' gc' : '')
        + (isActive ? ' selected' : '')
        + (isExpanded ? ' expanded' : '') + (isDormantMeeting ? ' dormant' : '')
        + (hasUnread ? ' need-unread' : '');
      div.dataset.meetingId = s.id;
      const SLOT_LABELS_M = ['一号位', '二号位', '三号位'];
      const miniSids = isGroupChat ? (s._meeting.subSessions || []) : (s._meeting.subSessions || []).slice(0, 3);
      const memberTotal = (s._meeting.subSessions || []).length;
      const memberSelected = isGroupChat
        ? (Array.isArray(s._meeting.participants) ? s._meeting.participants.length : memberTotal)
        : memberTotal;
      const miniJumpsHtml = miniSids.map((subId, idx) => {
        const sub = getSessions().get(subId);
        const label = isGroupChat
          ? ((sub && (sub.title || sub.kind)) || `AI ${idx + 1}`)
          : (SLOT_LABELS_M[idx] || `Slot ${idx + 1}`);
        const avatarSrc = sub && sub.kind
          ? `assets/ai-logos/${sub.kind}.svg`
          : '';
        const modelLabel = sub && sub.currentModel ? (typeof modelShort === 'function' ? modelShort(sub.currentModel) : sub.currentModel.id) : '';
        let statusCls = 'mini-st-ready';
        if (!sub) statusCls = 'mini-st-init';
        else if (sub.status === 'dormant') statusCls = 'mini-st-dormant';
        else if (sub.status === 'errored' || sub.status === 'error') statusCls = 'mini-st-error';
        else if (sub.status === 'running' || sub.gcWorking) statusCls = 'mini-st-thinking';
        const isActiveChild = subId === getActiveSessionId();
        const ctxPct = isGroupChat && sub && typeof sub.contextPct === 'number' ? sub.contextPct : null;
        const ctxCls = ctxPct != null && typeof pctClass === 'function' ? pctClass(ctxPct) : '';
        const ctxLabelHtml = ctxPct != null
          ? `<span class="mini-jump-ctx ${ctxCls}" title="Context ${ctxPct}%">${ctxPct}%</span>`
          : '';
        const tooltip = `${label}${modelLabel ? ' · ' + modelLabel : ''}${ctxPct != null ? ' · Ctx ' + ctxPct + '%' : ''} (点击跳转)`;
        const avatarHtml = isGroupChat
          ? `<span class="mini-jump-text">${escapeHtml(sub && sub.kind ? sub.kind : ('AI' + (idx + 1)))}</span>`
          : (avatarSrc
            ? `<img src="${avatarSrc}" alt="${escapeHtml(label)}" />`
            : `<span class="mini-jump-letter">${escapeHtml(String(idx + 1))}</span>`);
        return `<span class="mini-jump-cell">
          <button class="mini-jump-btn slot-${idx + 1}${isGroupChat ? ' group' : ''}${isActiveChild ? ' active' : ''}" data-sub-id="${subId}" title="${escapeHtml(tooltip)}">
            ${avatarHtml}
            <span class="mini-jump-status-dot ${statusCls}"></span>
          </button>${ctxLabelHtml}
        </span>`;
      }).join('');
      // 状态点优先级：未读 > 运行(任一成员) > 休眠 > 空闲
      let dotCls = 'idle';
      if (isDormantMeeting) dotCls = 'dorm';
      else if (hasUnread) dotCls = 'unread';
      else if (anySubRunning) dotCls = 'run';
      const stateHtml = isDormantMeeting
        ? '<span class="sl-state dorm" title="休眠中，点击唤醒">休眠</span>'
        : (hasUnread
          ? `<span class="sl-state unread" title="本轮已 ${s.unreadAnsweredSize} 个 AI 答完">等你 ${s.unreadAnsweredSize}</span>`
          : (anySubRunning
            ? '<span class="sl-state run">运行中</span>'
            : '<span></span>'));
      div.innerHTML = `
        <div class="sl-line1${canExpand ? ' with-arrow' : ''}">
          ${canExpand ? `<span class="expand-arrow" data-action="toggle-expand" title="${isExpanded ? '折叠' : '展开'}">▶</span>` : ''}
          ${_ringHtml(null, dotCls)}
          <span class="sl-title" title="${escapeHtml(s.title)}">${s.pinned ? '<span class="sl-pin">📌</span>' : ''}${isGroupChat ? '💬' : '🎯'} ${escapeHtml(s.title)}</span>
          ${stateHtml}
          <span class="sl-time">${formatTime(s.lastMessageTime)}</span>
        </div>
        <div class="session-mini-jumps">${miniJumpsHtml}<span class="sl-members-hint">${memberSelected}/${memberTotal} 已选</span></div>
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
          childDiv.className = 'session-item slim child' + (isChildActive ? ' selected' : '') + childDormantCls;
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
      return;
    }

    // 2026-07-19 道雪 · 方案C：普通 session 单行密排（状态点/标题/模型/ctx/时间）。
    //   badge pill（等你/模型/Ctx/burn）全部移除：等待与未读改行底色+状态点，
    //   burn 聚合到侧栏底部 strip，模型与 ctx 变等宽小字列。
    const isActive = s.id === getActiveSessionId();
    const div = doc.createElement('div');
    const isDormant = s.status === 'dormant';
    const dormantCls = isDormant ? ' dormant' : '';
    const showWaiting = !isDormant && s.isWaiting && !isActive;
    const showUnread = !isDormant && (s.unreadCount || 0) > 0 && !isActive && !s.isWaiting;
    // 状态点优先级：等待输入 > 未读 > 运行 > 休眠 > 空闲
    let dotCls = 'idle';
    if (isDormant) dotCls = 'dorm';
    else if (showWaiting) dotCls = 'wait';
    else if (showUnread) dotCls = 'unread';
    else if (s.status === 'running') dotCls = 'run';
    div.className = 'session-item slim' + (isActive ? ' selected' : '')
      + (showWaiting ? ' need-wait' : '') + (showUnread ? ' need-unread' : '') + dormantCls;
    const ctxPct = typeof s.contextPct === 'number' ? s.contextPct : null;
    const modelTxt = s.currentModel ? modelShort(s.currentModel) : '';
    const titleTip = [s.title,
      s.currentModel ? (s.currentModel.displayName || s.currentModel.id) : '',
      ctxPct != null ? `Ctx ${ctxPct}%` : '',
      isDormant ? '休眠中，点击唤醒' : (showWaiting ? (s.waitingText || '等你输入') : (showUnread ? (s.lastOutputPreview || '有未读新消息') : '')),
    ].filter(Boolean).join(' · ');
    div.innerHTML = `
      ${_ringHtml(ctxPct, dotCls)}
      <span class="sl-title" title="${escapeHtml(titleTip)}">${s.pinned ? '<span class="sl-pin" title="Pinned">📌</span>' : ''}${escapeHtml(s.title)}${showUnread ? `<span class="sl-un">● ${s.unreadCount}</span>` : ''}</span>
      <span class="sl-model">${escapeHtml(modelTxt)}</span>
      <span class="sl-time">${formatTime(s.lastMessageTime)}</span>
    `;
    div.addEventListener('click', () => selectSession(s.id, { forceScrollBottom: true }));
    div.addEventListener('contextmenu', (e) => { e.preventDefault(); openContextMenu(s.id, e.clientX, e.clientY); });
    sessionListEl.appendChild(div);
  }

  // === 2026-07-19 道雪 · 方案C 分区渲染：等你响应 → 运行中 → 最近 → 3天内/更早 ===
  //   分类语义（与状态来源逐项核对过）：
  //     等你响应 = 非 active 且非 dormant 且（isWaiting 或 unreadCount>0；群聊=本轮已答 AI 数>0）
  //     运行中   = status === 'running'（PTY 数据突发 / 卡片语义工作中）
  //     最近     = 24h 内其余（含 active、休眠、空闲）
  const { recent, mid, old } = partitionSessionsByAge(visible, Date.now());
  const activeSid = getActiveSessionId();
  const activeMid = getActiveMeetingId();
  const isActiveItem = (s) => s._isMeeting ? s.id === activeMid : s.id === activeSid;
  function needsRespond(s) {
    if (isActiveItem(s) || s.status === 'dormant') return false;
    if (s._isMeeting) return (s.unreadAnsweredSize || 0) > 0;
    return !!s.isWaiting || (s.unreadCount || 0) > 0;
  }
  const respond = [], running = [], rest = [];
  for (const s of recent) {
    if (needsRespond(s)) respond.push(s);
    else if (s._isMeeting ? _meetingAnySubRunning(s._meeting) : s.status === 'running') running.push(s);
    else rest.push(s);
  }
  function appendSecHeader(label, count, cls) {
    const h = doc.createElement('div');
    h.className = 'session-sec-header' + (cls ? ' ' + cls : '');
    h.innerHTML = `<span>${escapeHtml(label)}</span><span class="sec-count">${count}</span>`;
    sessionListEl.appendChild(h);
  }
  if (respond.length) { appendSecHeader('⚠ 等你响应', respond.length, 'sec-respond'); for (const s of respond) appendItem(s); }
  if (running.length) { appendSecHeader('运行中', running.length); for (const s of running) appendItem(s); }
  if (rest.length) {
    if (respond.length || running.length) appendSecHeader('最近', rest.length);
    for (const s of rest) appendItem(s);
  }
  function appendTimeGroup(key, label, items) {
    if (!items.length) return;
    // active 所在组自动展开，避免当前会话被折叠藏起；其余按落盘状态（默认折叠）。
    const expanded = _expandedTimeGroups.has(key) || items.some(isActiveItem);
    const header = doc.createElement('div');
    header.className = 'session-time-group-header' + (expanded ? ' expanded' : '');
    header.dataset.timeGroup = key;
    header.innerHTML = `<span class="stg-arrow">▶</span><span class="stg-label">${escapeHtml(label)}</span><span class="stg-count">${items.length}</span>`;
    header.addEventListener('click', () => toggleTimeGroup(key));
    sessionListEl.appendChild(header);
    if (expanded) for (const s of items) appendItem(s);
  }
  appendTimeGroup('mid', '3 天内', mid);
  appendTimeGroup('old', '更早', old);

  // === 侧栏底部聚合条：会话数 / 等你数 / ctx 均值 / 单会话最大 burn ===
  const stripEl = doc.getElementById('sidebar-strip');
  if (stripEl) {
    const allSessions = Array.from(getSessions().values());
    const ctxVals = allSessions.map(x => x.contextPct).filter(v => typeof v === 'number');
    const ctxMean = ctxVals.length ? Math.round(ctxVals.reduce((a, b) => a + b, 0) / ctxVals.length) : null;
    let maxBurn = 0;
    for (const x of allSessions) {
      const b = typeof sessionBurnRate === 'function' ? sessionBurnRate(x) : null;
      if (b && typeof b.pctPerHour === 'number' && b.pctPerHour > maxBurn) maxBurn = b.pctPerHour;
    }
    stripEl.innerHTML =
      `<span><b>${visible.length}</b> 会话</span>` +
      `<span>等你 <b class="${respond.length ? 'strip-warn' : ''}">${respond.length}</b></span>` +
      (ctxMean != null ? `<span>ctx̄ <b>${ctxMean}%</b></span>` : '') +
      (maxBurn >= 2 ? `<span class="strip-burn" title="单会话最大 burn 速率（占 5h 配额%/小时）">🔥 <b>${maxBurn.toFixed(1)}%</b>/h</span>` : '');
    stripEl.style.display = 'flex';
  }

  if (afterRender) afterRender();

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

module.exports = { createSessionListRenderer, partitionSessionsByAge };
