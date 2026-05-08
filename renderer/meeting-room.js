// renderer/meeting-room.js
// Meeting Room UI — manages the parallel terminal panel.
// Exposes global `MeetingRoom` object consumed by renderer.js.
// T2（2026-05-04 道雪）：底部 module.exports 暴露 _isPartialUnchanged 给 Node unit test，
//   require 时 typeof document === 'undefined' → IIFE 体内大量 DOM/IPC 引用会爆，故 IIFE 只在 renderer 浏览器环境跑。

if (typeof document !== 'undefined') (function () {
  const { ipcRenderer } = require('electron');
  const _scenes = require('../core/roundtable-scenes.js');
  const { isSlotParticipatingThisTurn } = require('../core/meeting-room.js');
  const { isPasteSensitive, kindRegexAlternation, KIND_LABELS, ALL_AI_KINDS, getKindLabel,
          SLOT_IDS, SLOT_DISPLAY, getSlotPromptName, getSlotDisplayLabel,
          slotIdRegexAlternation, slotIdToIndex, slotIndexToId } = require('../core/ai-kinds.js');

  let activeMeetingId = null;
  let meetingData = {};
  let subTerminals = {};
  let _markerStatusCache = {};
  let _markerPollTimer = null;
  // IF-C1（2026-05-01）：CLI ready 状态 cache（per-sid bool），由 cli-ready-status IPC 1s 轮询填充
  //   驱动 isInitializing 判断（修 P0 阻塞 bug B：原 markerStatus 永远 'none' 导致永久卡"创建中"）
  let _cliReadyCache = {};
  let _cliReadyPollTimer = null;
  // 圆桌记忆 phase 1（2026-05-07）：per-(meetingId, slot) 状态缓存
  //   { meetingId: { slot: { count, pending, hasProfile } } }
  //   memory-event IPC 增量更新；首次进 panel 时 _loadMemoryStatusForMeeting 拉取
  let _memStatusBy = {};
  // IF-C3（2026-05-01）：banner dismiss 状态记录 — meetingId，dismiss 后同会议不再显示，
  //   关闭会议（closeMeetingPanel）会重置，下次进同会议又显示
  let _bannerDismissedFor = null;
  // IF-C7（2026-05-03）：未 ready 数量上次值，用于"新增未 ready 项时撤销 dismiss"
  let _lastNotReadyCount = 0;
  const _tabState = {};     // { sessionId: 'streaming'|'new-output'|'idle'|'error' }
  const _tabTimers = {};    // { sessionId: silenceTimerId }

  // renderer.js loads before us — its `sessions` and `getOrCreateTerminal`
  // are accessible via the global lexical scope. We access them directly.

  // 所有场景(general/research)在 UI 渲染上完全一致(卡片+CLI)。
  // 与 core/meeting-room.js 的 isRoundtableCapableMeeting 语义一致。
  function _isPanelCapableMeeting(m) {
    return !!(m && m.scene);
  }

  // --- Roundtable @command parser ---
  // 摘要功能 2026-05-08 整体下线：原 @summary @<slot> 命令路径已删
  // 现仅支持 @debate / @all / @<slot>（@<slot> 仅用于剥前缀，仍走 fanout）
  const _RT_SLOT_ALT = slotIdRegexAlternation();
  const _tokenRe = new RegExp('^@(' + _RT_SLOT_ALT + ')\\b\\s*', 'i');
  function parseRoundtableCommand(text, meeting) {
    if (!meeting || !meeting.scene) return { type: 'normal', text, targets: null };
    let rest = text.trim();
    const debateRe = /^@debate\b\s*/i;
    let m;
    if ((m = rest.match(debateRe))) {
      return { type: 'rt-debate', text: rest.slice(m[0].length) };
    }
    const allRe = /^@all\b\s*/i;
    if ((m = rest.match(allRe))) {
      return { type: 'rt-fanout', text: rest.slice(m[0].length) };
    }
    // @<who> 私聊
    const targets = [];
    while (true) {
      const t = rest.match(_tokenRe);
      if (!t) break;
      targets.push(t[1].toLowerCase());
      rest = rest.slice(t[0].length);
    }
    // pilot redesign（2026-05-02）：旧 @xxx 私聊解析整体废弃。
    //   想私聊就直接进对应 AI 子会话区聊（圆桌不再桥接子会话，rt-private 类型已删）。
    //   保留 @xxx 前缀剥离能力，但全部走 fanout（@xxx 与不带 @ 等价）。
    return { type: 'rt-fanout', text: rest };
  }

  // --- Roundtable Mode: 持久化圆桌面板（始终显示当前状态 + 历史）---
  // Phase 5(2026-05-05 道雪): 时光机模式状态 — _rtViewingTurnN[meetingId] = N 表示正在查看第 N 轮历史。
  //   null / undefined = 默认查看最新轮(实时模式), 数字 = 查看第 N 轮(只读历史模式)。
  //   切换由 stepper dot click 触发 → 重渲 panel + _renderSlotCard 拿 turn.by[sid] 渲染历史内容。
  const _rtViewingTurnN = {};

  // _rtPanelState[meetingId] 缓存渲染状态，避免 IPC 频繁调用
  // partialBy: 当前进行中轮次的部分回答 { sid: { text, status } } — 单家完成立即更新
  const _rtPanelState = {};
  let _rtHistoryExpanded = false;
  // T3（2026-05-04 道雪）：抽屉实时订阅状态。打开时设 { sid, mid, kind }，关时清 null。
  //   partial-update handler 命中同 sid + 用户当前 active 的是 live tab 时，更新抽屉内容。
  let _rtTimelineLive = null;
  // T3 fix（2026-05-04 道雪）：上一次抽屉的清理函数，开新抽屉前先调，避免 escHandler 累积绑定 + 闭包内存泄漏。
  let _rtTimelineCleanup = null;
  // pilot redesign（2026-05-02）：_privateCountCache 已废弃（圆桌不再桥接子会话私聊）
  const _thinkStartTs = {};
  let _thinkTimer = null;
  // F0 Phase 1(2026-05-04 道雪): 卡片聚焦态全局状态。null = 默认态; sid = 该卡聚焦中。
  //   触发: click 任一 .mr-ft → 进入; 再次 click 同卡 / Esc / 点空白 → 退出。
  //   退出后 meeting.focusedSub 不变(主显仍是该 sid)。
  let _rtFocusedCardSid = null;

  // F9 Phase 2(2026-05-04 道雪): 卡片密度切换 (常规 220px / 紧凑 120px)。
  //   localStorage 持久化, per-Hub 全局态, 不与 meeting 绑定。
  function _isDensityCompact() {
    try {
      return typeof localStorage !== 'undefined' && localStorage.getItem('mr-density-compact') === 'true';
    } catch { return false; }
  }
  function _setDensityCompact(compact) {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem('mr-density-compact', compact ? 'true' : 'false'); } catch {}
    if (compact) document.body.classList.add('mr-density-compact');
    else document.body.classList.remove('mr-density-compact');
    // 触发 _relayoutMeetingRoom 让 xterm 等重新 fit (Card optimization Task 10 提供)
    if (typeof _relayoutMeetingRoom === 'function') {
      setTimeout(() => _relayoutMeetingRoom(), 260);
    }
  }
  // 启动时立即应用持久化状态
  if (_isDensityCompact()) document.body.classList.add('mr-density-compact');

  // F5 Phase 3(2026-05-04 道雪 / spec F5 简化版): 整轮总耗时
  //   原本 token + 成本估算因 transcript-tap 仅 GeminiTap 提供 token 数据,
  //   Claude/Codex/DeepSeek 等的 token/cost 显示 "--", 用户视觉上无价值。
  //   决定: 仅保留总耗时显示。token/cost 留给后续 transcript-tap 扩展后再启用。

  // F7 Phase 3 全员完成通知（Web Notification + title 闪烁）已废弃。
  //   2026-05-05 道雪 修3：改用侧栏 unread 机制（renderer.js 监听 turn-complete IPC，
  //   非 active 圆桌累加 meeting.unreadCount → renderSessionList 渲染 has-unread + ⏸ 等你 badge），
  //   与普通 session 的提醒哲学一致，不再用 Web Notification / title 闪烁打扰用户。

  const _CARD_VIEW_MODE_KEY = 'mr-card-view-mode';
  function _getCardViewMode() {
    try {
      const mode = typeof localStorage !== 'undefined' ? localStorage.getItem(_CARD_VIEW_MODE_KEY) : null;
      return mode === 'tab' ? 'tab' : 'parallel';
    } catch { return 'parallel'; }
  }
  function _isCardTabMode() {
    return _getCardViewMode() === 'tab';
  }
  function _applyCardViewModeClass(mode) {
    document.body.classList.toggle('mr-card-tab-mode', mode === 'tab');
    document.body.classList.remove('mr-density-compact');
  }
  function _setCardViewMode(mode, meeting) {
    const next = mode === 'tab' ? 'tab' : 'parallel';
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(_CARD_VIEW_MODE_KEY, next);
        localStorage.removeItem('mr-density-compact');
      }
    } catch {}
    _applyCardViewModeClass(next);
    if (next === 'tab') {
      _clearCompareSelect();
      _rtFocusedCardSid = null;
      document.body.classList.remove('mr-card-focus-on');
      const m = meeting || (activeMeetingId && meetingData[activeMeetingId]);
      if (m && !m.focusedSub && Array.isArray(m.subSessions) && m.subSessions[0]) {
        m.focusedSub = m.subSessions[0];
      }
    }
    const active = meeting || (activeMeetingId && meetingData[activeMeetingId]);
    if (active && _isPanelCapableMeeting(active)) refreshRoundtablePanel(active);
    if (typeof _relayoutMeetingRoom === 'function') {
      setTimeout(() => _relayoutMeetingRoom(), 260);
    }
  }
  _applyCardViewModeClass(_getCardViewMode());

  // F3 Phase 2(2026-05-04 道雪 / spec F3): 多卡 Ctrl/Cmd+click 对比模式
  //   状态: Set<sid>。空 = 默认; ≥1 = 对比模式 (body.mr-card-compare-on)
  //   spec §5 状态优先级: compare-selected 与 focus 互斥(进入对比时清 focus)
  //   退出: Esc / 点空白 / 取消最后一张
  //   简化版: 仅视觉描边(蓝色 dashed)+ 邻居淡化, 不动 grid 重分配
  const _rtCompareSlots = new Set();
  function _toggleCompareSelect(sid) {
    if (!sid) return;
    if (_rtFocusedCardSid) {
      _rtFocusedCardSid = null;
      document.body.classList.remove('mr-card-focus-on');
    }
    if (_rtCompareSlots.has(sid)) _rtCompareSlots.delete(sid);
    else _rtCompareSlots.add(sid);
    _applyCompareVisual();
  }
  function _clearCompareSelect() {
    if (_rtCompareSlots.size === 0) return;
    _rtCompareSlots.clear();
    _applyCompareVisual();
  }
  function _applyCompareVisual() {
    document.querySelectorAll('.mr-ft[data-ft-sid]').forEach(card => {
      const cardSid = card.getAttribute('data-ft-sid');
      if (_rtCompareSlots.has(cardSid)) card.classList.add('compare-selected');
      else card.classList.remove('compare-selected');
    });
    if (_rtCompareSlots.size > 0) document.body.classList.add('mr-card-compare-on');
    else document.body.classList.remove('mr-card-compare-on');
  }

  // F6 Phase 3(2026-05-04 道雪 / spec F6): 选中文本引用 chip
  //   流程: mouseup 选中 .mr-ft-bottom 内文本 → 浮按钮 [💎 引用追问] → 加 chip 到输入框上方区
  //   提交时: chips 内容拼到 prompt 头部"基于以下引用追问:\n[💎 第N轮 X: \"...\"]\n用户问题: ..."
  //   清空: 提交后 / 切 meeting 时
  let _rtQuoteChips = [];     // [{ sid, slotIndex, slotLabel, turnN, text }]
  let _rtQuoteFloatBtn = null; // body 级浮按钮 DOM, lazy 创建

  function _renderQuoteChips() {
    const inputRow = document.getElementById('mr-input-row');
    if (!inputRow) return;
    let row = document.getElementById('mr-quote-chips-row');
    if (!row) {
      row = document.createElement('div');
      row.id = 'mr-quote-chips-row';
      row.className = 'mr-quote-chips-row';
      inputRow.parentNode.insertBefore(row, inputRow);
    }
    if (_rtQuoteChips.length === 0) {
      row.style.display = 'none';
      row.innerHTML = '';
      return;
    }
    row.style.display = '';
    row.innerHTML = _rtQuoteChips.map((c, i) => {
      const slotCls = (c.slotIndex >= 0 && c.slotIndex < 3) ? `slot-${c.slotIndex + 1}` : '';
      const truncated = c.text.length > 60 ? c.text.slice(0, 60) + '…' : c.text;
      return `<span class="mr-rt-quote-chip ${slotCls}" data-quote-idx="${i}">
        <span class="mr-rt-quote-label">💎 第${c.turnN}轮 ${escapeHtml(c.slotLabel)}</span>
        <span class="mr-rt-quote-text">"${escapeHtml(truncated)}"</span>
        <button class="mr-rt-quote-close" data-quote-close="${i}" title="移除此引用">✕</button>
      </span>`;
    }).join('');
    row.querySelectorAll('[data-quote-close]').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const idx = parseInt(btn.getAttribute('data-quote-close'), 10);
        if (!isNaN(idx) && idx >= 0 && idx < _rtQuoteChips.length) {
          _rtQuoteChips.splice(idx, 1);
          _renderQuoteChips();
        }
      });
    });
  }

  function _addQuoteChip(meeting, sid, text) {
    if (!sid || !text || !text.trim()) return;
    if (_rtQuoteChips.length >= 5) return;  // 最多 5 条引用 (避免 prompt 爆炸)
    const slots = _getRtSlots(meeting);
    const slotIndex = slots.findIndex(s => s && s.sid === sid);
    const slot = (slotIndex >= 0 && slotIndex < slots.length) ? slots[slotIndex] : null;
    if (!slot) return;
    const cached = _rtPanelState[meeting.id];
    const turnsArr = (cached && Array.isArray(cached.turns)) ? cached.turns : [];
    const turnN = turnsArr.length > 0 ? (turnsArr[turnsArr.length - 1].n || turnsArr.length) : 1;
    _rtQuoteChips.push({
      sid, slotIndex,
      slotLabel: slot.label || sid.slice(0, 8),
      turnN,
      text: text.trim().slice(0, 500),  // 单条最长 500 字符
    });
    _renderQuoteChips();
  }

  function _clearQuoteChips() {
    if (_rtQuoteChips.length === 0) return;
    _rtQuoteChips = [];
    _renderQuoteChips();
  }

  // mouseup 选区检测 + 浮按钮 (IIFE 顶层一次性挂)
  document.addEventListener('mouseup', function _rtQuoteSelHandler(ev) {
    if (!ev.target || typeof ev.target.closest !== 'function') return;
    const card = ev.target.closest('.mr-ft[data-ft-sid]');
    const hideBtn = () => { if (_rtQuoteFloatBtn) _rtQuoteFloatBtn.style.display = 'none'; };
    if (!card) { hideBtn(); return; }
    const sel = window.getSelection();
    const selText = sel ? sel.toString().trim() : '';
    if (!selText || selText.length < 2) { hideBtn(); return; }
    // 选区起点必须在卡片 bottom 区(.mr-ft-bottom)内 — 排除 row1/row2 状态文本被误选
    const anchorEl = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    if (!anchorEl || !anchorEl.closest('.mr-ft-bottom')) { hideBtn(); return; }
    const sid = card.getAttribute('data-ft-sid');
    if (!sid) { hideBtn(); return; }
    let range; try { range = sel.getRangeAt(0); } catch { hideBtn(); return; }
    const rect = range.getBoundingClientRect();
    // lazy 创建浮按钮
    if (!_rtQuoteFloatBtn) {
      _rtQuoteFloatBtn = document.createElement('button');
      _rtQuoteFloatBtn.id = 'mr-rt-quote-float-btn';
      _rtQuoteFloatBtn.className = 'mr-rt-quote-float-btn';
      _rtQuoteFloatBtn.type = 'button';
      _rtQuoteFloatBtn.textContent = '💎 引用追问';
      _rtQuoteFloatBtn.title = '把选中文本作为引用加入下一轮 prompt (Phase 3 F6)';
      document.body.appendChild(_rtQuoteFloatBtn);
      _rtQuoteFloatBtn.addEventListener('mousedown', (e) => e.preventDefault()); // 防失焦清选区
      _rtQuoteFloatBtn.addEventListener('click', () => {
        const fSid = _rtQuoteFloatBtn.dataset.sid;
        const fText = _rtQuoteFloatBtn.dataset.text;
        const mid = activeMeetingId;
        const meeting = meetingData[mid];
        if (fSid && fText && meeting) _addQuoteChip(meeting, fSid, fText);
        _rtQuoteFloatBtn.style.display = 'none';
        try { window.getSelection().removeAllRanges(); } catch {}
      });
    }
    _rtQuoteFloatBtn.dataset.sid = sid;
    _rtQuoteFloatBtn.dataset.text = selText;
    _rtQuoteFloatBtn.style.display = 'inline-flex';
    // 选区右上方 + window scroll 偏移
    _rtQuoteFloatBtn.style.top = `${rect.top + window.scrollY - 34}px`;
    _rtQuoteFloatBtn.style.left = `${rect.right + window.scrollX - 90}px`;
  });

  // F0 + F3 Phase 1/2 + Phase 5: 全局 Esc — 退出聚焦/对比/时光机。IIFE 顶层挂载, 只挂一次。
  document.addEventListener('keydown', function _rtFocusEscHandler(ev) {
    if (ev.key !== 'Escape') return;
    // F6: Esc 也关闭引用浮按钮
    if (_rtQuoteFloatBtn && _rtQuoteFloatBtn.style.display !== 'none') {
      _rtQuoteFloatBtn.style.display = 'none';
    }
    if (_rtFocusedCardSid) {
      _rtFocusedCardSid = null;
      document.body.classList.remove('mr-card-focus-on');
    }
    if (_rtCompareSlots.size > 0) _clearCompareSelect();
    // Phase 5: Esc 退出时光机模式(对当前 active meeting)。
    //   meetings 是 plain object(不是 Map), 用 meetings[id] 取
    if (typeof activeMeetingId !== 'undefined' && activeMeetingId && _rtViewingTurnN[activeMeetingId]) {
      delete _rtViewingTurnN[activeMeetingId];
      const m = (typeof meetings !== 'undefined' && meetings) ? meetings[activeMeetingId] : null;
      if (m) refreshRoundtablePanel(m);
    }
  });
  document.addEventListener('click', function _rtFocusBlankClickHandler(ev) {
    if (ev.target && ev.target.closest && ev.target.closest('.mr-ft')) return;
    if (_rtFocusedCardSid) {
      _rtFocusedCardSid = null;
      document.body.classList.remove('mr-card-focus-on');
    }
    if (_rtCompareSlots.size > 0) _clearCompareSelect();
  });

  // 2026-05-05 道雪：聚焦主卡 Ctrl+滚轮缩放字号。IIFE 顶层挂载只挂一次。
  //   - CSS 变量 --card-font-focus-scale 挂在 body 上，沿 DOM 树继承到 .mr-ft.active
  //     的子元素 calc()，所以这里只 set 一次 body.style 就够，无需 MutationObserver
  //     等 .active 卡渲出来后再写
  //   - handler 内判断 mr-card-focus-on + e.target 在主卡内才响应
  //   - preventDefault 拦掉 Electron 默认整窗 zoom（仅主卡内拦，主卡外仍可整窗 zoom）
  //   - clamp [0.8, 2.0] 步进 0.1，持久化到 localStorage，下次启动沿用
  const CARD_FOCUS_SCALE_KEY = 'mr-card-focus-font-scale';
  const CARD_FOCUS_SCALE_MIN = 0.8;
  const CARD_FOCUS_SCALE_MAX = 2.0;
  const CARD_FOCUS_SCALE_STEP = 0.1;
  const CARD_FOCUS_SCALE_DEFAULT = 1.3;
  let _cardFocusFontScale = (() => {
    const raw = parseFloat(localStorage.getItem(CARD_FOCUS_SCALE_KEY));
    return (Number.isFinite(raw) && raw >= CARD_FOCUS_SCALE_MIN && raw <= CARD_FOCUS_SCALE_MAX) ? raw : CARD_FOCUS_SCALE_DEFAULT;
  })();
  function _applyCardFocusScale(s) {
    _cardFocusFontScale = Math.max(CARD_FOCUS_SCALE_MIN, Math.min(CARD_FOCUS_SCALE_MAX, Math.round(s * 10) / 10));
    document.body.style.setProperty('--card-focus-font-scale', String(_cardFocusFontScale));
    try { localStorage.setItem(CARD_FOCUS_SCALE_KEY, String(_cardFocusFontScale)); } catch {}
  }
  // 启动时把上次/默认 scale 写到 body —— 之后任何 .active 卡渲染都自动继承
  _applyCardFocusScale(_cardFocusFontScale);
  document.body.addEventListener('wheel', function _rtCardFocusWheelHandler(e) {
    if (!e.ctrlKey) return;
    if (!document.body.classList.contains('mr-card-focus-on')) return;
    const inActive = e.target && e.target.closest && e.target.closest('.mr-ft.active');
    if (!inActive) return;
    e.preventDefault();
    e.stopPropagation();
    const dir = e.deltaY < 0 ? +1 : -1;
    _applyCardFocusScale(_cardFocusFontScale + dir * CARD_FOCUS_SCALE_STEP);
  }, { passive: false });
  // Stage 2 容错升级：每轮 prompt 发送时间戳（用于 manual-extract IPC 的 sincePromptTs 参数）
  const _rtTurnStartTs = {};

  // Card optimization Task 9（2026-05-01）— 沉浸/调试模式 per-meetingId 状态（renderer 内存镜像）。
  //   首次 openMeeting 走 IPC 'get-immersive-mode' 拿主进程持久化值；切换走 'save-immersive-mode' 写回。
  //   _toggleMeetingMode 切换 panel.classList.immersive + 按钮 .active class + icon/label 文本。
  const _immersiveByMeeting = {};

  // markdown 渲染（用项目已有的 marked + DOMPurify）
  let _markedCache = null;
  let _domPurifyCache = null;

  // 卡片优化（2026-05-03 道雪）：与 renderer.js 的 ABS_PATH_RE 同源 — 绝对路径
  //   (Windows C:\... / UNC \\server\... / ~ 起始)，扩展名 1-8 ASCII。圆桌卡片
  //   场景下 AI 输出多绝对路径；相对路径需 cwd 上下文，本卡片层不易拿到，先不做。
  const _ABS_PATH_RE = /(?:[A-Za-z]:[\\/]|\\\\[^\\/:*?"<>|\r\n\s]+\\|~[\\/])(?:[^\\/:*?"<>|\r\n\s]+[\\/])*[^\\/:*?"<>|\r\n\s]+\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9])/g;

  function _activeMeetingCwd() {
    const meeting = activeMeetingId ? meetingData[activeMeetingId] : null;
    const subs = meeting && Array.isArray(meeting.subSessions) ? meeting.subSessions : [];
    for (const sid of subs) {
      try {
        const s = (typeof sessions !== 'undefined' && sessions && typeof sessions.get === 'function')
          ? sessions.get(sid)
          : null;
        if (s && s.cwd) return s.cwd;
      } catch {}
    }
    return null;
  }

  // marked 渲染后扫描非 <pre> 文本节点的绝对路径，包成
  // <a class="rt-file-link" data-path="..."> 让用户点击进 hub 内置 preview 面板。
  //
  // 不跳过 <code>（单 inline code）：AI 通常用 `\`path\`` 标注路径，理应可点击。
  //   `<code>C:\foo.html</code>` 会被升级成 `<code><a>C:\foo.html</a></code>`
  //   既保留 code 灰底等宽视觉，又得到链接行为。
  // 跳过 <pre>（多行代码块）：bash/python 脚本里的路径是命令参数，识别会误伤
  //   （如 `python C:\script.py --arg` 包路径会让脚本视觉断开）。
  // 2026-05-03 道雪：从 SKIP 移除 CODE 是用户场景反馈：历史回答面板的路径
  //   出现在 inline code 内，原 skip CODE 让它没有 link。
  function _wrapFilePathsInDom(rootEl) {
    if (typeof window !== 'undefined' && typeof window.wrapPathLinksInElement === 'function') {
      window.wrapPathLinksInElement(rootEl, { cwd: _activeMeetingCwd() });
      return;
    }
    const SKIP_TAGS = new Set(['PRE', 'A', 'SCRIPT', 'STYLE']);
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        let p = node.parentNode;
        while (p && p !== rootEl) {
          if (p.nodeType === 1 && SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
          p = p.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const targets = [];
    let n;
    while ((n = walker.nextNode())) {
      _ABS_PATH_RE.lastIndex = 0;
      if (_ABS_PATH_RE.test(n.nodeValue || '')) targets.push(n);
    }
    for (const node of targets) {
      const text = node.nodeValue;
      _ABS_PATH_RE.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      let m;
      while ((m = _ABS_PATH_RE.exec(text)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (start > last) frag.appendChild(document.createTextNode(text.slice(last, start)));
        const a = document.createElement('a');
        a.className = 'rt-file-link';
        a.setAttribute('data-path', m[0]);
        a.title = m[0];
        a.textContent = m[0];
        frag.appendChild(a);
        last = end;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
  }

  // Phase 6(2026-05-05 道雪): prismjs lazy-load + 常用语言注册 — markdown 代码块语法高亮。
  //   prismjs 已 deps in package.json (^1.30.0), 默认带 markup/css/clike/javascript;
  //   bash/python/typescript/rust/go/json/yaml/sql/markdown 等需单独 require components。
  //   _prismCache: null=未尝试 / Prism object=成功 / false=失败(有 try/catch 兜底)
  let _prismCache = null;
  function _getPrism() {
    if (_prismCache !== null) return _prismCache || null;
    try {
      const Prism = require('prismjs');
      // Prism 默认已含 markup/css/clike/javascript; 显式加载常用扩展语言
      ['bash', 'python', 'typescript', 'jsx', 'tsx', 'rust', 'go', 'json', 'yaml', 'sql', 'markdown'].forEach(lang => {
        try { require('prismjs/components/prism-' + lang); } catch {}
      });
      _prismCache = Prism;
      return Prism;
    } catch (e) {
      _prismCache = false;
      return null;
    }
  }
  function _highlightCodeBlocks(wrapper) {
    const Prism = _getPrism();
    if (!Prism) return;
    wrapper.querySelectorAll('pre code[class*="language-"]').forEach(code => {
      const langClass = Array.from(code.classList).find(c => c.startsWith('language-'));
      if (!langClass) return;
      const lang = langClass.slice('language-'.length);
      if (!Prism.languages[lang]) return;
      try {
        const html = Prism.highlight(code.textContent, Prism.languages[lang], lang);
        code.innerHTML = html;
      } catch {}
    });
  }

  function _renderMarkdown(text) {
    if (!text) return '';
    try {
      if (!_markedCache) _markedCache = require('marked').marked;
      if (!_domPurifyCache) _domPurifyCache = require('dompurify');
      const sanitized = _domPurifyCache.sanitize(
        _markedCache.parse(text, { breaks: true, gfm: true }),
        { ADD_ATTR: ['data-path', 'class'] }
      );
      // 后处理：扫文件路径包 <a class="rt-file-link"> 让用户点开预览（卡片优化 2026-05-03）。
      //   注意必须在 sanitize 之后做，因为我们新增的 <a> 元素文本来自 sanitize 后的 textContent
      //   （已 escape），data-path 也是从同一字符串复制，无注入风险。
      const wrapper = document.createElement('div');
      wrapper.innerHTML = sanitized;
      _wrapFilePathsInDom(wrapper);
      // Phase 6: 代码块语法高亮(prism token classes), CSS 提供 token 颜色
      _highlightCodeBlocks(wrapper);
      return wrapper.innerHTML;
    } catch (e) {
      // 回退到纯文本（escapeHtml）
      return escapeHtml(text).replace(/\n/g, '<br>');
    }
  }

  // 卡片优化（2026-05-03 道雪）：路径链接 click 全局委托。
  //   meeting-room.js IIFE 内 setup 一次（IIFE 只运行一次，幂等）。捕获阶段
  //   先于 marked HTML 内任何 a 元素的默认行为，让 .rt-file-link 路由到 hub
  //   内置 preview 面板（renderer.js 全局函数 openPreviewPanel）。
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a.rt-file-link');
    if (!a) return;
    const path = a.getAttribute('data-path');
    if (!path) return;
    e.preventDefault();
    e.stopPropagation();
    if (typeof window !== 'undefined' && typeof window.openPathInHub === 'function') {
      window.openPathInHub(path, { cwd: _activeMeetingCwd(), requireExistsForRel: false });
    } else if (typeof openPreviewPanel === 'function') {
      openPreviewPanel(path);
    } else if (typeof window !== 'undefined' && typeof window.openPreviewPanel === 'function') {
      window.openPreviewPanel(path);
    } else {
      console.warn('[mr] openPreviewPanel not found, cannot preview:', path);
    }
  }, true);

  // T7（2026-05-01）：preview blocks 结构化渲染 helper —
  //   transcript-tap 现在直供 { type:'thinking'|'text'|'tool_use', ... } 块数组
  //   thinking → 灰斜体 + 💭 前缀；tool_use → cyan chip 工具调用摘要；text → 复用 _renderMarkdown
  //   工具块上限 8（spec §3.6 R8），超出从前面丢（保留最近）
  function _formatToolUseBlock(block) {
    const name = (block && block.name) || '';
    const input = (block && block.input) || {};
    if (/^(WebSearch|web_search)$/i.test(name)) {
      const q = input.query || input.q || '';
      return `🔍 搜索: "${q}"`;
    }
    if (/^(Read|read_file|read)$/i.test(name)) {
      return `📄 读: ${input.path || input.file || input.file_path || ''}`;
    }
    if (/^(Bash|shell|exec)$/i.test(name)) {
      const cmd = String(input.command || input.cmd || '').slice(0, 60);
      return `⚙ 执行: ${cmd}`;
    }
    if (/^(Edit|Write|edit|write)$/i.test(name)) {
      return `✏ 编辑: ${input.file_path || input.path || ''}`;
    }
    return `🔧 ${name}`;
  }

  function _renderPreviewBlocks(blocks, sid) {
    if (!Array.isArray(blocks) || blocks.length === 0) return '';
    // 工具块只保留最后 8 个，从前面丢（spec §3.6 R8 防 thinking-heavy 卡片膨胀）
    const filtered = [];
    let toolCount = 0;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use') {
        if (toolCount >= 8) continue;
        toolCount++;
      }
      filtered.unshift(b);
    }
    // 2026-05-03 道雪：移除字符截断（改前 thinking 400 / text 2000）。
    //   卡片本身有 max-height + overflow-y 滚动承载长内容；截断会砍掉答案末尾
    //   的关键信息（如评分总评），用户必须开 shell 才能看到，违反"卡片即结论"原则。
    //   "进 shell"入口仍在卡片头部 escape btn，用户需要时可手动切换。
    const html = [];
    for (const block of filtered) {
      if (block.type === 'thinking') {
        const raw = String(block.text || '');
        html.push(`<div class="mr-ft-think">${escapeHtml(raw)}</div>`);
      } else if (block.type === 'tool_use') {
        const summary = _formatToolUseBlock(block);
        html.push(`<span class="mr-ft-tool">${escapeHtml(summary)}</span>`);
      } else if (block.type === 'text') {
        const raw = String(block.text || '');
        html.push(`<div class="mr-ft-md">${_renderMarkdown(raw)}</div>`);
      }
    }
    return html.join('');
  }

  // 注：顶部 scene toggle（圆桌/投研）的 _renderModeToggle/_bindModeToggle 已删除
  //   （2026-05-04 决策：scene 创建时确定，运行时不可切换）。
  //   IPC `switch-scene` handler 保留，避免破坏其它代码路径。

  function _ensureRtPanel() {
    let panel = document.getElementById('mr-roundtable-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'mr-roundtable-panel';
      panel.className = 'mr-rt-panel';
      // Arch refactor 2026-05-02: mr-terminals removed. Anchor the cards panel
      // before mr-toolbar so it occupies the main flex area between header and
      // toolbar / input-row.
      const toolbar = document.getElementById('mr-toolbar');
      if (toolbar && toolbar.parentElement) {
        toolbar.parentElement.insertBefore(panel, toolbar);
      } else {
        const mrPanel = document.getElementById('meeting-room-panel');
        if (mrPanel) mrPanel.appendChild(panel);
      }
    }
    return panel;
  }

  function _removeRtPanel() {
    const p = document.getElementById('mr-roundtable-panel');
    if (p && p.parentElement) p.remove();
  }

  // sub session 信息（kind → {sid, label}）— 用于按 kind 索引找子 session 显示信息。
  // Plan 阶段 2: 改为按 _KIND_LABELS 动态生成 5 家槽位（claude/gemini/codex/deepseek/glm），
  // 自动支持 deepseek/glm 私聊与 @summary。每个 kind 只取首个匹配的 sub-session
  // (5 选 3 + 同 kind 重复 的语义由 slotSpecs 处理，本函数仍按 kind 单值索引)。
  function _getRtSubInfo(meeting) {
    const subs = {};
    for (const kind of Object.keys(_KIND_LABELS)) subs[kind] = null;
    if (!meeting || !meeting.subSessions) return subs;
    for (const sid of meeting.subSessions) {
      const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      if (!s || !s.kind) continue;
      if (subs[s.kind] === null) {
        subs[s.kind] = { sid, label: s.title || _KIND_LABELS[s.kind] || s.kind };
      }
    }
    return subs;
  }

  function _ftCtxClass(pct) {
    if (typeof pct !== 'number') return 'ok';
    if (pct >= 80) return 'high';
    if (pct >= 50) return 'warn';
    return 'ok';
  }

  // Card redesign（2026-05-01）— 卡片统计格式化 helper
  function _formatTokens(n) {
    if (n == null || n === 0) return '-';
    if (n < 1000) return String(n);
    if (n < 1000000) {
      const v = (n / 1000).toFixed(1);
      return v.replace(/\.0$/, '') + 'k';
    }
    return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  }
  function _formatThinkTime(seconds) {
    if (seconds == null || seconds === 0) return '-';
    if (seconds < 60) {
      // 1.0s 显示 1s（秒级），<10s 显示 1 位小数（避免抖动到 1 整数粒度）
      return seconds < 10 ? `${seconds.toFixed(1).replace(/\.0$/, '')}s` : `${Math.round(seconds)}s`;
    }
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s === 0 ? `${m}m` : `${m}m${String(s).padStart(2, '0')}s`;
  }
  function _avatarSrcFor(kind) {
    return ({
      claude: 'assets/pokemon/pikachu.png',
      gemini: 'assets/pokemon/charmander.png',
      codex:  'assets/pokemon/squirtle.png',
      // 下列 kind 都跑在 claude CLI 上（CLAUDE_CONFIG_DIR 隔离）→ 共用皮卡丘
      deepseek: 'assets/pokemon/pikachu.png',
      glm:      'assets/pokemon/pikachu.png',
      gpt:      'assets/pokemon/pikachu.png',
      kimi:     'assets/pokemon/pikachu.png',
      qwen:     'assets/pokemon/pikachu.png',
    })[kind] || '';
  }
  function _avatarFallbackFor(kind) {
    return ({
      claude: '🟡', gemini: '🟠', codex: '🔵',
      deepseek: '🟢', glm: '🟣', gpt: '⚪', kimi: '🟤', qwen: '🔴',
    })[kind] || '🤖';
  }
  // meeting-create-modal（2026-05-01）：圆桌卡片头像与 slot 位置绑定（不与 kind 绑定）。
  //   slot 1 = 皮卡丘永远（即使该 slot 是 DeepSeek）；slot 2 小火龙；slot 3 杰尼龟。
  //   理由：用户视觉上把"slot 位置"和某只宝可梦稳定挂钩，方便快速识别哪一格是哪家。
  //   侧边栏单 session 列表仍按 kind 显头像（_avatarSrcFor），逻辑没变。
  const _SLOT_AVATARS = [
    'assets/pokemon/pikachu.png',
    'assets/pokemon/charmander.png',
    'assets/pokemon/squirtle.png',
  ];
  const _SLOT_AVATAR_FB = ['🟡', '🟠', '🔵'];
  function _avatarBySlot(i) {
    return _SLOT_AVATARS[i] || '';
  }
  function _avatarFallbackBySlot(i) {
    return _SLOT_AVATAR_FB[i] || '🤖';
  }

  // meeting-create-modal（2026-05-01）：按 subSessions 数组顺序还原 slot 数组。
  //   返回 [slot0, slot1, slot2]，每个 slot 是 { sid, kind, slotId, slotIndex, label, displayLabel }
  //     - slotId:        'pikachu' / 'charmander' / 'squirtle'（slot 化 2026-05-03）
  //     - label:         纯英文 slot 名（"Pikachu"），给 prompt / @解析 / 后端字段用
  //     - displayLabel:  双语带 emoji（"⚡ Pikachu · 皮卡丘"），给卡片 UI 用
  function _getRtSlots(meeting) {
    const slots = [null, null, null];
    if (!meeting || !Array.isArray(meeting.subSessions)) return slots;
    for (let i = 0; i < meeting.subSessions.length && i < 3; i++) {
      const sid = meeting.subSessions[i];
      const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      if (!s) continue;
      const slotId = slotIndexToId(i);
      slots[i] = {
        sid,
        kind: s.kind,
        slotId,
        slotIndex: i,
        label: slotId ? getSlotPromptName(slotId) : (s.title || s.kind || `Slot ${i + 1}`),
        displayLabel: slotId ? getSlotDisplayLabel(slotId) : (s.title || s.kind || `Slot ${i + 1}`),
      };
    }
    return slots;
  }

  // 用 ai-kinds.js 的 KIND_LABELS 单一真理源（含 deepseek/glm/gpt/kimi/qwen），未来加新 AI 自动覆盖。
  const _KIND_LABELS = KIND_LABELS;

  // T1（2026-05-04 道雪）：抽出单 slot 卡片渲染，让 partial-update IPC handler
  //   能复用同一份模板做局部 patch（不再 panel.innerHTML 全量替换）。
  //   依赖：函数参数（slotIndex, ctx）+ ctx 字段 { state, currentMode, partialBy, meeting,
  //         slots, lastTurn, meetingId, focused }；
  //         IIFE 私有 helper / 全局：_avatarBySlot, _avatarFallbackBySlot, _renderPreviewBlocks,
  //         isSlotParticipatingThisTurn, _ftCtxClass, _formatThinkTime, _formatTokens, _ftHtml,
  //         _thinkStartTs, _markerStatusCache, _cliReadyCache, _tabState, sessions,
  //         _KIND_LABELS, modelShort, modelClass。
  // 返回：{ html, anyThinking }（anyThinking 由调用方累加，不再 mutate 闭包变量）
  function _renderSlotCard(slotIndex, ctx) {
    const { state, currentMode, partialBy, meeting, slots, lastTurn, meetingId, focused } = ctx;
    const slot = slots[slotIndex];
    if (!slot) return { html: '', anyThinking: false };
    const kind = slot.kind;
    const sub = { sid: slot.sid, label: slot.label };
    const partial = partialBy ? partialBy[sub.sid] : null;
    const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sub.sid) : null;
    const markerState = _markerStatusCache[sub.sid];
    const isInitializing = s && !_cliReadyCache[sub.sid];
    let status = 'idle';
    let preview = '';
    let anyThinking = false;

    if (isInitializing && !partial && !(currentMode && currentMode !== 'idle') && !lastTurn) {
      status = 'initializing';
    } else if (partial) {
      if (partial.status === 'streaming') {
        status = 'streaming';
        preview = partial.text || '';
        anyThinking = true;
      } else if (partial.status === 'absent') {
        status = 'absent';
        preview = '';
      } else if (partial.status === 'errored') {
        status = 'errored';
        preview = '';
      } else if (partial.status === 'manual_extracted') {
        status = 'manual_extracted';
        preview = partial.text || '';
      } else if (partial.status === 'soft_alert') {
        status = 'soft_alert';
        preview = partial.text || '';
        anyThinking = true;
      } else {
        status = partial.status === 'timeout' ? 'timeout' : 'completed';
        preview = partial.text || '';
      }
    } else if (currentMode && currentMode !== 'idle') {
      if (!isSlotParticipatingThisTurn(meeting, slotIndex)) {
        status = lastTurn && lastTurn.by && lastTurn.by[sub.sid] ? 'completed' : 'idle';
        preview = lastTurn ? (lastTurn.by[sub.sid] || '') : '';
      } else {
        status = 'thinking';
        anyThinking = true;
      }
    } else if (lastTurn) {
      const lastStatus = lastTurn.byStatus ? lastTurn.byStatus[sub.sid] : null;
      if (lastStatus === 'errored') {
        status = 'errored';
      } else if (lastStatus === 'absent') {
        status = 'absent';
      } else if (lastStatus === 'manual_extracted') {
        status = 'manual_extracted';
        preview = lastTurn.by[sub.sid] || '';
      } else if (lastTurn.by[sub.sid]) {
        status = 'completed';
        preview = lastTurn.by[sub.sid];
      }
    }

    const isActive = sub.sid === focused;
    const modelName = s && s.currentModel ? (typeof modelShort === 'function' ? modelShort(s.currentModel) : s.currentModel.displayName || '') : '';
    const modelCls = s && s.currentModel && typeof modelClass === 'function' ? modelClass(s.currentModel.id) : '';
    const ctxPct = s && typeof s.contextPct === 'number' ? s.contextPct : null;
    const ctxCls = _ftCtxClass(ctxPct);
    const labelDisplay = slot.displayLabel;

    let statusForLabel = status;
    if (partial && partial.sendStatus === 'stuck') statusForLabel = 'send_stuck';
    const statusLabel = {
      idle: '待命',
      initializing: '创建中…',
      thinking: '思考中',
      streaming: '输出中',
      completed: '已答 ✓',
      timeout: '超时',
      manual_extracted: '已答 ✓ 手动',
      absent: '本轮缺席',
      soft_alert: '等待中…',
      send_stuck: '⚠ 输入卡顿，请点 📤 发送',
      errored: '错误',
      interrupted: '已中断',
      transport_lost: '连接断开',
    }[statusForLabel] || statusForLabel;
    const tabState = _tabState[sub.sid] || 'idle';
    const newBadge = tabState === 'new-output' && !isActive ? '<span class="mr-ft-new">NEW</span>' : '';

    const blocksFromPartial = (partial && Array.isArray(partial.blocks) && partial.blocks.length > 0)
      ? partial.blocks : null;
    const textFromPartial = (partial && typeof partial.text === 'string' && partial.text)
      ? partial.text : null;
    const textFromHistory = (!partial && lastTurn && lastTurn.by && lastTurn.by[sub.sid])
      ? lastTurn.by[sub.sid] : null;

    let bottomHtml = '';
    if (status === 'thinking') {
      if (!_thinkStartTs[meetingId]) _thinkStartTs[meetingId] = Date.now();
      bottomHtml = `<div class="mr-ft-progress"><div class="mr-ft-progress-bar slot-${slotIndex + 1}"></div></div>`;
    } else if (status === 'streaming') {
      if (!_thinkStartTs[meetingId]) _thinkStartTs[meetingId] = Date.now();
      let inner;
      if (blocksFromPartial) {
        inner = _renderPreviewBlocks(blocksFromPartial, sub.sid);
      } else if (textFromPartial) {
        inner = _renderPreviewBlocks([{ type: 'text', text: textFromPartial }], sub.sid);
      } else {
        const elapsedSec = _thinkStartTs[meetingId]
          ? Math.round((Date.now() - _thinkStartTs[meetingId]) / 1000) : 0;
        const elapsedTxt = _formatThinkTime(elapsedSec);
        const liveLen = (partial && typeof partial.cleanBufLen === 'number') ? partial.cleanBufLen : 0;
        const lenTxt = liveLen > 0 ? ` · 已输出约 ${liveLen} 字` : '';
        inner = `<div class="mr-ft-thinking-placeholder">💭 思考中 ${elapsedTxt}${lenTxt}<br><span class="mr-ft-thinking-hint">详情请点击左侧子 session 查看</span></div>`;
      }
      bottomHtml = `<div class="mr-ft-preview streaming mr-ft-preview-md">${inner}<span class="mr-ft-cursor"></span></div>`;
    } else if (blocksFromPartial || textFromPartial || textFromHistory) {
      let inner;
      if (blocksFromPartial) {
        inner = _renderPreviewBlocks(blocksFromPartial, sub.sid);
      } else if (textFromPartial) {
        inner = _renderPreviewBlocks([{ type: 'text', text: textFromPartial }], sub.sid);
      } else {
        inner = _renderPreviewBlocks([{ type: 'text', text: textFromHistory }], sub.sid);
      }
      bottomHtml = `<div class="mr-ft-preview mr-ft-preview-md">${inner}</div>`;
    } else {
      bottomHtml = '<div class="mr-ft-preview" style="opacity:0.5;font-style:italic">等待…</div>';
    }

    const aiStats = (state.aiStats && (state.aiStats[sub.sid] || state.aiStats[kind]))
      || { totalThinkSec: 0, totalTokens: 0 };
    let thinkCurrentSec = 0;
    let tokensCurrentN = 0;
    if (status === 'thinking' || status === 'streaming') {
      thinkCurrentSec = _thinkStartTs[meetingId]
        ? Math.round((Date.now() - _thinkStartTs[meetingId]) / 1000) : 0;
      if (partial && partial.tokens && typeof partial.tokens.total === 'number') {
        tokensCurrentN = partial.tokens.total;
      }
    } else if (lastTurn && lastTurn.thinkSecBy && lastTurn.thinkSecBy[sub.sid] != null) {
      thinkCurrentSec = lastTurn.thinkSecBy[sub.sid] || 0;
      tokensCurrentN = (lastTurn.tokensBy && lastTurn.tokensBy[sub.sid]) || 0;
    }
    const thinkCurrent = _formatThinkTime(thinkCurrentSec);
    const thinkTotal   = _formatThinkTime(aiStats.totalThinkSec || 0);
    const tokensCurrent = _formatTokens(tokensCurrentN);
    const tokensTotal   = _formatTokens(aiStats.totalTokens || 0);

    const sendStuck = !!(partial && partial.sendStatus === 'stuck');

    // F4 Phase 2(2026-05-04 道雪 / v3 多方审查后修订 2026-05-04): 上一轮注入血缘 chip(渲染层推断式, 不动后端)
    //   语义: "本轮卡片显示的内容"参考了"上一轮"谁的发言。
    //
    //   关键修订(v3): 用 currentMode 作为"运行中 vs idle 回顾态"的判断 (Gemini 多方审查推荐) —
    //     之前用 partial 存在与否, 但 partial 清空 vs turns push 第 N 轮 不是原子操作,
    //     存在时序窗口期内 chip 显示的轮次号会闪烁突变。currentMode 切换是后端原子动作, 更可靠。
    //
    //     场景 A: currentMode !== 'idle' (本轮运行中, 含 thinking/streaming/刚 settle/manual_extracted)
    //       → 卡片渲染本轮内容; turns 还没含本轮; lastTurn 是 N-1 轮 ✓
    //       → lineageRefTurn = lastTurn
    //
    //     场景 B: currentMode === 'idle' (回顾稳定态, 全员答完后)
    //       → 卡片渲染 turns 最后一项(=第 N 轮)的 by 内容; lastTurn 此时 = N (本轮自己)
    //       → "本轮"的"上一轮"是 turns[N-2] ≠ lastTurn ✓
    //
    //   规则: 本轮 sid X 的血缘 = lineageRefTurn.by 中除 X 外的所有 sid (排除 absent/errored)
    //   实现限制: 不点击跳转(避免 _openRtTimeline 加 initialTurnN); chip hover tooltip
    //   spec §F4 同组跳过(pilot→pilot/observer→observer)由后端 prompt 注入决定, UI 仅展示参考
    let lineageHtml = '';
    let lineageRefTurn = null;
    const turnsArr = (state && Array.isArray(state.turns)) ? state.turns : [];
    if (currentMode === 'idle' && (status === 'completed' || status === 'manual_extracted')) {
      // 场景 B: idle 回顾态(稳定) → lineage 来自 turns[N-2]
      if (turnsArr.length >= 2) lineageRefTurn = turnsArr[turnsArr.length - 2];
    } else if (currentMode && currentMode !== 'idle'
               && (status === 'thinking' || status === 'streaming'
                   || status === 'completed' || status === 'manual_extracted')) {
      // 场景 A: 本轮运行中(thinking/streaming/刚 settle 等) → lineage 来自 lastTurn (=N-1)
      lineageRefTurn = lastTurn;
    }
    if (lineageRefTurn && lineageRefTurn.by && typeof lineageRefTurn.n === 'number') {
      const refByMap = lineageRefTurn.by || {};
      const refByStatus = lineageRefTurn.byStatus || {};
      const otherSpeakers = Object.keys(refByMap).filter(s => {
        if (s === sub.sid) return false;
        const st = refByStatus[s];
        if (st === 'absent' || st === 'errored') return false;
        if (!refByMap[s] && st !== 'manual_extracted') return false;
        return true;
      });
      if (otherSpeakers.length > 0) {
        const chips = otherSpeakers.map(spkSid => {
          const spkSlot = slots.findIndex(slot => slot && slot.sid === spkSid);
          // Gemini #4 修订: 加 slots 上界检查 (虽然 findIndex 返回 -1 时已过滤, 但 length 防御深一层更稳)
          const inBounds = spkSlot >= 0 && spkSlot < slots.length && slots[spkSlot];
          const spkSlotCls = inBounds ? `slot-${spkSlot + 1}` : '';
          const spkLabel = inBounds ? slots[spkSlot].label : spkSid.slice(0, 8);
          return `<span class="mr-ft-lineage-chip ${spkSlotCls}" title="本轮内容参考了 ${escapeHtml(spkLabel)} 第 ${lineageRefTurn.n} 轮的发言">↪ ${escapeHtml(spkLabel)} 第${lineageRefTurn.n}轮</span>`;
        }).join('');
        lineageHtml = `<div class="mr-ft-lineage" title="本轮 AI 参考了上一轮谁的发言">${chips}</div>`;
      }
    }

    const html = _ftHtml(
      kind, isActive, sub.sid, labelDisplay, statusLabel, status,
      modelName, modelCls, ctxPct, ctxCls, bottomHtml,
      thinkCurrent, thinkTotal, tokensCurrent, tokensTotal, newBadge,
      slotIndex, sendStuck, lineageHtml
    );
    return { html, anyThinking };
  }

  function _renderFusedTabs(state, subs, currentMode, partialBy, meeting) {
    const meetingId = meeting && meeting.id;
    // Phase 5(2026-05-05 道雪): 时光机模式 — viewingTurnN 设置则将 ctx 切换到该历史轮快照,
    //   _renderSlotCard 内部 "已完成轮 → 显示 lastTurn.by[sid]" 分支(line 723-735)直接复用,
    //   纯前端切换。partialBy 设为 null + currentMode 设为 'idle' 避免触发 thinking/streaming 分支。
    const viewN = _rtViewingTurnN[meetingId];
    const isTimeTravel = (typeof viewN === 'number' && viewN >= 1 && viewN <= state.turns.length);
    const effectiveLastTurn = isTimeTravel
      ? state.turns[viewN - 1]
      : (state.turns.length > 0 ? state.turns[state.turns.length - 1] : null);
    const effectivePartialBy = isTimeTravel ? null : partialBy;
    const effectiveCurrentMode = isTimeTravel ? 'idle' : currentMode;

    const tabs = [];
    const focused = (Array.isArray(meeting.subSessions) && meeting.subSessions.includes(meeting.focusedSub))
      ? meeting.focusedSub
      : meeting.subSessions[0];
    let anyThinking = false;
    const slots = _getRtSlots(meeting);
    const ctx = {
      state, currentMode: effectiveCurrentMode, partialBy: effectivePartialBy,
      meeting, slots, lastTurn: effectiveLastTurn, meetingId, focused,
      isTimeTravel,
    };
    for (let slotIndex = 0; slotIndex < 3; slotIndex++) {
      const { html, anyThinking: t } = _renderSlotCard(slotIndex, ctx);
      if (html) tabs.push(html);
      if (t) anyThinking = true;
    }
    if (!anyThinking && meetingId) delete _thinkStartTs[meetingId];
    const stripCls = isTimeTravel ? 'mr-ft-strip mr-ft-timetravel' : 'mr-ft-strip';
    return `<div class="${stripCls}">${tabs.join('')}</div>`;
  }

  function _renderCardViewTabs(meeting) {
    if (!_isCardTabMode() || !meeting) return '';
    const slots = _getRtSlots(meeting);
    const focused = (Array.isArray(meeting.subSessions) && meeting.subSessions.includes(meeting.focusedSub))
      ? meeting.focusedSub
      : meeting.subSessions[0];
    const items = [];
    for (let slotIndex = 0; slotIndex < 3; slotIndex++) {
      const slot = slots[slotIndex];
      if (!slot || !slot.sid) continue;
      const slotCls = `slot-${slotIndex + 1}`;
      const active = slot.sid === focused;
      const label = slot.label || getKindLabel(slot.kind) || `AI ${slotIndex + 1}`;
      const kind = slot.kind ? getKindLabel(slot.kind) : '';
      items.push(`<button type="button" class="mr-card-view-tab ${slotCls}${active ? ' active' : ''}" data-rt-card-tab-sid="${escapeHtml(slot.sid)}" title="${escapeHtml(kind || label)}">
        <span class="mr-card-view-tab-dot"></span>
        <span class="mr-card-view-tab-label">${escapeHtml(label)}</span>
      </button>`);
    }
    if (!items.length) return '';
    return `<div class="mr-card-view-tabs" role="tablist" aria-label="AI cards">${items.join('')}</div>`;
  }

  function _ftHtml(kind, isActive, sid, name, statusLabel, statusCls, modelName, modelCls, ctxPct, ctxCls, bottomHtml,
                   thinkCurrent, thinkTotal, tokensCurrent, tokensTotal, newBadge, slotIndex, sendStuck, lineageHtml) {
    // 圆桌主题色按 slot 上色（slot 1/2/3 = 皮卡丘/小火龙/杰尼龟），与 kind 解耦：
    // kind 仍保留为 data-attribute 标识 AI 身份，但 CSS 视觉风格只跟槽位走，
    // 未来加任意 AI 都不需要补 CSS。
    const slotIdx = (typeof slotIndex === 'number' && slotIndex >= 0) ? slotIndex : 0;
    const slotCls = `slot-${slotIdx + 1}`;
    const cls = ['mr-ft', slotCls];
    if (isActive) cls.push('active');
    // Card redesign：thinking-card / streaming-card 触发头像 bounce 动画
    if (statusCls === 'thinking') cls.push('thinking-card');
    else if (statusCls === 'streaming') cls.push('streaming-card');
    // Phase 6(2026-05-05 道雪): completed-card → 触发头像旁完成打勾动画(0.4s 弹出 + 留显)
    else if (statusCls === 'completed' || statusCls === 'manual_extracted') cls.push('completed-card');
    // T6（2026-05-03）：send-stuck 数据驱动，refreshRoundtablePanel 重渲后保留
    if (sendStuck) cls.push('send-stuck');

    const modelBadge = modelName ? `<span class="mr-ft-model ${slotCls}">${escapeHtml(modelName)}</span>` : '';
    const ctxBadge = ctxPct !== null ? `<span class="mr-ft-ctx ${ctxCls}">Ctx ${ctxPct}%</span>` : '';

    // 圆桌卡片头像与 slot 位置绑定（不与 kind 绑定）。
    //   slot 1 永远皮卡丘，slot 2 永远小火龙，slot 3 永远杰尼龟，便于用户视觉识别
    //   "哪一格是哪家"。CSS 主题色亦按 slot 上色（见 .mr-ft.slot-N），kind 仅作 data-attribute。
    const avatarSrc = _avatarBySlot(slotIdx);
    const avatarFb = _avatarFallbackBySlot(slotIdx);
    const avatarHtml = avatarSrc
      ? `<div class="mr-ft-avatar"><img src="${avatarSrc}" alt="${kind || 'slot' + (slotIdx + 1)}" onerror="this.parentNode.textContent='${avatarFb}'; this.parentNode.style.cssText+=';display:flex;align-items:center;justify-content:center;font-size:30px;'"></div>`
      : `<div class="mr-ft-avatar" style="display:flex;align-items:center;justify-content:center;font-size:30px;">${avatarFb}</div>`;

    // Stage 2 容错升级：角标（绝对定位卡片右上角）—— 区分手动提取 / 缺席态
    let cornerBadge = '';
    if (statusCls === 'manual_extracted') cornerBadge = '<span class="mr-ft-corner-badge manual">手动</span>';
    else if (statusCls === 'absent') cornerBadge = '<span class="mr-ft-corner-badge absent">缺席</span>';

    // 2026-05-02 修订：逃生按钮**永久常驻**（用户血泪反馈：按钮"莫名其妙消失"
    //   再次发生）。无论卡片状态（idle/completed/thinking/error/...），两大按钮始终
    //   显示，给用户随时可用的兜底口：
    //     [一键提取]    — 任何状态都能从 transcript 直读拼接
    //     [跳过]        — 任何状态都能跳过本轮 / 暂停后续期待
    //   仅 [🔄 重新拉起] 保持仅终态显示（idle 没什么可拉起的，会让用户困惑）。
    //   截断提示链接（.mr-truncated-hint）仍可触发 enter-shell 切到子 session 主区。
    const isTerminalErrorState = statusCls === 'errored' || statusCls === 'absent';
    const relaunchBtn = isTerminalErrorState
      ? `<button class="mr-ft-escape-btn" data-rt-escape="resend" data-rt-sid="${sid}" data-rt-kind="${kind}" title="重新拉起该家：重发本轮 prompt">🔄 重新拉起</button>`
      : '';
    const escapeBar = `
      <div class="mr-ft-escape-bar">
        <button class="mr-ft-escape-btn" data-rt-escape="extract" data-rt-sid="${sid}" data-rt-kind="${kind}" title="从 transcript 直读拼接（卡死时绕过完成检测）">一键提取</button>
        <button class="mr-ft-escape-btn" data-rt-escape="skip" data-rt-sid="${sid}" data-rt-kind="${kind}" title="本轮跳过这家，下游 prompt 不引用">跳过</button>
        <button class="mr-ft-escape-btn" data-rt-escape="resend-prompt" data-rt-sid="${sid}" data-rt-kind="${kind}" title="重发本轮 prompt 给该家（自动判定输入框是否已含 prompt）">📤 发送</button>
        ${relaunchBtn}
      </div>`;

    // T8（2026-05-01）：row3/row4 stats 合并到 row1/row2 末尾（margin-left:auto push to right），
    //   删除 row3/row4 div，让 preview 区多 ~44px 给 markdown 内容。
    //   timeout 着色迁移：原 .mr-ft-row3.timeout .mr-ft-stat-current 高亮，
    //   现统一以 .mr-ft-row1.timeout .mr-ft-stat-inline 着色（CSS 处理）。
    const row1TimeoutCls = statusCls === 'timeout' ? ' timeout' : '';
    const timeStat = `<span class="mr-ft-stat-inline" title="本轮 / 累计 思考时间">⏱ <span class="num">${escapeHtml(thinkCurrent)}</span> · ${escapeHtml(thinkTotal)}</span>`;
    const tokenStat = `<span class="mr-ft-stat-inline" title="本轮 / 累计 token">🪙 <span class="num">${escapeHtml(tokensCurrent)}</span> · ${escapeHtml(tokensTotal)}</span>`;

    // F2 Phase 2(2026-05-04 道雪 / spec F2): hover 卡片浮出快捷操作浮条
    //   位置: 卡片右上, ↗ 按钮左侧(避免冲突)
    //   按钮: 📋 复制全文 / @ 追问 / " 引用入下轮(F6 占位, Phase 3 实施)
    //   交互: hover 卡片 0.25s 浮出, 移出消失。stopPropagation 不触发 F0 focus
    const hoverActionsHtml = `<div class="mr-ft-hover-actions">
        <button data-rt-action="copy" data-rt-sid="${sid}" title="复制本卡内容">📋</button>
        <button data-rt-action="mention" data-rt-sid="${sid}" data-rt-kind="${kind}" title="在输入框插入 @ 该家">@</button>
        <button data-rt-action="quote" data-rt-sid="${sid}" title="引用本卡内容入下一轮(Phase 3)">&ldquo;</button>
      </div>`;

    return `<div class="${cls.join(' ')}" data-ft-sid="${sid}" data-ft-kind="${kind}">
      <button class="mr-ft-expand" data-ft-expand-sid="${sid}" data-ft-expand-kind="${kind}" title="展开详细回答">↗</button>${cornerBadge}
      ${hoverActionsHtml}
      <div class="mr-ft-head">
        ${avatarHtml}
        <div class="mr-ft-info">
          <div class="mr-ft-row1${row1TimeoutCls}">
            <span class="mr-ft-name ${slotCls}">${name}</span>
            <span class="mr-ft-status ${statusCls}${sendStuck ? ' send-stuck' : ''}">${statusLabel}</span>${newBadge}
            ${timeStat}
          </div>
          <div class="mr-ft-row2">${modelBadge}${ctxBadge}${tokenStat}${_memBadgesHtml(activeMeetingId, slotIdx, sid)}</div>
          ${lineageHtml || ''}
        </div>
      </div>
      <div class="mr-ft-bottom">${bottomHtml}${escapeBar}</div>
    </div>`;
  }

  // 圆桌记忆 phase 1（2026-05-07）：右上角 📒 N / 📥 / 📊 三个按钮
  //   📒 N — 个体 .md 条目数。点击 → 打开 {slot}.md。N=0 也显示（点了会创建空文件 + header）
  //   📥   — 仅 pending-{slot}.json 含 status='pending' 的 item 时显示（带数字 dot）
  //   📊   — 仅 _profile.md 存在时显示（worker 派生的共识层；阶段 0 不存在）
  function _memBadgesHtml(meetingId, slotIdx, sid) {
    if (!meetingId || typeof slotIdx !== 'number' || slotIdx < 0 || slotIdx >= SLOT_IDS.length) return '';
    const slot = SLOT_IDS[slotIdx];
    const meta = _memStatusBy[meetingId] && _memStatusBy[meetingId][slot] || { count: 0, pending: 0, hasProfile: false, identity: null, aiKind: null, aiModel: null };
    // Phase 4 tooltip：identity 是家族存储 key（claude/gpt/...），model 是用户可见的具体型号
    //   [silent-failure-hunt] aiModel 来自 session.currentModel.id，理论上来源可控，但
    //     防御性 HTML escape 避免引号 / < 等字符破坏 title 属性。
    const _esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const familyHint = meta.identity ? _esc(meta.identity) + '.md' : '';
    const modelHint = meta.aiModel ? `当前: ${_esc(meta.aiModel)}` : '';
    const idHint = familyHint
      ? (modelHint ? `\n${modelHint} → 写入 ${familyHint}（家族共享）` : `\n写入 ${familyHint}`)
      : '';
    const ownBtn = `<button class="mr-ft-mem-btn" data-rt-mem-action="open-own" data-rt-mem-sid="${sid}" data-rt-mem-slot="${slot}" title="打开家族记忆 .md${idHint}\n${meta.count} 条 entry">📒 ${meta.count}</button>`;
    const inboxBtn = meta.pending > 0
      ? `<button class="mr-ft-mem-btn pending" data-rt-mem-action="open-pending" data-rt-mem-sid="${sid}" data-rt-mem-slot="${slot}" title="打开 inbox 候选${idHint}\n${meta.pending} 条待 AI 采纳/拒绝">📥 <span class="dot">${meta.pending}</span></button>`
      : '';
    const profileBtn = meta.hasProfile
      ? `<button class="mr-ft-mem-btn" data-rt-mem-action="open-profile" data-rt-mem-sid="${sid}" data-rt-mem-slot="${slot}" title="打开 _profile.md（共识层）">📊</button>`
      : '';
    // Phase 2 P1（2026-05-07）：worker 失败状态灯（meeting 级共享 — 仅在第一个 slot 显示，避免冗余）
    let healthBtn = '';
    if (slotIdx === 0) {
      const wh = _memStatusBy[meetingId] && _memStatusBy[meetingId]._worker;
      if (wh && wh.failures > 0) {
        const cls = wh.failures >= 3 ? 'health-bad' : 'health-warn';
        const reason = wh.lastReason || '(原因未知)';
        const reasonAttr = String(reason).replace(/"/g, '&quot;').slice(0, 240);
        healthBtn = `<button class="mr-ft-mem-btn ${cls}" data-rt-mem-action="open-worker" data-rt-mem-sid="${sid}" data-rt-mem-slot="${slot}" title="后台 worker 连续失败 ${wh.failures} 次&#10;最近原因: ${reasonAttr}&#10;点击查看 checkpoint state.json">🧠 ${wh.failures}</button>`;
      }
    }
    return `${ownBtn}${inboxBtn}${profileBtn}${healthBtn}`;
  }

  // Lazy load memory status for a meeting — 通过 IPC 同步三家 count/pending/hasProfile，
  //   有变化才 trigger refreshRoundtablePanel。在 selectMeeting / 圆桌轮完成后调用。
  async function _loadMemoryStatusForMeeting(meeting) {
    if (!meeting || !meeting.id || !Array.isArray(meeting.subSessions)) return;
    const meetingId = meeting.id;
    if (!_memStatusBy[meetingId]) _memStatusBy[meetingId] = {};
    let dirty = false;
    const slotsToCheck = Math.min(meeting.subSessions.length, SLOT_IDS.length);
    for (let i = 0; i < slotsToCheck; i++) {
      const slot = SLOT_IDS[i];
      try {
        const r = await ipcRenderer.invoke('arena:get-memory-status', { meetingId, slot });
        if (!r || !r.ok) continue;
        const cur = _memStatusBy[meetingId][slot];
        // Phase 3：缓存 identity / aiKind / aiModel 用于 tooltip + open 时确认提示
        const identityChanged = !cur || cur.identity !== r.identity;
        if (!cur || cur.count !== r.count || cur.pending !== r.pending || cur.hasProfile !== r.hasProfile || identityChanged) {
          _memStatusBy[meetingId][slot] = {
            count: r.count, pending: r.pending, hasProfile: r.hasProfile,
            identity: r.identity || null, aiKind: r.aiKind || null, aiModel: r.aiModel || null,
          };
          dirty = true;
        }
        // Phase 2 P1（2026-05-07）：worker 健康（meeting 级 — 三家返回相同值，存到 _worker key）
        if (r.workerHealth) {
          const wPrev = _memStatusBy[meetingId]._worker;
          if (!wPrev || wPrev.failures !== r.workerHealth.failures || wPrev.lastReason !== r.workerHealth.lastReason) {
            _memStatusBy[meetingId]._worker = r.workerHealth;
            dirty = true;
          }
        }
      } catch (e) {
        // memory IPC 失败不影响其他 panel 行为，静默 skip
      }
    }
    if (dirty && meetingId === activeMeetingId) {
      const m = meetingData[meetingId];
      if (m) refreshRoundtablePanel(m);
    }
  }

  // Stage 2 P1-2：历史轮次面板状态角标 — 把每家本轮的 byStatus 渲染成 [Claude ✓][Gemini 手动][Codex 缺席]
  // 让用户回看时一眼能看出哪轮哪家"未参与/出错/手动提取"。老格式 byStatus=null 时显示空（默默兼容）。
  const _STATUS_BADGE_CONFIG = {
    completed:        { icon: '✓',   cls: 'completed', title: '已答' },
    manual_extracted: { icon: '手动', cls: 'manual',    title: '手动提取' },
    absent:           { icon: '缺席', cls: 'absent',    title: '本轮缺席' },
    errored:          { icon: '错误', cls: 'errored',   title: '错误未输出' },
    interrupted:      { icon: '中断', cls: 'errored',   title: '已中断' },
    transport_lost:   { icon: '断连', cls: 'errored',   title: '连接断开' },
  };
  function _renderHistoryStatusBadges(turn, sidLabelLookup) {
    if (!turn || !turn.byStatus) return '';
    const badges = [];
    for (const [sid, status] of Object.entries(turn.byStatus)) {
      const cfg = _STATUS_BADGE_CONFIG[status];
      if (!cfg) continue;
      const label = sidLabelLookup ? (sidLabelLookup(sid) || sid.slice(0, 6)) : sid.slice(0, 6);
      badges.push(`<span class="mr-rt-history-status ${cfg.cls}" title="${escapeHtml(label)}: ${cfg.title}">${escapeHtml(label)} ${cfg.icon}</span>`);
    }
    return badges.join('');
  }

  function _renderRtHistory(state, meeting) {
    if (!state.turns || state.turns.length === 0) return '';
    // 构造 sid → label 查表，从 meeting.subSessions 推 kind label
    const sidToLabel = {};
    if (meeting && Array.isArray(meeting.subSessions) && typeof sessions !== 'undefined') {
      for (const sid of meeting.subSessions) {
        const s = sessions.get(sid);
        if (s) sidToLabel[sid] = _KIND_LABELS[s.kind] || s.kind;
      }
    }
    const lookupLabel = sid => sidToLabel[sid] || sid.slice(0, 6);

    const items = state.turns.map(t => {
      const userIn = (t.userInput || '').slice(0, 60);
      const meta = t.decisionTitle ? ` · 标题: ${escapeHtml(t.decisionTitle.slice(0, 40))}` : '';
      const statusBadges = _renderHistoryStatusBadges(t, lookupLabel);
      return `<div class="mr-rt-history-item">
        <span class="mr-rt-history-turn">第 ${t.n} 轮</span>
        <span class="mr-rt-history-mode ${escapeHtml(t.mode)}">${escapeHtml(t.mode)}</span>
        <span class="mr-rt-history-input">${escapeHtml(userIn)}${(t.userInput || '').length > 60 ? '…' : ''}</span>
        <span class="mr-rt-history-meta">${meta}</span>
        ${statusBadges ? `<span class="mr-rt-history-statuses">${statusBadges}</span>` : ''}
      </div>`;
    }).join('');
    const expanded = _rtHistoryExpanded;
    const toggle = `<span class="mr-rt-history-toggle" id="mr-rt-history-toggle">${expanded ? '▾' : '▸'} 历史轮次（${state.turns.length}）</span>`;
    return `<div class="mr-rt-history">
      ${toggle}
      <div class="mr-rt-history-list" style="display:${expanded ? 'flex' : 'none'}">${items}</div>
    </div>`;
  }

  // Phase 5(2026-05-05 道雪): stepper 升级为 progress track mini-map + N/N 当前轮指示。
  //   旧版: 装饰性 dot, 不可交互, 数据来源轻; 底部独立"历史轮次 (N)"按钮折叠列表。
  //   新版: 每轮一个可 click/hover 的 dot(progress track 风, A 方案), mode 配色,
  //         当前轮蓝光圈放大, 末尾 "N/N" 数字直白显示进度。
  //         数据 attr (data-turn-n / data-turn-mode) 支持 click/hover 时光机切换。
  //         "历史轮次"按钮 + _renderRtHistory 渲染删除(功能被 mini-map 完全替代)。
  function _renderTurnStepper(turns, currentMode, viewingTurnN) {
    const totalTurns = turns.length;
    if (totalTurns === 0 && (!currentMode || currentMode === 'idle')) return '';
    const isActive = currentMode && currentMode !== 'idle';
    // 当前 active 轮号: 非 idle 时 = totalTurns + 1(本轮还在跑); idle 时 = totalTurns(最后一轮已完成)
    const activeTurnN = isActive ? totalTurns + 1 : totalTurns;
    // 当前查看的轮号: viewingTurnN 优先(时光机模式), 否则 = activeTurnN
    const viewN = (typeof viewingTurnN === 'number' && viewingTurnN >= 1) ? viewingTurnN : activeTurnN;

    const dots = turns.map(t => {
      const isCurrent = t.n === viewN;
      const cls = `mr-rt-step-dot ${escapeHtml(t.mode)}${isCurrent ? ' current' : ''}`;
      return `<span class="${cls}" data-turn-n="${t.n}" data-turn-mode="${escapeHtml(t.mode)}" title="第 ${t.n} 轮 · ${escapeHtml(t.mode)}"></span>`;
    }).join('');
    // active(进行中)轮的 placeholder dot
    const activeDot = isActive
      ? `<span class="mr-rt-step-dot ${escapeHtml(currentMode)} active${activeTurnN === viewN ? ' current' : ''}" data-turn-n="${activeTurnN}" data-turn-active="1" title="第 ${activeTurnN} 轮 · ${escapeHtml(currentMode)} (进行中)"></span>`
      : '';
    // N/N 进度数字 — 时光机模式时显示 "viewN/totalDisplay" 蓝色, 默认显示 "current/total" 灰色
    const totalDisplay = isActive ? activeTurnN : totalTurns;
    const isViewingHistory = (typeof viewingTurnN === 'number' && viewingTurnN < activeTurnN);
    const counter = `<span class="mr-rt-step-counter${isViewingHistory ? ' viewing' : ''}">${viewN}/${totalDisplay}</span>`;
    return `<span class="mr-rt-stepper" id="mr-rt-stepper">${dots}${activeDot}${counter}</span>`;
  }

  // 2026-05-05 道雪：用户提问 banner（A+D 混合：黄色引用条 + 单行紧凑布局）。
  //   三态：
  //     'history' — 时光机模式，蓝色边线 + 第 N 轮 chip
  //     'live'    — 进行中（用户已发但 turn-complete 未到），黄色 + ⏳进行中
  //     'latest'  — 已 idle 看最新一轮，黄色 + 第 N 轮 chip
  //   空提问（纯 debate/summary 无附加输入）→ return ''，不显示。
  function _renderUserQuestionBanner(state, meeting, viewingTurnN) {
    const meetingId = meeting && meeting.id;
    const turns = (state && Array.isArray(state.turns)) ? state.turns : [];
    const currentMode = state && state.currentMode;
    const isTimeTravel = typeof viewingTurnN === 'number' && viewingTurnN >= 1 && viewingTurnN <= turns.length;
    const isLive = !isTimeTravel && currentMode && currentMode !== 'idle';

    let bannerMode, userInput, turnNum, turnLabel;
    const _modeLabelMap = { fanout: '提问', debate: '辩论', summary: '综合' };
    if (isTimeTravel) {
      const turn = turns[viewingTurnN - 1];
      if (!turn) return '';
      userInput = (turn.userInput || '').trim();
      turnNum = viewingTurnN;
      turnLabel = _modeLabelMap[turn.mode] || turn.mode || '';
      bannerMode = 'history';
    } else if (isLive) {
      userInput = (_currentTurnUserInputByMeeting[meetingId] || '').trim();
      turnNum = turns.length + 1;
      turnLabel = '进行中';
      bannerMode = 'live';
    } else if (turns.length > 0) {
      const turn = turns[turns.length - 1];
      userInput = (turn.userInput || '').trim();
      turnNum = turn.n || turns.length;
      turnLabel = _modeLabelMap[turn.mode] || turn.mode || '';
      bannerMode = 'latest';
    } else {
      return '';
    }
    if (!userInput) return '';
    return `
      <div class="mr-rt-userq" data-mode="${bannerMode}">
        <span class="mr-rt-userq-label">💬 你的提问</span>
        <span class="mr-rt-userq-text">${escapeHtml(userInput)}</span>
        <span class="mr-rt-userq-tag">第 ${turnNum} 轮 · ${escapeHtml(turnLabel)}</span>
        <button class="mr-rt-userq-toggle" data-action="userq-toggle" title="展开/折叠全文" aria-label="展开/折叠全文">▾</button>
      </div>
    `;
  }

  function _suggestedCmd(turns, currentMode) {
    if (currentMode && currentMode !== 'idle') return '';
    if (turns.length === 0) return 'ask';
    const last = turns[turns.length - 1];
    if (last.mode === 'fanout') return 'debate';
    if (last.mode === 'debate') return 'summary';
    return 'ask';
  }

  // Stage 2 容错升级：当所有参与者都 settled（completed/manual_extracted/absent/errored/interrupted）
  // 即使后端 currentMode 仍为非 idle（在写持久化），UI 也允许用户继续推进，避免 100% 等待。
  const _SETTLED_STATUSES = new Set(['completed', 'manual_extracted', 'absent', 'errored', 'interrupted']);
  // FIX-E（2026-05-01）：必须用"期望 sids 集合"判定，而不是 partialBy 自身的 keys。
  //   旧实现 `Object.keys(partialBy).every(...)` 在某家 watcher 还没 settle（partial 还没推送）
  //   时，partialBy 里压根没有这家的 sid → every 在剩余家都 settled 时直接为 true →
  //   推进按钮提前解锁，用户能在 Codex 卡死时先发下一轮，造成混乱。
  //   现按 expectedSids（meeting.subSessions）严格比对：每个期望 sid 都要有 settled 状态才算齐。
  function _allParticipantsSettled(partialBy, expectedSids) {
    if (!partialBy || !expectedSids || expectedSids.length === 0) return false;
    return expectedSids.every(sid =>
      partialBy[sid] && _SETTLED_STATUSES.has(partialBy[sid].status)
    );
  }

  // E3 修复 (2026-05-03)：_renderCmdBar 删除（与 toolbar 重复的 ask/debate/summary 按钮组）。
  // _suggestedCmd / _allParticipantsSettled 仍被其他地方使用（如未来扩展）— 保留 helper 函数，删渲染。

  function _renderOnboarding(meeting) {
    // D1 v2(2026-05-05 道雪): 删 examples 块 + scene 引用, onboarding 上移到 fusedTabs 之前。
    // 2026-05-03 道雪精测 C1 修复：欢迎文案原写死 "三家 AI（Claude / Gemini / Codex）"，
    //   3 × claude / 任意混合配置下都显示成 Claude/Gemini/Codex → 用户困惑配置是否生效。
    //   改为按 meeting.subSessions 的实际 kind 动态生成。
    const _OB_LABEL = KIND_LABELS;
    const sids = (meeting && Array.isArray(meeting.subSessions)) ? meeting.subSessions : [];
    const labels = sids.map(sid => {
      const sess = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      return _OB_LABEL[sess && sess.kind] || (sess && sess.title) || 'AI';
    });
    const cnNum = ['零','一','两','三','四','五','六','七','八','九'][labels.length] || String(labels.length);
    const headText = labels.length > 0 ? `${cnNum}个 AI 已就绪` : '圆桌已就位';
    const subText = labels.length > 0
      ? `${labels.join(' · ')} 等你抛话题`
      : '等你抛话题';

    // D1 Phase 4(2026-05-05 道雪): 圆桌角色 PNG 头像 stack(与卡片头像一致)
    //   slot 头像绑定: 0=Pikachu / 1=Charmander / 2=Squirtle (与 _SLOT_AVATARS 一致)
    const avatarsHtml = sids.map((sid, idx) => {
      const src = _avatarBySlot(idx);
      const fb = _avatarFallbackBySlot(idx);
      return src
        ? `<img src="${src}" class="mr-rt-ob-avatar" alt="slot${idx+1}" onerror="this.outerHTML='<span class=\\'mr-rt-ob-avatar-fb\\'>${fb}</span>'" />`
        : `<span class="mr-rt-ob-avatar-fb">${fb}</span>`;
    }).join('');

    // D1 Phase 4: 三步引导卡片 — 让新用户秒懂圆桌使用流程
    const stepsHtml = `
      <div class="mr-rt-ob-step">
        <div class="mr-rt-ob-step-num">1</div>
        <div class="mr-rt-ob-step-body">
          <div class="mr-rt-ob-step-title">提问</div>
          <div class="mr-rt-ob-step-desc">输入框输入问题,${labels.length || 3} 个 AI 同时启动思考</div>
        </div>
      </div>
      <div class="mr-rt-ob-step">
        <div class="mr-rt-ob-step-num">2</div>
        <div class="mr-rt-ob-step-body">
          <div class="mr-rt-ob-step-title">交叉迭代</div>
          <div class="mr-rt-ob-step-desc">他们引用彼此观点, 多轮收敛核心论点</div>
        </div>
      </div>
      <div class="mr-rt-ob-step">
        <div class="mr-rt-ob-step-num">3</div>
        <div class="mr-rt-ob-step-body">
          <div class="mr-rt-ob-step-title">总结</div>
          <div class="mr-rt-ob-step-desc">点输入框左侧 📝 总结, 选一人输出交接单</div>
        </div>
      </div>
    `;

    // D1 v3 Phase 4(2026-05-05 道雪): head 改为占位 div, 由 _refreshOnboardingHead 动态填充。
    //   启动中(notReady>0) → 黄色启动文字, 全员 ready → 绿色"X 个 AI 已就绪"。
    //   sub 行(label list)隐藏不渲染(信息已在 head 内, 避免重复)。
    //   data-default-* 属性记录默认全员 ready 文案, 让 head refresh 函数能 fallback。
    return `<div class="mr-rt-onboarding">
      <div class="mr-rt-ob-avatars">${avatarsHtml}</div>
      <div class="mr-rt-ob-head" id="mr-rt-ob-head"
           data-default-text="${escapeHtml(headText)}"
           data-default-sub="${escapeHtml(subText)}"></div>
      <div class="mr-rt-ob-steps">${stepsHtml}</div>
    </div>`;
  }

  // H3 Phase 4(2026-05-05 道雪): 更新 mr-header 的 meta 文字 + 进度条。
  //   meta: "已 N 轮 · ⏱ 总耗时"; 进度条: 本轮已 settled 的 sid 数 / 总人数, 渐变填充。
  //   header 骨架由 renderHeader 一次性 mount, 这里只刷新 #mr-header-meta + #mr-header-progress 内容,
  //   不动其他 listener。每次 _renderRtPanelHtml 时同步调用一次。
  function _updateHeaderProgress(meeting, state, mode, totalSec) {
    const metaEl = document.getElementById('mr-header-meta');
    const progEl = document.getElementById('mr-header-progress');
    if (!metaEl && !progEl) return;
    const turnsCount = (state && Array.isArray(state.turns)) ? state.turns.length : 0;
    const totalSecTxt = totalSec > 0 ? _formatThinkTime(totalSec) : null;
    // 进度计算: 非 idle = 本轮 partialBy 中 settled 的数 / 期望家总数
    //          idle    = 0/N (无活跃轮, 进度条灰色 0%)
    const expectedSids = Array.isArray(meeting.subSessions) ? meeting.subSessions : [];
    const total = expectedSids.length || 0;
    let done = 0;
    let isThinking = false;
    if (mode && mode !== 'idle' && state && state._partialBy) {
      for (const sid of expectedSids) {
        const p = state._partialBy[sid];
        if (p && _SETTLED_STATUSES.has(p.status)) done += 1;
      }
      isThinking = done < total;
    }
    // meta 文字
    if (metaEl) {
      const parts = [];
      if (turnsCount > 0) parts.push(`已 ${turnsCount} 轮`);
      if (totalSecTxt) parts.push(`⏱ ${totalSecTxt}`);
      if (mode && mode !== 'idle' && total > 0) {
        parts.push(`<span class="mr-header-meta-active">本轮 ${done}/${total}</span>`);
      }
      metaEl.innerHTML = parts.length ? '· ' + parts.join(' · ') : '';
    }
    // 进度条
    if (progEl) {
      if (total === 0) { progEl.style.display = 'none'; return; }
      progEl.style.display = '';
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      progEl.classList.toggle('mr-header-progress-thinking', isThinking);
      progEl.classList.toggle('mr-header-progress-idle', !isThinking && mode === 'idle');
      progEl.innerHTML = `<div class="mr-header-progress-fill" style="width:${pct}%"></div>`;
    }
  }

  // dev scene 一次性引导卡片 (plan-dev-scenario.md §5.2)
  //   按 meeting.scene 分发到三套文案 + 三个 localStorage key
  //   "不再显示" → setItem('1') 永久不再出现; "我知道了" → 仅当前视图隐藏 (DOM 删除), 下次进 panel 仍出现
  //   D1 v2 (master) 把欢迎区上移到 fusedTabs 之前; scene card 同属欢迎区, 跟随上移待遇 (在 onboarding 之上).
  const SCENE_ONBOARDING_LS_KEY = {
    general: 'hub-general-scenario-onboarding-dismissed-v1',
    research: 'hub-research-scenario-onboarding-dismissed-v1',
    dev: 'hub-dev-scenario-onboarding-dismissed-v1',
  };
  const SCENE_ONBOARDING_CONTENT = {
    general: {
      head: '🎯 通用圆桌 · 使用提示',
      bullets: [
        '三家平等给观点，不预设领域；技术辩论、代码评审、开放讨论都行。',
        '默认提问 → 三家并行；输入"<strong>@debate</strong>"触发辩论。',
        '想点名某家：用"<strong>@pikachu / @charmander / @squirtle</strong>"指定发言人。',
        '圆桌产物是<strong>可讨论的判断</strong>，不是研报或可执行方案。需要落地操作时，结论里会建议你切独立 session 实操。',
      ],
    },
    research: {
      head: '📊 投研圆桌 · 使用提示',
      bullets: [
        '三家偏置已固化：<strong>Pikachu</strong> 对抗硬度派（最尖锐空头）/ <strong>Charmander</strong> 反直觉校验派（找盲点）/ <strong>Squirtle</strong> 极简克制派（快速初筛）。',
        '输入个股代码 / 问题即可；三家会自动调数据后端拿最新数据，从基本面 + 资金面 + 技术面 + 情绪面给观点。',
        '结论必走 <strong>4 档</strong>（强烈推荐 / 可买需条件 / 不建议买 / 强烈回避），不允许"建议关注 / 可跟踪"等模糊话术。',
        '想跳过首轮反问，直接输入"<strong>直接分析</strong>"；想看深度推演（含对手盘 + 预期差分层），输入"<strong>@深度</strong>"。',
      ],
    },
    dev: {
      head: '🛠️ 开发圆桌 · 使用提示',
      bullets: [
        '三家先帮你问清需求、讨论方案，默认只交给 1 个 Driver 实操。',
        '你可以跳过问题；跳过项会在交接单里作为默认假设回显。',
        '需要交接时输入"<strong>生成交接单</strong>"；Driver 改完后输入"<strong>帮我审一下</strong>"。',
        '如需一对一深聊，建议直接打开对应 AI 子会话（左侧栏点 slot 头像跳转）。',
      ],
    },
  };
  function _renderSceneOnboardingCard(meeting) {
    if (!meeting) return '';
    const sceneKey = meeting.scene;
    const content = SCENE_ONBOARDING_CONTENT[sceneKey];
    const lsKey = SCENE_ONBOARDING_LS_KEY[sceneKey];
    if (!content || !lsKey) return ''; // 未注册场景不渲染
    try {
      if (localStorage.getItem(lsKey) === '1') return '';
    } catch {} // localStorage 不可用时按"未持久化"处理
    const bulletsHtml = content.bullets.map(b => `<li>${b}</li>`).join('');
    return `<div class="mr-rt-scene-card" data-rt-scene-card data-rt-scene-key="${sceneKey}">
      <div class="mr-rt-scene-card-head">${content.head}</div>
      <ul class="mr-rt-scene-card-body">${bulletsHtml}</ul>
      <div class="mr-rt-scene-card-actions">
        <button class="mr-rt-scene-card-btn" data-rt-scene-card-action="dismiss-once">我知道了</button>
        <button class="mr-rt-scene-card-btn mr-rt-scene-card-btn-secondary" data-rt-scene-card-action="dismiss-forever">不再显示</button>
      </div>
    </div>`;
  }

  function _renderRtPanelHtml(state, meeting) {
    const subs = _getRtSubInfo(meeting);
    const mode = state.currentMode || 'idle';
    const partialBy = state._partialBy || null;
    const fusedTabs = _renderFusedTabs(state, subs, mode, partialBy, meeting);
    const cardViewTabs = _renderCardViewTabs(meeting);
    // Phase 5(2026-05-05 道雪): 删除 _renderRtHistory 渲染调用。
    //   旧版底部"历史轮次 (N)"折叠按钮 + 列表已被 stepper mini-map 完全替代;
    //   保留 _renderRtHistory 函数本身以防其他地方调用, 仅删此处渲染。
    // 2026-05-05 道雪：标题统一为「圆桌轮次」(用户偏好统一标题,不区分 general/research/dev)。
    //   不动 _scenes.getScene().name —— 那个 name 同时给 covenant prompt header 用,改了会污染发给 AI 的 prompt。
    const titleText = '圆桌轮次';
    const viewingTurnN = _rtViewingTurnN[meeting.id];
    const stepper = _renderTurnStepper(state.turns, mode, viewingTurnN);
    // Phase 5: 时光机 banner — 仅 viewingTurnN 设置时渲染
    const timeTravelBanner = (typeof viewingTurnN === 'number' && viewingTurnN >= 1)
      ? `<div class="mr-rt-timetravel-banner">
          <span class="mr-rt-tt-icon">⌛</span>
          <span class="mr-rt-tt-text">时光机模式 · 第 <b>${viewingTurnN}</b> 轮 · ${escapeHtml((state.turns[viewingTurnN - 1] && state.turns[viewingTurnN - 1].mode) || '')} (只读历史)</span>
          <button class="mr-rt-tt-exit" id="mr-rt-tt-exit" data-rt-tt-exit="1">回到最新 (Esc)</button>
        </div>`
      : '';

    // F5 Phase 3(2026-05-04 道雪 简化版): 仅整轮总耗时
    //   token + cost 因 transcript-tap 通路缺失暂不显示, 等后续扩展再启用。
    const slots = _getRtSlots(meeting);
    const aiStats = state.aiStats || {};
    let totalSec = 0;
    for (const slot of slots) {
      if (!slot || !slot.sid) continue;
      const stats = aiStats[slot.sid] || aiStats[slot.kind] || null;
      if (!stats) continue;
      totalSec += stats.totalThinkSec || 0;
    }
    const totalSecTxt = totalSec > 0 ? _formatThinkTime(totalSec) : '--';
    const costBarHtml = `<div class="mr-rt-cost-bar" title="本对话累计总耗时(三家相加)">
      <span class="mr-rt-cost-item"><span class="ico">⏱</span> 总耗时 <span class="num">${escapeHtml(totalSecTxt)}</span></span>
    </div>`;
    // FIX-E（2026-05-01）：cmdBar 推进按钮判定要按"期望家集合"，不是 partialBy 自身的 keys。
    // meeting-create-modal（2026-05-01）：期望家 = meeting.subSessions（按 slot 顺序），
    //   不再硬编码 ['claude','gemini','codex']——多 claude / DeepSeek+GLM 混搭的圆桌也能正确判完成。
    const expectedSids = Array.isArray(meeting.subSessions) ? meeting.subSessions.slice() : [];
    // E3 修复 (2026-05-03)：删除 _renderCmdBar 调用 — panel 顶部按钮组与 toolbar 重复，
    //   toolbar 已覆盖所有功能，删 cmd-bar 单一来源。
    const onboarding = (state.turns.length === 0 && mode === 'idle') ? _renderOnboarding(meeting) : '';
    // 场景一次性引导卡片 (general/research/dev 共用): 与 onboarding 独立, 跨 panel 始终展示直至用户"不再显示"
    const devCard = _renderSceneOnboardingCard(meeting);
    // Stage 2 容错升级：软提醒 banner 容器
    const softBanner = `<div id="mr-rt-soft-alert-banner" class="mr-rt-soft-alert-banner" style="display:none"></div>`;
    // pilot redesign（2026-05-02）：废弃 pilotRecaps 卡片 + 主驾占位容器（圆桌不再桥接子会话私聊）。
    // H3 Phase 4(2026-05-05 道雪): 同步刷新 header 进度条 + meta(每次 panel re-render)
    _updateHeaderProgress(meeting, state, mode, totalSec);
    // Phase 4 v2(2026-05-05): panel 重渲后 onboarding head 占位空, 异步 microtask 触发 _refreshSoftAlert 填充
    setTimeout(() => { try { _refreshSoftAlert(meeting); } catch {} }, 0);
    // D1 v2(2026-05-05 道雪): 欢迎区从 fusedTabs 之后上移到 fusedTabs 之前,
    //   位置在 "圆桌讨论" 标题正下方与 3 张 AI 卡片之间, 视觉权重更高 + 更早被注意到。
    // 2026-05-05 道雪: 用户提问 banner 紧贴 fusedTabs 之上 — 让"标题/stepper → 你的提问 → AI 答复"
    //   形成 Q→A 视觉流。空提问/空 turns 时 banner 自动 return '' 不渲染。
    const userQBanner = _renderUserQuestionBanner(state, meeting, viewingTurnN);
    return `
      <div class="mr-rt-track">
        <div class="mr-rt-track-row">
          <div class="mr-rt-track-title-grp">
            <span class="mr-rt-title">${titleText}</span>
            ${stepper}
          </div>
          ${costBarHtml}
        </div>
      </div>
      ${softBanner}
      ${timeTravelBanner}
      ${devCard}
      ${onboarding}
      ${userQBanner}
      ${cardViewTabs}
      ${fusedTabs}
    `;
  }


  // 主渲染：从 IPC 拿最新 state 后重绘。
  // 乐观字段（currentMode）的保留条件：**只有 _rtOptimisticTurn[id] 还在**
  // —— 也就是 IPC 还在飞行中。IPC resolve 后 _rtOptimisticTurn 已被 clearOptimistic 清，
  // 此时 server state 真实状态（含 idle）才被采纳。
  // partialBy 单独保留：轮中单家完成 IPC 推 partial-update，这是轮内增量，独立处理。
  // 2026-05-05 道雪 修3：cache 与 DOM 解耦的设计原则
  //   旧实现：refreshRoundtablePanel 一手包办"拉 server state + merge cache + 写 DOM"，
  //     调用方必须保证 meeting 是当前 active 才能调，否则 DOM 会被错圆桌内容覆盖。
  //     副作用：所有 IPC handler 都用 `meetingId !== activeMeetingId → return` 守卫，
  //     非 active 圆桌的 cache 永远跟不上 server，切回时 partial 残留 → 卡片状态错乱。
  //   新设计：拆成两个函数 ——
  //     _syncRoundtableCacheFromServer(meeting): 纯 cache 同步，**任何 meeting 都安全调用**
  //       不动 DOM，IPC handler 在守卫之外也可调用
  //     refreshRoundtablePanel(meeting): cache sync + DOM 重渲，**仅 active meeting 调用**
  //       内含 activeMeetingId race guard（修2 内置）
  //   这样所有圆桌的 cache 始终跟 server 同步，切换体验一致，杜绝残留。

  // 拉 server state + merge cache（含 optimistic 与 prev._partialBy 合并），写 _rtPanelState。
  // 不写 DOM 不调 _ensureRtPanel，任何 meeting 都能调。
  // 返回 { state, ok: bool }，ok=false 表示 server state 拉取失败或 meeting 不可 panel。
  async function _syncRoundtableCacheFromServer(meeting) {
    if (!_isPanelCapableMeeting(meeting)) return { state: null, ok: false };
    let state;
    try {
      state = await ipcRenderer.invoke('roundtable:get-state', { meetingId: meeting.id });
    } catch (e) {
      console.error('[roundtable] get-state failed:', e.message);
      return { state: null, ok: false };
    }
    if (!state) return { state: null, ok: false };
    const prev = _rtPanelState[meeting.id];
    const optimistic = _rtOptimisticTurn[meeting.id];
    if (optimistic && (!state.currentMode || state.currentMode === 'idle')) {
      // IPC 飞行期间 + server 还没 begin → 显示乐观态
      state.currentMode = optimistic.mode;
    }
    // partialBy 合并：本轮还在跑（server currentMode 非 idle）才保留 prev._partialBy 增量；
    //   server 已 idle（本轮已 settle 持久化）→ 丢 prev 残留，让 lastTurn 路径接管渲染。
    //   这条规则替代旧 `meetingId !== activeMeetingId → return` 守卫的副作用 ——
    //   非 active 期间 partial 仍会同步进 cache，但切回时如果 server 已 idle，自然不读残留。
    const serverIdle = !state.currentMode || state.currentMode === 'idle';
    if (prev && prev._partialBy && !serverIdle) {
      state._partialBy = prev._partialBy;
    }
    _rtPanelState[meeting.id] = state;
    return { state, ok: true };
  }

  async function refreshRoundtablePanel(meeting) {
    if (!_isPanelCapableMeeting(meeting)) { _removeRtPanel(); return; }
    const { state, ok } = await _syncRoundtableCacheFromServer(meeting);
    if (!ok) return;
    // 修2：async race guard — await 期间用户切走，老 refresh 不写 DOM（避免 panel 被错圆桌内容覆盖）
    if (meeting.id !== activeMeetingId) return;
    const panel = _ensureRtPanel();
    panel.innerHTML = _renderRtPanelHtml(state, meeting);
    _bindRtPanelEvents(panel, meeting);
    // pilot redesign（2026-05-02）：panel.innerHTML 重渲后用 rAF 包裹，确保 paint 后再涂卡片视觉。
    //   旧实现直接调用，理论上同步生效，但截图显示 class 偶尔没生效——猜测是 panel innerHTML 后浏览器
    //   还没完成布局/合成的瞬间 querySelectorAll 拿到的引用与最终 paint 的 DOM 不一致。
    const pilotSlotForVisual = (typeof meeting.pilotSlot === 'number' && meeting.pilotSlot >= 0 && meeting.pilotSlot <= 2)
      ? meeting.pilotSlot : null;
    // T6：free 模式不调 _applyPilotCardVisual（无红框逻辑）
    if (meeting.mode !== 'free') {
      const dispatchModeForVisual = ['all', 'pilot', 'observer'].includes(meeting.dispatchMode)
        ? meeting.dispatchMode : 'all';
      requestAnimationFrame(() => {
        _applyPilotCardVisual(meeting, pilotSlotForVisual, dispatchModeForVisual);
      });
    }
    // 圆桌记忆 phase 1（2026-05-07）：lazy 拉取 count/pending/hasProfile（fire-and-forget）
    //   首次进 panel 时 cache 空 → 显示 0 → 拉取后若有 dirty 自然触发 refresh 二次渲染
    //   memory-event IPC 后续会做增量推送，所以这里只补"冷启动 / 切回"场景
    _loadMemoryStatusForMeeting(meeting);
  }

  // 绑定 panel 内部所有交互（折叠 / 卡片点击）。每次 innerHTML 重绘后都要重新调用。
  // T2（2026-05-04 道雪）：单 slot 卡片的事件绑定独立成函数，让 partial-update 局部 patch 后只 rebind 单卡片。
  //   覆盖范围：① 卡片本体 click（focus session）② ↗ 展开按钮 ③ [data-rt-escape] 工具栏按钮组。
  //   不覆盖：history-toggle / soft-alert banner-close / mr-rt-ob-card（这些是 panel 级，由 _bindRtPanelEvents 管）。
  function _showRtEscapeNotice(message, level = 'warn') {
    const banner = document.getElementById('mr-rt-soft-alert-banner');
    if (!banner) return false;
    const cls = level === 'error' ? 'urgent' : 'warn';
    banner.className = `mr-rt-soft-alert-banner ${cls}`;
    banner.innerHTML = `
      <div class="mr-rt-soft-alert-msg">
        <strong>${escapeHtml(level === 'error' ? '操作失败' : '提示')}</strong>
        <span class="mr-rt-soft-alert-hint">${escapeHtml(message || '')}</span>
      </div>
      <button class="mr-rt-soft-alert-close" data-rt-banner-close="1" title="关闭提示">×</button>`;
    banner.style.display = 'flex';
    const close = banner.querySelector('[data-rt-banner-close]');
    if (close) close.addEventListener('click', () => { banner.style.display = 'none'; banner.innerHTML = ''; }, { once: true });
    return true;
  }

  function _bindSlotCardEvents(slotEl, meeting) {
    if (!slotEl) return;
    // 卡片本体 click（mr-ft 自身），focus 该 sid 的 session
    if (slotEl.matches('.mr-ft[data-ft-sid]')) {
      const sid = slotEl.getAttribute('data-ft-sid');
      slotEl.addEventListener('click', (ev) => {
        if (!sid) return;
        if (_isCardTabMode()) return;
        // F3 Phase 2: Ctrl/Cmd+click → 对比模式多选(状态优先级: 互斥 focus)
        if (ev && (ev.ctrlKey || ev.metaKey)) {
          ev.stopPropagation();   // 阻止冒泡到全局 click 退出 handler
          _toggleCompareSelect(sid);
          return;
        }
        // 无 modifier click: 进入 focus 前清 compare(状态优先级)
        if (_rtCompareSlots.size > 0) _clearCompareSelect();
        // F0 v3(2026-05-05 道雪): 聚焦态下任何卡片点击都"收回放大",不打开新卡。
        //   场景: 用户聚焦 A 后, 想恢复全员等宽时常点到 B 卡区域 — 应理解为"收回",
        //         而非"切换聚焦到 B"。再次进入聚焦需先收回再点目标卡。
        //   - 同卡再点: 不动作(让用户选文本/复制), 显式退出走 Esc / 点空白
        //   - 不同卡再点: 退出聚焦(收回放大), 不打开新卡
        //   - 无聚焦时点卡: 进入聚焦
        if (_rtFocusedCardSid) {
          if (_rtFocusedCardSid !== sid) {
            _rtFocusedCardSid = null;
            document.body.classList.remove('mr-card-focus-on');
          }
          return;
        }
        _focusRoundtableSession(meeting, sid);
        _rtFocusedCardSid = sid;
        document.body.classList.add('mr-card-focus-on');
      });
    }
    // ↗ 展开
    slotEl.querySelectorAll('.mr-ft-expand[data-ft-expand-sid]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sid = btn.getAttribute('data-ft-expand-sid');
        const kind = btn.getAttribute('data-ft-expand-kind');
        _openRtTimeline(meeting, sid, kind);
      });
    });
    // 逃生工具栏 [data-rt-escape] —— 与原 _bindRtPanelEvents 中的 click handler 字节等价（4 分支：extract / skip / enter-shell / resend / resend-prompt）。
    slotEl.querySelectorAll('[data-rt-escape]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (btn.hasAttribute('disabled')) return;
        const action = btn.getAttribute('data-rt-escape');
        const sid = btn.getAttribute('data-rt-sid');
        const kind = btn.getAttribute('data-rt-kind');
        if (!sid) return;
        // 防重入：临时 disable + 操作期 spinner
        btn.disabled = true;
        const oldText = btn.textContent;
        btn.textContent = '...';
        // 标记是否已由按钮内部接管 textContent 还原（如 extract 走 1.5s setTimeout），
        //   finally 看到此 flag 就不再立即覆盖按钮文字。
        let _btnTextHandledExternally = false;
        try {
          if (action === 'extract') {
            const r = await ipcRenderer.invoke('roundtable-manual-extract', {
              meetingId: meeting.id, sid, sincePromptTs: _rtTurnStartTs[meeting.id] || 0,
            });
            if (!r || !r.ok) {
              console.warn(`[rt-escape] extract failed: ${r?.reason} (${r?.detail || ''})`);
              const detail = r?.detail ? `：${r.detail}` : '';
              _showRtEscapeNotice(`提取失败（${r?.reason || 'unknown'}）${detail}`, 'error');
            } else {
              // 2026-05-02 Bug 修复：用户视觉反馈。
              //   旧版本只 console.log → 用户看不到"提取成功"，加上 IPC 永远失败（Bug 2），
              //   感觉按钮完全是假的。新版本：按钮短暂变绿显示 "✓ 已同步 N 字"，
              //   1.5s 后恢复；卡片本身会被 sendToRenderer('roundtable-turn-complete') 触发刷新。
              const charCount = (r.text || '').length;
              console.log(`[rt-escape] extract ok: ${kind} got ${charCount} chars (mode=${r.mode}, source=${r.source})`);
              btn.style.background = '#2da44e';
              btn.style.color = '#fff';
              btn.textContent = `✓ 已同步 ${charCount}字`;
              _btnTextHandledExternally = true;
              setTimeout(() => {
                btn.style.background = '';
                btn.style.color = '';
                btn.textContent = oldText;
                btn.disabled = false;
              }, 1500);
            }
          } else if (action === 'skip') {
            const r = await ipcRenderer.invoke('roundtable-skip-participant', { meetingId: meeting.id, sid });
            if (!r || !r.ok) console.warn(`[rt-escape] skip failed: ${r?.reason}`);
          } else if (action === 'enter-shell') {
            // Arch refactor 2026-05-02 (Task 5): 切到该子 session 主区 shell view，
            // 复用已有 selectSession 路径（隐藏 mr-panel + 显示 terminal-panel + mount xterm）。
            if (typeof window !== 'undefined' && typeof window.selectSession === 'function') {
              window.selectSession(sid);
            } else if (typeof selectSession === 'function') {
              selectSession(sid);
            } else {
              console.warn('[rt-escape] enter-shell: selectSession not available');
            }
          } else if (action === 'resend-prompt') {
            const r = await ipcRenderer.invoke('roundtable-resend-prompt', { meetingId: meeting.id, sid });
            if (r && r.ok) {
              btn.style.background = '#2da44e';
              btn.style.color = '#fff';
              btn.textContent = `✓ 已重发`;
              _btnTextHandledExternally = true;
              // H2 数据驱动：重发成功后清掉 sendStatus='stuck'，由 refreshRoundtablePanel 重渲清除视觉
              const cachedForResend = _rtPanelState[meeting.id];
              if (cachedForResend && cachedForResend._partialBy && cachedForResend._partialBy[sid]) {
                delete cachedForResend._partialBy[sid].sendStatus;
              }
              refreshRoundtablePanel(meeting);
              setTimeout(() => {
                btn.style.background = '';
                btn.style.color = '';
                btn.textContent = oldText;
                btn.disabled = false;
              }, 1500);
            } else {
              alert(`重发失败：${r?.reason || 'unknown'}\n\n建议：\n1. 检查该家 PTY 是否还活着（左侧 sidebar 点进去看）\n2. 或者按"跳过"绕过这家，下一轮会自动重启 CLI`);
            }
          } else if (action === 'resend') {
            const r = await ipcRenderer.invoke('roundtable-resend-participant', { meetingId: meeting.id, sid });
            if (r && r.ok) {
              console.log(`[rt-escape] resend ok: ${kind}`);
            } else {
              // FIX-C 阶段：FIX-F 还没落地前，重发 IPC 是 stub，给用户清晰指引
              alert(`暂未支持单家"重新拉起"。\n\n建议操作：\n1. 在该卡片底部按"跳过"，下游 prompt 不会引用此家。\n2. 或者发起新一轮（直接提问 / @debate），系统会自动重启卡死的 CLI。\n3. 或者从左侧 sidebar 点该子 session 进 shell 看 PTY 真实情况。\n\n（错误信息：${r?.reason || 'unknown'}）`);
            }
          }
        } catch (err) {
          console.error(`[rt-escape] ${action} threw:`, err);
          // M1（T6 fix）：resend-prompt 是用户主动触发，IPC handler 未注册时静默失败体验差，
          //   加 alert 告知用户（"No handler registered" 说明 T5 IPC 还没部署）。
          if (action === 'resend-prompt') {
            alert(`📤 发送失败：${err && err.message ? err.message : 'unknown'}\n\n（如果错误说"No handler registered"，说明后端 IPC 还没部署，需要等待 T5 落地）`);
          }
        } finally {
          if (!_btnTextHandledExternally) {
            btn.disabled = false;
            btn.textContent = oldText;
          }
        }
      });
    });

    // 圆桌记忆 phase 1（2026-05-07）：📒 / 📥 / 📊 三按钮
    //   data-rt-mem-action: 'open-own' | 'open-pending' | 'open-profile'
    //   stopPropagation 避免冒泡到 .mr-ft 卡片 click（不要触发 focus）
    slotEl.querySelectorAll('[data-rt-mem-action]').forEach(btn => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const action = btn.getAttribute('data-rt-mem-action');
        const slot = btn.getAttribute('data-rt-mem-slot');
        if (!slot || !action) return;
        const typeMap = { 'open-own': 'own', 'open-pending': 'pending', 'open-profile': 'profile', 'open-worker': 'worker-state' };
        const type = typeMap[action];
        if (!type) return;
        const r = await ipcRenderer.invoke('arena:resolve-memory-file', { meetingId: meeting.id, slot, type });
        if (r && r.path) {
          if (typeof window !== 'undefined' && typeof window.openPathInHub === 'function') {
            await window.openPathInHub(r.path, { cwd: _activeMeetingCwd(), requireExistsForRel: false });
          } else if (typeof openPreviewPanel === 'function') {
            openPreviewPanel(r.path);
          }
        } else {
          const msg = (r && r.error) || 'unknown';
          console.warn(`[mr-mem] resolve ${type} for ${slot} failed: ${msg}`);
          alert(`打开记忆文件失败：${msg}`);
        }
      });
    });

    // F2 Phase 2(2026-05-04 道雪 / spec F2): hover-actions 浮条按钮
    //   📋 复制本卡 preview 全文 / @ 输入框插入 @AI / " 引用 (F6 占位 Phase 3)
    //   stopPropagation 避免冒泡到卡片 click 触发 F0 focus
    slotEl.querySelectorAll('.mr-ft-hover-actions button').forEach(btn => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const action = btn.getAttribute('data-rt-action');
        const f2Kind = btn.getAttribute('data-rt-kind');
        const card = btn.closest('.mr-ft');
        if (action === 'copy') {
          const previewText = (card?.querySelector('.mr-ft-bottom')?.innerText || '').trim();
          if (!previewText) {
            const oldT = btn.textContent;
            btn.textContent = '空';
            setTimeout(() => { btn.textContent = oldT; }, 1000);
            return;
          }
          try {
            await navigator.clipboard.writeText(previewText);
            const oldT = btn.textContent;
            btn.textContent = '✓';
            btn.style.background = '#2da44e';
            btn.style.color = '#fff';
            setTimeout(() => {
              btn.textContent = oldT;
              btn.style.background = '';
              btn.style.color = '';
            }, 1200);
          } catch (e) {
            console.warn('[hover-actions] copy failed:', e);
          }
        } else if (action === 'mention') {
          const input = document.getElementById('mr-input-box');
          if (input) {
            const labelEl = card?.querySelector('.mr-ft-name');
            const fullLabel = (labelEl?.textContent || f2Kind || '').trim();
            // 剥离前导 emoji / 非文字字符, 再按 · 或空格切第一段
            const cleanLabel = fullLabel.replace(/^[^A-Za-z0-9_一-鿿]+/, '');
            const shortLabel = cleanLabel.split(/[·\s]/)[0] || f2Kind || '';
            const cur = input.textContent || '';
            input.textContent = (cur && !cur.endsWith(' ') ? cur + ' ' : cur) + `@${shortLabel} `;
            input.focus();
            if (typeof _placeCaretAtEnd === 'function') _placeCaretAtEnd(input);
          }
        } else if (action === 'quote') {
          // F6 占位:Phase 3 实施完整选中文本引用流程
          alert('"引用本卡内容入下一轮" 将在 Phase 3 (F6) 实施。\n当前可先用 📋 复制后粘贴到输入框。');
        }
      });
    });
  }

  function _bindRtPanelEvents(panel, meeting) {
    // Phase 5(2026-05-05 道雪): 旧 history-toggle 已删除(被 stepper mini-map 替代),
    //   新加 stepper dot click + 时光机 banner exit click handlers。
    panel.querySelectorAll('.mr-rt-step-dot[data-turn-n]').forEach(dot => {
      dot.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const n = parseInt(dot.getAttribute('data-turn-n'), 10);
        if (!Number.isFinite(n) || n < 1) return;
        const cached = _rtPanelState[meeting.id];
        const totalTurns = cached && Array.isArray(cached.turns) ? cached.turns.length : 0;
        const isActive = cached && cached.currentMode && cached.currentMode !== 'idle';
        const latestN = isActive ? totalTurns + 1 : totalTurns;
        // 点击当前最新轮 = 退出时光机; 否则进入/切换时光机到第 N 轮
        if (n === latestN || dot.hasAttribute('data-turn-active')) {
          delete _rtViewingTurnN[meeting.id];
        } else {
          _rtViewingTurnN[meeting.id] = n;
        }
        refreshRoundtablePanel(meeting);
      });
    });
    panel.querySelectorAll('[data-rt-card-tab-sid]').forEach(tab => {
      tab.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const sid = tab.getAttribute('data-rt-card-tab-sid');
        if (sid) _focusRoundtableSession(meeting, sid);
      });
    });
    // 时光机 banner 退出按钮
    const ttExitBtn = panel.querySelector('[data-rt-tt-exit]');
    if (ttExitBtn) {
      ttExitBtn.addEventListener('click', () => {
        delete _rtViewingTurnN[meeting.id];
        refreshRoundtablePanel(meeting);
      });
    }
    // 2026-05-05 道雪：用户提问 banner 展开/折叠按钮。点 ▾ → 切 .expanded class,
    //   text 从 ellipsis 单行变 pre-wrap 多行;按钮 transform rotate 180° (CSS 控制)。
    //   局部 toggle 不调 refreshRoundtablePanel,避免重渲后 expanded 状态丢失。
    const userqToggle = panel.querySelector('[data-action="userq-toggle"]');
    if (userqToggle) {
      userqToggle.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const banner = userqToggle.closest('.mr-rt-userq');
        if (banner) banner.classList.toggle('expanded');
      });
    }
    // 时光机模式 input/send disable(只读历史不许新发轮)
    const inputBox = document.getElementById('mr-input-box');
    const sendBtn = document.getElementById('mr-send-btn');
    const inputRow = document.getElementById('mr-input-row');
    const isTT = !!_rtViewingTurnN[meeting.id];
    if (inputBox) {
      inputBox.setAttribute('contenteditable', isTT ? 'false' : 'true');
      inputBox.setAttribute('data-placeholder', isTT
        ? '⌛ 时光机模式 — 点 stepper 最新轮 / Esc 退出后才能发送'
        : (inputBox.getAttribute('data-placeholder-orig') || inputBox.getAttribute('data-placeholder') || ''));
    }
    if (sendBtn) sendBtn.disabled = isTT;
    if (inputRow) inputRow.classList.toggle('mr-input-row-tt', isTT);
    // T2（2026-05-04 道雪）：每个 slot 卡片走 _bindSlotCardEvents（同一函数 partial 局部 rebind 复用）
    panel.querySelectorAll('.mr-ft[data-ft-sid]').forEach(slotEl => {
      _bindSlotCardEvents(slotEl, meeting);
    });
    // E3 修复 (2026-05-03)：cmd-bar 的 .mr-rt-cmd-btn click handler 删除（按钮已不渲染）
    const hasThinking = panel.querySelector('.mr-rt-think-elapsed');
    if (hasThinking && !_thinkTimer) {
      const mid = meeting.id;
      _thinkTimer = setInterval(() => {
        const ts = _thinkStartTs[mid];
        if (!ts) { clearInterval(_thinkTimer); _thinkTimer = null; return; }
        const els = document.querySelectorAll('.mr-rt-think-elapsed');
        if (els.length === 0) { clearInterval(_thinkTimer); _thinkTimer = null; return; }
        const sec = Math.round((Date.now() - ts) / 1000);
        els.forEach(el => { el.textContent = `已 ${sec}s`; });
      }, 1000);
    } else if (!hasThinking && _thinkTimer) {
      clearInterval(_thinkTimer); _thinkTimer = null;
    }
    panel.querySelectorAll('.mr-rt-ob-card[data-ob-q]').forEach(card => {
      card.addEventListener('click', () => {
        const q = card.getAttribute('data-ob-q');
        const input = document.getElementById('mr-input-box');
        if (input && q) { input.textContent = q; input.focus(); _placeCaretAtEnd(input); }
      });
    });

    // T2（2026-05-04 道雪）：[data-rt-escape] 工具栏按钮的绑定已迁入 _bindSlotCardEvents
    //   （上方 panel.querySelectorAll('.mr-ft[data-ft-sid]') 循环已覆盖）。

    // 软提醒 banner 关闭按钮
    const banner = panel.querySelector('#mr-rt-soft-alert-banner');
    if (banner) {
      banner.querySelectorAll('[data-rt-banner-close]').forEach(btn => {
        btn.addEventListener('click', () => {
          banner.style.display = 'none';
          banner.innerHTML = '';
        });
      });
    }

    // 场景引导卡片按钮 (general/research/dev 共用)
    //   "我知道了" 仅当前视图隐藏 (DOM remove); "不再显示" 写对应 scene 的 localStorage key 永久
    const sceneCard = panel.querySelector('[data-rt-scene-card]');
    if (sceneCard) {
      const sceneKey = sceneCard.getAttribute('data-rt-scene-key');
      const lsKey = SCENE_ONBOARDING_LS_KEY[sceneKey];
      sceneCard.querySelectorAll('[data-rt-scene-card-action]').forEach(btn => {
        btn.addEventListener('click', () => {
          const action = btn.getAttribute('data-rt-scene-card-action');
          if (action === 'dismiss-forever' && lsKey) {
            try { localStorage.setItem(lsKey, '1'); } catch {}
          }
          sceneCard.remove();
        });
      });
    }
  }

  function _placeCaretAtEnd(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // ---- AI 时间线浮层 ----------------------------------------------------
  // 点击任意卡片 → 打开右侧抽屉，顶部 Tab 列轮次（最新在最左 = 默认 active），点 Tab 切换内容。
  // T3（2026-05-04 道雪）：合并 _partialBy[sid] 作为「实时」虚拟轮次（如果有内容）；
  //   抽屉打开期间订阅 partial-update 实时更新内容（修复 B1 看不到本轮 partial）。
  function _openRtTimeline(meeting, sid, kind) {
    // T3 fix（2026-05-04 道雪）：开新抽屉前先清掉上一次的 escHandler + 订阅状态。
    if (_rtTimelineCleanup) { _rtTimelineCleanup(); _rtTimelineCleanup = null; }
    const state = _rtPanelState[meeting.id];
    if (!state || !Array.isArray(state.turns)) return;

    const labelDisplay = _KIND_LABELS[kind] || kind;
    const subs = _getRtSubInfo(meeting);
    const sub = subs[kind];
    const headerLabel = sub && sub.label ? sub.label : labelDisplay;
    const slotIdxTl = (meeting && Array.isArray(meeting.subSessions))
      ? Math.max(0, meeting.subSessions.indexOf(sid))
      : 0;
    const slotClsTl = `slot-${slotIdxTl + 1}`;

    // 收集该 sid 有回答的轮次，按 turn n 倒序（最新在最左）
    const historyTurns = state.turns
      .filter(t => (t.by || {})[sid])
      .sort((a, b) => b.n - a.n);

    // T3：本轮 partial 合并（皮卡丘 settled 但小火龙未完时，本轮没 turn-complete → 用户在抽屉看不到本轮内容）
    const partial = (state._partialBy || {})[sid];
    const liveText = (partial && (partial.text || (Array.isArray(partial.blocks) && partial.blocks.length > 0)))
      ? (partial.text || '') : null;
    const turnsWithAns = [...historyTurns];
    let liveTurn = null;
    if (liveText !== null) {
      const baseTurnN = (historyTurns[0] && historyTurns[0].n) || (state.turnNum || 0);
      liveTurn = {
        n: baseTurnN + 1,
        mode: state.currentMode || 'fanout',
        by: { [sid]: liveText },
        userInput: '',  // partial 阶段没有标准化的 userInput；留空避免 stale
        _live: true,
        _partialStatus: partial.status,
        _partialBlocks: Array.isArray(partial.blocks) ? partial.blocks : null,
      };
      turnsWithAns.unshift(liveTurn);
    }

    let overlay = document.getElementById('mr-rt-timeline-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'mr-rt-timeline-overlay';
      overlay.className = 'mr-rt-tl-overlay';
      document.body.appendChild(overlay);
    }

    const renderTurnBody = (turn) => {
      if (!turn) return '<div class="mr-rt-tl-empty">该 AI 还没有可显示的历史回答。</div>';
      // T3：_live 走 partial blocks（如有）→ markdown text → 占位
      let bodyHtml;
      if (turn._live) {
        if (turn._partialBlocks && turn._partialBlocks.length > 0) {
          bodyHtml = _renderPreviewBlocks(turn._partialBlocks, sid);
        } else if (turn.by[sid]) {
          bodyHtml = _renderMarkdown(turn.by[sid]);
        } else {
          bodyHtml = '<div class="mr-rt-tl-empty" style="opacity:.6">💭 思考中…等待 AI 输出</div>';
        }
        // 加流式光标
        bodyHtml += '<span class="mr-ft-cursor"></span>';
      } else {
        const text = (turn.by || {})[sid] || '';
        bodyHtml = _renderMarkdown(text);
      }
      const userIn = (turn.userInput || '').trim();
      const userBlock = userIn
        ? `<div class="mr-rt-tl-user">用户输入：${escapeHtml(userIn.slice(0, 400))}${userIn.length > 400 ? '…' : ''}</div>`
        : '';
      const decisionTag = turn.decisionTitle
        ? `<div class="mr-rt-tl-decision-row">📌 决策标题：${escapeHtml(turn.decisionTitle)}</div>`
        : '';
      return `${decisionTag}${userBlock}<div class="mr-rt-tl-body">${bodyHtml}</div>`;
    };

    const tabsHtml = turnsWithAns.map((t, i) => {
      const modeLabel = { fanout: '提问', debate: '辩论', summary: '综合' }[t.mode] || t.mode;
      const isLatest = i === 0;
      const liveTag = t._live ? '<span class="mr-rt-tl-tab-latest" style="background:#22863a">实时</span>' : '';
      const latestTag = (isLatest && !t._live) ? '<span class="mr-rt-tl-tab-latest">最新</span>' : '';
      return `<button type="button" class="mr-rt-tl-tab ${isLatest ? 'active' : ''}" data-tab-idx="${i}" data-tab-live="${t._live ? '1' : '0'}" title="第 ${t.n} 轮 · ${escapeHtml(modeLabel)}">
        <span class="mr-rt-tl-tab-turn">第 ${t.n} 轮</span>
        <span class="mr-rt-tl-tab-mode ${escapeHtml(t.mode)}">${escapeHtml(modeLabel)}</span>
        ${liveTag}${latestTag}
      </button>`;
    }).join('');

    const hasAnyTab = turnsWithAns.length > 0;

    overlay.innerHTML = `
      <div class="mr-rt-tl-backdrop" data-rt-tl-close="1"></div>
      <aside class="mr-rt-tl-drawer mr-rt-tl-${slotClsTl}" role="dialog" aria-label="${escapeHtml(headerLabel)} 时间线">
        <header class="mr-rt-tl-drawer-head">
          <span class="mr-rt-tl-drawer-title">${escapeHtml(headerLabel)} · 历史回答</span>
          <span class="mr-rt-tl-drawer-meta">共 ${turnsWithAns.length} 轮</span>
          <button type="button" class="mr-rt-tl-close" data-rt-tl-close="1" aria-label="关闭">×</button>
        </header>
        ${hasAnyTab ? `<nav class="mr-rt-tl-tabs" role="tablist">${tabsHtml}</nav>` : ''}
        <div class="mr-rt-tl-content" id="mr-rt-tl-content">${renderTurnBody(turnsWithAns[0])}</div>
      </aside>
    `;
    overlay.style.display = 'block';

    // 2026-05-05 道雪：抽屉字号 scale —— 打开时从 localStorage 读上次值（默认 1.2，正文从
    //   13px 提升到 ~16px），Ctrl+滚轮 ±0.1 调整，clamp [0.8, 2.0]，preventDefault 拦掉
    //   Electron 默认整窗 zoom（仅抽屉内拦，抽屉外仍可整窗 zoom）。CSS 通过 --drawer-font-scale
    //   缩放 .mr-rt-tl-content 内的正文；header/tab 不受影响。
    const _drawerEl = overlay.querySelector('.mr-rt-tl-drawer');
    const FONT_SCALE_KEY = 'mr-drawer-font-scale';
    const FONT_SCALE_MIN = 0.8;
    const FONT_SCALE_MAX = 2.0;
    const FONT_SCALE_STEP = 0.1;
    const FONT_SCALE_DEFAULT = 1.2;
    let _drawerFontScale = (() => {
      const raw = parseFloat(localStorage.getItem(FONT_SCALE_KEY));
      return (Number.isFinite(raw) && raw >= FONT_SCALE_MIN && raw <= FONT_SCALE_MAX) ? raw : FONT_SCALE_DEFAULT;
    })();
    const _applyDrawerScale = (s) => {
      _drawerFontScale = Math.max(FONT_SCALE_MIN, Math.min(FONT_SCALE_MAX, Math.round(s * 10) / 10));
      if (_drawerEl) _drawerEl.style.setProperty('--drawer-font-scale', String(_drawerFontScale));
      try { localStorage.setItem(FONT_SCALE_KEY, String(_drawerFontScale)); } catch {}
    };
    _applyDrawerScale(_drawerFontScale);
    if (_drawerEl) {
      _drawerEl.addEventListener('wheel', (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        e.stopPropagation();
        const dir = e.deltaY < 0 ? +1 : -1;
        _applyDrawerScale(_drawerFontScale + dir * FONT_SCALE_STEP);
      }, { passive: false });
    }

    // T3：注册 live 订阅（仅当有 liveTurn 且默认 active 是它时）
    _rtTimelineLive = (liveTurn && turnsWithAns[0] && turnsWithAns[0]._live)
      ? { sid, mid: meeting.id, kind } : null;

    const contentEl = overlay.querySelector('#mr-rt-tl-content');
    overlay.querySelectorAll('.mr-rt-tl-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        overlay.querySelectorAll('.mr-rt-tl-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const idx = parseInt(btn.getAttribute('data-tab-idx') || '0', 10);
        const isLive = btn.getAttribute('data-tab-live') === '1';
        if (contentEl) {
          contentEl.innerHTML = renderTurnBody(turnsWithAns[idx]);
          contentEl.scrollTop = 0;
        }
        // T3：用户切走 live tab → 解订阅；切回 live tab → 重订阅
        _rtTimelineLive = (isLive && liveTurn) ? { sid, mid: meeting.id, kind } : null;
      });
    });

    const closeAll = () => {
      overlay.style.display = 'none';
      document.removeEventListener('keydown', escHandler);
      _rtTimelineLive = null;  // T3：关抽屉清订阅
      _rtTimelineCleanup = null;  // T3 fix：清掉自身指针，避免下次开抽屉重复 cleanup
    };
    const escHandler = (ev) => { if (ev.key === 'Escape') closeAll(); };
    overlay.querySelectorAll('[data-rt-tl-close]').forEach(el => {
      el.addEventListener('click', closeAll);
    });
    document.addEventListener('keydown', escHandler);
    // T3 fix（2026-05-04 道雪）：把本次 closeAll 注册为模块级清理函数。
    //   下次 _openRtTimeline 调用时会先调它，避免 escHandler 累积。
    _rtTimelineCleanup = closeAll;
  }

  // 乐观态生命周期：renderer 在 IPC 飞行期间用 _rtOptimisticTurn 标记自己写的乐观字段，
  // 一旦 IPC resolve / reject 或 server 推 turn-complete，就清掉这个标记 —— 之后 refresh
  // 拿到的 server state（含 idle）就是真值，merge 不再覆盖。
  // 不用单纯依赖 cached.currentMode 比对，避免轮次完成后 server.idle 被永远 merge 成乐观值。
  const _rtOptimisticTurn = {}; // { [meetingId]: { mode, t } }

  // 兼容旧调用名（handleMeetingSend 还在用 renderRoundtableBanner）
  function renderRoundtableBanner(meeting, result) {
    refreshRoundtablePanel(meeting);
    const cached = _rtPanelState[meeting.id];
    if (cached) renderToolbar(meeting);
  }

  // 投研圆桌触发器：按钮/输入框统一入口。立即给 UI pending 反馈，再异步 invoke IPC。
  function triggerRoundtable(meeting, mode, opts = {}) {
    const cached = _rtPanelState[meeting.id];
    // Stage 2 容错升级：记录本轮 prompt 发送时间戳，逃生工具栏的 manual-extract 用此过滤 JSONL
    _rtTurnStartTs[meeting.id] = Date.now();
    // 立即写本地乐观状态 + 标 _rtOptimisticTurn（IPC 完成后清掉）
    // 摘要功能 2026-05-08 整体下线：mode 仅 'fanout' / 'debate'
    _rtOptimisticTurn[meeting.id] = {
      mode,
      t: Date.now(),
    };
    if (cached) {
      cached.currentMode = mode;
      cached._partialBy = null;
    }
    refreshRoundtablePanel(meeting);
    renderToolbar(meeting); // 立即把按钮 disable，状态条改"⏳ 处理中…"

    const clearOptimistic = () => {
      delete _rtOptimisticTurn[meeting.id];
      const c = _rtPanelState[meeting.id];
      if (c) {
        // 不强写 idle —— 让 refresh 从 server 拿真值。但本地乐观字段必须先清，否则 merge 会保留它。
        c.currentMode = null; // null = 触发 merge 分支用 server 真值
      }
      refreshRoundtablePanel(meeting);
      renderToolbar(meeting);
    };

    ipcRenderer.invoke('roundtable:turn', {
      meetingId: meeting.id,
      mode,
      userInput: opts.userInput || '',
      // pilot redesign（2026-05-02）：传当前 dispatchMode（'all'|'pilot'|'observer'）。
      //   后端会校验 + 按值过滤 targetSubs；未传时按 meeting 持久化字段兜底（默认 'all'）。
      dispatchMode: meeting.dispatchMode || 'all',
    }).then((result) => {
      // 不论 completed / busy / error / no_sent，IPC 已返回 → 清乐观态，后续完全信任 server
      console.log('[roundtable] turn IPC resolved:', result && result.status, 'turn=', result && result.turnNum);
      clearOptimistic();
      // 用户血泪反馈"输入框卡死"根因：上一轮还在跑（_roundtableInProgress 占用）→ server
      // 返回 status='busy' → doSend 已清空 input → 用户感觉"按发送没反应消息消失"。
      // 这里识别 busy 时把原文还原回 input + 给清晰提示。
      if (result && result.status === 'busy') {
        const inp = document.getElementById('mr-input-box');
        if (inp && !inp.innerText.trim()) {
          inp.textContent = opts.userInput || '';
          _placeCaretAtEnd(inp);
        }
        alert('上一轮圆桌还在等其他家完成，无法发起新一轮。\n\n请用卡片上的"跳过"按钮处理仍在等待的家，或等他们自然完成后再发送。');
      }
    }).catch((e) => {
      console.error('[roundtable] turn IPC failed:', e.message);
      clearOptimistic();
    });
    meeting.lastMessageTime = Date.now();
    ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { lastMessageTime: meeting.lastMessageTime } });
  }

  function findSessionByKind(meeting, kind) {
    if (!meeting || !meeting.subSessions) return null;
    for (const sid of meeting.subSessions) {
      const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      if (s && s.kind === kind && s.status !== 'dormant') return sid;
    }
    return null;
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Roundtable 轮次完成：清掉 partialBy + 乐观标记（防止 turn-complete 比 IPC.then 更早），
  // 从 IPC 拉最终 state（含 turn N 已持久化）
  // 2026-05-05 道雪 修3：cache 清理对所有 meeting 都做（含非 active），DOM 重渲仅 active 做。
  //   之前的 `meetingId === activeMeetingId` 守卫导致非 active 圆桌 _partialBy 残留，
  //   切回时 cached.currentMode!=idle 但实际 server 已 idle → 卡片显示 streaming 假象。
  // 圆桌记忆 phase 1（2026-05-07）：主进程 memory-event 广播
  //   type:'write'             — memory_write 命中后；含 slot/count，增量更新该 slot count
  //   type:'checkpoint-done'   — worker 跑完 _profile.md + pending；触发整 meeting 状态重拉
  //   type:'checkpoint-failed' — worker 失败；触发重拉（让 pending count 仍刷新）
  ipcRenderer.on('memory-event', (_event, payload) => {
    if (!payload || !payload.meetingId) return;
    const { meetingId, slot, count, type } = payload;
    if (type === 'write' && slot) {
      if (!_memStatusBy[meetingId]) _memStatusBy[meetingId] = {};
      if (!_memStatusBy[meetingId][slot]) _memStatusBy[meetingId][slot] = { count: 0, pending: 0, hasProfile: false };
      if (typeof count === 'number') _memStatusBy[meetingId][slot].count = count;
      if (meetingId === activeMeetingId) {
        const m = meetingData[meetingId];
        if (m) refreshRoundtablePanel(m);
      }
      return;
    }
    if (type === 'checkpoint-done' || type === 'checkpoint-failed') {
      // worker 改了 _profile.md / pending-{slot}.json → 全 slot 重拉 status（lazy IPC 调）
      if (meetingId === activeMeetingId) {
        const m = meetingData[meetingId];
        if (m) _loadMemoryStatusForMeeting(m);
      }
    }
  });

  ipcRenderer.on('roundtable-turn-complete', (_event, { meetingId }) => {
    const meeting = meetingData[meetingId];
    if (!_isPanelCapableMeeting(meeting)) return;
    // === Phase 1: cache 清理（所有 meeting 都做）===
    delete _rtOptimisticTurn[meetingId];
    // 2026-05-05 道雪：本轮已 settle,state.turns[N].userInput 接管,清掉进行中缓存。
    delete _currentTurnUserInputByMeeting[meetingId];
    const cached = _rtPanelState[meetingId];
    if (cached) {
      cached._partialBy = null;
      cached.currentMode = null;
    }
    // === Phase 2: DOM 重渲（仅 active meeting）===
    //   非 active 圆桌的全员完成通知由 renderer.js 监听同 IPC 累加 meeting.unreadCount
    //   触发侧栏 has-unread + ⏸ 等你 badge，不在此处理。
    if (meetingId !== activeMeetingId) return;
    refreshRoundtablePanel(meeting);
    if (cached) renderToolbar(meeting);
  });

  // Roundtable state 元数据变更（轮次启停等）
  // 2026-05-05 道雪 修3：cache 同步对所有 meeting 都做（含非 active），DOM 重渲仅 active。
  //   非 active 圆桌的 currentMode 也得跟 server 同步，否则切回时 panel 显示老状态。
  ipcRenderer.on('roundtable-state-update', (_event, { meetingId }) => {
    const meeting = meetingData[meetingId];
    if (!_isPanelCapableMeeting(meeting)) return;
    if (meetingId === activeMeetingId) {
      // active：cache 同步 + DOM 重渲
      refreshRoundtablePanel(meeting);
    } else {
      // 非 active：仅 cache 同步（不动 DOM）
      _syncRoundtableCacheFromServer(meeting);
    }
  });

  // pilot redesign（2026-05-02）：timeline-append / timeline-update / _updatePilotPlaceholder 整体废弃
  //   （pilot recap 卡片不再生成，圆桌 timeline 只保留 fanout/debate/summary 公开发言记录）。

  // T2（2026-05-04 道雪）：partial diff 短路 — 内容完全没变就不动 DOM，
  //   修复 B2「皮卡丘已 settled 后小火龙心跳仍打回皮卡丘卡片滚动条」。
  function _isPartialUnchanged(prev, next) {
    if (!prev && !next) return true;
    if (!prev || !next) return false;
    if (prev.text !== next.text) return false;
    if (prev.status !== next.status) return false;
    if (prev.cleanBufLen !== next.cleanBufLen) return false;
    if (prev.sendStatus !== next.sendStatus) return false;
    const pt = prev.tokens && prev.tokens.total;
    const nt = next.tokens && next.tokens.total;
    if (pt !== nt) return false;
    const pb = Array.isArray(prev.blocks) ? prev.blocks : null;
    const nb = Array.isArray(next.blocks) ? next.blocks : null;
    if (!pb && !nb) return true;
    if (!pb || !nb) return false;
    if (pb.length !== nb.length) return false;
    if (pb.length === 0) return true;
    const last = pb.length - 1;
    if (pb[last].type !== nb[last].type) return false;
    if ((pb[last].text || '') !== (nb[last].text || '')) return false;
    return true;
  }

  // Roundtable 单家 partial-update：T2（2026-05-04 道雪）局部 patch + diff 短路 + scrollTop 保留
  //   修复 B2 滚动条弹回：旧版 panel.innerHTML 全量重渲，三家卡片 DOM 全销毁→
  //   皮卡丘 settled 后小火龙心跳仍把皮卡丘 .mr-ft-preview 的 scrollTop 拍回 0。
  // 2026-05-05 道雪 修3：cache 同步与 DOM 解耦 ——
  //   旧版 `meetingId !== activeMeetingId → return` 让非 active 圆桌的 cache 永远跟不上 server，
  //   切回时残留 streaming partial → 卡片显示错状态。新版 cache 同步对所有 meeting 都做，
  //   DOM 操作仅 active 时执行。
  ipcRenderer.on('roundtable-partial-update', (_event, { meetingId, sid, status, text, thinkSec, tokens, blocks, source, cleanBufLen }) => {
    const meeting = meetingData[meetingId];
    if (!_isPanelCapableMeeting(meeting)) return;
    // === Phase 1: cache 同步（任何 meeting 都做，含非 active）===
    let cached = _rtPanelState[meetingId];
    if (!cached) {
      // 没 cache 说明用户从没打开过这个圆桌 → 异步拉 server state 建 cache。
      //   本次 partial 不写（下次 partial 来时 cache 已建会正常合并），
      //   保持与旧版行为一致避免占位 cache 导致 lastTurn=null 渲染不完整。
      _syncRoundtableCacheFromServer(meeting).then(({ ok }) => {
        if (ok && meetingId === activeMeetingId) refreshRoundtablePanel(meeting);
      });
      return;
    }
    if (!cached._partialBy) cached._partialBy = {};
    const next = {
      text: text || '',
      status: status || 'completed',
      thinkSec: typeof thinkSec === 'number' ? thinkSec : undefined,
      tokens: tokens || undefined,
      blocks: Array.isArray(blocks) ? blocks : undefined,
      source: source || undefined,
      cleanBufLen: typeof cleanBufLen === 'number' ? cleanBufLen : undefined,
    };
    const prev = cached._partialBy[sid];
    // T2（2026-05-04 道雪）：先把 sendStatus 从 prev 抄到 next，再做 diff —— 否则 stuck 心跳每次都误判变化，短路失效。
    next.sendStatus = prev && prev.sendStatus;
    // 2026-05-05 fix（虚警）：streaming/completed/manual_extracted 物理上否定 stuck 状态
    //   （\r 提交已生效），强清 sendStatus。否则 1A verify 误判 stuck 后即使后续真
    //   streaming 750 字进来，UI 仍显示"⚠ 输入卡顿"误导用户。
    if (next.sendStatus === 'stuck' && (status === 'streaming' || status === 'completed' || status === 'manual_extracted')) {
      delete next.sendStatus;
    }
    // T2 short-circuit：内容完全无变化（高频心跳常见）→ 直接 return，0 DOM 操作
    if (_isPartialUnchanged(prev, next)) return;
    cached._partialBy[sid] = next;  // ← cache 写入完成（无论 active 与否都做）

    // === Phase 2: DOM 更新（仅 active meeting 做）===
    if (meetingId !== activeMeetingId) return;

    // 2026-05-05 道雪：时光机模式短路 — 用户在看第 N 轮历史快照时，partial-update
    //   不应该把卡片 outerHTML 替换为最新 streaming 内容（否则用户感知"被强制跳回最新轮"）。
    //   cache 已经在上面更新（保持一致性，用户退出时光机后即可看到最新态），仅跳过 DOM patch。
    //   refreshRoundtablePanel 全量路径走 _renderFusedTabs 已有 isTimeTravel 分支，不受影响。
    if (typeof _rtViewingTurnN[meetingId] === 'number') return;

    // T2 局部 patch：找到该 sid 的 slot DOM，outerHTML 替换；其他两个 slot 完全不动
    const panel = _ensureRtPanel();
    const slotEl = panel.querySelector(`.mr-ft[data-ft-sid="${sid}"]`);
    if (!slotEl) {
      // 兜底：DOM 找不到该 slot（panel 还没渲染过）→ 全量重渲
      // silent-failure-hunter L1（2026-05-04 道雪）：并发场景（partial-update 在 turn-complete
      //   之后到、cached 字段意外 null）下 _renderRtPanelHtml 可能抛 TypeError，
      //   原版无 try/catch → 整个 IPC 回调崩溃，panel 残破。包一层让回调能 return。
      try {
        panel.innerHTML = _renderRtPanelHtml(cached, meeting);
        _bindRtPanelEvents(panel, meeting);
      } catch (e) {
        console.error('[roundtable] partial-update fallback rebuild failed:', e);
      }
      return;
    }
    // T2 scrollTop 保留：替换前记录 .mr-ft-preview 的滚动位置（即使是流式增长的家自己，也尽量保留）
    const prevPreview = slotEl.querySelector('.mr-ft-preview');
    const savedScrollTop = prevPreview ? prevPreview.scrollTop : 0;
    // 计算新 HTML
    const slots = _getRtSlots(meeting);
    const slotIndex = slots.findIndex(slot => slot && slot.sid === sid);
    if (slotIndex < 0) return;
    const lastTurn = cached.turns.length > 0 ? cached.turns[cached.turns.length - 1] : null;
    const focused = meeting.focusedSub || meeting.subSessions[0];
    const ctx = {
      state: cached, currentMode: cached.currentMode || 'idle', partialBy: cached._partialBy,
      meeting, slots, lastTurn, meetingId: meeting.id, focused,
    };
    const { html } = _renderSlotCard(slotIndex, ctx);
    if (!html) return;
    // outerHTML 替换该 slot（其他卡片 DOM 节点完全不被打扰）
    slotEl.outerHTML = html;
    // 重新查找新节点（outerHTML 替换后旧引用已失效）
    const newSlotEl = panel.querySelector(`.mr-ft[data-ft-sid="${sid}"]`);
    if (newSlotEl) {
      _bindSlotCardEvents(newSlotEl, meeting);
      // 恢复 scrollTop
      const newPreview = newSlotEl.querySelector('.mr-ft-preview');
      if (newPreview && savedScrollTop > 0) newPreview.scrollTop = savedScrollTop;
    }
    // 应用 pilot 视觉（红框）— 与全量 refreshRoundtablePanel 保持一致
    if (meeting.mode !== 'free') {
      const pilotSlotForVisual = (typeof meeting.pilotSlot === 'number' && meeting.pilotSlot >= 0 && meeting.pilotSlot <= 2)
        ? meeting.pilotSlot : null;
      const dispatchModeForVisual = ['all', 'pilot', 'observer'].includes(meeting.dispatchMode)
        ? meeting.dispatchMode : 'all';
      requestAnimationFrame(() => {
        _applyPilotCardVisual(meeting, pilotSlotForVisual, dispatchModeForVisual);
      });
    }
    // T3（2026-05-04 道雪）：抽屉实时订阅 — 用户打开 ↗ 看本 sid 的实时 tab 时，
    //   不重建 overlay，仅 mutate `.mr-rt-tl-body` innerHTML，保留用户的滚动位置。
    if (_rtTimelineLive && _rtTimelineLive.sid === sid && _rtTimelineLive.mid === meetingId) {
      const overlay = document.getElementById('mr-rt-timeline-overlay');
      if (overlay && overlay.style.display !== 'none') {
        const tlBody = overlay.querySelector('.mr-rt-tl-body');
        if (tlBody) {
          let inner;
          if (Array.isArray(next.blocks) && next.blocks.length > 0) {
            inner = _renderPreviewBlocks(next.blocks, sid);
          } else if (next.text) {
            inner = _renderMarkdown(next.text);
          } else {
            inner = '<div class="mr-rt-tl-empty" style="opacity:.6">💭 思考中…等待 AI 输出</div>';
          }
          // T3 滚动保留：mutate innerHTML 时记录旧 scrollTop，在父容器（.mr-rt-tl-content）层面恢复
          const tlContent = overlay.querySelector('#mr-rt-tl-content');
          const savedScroll = tlContent ? tlContent.scrollTop : 0;
          tlBody.innerHTML = inner;
          if (tlContent && savedScroll > 0) tlContent.scrollTop = savedScroll;
        }
      }
    }
  });

  // Stage 2 容错升级：软提醒 banner —— watcher 在 T1=90s/T2=180s 触发，UI 弹非阻塞 banner
  // 提示用户"还在等"，提供"一键提取/跳过/继续等"操作。永不阻塞按钮（按钮 disabled
  // 由 _allParticipantsSettled 决定，与本 banner 无关）。
  ipcRenderer.on('roundtable-soft-alert', (_event, { meetingId, sid, label, level, mode, turnNum }) => {
    const meeting = meetingData[meetingId];
    if (!_isPanelCapableMeeting(meeting)) return;
    // 2026-05-05 道雪 修3：cache 同步对所有 meeting 都做（写 _partialBy[sid].status='soft_alert'），
    //   切回该圆桌时卡片自动显示"等待中…"状态。
    //   banner DOM 仅 active 时弹（跨 meeting 弹 banner 文案"XX 已等待"会让用户混乱当前看的不是这个圆桌）。
    //   非 active 圆桌的 soft-alert 不接入侧栏 unread —— 这是"AI 慢响应"信号，
    //   语义跟"全员完成"不同，混入侧栏会让"⏸ 等你"badge 含义模糊。
    const cached = _rtPanelState[meetingId];
    if (cached) {
      if (!cached._partialBy) cached._partialBy = {};
      const existing = cached._partialBy[sid] || {};
      cached._partialBy[sid] = { text: existing.text || '', status: 'soft_alert' };
    }
    // === Phase 2: banner DOM 与 panel 重渲（仅 active）===
    if (meetingId !== activeMeetingId) return;
    const banner = document.getElementById('mr-rt-soft-alert-banner');
    if (banner) {
      const levelLabel = level === 't2' ? '3 分钟' : '90 秒';
      const urgency = level === 't2' ? 'urgent' : '';
      // FIX-B（2026-05-01）：T2（3min）文案明确指引"用卡片按钮绕过"，不再让用户傻等
      const hint = level === 't2'
        ? '⚠ 已等待 3 分钟仍无响应，大概率卡死。请用卡片上的「一键提取 / 跳过 / 重新拉起」按钮处理这家。'
        : '可能是慢响应 / 限流 / 卡死。可用卡片上的"一键提取 / 跳过"绕过，或继续等待自然完成。';
      banner.className = `mr-rt-soft-alert-banner ${urgency}`;
      banner.innerHTML = `
        <div class="mr-rt-soft-alert-msg">
          <strong>${escapeHtml(label || sid.slice(0, 8))}</strong> 已等待 <strong>${levelLabel}</strong>。
          <span class="mr-rt-soft-alert-hint">${hint}</span>
        </div>
        <button class="mr-rt-soft-alert-close" data-rt-banner-close="1" title="关闭提示">×</button>
      `;
      banner.style.display = 'flex';
      banner.querySelectorAll('[data-rt-banner-close]').forEach(b => {
        b.addEventListener('click', () => { banner.style.display = 'none'; banner.innerHTML = ''; }, { once: true });
      });
    }
    if (cached) {
      const panel = _ensureRtPanel();
      panel.innerHTML = _renderRtPanelHtml(cached, meeting);
      _bindRtPanelEvents(panel, meeting);
    }
  });

  // T6（2026-05-03）：send-stuck 事件 → 数据驱动写 _partialBy[sid].sendStatus='stuck'，
  //   再 refreshRoundtablePanel 重渲——这样 innerHTML 重渲后状态也能保留（H2 数据驱动方案）。
  //   H1 修复：补 activeMeetingId 守卫，与其他 roundtable-* 监听器保持一致。
  ipcRenderer.on('roundtable-send-stuck', (_e, { meetingId, sid /*, kind, mode */ }) => {
    const meeting = meetingData[meetingId];
    if (!_isPanelCapableMeeting(meeting)) return;
    // 2026-05-05 道雪 修3：cache 同步对所有 meeting 都做（写 sendStatus='stuck'），
    //   切回该圆桌时卡片自动显示"⚠ 输入卡顿"状态 + [📤 发送] 按钮亮起。
    //   panel DOM 重渲仅 active 做。
    const cached = _rtPanelState[meetingId];
    if (cached) {
      if (!cached._partialBy) cached._partialBy = {};
      const existing = cached._partialBy[sid] || {};
      // 保留已有 text/status/blocks，仅追加 sendStatus='stuck'
      cached._partialBy[sid] = { ...existing, sendStatus: 'stuck' };
    }
    console.warn(`[renderer] roundtable-send-stuck meeting=${meetingId} sid=${sid.slice(0,8)}`);
    if (meetingId !== activeMeetingId) return;
    if (cached) {
      const panel = _ensureRtPanel();
      panel.innerHTML = _renderRtPanelHtml(cached, meeting);
      _bindRtPanelEvents(panel, meeting);
    }
  });

  // T6（2026-05-03）：turn-patched 事件 → 卡片右上角浮"自动补全 +N 字"角标 + 触发刷新
  //   H1 修复：补 activeMeetingId 守卫。
  //   M2 修复（最小化方案）：先 await refreshRoundtablePanel 拿最新 turn meta 重渲，
  //     再追加 badge 到新 DOM 节点上（旧节点已被 innerHTML 替换），避免 badge 被立即抹掉。
  ipcRenderer.on('roundtable-turn-patched', async (_e, { meetingId, turnNum, sid, charCount }) => {
    const meeting = meetingData[meetingId];
    if (!_isPanelCapableMeeting(meeting)) return;
    // 2026-05-05 道雪 修3：cache 同步（拉 server state 拿到 patch 后的 lastTurn.by）对所有 meeting 都做，
    //   切回该圆桌时 lastTurn 自动是 patch 后的最新文本。
    //   "自动补全 +N 字"badge 是 3s 浮动动画，仅 active 时追加（跨切换语义弱，非 active 期间错过没影响）。
    if (meetingId === activeMeetingId) {
      // active：先重渲拿最新 turn meta，badge 在新 DOM 上追加
      await refreshRoundtablePanel(meeting);
      const card = document.querySelector(`.mr-ft[data-ft-sid="${sid}"]`);
      if (card) {
        let badge = card.querySelector('.mr-ft-auto-patched-badge');
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'mr-ft-auto-patched-badge';
          card.appendChild(badge);
        }
        badge.textContent = `自动补全 +${charCount}字`;
        badge.classList.remove('fade-out');
        void badge.offsetWidth;  // 强制 reflow 让 fade-out 动画从头开始
        badge.classList.add('fade-out');
        setTimeout(() => { try { badge.remove(); } catch {} }, 3000);
      }
    } else {
      // 非 active：仅 cache 同步（不动 DOM）
      _syncRoundtableCacheFromServer(meeting);
    }
    console.log(`[renderer] roundtable-turn-patched turn=${turnNum} sid=${sid.slice(0,8)} +${charCount} chars`);
  });

  const panelEl = () => document.getElementById('meeting-room-panel');
  const headerEl = () => document.getElementById('mr-header');
  const terminalsEl = () => document.getElementById('mr-terminals');
  const toolbarEl = () => document.getElementById('mr-toolbar');
  const inputBoxEl = () => document.getElementById('mr-input-box');
  const sendBtnEl = () => document.getElementById('mr-send-btn');

  // 2026-05-05 道雪：输入框草稿 per meeting 独立。#mr-input-box 是全局唯一 DOM,
  //   切换不同圆桌时 textContent 不变 → 用户感知"输入框被共享/串味"。
  //   切换前 save 当前 mid 的草稿、切换后 restore 新 mid 的草稿即可独立。
  //   仅内存级（不落盘）：重启 Hub 草稿丢失，与"输入未发送临时缓冲"语义一致。
  const _inputDraftByMeeting = {};

  // 2026-05-05 道雪：用户提问 banner 的"进行中轮"缓存。
  //   handleMeetingSend 入口写入 → turn-complete 清空 → state.turns[N].userInput 接管。
  //   这样从用户点发送 → server 推 turn-complete 之间(数秒到数分钟),banner 就能立即显示
  //   "你刚发的提问 + 进行中"标签,不必等本轮 settle 才出现。
  const _currentTurnUserInputByMeeting = {};
  function _saveInputDraft() {
    if (!activeMeetingId) return;
    const inp = document.getElementById('mr-input-box');
    if (!inp) return;
    const text = inp.innerText || '';
    if (text.trim()) _inputDraftByMeeting[activeMeetingId] = text;
    else delete _inputDraftByMeeting[activeMeetingId];
  }
  function _restoreInputDraft(meetingId) {
    const inp = document.getElementById('mr-input-box');
    if (!inp) return;
    inp.textContent = _inputDraftByMeeting[meetingId] || '';
  }

  function init() {
    // no-op — kept for backward compat; refs resolved lazily
  }

  function openMeeting(meetingId, meeting) {
    // 切换前先保存上一个 meeting 的草稿（如果有）；切换到同一个 meeting 不存。
    if (activeMeetingId && activeMeetingId !== meetingId) _saveInputDraft();
    activeMeetingId = meetingId;
    meetingData[meetingId] = meeting;

    const panel = panelEl();
    panel.style.display = 'flex';

    renderHeader(meeting);
    renderTerminals(meeting);
    renderToolbar(meeting);
    setupInput(meeting);
    // setupInput 在 _inputBound=true 时直接 return,不会更新 textContent。
    // 这里兜底恢复草稿:无论 setupInput 内是首次绑定路径还是 bypass 路径,都保证
    // 切换 meeting 后 inputBox 显示当前 meeting 的草稿。
    _restoreInputDraft(meetingId);
    startMarkerPoll();
    // IF-C1：开启 CLI ready 轮询，驱动卡片"创建中→待命"切换。
    // IF-C6（多方审查 medium 修复）：拿首次 poll 的 promise，等它返回后再 refresh panel
    //   避免首屏闪烁——一次 IPC < 100ms，对用户感知近乎瞬间。
    const firstPoll = startCliReadyPoll();

    // 两模式(通用/投研)进入会议室即刷新持久化面板
    // 先做一次同步渲染（保持响应不阻塞），await 首次 poll 后再 refresh 一次（修首屏闪烁）
    if (_isPanelCapableMeeting(meeting)) {
      refreshRoundtablePanel(meeting);
      // 异步等首次 poll 后再 refresh 一次（poll 内部已会重渲，这里只是兜底，不阻塞 UI）
      if (firstPoll && typeof firstPoll.then === 'function') {
        firstPoll.then(() => {
          if (activeMeetingId === meetingId) {
            try { _refreshSoftAlert(meeting); } catch {}
          }
        }).catch(() => {});
      }
    } else {
      _removeRtPanel();
    }

    // IF-C3（2026-05-01）：进会议室立即刷一次软提醒 banner（AI 未 ready 时提示用户）
    try { _refreshSoftAlert(meeting); } catch {}

    // Card optimization Task 9（2026-05-01）：恢复持久化的沉浸/调试模式
    if (_isPanelCapableMeeting(meeting)) {
      _restoreMeetingMode(meeting).catch(() => {});
    }

    // Card optimization Task 10（2026-05-01）：开启 ResizeObserver 防溢出兜底（Task 10 提供）
    if (typeof _setupMeetingResizeObserver === 'function') _setupMeetingResizeObserver();

    // IF-C2（2026-05-01）：auto-focus 输入框 — 修 P1 bug A（输入框暂时不可用）。
    //   xterm.terminal.open() + robustFit 的 rAF 循环会抢焦点；用 setTimeout 50ms
    //   defer 到 xterm 初始化稳定后再 focus，让用户进会议室立即可键盘输入。
    setTimeout(() => {
      const inputBox = document.getElementById('mr-input-box');
      if (inputBox && document.activeElement !== inputBox) {
        inputBox.focus();
      }
    }, 50);
  }

  function closeMeetingPanel() {
    // 离开圆桌前先保存草稿，下次重新进入时恢复。
    _saveInputDraft();
    activeMeetingId = null;
    _inputBound = false;
    stopMarkerPoll();
    _markerStatusCache = {};
    // IF-C1：关闭轮询并清空 ready cache，下次 openMeeting 重新检测
    stopCliReadyPoll();
    _cliReadyCache = {};
    // IF-C3：清空 banner dismiss 状态 + 隐藏 banner，下次进同会议再显示一次
    _bannerDismissedFor = null;
    _lastNotReadyCount = 0;
    const _banner = document.getElementById('mr-input-soft-alert');
    if (_banner) { _banner.style.display = 'none'; _banner.innerHTML = ''; }
    // Card optimization Task 10（2026-05-01）：拆 ResizeObserver / window resize 监听，避免 panel 隐藏后还触发 fit
    if (typeof _teardownMeetingResizeObserver === 'function') _teardownMeetingResizeObserver();
    // F6 Phase 3: 切 meeting 清引用 chips, 避免跨 meeting 误带
    if (typeof _clearQuoteChips === 'function') _clearQuoteChips();
    if (_rtQuoteFloatBtn) _rtQuoteFloatBtn.style.display = 'none';
    const panel = panelEl();
    if (panel) panel.style.display = 'none';
    const el = terminalsEl();
    if (el) el.innerHTML = '';
    subTerminals = {};
  }

  // Arch refactor 2026-05-02: 沉浸/调试模式切换已删除。圆桌只有一种视图，
  // 这些函数保留为 no-op 以兼容内部调用（openMeeting 仍调 _restoreMeetingMode）。
  function _toggleMeetingMode() { /* removed: only one view now */ }
  function _applyMeetingMode(_immersive) { /* removed */ }
  async function _restoreMeetingMode(_meeting) { /* removed */ }

  // Card optimization Task 10（2026-05-01）— 动态重排兜底：
  //   触发场景：窗口 resize / 沉浸切换 / 历史面板展开 / preview markdown 长度跳变 /
  //             session 加减 / devtools 开关
  //   策略：ResizeObserver 监 #meeting-room-panel 尺寸 + window 'resize' →
  //         debounce 100ms → 强制 reflow + 对所有 subTerminals 调 fitAddon.fit()
  //   subTerminals[sid] 结构（renderer.js:919）：{ terminal, fitAddon, searchAddon, container, opened }。
  //   T9 已预先在 openMeeting / closeMeetingPanel 调 setup/teardown（typeof 守卫）。
  function _debounce(fn, wait) {
    let t = null;
    return function (...args) {
      if (t) clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  let _meetingResizeObserver = null;
  let _windowResizeHandler = null;
  let _lastLayoutW = 0;
  let _lastLayoutH = 0;

  function _relayoutMeetingRoom() {
    const panel = document.getElementById('meeting-room-panel');
    if (!panel || panel.style.display === 'none') return;

    // 强制 reflow（避免延迟到下次 paint）
    void panel.offsetHeight;

    // 沉浸模式下 .mr-terminals height:0 + opacity:0，xterm 容器尺寸为 0，
    //   FitAddon.fit() 在 rows/cols < 1 时可能抛 (xterm 协议下限)。即便外层 try/catch
    //   吃掉异常，频繁失败调用也是浪费——直接 skip。
    //   多方审查反馈（DeepSeek V4-pro 中置信度 #1）。
    const skipFit = panel.classList.contains('immersive');

    if (!skipFit && typeof subTerminals === 'object' && subTerminals) {
      for (const sid of Object.keys(subTerminals)) {
        const cached = subTerminals[sid];
        if (cached && cached.fitAddon && typeof cached.fitAddon.fit === 'function') {
          try { cached.fitAddon.fit(); } catch (_) {}
        }
      }
    }

    // history panel 高度（如展开）— 当前 DOM 暂未引入 #mr-history-panel，保留兜底以防未来加入
    const hp = document.getElementById('mr-history-panel');
    if (hp && hp.classList.contains('expanded')) {
      hp.style.maxHeight = `${hp.scrollHeight}px`;
    }
  }

  function _setupMeetingResizeObserver() {
    if (_meetingResizeObserver) return;
    const panel = document.getElementById('meeting-room-panel');
    if (!panel) return;

    const debouncedRelayout = _debounce((entries) => {
      const e = entries && entries[0];
      if (!e) { _relayoutMeetingRoom(); return; }
      const { width, height } = e.contentRect;
      // 抖动过滤：宽高变化 <4px 视为噪声（典型滚动条出现/消失边缘）
      if (Math.abs(width - _lastLayoutW) < 4 && Math.abs(height - _lastLayoutH) < 4) return;
      _lastLayoutW = width;
      _lastLayoutH = height;
      _relayoutMeetingRoom();
    }, 100);

    _meetingResizeObserver = new ResizeObserver(debouncedRelayout);
    _meetingResizeObserver.observe(panel);

    // window resize（cover devtools 开关、窗口拖拽尺寸）
    _windowResizeHandler = _debounce(() => _relayoutMeetingRoom(), 100);
    window.addEventListener('resize', _windowResizeHandler);
  }

  function _teardownMeetingResizeObserver() {
    if (_meetingResizeObserver) {
      try { _meetingResizeObserver.disconnect(); } catch (_) {}
      _meetingResizeObserver = null;
    }
    if (_windowResizeHandler) {
      try { window.removeEventListener('resize', _windowResizeHandler); } catch (_) {}
      _windowResizeHandler = null;
    }
    _lastLayoutW = 0; _lastLayoutH = 0;
  }

  function getActiveMeetingId() {
    return activeMeetingId;
  }

  function getMeetingData(meetingId) {
    return meetingData[meetingId] || null;
  }

  let _updating = false;
  function updateMeetingData(meetingId, updated) {
    if (_updating) return;
    _updating = true;
    try {
      const prev = meetingData[meetingId];
      meetingData[meetingId] = updated;
      if (activeMeetingId === meetingId) {
        renderHeader(updated);
        renderToolbar(updated);
        // 模式切换时同步刷新面板与终端容器可见性（E2E 修复）
        if (_isPanelCapableMeeting(updated)) {
          refreshRoundtablePanel(updated);
        } else {
          _removeRtPanel();
        }
        const term = terminalsEl();
        if (term) applyModeContainerVisibility(updated, term);
        const prevSubs = prev ? prev.subSessions.join(',') : '';
        const newSubs = updated.subSessions ? updated.subSessions.join(',') : '';
        const modeChanged = prev && (prev.scene !== updated.scene);
        // T7 fix（2026-05-04）：free 模式下 participants 变化（尤其 0 人→非0）需重刷 setupInput
        // 以同步 sendBtn.disabled 和 inputBox placeholder/readonly 状态。
        const prevParts = prev && Array.isArray(prev.participants) ? prev.participants.join(',') : 'null';
        const newParts = Array.isArray(updated.participants) ? updated.participants.join(',') : 'null';
        const participantsChanged = prevParts !== newParts;
        const modeModeChanged = prev && (prev.mode !== updated.mode);
        if (prevSubs !== newSubs || modeChanged || participantsChanged || modeModeChanged) {
          renderTerminals(updated);
          setupInput(updated);
        }
      }
    } catch (e) {
      console.error('[meeting-room] updateMeetingData error:', e);
      // 注：故意不清 _inputBound，保留上次绑定避免 setupInput 重渲后 listener 丢失
    } finally {
      _updating = false;
    }
  }

  // --- Header ---

  function renderHeader(meeting) {
    const el = headerEl();
    if (!el) return;
    const showLayoutButtons = !_isPanelCapableMeeting(meeting);
    const layoutButtonsHtml = showLayoutButtons ? `
        <button class="mr-header-btn ${meeting.layout === 'focus' ? 'active' : ''}" id="mr-btn-focus">Focus</button>` : '';

    // Arch refactor 2026-05-02: 沉浸/调试切换按钮已删除。圆桌界面只有一种
    // 视图（永远纯卡片），shell 沉到子 session 主区。

    el.innerHTML = `
      <div class="mr-header-left">
        <span class="mr-header-title" id="mr-title">${escapeHtml(meeting.title)}</span>
        <span class="mr-header-meta" id="mr-header-meta"></span>
      </div>
      <div class="mr-header-progress" id="mr-header-progress" title="本轮发言进度"></div>
      <div class="mr-header-right">${layoutButtonsHtml}
        <div class="mr-view-toggle" role="group" aria-label="Card view mode">
          <button class="mr-header-btn mr-view-btn ${!_isCardTabMode() ? 'active' : ''}" id="mr-btn-view-parallel" title="并列显示 3 张 AI 卡片">并列</button>
          <button class="mr-header-btn mr-view-btn ${_isCardTabMode() ? 'active' : ''}" id="mr-btn-view-tab" title="Tab 模式：主界面只显示当前 AI 卡片">Tab</button>
        </div>
        <button class="mr-header-btn" id="mr-btn-add-sub" title="添加子会话">+ 添加</button>
        <button class="btn-zoom btn-memo-toggle ${typeof localStorage !== 'undefined' && localStorage.getItem('claude-hub-memo-open') === 'true' ? 'active' : ''}" id="mr-btn-memo" title="Toggle memo panel"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v9a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5v-9zM4 5h8M4 8h8M4 11h5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/></svg></button>
        <button class="btn-zoom" id="mr-btn-zoom-out" title="Shrink UI">A−</button>
        <button class="btn-zoom" id="mr-btn-zoom-in" title="Enlarge UI">A+</button>
        <button class="btn-close-session" id="mr-btn-close" title="关闭会议室" aria-label="Close meeting"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg></button>
      </div>
    `;

    const focusBtn = document.getElementById('mr-btn-focus');
    if (focusBtn) focusBtn.addEventListener('click', () => setLayout(meeting.id, 'focus'));
    const parallelBtn = document.getElementById('mr-btn-view-parallel');
    const tabBtn = document.getElementById('mr-btn-view-tab');
    if (parallelBtn) parallelBtn.addEventListener('click', () => {
      _setCardViewMode('parallel', meeting);
      renderHeader(meeting);
    });
    if (tabBtn) tabBtn.addEventListener('click', () => {
      _setCardViewMode('tab', meeting);
      renderHeader(meeting);
    });
    document.getElementById('mr-btn-add-sub').addEventListener('click', () => showAddSubMenu(meeting.id));
    // 注：顶部 scene toggle（圆桌/投研）已删除（2026-05-04 决策：scene 创建时确定，运行时不可切换）。
    // Arch refactor 2026-05-02: 沉浸/调试 toggle 删除，无需 binding。
    document.getElementById('mr-btn-memo').addEventListener('click', () => { if (typeof toggleMemoPanel === 'function') toggleMemoPanel(); });
    document.getElementById('mr-btn-zoom-out').addEventListener('click', () => { if (typeof applyZoom === 'function') applyZoom(currentZoom - 1); });
    document.getElementById('mr-btn-zoom-in').addEventListener('click', () => { if (typeof applyZoom === 'function') applyZoom(currentZoom + 1); });
    document.getElementById('mr-btn-close').addEventListener('click', async () => {
      await ipcRenderer.invoke('close-meeting', meeting.id);
      closeMeetingPanel();
    });

    const titleSpan = document.getElementById('mr-title');
    titleSpan.addEventListener('dblclick', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = meeting.title;
      input.className = 'mr-header-title';
      input.style.cssText = 'border:1px solid var(--accent);border-radius:4px;padding:2px 6px;background:var(--bg-primary);color:var(--text-primary);font-size:14px;font-weight:600;outline:none;';
      titleSpan.replaceWith(input);
      input.focus();
      input.select();
      const finish = () => {
        const trimmed = input.value.trim();
        if (trimmed && trimmed !== meeting.title) {
          meeting.title = trimmed;
          ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { title: trimmed } });
        }
        const newSpan = document.createElement('span');
        newSpan.className = 'mr-header-title';
        newSpan.id = 'mr-title';
        newSpan.textContent = meeting.title;
        input.replaceWith(newSpan);
      };
      input.addEventListener('blur', finish);
      input.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { input.value = meeting.title; input.blur(); }
      });
    });
  }

  // --- Add Sub-Session Menu ---

  function showAddSubMenu(meetingId) {
    const meeting = meetingData[meetingId];
    if (!meeting || meeting.subSessions.length >= 3) return;

    const btn = document.getElementById('mr-btn-add-sub');
    const rect = btn.getBoundingClientRect();

    const old = document.getElementById('mr-add-sub-menu');
    if (old) old.remove();

    const menu = document.createElement('div');
    menu.id = 'mr-add-sub-menu';
    menu.className = 'mr-quote-menu';
    menu.style.top = rect.bottom + 4 + 'px';
    menu.style.left = rect.left + 'px';

    // 用 ALL_AI_KINDS 单一真理源动态生成菜单项 — Claude/Gemini/Codex 用 "<Brand> CLI" 后缀，
    // 其他 Claude 家族（DeepSeek/GLM/GPT/Kimi/Qwen）用纯 brand 名（都跑在 Claude CLI 上）。
    const _CLI_SUFFIX = { claude: 'Claude Code', gemini: 'Gemini CLI', codex: 'Codex CLI' };
    const kinds = ALL_AI_KINDS.map(k => ({
      kind: k,
      label: _CLI_SUFFIX[k] || getKindLabel(k),
    }));
    kinds.push({ kind: 'powershell', label: 'PowerShell' });

    for (const { kind, label } of kinds) {
      const item = document.createElement('button');
      item.className = 'mr-quote-menu-item';
      item.textContent = label;
      item.addEventListener('click', async () => {
        menu.remove();
        const result = await ipcRenderer.invoke('add-meeting-sub', { meetingId, kind });
        if (result && result.meeting) {
          meetingData[meetingId] = result.meeting;
          renderTerminals(result.meeting);
          renderToolbar(result.meeting);
          setupInput(result.meeting);
        }
      });
      menu.appendChild(item);
    }

    document.body.appendChild(menu);
    const dismiss = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('mousedown', dismiss);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
  }

  // --- Terminal Rendering ---

  function applyModeContainerVisibility(meeting, container) {
    if (!container) return;
    container.classList.remove('mr-terminals-hidden');
  }

  // Arch refactor 2026-05-02: 圆桌界面去 shell。原 #mr-terminals 已删除，xterm
  // 仅在子 session 主区 shell view 挂载（renderer.js: showTerminal）。这些
  // mount/render 函数保留签名以兼容调用方，body 改为 no-op。subTerminals 永远
  // 为空对象，下游 fit 循环空跑无害。
  function renderTerminals(_meeting) { /* removed: shell moved to sub-session view */ }

  function openSubTerminal(_sessionId) { /* removed */ }

  function subModelBadgeHtml(session) {
    if (!session || !session.currentModel) return '';
    const cls = typeof modelClass === 'function' ? modelClass(session.currentModel.id) : '';
    const label = typeof modelShort === 'function' ? modelShort(session.currentModel) : (session.currentModel.displayName || '');
    return `<span class="model-badge ${cls}" title="${escapeHtml(session.currentModel.id)}">${escapeHtml(label)}</span>`;
  }

  function subCtxBadgeHtml(session) {
    if (!session || typeof session.contextPct !== 'number') return '';
    const cls = typeof pctClass === 'function' ? pctClass(session.contextPct) : 'ok';
    return `<span class="ctx-badge ${cls}" title="Context ${session.contextPct}%">Ctx ${session.contextPct}%</span>`;
  }

  function markerStatusHtml(sessionId) {
    const cache = _markerStatusCache[sessionId];
    if (cache === 'done') return '<span class="mr-marker-status mr-marker-badge done">✓</span>';
    if (cache === 'streaming') return '<span class="mr-marker-status mr-marker-badge streaming">⏳</span>';
    return '<span class="mr-marker-status mr-marker-badge none">—</span>';
  }

  function startMarkerPoll() {
    if (_markerPollTimer) return;
    _markerPollTimer = setInterval(async () => {
      if (!activeMeetingId) return;
      const meeting = meetingData[activeMeetingId];
      if (!meeting) return;
      let changed = false;
      for (const sid of meeting.subSessions) {
        const status = await ipcRenderer.invoke('marker-status', sid);
        if (_markerStatusCache[sid] !== status) {
          _markerStatusCache[sid] = status;
          changed = true;
        }
      }
      if (changed) {
        updateMarkerBadges(meeting);
      }
    }, 2000);
  }

  function stopMarkerPoll() {
    if (_markerPollTimer) { clearInterval(_markerPollTimer); _markerPollTimer = null; }
  }

  // IF-C1（2026-05-01）— 修 P0 阻塞 bug B：永久卡死"创建中"
  // 每秒 invoke cli-ready-status IPC 更新 _cliReadyCache，驱动 isInitializing。
  // 一家 ready 后置 true 不再变（除非会议关闭重置），避免实时切换造成 UI 抖动。
  function startCliReadyPoll() {
    if (_cliReadyPollTimer) return;
    const pollOnce = async () => {
      if (!activeMeetingId) return;
      // 2026-05-05 道雪：activeMeetingId 快照 + race guard。
      //   原版在 await invoke 后用全局 activeMeetingId 拿 cached、用 T0 闭包的 meeting 写 panel —
      //   用户在 await 期间切到 B 时，cached=cachedB + meeting=meetingA 混渲（标题来自 A 但 stepper/
      //   turns 来自 B）。同样可能让 panel 在用户感知"未操作"瞬间显示错圆桌内容。
      const startActiveMeetingId = activeMeetingId;
      const meeting = meetingData[startActiveMeetingId];
      if (!meeting || !Array.isArray(meeting.subSessions)) return;
      let changed = false;
      let needRefresh = false;
      for (const sid of meeting.subSessions) {
        if (_cliReadyCache[sid]) continue; // 已 ready 不重查（CLI exit 时由 'session-closed' 清缓存触发重查）
        try {
          const ready = await ipcRenderer.invoke('cli-ready-status', sid);
          if (ready) {
            _cliReadyCache[sid] = true;
            changed = true;
            needRefresh = true;
          }
        } catch {}
      }
      // race guard：await 期间 activeMeetingId 已变（用户切走/会议关闭）→ 不写 panel
      if (activeMeetingId !== startActiveMeetingId) return;
      if (needRefresh && _isPanelCapableMeeting(meeting)) {
        // 触发 panel 重渲染让 isInitializing 立即生效（卡片切到"待命"）
        const cached = _rtPanelState[startActiveMeetingId];
        if (cached) {
          const panel = _ensureRtPanel();
          panel.innerHTML = _renderRtPanelHtml(cached, meeting);
          _bindRtPanelEvents(panel, meeting);
        }
      }
      // 软提醒 banner（IF-C3 实装后会调），保护性调用——不存在时静默
      if (changed && typeof _refreshSoftAlert === 'function') {
        try { _refreshSoftAlert(meeting); } catch {}
      }
    };
    // IF-C6（首屏闪烁修复 2026-05-01）：返回首次 pollOnce 的 promise，让 openMeeting 可以
    //   await 它再继续后续渲染（一次 IPC < 100ms，远低于人眼可感知的 200ms 阈值）。
    //   避免 panel 首次渲染时 _cliReadyCache 还空 → 全部判 isInitializing → 闪一下"创建中"。
    // IF-C7（2026-05-03）：首次 pollOnce 后强制刷一次 banner。原 _refreshSoftAlert 仅在
    //   pollOnce 检测 changed=true 时被调，全员未 ready 时 cache 始终空 → 不变更 → banner
    //   一次都不显示，输入框上方静默——本 fix 让首屏立刻反映"XX 启动中"提示。
    const firstPollPromise = pollOnce().then(() => {
      try { _refreshSoftAlert(meeting); } catch {}
    });
    _cliReadyPollTimer = setInterval(pollOnce, 1000);
    return firstPollPromise;
  }

  function stopCliReadyPoll() {
    if (_cliReadyPollTimer) { clearInterval(_cliReadyPollTimer); _cliReadyPollTimer = null; }
  }

  // IF-C3（2026-05-01）：软提醒 banner — 进会议室时若 AI 还在启动，显示哪几家未 ready
  //   提示用户"等几秒再发送"，避免输入早于 CLI ready 而被吞。
  //   一旦全部 ready 自动消失。用户点 × dismiss 后同会议不再显示（_bannerDismissedFor 记录），
  //   关闭会议 → 重置，下次进同会议又显示。
  //
  // 2026-05-03 道雪精测 Bug #1+#2 修复（关键 P0 用户铁律）：banner 用「DOM + cache
  //   取并集」的悲观策略 — 任一数据源说某家未 ready，banner 就提示该家启动中。
  //   原 filter(meeting.subSessions, sid => !_cliReadyCache[sid]) 有两个问题：
  //   #1: 装配中途 meeting.subSessions 还不完整 → notReady 数字偏小（如 2/3 而非 3/3）
  //   #2: _cliReadyCache 比卡片 DOM 早更新 1s → banner 早消失，用户以为 ready 实际还没
  //   并集策略保证：DOM 卡片仍"创建中" 或 cache 未 ready，任一为真即在 banner 内提示，
  //   彻底杜绝"卡片创建中但 banner 消失"的误导（用户铁律 P0 禁忌）。
  // Phase 4 v2(2026-05-05 道雪): _refreshSoftAlert 改造为更新 onboarding head 的动态状态。
  //   旧策略: 在底部 mr-input-soft-alert banner 显示启动中文字 + dismiss × 按钮。
  //   新策略(用户决策): banner DOM 已删, head 文字上移到欢迎区。AI 启动中(notReady>0) 显示黄色
  //     "X / Y / Z 启动中, 建议等到状态变'待命'再发送"; 全员 ready 显示绿色 "N 个 AI 已就绪"。
  //   notReady 算法不变(DOM "创建中"+ cliReadyCache 并集 + slotSpecs 装配中补齐)。
  //   dismiss 语义删除(欢迎区 head 是动态的, ready 后自然变绿无需用户关闭)。
  //
  // 函数名保持 _refreshSoftAlert 兼容现有调用点(避免大面积改 ipc handler), 实际行为变了。
  function _refreshSoftAlert(meeting) {
    const head = document.getElementById('mr-rt-ob-head');
    if (!head || !meeting || !Array.isArray(meeting.subSessions)) return;

    const labelOf = sid => {
      const sess = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      const kind = sess && sess.kind;
      return KIND_LABELS[kind] || (sess && sess.title) || sid.slice(0, 6);
    };
    // 数据源 A：DOM 卡片状态文字含"创建中"的 sid（跟用户所见同源）
    const domNotReadySids = new Set();
    document.querySelectorAll('.mr-ft').forEach(card => {
      const status = (card.querySelector('.mr-ft-status')?.textContent || '').trim();
      if (status && status.includes('创建中')) {
        const sid = card.querySelector('[data-rt-sid]')?.dataset?.rtSid;
        if (sid) domNotReadySids.add(sid);
      }
    });
    // 数据源 B：cli-ready cache 未 ready 的 sid（覆盖 panel 还没渲染时的首屏）
    const cacheNotReadySids = new Set(meeting.subSessions.filter(sid => !_cliReadyCache[sid]));
    // 并集（悲观策略）：任一源说未 ready → 提示
    const unionSids = new Set([...domNotReadySids, ...cacheNotReadySids]);
    const notReady = meeting.subSessions.filter(sid => unionSids.has(sid)).map(labelOf);
    // 装配中途补齐(slotSpecs.length > subSessions.length 时, 差额按 slotSpecs[i].kind 算未 ready)
    if (Array.isArray(meeting.slotSpecs) && meeting.slotSpecs.length > meeting.subSessions.length) {
      for (let i = meeting.subSessions.length; i < meeting.slotSpecs.length; i++) {
        const spec = meeting.slotSpecs[i];
        notReady.push(KIND_LABELS[spec?.kind] || 'AI');
      }
    }

    // notReady>0 → 黄色启动中; notReady===0 → 绿色全员 ready
    if (notReady.length > 0) {
      head.classList.remove('ready');
      head.classList.add('loading');
      head.innerHTML = `
        <span class="mr-rt-ob-head-icon">⏳</span>
        <span><strong>${notReady.join(' / ')}</strong> 启动中, 建议等到状态变 <strong>"待命"</strong> 再发送(避免输入丢失)</span>
      `;
    } else {
      head.classList.remove('loading');
      head.classList.add('ready');
      const defaultText = head.getAttribute('data-default-text') || '圆桌已就位';
      const defaultSub = head.getAttribute('data-default-sub') || '等你抛话题';
      head.innerHTML = `
        <span class="mr-rt-ob-head-icon">✓</span>
        <span><strong>${escapeHtml(defaultText)}</strong> · ${escapeHtml(defaultSub)}</span>
      `;
    }
  }

  function updateMarkerBadges(meeting) {
    for (const sid of meeting.subSessions) {
      const newHtml = markerStatusHtml(sid);
      const slotBadge = document.querySelector(`.mr-sub-slot[data-session-id="${sid}"] .mr-marker-badge`);
      if (slotBadge) slotBadge.outerHTML = newHtml;
      const tabBadge = document.querySelector(`.mr-tab[data-sid="${sid}"] .mr-marker-badge`);
      if (tabBadge) tabBadge.outerHTML = newHtml;
    }
  }

  function createSubSlot(meeting, sessionId) {
    const session = sessions ? sessions.get(sessionId) : null;
    const isDormant = session && session.status === 'dormant';
    const isSelected = meeting.sendTarget === sessionId;
    const slotTitle = session ? (session.title || session.kind || 'session') : 'session';

    const slot = document.createElement('div');
    slot.className = 'mr-sub-slot' + (isSelected ? ' selected' : '') + (isDormant ? ' dormant' : '');
    slot.dataset.sessionId = sessionId;

    const badgeHtml = subModelBadgeHtml(session) + subCtxBadgeHtml(session);
    const markerBadge = markerStatusHtml(sessionId);
    const header = document.createElement('div');
    header.className = 'mr-sub-header';
    header.innerHTML = `
      <span class="mr-sub-label">${escapeHtml(slotTitle)}${badgeHtml ? ' ' + badgeHtml : ''} ${markerBadge}</span>
      <button class="mr-sub-close" title="关闭此会话">✕</button>
    `;

    header.addEventListener('click', (e) => {
      if (e.target.classList.contains('mr-sub-close')) return;
      const newTarget = meeting.sendTarget === sessionId ? 'all' : sessionId;
      meeting.sendTarget = newTarget;
      ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { sendTarget: newTarget } });
      renderTerminals(meeting);
      renderToolbar(meeting);
    });

    header.querySelector('.mr-sub-close').addEventListener('click', async () => {
      const result = await ipcRenderer.invoke('remove-meeting-sub', { meetingId: meeting.id, sessionId });
      if (result) {
        delete _markerStatusCache[sessionId];
        meetingData[meeting.id] = result;
        renderTerminals(result);
        renderToolbar(result);
      }
    });

    slot.appendChild(header);

    const termContainer = document.createElement('div');
    termContainer.className = 'mr-sub-terminal';
    termContainer.addEventListener('click', () => {
      const cached = subTerminals[sessionId];
      if (cached && cached.terminal) cached.terminal.scrollToBottom();
    });
    slot.appendChild(termContainer);

    if (!isDormant && typeof getOrCreateTerminal === 'function') {
      const cached = getOrCreateTerminal(sessionId);
      if (cached && cached.container) {
        cached.container.style.display = 'block';
        // 幂等防护：cached.container 是单例（renderer.js:708 cache）, 反复 appendChild
        //   会让 DOM 自动 detach + reattach, 期间 Canvas/WebGL 上下文可能丢帧。
        //   只在父节点变更时才挂载, layout 切换 / 主驾切换的高频重渲不再抖动。
        if (cached.container.parentNode !== termContainer) {
          termContainer.appendChild(cached.container);
        }
        subTerminals[sessionId] = cached;
      }
    }

    slot.addEventListener('contextmenu', (e) => {
      handleQuoteContext(e, meeting, sessionId);
    });

    return slot;
  }

  // Arch refactor 2026-05-02: shell 不再在圆桌界面 mount，no-op。
  function fitSubTerminal(_sessionId) { /* removed */ }
  function mountSubTerminal(_sessionId) { /* removed */ }

  // --- Focus Mode ---

  function renderFocusMode(meeting, container) {
    const focused = meeting.focusedSub || meeting.subSessions[0];
    if (!focused) return;

    for (const sessionId of meeting.subSessions) {
      const slot = createSubSlot(meeting, sessionId);
      slot.style.flex = '1';
      slot.style.display = sessionId === focused ? '' : 'none';
      container.appendChild(slot);
    }

    for (const sessionId of meeting.subSessions) {
      openSubTerminal(sessionId);
    }
    // Only fit the visible (focused) terminal; hidden ones get wrong dims
    robustFit(focused);
  }

  // rAF-loop until container has real width AND height, then fit + resize PTY.
  // 旧实现的 `cached.container || ... ? null : ...` 因 ||/?: 优先级 bug 让 el 永远是 null，
  // offsetWidth 门禁形同虚设，fit 在容器无 layout 时执行 → 错 cols/rows → SIGWINCH 风暴
  // → CLI 错位重绘（用户看到的"重复渲染/字符叠加"老 bug）。
  // 同时加 SIGWINCH 去重：cols/rows 没变就不再发 terminal-resize（第二层防护，主进程也再去重一次）。
  function robustFit(sessionId) {
    const _refit = () => {
      const cached = subTerminals[sessionId];
      if (!cached || !cached.fitAddon) return;
      const el = cached.container || cached.terminal.element;
      if (!el || !el.offsetWidth || !el.offsetHeight) {
        requestAnimationFrame(_refit);
        return;
      }
      try {
        const beforeCols = cached.terminal.cols;
        const beforeRows = cached.terminal.rows;
        cached.fitAddon.fit();
        const afterCols = cached.terminal.cols;
        const afterRows = cached.terminal.rows;
        if (afterCols !== beforeCols || afterRows !== beforeRows) {
          ipcRenderer.send('terminal-resize', { sessionId, cols: afterCols, rows: afterRows });
        }
        // Canvas/WebGL 后端在 display:none→block 或 reparent 后, 浏览器合成层
        // 可能保留旧帧或缺帧；不强制 refresh 会留下"残影 / 字符叠加"。
        // 排在 fit 之后的下一帧确保 cols/rows 已稳定。
        requestAnimationFrame(() => {
          try { cached.terminal.refresh(0, cached.terminal.rows - 1); } catch (_) {}
        });
      } catch (_) {}
    };
    requestAnimationFrame(_refit);
  }

  const _savedScrollPos = {}; // sessionId → { viewportY, vpScrollTop }

  function switchFocusTab(meeting, newSid) {
    const container = terminalsEl();
    if (!container) return;

    // Save scroll position of the previously focused terminal
    const prevSid = meeting.focusedSub || meeting.subSessions[0];
    if (prevSid && prevSid !== newSid) {
      const prev = subTerminals[prevSid];
      if (prev && prev.terminal) {
        const pvp = prev.container && prev.container.querySelector('.xterm-viewport');
        _savedScrollPos[prevSid] = {
          viewportY: prev.terminal.buffer.active.viewportY,
          vpScrollTop: pvp ? pvp.scrollTop : 0,
          atBottom: pvp ? (pvp.scrollTop + pvp.clientHeight >= pvp.scrollHeight - 5) : true,
        };
      }
    }

    const slots = container.querySelectorAll('.mr-sub-slot');
    for (const slot of slots) {
      slot.style.display = slot.dataset.sessionId === newSid ? '' : 'none';
    }
    robustFit(newSid);
    setTimeout(() => {
      const cached = subTerminals[newSid];
      if (!cached || !cached.terminal) return;
      // Sync xterm's internal scroll area — same pattern as renderer.js showSession
      try {
        const vpInst = cached.terminal._core && cached.terminal._core.viewport;
        if (vpInst && typeof vpInst.syncScrollArea === 'function') {
          vpInst.syncScrollArea(true);
        }
      } catch (_) {}

      // Restore saved position or scroll to bottom for fresh tabs
      const saved = _savedScrollPos[newSid];
      const vp = cached.container && cached.container.querySelector('.xterm-viewport');
      if (saved && !saved.atBottom) {
        try { cached.terminal.scrollToLine(saved.viewportY); } catch (_) {}
        if (vp) vp.scrollTop = saved.vpScrollTop;
      } else {
        cached.terminal.scrollToBottom();
        if (vp) vp.scrollTop = vp.scrollHeight;
        requestAnimationFrame(() => {
          if (vp) vp.scrollTop = vp.scrollHeight;
          try { cached.terminal.scrollToBottom(); } catch (_) {}
        });
      }
      cached.terminal.focus();
    }, 100);
  }

  // --- Layout Toggle ---

  function setLayout(meetingId, layout) {
    const meeting = meetingData[meetingId];
    if (!meeting) return;
    meeting.layout = layout;
    if (layout === 'focus' && !meeting.focusedSub) {
      meeting.focusedSub = meeting.subSessions[0] || null;
    }
    ipcRenderer.send('update-meeting', { meetingId, fields: { layout, focusedSub: meeting.focusedSub } });
    renderHeader(meeting);
    renderTerminals(meeting);
  }

  // pilot-mode Task 3（2026-05-01）：主驾按钮事件绑定 + 卡片视觉切换。
  //   按钮点击展开 dropdown；选 slot 0/1/2 → 调 IPC 开主驾；选 -1 关主驾。
  //   IPC 返回后由 'meeting-updated' 事件触发 renderToolbar 重渲（按钮 active + 卡片 dim）。
  function _bindPilotEvents(meeting, _pilotSlot) {
    const btn = document.getElementById('mr-pilot-btn');
    const menu = document.getElementById('mr-pilot-menu');
    if (!btn || !menu) return;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    });

    // 点外部关闭菜单
    const offClickHandler = (e) => {
      if (!btn.contains(e.target) && !menu.contains(e.target)) {
        menu.style.display = 'none';
      }
    };
    document.addEventListener('mousedown', offClickHandler, { once: true });

    menu.querySelectorAll('.mr-pilot-option').forEach(opt => {
      opt.addEventListener('click', async (e) => {
        e.stopPropagation();
        const slotStr = opt.dataset.slot;
        const slotIndex = parseInt(slotStr, 10);
        const targetSlot = slotIndex === -1 ? null : slotIndex;
        // 检查目标 slot 真的有 sub session（避免开到空槽）
        if (targetSlot !== null && (!meeting.subSessions || !meeting.subSessions[targetSlot])) {
          alert(`Slot ${targetSlot + 1} 没有活跃 session`);
          return;
        }
        menu.style.display = 'none';
        // 防重复点击：disable 按钮直到 IPC 完成
        btn.disabled = true;
        const labelSpan = document.getElementById('mr-pilot-label');
        const oldLabel = labelSpan ? labelSpan.textContent : '';
        if (labelSpan) labelSpan.textContent = '切换中…';
        try {
          const result = await ipcRenderer.invoke('roundtable:pilot-toggle', {
            meetingId: meeting.id, slotIndex: targetSlot,
          });
          // pilot redesign（2026-05-02）：pilot-toggle 仅设置 pilotSlot，无副作用（无 recap 生成）。
          if (!result || !result.ok) throw new Error('pilot-toggle returned non-ok');
        } catch (err) {
          console.error('[pilot-toggle] failed:', err);
          alert('切换主驾失败：' + (err && err.message ? err.message : String(err)));
          if (labelSpan) labelSpan.textContent = oldLabel;
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  // pilot redesign v4（2026-05-02）：卡片只保留"角色层"红框，删除 dispatch 视觉特效。
  //   设计准则：副驾发言时主驾卡片保持原状，主驾发言时副驾同理。卡片自然反映真实 PTY
  //            状态（thinking/done/idle）即可——dispatch 视觉特效是"多此一举"，反而
  //            会和真实 PTY 状态打架（出现"灰化但又部分动"的怪异中间态）。
  //   dispatchMode 仍保留参数：仅用于输入框 placeholder 的文本提示。
  function _applyPilotCardVisual(meeting, pilotSlot, dispatchMode) {
    const panel = document.getElementById('mr-rt-panel');
    const cards = panel
      ? panel.querySelectorAll('.mr-ft-strip > .mr-ft')
      : document.querySelectorAll('.mr-ft-strip > .mr-ft');
    const mode = ['all', 'pilot', 'observer'].includes(dispatchMode) ? dispatchMode : 'all';
    cards.forEach((card, i) => {
      // 角色层：主驾红框 + 左上角"主驾"三角标
      card.classList.toggle('pilot-role', pilotSlot === i);
      // 兜底清理旧 v3 dispatch class（用户从老版本升级时卡片可能仍带这两个 class）
      card.classList.remove('dispatch-active', 'dispatch-inactive');
      // 主驾角色 corner 三角
      let cornerEl = card.querySelector('.ft-corner-pilot');
      if (pilotSlot === i) {
        if (!cornerEl) {
          cornerEl = document.createElement('div');
          cornerEl.className = 'ft-corner-pilot';
          cornerEl.textContent = '主驾';
          card.appendChild(cornerEl);
        }
      } else if (cornerEl) {
        cornerEl.remove();
      }
    });
    // 输入框 placeholder
    const inputBox = document.getElementById('mr-input-box');
    if (inputBox) {
      const slotPokemon = ['皮卡丘', '小火龙', '杰尼龟'];
      const dispatchLabel = { all: '群策群力', pilot: '主驾发言', observer: '副驾发言' }[mode];
      inputBox.dataset.placeholder = pilotSlot !== null
        ? `🚗 主驾: Slot ${pilotSlot + 1} · ${slotPokemon[pilotSlot]} · 当前分发: ${dispatchLabel}`
        : '圆桌讨论：发普通文本启动一轮 / @debate';
    }
  }

  // --- Toolbar ---

  function renderToolbar(meeting) {
    const el = toolbarEl();
    if (!el) return;

    // Module C 后 blackboard layout 已废弃,layout 字段只剩 'focus' 一种语义。
    // 两模式(通用/投研)统一 toolbar：群策群力 / 总结发言。
    if (_isPanelCapableMeeting(meeting)) {
      const subs = _getRtSubInfo(meeting);
      // slot 化（2026-05-03）：dropdown 改按 slot 枚举（不再按 kind 去重）。
      //   关键修复：3 claude 圆桌时，原 kind 索引只显 1 个"Claude"选项，
      //   sidByKind 也只返回首个，导致后两位 claude 永远当不了总结人。
      //   现在改 slot：3 个选项 ⚡Pikachu / 🔥Charmander / 💎Squirtle，
      //   value=slotId 直接对应到后端 sidBySlot。
      const slotsArr = _getRtSlots(meeting);
      const opts = slotsArr
        .filter(s => s)
        .map(s => `<option value="${s.slotId}">${escapeHtml(s.displayLabel)}</option>`)
        .join('');
      const cached = _rtPanelState[meeting.id];
      const inProgress = cached && cached.currentMode && cached.currentMode !== 'idle';
      const turns = cached ? (cached.turns || []).length : 0;
      // pilot redesign（2026-05-02）：pilotSlot 是"主驾角色"标识（红框），dispatchMode 控制本轮谁开口。
      const pilotSlot = (typeof meeting.pilotSlot === 'number' && meeting.pilotSlot >= 0 && meeting.pilotSlot <= 2)
        ? meeting.pilotSlot : null;
      const pilotOn = pilotSlot !== null;
      const dispatchMode = ['all', 'pilot', 'observer'].includes(meeting.dispatchMode)
        ? meeting.dispatchMode : 'all';

      // dispatchMode segmented control: pilot/observer 要求 pilotSlot !== null
      const dispatchPilotDisabled = (!pilotOn || inProgress) ? 'disabled' : '';
      const dispatchObserverDisabled = (!pilotOn || inProgress) ? 'disabled' : '';
      // E5 修复 (2026-05-03)：disabled 时 title 解释原因（之前 title 仍是按钮功能描述，
      //   用户点不动不知道为啥）。优先级：处理中 > 没选主驾。
      const _pilotObsHint = inProgress
        ? '上一轮还在跑，请等结束'
        : (!pilotOn ? '请先在右侧 🚗 主驾角色 选定一家 AI 才能切到此模式' : null);
      const dispatchPilotTitle = _pilotObsHint || '主驾发言：本轮 prompt 仅发给主驾';
      const dispatchObserverTitle = _pilotObsHint || '副驾发言：本轮 prompt 仅发给副驾两家';
      const dispatchAllDisabled = inProgress ? 'disabled' : '';

      // T6：mode toggle segmented control（必须在 debateDisabled 之前，因为 debateDisabled 依赖 meetingMode）
      // 2026-05-05 道雪：主驾入口废弃，fallback 'pilot' → 'free'（与 core 一致）。
      const meetingMode = (meeting.mode === 'free' || meeting.mode === 'pilot') ? meeting.mode : 'free';

      // debate: free 模式需 >=2 人；pilot 模式下一家无法辩论 → disable
      const debateDisabled = (() => {
        if (turns < 1 || inProgress) return 'disabled';
        if (meetingMode === 'free') {
          const parts = Array.isArray(meeting.participants) ? meeting.participants : [];
          return parts.length < 2 ? 'disabled' : '';
        }
        // pilot 模式：原条件
        return dispatchMode === 'pilot' ? 'disabled' : '';
      })();

      const debateBtnTitle = (() => {
        if (turns < 1) return '至少完成 1 轮 fanout 才能辩论';
        if (inProgress) return '上一轮还在跑，请等结束';
        if (meetingMode === 'free') {
          const parts = Array.isArray(meeting.participants) ? meeting.participants : [];
          if (parts.length < 2) return '勾选至少 2 位才能辩论';
          return '让目标范围内的 AI 结合彼此观点重新发言';
        }
        if (dispatchMode === 'pilot') return '主驾发言模式下一家无法辩论';
        return '让目标范围内的 AI 结合彼此观点重新发言';
      })();

      // 摘要功能 2026-05-08 整体下线：原 summaryDisabled / summaryPickDisabled / briefSummaryDisabled 已删

      // 主驾按钮 label
      const slotPokemon = ['⚡皮卡丘', '🔥小火龙', '💎杰尼龟'];
      const pilotBtnLabel = pilotOn ? `${slotPokemon[pilotSlot]}` : '未选';
      const pilotBtnCls = pilotOn ? 'mr-rt-tb-btn pilot active' : 'mr-rt-tb-btn pilot';

      // 状态行（toolbar 顶部一行小字，文字冗余兜底）—— T7: free/pilot 分支
      let statusLine;
      if (meetingMode === 'free') {
        const parts = Array.isArray(meeting.participants) ? meeting.participants : [];
        const SLOT_NAMES_S = ['⚡皮卡丘', '🔥小火龙', '💎杰尼龟'];
        let speakerStr;
        if (parts.length === 0) {
          speakerStr = '<strong style="color:#f85149">⚠ 请勾选至少一位发言人</strong>';
        } else {
          speakerStr = '发言人: <strong>' + parts.map(i => SLOT_NAMES_S[i]).join(', ') + '</strong>';
        }
        statusLine = `<div class="mr-status-line">分发: <strong>自由</strong> · ${speakerStr}${
          inProgress ? ' · <strong>⏳ 处理中</strong>' : (turns > 0 ? ` · 已 ${turns} 轮` : '')
        }</div>`;
      } else {
        // pilot 路径：原状态行不动
        const dispatchModeLabel = { all: '群策群力', pilot: '主驾发言', observer: '副驾发言' }[dispatchMode];
        const pilotLabel = pilotOn ? `Slot ${pilotSlot + 1}` : '未选';
        statusLine = `<div class="mr-status-line">分发: <strong>${dispatchModeLabel}</strong> · 主驾: <strong>${pilotLabel}</strong>${
          inProgress ? ' · <strong>⏳ 处理中</strong>' : (turns > 0 ? ` · 已 ${turns} 轮` : '')
        }</div>`;
      }
      // 注：mode（free/pilot）在创建会议时确定，运行时不可切换；旧的 mode toggle 已删除（2026-05-04 决策）。

      // T6：dispatch 区域按 mode 分支
      const SLOT_AVATARS = ['pikachu.png', 'charmander.png', 'squirtle.png'];
      const SLOT_LABELS = ['⚡ Pikachu · 皮卡丘', '🔥 Charmander · 小火龙', '💎 Squirtle · 杰尼龟'];
      const dispatchAreaHtml = (() => {
        if (meetingMode === 'free') {
          const participants = Array.isArray(meeting.participants) ? meeting.participants : [];
          const partSet = new Set(participants);
          const slotsHtml = [0, 1, 2].map(idx => {
            const checked = partSet.has(idx);
            const disabled = inProgress ? 'disabled' : '';
            return `
              <label class="mr-free-slot ${checked ? 'checked' : ''} ${disabled}" data-slot-idx="${idx}">
                <input type="checkbox" class="mr-free-slot-cb" data-slot-idx="${idx}" ${checked ? 'checked' : ''} ${disabled} />
                <img src="assets/pokemon/${SLOT_AVATARS[idx]}" alt="${SLOT_LABELS[idx]}" />
                <span class="mr-free-slot-label">${SLOT_LABELS[idx]}</span>
              </label>
            `;
          }).join('');
          return `<div class="mr-free-participants" role="group" aria-label="本轮发言人">
            <span class="mr-free-participants-title">本轮发言人</span>
            ${slotsHtml}
          </div>`;
        }
        // pilot 模式：原三按钮组（一行不动）
        return `<div class="mr-rt-dispatch-group" role="group" aria-label="分发模式">
          <button class="mr-rt-dispatch-btn ${dispatchMode === 'all' ? 'active' : ''}" data-dispatch-mode="all" ${dispatchAllDisabled} title="群策群力：本轮 prompt 发给全员">🤝 群策群力</button>
          <button class="mr-rt-dispatch-btn ${dispatchMode === 'pilot' ? 'active' : ''}" data-dispatch-mode="pilot" ${dispatchPilotDisabled} title="${dispatchPilotTitle}">🎯 主驾发言</button>
          <button class="mr-rt-dispatch-btn ${dispatchMode === 'observer' ? 'active' : ''}" data-dispatch-mode="observer" ${dispatchObserverDisabled} title="${dispatchObserverTitle}">👥 副驾发言</button>
        </div>`;
      })();

      // T6：pilot wrap 仅 pilot 模式显示
      const pilotWrapHtml = (meetingMode === 'pilot') ? `
        <span class="mr-rt-tb-divider"></span>
        <span class="mr-rt-tb-pilot-wrap">
          <button class="${pilotBtnCls}" id="mr-pilot-btn" title="选定一家为主驾角色（红框标记）；不会切换全局模式，仅是身份标签。配合分发模式按钮使用。">🚗 主驾角色:<span id="mr-pilot-label">${pilotBtnLabel}</span> ▾</button>
          <span id="mr-pilot-menu" class="mr-pilot-menu" style="display:none;">
            <div class="mr-pilot-option" data-slot="0">⚡ Slot 1 · 皮卡丘</div>
            <div class="mr-pilot-option" data-slot="1">🔥 Slot 2 · 小火龙</div>
            <div class="mr-pilot-option" data-slot="2">💎 Slot 3 · 杰尼龟</div>
            <div class="mr-pilot-option mr-pilot-option-off" data-slot="-1">取消主驾</div>
          </span>
        </span>
      ` : '';

      // Phase 4 v2(2026-05-05 道雪): footer 一行化重构
      //   free 模式: toolbar 完全空, 头像组 + 模式 dropdown 渲到 input-row 内占位。
      //   pilot 模式: 走老 toolbar 路径(本次未优化, 用户主要使用 free)。
      if (meetingMode === 'free') {
        el.innerHTML = ''; // toolbar 空, 高度由 input-row 接管
        // 1. 头像 checkbox 组 → #mr-free-avatars-row(只 logo, 无文字)
        const avatarsRow = document.getElementById('mr-free-avatars-row');
        if (avatarsRow) {
          const participants = Array.isArray(meeting.participants) ? meeting.participants : [];
          const partSet = new Set(participants);
          const SLOT_LABELS_FULL = ['⚡ Pikachu · 皮卡丘', '🔥 Charmander · 小火龙', '💎 Squirtle · 杰尼龟'];
          avatarsRow.innerHTML = [0, 1, 2].map(idx => {
            const checked = partSet.has(idx);
            const disabledAttr = inProgress ? 'disabled' : '';
            return `
              <label class="mr-free-avatar-chk ${checked ? 'checked' : ''} ${disabledAttr}"
                     data-slot-idx="${idx}" title="${SLOT_LABELS_FULL[idx]}">
                <input type="checkbox" class="mr-free-slot-cb" data-slot-idx="${idx}" ${checked ? 'checked' : ''} ${disabledAttr} />
                <img src="assets/pokemon/${SLOT_AVATARS[idx]}" alt="${SLOT_LABELS_FULL[idx]}" />
                <span class="mr-free-avatar-chk-mark">✓</span>
              </label>
            `;
          }).join('');
        }
        // 2. 模式 dropdown → #mr-input-mode-chips（摘要功能 2026-05-08 下线后仅剩"辩论"）
        const modeChipsEl = document.getElementById('mr-input-mode-chips');
        if (modeChipsEl) {
          modeChipsEl.innerHTML = `
            <div class="mr-mode-dropdown">
              <button class="mr-mode-trigger" id="mr-mode-trigger" title="选择动作: 辩论">
                <span>🎯 模式</span><span class="mr-mode-arrow">▾</span>
              </button>
              <div class="mr-mode-popup">
                <button class="mr-mode-item" id="mr-rt-debate-btn" ${debateDisabled} title="${debateBtnTitle}">
                  <span>🗣 辩论</span><span class="mr-mode-item-hint">让 AI 互辩</span>
                </button>
              </div>
            </div>
          `;
        }
      } else {
        // pilot 模式: 老 toolbar 渲染（摘要功能 2026-05-08 下线后仅剩"辩论"）
        el.innerHTML = `
          <div class="mr-rt-toolbar">
            ${dispatchAreaHtml}
            <span class="mr-rt-tb-divider"></span>
            <button class="mr-rt-tb-btn" id="mr-rt-debate-btn" ${debateDisabled} title="${debateBtnTitle}">🗣 辩论</button>
            ${pilotWrapHtml}
          </div>
        `;
        // free 模式占位也清掉(避免老元素残留)
        const arRow = document.getElementById('mr-free-avatars-row');
        if (arRow) arRow.innerHTML = '';
        const mc = document.getElementById('mr-input-mode-chips');
        if (mc) mc.innerHTML = '';
      }

      // 注：mode toggle click handler 已删除（mode 创建时确定，运行时不可切换）。

      // 头像勾选 click handler — Phase 4 v2(2026-05-05 道雪) 重写:
      //   旧版: listener 绑在 el.querySelectorAll('.mr-free-slot-cb'), 但 free 模式 el(toolbar) 已空,
      //        头像组在 input-row 内 → listener 无法找到 → 点击无反应。
      //   新版: 直接给 label(.mr-free-avatar-chk) 绑 click, document 全局查找;
      //         点击 logo / checkmark / label 任何位置均触发, UI 状态等 IPC 重渲后由 panel 刷新。
      //   race guard: 仍用 _freeSlotUpdating 防连击。
      let _freeSlotUpdating = false;
      document.querySelectorAll('.mr-free-avatar-chk[data-slot-idx]').forEach(label => {
        label.addEventListener('click', async (ev) => {
          ev.preventDefault();   // 阻止 native label→input 触发(避免双触发)
          ev.stopPropagation();
          if (label.classList.contains('disabled')) return;
          if (_freeSlotUpdating) return;
          _freeSlotUpdating = true;
          const slotIdx = parseInt(label.getAttribute('data-slot-idx'), 10);
          const current = Array.isArray(meeting.participants) ? [...meeting.participants] : [0, 1, 2];
          const wasChecked = current.includes(slotIdx);
          const next = wasChecked
            ? current.filter(x => x !== slotIdx)
            : [...current, slotIdx];
          next.sort((a, b) => a - b);
          try {
            await ipcRenderer.invoke('roundtable:set-participants', { meetingId: meeting.id, participants: next });
          } catch (err) {
            console.error('[set-participants] failed:', err);
            alert('保存失败:' + (err && err.message ? err.message : String(err)));
          } finally {
            _freeSlotUpdating = false;
          }
        });
      });

      // dispatchMode 切换：调 IPC 'roundtable:dispatch-mode-set'，server 推 meeting-updated 回来重渲
      el.querySelectorAll('.mr-rt-dispatch-btn[data-dispatch-mode]').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (btn.hasAttribute('disabled')) return;
          const newMode = btn.getAttribute('data-dispatch-mode');
          if (newMode === dispatchMode) return;  // 已选中
          try {
            await ipcRenderer.invoke('roundtable:dispatch-mode-set', { meetingId: meeting.id, dispatchMode: newMode });
          } catch (err) {
            console.error('[dispatch-mode-set] failed:', err);
            alert('切换分发模式失败：' + (err && err.message ? err.message : String(err)));
          }
        });
      });

      // 摘要功能 2026-05-08 整体下线：原 mr-rt-summary-btn / mr-rt-brief-summary-btn /
      //   mr-mode-subitem[data-summarizer-slot] 事件绑定全删。仅保留辩论按钮。
      const debateBtn = document.getElementById('mr-rt-debate-btn');
      if (debateBtn) debateBtn.addEventListener('click', () => {
        if (debateBtn.hasAttribute('disabled')) return;
        const inputBox = document.getElementById('mr-input-box');
        const extra = inputBox ? inputBox.innerText.trim() : '';
        // 2026-05-05 道雪：辩论无附加 userInput 时也缓存固定标识,banner 可显示"辩论中"语义
        if (extra) _currentTurnUserInputByMeeting[meeting.id] = extra;
        else delete _currentTurnUserInputByMeeting[meeting.id];
        triggerRoundtable(meeting, 'debate', { userInput: extra });
        if (inputBox) inputBox.textContent = '';
        delete _inputDraftByMeeting[meeting.id];
      });
      _bindPilotEvents(meeting, pilotSlot);
      // pilot redesign（2026-05-02）：不在这里调 _applyPilotCardVisual——renderToolbar 在 panel.innerHTML
      //   重渲之前执行，对旧卡片设的 class 会被冲掉。统一由 refreshRoundtablePanel 在 DOM 重建后调用。
      return;
    }

    // fallback toolbar:仅在老数据/异常 meeting(无 mode flag)出现,清空即可,
    // 用户应通过模式 toggle 切到圆桌或投研以使用主功能。
    el.innerHTML = '';
  }

  // --- Input & Broadcasting ---

  let _inputBound = false;
  let _rtMentionActiveIndex = 0;

  // meeting-create-modal（2026-05-01）：mention 列表按当前 meeting 动态构建，
  //   支持 5 选 3（claude/gemini/codex/deepseek/glm）+ 同 kind 重复（如 3 Claude）。
  //   默认插入 @slot1 / @slot2 / @slot3（按 slot 位置精确指向）；
  //   当 meeting 内某个 kind 唯一出现时，额外注册 @<kind> 别名（向后兼容老 prompt）；
  //   重复 kind 时该 kind 的 @<kind> 别名不注册（避免歧义）。
  function buildRtMentionItems(meeting) {
    const items = [];
    const subSids = (meeting && Array.isArray(meeting.subSessions)) ? meeting.subSessions : [];
    const sidKind = {};
    const kindCount = {};
    for (const sid of subSids) {
      const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      if (s && s.kind) {
        sidKind[sid] = s.kind;
        kindCount[s.kind] = (kindCount[s.kind] || 0) + 1;
      }
    }
    // slot mentions（主项）
    for (let i = 0; i < subSids.length; i++) {
      const sid = subSids[i];
      const k = sidKind[sid] || null;
      const kindLabel = k ? (_KIND_LABELS[k] || k) : '';
      items.push({
        value: `@slot${i + 1}`,
        label: `Slot ${i + 1}${kindLabel ? ' · ' + kindLabel : ''}`,
        hint: 'private ask',
        sid,
        kind: k,
        slotIndex: i,
      });
    }
    // kind alias（仅 kind 唯一时注册，避免歧义）
    for (const sid of subSids) {
      const k = sidKind[sid];
      if (k && kindCount[k] === 1) {
        items.push({
          value: `@${k}`,
          label: _KIND_LABELS[k] || k,
          hint: 'private ask · 别名',
          sid, kind: k,
        });
      }
    }
    // mode 触发（静态；摘要功能 2026-05-08 下线后仅剩 @debate）
    items.push({ value: '@debate', label: '@debate', hint: 'cross-review' });
    return items;
  }

  function _getRtMentionMenu() {
    let menu = document.getElementById('mr-rt-mention-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'mr-rt-mention-menu';
      menu.className = 'mr-rt-mention-menu';
      menu.setAttribute('role', 'listbox');
      menu.style.display = 'none';
      const row = document.getElementById('mr-input-row');
      if (row) row.appendChild(menu);
    }
    return menu;
  }

  function _hideRtMentionMenu() {
    const menu = document.getElementById('mr-rt-mention-menu');
    if (menu) {
      menu.style.display = 'none';
      menu.innerHTML = '';
    }
    _rtMentionActiveIndex = 0;
  }

  function _getTextCaretOffset(el) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return el.innerText.length;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.endContainer)) return el.innerText.length;
    const pre = range.cloneRange();
    pre.selectNodeContents(el);
    pre.setEnd(range.endContainer, range.endOffset);
    return pre.toString().length;
  }

  function _placeCaretAtTextOffset(el, offset) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let node;
    let remaining = offset;
    while ((node = walker.nextNode())) {
      if (remaining <= node.nodeValue.length) {
        const range = document.createRange();
        range.setStart(node, remaining);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      remaining -= node.nodeValue.length;
    }
    _placeCaretAtEnd(el);
  }

  function _getRtMentionMatch(inputBox) {
    const text = inputBox.innerText || '';
    const caret = _getTextCaretOffset(inputBox);
    const beforeCaret = text.slice(0, caret);
    const at = beforeCaret.lastIndexOf('@');
    if (at < 0) return null;
    const query = beforeCaret.slice(at + 1);
    if (/\s/.test(query)) return null;
    return { text, caret, start: at, query: query.toLowerCase() };
  }

  function _insertRtMention(inputBox, item, meeting) {
    const match = _getRtMentionMatch(inputBox);
    if (!match) return;
    const suffix = match.text.slice(match.caret);
    const spacer = suffix.startsWith(' ') || suffix.length === 0 ? '' : ' ';
    const inserted = `${item.value} `;
    inputBox.textContent = match.text.slice(0, match.start) + inserted + spacer + suffix;
    inputBox.focus();
    _placeCaretAtTextOffset(inputBox, match.start + inserted.length);
    _hideRtMentionMenu();
    // meeting-create-modal：slot mentions 优先按 sid focus（精确指向 slot）；
    //   kind alias 走老 _focusRoundtableKind（kind 唯一时才注册此别名，确定不歧义）。
    if (item.sid) _focusRoundtableSession(meeting, item.sid);
    else if (item.kind) _focusRoundtableKind(meeting, item.kind);
  }

  function _updateRtMentionMenu(inputBox, meeting) {
    if (!_isPanelCapableMeeting(meeting)) {
      _hideRtMentionMenu();
      return;
    }
    // pilot-mode Task 9（2026-05-01）：主驾期间 mention 灰显——所有 @ 候选都不可用，
    //   仅显示一行 disabled 提示让用户知道为什么。
    const pilotSlot = (typeof meeting.pilotSlot === 'number' && meeting.pilotSlot >= 0 && meeting.pilotSlot <= 2)
      ? meeting.pilotSlot : null;
    const match = _getRtMentionMatch(inputBox);
    if (!match) {
      _hideRtMentionMenu();
      return;
    }
    if (pilotSlot !== null) {
      const menu = _getRtMentionMenu();
      menu.style.left = `${inputBox.offsetLeft}px`;
      menu.style.minWidth = `${Math.min(Math.max(inputBox.offsetWidth, 260), 420)}px`;
      menu.innerHTML = `<div class="mr-rt-mention-disabled-hint">主驾模式中（仅 Slot ${pilotSlot + 1} 接收），请先 [🚗 主驾:▾ 关闭主驾] 再使用 @ 提及</div>`;
      menu.style.display = 'block';
      return;
    }
    const items = buildRtMentionItems(meeting).filter(item => {
      const haystack = `${item.value} ${item.label}`.toLowerCase().replace(/^@/, '');
      return haystack.includes(match.query);
    });
    if (items.length === 0) {
      _hideRtMentionMenu();
      return;
    }
    if (_rtMentionActiveIndex >= items.length) _rtMentionActiveIndex = 0;
    const menu = _getRtMentionMenu();
    menu.style.left = `${inputBox.offsetLeft}px`;
    menu.style.minWidth = `${Math.min(Math.max(inputBox.offsetWidth, 260), 420)}px`;
    menu.innerHTML = items.map((item, index) => `
      <button type="button" class="mr-rt-mention-item${index === _rtMentionActiveIndex ? ' active' : ''}" data-mention-index="${index}" role="option" aria-selected="${index === _rtMentionActiveIndex ? 'true' : 'false'}">
        <span class="mr-rt-mention-label">${escapeHtml(item.label)}</span>
        <span class="mr-rt-mention-value">${escapeHtml(item.value)}</span>
        <span class="mr-rt-mention-hint">${escapeHtml(item.hint)}</span>
      </button>
    `).join('');
    menu.style.display = 'block';
    menu.querySelectorAll('.mr-rt-mention-item').forEach(btn => {
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const index = Number(btn.getAttribute('data-mention-index'));
        _insertRtMention(inputBox, items[index], meeting);
      });
    });
  }

  function _focusRoundtableSession(meeting, sid) {
    if (!meeting || !sid || !Array.isArray(meeting.subSessions) || !meeting.subSessions.includes(sid)) return false;
    const focused = meeting.focusedSub || meeting.subSessions[0];
    if (sid === focused) return true;
    _tabState[sid] = 'idle';
    if (_tabTimers[sid]) { clearTimeout(_tabTimers[sid]); delete _tabTimers[sid]; }
    meeting.focusedSub = sid;
    ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { focusedSub: sid } });
    switchFocusTab(meeting, sid);
    refreshRoundtablePanel(meeting);
    renderHeader(meeting);
    return true;
  }

  function _focusRoundtableKind(meeting, kind) {
    const sid = findSessionByKind(meeting, kind);
    if (!sid) return false;
    return _focusRoundtableSession(meeting, sid);
  }

  function _handleRtMentionKeydown(e, inputBox, meeting) {
    const menu = document.getElementById('mr-rt-mention-menu');
    const isOpen = menu && menu.style.display !== 'none';
    if (!isOpen) return false;
    const items = buildRtMentionItems(meeting).filter(item => {
      const match = _getRtMentionMatch(inputBox);
      if (!match) return false;
      const haystack = `${item.value} ${item.label}`.toLowerCase().replace(/^@/, '');
      return haystack.includes(match.query);
    });
    if (items.length === 0) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _rtMentionActiveIndex = (_rtMentionActiveIndex + 1) % items.length;
      _updateRtMentionMenu(inputBox, meeting);
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      _rtMentionActiveIndex = (_rtMentionActiveIndex + items.length - 1) % items.length;
      _updateRtMentionMenu(inputBox, meeting);
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      _insertRtMention(inputBox, items[_rtMentionActiveIndex], meeting);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      _hideRtMentionMenu();
      return true;
    }
    return false;
  }

  function setupInput(meeting) {
    const inputBox = document.getElementById('mr-input-box');
    const sendBtn = document.getElementById('mr-send-btn');
    const targetSelect = document.getElementById('mr-input-target');
    if (!inputBox || !sendBtn) return;

    // IF-C2（2026-05-01）：placeholder 每次都更新（meeting 切换时场景可能变）；
    // 但 textContent 擦除只在首次（_inputBound=false）做——避免每次重渲染擦掉
    // 用户已输入但还没发送的内容（P1 体验断裂 bug A）。
    // T7: free 模式 0 人勾选时灰态保护
    // 2026-05-05 道雪：主驾入口废弃，fallback 'pilot' → 'free'（与 core 一致）。
    const _curMeetingMode = (meeting.mode === 'free' || meeting.mode === 'pilot') ? meeting.mode : 'free';
    const isFreeZeroSelected = (_curMeetingMode === 'free') &&
      (Array.isArray(meeting.participants) && meeting.participants.length === 0);
    if (meeting.scene) {
      inputBox.dataset.placeholder = isFreeZeroSelected
        ? '请先勾选至少一位发言人'
        : '圆桌讨论：发普通文本启动一轮 / @debate / @<slot> 单聊';
    } else {
      inputBox.dataset.placeholder = '输入消息...';
    }
    // 灰态：readonly + class 切换
    if (isFreeZeroSelected) {
      inputBox.setAttribute('readonly', '');
      inputBox.classList.add('mr-rt-input-disabled');
      sendBtn.disabled = true;
    } else {
      inputBox.removeAttribute('readonly');
      inputBox.classList.remove('mr-rt-input-disabled');
      sendBtn.disabled = false;
    }

    // 卡片优化（2026-05-03 道雪）：粘贴图片支持。绑一次（idempotent guard 在 helper 内）。
    //   helper 由 renderer.js 暴露为 window.attachContenteditablePasteImage（先于 meeting-room.js 加载）。
    if (typeof window.attachContenteditablePasteImage === 'function') {
      window.attachContenteditablePasteImage(inputBox);
    }

    // 两模式(通用/投研)统一隐藏目标选择(路由由 fanout/debate/summary/private/@command 决定)。
    if (targetSelect) {
      if (_isPanelCapableMeeting(meeting)) {
        targetSelect.style.display = 'none';
      } else {
        targetSelect.style.display = '';
        targetSelect.style.opacity = '';
        targetSelect.style.pointerEvents = '';
      }
    }

    if (targetSelect && !_isPanelCapableMeeting(meeting)) {
      targetSelect.innerHTML = '<option value="all">全部</option>';
      for (const sid of meeting.subSessions) {
        const session = sessions ? sessions.get(sid) : null;
        const label = session ? (session.title || session.kind || sid) : sid;
        const opt = document.createElement('option');
        opt.value = sid;
        opt.textContent = label;
        if (meeting.sendTarget === sid) opt.selected = true;
        targetSelect.appendChild(opt);
      }
      targetSelect.value = meeting.sendTarget || 'all';
    }

    if (_inputBound) return;
    _inputBound = true;
    // IF-C2：仅首次绑定时设内容（避免后续重渲染 setupInput 擦掉用户已输入未发送内容）。
    // 2026-05-05 道雪：从清空改为按 meeting.id 恢复草稿 — 切换不同圆桌时各自独立。
    inputBox.textContent = _inputDraftByMeeting[meeting.id] || '';

    if (targetSelect) {
      targetSelect.addEventListener('change', (e) => {
        const mid = activeMeetingId;
        const m = meetingData[mid];
        if (m) {
          m.sendTarget = e.target.value;
          ipcRenderer.send('update-meeting', { meetingId: m.id, fields: { sendTarget: m.sendTarget } });
        }
      });
    }

    const doSend = () => {
      const box = document.getElementById('mr-input-box');
      const userText = box ? box.innerText.trim() : '';
      // F6 Phase 3: 既无 text 又无 quote chips → 不发
      if (!userText && _rtQuoteChips.length === 0) return;
      const mid = activeMeetingId;
      const m = meetingData[mid];
      if (!m) return;
      // free-mode（2026-05-04）：0 人勾选时拒绝发送
      // CSS readonly 对 contenteditable 无效，必须 JS 二次防御，防 race 导致按钮意外还原
      if (m.mode === 'free') {
        const parts = Array.isArray(m.participants) ? m.participants : [];
        if (parts.length === 0) {
          alert('请先勾选至少一位发言人');
          return;
        }
      }
      if (!m.scene) {
        const sel = document.getElementById('mr-input-target');
        if (sel) m.sendTarget = sel.value;
      } else {
        m.sendTarget = 'all';
      }
      // F6 Phase 3: 拼接引用 chips 到 prompt 头部, 让 AI 知道用户基于哪些片段追问
      let finalText = userText;
      if (_rtQuoteChips.length > 0) {
        const quoteSection = '基于以下引用追问:\n' + _rtQuoteChips.map(c =>
          `[💎 第${c.turnN}轮 ${c.slotLabel}: "${c.text}"]`
        ).join('\n');
        finalText = userText
          ? `${quoteSection}\n\n用户问题: ${userText}`
          : `${quoteSection}\n\n(请就以上引用展开评论或继续讨论)`;
      }
      handleMeetingSend(finalText, m);
      if (box) box.textContent = '';
      delete _inputDraftByMeeting[m.id];
      _clearQuoteChips();
    };

    sendBtn.addEventListener('click', doSend);

    inputBox.addEventListener('keydown', (e) => {
      // IME composition (中/日/韩) 中, 回车/方向键是给候选词用的, 不是给应用层。
      // 不放行就会出现:中文按回车选词被当作"发送"+清空输入框,或方向键被 mention 菜单吃掉。
      if (e.isComposing || e.keyCode === 229) return;
      const mid = activeMeetingId;
      const currentMeeting = meetingData[mid] || meeting;
      if (_handleRtMentionKeydown(e, inputBox, currentMeeting)) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    });

    inputBox.addEventListener('input', () => {
      const mid = activeMeetingId;
      _updateRtMentionMenu(inputBox, meetingData[mid] || meeting);
    });
    inputBox.addEventListener('keyup', (e) => {
      if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) return;
      const mid = activeMeetingId;
      _updateRtMentionMenu(inputBox, meetingData[mid] || meeting);
    });
    inputBox.addEventListener('click', () => {
      const mid = activeMeetingId;
      _updateRtMentionMenu(inputBox, meetingData[mid] || meeting);
    });
    inputBox.addEventListener('blur', () => {
      setTimeout(_hideRtMentionMenu, 120);
    });
  }

  async function handleMeetingSend(text, meeting) {
    const current = meetingData[meeting.id] || meeting;

    // --- Research Mode routing 优先 ---
    // 路由由 fanout/debate 决定（摘要功能 2026-05-08 整体下线）。
    if (current.scene) {
      const cmd = parseRoundtableCommand(text, current);
      // 公共轮次：fanout / debate 走 orchestrator
      if (cmd.type === 'rt-fanout' || cmd.type === 'rt-debate') {
        const mode = cmd.type === 'rt-fanout' ? 'fanout' : 'debate';
        // 2026-05-05 道雪：本轮 userInput 立即缓存,让"用户提问 banner"在 turn-complete 之前就能显示。
        const _userInputForBanner = (cmd.text || '').trim();
        if (_userInputForBanner) _currentTurnUserInputByMeeting[meeting.id] = _userInputForBanner;
        // 也写入 meeting timeline（黑板视图回放用）
        try {
          await ipcRenderer.invoke('meeting-append-user-turn', { meetingId: meeting.id, text });
        } catch (e) { console.warn('[meeting-room] append-user-turn failed:', e.message); }
        triggerRoundtable(current, mode, {
          userInput: cmd.text || '',
        });
        return;
      }
      // pilot redesign（2026-05-02）：rt-private 类型完全废弃，圆桌不再处理 @<who> 私聊。
      //   想私聊就直接进 AI 子会话区聊。parseRoundtableCommand 会把 @xxx 前缀的输入归一为 rt-fanout。
    }

    const targets = current.sendTarget === 'all' ? current.subSessions : [current.sendTarget];

    // Single defensive filter: only sub-sessions still in the meeting and not dormant.
    const validTargets = targets.filter(sid => {
      if (!current.subSessions.includes(sid)) return false;
      const s = sessions ? sessions.get(sid) : null;
      return s && s.status !== 'dormant';
    });

    // Phase B: append user turn to timeline. Always do this (even when no valid
    // targets) so Feed UI history is complete.
    await ipcRenderer.invoke('meeting-append-user-turn', { meetingId: meeting.id, text });

    const contextBySid = {};

    if (validTargets.length === 0) {
      console.warn('[meeting-room] handleMeetingSend: no valid targets, message recorded in timeline only');
      meeting.lastMessageTime = Date.now();
      ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { lastMessageTime: meeting.lastMessageTime } });
      return;
    }

    // --- Normal mode: Phase C send to each target ---
    for (const sessionId of validTargets) {
      const payload = (contextBySid[sessionId] || '') + text;
      ipcRenderer.send('terminal-input', { sessionId, data: payload });
      const session = sessions ? sessions.get(sessionId) : null;
      // 2026-05-02 修复：旧版本仅 codex 用 400ms 延迟，其他 200ms。但 Claude/Gemini/
      //   DeepSeek/GLM 同样是 TUI alt-screen + paste-detect 程序，200ms 太短可能让 \r
      //   落进 paste 缓冲被吞 → 字符进了 CLI 输入框但 Enter 没提交 → 用户血泪反馈
      //   "卡输入框需手按 Enter"。统一所有 paste-sensitive CLI 都用 400ms 兜底，
      //   powershell 等普通 shell 仍 200ms。
      const baseDelay = session && isPasteSensitive(session.kind) ? 400 : 200;
      const sizeDelay = Math.min(Math.floor(payload.length / 100) * 10, 500);
      setTimeout(() => {
        ipcRenderer.send('terminal-input', { sessionId, data: '\r' });
      }, baseDelay + sizeDelay);
    }

    meeting.lastMessageTime = Date.now();
    ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { lastMessageTime: meeting.lastMessageTime } });
    _contextCompressCache.clear();
  }

  // Format incremental-context turns as a clear "meeting sync" prefix the AI can
  // recognize as not being from the user. Format:
  //   [会议室协作同步]
  //   【你】Q2 follow-up
  //   【Codex】R2_X content...
  //   ---
  function formatIncrementalContext(turns, sessions) {
    const lines = ['[会议室协作同步]'];
    for (const t of turns) {
      let label;
      if (t.sid === 'user') {
        label = '你';
      } else {
        const s = sessions ? sessions.get(t.sid) : null;
        label = s ? (s.title || s.kind || 'AI') : 'AI';
      }
      lines.push(`【${label}】${t.text}`);
    }
    lines.push('---', '');
    return lines.join('\n');
  }

  const _contextCompressCache = new Map();

  async function buildContextSummary(meeting, excludeSessionId) {
    const others = meeting.subSessions.filter(id => id !== excludeSessionId);
    if (others.length === 0) return '';

    const lines = [];
    for (const id of others) {
      const session = sessions ? sessions.get(id) : null;
      const label = session ? (session.kind || 'session') : 'session';

      // 1. Try SM marker content first
      let content = await ipcRenderer.invoke('quick-summary', id);

      // 2. Fallback to ring buffer last 1000 chars
      if (!content) {
        const raw = await ipcRenderer.invoke('get-ring-buffer', id);
        if (raw) content = raw.length > 1000 ? raw.slice(-1000) : raw;
      }

      if (!content) continue;

      // 3. Threshold: ≤1000 use as-is, >1000 compress via Gemini Flash
      if (content.length > 1000) {
        const cacheKey = id + ':' + simpleHash(content);
        if (_contextCompressCache.has(cacheKey)) {
          content = _contextCompressCache.get(cacheKey);
        } else {
          const compressed = await ipcRenderer.invoke('compress-context', { content, maxChars: 1000 });
          _contextCompressCache.set(cacheKey, compressed);
          content = compressed;
        }
      }

      lines.push(`【${label}】${content}`);
    }

    if (lines.length === 0) return '';
    return `[会议室协作同步]\n${lines.join('\n')}\n---\n`;
  }

  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return hash.toString(36);
  }

  // --- Quote (Right-click) ---

  function handleQuoteContext(e, meeting, sourceSessionId) {
    const cached = subTerminals[sourceSessionId];
    if (!cached || !cached.terminal) return;

    const selection = cached.terminal.getSelection();
    if (!selection) return;

    e.preventDefault();

    const old = document.getElementById('mr-quote-context-menu');
    if (old) old.remove();

    const others = meeting.subSessions.filter(id => id !== sourceSessionId);
    if (others.length === 0) return;

    const sourceSession = sessions ? sessions.get(sourceSessionId) : null;
    const sourceLabel = sourceSession ? sourceSession.kind : 'session';

    const menu = document.createElement('div');
    menu.id = 'mr-quote-context-menu';
    menu.className = 'mr-quote-menu';
    menu.style.top = e.clientY + 'px';
    menu.style.left = e.clientX + 'px';

    for (const targetId of others) {
      const targetSession = sessions ? sessions.get(targetId) : null;
      const targetLabel = targetSession ? targetSession.kind : 'session';
      const item = document.createElement('button');
      item.className = 'mr-quote-menu-item';
      item.textContent = `引用到 ${targetLabel}`;
      item.addEventListener('click', () => {
        menu.remove();
        const inputBox = document.getElementById('mr-input-box');
        if (inputBox) {
          inputBox.textContent = `> [来自 ${sourceLabel}] ${selection}\n`;
          const range = document.createRange();
          range.selectNodeContents(inputBox);
          range.collapse(false);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
        meeting.sendTarget = targetId;
        ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { sendTarget: targetId } });
        renderToolbar(meeting);
        renderTerminals(meeting);
      });
      menu.appendChild(item);
    }

    document.body.appendChild(menu);
    const dismiss = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove();
        document.removeEventListener('mousedown', dismiss);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
  }

  // --- Helpers ---

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // --- Tab output state tracking ---
  ipcRenderer.on('terminal-data', (_e, { sessionId }) => {
    if (!activeMeetingId) return;
    const meeting = meetingData[activeMeetingId];
    if (!meeting || !meeting.subSessions.includes(sessionId)) return;
    const focused = meeting.focusedSub || meeting.subSessions[0];
    if (sessionId === focused) return;

    _tabState[sessionId] = 'streaming';
    updateTabIndicator(sessionId);

    if (_tabTimers[sessionId]) clearTimeout(_tabTimers[sessionId]);
    _tabTimers[sessionId] = setTimeout(() => {
      if (_tabState[sessionId] === 'streaming') {
        _tabState[sessionId] = 'new-output';
        updateTabIndicator(sessionId);
      }
    }, 2000);
  });

  ipcRenderer.on('session-closed', (_e, { sessionId }) => {
    if (_tabState[sessionId] !== undefined) {
      _tabState[sessionId] = 'error';
      updateTabIndicator(sessionId);
    }
    // IF-C6（多方审查 high 修复 2026-05-01）：CLI 进程退出后清 _cliReadyCache，
    //   避免单调递增——一旦 ready=true 永不复查导致卡片错误显示"已就绪"。
    //   清后下个 cliReady poll tick 会重新查 IPC 拿到 false（getSession 找不到 sid 即返回 false）。
    if (_cliReadyCache[sessionId] !== undefined) {
      delete _cliReadyCache[sessionId];
      if (activeMeetingId && _isPanelCapableMeeting(meetingData[activeMeetingId])) {
        const cached = _rtPanelState[activeMeetingId];
        if (cached) {
          const panel = _ensureRtPanel();
          panel.innerHTML = _renderRtPanelHtml(cached, meetingData[activeMeetingId]);
          _bindRtPanelEvents(panel, meetingData[activeMeetingId]);
        }
      }
    }
  });

  function updateTabIndicator(sessionId) {
    const tab = document.querySelector(`.mr-tab[data-sid="${sessionId}"]`);
    if (!tab) return;
    const state = _tabState[sessionId] || 'idle';
    let dot = tab.querySelector('.mr-tab-status');
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'mr-tab-status';
      tab.prepend(dot);
    }
    dot.className = `mr-tab-status ${state}`;
    let badge = tab.querySelector('.new-badge');
    if (state === 'new-output') {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'new-badge';
        badge.textContent = 'NEW';
        tab.appendChild(badge);
      }
      tab.classList.add('has-new');
    } else {
      if (badge) badge.remove();
      tab.classList.remove('has-new');
    }
  }

  // --- Live badge refresh on status-event ---
  ipcRenderer.on('status-event', (_e, payload) => {
    if (!activeMeetingId) return;
    const meeting = meetingData[activeMeetingId];
    if (!meeting || !meeting.subSessions.includes(payload.sessionId)) return;
    const session = sessions ? sessions.get(payload.sessionId) : null;
    if (!session) return;
    const title = session.title || session.kind || 'session';
    const badges = subModelBadgeHtml(session) + subCtxBadgeHtml(session);
    const markerBadge = markerStatusHtml(payload.sessionId);
    const newHtml = `${escapeHtml(title)}${badges ? ' ' + badges : ''}`;
    // Update sub-slot header
    const slot = document.querySelector(`.mr-sub-slot[data-session-id="${payload.sessionId}"]`);
    if (slot) {
      const label = slot.querySelector('.mr-sub-label');
      if (label) label.innerHTML = `${newHtml} ${markerBadge}`;
    }
    // Update focus-mode tab (preserve status dot + NEW badge + marker badge)
    const tab = document.querySelector(`.mr-tab[data-sid="${payload.sessionId}"]`);
    if (tab) {
      const state = _tabState[payload.sessionId] || 'idle';
      const statusDot = `<span class="mr-tab-status ${state}"></span>`;
      const newBadge = state === 'new-output' ? ' <span class="new-badge">NEW</span>' : '';
      tab.innerHTML = `${statusDot}${newHtml} ${markerBadge}${newBadge}`;
    }
  });

  // --- Expose global ---

  window.MeetingRoom = {
    init,
    openMeeting,
    closeMeetingPanel,
    getActiveMeetingId,
    getMeetingData,
    updateMeetingData,
    mountSubTerminal,
  };

})();

// Node 测试环境兼容（renderer 真实运行时为 IIFE 浏览器环境，typeof module 为 undefined 走不到这）
if (typeof module !== 'undefined' && module.exports) {
  // 让 unit test 能 require 到 _isPartialUnchanged。这种"双模兼容"模式同 core/roundtable-free.js。
  // 双份函数体看起来 DRY 违反，但 IIFE 内部变量（document、ipcRenderer）在 Node require 时不存在 →
  // 把整个 IIFE 移出来代价巨大。_isPartialUnchanged 是纯函数无外部依赖 → 复制一份是最低成本路径。
  module.exports = {
    _isPartialUnchanged: function _isPartialUnchanged(prev, next) {
      if (!prev && !next) return true;
      if (!prev || !next) return false;
      if (prev.text !== next.text) return false;
      if (prev.status !== next.status) return false;
      if (prev.cleanBufLen !== next.cleanBufLen) return false;
      if (prev.sendStatus !== next.sendStatus) return false;
      const pt = prev.tokens && prev.tokens.total;
      const nt = next.tokens && next.tokens.total;
      if (pt !== nt) return false;
      const pb = Array.isArray(prev.blocks) ? prev.blocks : null;
      const nb = Array.isArray(next.blocks) ? next.blocks : null;
      if (!pb && !nb) return true;
      if (!pb || !nb) return false;
      if (pb.length !== nb.length) return false;
      if (pb.length === 0) return true;
      const last = pb.length - 1;
      if (pb[last].type !== nb[last].type) return false;
      if ((pb[last].text || '') !== (nb[last].text || '')) return false;
      return true;
    },
  };
}
