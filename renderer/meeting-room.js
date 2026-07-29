// renderer/meeting-room.js
// Meeting Room UI — manages the parallel terminal panel.
// Exposes global `MeetingRoom` object consumed by renderer.js.
// T2（2026-05-04 道雪）：底部 module.exports 暴露 _isPartialUnchanged 给 Node unit test，
//   require 时 typeof document === 'undefined' → IIFE 体内大量 DOM/IPC 引用会爆，故 IIFE 只在 renderer 浏览器环境跑。

if (typeof document !== 'undefined') (function () {
  const { ipcRenderer } = require('electron');
  const { isSlotParticipatingThisTurn } = require('../core/meeting-room.js');
  const { CLAUDE_MEMORY_INDEX: _CLAUDE_MEMORY_INDEX } = require('../core/claude-memory-loader.js');
  const {
    buildHeroPromptBlock: _buildHeroPromptBlock,
    getHero: _getHero,
    listHeroes: _listHeroes,
    normalizeHeroAssignments: _normalizeHeroAssignments,
  } = require('../core/hero-prompts.js');
  const { isPasteSensitive, kindRegexAlternation, KIND_LABELS, ALL_AI_KINDS, getKindLabel,
          SLOT_IDS, SLOT_DISPLAY, getSlotPromptName, getSlotDisplayLabel,
          slotIdRegexAlternation, slotIdToIndex, slotIndexToId } = require('../core/ai-kinds.js');
  const {
    avatarBySlot: _avatarBySlot,
    avatarFallbackBySlot: _avatarFallbackBySlot,
    avatarFallbackFor: _avatarFallbackFor,
    avatarSrcFor: _avatarSrcFor,
    escapeHtml,
    formatThinkTime: _formatThinkTime,
    formatTokens: _formatTokens,
    ftCtxClass: _ftCtxClass,
  } = require('./meeting-room-format.js');

  let activeMeetingId = null;
  let meetingData = {};
  // IF-C1（2026-05-01）：CLI ready 状态 cache（per-sid bool），由 cli-ready-status IPC 1s 轮询填充
  //   驱动 isInitializing 判断（修 P0 阻塞 bug B：原 markerStatus 永远 'none' 导致永久卡"创建中"）
  let _cliReadyCache = {};
  let _cliReadyPollTimer = null;
  let _cliReadyPollInFlight = null;
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
  // 与 core/meeting-room.js 的 isGroupChatCapableMeeting 语义一致。
  function _isPanelCapableMeeting(m) {
    return !!(m && m.scene);
  }

  // --- Group chat @command parser ---
  // 摘要功能 2026-05-08 整体下线：原 @summary @<slot> 命令路径已删
  // 现仅支持 @m1 / @all / @<slot>（@<slot> 仅用于剥前缀，仍走 fanout）
  const _RT_SLOT_ALT = slotIdRegexAlternation();
  const _tokenRe = new RegExp('^@(' + _RT_SLOT_ALT + ')\\b\\s*', 'i');
  // --- Group Chat Mode: 持久化 AI 群聊面板（始终显示当前状态 + 历史）---
  // Phase 5(2026-05-05 道雪): 时光机模式状态 — _gcViewingTurnN[meetingId] = N 表示正在查看第 N 轮历史。
  //   null / undefined = 默认查看最新轮(实时模式), 数字 = 查看第 N 轮(只读历史模式)。
  //   切换由 stepper dot click 触发 → 重渲 panel + _renderSlotCard 拿 turn.by[sid] 渲染历史内容。
  const _gcViewingTurnN = {};

  // _gcPanelState[meetingId] 缓存渲染状态，避免 IPC 频繁调用
  // partialBy: 当前进行中轮次的部分回答 { sid: { text, status } } — 单家完成立即更新
  const _gcPanelState = {};

  // [幕次折叠] meetingId -> Set(actKey) 当前被折叠的幕次（前端临时状态，不持久化；刷新后默认全展开）。
  const _gcCollapsedActs = {};

  // T3（2026-05-04 道雪）：抽屉实时订阅状态。打开时设 { sid, mid, kind }，关时清 null。
  //   partial-update handler 命中同 sid + 用户当前 active 的是 live tab 时，更新抽屉内容。
  let _gcTimelineLive = null;
  // T3 fix（2026-05-04 道雪）：上一次抽屉的清理函数，开新抽屉前先调，避免 escHandler 累积绑定 + 闭包内存泄漏。
  let _gcTimelineCleanup = null;
  // pilot redesign（2026-05-02）：_privateCountCache 已废弃（AI 群聊不再桥接子会话私聊）
  const _thinkStartTs = {};
  let _thinkTimer = null;
  // F0 Phase 1(2026-05-04 道雪): 卡片聚焦态全局状态。null = 默认态; sid = 该卡聚焦中。
  //   触发: click 任一 .mr-ft → 进入; 再次 click 同卡 / Esc / 点空白 → 退出。
  //   退出后 meeting.focusedSub 不变(主显仍是该 sid)。
  let _gcFocusedCardSid = null;

  // F5 Phase 3(2026-05-04 道雪 / spec F5 简化版): 整轮总耗时
  //   原本 token + 成本估算因 transcript-tap 仅 GeminiTap 提供 token 数据,
  //   Claude/Codex/DeepSeek 等的 token/cost 显示 "--", 用户视觉上无价值。
  //   决定: 仅保留总耗时显示。token/cost 留给后续 transcript-tap 扩展后再启用。

  // F7 Phase 3 全员完成通知（Web Notification + title 闪烁）已废弃。
  //   2026-05-05 道雪 修3：改用侧栏 unread 机制（renderer.js 监听 turn-complete IPC，
  //   非 active AI 群聊累加 meeting.unreadCount → renderSessionList 渲染 has-unread + ⏸ 等你 badge），
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
  }
  function _setCardViewMode(mode, meeting) {
    const next = mode === 'tab' ? 'tab' : 'parallel';
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(_CARD_VIEW_MODE_KEY, next);
      }
    } catch {}
    _applyCardViewModeClass(next);
    if (next === 'tab') {
      _clearCompareSelect();
      _gcFocusedCardSid = null;
      document.body.classList.remove('mr-card-focus-on');
      const m = meeting || (activeMeetingId && meetingData[activeMeetingId]);
      if (m && !m.focusedSub && Array.isArray(m.subSessions) && m.subSessions[0]) {
        m.focusedSub = m.subSessions[0];
      }
    }
    const active = meeting || (activeMeetingId && meetingData[activeMeetingId]);
    if (active && _isPanelCapableMeeting(active)) refreshGroupChatPanel(active);
    if (typeof _relayoutMeetingRoom === 'function') {
      setTimeout(() => _relayoutMeetingRoom(), 260);
    }
  }
  _applyCardViewModeClass(_getCardViewMode());

  const _GROUP_VIEW_MODE_KEY = 'mr-group-chat-view-mode';
  function _getGroupViewMode() {
    try {
      const mode = typeof localStorage !== 'undefined' ? localStorage.getItem(_GROUP_VIEW_MODE_KEY) : null;
      return mode === 'card' ? 'card' : 'chat';
    } catch { return 'chat'; }
  }
  function _setGroupViewMode(mode, meeting) {
    const next = mode === 'card' ? 'card' : 'chat';
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(_GROUP_VIEW_MODE_KEY, next);
    } catch {}
    const active = meeting || (activeMeetingId && meetingData[activeMeetingId]);
    if (active && _isPanelCapableMeeting(active)) {
      // 视图切换是纯 renderer 状态，先用已有 cache 同步重绘，避免 header 已切换
      // 但异步 get-state 尚未返回时主体仍停在上一种视图。
      _renderActivePanelFromCache(active);
      refreshGroupChatPanel(active, { expectedGroupViewMode: next });
    }
    if (typeof _relayoutMeetingRoom === 'function') {
      setTimeout(() => _relayoutMeetingRoom(), 160);
    }
  }
  const _GROUP_SIDE_STATE_KEY = 'mr-group-chat-side-state';
  function _getGroupSideCollapsed() {
    // 普通聊天优先保证消息阅读宽度；用户显式展开后记住选择。
    try {
      const state = typeof localStorage !== 'undefined' ? localStorage.getItem(_GROUP_SIDE_STATE_KEY) : null;
      return state !== 'expanded';
    } catch { return true; }
  }
  function _setGroupSideCollapsed(collapsed, meeting) {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(_GROUP_SIDE_STATE_KEY, collapsed ? 'collapsed' : 'expanded');
      }
    } catch {}
    const active = meeting || (activeMeetingId && meetingData[activeMeetingId]);
    if (active && _isPanelCapableMeeting(active)) refreshGroupChatPanel(active);
    if (typeof _relayoutMeetingRoom === 'function') {
      setTimeout(() => _relayoutMeetingRoom(), 120);
    }
  }

  function _renderActivePanelFromCache(meeting, opts = {}) {
    const active = meeting || (activeMeetingId && meetingData[activeMeetingId]);
    if (!active || active.id !== activeMeetingId || !_isPanelCapableMeeting(active)) return false;
    const state = _gcPanelState[active.id];
    if (!state) return false;
    const panel = _ensureGcPanel();
    const forceGroupChatBottom = !!opts.forceGroupChatBottom && !!active.groupChat && _getGroupViewMode() === 'chat';
    const groupScroll = forceGroupChatBottom
      ? { scrollTop: 0, stickToBottom: true }
      : _captureGroupChatScroll(panel, active);
    try {
      _renderGcPanelInto(panel, active, state, {
        scroll: groupScroll,
        restoreOpts: { forceBottom: forceGroupChatBottom },
      });
      return true;
    } catch (e) {
      console.error('[groupchat] cached panel render failed:', e);
      return false;
    }
  }

  // 2026-07-20 道雪 [修#6b]：气泡展开态持久（key: meetingId|msgId）。
  const _gcExpandedBubbles = new Map();

  function _renderGcPanelInto(panel, meeting, state, opts = {}) {
    if (!panel || !meeting || !state) return false;
    panel.innerHTML = _renderGcPanelHtml(state, meeting);
    // 2026-07-29：_renderGcPanelHtml 只吐出卡片挂载点（登记在 _gcCardTurns），
    //   真正的 turn 卡片在这里由 turn-card-renderer 挂进去 —— 必须早于
    //   _applyLongAnswerCollapse / _enhanceCodeBlocks，它们要量已渲染内容的高度。
    _hydrateGroupChatCards(panel);
    _bindGcPanelEvents(panel, meeting);
    // 2026-07-20 道雪 [修#5]：后处理四件套统一在此执行（此前只在 refreshGroupChatPanel）。
    _applyLongAnswerCollapse(panel);
    _setupScrollToBottom(panel);
    _enhanceCodeBlocks(panel);
    _setupGcSearch(panel);
    _renderHeroDock(meeting);
    if (opts.scroll) {
      _restoreGroupChatScroll(panel, opts.scroll, opts.restoreOpts || {});
    }
    return true;
  }

  // F3 Phase 2(2026-05-04 道雪 / spec F3): 多卡 Ctrl/Cmd+click 对比模式
  //   状态: Set<sid>。空 = 默认; ≥1 = 对比模式 (body.mr-card-compare-on)
  //   spec §5 状态优先级: compare-selected 与 focus 互斥(进入对比时清 focus)
  //   退出: Esc / 点空白 / 取消最后一张
  //   简化版: 仅视觉描边(蓝色 dashed)+ 邻居淡化, 不动 grid 重分配
  const _gcCompareSlots = new Set();
  function _toggleCompareSelect(sid) {
    if (!sid) return;
    if (_gcFocusedCardSid) {
      _gcFocusedCardSid = null;
      document.body.classList.remove('mr-card-focus-on');
    }
    if (_gcCompareSlots.has(sid)) _gcCompareSlots.delete(sid);
    else _gcCompareSlots.add(sid);
    _applyCompareVisual();
  }
  function _clearCompareSelect() {
    if (_gcCompareSlots.size === 0) return;
    _gcCompareSlots.clear();
    _applyCompareVisual();
  }
  function _applyCompareVisual() {
    document.querySelectorAll('.mr-ft[data-ft-sid]').forEach(card => {
      const cardSid = card.getAttribute('data-ft-sid');
      if (_gcCompareSlots.has(cardSid)) card.classList.add('compare-selected');
      else card.classList.remove('compare-selected');
    });
    if (_gcCompareSlots.size > 0) document.body.classList.add('mr-card-compare-on');
    else document.body.classList.remove('mr-card-compare-on');
  }

  // F6 Phase 3(2026-05-04 道雪 / spec F6): 选中文本引用 chip
  //   流程: mouseup 选中 .mr-ft-bottom 内文本 → 浮按钮 [💎 引用追问] → 加 chip 到输入框上方区
  //   提交时: chips 内容拼到 prompt 头部"基于以下引用追问:\n[💎 第N轮 X: \"...\"]\n用户问题: ..."
  //   清空: 提交后 / 切 meeting 时
  let _gcQuoteChips = [];     // [{ sid, slotIndex, slotLabel, turnN, text }]
  let _gcQuoteFloatBtn = null; // body 级浮按钮 DOM, lazy 创建

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
    if (_gcQuoteChips.length === 0) {
      row.style.display = 'none';
      row.innerHTML = '';
      _updateInputPreflight(meetingData[activeMeetingId]);
      return;
    }
    row.style.display = '';
    row.innerHTML = _gcQuoteChips.map((c, i) => {
      const slotCls = (c.slotIndex >= 0 && c.slotIndex < 3) ? `slot-${c.slotIndex + 1}` : '';
      const truncated = c.text.length > 60 ? c.text.slice(0, 60) + '…' : c.text;
      return `<span class="mr-gc-quote-chip ${slotCls}" data-quote-idx="${i}">
        <span class="mr-gc-quote-label">💎 第${c.turnN}轮 ${escapeHtml(c.slotLabel)}</span>
        <span class="mr-gc-quote-text">"${escapeHtml(truncated)}"</span>
        <button class="mr-gc-quote-close" data-quote-close="${i}" title="移除此引用">✕</button>
      </span>`;
    }).join('');
    row.querySelectorAll('[data-quote-close]').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const idx = parseInt(btn.getAttribute('data-quote-close'), 10);
        if (!isNaN(idx) && idx >= 0 && idx < _gcQuoteChips.length) {
          _gcQuoteChips.splice(idx, 1);
          _renderQuoteChips();
        }
      });
    });
    _updateInputPreflight(meetingData[activeMeetingId]);
  }

  function _addQuoteChip(meeting, sid, text) {
    if (!sid || !text || !text.trim()) return;
    if (_gcQuoteChips.length >= 5) return;  // 最多 5 条引用 (避免 prompt 爆炸)
    const slots = _getGcSlots(meeting);
    const slotIndex = slots.findIndex(s => s && s.sid === sid);
    const slot = (slotIndex >= 0 && slotIndex < slots.length) ? slots[slotIndex] : null;
    if (!slot) return;
    const cached = _gcPanelState[meeting.id];
    const turnsArr = (cached && Array.isArray(cached.turns)) ? cached.turns : [];
    const turnN = turnsArr.length > 0 ? (turnsArr[turnsArr.length - 1].n || turnsArr.length) : 1;
    _gcQuoteChips.push({
      sid, slotIndex,
      slotLabel: slot.label || sid.slice(0, 8),
      turnN,
      text: text.trim().slice(0, 500),  // 单条最长 500 字符
    });
    _renderQuoteChips();
  }

  function _clearQuoteChips() {
    if (_gcQuoteChips.length === 0) return;
    _gcQuoteChips = [];
    _renderQuoteChips();
  }

  // mouseup 选区检测 + 浮按钮 (IIFE 顶层一次性挂)
  document.addEventListener('mouseup', function _gcQuoteSelHandler(ev) {
    if (!ev.target || typeof ev.target.closest !== 'function') return;
    const card = ev.target.closest('.mr-ft[data-ft-sid]');
    const hideBtn = () => { if (_gcQuoteFloatBtn) _gcQuoteFloatBtn.style.display = 'none'; };
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
    if (!_gcQuoteFloatBtn) {
      _gcQuoteFloatBtn = document.createElement('button');
      _gcQuoteFloatBtn.id = 'mr-gc-quote-float-btn';
      _gcQuoteFloatBtn.className = 'mr-gc-quote-float-btn';
      _gcQuoteFloatBtn.type = 'button';
      _gcQuoteFloatBtn.textContent = '💎 引用追问';
      _gcQuoteFloatBtn.title = '把选中文本作为引用加入下一轮 prompt (Phase 3 F6)';
      document.body.appendChild(_gcQuoteFloatBtn);
      _gcQuoteFloatBtn.addEventListener('mousedown', (e) => e.preventDefault()); // 防失焦清选区
      _gcQuoteFloatBtn.addEventListener('click', () => {
        const fSid = _gcQuoteFloatBtn.dataset.sid;
        const fText = _gcQuoteFloatBtn.dataset.text;
        const mid = activeMeetingId;
        const meeting = meetingData[mid];
        if (fSid && fText && meeting) _addQuoteChip(meeting, fSid, fText);
        _gcQuoteFloatBtn.style.display = 'none';
        try { window.getSelection().removeAllRanges(); } catch {}
      });
    }
    _gcQuoteFloatBtn.dataset.sid = sid;
    _gcQuoteFloatBtn.dataset.text = selText;
    _gcQuoteFloatBtn.style.display = 'inline-flex';
    // 选区右上方 + window scroll 偏移
    _gcQuoteFloatBtn.style.top = `${rect.top + window.scrollY - 34}px`;
    _gcQuoteFloatBtn.style.left = `${rect.right + window.scrollX - 90}px`;
  });

  // F0 + F3 Phase 1/2 + Phase 5: 全局 Esc — 退出聚焦/对比/时光机。IIFE 顶层挂载, 只挂一次。
  document.addEventListener('keydown', function _gcFocusEscHandler(ev) {
    if (ev.key !== 'Escape') return;
    // F6: Esc 也关闭引用浮按钮
    if (_gcQuoteFloatBtn && _gcQuoteFloatBtn.style.display !== 'none') {
      _gcQuoteFloatBtn.style.display = 'none';
    }
    if (_gcFocusedCardSid) {
      _gcFocusedCardSid = null;
      document.body.classList.remove('mr-card-focus-on');
    }
    if (_gcCompareSlots.size > 0) _clearCompareSelect();
    // Phase 5: Esc 退出时光机模式(对当前 active meeting)。
    //   meetings 是 plain object(不是 Map), 用 meetings[id] 取
    if (typeof activeMeetingId !== 'undefined' && activeMeetingId && _gcViewingTurnN[activeMeetingId]) {
      delete _gcViewingTurnN[activeMeetingId];
      const m = (typeof meetings !== 'undefined' && meetings) ? meetings[activeMeetingId] : null;
      if (m) refreshGroupChatPanel(m);
    }
  });
  document.addEventListener('click', function _gcFocusBlankClickHandler(ev) {
    if (ev.target && ev.target.closest && ev.target.closest('.mr-ft')) return;
    if (_gcFocusedCardSid) {
      _gcFocusedCardSid = null;
      document.body.classList.remove('mr-card-focus-on');
    }
    if (_gcCompareSlots.size > 0) _clearCompareSelect();
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
  document.body.addEventListener('wheel', function _gcCardFocusWheelHandler(e) {
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
  const _gcTurnStartTs = {};

  // markdown 渲染（用项目已有的 marked + DOMPurify）
  let _markedCache = null;
  let _domPurifyCache = null;

  function _normalizeMarkdownPathBreaks(text) {
    if (typeof window !== 'undefined' && typeof window.normalizeWrappedPathBreaks === 'function') {
      return window.normalizeWrappedPathBreaks(text);
    }
    return String(text || '');
  }

  // 卡片优化（2026-05-03 道雪）：与 renderer.js 的 ABS_PATH_RE 同源 — 绝对路径
  //   (Windows C:\... / UNC \\server\... / ~ 起始)，扩展名 1-8 ASCII。AI 群聊卡片
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

  // Windows 绝对路径在 markdown 里会被 marked 的 escape 规则吃掉反斜杠
  // （如 `C:\Users\lintian\.arena` 中 `\.` 被吞成 `.`，导致 data-path 错位、
  // 下游 shell.openPath / Set-Clipboard 全部找不到文件）。
  // 解决：marked 解析前用私用区 placeholder 包住路径，解析完原样还原。
  const _PATH_GUARD_RE = /[A-Za-z]:[\\/](?:[^\s'"`<>|*?\r\n]+)/g;
  function _guardWindowsPaths(text) {
    const map = new Map();
    let n = 0;
    const guarded = String(text).replace(_PATH_GUARD_RE, (m) => {
      const key = 'PG' + (n++) + '';
      map.set(key, m);
      return key;
    });
    return { guarded, map };
  }
  function _unguardWindowsPaths(html, map) {
    if (!map || map.size === 0) return html;
    let out = html;
    for (const [key, val] of map) {
      out = out.split(key).join(val);
    }
    return out;
  }

  function _renderMarkdownUncached(text) {
    try {
      if (!_markedCache) _markedCache = require('marked').marked;
      if (!_domPurifyCache) _domPurifyCache = require('dompurify');
      const { guarded, map: pathMap } = _guardWindowsPaths(_normalizeMarkdownPathBreaks(text));
      let html = _markedCache.parse(guarded, { breaks: true, gfm: true });
      html = _unguardWindowsPaths(html, pathMap);
      const sanitized = _domPurifyCache.sanitize(html, { ADD_ATTR: ['data-path', 'class'] });
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
  // #1 流式/重渲性能：_renderMarkdown 对相同文本会被反复调用——chat/full-panel panel 每个
  //   partial tick 重渲所有已完成消息、tab 切换/时光机/soft-alert 亦然。同一 text 经
  //   marked+DOMPurify+Prism 必得同一 HTML（运行期配置稳定），故按 text 做 LRU memo：
  //   稳定内容直接命中缓存，跳过 parse+sanitize+DOM walk+Prism；流式增长中的那条每 tick
  //   text 不同必然 miss（不影响正确性），命中的是其周围大量稳定内容。输出逐字节一致，
  //   零视觉/行为变化。Map 迭代序=插入序，命中即 delete+set 重置到队尾，超上限驱逐最旧。
  const _mdCache = new Map();
  const _MD_CACHE_MAX = 300;
  const _mdStats = { renders: 0, hits: 0 };
  function _renderMarkdown(text) {
    if (!text) return '';
    const hit = _mdCache.get(text);
    if (hit !== undefined) {
      _mdCache.delete(text); _mdCache.set(text, hit);
      _mdStats.hits++;
      return hit;
    }
    const out = _renderMarkdownUncached(text);
    _mdStats.renders++;
    _mdCache.set(text, out);
    if (_mdCache.size > _MD_CACHE_MAX) _mdCache.delete(_mdCache.keys().next().value);
    return out;
  }
  if (typeof window !== 'undefined') {
    // 可观测/E2E seam（同底部 module.exports 暴露 _isPartialUnchanged 之意图）：
    //   供 CDP 度量 memo 命中率、验证相同 text 输出逐字节一致。
    window.__mrMarkdownStats = _mdStats;
    window.__mrRenderMarkdown = _renderMarkdown;
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

  // 2026-07-29 道雪：_formatToolUseBlock / _renderPreviewBlocks 已删除。
  //   它们是 T7（2026-05-01）为群聊自建的一套 blocks 渲染（thinking 灰斜体 / tool_use
  //   cyan chip / text 走 _renderMarkdown），与 renderer/turn-card-renderer.js 的
  //   thinking <details> + 工具簇 + markdown 正文完全平行 —— 同一份 transcript-tap
  //   数据两套渲染，长期结果是群聊这套慢慢落后（工具返回预览、代码高亮、长文折叠、
  //   meta pills 都只有子 session 卡片有）。
  //   现在群聊三个渲染面（聊天流气泡 / 卡片视图 / 时间线抽屉）统一走
  //   _gcTurnFromBlocks → _gcRegisterCard → _hydrateGroupChatCards → mountSessionTurnCard。

  // 注：顶部 scene toggle（群聊/投研）的 _renderModeToggle/_bindModeToggle 已删除
  //   （2026-05-04 决策：scene 创建时确定，运行时不可切换）。
  //   IPC `switch-scene` handler 保留，避免破坏其它代码路径。

  function _ensureGcPanel() {
    let panel = document.getElementById('mr-group-chat-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'mr-group-chat-panel';
      panel.className = 'mr-gc-panel';
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

  function _removeGcPanel() {
    const p = document.getElementById('mr-group-chat-panel');
    if (p && p.parentElement) p.remove();
  }

  // sub session 信息（kind → {sid, label}）— 用于按 kind 索引找子 session 显示信息。
  // Build a first-session lookup for the active core AI kinds. Duplicate-kind slot semantics are handled by slot specs.
  function _getGcSubInfo(meeting) {
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

  // meeting-create-modal（2026-05-01）：按 subSessions 数组顺序还原 slot 数组。
  //   返回 [slot0, slot1, slot2]，每个 slot 是 { sid, kind, slotId, slotIndex, label, displayLabel }
  // Restore slot metadata from subSessions order. slotId is member1/member2/member3.
  function _getGcSlots(meeting) {
    const maxSlots = meeting && meeting.groupChat && Array.isArray(meeting.subSessions)
      ? meeting.subSessions.length
      : 3;
    const slots = Array.from({ length: maxSlots }, () => null);
    if (!meeting || !Array.isArray(meeting.subSessions)) return slots;
    for (let i = 0; i < meeting.subSessions.length && i < maxSlots; i++) {
      const sid = meeting.subSessions[i];
      const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      if (!s) continue;
      const slotId = slotIndexToId(i);
      const kindLabel = getKindLabel(s.kind);
      slots[i] = {
        sid,
        kind: s.kind,
        slotId,
        slotIndex: i,
        label: meeting.groupChat ? (s.title || `${kindLabel} ${i + 1}`) : (slotId ? getSlotPromptName(slotId) : (s.title || s.kind || `Slot ${i + 1}`)),
        displayLabel: meeting.groupChat ? (s.title || `${kindLabel} ${i + 1}`) : (slotId ? getSlotDisplayLabel(slotId) : (s.title || s.kind || `Slot ${i + 1}`)),
      };
    }
    return slots;
  }
  // ai-kinds.js is the single source of truth for supported AI labels.
  const _KIND_LABELS = KIND_LABELS;

  const _DUTY_HAT_PROMPT_MARKER = '## 临时职责帽（本轮有效，不写入长期记忆）';
  const _DUTY_HATS_BY_SCENE = {
    general: [
      {
        id: 'clarifier',
        icon: '❓',
        label: '问题澄清员',
        short: '澄清',
        duty: '负责拆解用户问题、补齐前提、指出会改变答案的关键缺口；不要直接替其他角色下结论。',
        format: '问题拆解 / 已知前提 / 缺失信息 / 关键追问 / 默认假设',
      },
      {
        id: 'fact_check',
        icon: '🔍',
        label: '事实核验员',
        short: '核验',
        duty: '负责核验关键事实、数字、引用、时间点与来源；不确定内容必须明确标注。',
        format: '已确认事实 / 来源与时间 / 不确定项 / 冲突口径 / 需补查',
      },
      {
        id: 'options',
        icon: '🧩',
        label: '方案设计师',
        short: '方案',
        duty: '负责提出可选方案和执行路径，说明每个方案的适用条件，不负责风险挑错。',
        format: '方案 A / 方案 B / 适用条件 / 成本收益 / 推荐前提',
      },
      {
        id: 'critic',
        icon: '⚠️',
        label: '反方挑战者',
        short: '反方',
        duty: '负责寻找遗漏、反例、逻辑跳跃和失败路径；避免复述方案优点。',
        format: '最大风险 / 反例 / 隐含假设 / 失败信号 / 修正建议',
      },
      {
        id: 'judge',
        icon: '🎯',
        label: '综合裁判',
        short: '裁判',
        duty: '负责收敛共识与分歧，给出可执行结论和取舍理由；不做无差别折中。',
        format: '结论 / 取舍理由 / 主要分歧 / 决策条件 / 下一步',
      },
      {
        id: 'action',
        icon: '✅',
        label: '行动拆解员',
        short: '行动',
        duty: '负责把结论拆成下一步动作、负责人、验证方式和截止条件。',
        format: '下一步 / 优先级 / 负责人或角色 / 验证标准 / 截止条件',
      },
    ],
    research: [
      {
        id: 'data',
        icon: '🔍',
        label: '数据核验员',
        short: '核验',
        duty: '只负责核验关键数字、事实、来源与时间点；未查到或未确认的内容必须标注“未核验”。核验前先调 stock_static(symbol) 拿财务/估值/股东/质押底数，对照其 confidence 标签，非 HIGH 字段必须提示口径风险。',
        format: '已核验数据 / 数据来源 / 数据时点 / 未核验项 / 口径或冲突风险',
      },
      {
        id: 'bear',
        icon: '🧨',
        label: '空头审稿人',
        short: '空头',
        duty: '只负责攻击前面观点，寻找反例、逻辑跳跃、过期数据、证伪条件；不要输出综合结论。攻击要落到实据：调 stock_static 查质押/商誉/股东减持等雷点，必要时调 stock_news 反证催化是否已被 price-in；质疑同样标证据强度（strong/medium/weak），weak 级不能单独作为“建议打回”的理由。',
        format: '最大漏洞 / 反例 / 需要补查 / 证伪条件 / 是否建议打回',
      },
      {
        id: 'bull',
        icon: '📈',
        label: '多头论证员',
        short: '多头',
        duty: '负责构建最强看多逻辑链，但必须给出验证条件和失效条件，避免只讲叙事。看多链必须挂在数据上：调 stock_static 验财务/估值底子、stock_news 找催化与一致预期；关键证据标 strong/medium/weak，weak 不得单独支撑高置信。',
        format: '看多主张 / 关键证据 / 验证条件 / 失效条件 / 置信度',
      },
      {
        id: 'judge',
        icon: '🎯',
        label: '综合裁判',
        short: '裁判',
        duty: '负责在其他成员发言后收敛，不负责和稀泥；合并共识与分歧，给出行动前复核清单。原则上不另调数据工具，专注收敛各方已查证据；若有机器基线分/体检卡则以其为量化锚，偏离要说明理由。',
        format: '结论等级 / 置信度 / 主要分歧 / 需要补查的数据 / 行动前复核清单',
      },
      {
        id: 'catalyst',
        icon: '📰',
        label: '消息催化帽',
        short: '催化',
        duty: '负责公告、财报日历、政策、监管、新闻事件与催化剂时间表，区分已发生、已知未兑现和待确认信息。优先调 stock_news(symbol) 拿公告/新闻/快讯；若要看社区情绪、争议焦点、V大观点，再调 stock_sentiment(symbol)。每个催化剂必须带日期与来源，并指出市场已知与可能的预期差。',
        format: '最新事件 / 来源与时间 / 影响路径 / 待兑现节点 / 可靠性',
      },
      {
        id: 'technical',
        icon: '📊',
        label: '技术分析师',
        short: '技术',
        duty: '负责趋势、量价、资金流、融资融券、实时盘口等交易层信号，回答市场现在在做什么。优先调 stock_market(symbol) 拿 K线/RSI/MACD/资金流/融资融券；支撑、压力、止损位必须基于真实指标算，不得凭记忆估。问“历史上类似形态后来怎么走”时再调 kline_similarity(symbol)。',
        format: '趋势方向 / 关键价位 / 量能资金 / 短期风险 / 失效信号',
      },
    ],
    dev: [
      {
        id: 'requirements',
        icon: '🧭',
        label: '需求澄清员',
        short: '需求',
        duty: '负责确认目标、验收标准、边界条件和用户真实工作流；不急于给实现方案。',
        format: '目标 / 验收标准 / 边界条件 / 待确认问题 / 非目标',
      },
      {
        id: 'architect',
        icon: '🏗️',
        label: '架构设计师',
        short: '架构',
        duty: '负责判断模块边界、数据流、接口契约和可维护性取舍；避免过度设计。',
        format: '影响范围 / 模块边界 / 数据流 / 关键取舍 / 迁移风险',
      },
      {
        id: 'implementer',
        icon: '🛠️',
        label: '实现工程师',
        short: '实现',
        duty: '负责给出最小可落地实现路径、关键文件、伪代码或补丁思路。',
        format: '改动文件 / 实现步骤 / 关键代码点 / 兼容性 / 回滚方式',
      },
      {
        id: 'reviewer',
        icon: '🔎',
        label: '代码审稿人',
        short: '审稿',
        duty: '负责从缺陷、回归、并发、状态一致性和可读性角度挑错；不要重写完整方案。',
        format: '高风险点 / 可能回归 / 可读性问题 / 必改项 / 可缓项',
      },
      {
        id: 'tester',
        icon: '🧪',
        label: '测试守门员',
        short: '测试',
        duty: '负责设计验证路径、红绿测试、手工检查和日志证据；明确哪些无法验证。',
        format: '必测场景 / 自动化测试 / 手工验证 / 日志证据 / 剩余风险',
      },
      {
        id: 'release',
        icon: '🚦',
        label: '发布排障员',
        short: '发布',
        duty: '负责关注配置、构建、部署、回滚、兼容环境和线上排障路径。',
        format: '配置检查 / 构建发布 / 环境依赖 / 回滚方案 / 排障入口',
      },
    ],
  };
  const _dutyHatAssignmentsByMeeting = {};

  function _getDutyHatScene(meeting) {
    const scene = meeting && typeof meeting.scene === 'string' ? meeting.scene : 'general';
    return _DUTY_HATS_BY_SCENE[scene] ? scene : 'general';
  }

  function _getDutyHats(meeting) {
    return _DUTY_HATS_BY_SCENE[_getDutyHatScene(meeting)];
  }

  function _getDutyHatAssignmentKey(meeting) {
    if (!meeting || !meeting.id) return '';
    return `${meeting.id}:${_getDutyHatScene(meeting)}`;
  }

  function _getDutyHatAssignments(meeting) {
    const key = _getDutyHatAssignmentKey(meeting);
    if (!key) return {};
    if (!_dutyHatAssignmentsByMeeting[key]) _dutyHatAssignmentsByMeeting[key] = {};
    return _dutyHatAssignmentsByMeeting[key];
  }

  function _clearDutyHatAssignments(meeting) {
    const key = _getDutyHatAssignmentKey(meeting);
    if (key) delete _dutyHatAssignmentsByMeeting[key];
  }

  function _memberMentionLabel(slot) {
    if (!slot) return 'AI';
    const label = slot.displayLabel || slot.label || slot.kind || `AI ${slot.slotIndex + 1}`;
    return `m${slot.slotIndex + 1}（${label}）`;
  }

  function _renderDutyHatPanel(meeting, slots) {
    if (!meeting || !meeting.groupChat || !Array.isArray(slots) || slots.length === 0) return '';
    const dutyHats = _getDutyHats(meeting);
    const assignments = _getDutyHatAssignments(meeting);
    const validSlots = slots.filter(slot => slot && slot.sid);
    const validSids = new Set(validSlots.map(slot => slot.sid));
    const assignedCount = dutyHats.filter(h => assignments[h.id] && validSids.has(assignments[h.id])).length;
    const rows = dutyHats.map(hat => {
      const sid = validSids.has(assignments[hat.id]) ? assignments[hat.id] : '';
      const optionsHtml = validSlots.map(slot => {
        const label = _memberMentionLabel(slot);
        return `<option value="${escapeHtml(slot.sid)}" ${slot.sid === sid ? 'selected' : ''}>${escapeHtml(label)}</option>`;
      }).join('');
      return `
        <label class="mr-duty-hat-row ${sid ? 'assigned' : ''}" title="${escapeHtml(hat.duty)}">
          <span class="mr-duty-hat-label">
            <span class="mr-duty-hat-icon" aria-hidden="true">${hat.icon}</span>
            <span class="mr-duty-hat-text">${escapeHtml(hat.label)}</span>
          </span>
          <select class="mr-duty-hat-select" data-duty-hat-id="${escapeHtml(hat.id)}" aria-label="${escapeHtml(hat.label)}">
            <option value="">未指定</option>
            ${optionsHtml}
          </select>
        </label>
      `;
    }).join('');
    return `
      <section class="mr-duty-hats" aria-label="临时职责帽">
        <div class="mr-duty-hats-head">
          <span>临时职责帽</span>
          <span class="mr-duty-hats-count">${assignedCount}/${dutyHats.length}</span>
        </div>
        <div class="mr-duty-hat-list">${rows}</div>
        <div class="mr-duty-hat-actions">
          <button type="button" class="mr-duty-hat-action primary" data-duty-hat-insert="1" ${assignedCount ? '' : 'disabled'}>更新分工</button>
          <button type="button" class="mr-duty-hat-action" data-duty-hat-clear="1" ${assignedCount ? '' : 'disabled'}>清空</button>
        </div>
        <div class="mr-duty-hat-hint">选择后自动同步到输入框，发送前可编辑。</div>
      </section>
    `;
  }

  function _buildDutyHatPrompt(meeting) {
    if (!meeting) return '';
    const dutyHats = _getDutyHats(meeting);
    const assignments = _getDutyHatAssignments(meeting);
    const slotsBySid = {};
    for (const slot of _getGcSlots(meeting).filter(Boolean)) {
      slotsBySid[slot.sid] = slot;
    }
    const selected = dutyHats
      .map(hat => ({ hat, slot: slotsBySid[assignments[hat.id]] }))
      .filter(item => item.slot);
    if (selected.length === 0) return '';

    const summary = selected
      .map(({ hat, slot }) => `${_memberMentionLabel(slot)}=${hat.short}`)
      .join('；');
    const lines = [
      _DUTY_HAT_PROMPT_MARKER,
      `【本轮完整分工：${summary}】`,
      '所有成员都能看到完整分工；请只按自己的职责发言，不重复他人观点。涉及数字必须说明来源和时间点；无法核验请明确标注“未核验”。',
      '',
    ];
    for (const { hat, slot } of selected) {
      lines.push(`- ${_memberMentionLabel(slot)}：${hat.label}。${hat.duty}`);
      lines.push(`  输出格式：${hat.format}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  function _replaceDutyHatPromptInText(text, prompt) {
    const current = String(text || '').trim();
    const blockRe = new RegExp(`${_DUTY_HAT_PROMPT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?(?=\\n\\n(?!- )|$)`, 'm');
    if (!prompt) return current.replace(blockRe, '').trim();
    if (blockRe.test(current)) return current.replace(blockRe, prompt.trim()).trim();
    return current ? `${prompt.trim()}\n\n${current}` : prompt.trim();
  }

  function _setMeetingInputText(meetingId, text) {
    const input = document.getElementById('mr-input-box');
    if (!input) return;
    input.textContent = text || '';
    _setInputDraft(meetingId, text || '');
    _updateInputPreflight(meetingData[meetingId]);
    input.focus();
    _placeCaretAtEnd(input);
  }

  function _syncDutyHatPromptToInput(meeting) {
    if (!meeting || !meeting.id) return;
    const prompt = _buildDutyHatPrompt(meeting);
    const input = document.getElementById('mr-input-box');
    const currentText = input ? (input.innerText || '') : '';
    const nextText = _replaceDutyHatPromptInText(currentText, prompt);
    _setMeetingInputText(meeting.id, nextText);
  }

  // 轻量英雄（方案 B）：每个投研群聊、每位 AI 的下一轮一次性选择。
  // 只保存 hero id，不把任意 Prompt 文本从 renderer 传给主进程。
  const _heroCatalog = _listHeroes();
  const _heroAssignmentsByMeeting = {};
  let _heroPromptPreviewCleanup = null;

  function _isHeroDockEligible(meeting) {
    return !!(meeting && meeting.groupChat && meeting.scene === 'research');
  }

  function _getHeroAssignments(meeting) {
    if (!meeting || !meeting.id) return {};
    if (!_heroAssignmentsByMeeting[meeting.id]) _heroAssignmentsByMeeting[meeting.id] = {};
    return _heroAssignmentsByMeeting[meeting.id];
  }

  function _snapshotHeroAssignments(meeting) {
    if (!_isHeroDockEligible(meeting)) return {};
    const validSids = _getGcSlots(meeting).filter(Boolean).map(slot => slot.sid);
    return _normalizeHeroAssignments(_getHeroAssignments(meeting), validSids);
  }

  function _clearHeroAssignments(meeting) {
    if (!meeting || !meeting.id) return;
    delete _heroAssignmentsByMeeting[meeting.id];
    if (meeting.id === activeMeetingId) _renderHeroDock(meetingData[meeting.id] || meeting);
  }

  function _restoreHeroAssignments(meeting, snapshot) {
    if (!meeting || !meeting.id) return;
    const validSids = _getGcSlots(meeting).filter(Boolean).map(slot => slot.sid);
    const restored = _normalizeHeroAssignments(snapshot, validSids);
    if (Object.keys(restored).length) _heroAssignmentsByMeeting[meeting.id] = restored;
    else delete _heroAssignmentsByMeeting[meeting.id];
    if (meeting.id === activeMeetingId) _renderHeroDock(meetingData[meeting.id] || meeting);
  }

  function _heroSlotLabel(slot) {
    if (!slot) return 'AI';
    return slot.displayLabel || slot.label || slot.kind || `AI ${Number(slot.slotIndex || 0) + 1}`;
  }

  function _ensureHeroDock() {
    const inputRow = document.getElementById('mr-input-row');
    if (!inputRow || !inputRow.parentNode) return null;
    // 固定顺序：作战面板 → 英雄编队条 → 输入框。
    _ensureInputPreflightRow();
    let dock = document.getElementById('mr-hero-dock');
    if (!dock) {
      dock = document.createElement('section');
      dock.id = 'mr-hero-dock';
      dock.className = 'mr-hero-dock';
      dock.setAttribute('aria-label', '下一轮英雄');
      inputRow.parentNode.insertBefore(dock, inputRow);
      dock.addEventListener('change', (ev) => {
        const select = ev.target && ev.target.closest ? ev.target.closest('[data-hero-sid]') : null;
        if (!select || !dock.contains(select)) return;
        const meeting = activeMeetingId ? meetingData[activeMeetingId] : null;
        if (!_isHeroDockEligible(meeting)) return;
        const sid = select.getAttribute('data-hero-sid') || '';
        const heroId = select.value || '';
        const assignments = _getHeroAssignments(meeting);
        if (sid && _getHero(heroId)) assignments[sid] = heroId;
        else if (sid) delete assignments[sid];
        _renderHeroDock(meeting);
        _updateInputPreflight(meeting);
      });
      dock.addEventListener('click', (ev) => {
        const previewBtn = ev.target && ev.target.closest ? ev.target.closest('[data-hero-preview]') : null;
        if (!previewBtn || !dock.contains(previewBtn) || previewBtn.disabled) return;
        const meeting = activeMeetingId ? meetingData[activeMeetingId] : null;
        if (meeting) _showHeroPromptPreview(meeting);
      });
    }
    return dock;
  }

  function _renderHeroDock(meeting) {
    const dock = _ensureHeroDock();
    if (!dock) return;
    if (!_isHeroDockEligible(meeting)) {
      dock.style.display = 'none';
      dock.innerHTML = '';
      return;
    }
    const slots = _getGcSlots(meeting).filter(Boolean);
    const assignments = _snapshotHeroAssignments(meeting);
    const assignedCount = Object.keys(assignments).length;
    const optionHtml = _heroCatalog.map(hero =>
      `<option value="${escapeHtml(hero.id)}">${escapeHtml(hero.label)}</option>`
    ).join('');
    const slotHtml = slots.map(slot => {
      const heroId = assignments[slot.sid] || '';
      const selectedHero = _getHero(heroId);
      return `
        <label class="mr-hero-slot ${selectedHero ? 'assigned' : ''}" title="${selectedHero ? escapeHtml(selectedHero.subtitle) : '本轮不注入英雄 Prompt'}">
          <span class="mr-hero-slot-name">${escapeHtml(_heroSlotLabel(slot))}</span>
          <select class="mr-hero-select" data-hero-sid="${escapeHtml(slot.sid)}" aria-label="为 ${escapeHtml(_heroSlotLabel(slot))} 选择下一轮英雄">
            <option value="">不使用英雄</option>
            ${optionHtml}
          </select>
        </label>
      `;
    }).join('');
    dock.style.display = '';
    dock.innerHTML = `
      <div class="mr-hero-dock-title" title="英雄 Prompt 仅下一轮有效，并覆盖用户画像、默认投资倾向和职责帽等业务偏好">
        <span class="mr-hero-dock-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3.8l2.3 4.7 5.2.8-3.8 3.7.9 5.2L12 15.8 7.4 18.2l.9-5.2-3.8-3.7 5.2-.8L12 3.8z"/></svg></span>
        <span class="mr-hero-dock-heading">下一轮英雄</span>
        <span class="mr-hero-dock-meta">${assignedCount ? `${assignedCount} 位 · 业务偏好最高优先级` : '发送后自动清空'}</span>
      </div>
      <div class="mr-hero-slots">${slotHtml}</div>
      <button type="button" class="mr-hero-preview-btn" data-hero-preview="1" ${assignedCount ? '' : 'disabled'}>查看注入</button>
    `;
    dock.querySelectorAll('[data-hero-sid]').forEach(select => {
      select.value = assignments[select.getAttribute('data-hero-sid')] || '';
    });
  }

  function _buildHeroPromptPreview(meeting) {
    const assignments = _snapshotHeroAssignments(meeting);
    const slotsBySid = {};
    for (const slot of _getGcSlots(meeting).filter(Boolean)) slotsBySid[slot.sid] = slot;
    const sections = Object.entries(assignments).map(([sid, heroId]) => {
      const hero = _getHero(heroId);
      const slot = slotsBySid[sid];
      if (!hero || !slot) return '';
      return `# ${_heroSlotLabel(slot)} → ${hero.label}\n\n${_buildHeroPromptBlock(heroId)}`;
    }).filter(Boolean);
    return sections.join('\n\n---\n\n');
  }

  function _showHeroPromptPreview(meeting) {
    if (_heroPromptPreviewCleanup) _heroPromptPreviewCleanup();
    const prompt = _buildHeroPromptPreview(meeting);
    if (!prompt) return;
    const overlay = document.createElement('div');
    overlay.className = 'mr-gc-prompt-modal-overlay mr-hero-prompt-modal-overlay';
    overlay.innerHTML = `
      <div class="mr-gc-prompt-modal" role="dialog" aria-modal="true" aria-labelledby="mr-hero-preview-title">
        <div class="mr-gc-prompt-modal-head">
          <span class="mr-gc-prompt-modal-title" id="mr-hero-preview-title">下一轮英雄 Prompt 预览</span>
          <span class="mr-gc-prompt-modal-act">仅下一轮</span>
          <span class="mr-gc-prompt-modal-spacer"></span>
          <button type="button" class="mr-gc-prompt-modal-copy" title="复制 Prompt 原文">复制</button>
          <button type="button" class="mr-gc-prompt-modal-close" title="关闭 (Esc)" aria-label="关闭">×</button>
        </div>
        <div class="mr-gc-prompt-modal-body"><div class="mr-gc-md">${_renderMarkdown(prompt)}</div></div>
        <div class="mr-gc-prompt-modal-foot">按 AI 独立注入 · 业务偏好层最高优先级 · 发送后自动清空</div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => {
      document.removeEventListener('keydown', onKeydown);
      try { overlay.remove(); } catch {}
      if (_heroPromptPreviewCleanup === close) _heroPromptPreviewCleanup = null;
    };
    const onKeydown = (ev) => { if (ev.key === 'Escape') close(); };
    overlay.querySelector('.mr-gc-prompt-modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
    overlay.querySelector('.mr-gc-prompt-modal-copy').addEventListener('click', async (ev) => {
      try {
        await navigator.clipboard.writeText(prompt);
        ev.currentTarget.textContent = '已复制';
      } catch {
        ev.currentTarget.textContent = '复制失败';
      }
    });
    document.addEventListener('keydown', onKeydown);
    _heroPromptPreviewCleanup = close;
    overlay.querySelector('.mr-gc-prompt-modal-close').focus();
  }

  // T1（2026-05-04 道雪）：抽出单 slot 卡片渲染，让 partial-update IPC handler
  //   能复用同一份模板做局部 patch（不再 panel.innerHTML 全量替换）。
  //   依赖：函数参数（slotIndex, ctx）+ ctx 字段 { state, currentMode, partialBy, meeting,
  //         slots, lastTurn, meetingId, focused }；
  //         IIFE 私有 helper / 全局：_avatarBySlot, _avatarFallbackBySlot, _gcRegisterCard,
  //         isSlotParticipatingThisTurn, _ftCtxClass, _formatThinkTime, _formatTokens, _ftHtml,
  //         _thinkStartTs, _cliReadyCache, _tabState, sessions,
  //         _KIND_LABELS, modelShort, modelClass。
  // 返回：{ html, anyThinking }（anyThinking 由调用方累加，不再 mutate 闭包变量）
  // 无回答终态（2026-07-29 道雪 · 群聊运行中可操作）：这些状态一律不再算"进行中"，
  //   气泡/卡片不得继续显示「思考中」「正在发言」。'interrupted' 是用户点「停止本轮」
  //   后的终态（可能带已生成的半截文本）。集中成一个判定，避免各处硬编码列表漏掉新状态
  //   ——历史上「永久思考中」卡死正是漏判造成的。
  //   'cli_not_ready'（2026-07-29 B3）：勾选了但该成员的 CLI 60s 内没就绪，prompt 一个字
  //   都没写进 PTY。它同样是"本轮不会有回答"的终态 —— 必须算 settle，否则气泡永远闪
  //   「思考中」等一个根本没被问过的 AI。
  const _GC_SETTLED_NO_ANSWER = new Set(['errored', 'absent', 'superseded', 'interrupted', 'cli_not_ready']);
  function _isGcSettledStatus(status) {
    return _GC_SETTLED_NO_ANSWER.has(status);
  }

  // ==========================================================================
  // 群聊 ⇄ 子 session 卡片复用桥（2026-07-29 道雪）
  //
  // 用户原话："我们每个 session 都有自己的卡片视图，我为什么不能直接复用各自 session
  // 的卡片视图，来作为 AI 群聊的视图……相当于 AI 群聊就是把 3 个 AI 各自的卡片视图卡片
  // 搬到了群聊里。"
  //
  // 之前群聊维护了一整套平行渲染（_renderMarkdown 气泡 + _renderPreviewBlocks 预览块），
  // 结果是：streaming 期只认 partial.text，而 partial.text 在"思考 + 连续工具调用"阶段
  // 恒为空 —— 子 session 卡片里明明有 thinking 块和工具 chip，群聊却只显示「思考中…」
  // 空壳。这不是数据没有，是群聊自己没渲染。
  //
  // 现在：群聊只负责"外壳"（轮次分组 / 成员归属 / 群聊专属状态），气泡正文交给
  // renderer/turn-card-renderer.js 的 mountSessionTurnCard —— 与点进子 session 看到的
  // 是同一个渲染器、同一张卡片结构（thinking <details> / 工具簇 / markdown 正文 /
  // 代码高亮 / meta pills）。
  //
  // 隔离约定（避免与单会话面板串台）：
  //   - skipTurnRegistry:true       不写 win._sessionTurns（renderer.js 切会话会 clear 它）
  //   - skipStreamingIndicator:true 不碰 #msg-overlay 的 streaming spinner
  //   - .ta-btn 全局处理器本就有 `card.closest('.msg-overlay')` 守卫，群聊卡片够不着；
  //     卡片自带的操作条由 CSS 隐藏，群聊用外壳自己的 复制/📥prompt/↻重新提取。
  // ==========================================================================

  // 挂载点 → 待挂载 turn 的暂存表。HTML 字符串生成阶段写入，紧随其后的 hydrate 阶段读取，
  //   两者同步相邻，不存在跨帧失效问题。hydrate 会把消费掉的条目删除，所以稳态下这张表
  //   是空的 —— 别让它变成"每条历史消息的 turn 对象"的常驻副本。
  const _gcCardTurns = new Map();
  // 本轮 live blocks 快照：key = `${meetingId}|${turnNum}|${sid}`。
  //   partial-update 每次都写；等这一轮 settle 成正式 message 之后，_partialBy 会被清掉，
  //   但用户刚看过的 thinking / 工具调用不该凭空消失 —— 正式气泡继续从这里取回。
  //   只活在 renderer 内存里（Hub 重启后回退到纯文本卡片），不落盘、不污染 state.json。
  const _gcLiveBlocks = new Map();
  const _GC_LIVE_BLOCKS_MAX = 400;

  function _gcBlocksKey(meetingId, turnNum, sid) {
    return `${meetingId}|${turnNum || 0}|${sid}`;
  }
  function _rememberGcBlocks(meetingId, turnNum, sid, blocks) {
    if (!meetingId || !sid || !Array.isArray(blocks) || blocks.length === 0) return;
    if (_gcLiveBlocks.size >= _GC_LIVE_BLOCKS_MAX) {
      // 简单 FIFO 淘汰，别让长会话把内存吃穿
      const oldest = _gcLiveBlocks.keys().next();
      if (!oldest.done) _gcLiveBlocks.delete(oldest.value);
    }
    _gcLiveBlocks.set(_gcBlocksKey(meetingId, turnNum, sid), blocks);
  }
  function _recallGcBlocks(meetingId, turnNum, sid) {
    return _gcLiveBlocks.get(_gcBlocksKey(meetingId, turnNum, sid)) || null;
  }

  // transcript-tap 的 block 数组 → turn-card-renderer 认识的 turn 对象。
  //   block 形状来自 core/transcript-tap.js（{type:'thinking'|'text'|'tool_use'}），
  //   turn 形状对齐 core/claude-transcript-parser.js 的产出（renderTurnCard 的入参契约）。
  // 工具调用上限：turn-card 的工具簇是可折叠 <details>，N 个工具只占 1 行摘要，
  //   所以不再需要旧 _renderPreviewBlocks 的 8 个硬上限（那是因为它一个工具一个
  //   inline chip、会把卡片撑爆）。这里只留一个防 DOM 膨胀的宽松上限：超长 agentic
  //   轮（几十上百次工具调用）× 每 1.5s 心跳重渲，无上限会拖慢渲染。保留最近的。
  const _GC_TURN_TOOL_CAP = 50;

  function _gcTurnFromBlocks(opts) {
    const { id, kind, model, text, blocks, ts, tsEnd } = opts || {};
    const thinkingParts = [];
    let toolCalls = [];
    const textParts = [];
    for (const b of (Array.isArray(blocks) ? blocks : [])) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'thinking' && b.text) thinkingParts.push(String(b.text));
      else if (b.type === 'tool_use' && b.name) toolCalls.push({ name: b.name, input: b.input || {} });
      else if (b.type === 'text' && b.text) textParts.push(String(b.text));
    }
    if (toolCalls.length > _GC_TURN_TOOL_CAP) toolCalls = toolCalls.slice(-_GC_TURN_TOOL_CAP);
    // blocks 里的 text 是权威（结构化、无 PTY 噪音）；没有 blocks 才退回 partial.text /
    //   持久化 message.content。
    const body = textParts.length > 0 ? textParts.join('') : String(text || '');
    const turn = {
      id: String(id || ''),
      role: 'assistant',
      text: body,
      ts: ts || Date.now(),
      toolCalls,
    };
    if (kind) turn.kind = kind;
    if (model) turn.model = model;
    if (thinkingParts.length > 0) turn.thinking = thinkingParts.join('\n\n---\n\n');
    if (tsEnd) turn.tsEnd = tsEnd;
    return turn;
  }

  // 群聊气泡里的卡片挂载点。cardKey 只是 _gcCardTurns 的取数键，不参与 DOM 语义。
  function _gcCardHostHtml(cardKey, sid, extraCls = '') {
    return `<div class="mr-gc-card-host${extraCls ? ' ' + extraCls : ''}"`
      + ` data-gc-card-key="${escapeHtml(cardKey)}" data-gc-card-sid="${escapeHtml(sid || '')}"></div>`;
  }

  // 登记一张待挂载卡片，返回挂载点 HTML。turn 为空（无任何内容）时返回 '' 让调用方走占位分支。
  function _gcRegisterCard(cardKey, sid, turn, extraCls) {
    if (!turn || (!turn.text && !turn.thinking && !(turn.toolCalls && turn.toolCalls.length))) return '';
    _gcCardTurns.set(cardKey, { sid, turn });
    return _gcCardHostHtml(cardKey, sid, extraCls);
  }

  // hydrate：把登记好的 turn 真正挂进 DOM。每次 panel.innerHTML 重绘后必须调用。
  //   root 可传整个 panel（全量重渲）或单个 article（partial-update 局部 patch）。
  function _hydrateGroupChatCards(root) {
    if (!root) return 0;
    const mount = (typeof window !== 'undefined') && window._mountSessionTurnCard;
    const hosts = root.querySelectorAll
      ? root.querySelectorAll('.mr-gc-card-host[data-gc-card-key]')
      : [];
    let n = 0;
    hosts.forEach((host) => {
      const key = host.getAttribute('data-gc-card-key');
      const entry = key ? _gcCardTurns.get(key) : null;
      if (!entry) return;
      _gcCardTurns.delete(key);   // 消费即释放，见 _gcCardTurns 声明处
      if (typeof mount !== 'function') {
        // turn-card-renderer 没加载（理论上不会发生：renderer.js 早于 meeting-room.js 加载）。
        //   静默留空会让用户看到空气泡，故退回纯文本，宁可难看也不能吞内容。
        host.textContent = entry.turn.text || '';
        host.classList.add('mr-gc-card-fallback');
        return;
      }
      try {
        const el = mount(entry.sid, entry.turn, {
          container: host,
          kind: entry.turn.kind,
          skipTurnRegistry: true,
          skipStreamingIndicator: true,
        });
        if (el) n++;
      } catch (e) {
        console.warn('[groupchat] mountSessionTurnCard failed:', e);
        host.textContent = entry.turn.text || '';
        host.classList.add('mr-gc-card-fallback');
      }
    });
    return n;
  }

  function _renderSlotCard(slotIndex, ctx) {
    const { state, currentMode, partialBy, meeting, slots, lastTurn, meetingId, focused } = ctx;
    const slot = slots[slotIndex];
    if (!slot) return { html: '', anyThinking: false };
    const kind = slot.kind;
    const sub = { sid: slot.sid, label: slot.label };
    const partial = partialBy ? partialBy[sub.sid] : null;
    const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sub.sid) : null;
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
      } else if (partial.status === 'superseded') {
        status = 'superseded';
        preview = '';
      } else if (partial.status === 'interrupted') {
        // 用户点了「停止本轮」：保留已生成的半截文本，但明确是终态、不再"思考中"。
        status = 'interrupted';
        preview = partial.text || '';
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
      // 本轮真正被 dispatch 的 sid 集合（串行工作流每步只发子集）；未设置则 fallback participants
      const activeSids = _gcActiveSids[meetingId];
      const isActiveThisTurn = activeSids
        ? activeSids.has(sub.sid)
        : isSlotParticipatingThisTurn(meeting, slotIndex);
      if (!isActiveThisTurn) {
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
      } else if (lastStatus === 'superseded') {
        status = 'superseded';
      } else if (lastStatus === 'interrupted') {
        status = 'interrupted';
        preview = lastTurn.by[sub.sid] || '';
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
      superseded: '已被新问题覆盖',
      soft_alert: '等待中…',
      send_stuck: '⚠ 输入卡顿，请点 📤 发送',
      errored: '错误',
      interrupted: '已中断',
      transport_lost: '连接断开',
      cli_not_ready: '⚠ CLI 未就绪，本轮未发出',
    }[statusForLabel] || statusForLabel;
    const tabState = _tabState[sub.sid] || 'idle';
    const newBadge = tabState === 'new-output' && !isActive ? '<span class="mr-ft-new">NEW</span>' : '';

    const blocksFromPartial = (partial && Array.isArray(partial.blocks) && partial.blocks.length > 0)
      ? partial.blocks : null;
    const textFromPartial = (partial && typeof partial.text === 'string' && partial.text)
      ? partial.text : null;
    const textFromHistory = (!partial && lastTurn && lastTurn.by && lastTurn.by[sub.sid])
      ? lastTurn.by[sub.sid] : null;

    // === 2026-07-29 道雪 · 卡片视图正文同样复用该成员 session 的 turn 卡片 ===
    //   历史 blocks 快照兜底：settle 后 _partialBy 清空，但用户刚看过的 thinking /
    //   工具调用不该消失（无回答终态除外，那些轮的语义就是"没有回答"）。
    const blocksForCard = blocksFromPartial
      || (_isGcSettledStatus(status) ? null : _recallGcBlocks(meetingId, state && state.currentTurn, sub.sid));
    const cardTurn = _gcTurnFromBlocks({
      id: `gcft-${meetingId}-${sub.sid}`,
      kind,
      model: modelName || undefined,
      text: textFromPartial || textFromHistory || '',
      blocks: blocksForCard,
    });
    const cardHost = _gcRegisterCard(`ft|${meetingId}|${sub.sid}`, sub.sid, cardTurn);

    let bottomHtml = '';
    if (cardHost) {
      // 有任何真实内容（thinking / 工具调用 / 正文）→ 挂真卡片。
      //   这条分支同时覆盖 thinking / streaming / completed / interrupted：
      //   旧实现里 thinking 只给一根进度条、streaming 没 text 就退回
      //   「💭 思考中 … 详情请点击左侧子 session 查看」—— 那句话本身就是在承认
      //   群聊显示不了子 session 能显示的东西。现在它们是同一张卡片。
      const liveCls = (status === 'streaming' || status === 'thinking') ? ' streaming' : '';
      const cursor = liveCls ? '<span class="mr-ft-cursor"></span>' : '';
      bottomHtml = `<div class="mr-ft-preview mr-ft-preview-md${liveCls}">${cardHost}${cursor}</div>`;
      if (liveCls && !_thinkStartTs[meetingId]) _thinkStartTs[meetingId] = Date.now();
    } else if (status === 'thinking') {
      // 真的还什么都没产出（prompt 刚发出去）→ 进度条是诚实的
      if (!_thinkStartTs[meetingId]) _thinkStartTs[meetingId] = Date.now();
      bottomHtml = `<div class="mr-ft-progress"><div class="mr-ft-progress-bar slot-${slotIndex + 1}"></div></div>`;
    } else if (status === 'streaming') {
      if (!_thinkStartTs[meetingId]) _thinkStartTs[meetingId] = Date.now();
      const elapsedSec = _thinkStartTs[meetingId]
        ? Math.round((Date.now() - _thinkStartTs[meetingId]) / 1000) : 0;
      const liveLen = (partial && typeof partial.cleanBufLen === 'number') ? partial.cleanBufLen : 0;
      const lenTxt = liveLen > 0 ? ` · 已输出约 ${liveLen} 字` : '';
      const inner = `<div class="mr-ft-thinking-placeholder">💭 思考中 ${_formatThinkTime(elapsedSec)}${lenTxt}</div>`;
      bottomHtml = `<div class="mr-ft-preview streaming mr-ft-preview-md">${inner}<span class="mr-ft-cursor"></span></div>`;
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
    //   实现限制: 不点击跳转(避免 _openGcTimeline 加 initialTurnN); chip hover tooltip
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
      slotIndex, sendStuck, lineageHtml, !!meeting.groupChat
    );
    return { html, anyThinking };
  }

  function _renderFusedTabs(state, subs, currentMode, partialBy, meeting) {
    const meetingId = meeting && meeting.id;
    // Phase 5(2026-05-05 道雪): 时光机模式 — viewingTurnN 设置则将 ctx 切换到该历史轮快照,
    //   _renderSlotCard 内部 "已完成轮 → 显示 lastTurn.by[sid]" 分支(line 723-735)直接复用,
    //   纯前端切换。partialBy 设为 null + currentMode 设为 'idle' 避免触发 thinking/streaming 分支。
    const viewN = _gcViewingTurnN[meetingId];
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
    const slots = _getGcSlots(meeting);
    const ctx = {
      state, currentMode: effectiveCurrentMode, partialBy: effectivePartialBy,
      meeting, slots, lastTurn: effectiveLastTurn, meetingId, focused,
      isTimeTravel,
    };
    for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
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
    const slots = _getGcSlots(meeting);
    const focused = (Array.isArray(meeting.subSessions) && meeting.subSessions.includes(meeting.focusedSub))
      ? meeting.focusedSub
      : meeting.subSessions[0];
    const items = [];
    for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
      const slot = slots[slotIndex];
      if (!slot || !slot.sid) continue;
      const slotCls = `slot-${slotIndex + 1}`;
      const active = slot.sid === focused;
      const label = slot.label || getKindLabel(slot.kind) || `AI ${slotIndex + 1}`;
      const kind = slot.kind ? getKindLabel(slot.kind) : '';
      items.push(`<button type="button" class="mr-card-view-tab ${slotCls}${active ? ' active' : ''}" data-gc-card-tab-sid="${escapeHtml(slot.sid)}" title="${escapeHtml(kind || label)}">
        <span class="mr-card-view-tab-dot"></span>
        <span class="mr-card-view-tab-label">${escapeHtml(label)}</span>
      </button>`);
    }
    if (!items.length) return '';
    return `<div class="mr-card-view-tabs" role="tablist" aria-label="AI cards">${items.join('')}</div>`;
  }

  function _ftHtml(kind, isActive, sid, name, statusLabel, statusCls, modelName, modelCls, ctxPct, ctxCls, bottomHtml,
                   thinkCurrent, thinkTotal, tokensCurrent, tokensTotal, newBadge, slotIndex, sendStuck, lineageHtml, isGroupChat) {
    // AI 群聊主题色按 slot 上色（slot 1/2/3 = 皮卡丘/小火龙/杰尼龟），与 kind 解耦：
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
    // T6（2026-05-03）：send-stuck 数据驱动，refreshGroupChatPanel 重渲后保留
    if (sendStuck) cls.push('send-stuck');

    const modelBadge = modelName ? `<span class="mr-ft-model ${slotCls}">${escapeHtml(modelName)}</span>` : '';
    const ctxBadge = ctxPct !== null ? `<span class="mr-ft-ctx ${ctxCls}">Ctx ${ctxPct}%</span>` : '';

    // AI 群聊卡片头像与 slot 位置绑定（不与 kind 绑定）。
    //   slot 1 永远皮卡丘，slot 2 永远小火龙，slot 3 永远杰尼龟，便于用户视觉识别
    //   "哪一格是哪家"。CSS 主题色亦按 slot 上色（见 .mr-ft.slot-N），kind 仅作 data-attribute。
    const avatarSrc = isGroupChat ? `assets/ai-logos/${kind}.svg` : _avatarBySlot(slotIdx);
    const avatarFb = _avatarFallbackBySlot(slotIdx);
    const avatarHtml = avatarSrc
      ? `<div class="mr-ft-avatar"><img src="${avatarSrc}" alt="${kind || 'slot' + (slotIdx + 1)}" onerror="this.parentNode.textContent='${avatarFb}'; this.parentNode.style.cssText+=';display:flex;align-items:center;justify-content:center;font-size:30px;'"></div>`
      : `<div class="mr-ft-avatar" style="display:flex;align-items:center;justify-content:center;font-size:30px;">${avatarFb}</div>`;

    // Stage 2 容错升级：角标（绝对定位卡片右上角）—— 区分手动提取 / 缺席态
    let cornerBadge = '';
    if (statusCls === 'manual_extracted') cornerBadge = '<span class="mr-ft-corner-badge manual">手动</span>';
    else if (statusCls === 'absent') cornerBadge = '<span class="mr-ft-corner-badge absent">缺席</span>';
    else if (statusCls === 'superseded') cornerBadge = '<span class="mr-ft-corner-badge absent">已覆盖</span>';
    else if (statusCls === 'interrupted') cornerBadge = '<span class="mr-ft-corner-badge absent">已中断</span>';

    // 2026-05-02 修订：逃生按钮**永久常驻**（用户血泪反馈：按钮"莫名其妙消失"
    //   再次发生）。无论卡片状态（idle/completed/thinking/error/...），两大按钮始终
    //   显示，给用户随时可用的兜底口：
    //     [一键提取]    — 任何状态都能从 transcript 直读拼接
    //     [跳过]        — 任何状态都能跳过本轮 / 暂停后续期待
    //   仅 [🔄 重新拉起] 保持仅终态显示（idle 没什么可拉起的，会让用户困惑）。
    //   截断提示链接（.mr-truncated-hint）仍可触发 enter-shell 切到子 session 主区。
    const isTerminalErrorState = statusCls === 'errored' || statusCls === 'absent';
    const relaunchBtn = isTerminalErrorState
      ? `<button class="mr-ft-escape-btn" data-gc-escape="resend" data-gc-sid="${sid}" data-gc-kind="${kind}" title="重新拉起该家：重发本轮 prompt">🔄 重新拉起</button>`
      : '';
    const escapeBar = `
      <div class="mr-ft-escape-bar">
        <button class="mr-ft-escape-btn" data-gc-escape="extract" data-gc-sid="${sid}" data-gc-kind="${kind}" title="从 transcript 直读拼接（卡死时绕过完成检测）">一键提取</button>
        <button class="mr-ft-escape-btn" data-gc-escape="skip" data-gc-sid="${sid}" data-gc-kind="${kind}" title="本轮跳过这家，下游 prompt 不引用">跳过</button>
        <button class="mr-ft-escape-btn" data-gc-escape="resend-prompt" data-gc-sid="${sid}" data-gc-kind="${kind}" title="重发本轮 prompt 给该家（自动判定输入框是否已含 prompt）">📤 发送</button>
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
        <button data-gc-action="copy" data-gc-sid="${sid}" title="复制本卡内容">📋</button>
        <button data-gc-action="mention" data-gc-sid="${sid}" data-gc-kind="${kind}" title="在输入框插入 @ 该家">@</button>
        <button data-gc-action="quote" data-gc-sid="${sid}" title="引用本卡内容入下一轮(Phase 3)">&ldquo;</button>
      </div>`;

    return `<div class="${cls.join(' ')}" data-ft-sid="${sid}" data-ft-kind="${kind}">
      <button class="mr-ft-expand" data-ft-expand-sid="${sid}" data-ft-expand-kind="${kind}" title="展开详细回答">↗</button>${cornerBadge}
      ${hoverActionsHtml}
      <div class="mr-ft-head">
        ${avatarHtml}
        <div class="mr-ft-info">
          <div class="mr-ft-row1${row1TimeoutCls}">
            <span class="mr-ft-name ${slotCls}">${escapeHtml(name)}</span>
            <span class="mr-ft-status ${statusCls}${sendStuck ? ' send-stuck' : ''}">${statusLabel}</span>${newBadge}
            ${timeStat}
          </div>
          <div class="mr-ft-row2">${modelBadge}${ctxBadge}${tokenStat}</div>
          ${lineageHtml || ''}
        </div>
      </div>
      <div class="mr-ft-bottom">${bottomHtml}${escapeBar}</div>
    </div>`;
  }

  // Phase 5(2026-05-05 道雪): stepper 升级为 progress track mini-map + N/N 当前轮指示。
  //   旧版: 装饰性 dot, 不可交互, 数据来源轻; 底部独立"历史轮次 (N)"按钮折叠列表。
  //   新版: 每轮一个可 click/hover 的 dot(progress track 风, A 方案), mode 配色,
  //         当前轮蓝光圈放大, 末尾 "N/N" 数字直白显示进度。
  //         数据 attr (data-turn-n / data-turn-mode) 支持 click/hover 时光机切换。
  //         旧历史列表已被 mini-map 完全替代。
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
      const cls = `mr-gc-step-dot ${escapeHtml(t.mode)}${isCurrent ? ' current' : ''}`;
      return `<span class="${cls}" data-turn-n="${t.n}" data-turn-mode="${escapeHtml(t.mode)}" title="第 ${t.n} 轮 · ${escapeHtml(t.mode)}"></span>`;
    }).join('');
    // active(进行中)轮的 placeholder dot
    const activeDot = isActive
      ? `<span class="mr-gc-step-dot ${escapeHtml(currentMode)} active${activeTurnN === viewN ? ' current' : ''}" data-turn-n="${activeTurnN}" data-turn-active="1" title="第 ${activeTurnN} 轮 · ${escapeHtml(currentMode)} (进行中)"></span>`
      : '';
    // N/N 进度数字 — 时光机模式时显示 "viewN/totalDisplay" 蓝色, 默认显示 "current/total" 灰色
    const totalDisplay = isActive ? activeTurnN : totalTurns;
    const isViewingHistory = (typeof viewingTurnN === 'number' && viewingTurnN < activeTurnN);
    const counter = `<span class="mr-gc-step-counter${isViewingHistory ? ' viewing' : ''}">${viewN}/${totalDisplay}</span>`;
    return `<span class="mr-gc-stepper" id="mr-gc-stepper">${dots}${activeDot}${counter}</span>`;
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
      <div class="mr-gc-userq" data-mode="${bannerMode}">
        <span class="mr-gc-userq-label">💬 你的提问</span>
        <span class="mr-gc-userq-text">${escapeHtml(userInput)}</span>
        <span class="mr-gc-userq-tag">第 ${turnNum} 轮 · ${escapeHtml(turnLabel)}</span>
        <button class="mr-gc-userq-toggle" data-action="userq-toggle" title="展开/折叠全文" aria-label="展开/折叠全文">▾</button>
      </div>
    `;
  }

  function _turnStatusLabel(status) {
    return {
      idle: '待命',
      queued: '待发言',
      off: '未选',
      thinking: '思考中',
      streaming: '输出中',
      completed: '已答',
      manual_extracted: '已同步',
      absent: '缺席',
      superseded: '已被新问题覆盖',
      errored: '错误',
      timeout: '超时',
      soft_alert: '等待中',
      send_stuck: '输入卡住',
      interrupted: '已中断',
      transport_lost: '连接断开',
      cli_not_ready: 'CLI 未就绪 · 未发出',
    }[status] || status || '待命';
  }

  function _slotTurnStatus(state, meeting, slot, viewingTurnN) {
    const partialBy = state && state._partialBy ? state._partialBy : {};
    const partial = partialBy[slot.sid] || null;
    const turns = (state && Array.isArray(state.turns)) ? state.turns : [];
    const currentMode = (state && state.currentMode) || 'idle';
    const lastTurn = (typeof viewingTurnN === 'number' && turns[viewingTurnN - 1])
      ? turns[viewingTurnN - 1]
      : turns[turns.length - 1];
    const allIndexes = _getGcSlots(meeting).map((s, i) => s ? i : null).filter(i => i !== null);
    const selectedSet = new Set(Array.isArray(meeting.participants) ? meeting.participants : allIndexes);
    const activeSids = _gcActiveSids[meeting.id];
    const isActiveThisTurn = activeSids
      ? activeSids.has(slot.sid)
      : selectedSet.has(slot.slotIndex);

    let status = selectedSet.has(slot.slotIndex) ? 'idle' : 'off';
    if (currentMode && currentMode !== 'idle') {
      if (partial) {
        status = partial.sendStatus === 'stuck' ? 'send_stuck' : (partial.status || 'thinking');
      } else {
        status = isActiveThisTurn ? 'thinking' : 'off';
      }
    } else if (lastTurn) {
      const byStatus = lastTurn.byStatus || {};
      if (byStatus[slot.sid]) status = byStatus[slot.sid];
      else if (lastTurn.by && lastTurn.by[slot.sid]) status = 'completed';
    }
    return {
      status,
      label: _turnStatusLabel(status),
      selected: selectedSet.has(slot.slotIndex),
      text: (partial && partial.text) || (lastTurn && lastTurn.by && lastTurn.by[slot.sid]) || '',
    };
  }

  function _turnStatusBucket(status) {
    if (status === 'completed' || status === 'manual_extracted') return 'done';
    if (status === 'thinking' || status === 'streaming' || status === 'soft_alert' || status === 'queued') return 'running';
    // cli_not_ready 归 warn：勾了却没发出去，是需要用户注意的异常，不是"正常缺席"。
    if (status === 'errored' || status === 'timeout' || status === 'send_stuck' || status === 'transport_lost' || status === 'cli_not_ready') return 'warn';
    if (status === 'off' || status === 'absent' || status === 'superseded' || status === 'interrupted') return 'muted';
    return 'idle';
  }

  function _renderTurnProgressLane(state, meeting, viewingTurnN) {
    if (!meeting || !meeting.groupChat) return '';
    const slots = _getGcSlots(meeting).filter(Boolean);
    if (!slots.length) return '';
    const currentMode = (state && state.currentMode) || 'idle';
    const items = slots.map(slot => {
      const st = _slotTurnStatus(state, meeting, slot, viewingTurnN);
      const bucket = _turnStatusBucket(st.status);
      const label = slot.displayLabel || slot.label || slot.kind || `AI ${slot.slotIndex + 1}`;
      const actionHtml = (bucket === 'warn' || st.status === 'absent')
        ? `<span class="mr-turn-lane-actions">
            <button type="button" data-gc-escape="extract" data-gc-sid="${escapeHtml(slot.sid)}" data-gc-kind="${escapeHtml(slot.kind)}">提取</button>
            <button type="button" data-gc-escape="skip" data-gc-sid="${escapeHtml(slot.sid)}" data-gc-kind="${escapeHtml(slot.kind)}">跳过</button>
          </span>`
        : '';
      return `<div class="mr-turn-lane-item is-${bucket}" data-turn-lane-sid="${escapeHtml(slot.sid)}">
        <img src="${_groupLogoSrc(slot.kind)}" alt="${escapeHtml(label)}" />
        <span class="mr-turn-lane-main">
          <span class="mr-turn-lane-name">${escapeHtml(label)}</span>
          <span class="mr-turn-lane-meta">@m${slot.slotIndex + 1} · ${escapeHtml(st.label)}</span>
        </span>
        ${actionHtml}
      </div>`;
    }).join('');
    const expectedSidSet = new Set(_expectedParticipantSids(meeting));
    const expectedSlots = slots.filter(slot => expectedSidSet.has(slot.sid));
    const done = expectedSlots.filter(slot => {
      const status = _slotTurnStatus(state, meeting, slot, viewingTurnN).status;
      return status === 'completed' || status === 'manual_extracted'
        || status === 'absent' || status === 'superseded' || status === 'interrupted'
        || status === 'cli_not_ready';   // 未发出也是本轮的确定结局，计入分子否则永远差一个
    }).length;
    const summary = currentMode && currentMode !== 'idle'
      ? `本轮 ${done}/${expectedSlots.length}`
      : `最近 ${done}/${expectedSlots.length}`;
    return `<section class="mr-turn-lane" aria-label="本轮成员进度">
      <div class="mr-turn-lane-head">
        <strong>本轮进度</strong>
        <span>${escapeHtml(summary)}</span>
      </div>
      <div class="mr-turn-lane-grid">${items}</div>
    </section>`;
  }

  function _renderNextActionBar(state, meeting, viewingTurnN) {
    if (!meeting || !meeting.groupChat) return '';
    const turns = (state && Array.isArray(state.turns)) ? state.turns : [];
    const currentMode = (state && state.currentMode) || 'idle';
    const isHistory = typeof viewingTurnN === 'number' && viewingTurnN >= 1 && viewingTurnN < turns.length;
    if (!turns.length || currentMode !== 'idle' || isHistory) return '';
    const last = turns[turns.length - 1] || {};
    const label = last.mode === 'debate' ? '辩论' : (last.mode === 'summary' ? '综合' : '提问');
    return `<section class="mr-next-actions" aria-label="下一步动作">
      <span class="mr-next-actions-label">第 ${escapeHtml(last.n || turns.length)} 轮 ${escapeHtml(label)} 已结束</span>
      <!-- 2026-07-20 道雪：找回 codex 批改动——删除五个低频操作按钮（综合共识/互相挑错/生成交接/引用焦点卡/复制本轮）。
           03:00 工作区覆盖曾把删除回退；本次仅摘除按钮，点击委托与 _handleNextAction 保留备用。 -->
    </section>`;
  }

  function _renderCardRoster(state, meeting, viewingTurnN) {
    if (!meeting || !meeting.groupChat) return '';
    const slots = _getGcSlots(meeting).filter(Boolean);
    if (!slots.length) return '';
    const selected = new Set(Array.isArray(meeting.participants) ? meeting.participants : slots.map(slot => slot.slotIndex));
    const rows = slots.map(slot => {
      const label = slot.displayLabel || slot.label || slot.kind || `AI ${slot.slotIndex + 1}`;
      const sess = (typeof sessions !== 'undefined' && sessions) ? sessions.get(slot.sid) : null;
      const model = sess && sess.currentModel ? (typeof modelShort === 'function' ? modelShort(sess.currentModel) : sess.currentModel.displayName || sess.currentModel.id || '') : '';
      const ctxPct = sess && typeof sess.contextPct === 'number' ? sess.contextPct : null;
      const ctxCls = ctxPct == null ? 'unknown' : _ftCtxClass(ctxPct);
      const st = _slotTurnStatus(state, meeting, slot, viewingTurnN);
      return `<button type="button" class="mr-card-roster-member ${selected.has(slot.slotIndex) ? 'selected' : ''}" data-gc-member-idx="${slot.slotIndex}">
        <img src="${_groupLogoSrc(slot.kind)}" alt="${escapeHtml(label)}" />
        <span class="mr-card-roster-main">
          <span class="mr-card-roster-name">${escapeHtml(label)}</span>
          <span class="mr-card-roster-meta">@m${slot.slotIndex + 1}${model ? ` · ${escapeHtml(model)}` : ''}</span>
        </span>
        <span class="mr-card-roster-side">
          <span class="mr-card-roster-status is-${_turnStatusBucket(st.status)}">${escapeHtml(st.label)}</span>
          <span class="mr-card-roster-ctx ${ctxCls}">${ctxPct == null ? 'Ctx --' : `Ctx ${ctxPct}%`}</span>
        </span>
      </button>`;
    }).join('');
    return `<section class="mr-card-roster" aria-label="群聊成员">
      <div class="mr-card-roster-head">
        <strong>成员 roster</strong>
        <span>${selected.size}/${slots.length} 已选 · 点击成员切换发言</span>
      </div>
      <div class="mr-card-roster-grid">${rows}</div>
    </section>`;
  }

  function _renderMobileWorkbench(meeting) {
    if (!meeting || !meeting.groupChat) return '';
    const slots = _getGcSlots(meeting).filter(Boolean);
    const selected = Array.isArray(meeting.participants) ? meeting.participants.length : slots.length;
    return `<nav class="mr-mobile-workbench" aria-label="群聊移动工作台">
      <button type="button" data-gc-mobile-open="members">成员 ${selected}/${slots.length}</button>
      <button type="button" data-gc-mobile-open="history">历史</button>
      <button type="button" data-gc-mobile-open="editor">展开输入</button>
      <button type="button" data-gc-mobile-open="toggle-view">切视图</button>
    </nav>`;
  }

  function _appendPromptTemplate(meeting, text) {
    if (!meeting || !meeting.id) return;
    const input = document.getElementById('mr-input-box');
    const cur = input ? (input.innerText || input.textContent || '').trim() : '';
    _setMeetingInputText(meeting.id, cur ? `${cur}\n\n${text}` : text);
  }

  function _handleNextAction(action, meeting) {
    const state = meeting && _gcPanelState[meeting.id];
    const turns = state && Array.isArray(state.turns) ? state.turns : [];
    const last = turns[turns.length - 1] || null;
    if (action === 'synthesize') {
      _appendPromptTemplate(meeting, '请综合上一轮所有成员观点，输出：共识、分歧、建议下一步。');
      return;
    }
    if (action === 'challenge') {
      _appendPromptTemplate(meeting, '请针对上一轮结论互相挑错：每位成员只指出一个最关键风险，并说明证据。');
      return;
    }
    if (action === 'handoff') {
      _appendPromptTemplate(meeting, '请把上一轮讨论整理成 A2A 交接单：What / Why / Tradeoff / Open Questions / Next Action。');
      return;
    }
    if (action === 'quote-latest' && last && last.by) {
      const focused = meeting.focusedSub;
      const slots = _getGcSlots(meeting).filter(Boolean);
      const target = slots.find(slot => slot.sid === focused && last.by[slot.sid]) || slots.find(slot => last.by[slot.sid]);
      if (target) _addQuoteChip(meeting, target.sid, last.by[target.sid]);
    }
    // 2026-06-28 道雪 [改进4]：复制本轮全部回答（markdown：## 成员名 + 内容）
    if (action === 'copy-round' && last && last.by) {
      const slots = _getGcSlots(meeting).filter(Boolean);
      const parts = [];
      for (const slot of slots) {
        const c = last.by[slot.sid];
        if (c) {
          const name = slot.displayLabel || slot.label || slot.kind || ('AI ' + (slot.slotIndex + 1));
          parts.push('## ' + name + '\n\n' + (typeof c === 'string' ? c : (c && c.text) || ''));
        }
      }
      if (parts.length && typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(parts.join('\n\n---\n\n'));
        try { _showGcEscapeNotice('已复制本轮 ' + parts.length + ' 家回答到剪贴板', 'info'); } catch {}
      }
    }
  }

  function _handleMobileWorkbench(action, meeting) {
    if (action === 'members') {
      const roster = document.querySelector('.mr-card-roster, .mr-gc-side');
      if (roster && roster.scrollIntoView) roster.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }
    if (action === 'history') {
      const btn = document.getElementById('mr-input-history-btn');
      if (btn) btn.click();
      return;
    }
    if (action === 'editor') {
      _openLongInputEditor(meeting);
      return;
    }
    if (action === 'toggle-view') {
      _setGroupViewMode(_getGroupViewMode() === 'chat' ? 'card' : 'chat', meeting);
      renderHeader(meeting);
    }
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
  const _SETTLED_STATUSES = new Set(['completed', 'manual_extracted', 'absent', 'errored', 'interrupted', 'superseded', 'cli_not_ready']);
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

  // 2026-06-21 道雪：判断某群聊/投研会议「本轮仍在进行且未全员结束」。
  //   与推进解锁同口径：currentMode 活跃 且 未 _allParticipantsSettled 即视为忙碌。
  //   用于发送 guard——本轮没跑完时拦截再次提问（普通群聊无超时，卡死的 AI 会让后端
  //   串行队列无限期挂起、用户第二问凭空消失）。
  function _isGroupTurnBusy(meeting) {
    if (!meeting || !_isPanelCapableMeeting(meeting)) return false;
    const st = _gcPanelState[meeting.id];
    if (!st) return false;
    const mode = st.currentMode;
    if (!mode || mode === 'idle') return false;
    const expected = Array.isArray(meeting.subSessions) ? meeting.subSessions : [];
    if (expected.length === 0) return false;
    return !_allParticipantsSettled(st._partialBy, expected);
  }

  // 2026-07-29 道雪 [群聊运行中可操作]：本轮是否还在跑 —— 决定「⏹ 停止本轮」入口的显隐。
  //   与 _isGroupTurnBusy 的区别：这里只看 currentMode，不要求"还有人没结算"。全员刚
  //   settle、后端还在落盘的窗口里用户依然可能想叫停，而下发 ESC 本身是幂等的。
  //   注意：**不用它做发送拦截**。运行中追加提问是明确支持的能力（后端抢占式结算），
  //   这个函数只负责给出"停止"入口，绝不能再退回到"运行中禁止发送"。
  function _isGroupTurnRunning(meeting) {
    if (!meeting || !_isPanelCapableMeeting(meeting)) return false;
    const st = _gcPanelState[meeting.id];
    const mode = st && st.currentMode;
    return !!(mode && mode !== 'idle');
  }

  // 「停止本轮」：向本轮所有在跑成员下发中断（后端 = watcher 结算 interrupted + PTY 写 ESC），
  //   同时停掉可能在跑的串行/循环工作流。失败诚实报错，不假装已停。
  async function _handleGcStopTurn(meeting) {
    const m = (meeting && meetingData[meeting.id]) || meeting || meetingData[activeMeetingId];
    if (!m || !m.id) return;
    try {
      const r = await ipcRenderer.invoke('groupchat:interrupt', { meetingId: m.id });
      if (!r || r.ok === false) {
        _showGcEscapeNotice('停止本轮失败：' + ((r && r.reason) || '未知'), 'error');
        return;
      }
      const n = Array.isArray(r.stopped) ? r.stopped.length : 0;
      const loopTail = r.loopStopped ? '，工作流已一并停止' : '';
      _showGcEscapeNotice(n > 0
        ? `已停止本轮：${n} 位 AI 收到中断信号${loopTail}`
        : r.pendingDispatch
          ? `本轮正在发送中，已登记停止；发出后立即中断${loopTail}`
          : `本轮已经没有正在回答的 AI，状态已收回待命${loopTail}`);
    } catch (e) {
      _showGcEscapeNotice('停止本轮异常：' + (e && e.message ? e.message : String(e)), 'error');
    }
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
    const headText = labels.length > 0 ? `${cnNum}个 AI 已就绪` : 'AI 群聊已就位';
    const subText = labels.length > 0
      ? `${labels.join(' · ')} 等你抛话题`
      : '等你抛话题';

    // D1 Phase 4(2026-05-05 道雪): AI 群聊角色 PNG 头像 stack(与卡片头像一致)
    //   groupChat uses company logos instead of slot-bound Pokemon avatars.
    const slots = _getGcSlots(meeting);
    const avatarsHtml = sids.map((sid, idx) => {
      const slot = slots[idx] || {};
      const src = meeting && meeting.groupChat && slot.kind
        ? `assets/ai-logos/${slot.kind}.svg`
        : _avatarBySlot(idx);
      const fb = meeting && meeting.groupChat
        ? escapeHtml((slot.displayLabel || slot.kind || `AI ${idx + 1}`).slice(0, 2))
        : _avatarFallbackBySlot(idx);
      return src
        ? `<img src="${src}" class="mr-gc-ob-avatar${meeting && meeting.groupChat ? ' group' : ''}" alt="slot${idx+1}" onerror="this.outerHTML='<span class=\\'mr-gc-ob-avatar-fb\\'>${fb}</span>'" />`
        : `<span class="mr-gc-ob-avatar-fb">${fb}</span>`;
    }).join('');

    // D1 Phase 4: 三步引导卡片 — 群聊去掉固定辩论/总结轮次暗示。
    const stepsHtml = meeting && meeting.groupChat ? `
      <div class="mr-gc-ob-step">
        <div class="mr-gc-ob-step-num">1</div>
        <div class="mr-gc-ob-step-body">
          <div class="mr-gc-ob-step-title">提问</div>
          <div class="mr-gc-ob-step-desc">勾选成员，或用 @m1 / @all 指定发言人</div>
        </div>
      </div>
      <div class="mr-gc-ob-step">
        <div class="mr-gc-ob-step-num">2</div>
        <div class="mr-gc-ob-step-body">
          <div class="mr-gc-ob-step-title">争鸣</div>
          <div class="mr-gc-ob-step-desc">成员基于历史摘要与最近原文独立回答</div>
        </div>
      </div>
      <div class="mr-gc-ob-step">
        <div class="mr-gc-ob-step-num">3</div>
        <div class="mr-gc-ob-step-body">
          <div class="mr-gc-ob-step-title">追问</div>
          <div class="mr-gc-ob-step-desc">继续点名、改勾选，或按 raw anchor 核对原文</div>
        </div>
      </div>
    ` : `
      <div class="mr-gc-ob-step">
        <div class="mr-gc-ob-step-num">1</div>
        <div class="mr-gc-ob-step-body">
          <div class="mr-gc-ob-step-title">提问</div>
          <div class="mr-gc-ob-step-desc">输入框输入问题,${labels.length || 3} 个 AI 同时启动思考</div>
        </div>
      </div>
      <div class="mr-gc-ob-step">
        <div class="mr-gc-ob-step-num">2</div>
        <div class="mr-gc-ob-step-body">
          <div class="mr-gc-ob-step-title">交叉迭代</div>
          <div class="mr-gc-ob-step-desc">他们引用彼此观点, 多轮收敛核心论点</div>
        </div>
      </div>
      <div class="mr-gc-ob-step">
        <div class="mr-gc-ob-step-num">3</div>
        <div class="mr-gc-ob-step-body">
          <div class="mr-gc-ob-step-title">总结</div>
          <div class="mr-gc-ob-step-desc">点输入框左侧 📝 总结, 选一人输出交接单</div>
        </div>
      </div>
    `;

    // D1 v3 Phase 4(2026-05-05 道雪): head 改为占位 div, 由 _refreshOnboardingHead 动态填充。
    //   启动中(notReady>0) → 黄色启动文字, 全员 ready → 绿色"X 个 AI 已就绪"。
    //   sub 行(label list)隐藏不渲染(信息已在 head 内, 避免重复)。
    //   data-default-* 属性记录默认全员 ready 文案, 让 head refresh 函数能 fallback。
    return `<div class="mr-gc-onboarding">
      <div class="mr-gc-ob-avatars">${avatarsHtml}</div>
      <div class="mr-gc-ob-head" id="mr-gc-ob-head"
           data-default-text="${escapeHtml(headText)}"
           data-default-sub="${escapeHtml(subText)}"></div>
      <div class="mr-gc-ob-steps">${stepsHtml}</div>
    </div>`;
  }

  // H3 Phase 4(2026-05-05 道雪): 更新 mr-header 的 meta 文字 + 进度条。
  //   meta: "已 N 轮 · ⏱ 总耗时"; 进度条: 本轮已 settled 的 sid 数 / 总人数, 渐变填充。
  //   header 骨架由 renderHeader 一次性 mount, 这里只刷新 #mr-header-meta + #mr-header-progress 内容,
  //   不动其他 listener。每次 _renderGcPanelHtml 时同步调用一次。
  function _expectedParticipantSids(meeting) {
    const subSessions = meeting && Array.isArray(meeting.subSessions) ? meeting.subSessions : [];
    // 2026-07-20 道雪 [修#3c]：进度分母过滤休眠成员——勾选但休眠的 AI 本轮收不到 prompt，
    //   计入分母会让"本轮 2/3"永远等第三家。
    const awake = subSessions.filter(sid => {
      const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      return !(s && s.status === 'dormant');
    });
    const activeSids = meeting && _gcActiveSids[meeting.id];
    if (activeSids) return awake.filter(sid => activeSids.has(sid));
    if (!meeting || !Array.isArray(meeting.participants)) return awake;
    const selected = new Set(meeting.participants);
    const idxOf = new Map(subSessions.map((sid, i) => [sid, i]));
    return awake.filter(sid => selected.has(idxOf.get(sid)));
  }

  function _updateHeaderProgress(meeting, state, mode, totalSec) {
    const metaEl = document.getElementById('mr-header-meta');
    const progEl = document.getElementById('mr-header-progress');
    if (!metaEl && !progEl) return;
    const turnsCount = (state && Array.isArray(state.turns)) ? state.turns.length : 0;
    const totalSecTxt = totalSec > 0 ? _formatThinkTime(totalSec) : null;
    // 进度计算: 非 idle = 本轮 partialBy 中 settled 的数 / 期望家总数
    //          idle    = 0/N (无活跃轮, 进度条灰色 0%)
    const expectedSids = _expectedParticipantSids(meeting);
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

  function _groupMemberMap(meeting) {
    const map = {};
    for (const slot of _getGcSlots(meeting)) {
      if (!slot || !slot.sid) continue;
      map[slot.sid] = slot;
    }
    return map;
  }

  function _groupLogoSrc(kind) {
    return `assets/ai-logos/${escapeHtml(kind || 'claude')}.svg`;
  }

  function _formatGroupChatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  function _renderGroupAvatar(slot, isUser) {
    if (isUser) return '<div class="mr-gc-avatar mr-gc-avatar-user">我</div>';
    if (!slot) return '<div class="mr-gc-avatar mr-gc-avatar-fallback">AI</div>';
    const label = slot.displayLabel || slot.label || slot.kind || 'AI';
    return `<div class="mr-gc-avatar"><img src="${_groupLogoSrc(slot.kind)}" alt="${escapeHtml(label)}" /></div>`;
  }

  // 2026-07-12 道雪：watcher settle 的失败原因 → 用户能看懂的中文标签。
  //   原因来源：turn-completion-watcher 的 markErrored/markProcessExit（经
  //   orchestrator statusReason 持久化 / partial-update reason 实时透传）。
  function _gcFailReasonLabel(reason) {
    const r = String(reason || '').trim();
    if (!r) return '';
    if (r === 'auth_required') return '检测到登录失效横幅，可能需要 /login';
    if (r === 'cli_not_ready') return 'CLI 60 秒内未就绪，prompt 未写入终端';
    if (/^send_failed/i.test(r)) return '写入终端失败：' + r.replace(/^send_failed:\s*/i, '');
    if (/cli_self_exit/i.test(r)) return 'CLI 自行退出，PTY 回到宿主 shell';
    if (/pty exit/i.test(r)) return 'CLI 进程退出';
    if (/promise rejected/i.test(r)) return '内部等待异常';
    return r.length > 60 ? r.slice(0, 60) + '…' : r;
  }

  function _renderGroupChatMessage(message, meeting, memberBySid, opts = {}) {
    if (!message) return '';
    const isUser = message.role === 'user';
    const slot = isUser ? null : memberBySid[message.sid];
    const slotCls = slot ? ` slot-${(slot.slotIndex || 0) + 1}` : '';
    const label = isUser ? '我' : (message.speaker || (slot && slot.displayLabel) || 'AI');
    // 投委会发言（committeeAct）：幕次 badge + 气泡左侧色条标识（折叠交给通用「长回答折叠」，不重复做）
    const cAct = message.committeeAct || '';
    let actBadge = '';
    if (cAct) {
      let bl = (cAct === '辩论' && message.committeeRound) ? `辩论·第${message.committeeRound}轮` : cAct;
      if (message.committeeSub === '收口') bl += '·收口';
      actBadge = `<span class="mr-gc-act-badge">${escapeHtml(bl)}</span>`;
    }
    const committeeCls = cAct ? ' mr-gc-committee' : '';
    const time = _formatGroupChatTime(message.createdAt);
    const status = opts.status || message.status || '';
    // 2026-07-12 道雪：errored 优先于 pending —— 旧逻辑 pending 期 errored 会显示
    //   「正在发言」+失败占位文案并存（截图血泪：状态矛盾）。superseded/absent 也给明确标签。
    //   组件内统一防御：settle 态（errored/absent/superseded）一律不算 pending，
    //   不依赖调用方各自清 pending flag（多方审查加固）。
    const _isSettledStatus = _isGcSettledStatus(status);
    const isPending = !!opts.pending && !_isSettledStatus;
    const statusText = status === 'errored' ? '发送失败'
      : status === 'cli_not_ready' ? '本轮未发出'
      : isPending ? '正在发言'
      : status === 'superseded' ? '被新提问覆盖'
      : status === 'interrupted' ? '已被你停止'
      : status === 'absent' ? '已跳过'
      : '';
    const contentStr = String(message.content || '');
    const hasContent = !!contentStr.trim();
    // 2026-06-21 道雪：「同步」是 AI 卡住/没抓到回答时手动从 shell/transcript 补抓的逃生入口，
    //   对已 completed/manual_extracted 的回答无意义且误导用户以为"没同步成功"，故仅非成功态渲染。
    // 2026-07-12 收紧：成功态但内容为空（如 PTY 干净退出兜底 settle）仍要给同步入口。
    const _syncSettled = (status === 'completed' || status === 'manual_extracted') && hasContent;
    const syncAction = (!isUser && message.sid && !message.committeeAct && !_syncSettled)
      ? `<button type="button" class="mr-gc-sync-btn" data-gc-sync-answer="${escapeHtml(message.sid)}" data-gc-sync-turn="${escapeHtml(message.turnNum || '')}" title="从该 AI 的 shell/transcript 手动同步本轮回答">同步</button>`
      : '';
    // === 2026-07-29 道雪 · 群聊气泡正文 = 该成员 session 自己的 turn 卡片 ===
    //   优先级：live blocks（thinking / 工具调用 / 流式正文）> 本轮 blocks 快照 > 纯文本。
    //   关键点：partial.text 在"思考 + 连续工具调用"阶段恒为空，但 blocks 早就有内容了 ——
    //   旧实现只看 text，于是群聊卡在「思考中…」，而点进子 session 明明什么都能看到。
    //   无回答终态（absent/superseded/errored）不回捞历史 blocks：那些轮次的语义就是
    //   "没有被收录的回答"，占位文案要保持权威（opts.blocks 是调用方显式给的实时数据，仍尊重）。
    const _gcBlocks = (!isUser && message.sid)
      ? ((Array.isArray(opts.blocks) && opts.blocks.length > 0)
          ? opts.blocks
          : (_isSettledStatus ? null : _recallGcBlocks(meeting && meeting.id, message.turnNum, message.sid)))
      : null;
    let cardHostHtml = '';
    if (!isUser && message.sid) {
      const cardKey = `${(meeting && meeting.id) || 'm'}|${message.id || `${message.turnNum}-${message.sid}`}`;
      cardHostHtml = _gcRegisterCard(cardKey, message.sid, _gcTurnFromBlocks({
        id: `gccard-${cardKey}`,
        kind: slot && slot.kind,
        text: contentStr,
        blocks: _gcBlocks,
        ts: message.createdAt || undefined,
      }), isPending ? 'live' : '');
    }
    // 2026-07-12 道雪：空内容的非成功态消息不再渲染成"空气泡+裸图标排"（截图血泪），
    //   按 status 给占位文案 + 失败原因，让用户知道发生了什么、下一步点哪里。
    //   settle 态即使被调用方标了 empty 也不显示"思考中"——已经结束的轮不存在"思考中"。
    let body;
    if (cardHostHtml) {
      // 有真实内容（哪怕只有 thinking / 一个工具调用）→ 一律走真卡片，不再显示空壳占位。
      body = cardHostHtml;
    } else if (opts.empty && !_isSettledStatus) {
      body = '<span class="mr-gc-waiting">思考中...</span>';
    } else if (!isUser && !hasContent) {
      const reasonTxt = _gcFailReasonLabel(message.statusReason);
      const ph = status === 'errored'
        ? `本轮未收到回答${reasonTxt ? `（${reasonTxt}）` : ''}。PTY 可能已正常作答——点「同步」从 transcript 重新提取，或点「原文」核对。`
        : status === 'superseded' ? '本轮回答被下一轮提问覆盖，未收录。'
        : status === 'interrupted' ? '你已停止本轮，该 AI 未来得及输出内容。'
        : status === 'absent' ? '本轮已跳过该 AI，无回答。'
        // 2026-07-29 [B3]：勾了却没发出去的成员必须自己说明白，而不是整条气泡消失。
        : status === 'cli_not_ready' ? '该成员的 CLI 在 60 秒内没有就绪，本轮的提问没有发给它（一个字都没写进终端）。点进它的子 session 看看 CLI 卡在哪一步；就绪后重新提问即可。'
        : '本轮未提取到内容。点「同步」从 transcript 重新提取。';
      body = `<div class="mr-gc-md mr-gc-empty-placeholder">${escapeHtml(ph)}</div>`;
    } else {
      body = `<div class="mr-gc-md">${_renderMarkdown(contentStr)}</div>`;
    }
    // 2026-06-21 道雪：raw anchor 是内部原文索引，只对 AI 消息有意义（点开核对原文）；
    //   用户看自己刚发的提问不需要、且会暴露 raw://group/... 内部串，故仅 AI 消息渲染。
    // 2026-06-28 道雪：raw://group/... 串是内部噪音，缩成小图标按钮（hover title 仍显示完整索引，点击功能不变）。
    const anchor = (!isUser && message.anchor)
      ? `<button type="button" class="mr-gc-anchor" data-gc-anchor="${escapeHtml(message.anchor)}" title="原文索引：${escapeHtml(message.anchor)}">🔗 原文</button>`
      : '';
    const copyAction = `<button type="button" class="mr-gc-copy-btn" data-gc-copy-message="1" title="复制此条消息" aria-label="复制此条消息">📋</button>`;
    // [查看本轮 prompt] 通用群聊功能：仅 AI 气泡 + 有存档 prompt 时显示，点开弹窗看该 AI 实际收到的 prompt。
    const promptAction = (!isUser && message.sourcePrompt)
      ? `<button type="button" class="mr-gc-prompt-btn" data-gc-view-prompt="${escapeHtml(message.id || '')}" title="查看本轮发给该 AI 的 prompt" aria-label="查看本轮 prompt">📥</button>`
      : '';
    // 2026-06-28 道雪：每张 AI 气泡 hover 显示「重新提取」(↻) —— 本轮回答提取错/截断时，
    //   手动从该 AI 的 shell/transcript 重新同步。复用 data-gc-sync-answer 处理器
    //   (_handleGcManualSync)，传 turnNum 精确重抓该轮；pending/empty 态不显示（还没答完）。
    const resyncAction = (!isUser && message.sid && !message.committeeAct && !isPending && !(opts.empty && !_isSettledStatus))
      ? `<button type="button" class="mr-gc-resync-btn" data-gc-sync-answer="${escapeHtml(message.sid)}" data-gc-sync-turn="${escapeHtml(message.turnNum || '')}" title="提取错了？从该 AI 的 shell / transcript 重新同步本轮回答" aria-label="重新提取本轮回答">↻</button>`
      : '';
    // 2026-06-28 道雪 [改进3]：回答字数标签（仅 AI）；[改进5]：AI 名字按 kind 上品牌色（.ai-name-<kind>）
    const kindCls = (!isUser && slot && slot.kind) ? ` ai-name-${slot.kind}` : '';
    const wordChip = (!isUser && message.content) ? `<span class="mr-gc-wordcount">${message.content.length} 字</span>` : '';
    const meta = `<div class="mr-gc-meta"><span class="mr-gc-name${kindCls}">${escapeHtml(label)}</span>${actBadge}${time ? `<span>${escapeHtml(time)}</span>` : ''}${isUser && message.interruptedNote ? '<span class="mr-gc-interrupted-note" title="本轮进行中 Hub 重启，回答已被打断">已被重启打断</span>' : ''}${wordChip}${statusText ? `<span>${escapeHtml(statusText)}</span>` : ''}${syncAction}</div>`;
    // 2026-05-15 道雪 群聊弹顶 bug 修复：article 上加 data-gc-msg-id 作 partial-update
    //   局部 patch 的稳定 anchor。pending 区调用方传入 id='pending-${sid}'；真消息
    //   id 来自 orchestrator（u${n} / a${turnNum}-${sid}）。无 id 时 fallback 到空串
    //   不会阻断渲染。
    const anchorId = escapeHtml(message.id || '');
    // 2026-07-29 道雪：群聊专属状态（superseded / interrupted / absent / errored /
    //   send_stuck / soft_alert / transport_lost）由**外壳**表达，不塞进 turn-card-renderer
    //   ——那是通用 session 卡片渲染器，不该认识群聊调度语义。外壳画左侧状态色条 +
    //   右上角标，卡片本体只管内容。
    const statusCls = (!isUser && status) ? ` mr-gc-st-${escapeHtml(String(status))}` : '';
    const cardCls = cardHostHtml ? ' has-card' : '';
    return `
      <article class="mr-gc-msg ${isUser ? 'mine' : 'ai'}${slotCls}${committeeCls}${isPending ? ' pending' : ''}${statusCls}" data-gc-msg-id="${anchorId}"${!isUser && status ? ` data-gc-status="${escapeHtml(String(status))}"` : ''}>
        ${!isUser ? _renderGroupAvatar(slot, false) : ''}
        <div class="mr-gc-msg-body">
          ${meta}
          <div class="mr-gc-bubble-row">
            ${isUser ? copyAction : ''}
            <div class="mr-gc-bubble${cardCls}">${body}${isPending ? '<span class="mr-ft-cursor"></span>' : ''}</div>
            ${!isUser ? copyAction + promptAction + resyncAction : ''}
          </div>
          ${anchor}
        </div>
        ${isUser ? _renderGroupAvatar(null, true) : ''}
      </article>
    `;
  }

  function _renderGroupChatPending(state, meeting, memberBySid) {
    const partialBy = state && state._partialBy ? state._partialBy : {};
    const slots = _getGcSlots(meeting).filter(Boolean);
    const currentTurn = Number(state && state.currentTurn) || 0;
    const persistedSids = new Set((state && Array.isArray(state.messages) ? state.messages : [])
      .filter(m => m && m.role === 'assistant' && Number(m.turnNum) === currentTurn
        && (m.status === 'completed' || m.status === 'manual_extracted' || _isGcSettledStatus(m.status)))
      .map(m => m.sid));
    const parts = [];
    for (const slot of slots) {
      // 已持久化的进行中恢复结果会作为正式消息渲染；不要再叠一张“思考中”空气泡。
      if (persistedSids.has(slot.sid)) continue;
      const partial = partialBy[slot.sid];
      // 本轮真正被 dispatch 的 sid 集合（串行工作流每步只发子集）；未设置则 fallback participants。
      // 修复：之前对全员 participating 都显示 thinking 气泡，串行时只 1 个真动却全员"思考中"。
      const activeSids = _gcActiveSids[meeting.id];
      const participating = activeSids
        ? activeSids.has(slot.sid)
        : isSlotParticipatingThisTurn(meeting, slot.slotIndex);
      if (!partial && !participating) continue;
      const text = partial && partial.text ? partial.text : '';
      const status = partial && partial.status ? partial.status : (participating ? 'thinking' : 'idle');
      // 2026-07-29：blocks 也算"有内容"。thinking / 工具调用先到、text 后到是常态，
      //   只按 text 判空正是"永久思考中"空壳的根因。
      const blocks = (partial && Array.isArray(partial.blocks)) ? partial.blocks : null;
      const empty = !text && !(blocks && blocks.length > 0) && status !== 'errored';
      // 2026-07-12 道雪：errored/absent 等已 settle 态不再算 pending（旧逻辑显示
      //   「正在发言」+闪烁光标与失败并存）；errored 空文本交给占位文案统一解释，
      //   并带上 watcher 的失败原因。
      // 2026-07-29 道雪：'interrupted'（用户停止本轮）并入同一判定，防止中断后气泡
      //   继续闪光标停在"正在发言"。
      const settledPending = _isGcSettledStatus(status);
      parts.push(_renderGroupChatMessage({
        id: `pending-${slot.sid}`,
        role: 'assistant',
        sid: slot.sid,
        turnNum: state.currentTurn || '',
        speaker: slot.displayLabel || slot.label,
        content: text,
        status,
        statusReason: partial && partial.reason ? partial.reason : '',
      }, meeting, memberBySid, { pending: status !== 'completed' && status !== 'manual_extracted' && !settledPending, empty, status, blocks }));
    }
    return parts.join('');
  }

  function _renderGroupChatView(state, meeting, softBanner, totalSecTxt) {
    const messages = Array.isArray(state.messages) ? state.messages : [];
    const memberBySid = _groupMemberMap(meeting);
    const slots = _getGcSlots(meeting).filter(Boolean);
    const selected = new Set(Array.isArray(meeting.participants) ? meeting.participants : slots.map(slot => slot.slotIndex));
    const summaryCount = Array.isArray(state.summarySegments) ? state.summarySegments.length : 0;
    const rawCount = messages.length;
    const mode = state.currentMode || 'idle';
    const sideCollapsed = _getGroupSideCollapsed();
    const renderMessages = messages.slice();
    for (const pendingUser of _pendingUserMessages(meeting.id)) {
      const pendingConfirmed = messages.some(message =>
        message && message.role === 'user' && Number(message.turnNum) > pendingUser.afterTurn
      );
      if (!pendingConfirmed) {
        renderMessages.push({
          id: 'pending-user-' + pendingUser.clientId,
          role: 'user',
          turnNum: pendingUser.afterTurn + 1,
          content: pendingUser.content,
          createdAt: pendingUser.createdAt,
        });
      }
    }
    // 2026-06-28 道雪 [改进R2-2]：轮次分隔线——相邻消息 turnNum 变化时插「第 N 轮」分隔，长对话结构清晰。
    let _lastTurnSep = null;
    let _lastActSep = null;
    // [幕次折叠] 预扫描各幕消息数（折叠后分隔条显示「N 条已折叠」）；折叠状态存前端临时 Set，不持久化。
    const _actCounts = {};
    for (const _m of messages) {
      if (_m && _m.committeeAct) {
        const _k = `${_m.committeeAct}#${_m.committeeRound || ''}`;
        _actCounts[_k] = (_actCounts[_k] || 0) + 1;
      }
    }
    const _collapsedSet = _gcCollapsedActs[meeting.id] || (_gcCollapsedActs[meeting.id] = new Set());
    const messageHtml = renderMessages.map(m => {
      let sep = '';
      const actKey = (m && m.committeeAct) ? `${m.committeeAct}#${m.committeeRound || ''}` : null;
      if (actKey) {
        // 投委会发言：按幕次分隔（▶ 建库 / ▶ 辩论 · 第 N 轮 / ▶ 收敛）——分隔条可点击折叠本幕全部气泡。
        if (actKey !== _lastActSep) {
          _lastActSep = actKey;
          const lbl = (m.committeeAct === '辩论' && m.committeeRound) ? `辩论 · 第 ${m.committeeRound} 轮` : m.committeeAct;
          const collapsed = _collapsedSet.has(actKey);
          const cnt = _actCounts[actKey] || 0;
          sep = `<div class="mr-gc-act-sep${collapsed ? ' collapsed' : ''}" data-gc-act-toggle="${escapeHtml(actKey)}" role="button" tabindex="0" title="点击折叠/展开本幕发言"><span class="mr-gc-act-sep-icon">${collapsed ? '▶' : '▼'}</span><span class="mr-gc-act-sep-label">${escapeHtml(lbl)}</span>${collapsed && cnt ? `<span class="mr-gc-act-sep-count">${cnt} 条已折叠</span>` : ''}</div>`;
        }
      } else {
        const tn = m && m.turnNum;
        if (tn != null && tn !== _lastTurnSep) {
          _lastTurnSep = tn;
          sep = `<div class="mr-gc-turn-sep"><span>第 ${escapeHtml(String(tn))} 轮</span></div>`;
        }
      }
      // [幕次折叠] 该幕被折叠时只保留分隔条、隐藏本幕气泡本体。
      const hidden = !!(actKey && _collapsedSet.has(actKey));
      return sep + (hidden ? '' : _renderGroupChatMessage(m, meeting, memberBySid));
    }).join('');
    const pendingHtml = mode !== 'idle' ? _renderGroupChatPending(state, meeting, memberBySid) : '';
    const viewingTurnN = _gcViewingTurnN[meeting.id];
    const progressLane = _renderTurnProgressLane(state, meeting, viewingTurnN);
    const nextActions = _renderNextActionBar(state, meeting, viewingTurnN);
    const mobileWorkbench = _renderMobileWorkbench(meeting);

    const emptyHtml = (!messageHtml && !pendingHtml) ? `
      <div class="mr-gc-empty">
        <div class="mr-gc-empty-title">还没有群聊消息</div>
        <div class="mr-gc-empty-sub">直接提问会发给当前勾选成员；输入 @m1、@m2 或 @all 可以指定发言成员。</div>
      </div>
    ` : '';
    const dutyHatPanel = _renderDutyHatPanel(meeting, slots);
    const memberRows = slots.map((slot) => {
      const checked = selected.has(slot.slotIndex);
      const label = slot.displayLabel || slot.label || slot.kind || 'AI';
      const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(slot.sid) : null;
      const model = s && s.currentModel ? (typeof modelShort === 'function' ? modelShort(s.currentModel) : s.currentModel.displayName || '') : '';
      // 群成员行 ctx 占比统一来自各 CLI 状态栏 → session.contextPct。
      const ctxPct = s && typeof s.contextPct === 'number' ? s.contextPct : null;
      const ctxCls = ctxPct == null ? 'unknown' : _ftCtxClass(ctxPct);
      const ctxText = ctxPct == null ? 'Ctx --' : `Ctx ${ctxPct}%`;
      const ctxTitle = ctxPct == null ? '尚未从该 CLI 状态栏读取上下文占比' : `上下文已用 ${ctxPct}%`;
      const canRemove = slots.length > 1 && mode === 'idle';
      const removeTitle = slots.length <= 1
        ? '群聊至少保留一位成员'
        : mode !== 'idle' ? '本轮回答结束后可移除' : `移除 ${label}`;
      return `
        <div class="mr-gc-member-row">
          <button type="button" class="mr-gc-member ${checked ? 'selected' : ''}" data-gc-member-idx="${slot.slotIndex}">
            <span class="mr-gc-member-logo" aria-hidden="true"><img src="${_groupLogoSrc(slot.kind)}" alt="" /></span>
            <span class="mr-gc-member-main">
              <span class="mr-gc-member-name">${escapeHtml(label)}</span>
              <span class="mr-gc-member-meta">@m${slot.slotIndex + 1}${model ? ` · ${escapeHtml(model)}` : ''}</span>
            </span>
            <span class="mr-gc-member-side">
              <span class="mr-gc-member-ctx ${ctxCls}" title="${escapeHtml(ctxTitle)}">${escapeHtml(ctxText)}</span>
              <span class="mr-gc-member-check">${checked ? 'ON' : ''}</span>
            </span>
          </button>
          <button type="button" class="mr-gc-member-remove" data-gc-member-remove-sid="${escapeHtml(slot.sid)}"
                  title="${escapeHtml(removeTitle)}" aria-label="${escapeHtml(removeTitle)}" ${canRemove ? '' : 'disabled'}>移除</button>
        </div>
      `;
    }).join('');

    return `
      ${softBanner}
      <section class="mr-gc-shell ${sideCollapsed ? 'side-collapsed' : ''}" aria-label="AI 群聊">
        <main class="mr-gc-thread">
          <!-- 2026-06-28 道雪：群聊精简 — 删 topbar(标题/统计/卡片视图)、摘要提示条、本轮进度、内联操作按钮行。
               群成员按钮移到 header；操作按钮(综合共识等)移到作战面板；research 场景保留精简 topbar 只放投委会入口。 -->
          ${_getDutyHatScene(meeting) === 'research' ? `<div class="mr-gc-topbar"><div class="mr-gc-top-actions"><button type="button" class="mr-gc-card-link cm-open-btn" data-committee-open="1" title="开投委会：手输股票，自动跑五幕出双榜">⚖️ 开投委会</button><button type="button" class="mr-gc-card-link" data-committee-history="1" title="过往投委会：回看历史五幕发言+双榜+主席报告">📋 过往投委会</button><button type="button" class="mr-gc-card-link" data-committee-screener="1" title="技术初筛=独立趋势龙雷达，与投委会解耦">📊 技术初筛</button></div></div>` : ''}

          <div class="mr-gc-search-row"><input type="text" class="mr-gc-search" placeholder="🔍 搜索本群聊消息…" /><span class="mr-gc-search-count"></span></div>
          <div class="mr-gc-messages">
            ${emptyHtml}
            ${messageHtml}
            ${pendingHtml}
          </div>
          ${mobileWorkbench}
          <button type="button" class="mr-gc-scroll-bottom" data-gc-scroll-bottom="1" title="回到最新回答">↓ 最新</button>
          <button type="button" class="mr-gc-collapse-all" data-gc-collapse-all="1" title="折叠/展开所有长回答">⇕ 折叠全部</button>
        </main>
        <aside class="mr-gc-side" aria-label="群成员">
          <div class="mr-gc-side-head">
            <span>群成员</span>
            <span class="mr-gc-side-actions">
              <button type="button" class="mr-gc-side-add" data-gc-add-member="1" title="添加新的 AI 成员">+ 成员</button>
              <button type="button" class="mr-gc-side-collapse" data-gc-side-toggle="1" title="收起群成员">${selected.size}/${slots.length}</button>
            </span>
          </div>
          <div class="mr-gc-members">${memberRows}</div>
          ${dutyHatPanel}
          <div class="mr-gc-ledger">
            <div class="mr-gc-ledger-title">上下文</div>
            <div>摘要段：${summaryCount}</div>
            <div>原文索引：${rawCount}</div>
          </div>
        </aside>
      </section>
    `;
  }

  function _renderGcPanelHtml(state, meeting) {
    const subs = _getGcSubInfo(meeting);
    const mode = state.currentMode || 'idle';
    const partialBy = state._partialBy || null;
    const fusedTabs = _renderFusedTabs(state, subs, mode, partialBy, meeting);
    const cardViewTabs = _renderCardViewTabs(meeting);
    // 2026-05-05 道雪：标题统一为轮次视图(不区分 general/research/dev)。
    //   不动 _scenes.getScene().name —— 那个 name 同时给 covenant prompt header 用,改了会污染发给 AI 的 prompt。
    const titleText = meeting.groupChat ? 'AI 群聊' : 'AI 群聊轮次';
    const viewingTurnN = _gcViewingTurnN[meeting.id];
    const stepper = _renderTurnStepper(state.turns, mode, viewingTurnN);
    // Phase 5: 时光机 banner — 仅 viewingTurnN 设置时渲染
    const timeTravelBanner = (typeof viewingTurnN === 'number' && viewingTurnN >= 1)
      ? `<div class="mr-gc-timetravel-banner">
          <span class="mr-gc-tt-icon">⌛</span>
          <span class="mr-gc-tt-text">时光机模式 · 第 <b>${viewingTurnN}</b> 轮 · ${escapeHtml((state.turns[viewingTurnN - 1] && state.turns[viewingTurnN - 1].mode) || '')} (只读历史)</span>
          <button class="mr-gc-tt-exit" id="mr-gc-tt-exit" data-gc-tt-exit="1">回到最新 (Esc)</button>
        </div>`
      : '';

    // F5 Phase 3(2026-05-04 道雪 简化版): 仅整轮总耗时
    //   token + cost 因 transcript-tap 通路缺失暂不显示, 等后续扩展再启用。
    const slots = _getGcSlots(meeting);
    const aiStats = state.aiStats || {};
    let totalSec = 0;
    for (const slot of slots) {
      if (!slot || !slot.sid) continue;
      const stats = aiStats[slot.sid] || aiStats[slot.kind] || null;
      if (!stats) continue;
      totalSec += stats.totalThinkSec || 0;
    }
    const totalSecTxt = totalSec > 0 ? _formatThinkTime(totalSec) : '--';
    const costBarHtml = `<div class="mr-gc-cost-bar" title="本对话累计总耗时(三家相加)">
      <span class="mr-gc-cost-item"><span class="ico">⏱</span> 总耗时 <span class="num">${escapeHtml(totalSecTxt)}</span></span>
    </div>`;
    // FIX-E（2026-05-01）：cmdBar 推进按钮判定要按"期望家集合"，不是 partialBy 自身的 keys。
    // meeting-create-modal（2026-05-01）：期望家 = meeting.subSessions（按 slot 顺序），
    //   不再硬编码 ['claude','gemini','codex']——多 claude / DeepSeek+GLM 混搭的 AI 群聊也能正确判完成。
    const expectedSids = Array.isArray(meeting.subSessions) ? meeting.subSessions.slice() : [];
    // E3 修复 (2026-05-03)：删除 _renderCmdBar 调用 — panel 顶部按钮组与 toolbar 重复，
    //   toolbar 已覆盖所有功能，删 cmd-bar 单一来源。
    const onboarding = (state.turns.length === 0 && mode === 'idle') ? _renderOnboarding(meeting) : '';
    // Stage 2 容错升级：软提醒 banner 容器
    const softBanner = `<div id="mr-gc-soft-alert-banner" class="mr-gc-soft-alert-banner" style="display:none"></div>`;
    // pilot redesign（2026-05-02）：废弃 pilotRecaps 卡片 + 主驾占位容器（AI 群聊不再桥接子会话私聊）。
    // H3 Phase 4(2026-05-05 道雪): 同步刷新 header 进度条 + meta(每次 panel re-render)
    _updateHeaderProgress(meeting, state, mode, totalSec);
    // Phase 4 v2(2026-05-05): panel 重渲后 onboarding head 占位空, 异步 microtask 触发 _refreshSoftAlert 填充
    setTimeout(() => { try { _refreshSoftAlert(meeting); } catch {} }, 0);
    if (meeting.groupChat && _getGroupViewMode() === 'chat') {
      return _renderGroupChatView(state, meeting, softBanner, totalSecTxt);
    }
    // D1 v2(2026-05-05 道雪): 欢迎区从 fusedTabs 之后上移到 fusedTabs 之前,
    //   位置在 "AI 群聊" 标题正下方与 3 张 AI 卡片之间, 视觉权重更高 + 更早被注意到。
    // 2026-05-05 道雪: 用户提问 banner 紧贴 fusedTabs 之上 — 让"标题/stepper → 你的提问 → AI 答复"
    //   形成 Q→A 视觉流。空提问/空 turns 时 banner 自动 return '' 不渲染。
    const userQBanner = _renderUserQuestionBanner(state, meeting, viewingTurnN);
    const progressLane = _renderTurnProgressLane(state, meeting, viewingTurnN);
    const nextActions = _renderNextActionBar(state, meeting, viewingTurnN);
    const cardRoster = _renderCardRoster(state, meeting, viewingTurnN);
    const mobileWorkbench = _renderMobileWorkbench(meeting);
    return `
      <div class="mr-gc-track">
        <div class="mr-gc-track-row">
          <div class="mr-gc-track-title-grp">
            <span class="mr-gc-title">${titleText}</span>
            ${stepper}
          </div>
          ${costBarHtml}
        </div>
      </div>
      ${softBanner}
      ${timeTravelBanner}
      ${onboarding}
      ${userQBanner}
      ${cardRoster}
      <section class="mr-latest-round" aria-label="最新轮回答">
        <div class="mr-latest-round-head">
          <strong>最新轮回答</strong>
          <span>卡片优先展示当前焦点成员，历史轮次从上方进度点回看</span>
        </div>
        ${cardViewTabs}
        ${fusedTabs}
      </section>
      ${mobileWorkbench}
    `;
  }


  // 主渲染：从 IPC 拿最新 state 后重绘。
  // 乐观字段（currentMode）的保留条件：**只有 _gcOptimisticTurn[id] 还在**
  // —— 也就是 IPC 还在飞行中。IPC resolve 后 _gcOptimisticTurn 已被 clearOptimistic 清，
  // 此时 server state 真实状态（含 idle）才被采纳。
  // partialBy 单独保留：轮中单家完成 IPC 推 partial-update，这是轮内增量，独立处理。
  // 2026-05-05 道雪 修3：cache 与 DOM 解耦的设计原则
  //   旧实现：refreshGroupChatPanel 一手包办"拉 server state + merge cache + 写 DOM"，
  //     调用方必须保证 meeting 是当前 active 才能调，否则 DOM 会被错群聊内容覆盖。
  //     副作用：所有 IPC handler 都用 `meetingId !== activeMeetingId → return` 守卫，
  //     非 active AI 群聊的 cache 永远跟不上 server，切回时 partial 残留 → 卡片状态错乱。
  //   新设计：拆成两个函数 ——
  //     _syncGroupChatCacheFromServer(meeting): 纯 cache 同步，**任何 meeting 都安全调用**
  //       不动 DOM，IPC handler 在守卫之外也可调用
  //     refreshGroupChatPanel(meeting): cache sync + DOM 重渲，**仅 active meeting 调用**
  //       内含 activeMeetingId race guard（修2 内置）
  //   这样所有 AI 群聊的 cache 始终跟 server 同步，切换体验一致，杜绝残留。

  // 拉 server state + merge cache（含 optimistic 与 prev._partialBy 合并），写 _gcPanelState。
  // 不写 DOM 不调 _ensureGcPanel，任何 meeting 都能调。
  // 返回 { state, ok: bool }，ok=false 表示 server state 拉取失败或 meeting 不可 panel。
  async function _syncGroupChatCacheFromServer(meeting) {
    if (!_isPanelCapableMeeting(meeting)) return { state: null, ok: false };
    let state;
    try {
      state = await ipcRenderer.invoke('groupchat:get-state', { meetingId: meeting.id });
    } catch (e) {
      console.error('[groupchat] get-state failed:', e.message);
      return { state: null, ok: false };
    }
    if (!state) return { state: null, ok: false };
    const prev = _gcPanelState[meeting.id];
    const optimistic = _gcOptimisticTurn[meeting.id];
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
    _gcPanelState[meeting.id] = state;
    return { state, ok: true };
  }

  function _captureGroupChatScroll(panel, meeting) {
    if (!panel || !meeting || !meeting.groupChat || _getGroupViewMode() !== 'chat') return null;
    const el = panel.querySelector('.mr-gc-messages');
    if (!el) return null;
    const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
    const bottomGap = Math.max(0, maxTop - el.scrollTop);
    return {
      scrollTop: el.scrollTop,
      stickToBottom: bottomGap <= 48,
    };
  }

  function _restoreGroupChatScroll(panel, snapshot, opts = {}) {
    if (!panel || !snapshot) return;
    const forceBottom = !!opts.forceBottom;
    const apply = () => {
      const el = panel.querySelector('.mr-gc-messages');
      if (!el) return;
      const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
      el.scrollTop = (forceBottom || snapshot.stickToBottom) ? maxTop : Math.min(snapshot.scrollTop, maxTop);
    };
    apply();
    requestAnimationFrame(apply);
  }

  // 2026-05-15 道雪 群聊弹顶 bug 修复：partial-update 局部 patch
  //   旧路径：partial-update 在群聊视图下走"找不到 .mr-ft → panel.innerHTML 全量重渲"
  //     兜底，每次心跳都新建 .mr-gc-messages 容器 → scrollTop 重置 0 → 用户视觉"弹顶"。
  //   新路径：本函数按 data-gc-msg-id="pending-${sid}" 找已渲染的 pending article，
  //     用 partial 最新数据 outerHTML 替换该 article 本身；.mr-gc-messages 容器 +
  //     其他兄弟 article DOM 节点完全不动，scrollTop 自然保留。
  //   返回 true 表示 patch 成功；false 让调用方走 fallback（极少见，如 pending 区
  //     还未首次渲染、参与本轮的成员名单变化等）。
  //   stickToBottom 跟随：patch 前抓底距（bottomGap≤48），patch 后若在底就 scrollTo
  //     底部，保持"用户在底部 → 跟随新内容"的微信式体验；不在底部就完全不动。
  function _patchGroupChatPendingMessage(panel, meeting, sid, state) {
    if (!panel || !meeting || !meeting.groupChat || _getGroupViewMode() !== 'chat') return false;
    if (!sid || !state) return false;
    const partial = state._partialBy && state._partialBy[sid];
    if (!partial) return false;
    const messagesEl = panel.querySelector('.mr-gc-messages');
    if (!messagesEl) return false;
    const articleEl = messagesEl.querySelector(`.mr-gc-msg[data-gc-msg-id="pending-${CSS.escape(sid)}"]`);
    if (!articleEl) return false;
    const memberBySid = _groupMemberMap(meeting);
    const slot = memberBySid[sid];
    if (!slot) return false;
    const text = partial.text || '';
    const status = partial.status || 'thinking';
    // 2026-07-29：与 _renderGroupChatPending 同口径 —— blocks 有内容就不算 empty。
    const blocks = Array.isArray(partial.blocks) ? partial.blocks : null;
    const empty = !text && !(blocks && blocks.length > 0) && status !== 'errored';
    // 2026-07-12 道雪：与 _renderGroupChatPending 同步——settle 态不算 pending，
    //   errored 占位文案由 _renderGroupChatMessage 统一渲染并带失败原因。
    //   2026-07-29 起 'interrupted' 走同一判定（用户停止本轮后不得再显示"正在发言"）。
    const settledPending = _isGcSettledStatus(status);
    const newHtml = _renderGroupChatMessage({
      id: `pending-${sid}`,
      role: 'assistant',
      sid,
      turnNum: state.currentTurn || '',
      speaker: slot.displayLabel || slot.label,
      content: text,
      status,
      statusReason: partial.reason || '',
    }, meeting, memberBySid, { pending: status !== 'completed' && status !== 'manual_extracted' && !settledPending, empty, status, blocks });
    // 抓底距决定 patch 后是否跟随：bottomGap ≤ 48 视为"贴底"，patch 后 scrollTo 底
    const maxTop0 = Math.max(0, messagesEl.scrollHeight - messagesEl.clientHeight);
    const savedScrollTop = messagesEl.scrollTop;
    const stick = (maxTop0 - messagesEl.scrollTop) <= 48;
    // outerHTML 替换：article 内部无 listener（事件委托在 panel 层 _bindGcPanelEvents），
    //   替换不会留死引用。messagesEl 容器 + 其他兄弟 article 完全不动 → scrollTop 自然保留。
    articleEl.outerHTML = newHtml;
    // 2026-07-29：替换出来的新 article 里只有卡片挂载点，必须立刻 hydrate，
    //   否则局部 patch 路径（streaming 期最高频的那条）会渲染出空气泡。
    const patchedEl = messagesEl.querySelector(`.mr-gc-msg[data-gc-msg-id="pending-${CSS.escape(sid)}"]`);
    if (patchedEl) _hydrateGroupChatCards(patchedEl);
    if (stick) {
      requestAnimationFrame(() => {
        const after = panel.querySelector('.mr-gc-messages');
        if (after) after.scrollTop = Math.max(0, after.scrollHeight - after.clientHeight);
      });
    } else {
      const restore = () => {
        const after = panel.querySelector('.mr-gc-messages');
        if (!after) return;
        const maxTop = Math.max(0, after.scrollHeight - after.clientHeight);
        after.scrollTop = Math.min(savedScrollTop, maxTop);
      };
      restore();
      requestAnimationFrame(restore);
    }
    return true;
  }

  async function refreshGroupChatPanel(meeting, opts = {}) {
    if (!_isPanelCapableMeeting(meeting)) { _removeGcPanel(); return; }
    const expectedGroupViewMode = opts.expectedGroupViewMode || (meeting.groupChat ? _getGroupViewMode() : null);
    const { state, ok } = await _syncGroupChatCacheFromServer(meeting);
    if (!ok) return;
    // 修2：async race guard — await 期间用户切走，老 refresh 不写 DOM（避免 panel 被错群聊内容覆盖）
    if (meeting.id !== activeMeetingId) return;
    // 群聊"聊天/卡片"切换期间可能有上一轮 refresh 仍在飞行中。若它返回时视图模式
    // 已改变，直接丢弃，避免 header 已是新模式、panel 却被旧模式重写。
    if (meeting.groupChat && expectedGroupViewMode && _getGroupViewMode() !== expectedGroupViewMode) return;
    const panel = _ensureGcPanel();
    const forceGroupChatBottom = !!opts.forceGroupChatBottom && !!meeting.groupChat && _getGroupViewMode() === 'chat';
    const groupScroll = forceGroupChatBottom
      ? { scrollTop: 0, stickToBottom: true }
      : _captureGroupChatScroll(panel, meeting);
    _renderGcPanelInto(panel, meeting, state, {
      scroll: groupScroll,
      restoreOpts: { forceBottom: forceGroupChatBottom },
    });
    // 2026-06-28 道雪：nextActions(综合共识/互相挑错/生成交接/引用焦点卡)已移到作战面板，
    //   轮次状态随每次 refresh 变化，故同步刷新作战面板，让按钮在轮次结束时即时出现/消失。
    _updateInputPreflight(meeting);
  }

  // 2026-06-28 道雪 [改进R2-5]：群聊内消息搜索——实时过滤，匹配正常显示、不匹配淡化，显示计数 + 滚到首个匹配。
  function _setupGcSearch(panel) {
    if (!panel) return;
    const input = panel.querySelector('.mr-gc-search');
    const msgEl = panel.querySelector('.mr-gc-messages');
    if (!input || !msgEl || input.dataset.searchBound) return;
    input.dataset.searchBound = '1';
    input.addEventListener('input', () => {
      const kw = input.value.trim().toLowerCase();
      const msgs = msgEl.querySelectorAll('.mr-gc-msg');
      let hits = 0, first = null;
      msgs.forEach(m => {
        const md = m.querySelector('.mr-gc-md');
        const txt = ((md ? md.textContent : m.textContent) || '').toLowerCase();
        const hit = !kw || txt.indexOf(kw) >= 0;
        m.classList.toggle('mr-gc-search-dim', !!kw && !hit);
        if (kw && hit) { hits++; if (!first) first = m; }
      });
      const cnt = panel.querySelector('.mr-gc-search-count');
      if (cnt) cnt.textContent = kw ? (hits + ' 条匹配') : '';
      if (kw && first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  // 2026-06-28 道雪 [改进R2-1]：代码块一键复制——给 AI 回答 markdown 代码块加复制按钮 + 语言标签。
  function _enhanceCodeBlocks(panel) {
    if (!panel) return;
    panel.querySelectorAll('.mr-gc-md pre').forEach(pre => {
      if (pre.dataset.codeEnhanced) return;
      pre.dataset.codeEnhanced = '1';
      const code = pre.querySelector('code');
      const m = code && code.className && code.className.match(/language-([\w-]+)/);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mr-gc-code-copy';
      btn.setAttribute('data-gc-copy-code', '1');
      btn.textContent = m ? (m[1] + ' · 复制') : '复制';
      pre.appendChild(btn);
    });
  }

  // 2026-06-28 道雪 [改进2]：回到最新悬浮按钮——群聊滚离底部超 240px 时显示，点击回到最新。
  //   .mr-gc-messages 每次重渲都重绑 scroll（scroll 事件不冒泡，无法委托）。
  function _setupScrollToBottom(panel) {
    if (!panel) return;
    const el = panel.querySelector('.mr-gc-messages');
    const btn = panel.querySelector('.mr-gc-scroll-bottom');
    if (!el || !btn) return;
    const update = () => {
      const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
      btn.classList.toggle('visible', (maxTop - el.scrollTop) > 240);
    };
    if (el._scrollBtnHandler) el.removeEventListener('scroll', el._scrollBtnHandler);
    el._scrollBtnHandler = update;
    el.addEventListener('scroll', update, { passive: true });
    update();
  }

  // 2026-06-28 道雪 [改进1]：长回答折叠——超阈值高度的 AI 回答默认折叠 + 渐变遮罩 + 展开按钮，
  //   避免多家长回答纵向刷屏。展开按钮点击走 _handleGcPanelClick 的 data-gc-expand-bubble 分支。
  function _applyLongAnswerCollapse(panel) {
    if (!panel) return;
    const COLLAPSE_PX = 360;
    const bubbles = panel.querySelectorAll('.mr-gc-msg.ai:not(.pending) .mr-gc-bubble');
    bubbles.forEach(b => {
      if (b.dataset.collapseChecked) return;
      b.dataset.collapseChecked = '1';
      // 2026-07-29：正文已是真 turn 卡片时，折叠交给卡片自己的「▾ 展开全文」
      //   （turn-card-renderer 的 postProcessLongTextFold）——与子 session 里的行为完全一致。
      //   两套折叠叠在一起会出现"展开了还是被截断"的诡异体验。
      if (b.querySelector('.mr-gc-card-host')) return;
      if (b.scrollHeight > COLLAPSE_PX + 48) {
        b.classList.add('mr-gc-collapsible');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'mr-gc-expand-btn';
        btn.setAttribute('data-gc-expand-bubble', '1');
        btn.textContent = '展开全文 ▾';
        const row = b.closest('.mr-gc-bubble-row');
        if (row && row.parentElement) row.parentElement.insertBefore(btn, row.nextSibling);
        const art = b.closest('.mr-gc-msg');
        const mid = art && art.getAttribute('data-gc-msg-id');
        if (mid && _gcExpandedBubbles.has(activeMeetingId + '|' + mid)) {
          b.classList.add('mr-gc-expanded');
          btn.textContent = '收起 ▴';
        }
      }
    });
    // [改进R2-3]：有可折叠回答时才显示"折叠全部"悬浮按钮
    const collapseAllBtn = panel.querySelector('.mr-gc-collapse-all');
    if (collapseAllBtn) collapseAllBtn.classList.toggle('visible', panel.querySelectorAll('.mr-gc-bubble.mr-gc-collapsible').length > 0);
  }

  // 绑定 panel 内部所有交互（折叠 / 卡片点击）。每次 innerHTML 重绘后都要重新调用。
  // T2（2026-05-04 道雪）：单 slot 卡片的事件绑定独立成函数，让 partial-update 局部 patch 后只 rebind 单卡片。
  //   覆盖范围：① 卡片本体 click（focus session）② ↗ 展开按钮 ③ [data-gc-escape] 工具栏按钮组。
  //   不覆盖：soft-alert banner-close / mr-gc-ob-card（这些是 panel 级，由 _bindGcPanelEvents 管）。
  function _showGcEscapeNotice(message, level = 'warn') {
    const banner = document.getElementById('mr-gc-soft-alert-banner');
    if (!banner) return false;
    const cls = level === 'error' ? 'urgent' : 'warn';
    banner.className = `mr-gc-soft-alert-banner ${cls}`;
    banner.innerHTML = `
      <div class="mr-gc-soft-alert-msg">
        <strong>${escapeHtml(level === 'error' ? '操作失败' : '提示')}</strong>
        <span class="mr-gc-soft-alert-hint">${escapeHtml(message || '')}</span>
      </div>
      <button class="mr-gc-soft-alert-close" data-gc-banner-close="1" title="关闭提示">×</button>`;
    banner.style.display = 'flex';
    const close = banner.querySelector('[data-gc-banner-close]');
    if (close) close.addEventListener('click', () => { banner.style.display = 'none'; banner.innerHTML = ''; }, { once: true });
    return true;
  }

  function _bindSlotCardEvents(slotEl, meeting) {
    if (!slotEl) return;
    slotEl.__mrSlotMeeting = meeting || null;
  }

  function _eventTargetEl(target) {
    if (!target) return null;
    return target.nodeType === 1 ? target : target.parentElement;
  }

  function _closestInPanel(target, selector, panel) {
    const start = _eventTargetEl(target);
    const el = start && typeof start.closest === 'function' ? start.closest(selector) : null;
    return el && panel && panel.contains(el) ? el : null;
  }

  function _currentGcPanelMeeting(panel) {
    const meeting = panel && panel.__mrGcMeeting;
    return meeting && meeting.id ? (meetingData[meeting.id] || meeting) : meeting;
  }

  function _handleSlotCardClick(card, ev, meeting) {
    const sid = card.getAttribute('data-ft-sid');
    if (!sid) return;
    if (_isCardTabMode()) return;
    if (ev && (ev.ctrlKey || ev.metaKey)) {
      ev.stopPropagation();
      _toggleCompareSelect(sid);
      return;
    }
    if (_gcCompareSlots.size > 0) _clearCompareSelect();
    if (_gcFocusedCardSid) {
      if (_gcFocusedCardSid !== sid) {
        _gcFocusedCardSid = null;
        document.body.classList.remove('mr-card-focus-on');
      }
      return;
    }
    _focusGroupChatSession(meeting, sid);
    _gcFocusedCardSid = sid;
    document.body.classList.add('mr-card-focus-on');
  }

  async function _handleGcEscapeAction(btn, meeting) {
    if (btn.hasAttribute('disabled')) return;
    const action = btn.getAttribute('data-gc-escape');
    const sid = btn.getAttribute('data-gc-sid');
    const kind = btn.getAttribute('data-gc-kind');
    if (!sid) return;
    btn.disabled = true;
    const oldText = btn.textContent;
    btn.textContent = '...';
    let _btnTextHandledExternally = false;
    try {
      if (action === 'extract') {
        const r = await ipcRenderer.invoke('groupchat-manual-extract', {
          meetingId: meeting.id, sid, sincePromptTs: _gcTurnStartTs[meeting.id] || 0,
        });
        if (!r || !r.ok) {
          console.warn(`[rt-escape] extract failed: ${r?.reason} (${r?.detail || ''})`);
          const detail = r?.detail ? `：${r.detail}` : '';
          _showGcEscapeNotice(`提取失败（${r?.reason || 'unknown'}）${detail}`, 'error');
        } else {
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
        const r = await ipcRenderer.invoke('groupchat-skip-participant', { meetingId: meeting.id, sid });
        if (!r || !r.ok) console.warn(`[rt-escape] skip failed: ${r?.reason}`);
      } else if (action === 'enter-shell') {
        if (typeof window !== 'undefined' && typeof window.selectSession === 'function') {
          window.selectSession(sid);
        } else if (typeof selectSession === 'function') {
          selectSession(sid);
        } else {
          console.warn('[rt-escape] enter-shell: selectSession not available');
        }
      } else if (action === 'resend-prompt') {
        const r = await ipcRenderer.invoke('groupchat-resend-prompt', { meetingId: meeting.id, sid });
        if (r && r.ok) {
          btn.style.background = '#2da44e';
          btn.style.color = '#fff';
          btn.textContent = `✓ 已重发`;
          _btnTextHandledExternally = true;
          const cachedForResend = _gcPanelState[meeting.id];
          if (cachedForResend && cachedForResend._partialBy && cachedForResend._partialBy[sid]) {
            delete cachedForResend._partialBy[sid].sendStatus;
          }
          refreshGroupChatPanel(meeting);
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
        const r = await ipcRenderer.invoke('groupchat-resend-participant', { meetingId: meeting.id, sid });
        if (r && r.ok) {
          console.log(`[rt-escape] resend ok: ${kind}`);
        } else {
          alert(`暂未支持单家"重新拉起"。\n\n建议操作：\n1. 在该卡片底部按"跳过"，下游 prompt 不会引用此家。\n2. 或者发起新一轮（直接提问），系统会自动重启卡死的 CLI。\n3. 或者从左侧 sidebar 点该子 session 进 shell 看 PTY 真实情况。\n\n（错误信息：${r?.reason || 'unknown'}）`);
        }
      }
    } catch (err) {
      console.error(`[rt-escape] ${action} threw:`, err);
      if (action === 'resend-prompt') {
        alert(`📤 发送失败：${err && err.message ? err.message : 'unknown'}\n\n（如果错误说"No handler registered"，说明后端 IPC 还没部署，需要等待 T5 落地）`);
      }
    } finally {
      if (!_btnTextHandledExternally) {
        btn.disabled = false;
        btn.textContent = oldText;
      }
    }
  }

  async function _handleSlotHoverAction(btn) {
    const action = btn.getAttribute('data-gc-action');
    const f2Kind = btn.getAttribute('data-gc-kind');
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
        const cleanLabel = fullLabel.replace(/^[^A-Za-z0-9_一-鿿]+/, '');
        const shortLabel = cleanLabel.split(/[·\s]/)[0] || f2Kind || '';
        const cur = input.textContent || '';
        input.textContent = (cur && !cur.endsWith(' ') ? cur + ' ' : cur) + `@${shortLabel} `;
        input.focus();
        if (typeof _placeCaretAtEnd === 'function') _placeCaretAtEnd(input);
      }
    } else if (action === 'quote') {
      const sid = btn.getAttribute('data-gc-sid');
      const meeting = activeMeetingId ? (meetingData[activeMeetingId] || null) : null;
      const previewText = (card?.querySelector('.mr-ft-preview')?.innerText || card?.querySelector('.mr-ft-bottom')?.innerText || '').trim();
      if (meeting && sid && previewText) {
        _addQuoteChip(meeting, sid, previewText);
        const oldT = btn.textContent;
        btn.textContent = '引';
        btn.classList.add('quoted');
        setTimeout(() => {
          btn.textContent = oldT;
          btn.classList.remove('quoted');
        }, 1000);
      }
    }
  }

  async function _handleGcMessageCopy(btn) {
    const msgEl = btn.closest('.mr-gc-msg');
    const text = (msgEl?.querySelector('.mr-gc-bubble')?.innerText || '').trim();
    const oldText = btn.textContent;
    if (!text) {
      btn.textContent = '空';
      setTimeout(() => { btn.textContent = oldText; }, 900);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = '✓';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = oldText;
        btn.classList.remove('copied');
      }, 1200);
    } catch (e) {
      console.warn('[groupchat] copy message failed:', e);
      btn.textContent = '复制失败';
      setTimeout(() => { btn.textContent = oldText; }, 1200);
    }
  }

  // [查看本轮 prompt] 从 _gcPanelState 缓存按 message.id 取该条消息存档的 sourcePrompt，弹窗 markdown 渲染。
  function _handleGcViewPrompt(btn, meeting) {
    const msgId = btn.getAttribute('data-gc-view-prompt');
    const cached = meeting && _gcPanelState[meeting.id];
    const msg = cached && Array.isArray(cached.messages) ? cached.messages.find(m => m && m.id === msgId) : null;
    const prompt = msg && msg.sourcePrompt ? String(msg.sourcePrompt) : '';
    _showGcPromptModal(prompt, msg);
  }

  // 自建 DOM overlay（非浏览器原生 dialog，符合禁用 alert/confirm 铁律）。点遮罩 / ✕ / Esc 关闭。
  function _showGcPromptModal(prompt, msg) {
    const existing = document.querySelector('.mr-gc-prompt-modal-overlay');
    if (existing) { try { existing.remove(); } catch {} }
    const overlay = document.createElement('div');
    overlay.className = 'mr-gc-prompt-modal-overlay';
    const who = msg && msg.speaker ? escapeHtml(msg.speaker) : 'AI';
    const actLbl = (msg && msg.committeeAct)
      ? `<span class="mr-gc-prompt-modal-act">${escapeHtml(msg.committeeAct)}${msg.committeeRound ? ' 第' + escapeHtml(String(msg.committeeRound)) + '轮' : ''}</span>`
      : '';
    const bodyHtml = prompt
      ? `<div class="mr-gc-md">${_renderMarkdown(prompt)}</div>`
      : '<div class="mr-gc-prompt-empty">这条消息没有存档 prompt——通常是「查看 prompt」功能上线前产生的旧消息，重新发起一轮即可记录。</div>';
    overlay.innerHTML = `
      <div class="mr-gc-prompt-modal" role="dialog" aria-modal="true">
        <div class="mr-gc-prompt-modal-head">
          <span class="mr-gc-prompt-modal-title">📥 ${who} 本轮收到的 prompt</span>
          ${actLbl}
          <span class="mr-gc-prompt-modal-spacer"></span>
          <button type="button" class="mr-gc-prompt-modal-copy" title="复制 prompt 原文">复制</button>
          <button type="button" class="mr-gc-prompt-modal-close" title="关闭 (Esc)" aria-label="关闭">✕</button>
        </div>
        <div class="mr-gc-prompt-modal-body">${bodyHtml}</div>
        <div class="mr-gc-prompt-modal-foot">${prompt ? prompt.length + ' 字 · 该 AI 实际收到的完整输入（首轮含角色设定，之后仅增量）' : ''}</div>
      </div>`;
    document.body.appendChild(overlay);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const close = () => { try { overlay.remove(); } catch {} document.removeEventListener('keydown', onKey); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    const closeBtn = overlay.querySelector('.mr-gc-prompt-modal-close');
    if (closeBtn) closeBtn.addEventListener('click', close);
    const copyBtn = overlay.querySelector('.mr-gc-prompt-modal-copy');
    if (copyBtn) copyBtn.addEventListener('click', () => {
      try { if (navigator.clipboard) navigator.clipboard.writeText(prompt || ''); } catch {}
      copyBtn.textContent = '已复制 ✓';
      setTimeout(() => { try { copyBtn.textContent = '复制'; } catch {} }, 1200);
    });
    document.addEventListener('keydown', onKey);
  }

  async function _handleGcManualSync(btn, meeting) {
    if (btn.disabled) return;
    const sid = btn.getAttribute('data-gc-sync-answer');
    const turnRaw = parseInt(btn.getAttribute('data-gc-sync-turn') || '', 10);
    if (!sid) return;
    const oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '同步中';
    try {
      const payload = {
        meetingId: meeting.id,
        sid,
        turnNum: Number.isFinite(turnRaw) ? turnRaw : undefined,
        sincePromptTs: _gcTurnStartTs[meeting.id] || 0,
      };
      const r = await ipcRenderer.invoke('groupchat-manual-extract', payload);
      if (!r || !r.ok) {
        const detail = r && (r.detail || r.reason) ? (r.detail || r.reason) : 'unknown';
        _showGcEscapeNotice(`同步失败：${detail}`, 'error');
        // 2026-07-12：按钮短暂文案写全「同步失败」——旧文案裸「失败」出现在
        //   "正在发言"旁边时被误读成 AI 回答失败（截图血泪）。
        btn.textContent = '同步失败';
        setTimeout(() => { btn.textContent = oldText; btn.disabled = false; }, 1500);
        return;
      }
      btn.textContent = '已同步';
      btn.classList.add('ok');
      await refreshGroupChatPanel(meeting);
      setTimeout(() => {
        btn.textContent = oldText;
        btn.classList.remove('ok');
        btn.disabled = false;
      }, 1200);
    } catch (e) {
      _showGcEscapeNotice(`同步失败：${e && e.message ? e.message : String(e)}`, 'error');
      btn.textContent = '同步失败';
      setTimeout(() => { btn.textContent = oldText; btn.disabled = false; }, 1500);
    }
  }

  async function _setMeetingParticipants(meeting, participants) {
    const response = await ipcRenderer.invoke('groupchat:set-participants', {
      meetingId: meeting.id,
      participants,
    });
    if (!response || !response.ok || !response.meeting) {
      throw new Error((response && response.reason) || '参与者状态未保存');
    }
    meetingData[meeting.id] = response.meeting;
    return response.meeting;
  }

  async function _handleGcMemberToggle(btn, meeting) {
    const latestMeeting = meetingData[meeting.id] || meeting;
    const idx = parseInt(btn.getAttribute('data-gc-member-idx') || '-1', 10);
    const sid = Array.isArray(latestMeeting.subSessions) ? latestMeeting.subSessions[idx] : null;
    if (!sid) return;
    const allIndexes = latestMeeting.subSessions.map((_, i) => i);
    const current = Array.isArray(latestMeeting.participants) ? latestMeeting.participants.slice() : allIndexes;
    const set = new Set(current);
    if (set.has(idx)) set.delete(idx);
    else set.add(idx);
    const next = allIndexes.filter(i => set.has(i));
    try {
      await _setMeetingParticipants(latestMeeting, next);
    } catch (err) {
      console.error('[groupchat] set participants failed:', err);
      _showGcEscapeNotice('成员选择保存失败：' + (err && err.message ? err.message : String(err)), 'error');
    }
    renderToolbar(meetingData[latestMeeting.id] || latestMeeting);
    refreshGroupChatPanel(meetingData[latestMeeting.id] || latestMeeting);
  }

  async function _handleDutyHatChange(select, meeting) {
    const latestMeeting = meetingData[meeting.id] || meeting;
    const hatId = select.getAttribute('data-duty-hat-id');
    const sid = select.value || '';
    const assignments = _getDutyHatAssignments(latestMeeting);
    const validSids = new Set((latestMeeting.subSessions || []).filter(Boolean));
    if (sid && validSids.has(sid)) assignments[hatId] = sid;
    else delete assignments[hatId];
    if (sid && validSids.has(sid)) {
      const slotIdx = (latestMeeting.subSessions || []).indexOf(sid);
      const allIndexes = (latestMeeting.subSessions || []).map((_, i) => i);
      const current = Array.isArray(latestMeeting.participants) ? latestMeeting.participants.slice() : allIndexes;
      if (slotIdx >= 0 && !current.includes(slotIdx)) {
        const next = allIndexes.filter(i => current.includes(i) || i === slotIdx);
        try {
          await _setMeetingParticipants(latestMeeting, next);
        } catch (err) {
          console.error('[groupchat] set participants for duty hat failed:', err);
        }
      }
    }
    const refreshedMeeting = meetingData[latestMeeting.id] || latestMeeting;
    _syncDutyHatPromptToInput(refreshedMeeting);
    refreshGroupChatPanel(refreshedMeeting);
  }

  function _memberRemoveErrorText(reason) {
    return {
      last_member: '群聊至少需要保留一位成员',
      turn_in_progress: '本轮回答进行中，请在本轮结束后移除成员',
      turn_state_unavailable: '暂时无法确认本轮是否结束，为避免误删成员已取消操作',
      not_member: '该成员已不在当前群聊中',
      meeting_not_found: '当前群聊已不存在',
    }[reason] || '成员移除失败';
  }

  async function _handleGcMemberRemove(btn, meeting) {
    if (!btn || btn.disabled) return;
    const latestMeeting = meetingData[meeting.id] || meeting;
    const sid = btn.getAttribute('data-gc-member-remove-sid');
    const index = Array.isArray(latestMeeting.subSessions) ? latestMeeting.subSessions.indexOf(sid) : -1;
    if (index < 0) return;
    const slot = _getGcSlots(latestMeeting)[index] || {};
    const label = slot.displayLabel || slot.label || slot.kind || ('成员 ' + (index + 1));
    if (typeof window.confirm === 'function' && !window.confirm('移除“' + label + '”并关闭它的会话？')) return;

    btn.disabled = true;
    const oldText = btn.textContent;
    btn.textContent = '移除中';
    try {
      const response = await ipcRenderer.invoke('remove-meeting-sub', {
        meetingId: latestMeeting.id,
        sessionId: sid,
      });
      if (!response || !response.ok || !response.meeting) {
        throw new Error(_memberRemoveErrorText(response && response.reason));
      }
      meetingData[latestMeeting.id] = response.meeting;
      // 2026-07-20 道雪 [修#3e]：被移除成员同步从"等你 N"集合剔除（否则侧栏把删了的人也算上）
      try {
        const m0 = (typeof meetings !== 'undefined') && meetings[latestMeeting.id];
        if (m0 && m0.unreadAnswered instanceof Set) m0.unreadAnswered.delete(sid);
      } catch {}
      delete _cliReadyCache[sid];
      const assignments = _getDutyHatAssignments(response.meeting);
      for (const [hatId, assignedSid] of Object.entries(assignments)) {
        if (assignedSid === sid) delete assignments[hatId];
      }
      renderHeader(response.meeting);
      renderToolbar(response.meeting);
      setupInput(response.meeting);
      await refreshGroupChatPanel(response.meeting);
    } catch (err) {
      console.error('[groupchat] remove member failed:', err);
      _showGcEscapeNotice(err && err.message ? err.message : String(err), 'error');
      btn.disabled = false;
      btn.textContent = oldText;
    }
  }

  async function _handleGcPanelClick(ev, panel) {
    const meeting = _currentGcPanelMeeting(panel);
    if (!meeting) return;

    const addMemberBtn = _closestInPanel(ev.target, '[data-gc-add-member]', panel);
    if (addMemberBtn) {
      ev.stopPropagation();
      showAddSubMenu(meeting.id, addMemberBtn);
      return;
    }

    const removeMemberBtn = _closestInPanel(ev.target, '[data-gc-member-remove-sid]', panel);
    if (removeMemberBtn) {
      ev.stopPropagation();
      await _handleGcMemberRemove(removeMemberBtn, meeting);
      return;
    }

    // 2026-06-28 道雪 [改进1]：长回答折叠 展开/收起
    const expandBubbleBtn = _closestInPanel(ev.target, '[data-gc-expand-bubble]', panel);
    if (expandBubbleBtn) {
      ev.stopPropagation();
      const row = expandBubbleBtn.previousElementSibling;
      const bubble = row && row.querySelector ? row.querySelector('.mr-gc-bubble') : null;
      if (bubble) {
        const expanded = bubble.classList.toggle('mr-gc-expanded');
        expandBubbleBtn.textContent = expanded ? '收起 ▴' : '展开全文 ▾';
        const art = bubble.closest('.mr-gc-msg');
        const mid = art && art.getAttribute('data-gc-msg-id');
        if (mid) {
          const k = activeMeetingId + '|' + mid;
          if (expanded) _gcExpandedBubbles.set(k, 1); else _gcExpandedBubbles.delete(k);
        }
      }
      return;
    }

    // 2026-06-28 道雪 [改进2]：回到最新
    const scrollBtn = _closestInPanel(ev.target, '[data-gc-scroll-bottom]', panel);
    if (scrollBtn) {
      ev.stopPropagation();
      const el = panel.querySelector('.mr-gc-messages');
      if (el) el.scrollTop = el.scrollHeight;
      return;
    }

    // 2026-06-28 道雪 [改进R2-1]：代码块复制
    const codeCopyBtn = _closestInPanel(ev.target, '[data-gc-copy-code]', panel);
    if (codeCopyBtn) {
      ev.stopPropagation();
      const pre = codeCopyBtn.closest('pre');
      const code = pre && pre.querySelector('code');
      if (code && typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(code.textContent || '');
        const old = codeCopyBtn.textContent;
        codeCopyBtn.textContent = '已复制 ✓';
        setTimeout(() => { try { codeCopyBtn.textContent = old; } catch {} }, 1500);
      }
      return;
    }

    // 2026-06-28 道雪 [改进R2-3]：折叠/展开全部长回答
    const collapseAllBtn2 = _closestInPanel(ev.target, '[data-gc-collapse-all]', panel);
    if (collapseAllBtn2) {
      ev.stopPropagation();
      const bubbles = panel.querySelectorAll('.mr-gc-bubble.mr-gc-collapsible');
      const anyExpanded = Array.from(bubbles).some(b => b.classList.contains('mr-gc-expanded'));
      bubbles.forEach(b => {
        b.classList.toggle('mr-gc-expanded', !anyExpanded);
        const art = b.closest('.mr-gc-msg');
        const mid = art && art.getAttribute('data-gc-msg-id');
        if (mid) { const k = activeMeetingId + '|' + mid; if (!anyExpanded) _gcExpandedBubbles.set(k, 1); else _gcExpandedBubbles.delete(k); }
        const row = b.closest('.mr-gc-bubble-row');
        const eb = row && row.nextElementSibling;
        if (eb && eb.classList && eb.classList.contains('mr-gc-expand-btn')) eb.textContent = !anyExpanded ? '收起 ▴' : '展开全文 ▾';
      });
      collapseAllBtn2.textContent = anyExpanded ? '⇕ 展开全部' : '⇕ 折叠全部';
      return;
    }

    // [幕次折叠] 点击投委会幕次分隔条 → toggle 折叠状态 → 重渲染（前端临时状态，不持久化）。
    const actToggle = _closestInPanel(ev.target, '[data-gc-act-toggle]', panel);
    if (actToggle) {
      ev.stopPropagation();
      const key = actToggle.getAttribute('data-gc-act-toggle');
      const set = _gcCollapsedActs[meeting.id] || (_gcCollapsedActs[meeting.id] = new Set());
      if (set.has(key)) set.delete(key); else set.add(key);
      refreshGroupChatPanel(meeting);
      return;
    }

    const stepDot = _closestInPanel(ev.target, '.mr-gc-step-dot[data-turn-n]', panel);
    if (stepDot) {
      ev.stopPropagation();
      const n = parseInt(stepDot.getAttribute('data-turn-n'), 10);
      if (!Number.isFinite(n) || n < 1) return;
      const cached = _gcPanelState[meeting.id];
      const totalTurns = cached && Array.isArray(cached.turns) ? cached.turns.length : 0;
      const isActive = cached && cached.currentMode && cached.currentMode !== 'idle';
      const latestN = isActive ? totalTurns + 1 : totalTurns;
      if (n === latestN || stepDot.hasAttribute('data-turn-active')) {
        delete _gcViewingTurnN[meeting.id];
      } else {
        _gcViewingTurnN[meeting.id] = n;
      }
      refreshGroupChatPanel(meeting);
      return;
    }

    const cardTab = _closestInPanel(ev.target, '[data-gc-card-tab-sid]', panel);
    if (cardTab) {
      ev.stopPropagation();
      const sid = cardTab.getAttribute('data-gc-card-tab-sid');
      if (sid) _focusGroupChatSession(meeting, sid);
      return;
    }

    if (_closestInPanel(ev.target, '[data-committee-open]', panel)) {
      ev.stopPropagation();
      if (window.committeeUI && window.committeeUI.showModal) window.committeeUI.showModal(meeting);
      return;
    }
    if (_closestInPanel(ev.target, '[data-committee-history]', panel)) {
      ev.stopPropagation();
      if (window.committeeUI && window.committeeUI.showHistory) window.committeeUI.showHistory(meeting);
      return;
    }
    if (_closestInPanel(ev.target, '[data-committee-screener]', panel)) {
      ev.stopPropagation();
      if (window.committeeUI && window.committeeUI.showScreenerHint) window.committeeUI.showScreenerHint(meeting);
      return;
    }

    if (_closestInPanel(ev.target, '[data-gc-view-card]', panel)) {
      ev.stopPropagation();
      _setGroupViewMode('card', meeting);
      renderHeader(meeting);
      return;
    }

    if (_closestInPanel(ev.target, '[data-gc-side-toggle]', panel)) {
      ev.stopPropagation();
      _setGroupSideCollapsed(!_getGroupSideCollapsed(), meeting);
      return;
    }

    const nextActionBtn = _closestInPanel(ev.target, '[data-gc-next-action]', panel);
    if (nextActionBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      _handleNextAction(nextActionBtn.getAttribute('data-gc-next-action'), meetingData[meeting.id] || meeting);
      return;
    }

    const mobileBtn = _closestInPanel(ev.target, '[data-gc-mobile-open]', panel);
    if (mobileBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      _handleMobileWorkbench(mobileBtn.getAttribute('data-gc-mobile-open'), meetingData[meeting.id] || meeting);
      return;
    }

    const viewPromptBtn = _closestInPanel(ev.target, '[data-gc-view-prompt]', panel);
    if (viewPromptBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      _handleGcViewPrompt(viewPromptBtn, meeting);
      return;
    }

    const copyBtn = _closestInPanel(ev.target, '[data-gc-copy-message]', panel);
    if (copyBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      await _handleGcMessageCopy(copyBtn);
      return;
    }

    const syncBtn = _closestInPanel(ev.target, '[data-gc-sync-answer]', panel);
    if (syncBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      await _handleGcManualSync(syncBtn, meeting);
      return;
    }

    const memberBtn = _closestInPanel(ev.target, '[data-gc-member-idx]', panel);
    if (memberBtn) {
      ev.stopPropagation();
      await _handleGcMemberToggle(memberBtn, meeting);
      return;
    }

    if (_closestInPanel(ev.target, '[data-duty-hat-insert]', panel)) {
      ev.stopPropagation();
      _syncDutyHatPromptToInput(meetingData[meeting.id] || meeting);
      return;
    }

    if (_closestInPanel(ev.target, '[data-duty-hat-clear]', panel)) {
      ev.stopPropagation();
      const latestMeeting = meetingData[meeting.id] || meeting;
      _clearDutyHatAssignments(latestMeeting);
      const input = document.getElementById('mr-input-box');
      const currentText = input ? (input.innerText || '') : '';
      const nextText = _replaceDutyHatPromptInText(currentText, '');
      _setMeetingInputText(latestMeeting.id, nextText);
      refreshGroupChatPanel(latestMeeting);
      return;
    }

    if (_closestInPanel(ev.target, '[data-gc-tt-exit]', panel)) {
      ev.stopPropagation();
      delete _gcViewingTurnN[meeting.id];
      refreshGroupChatPanel(meeting);
      return;
    }

    const userqToggle = _closestInPanel(ev.target, '[data-action="userq-toggle"]', panel);
    if (userqToggle) {
      ev.stopPropagation();
      const banner = userqToggle.closest('.mr-gc-userq');
      if (banner) banner.classList.toggle('expanded');
      return;
    }

    const obCard = _closestInPanel(ev.target, '.mr-gc-ob-card[data-ob-q]', panel);
    if (obCard) {
      const q = obCard.getAttribute('data-ob-q');
      const input = document.getElementById('mr-input-box');
      if (input && q && !(input.innerText || '').trim()) {
        input.textContent = q; input.focus(); _placeCaretAtEnd(input);
      }
      return;
    }

    const bannerClose = _closestInPanel(ev.target, '[data-gc-banner-close]', panel);
    if (bannerClose) {
      const banner = bannerClose.closest('#mr-gc-soft-alert-banner');
      if (banner) {
        banner.style.display = 'none';
        banner.innerHTML = '';
      }
      return;
    }

    const expandBtn = _closestInPanel(ev.target, '.mr-ft-expand[data-ft-expand-sid]', panel);
    if (expandBtn) {
      ev.stopPropagation();
      const sid = expandBtn.getAttribute('data-ft-expand-sid');
      const kind = expandBtn.getAttribute('data-ft-expand-kind');
      _openGcTimeline(meeting, sid, kind);
      return;
    }

    const escapeBtn = _closestInPanel(ev.target, '[data-gc-escape]', panel);
    if (escapeBtn) {
      ev.stopPropagation();
      await _handleGcEscapeAction(escapeBtn, meeting);
      return;
    }

    const hoverBtn = _closestInPanel(ev.target, '.mr-ft-hover-actions button', panel);
    if (hoverBtn) {
      ev.stopPropagation();
      await _handleSlotHoverAction(hoverBtn);
      return;
    }

    const card = _closestInPanel(ev.target, '.mr-ft[data-ft-sid]', panel);
    if (card) {
      _handleSlotCardClick(card, ev, meeting);
    }
  }

  function _handleGcPanelChange(ev, panel) {
    const meeting = _currentGcPanelMeeting(panel);
    if (!meeting) return;
    const dutyHatSelect = _closestInPanel(ev.target, '[data-duty-hat-id]', panel);
    if (dutyHatSelect) {
      ev.stopPropagation();
      void _handleDutyHatChange(dutyHatSelect, meeting).catch(err => {
        console.error('[groupchat] duty hat change failed:', err);
      });
    }
  }

  function _syncGcPanelTransientState(panel, meeting) {
    const inputBox = document.getElementById('mr-input-box');
    const sendBtn = document.getElementById('mr-send-btn');
    const inputRow = document.getElementById('mr-input-row');
    const isTT = !!_gcViewingTurnN[meeting.id];
    if (inputBox) {
      inputBox.setAttribute('contenteditable', isTT ? 'false' : 'true');
      inputBox.setAttribute('data-placeholder', isTT
        ? '⌛ 时光机模式 — 点 stepper 最新轮 / Esc 退出后才能发送'
        : (inputBox.getAttribute('data-placeholder-orig') || inputBox.getAttribute('data-placeholder') || ''));
    }
    if (sendBtn) sendBtn.disabled = isTT;
    if (inputRow) inputRow.classList.toggle('mr-input-row-tt', isTT);
    // 2026-07-29 道雪 [群聊运行中可操作]：面板每次重渲都同步一次作战面板行，
    //   让「⏹ 停止本轮」入口跟着 currentMode 实时出现/消失（此前只有输入/勾选等
    //   用户动作才会刷新这一行，运行状态变化时看不到入口）。
    try { _updateInputPreflight(meeting); } catch (e) { console.warn('[groupchat] preflight sync failed:', e && e.message); }

    const hasThinking = panel.querySelector('.mr-gc-think-elapsed');
    if (hasThinking && !_thinkTimer) {
      const mid = meeting.id;
      _thinkTimer = setInterval(() => {
        const ts = _thinkStartTs[mid];
        if (!ts) { clearInterval(_thinkTimer); _thinkTimer = null; return; }
        const els = document.querySelectorAll('.mr-gc-think-elapsed');
        if (els.length === 0) { clearInterval(_thinkTimer); _thinkTimer = null; return; }
        const sec = Math.round((Date.now() - ts) / 1000);
        els.forEach(el => { el.textContent = `已 ${sec}s`; });
      }, 1000);
    } else if (!hasThinking && _thinkTimer) {
      clearInterval(_thinkTimer); _thinkTimer = null;
    }
  }

  function _bindGcPanelEvents(panel, meeting) {
    if (!panel || !meeting) return;
    panel.__mrGcMeeting = meeting;
    if (!panel.__mrGcDelegated) {
      panel.addEventListener('click', (ev) => {
        void _handleGcPanelClick(ev, panel).catch(err => {
          console.error('[groupchat] delegated click failed:', err);
        });
      });
      panel.addEventListener('change', (ev) => {
        _handleGcPanelChange(ev, panel);
      });
      panel.__mrGcDelegated = true;
    }
    _syncGcPanelTransientState(panel, meeting);
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
  function _openGcTimeline(meeting, sid, kind) {
    // T3 fix（2026-05-04 道雪）：开新抽屉前先清掉上一次的 escHandler + 订阅状态。
    if (_gcTimelineCleanup) { _gcTimelineCleanup(); _gcTimelineCleanup = null; }
    const state = _gcPanelState[meeting.id];
    if (!state || !Array.isArray(state.turns)) return;

    const labelDisplay = _KIND_LABELS[kind] || kind;
    const subs = _getGcSubInfo(meeting);
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

    let overlay = document.getElementById('mr-gc-timeline-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'mr-gc-timeline-overlay';
      overlay.className = 'mr-gc-tl-overlay';
      document.body.appendChild(overlay);
    }

    // 2026-07-29 道雪：抽屉正文同样走 turn-card-renderer —— 这是群聊第三个渲染面，
    //   转过来之后 _renderPreviewBlocks / _formatToolUseBlock 这套平行实现就彻底没人用了。
    const renderTurnBody = (turn) => {
      if (!turn) return '<div class="mr-gc-tl-empty">该 AI 还没有可显示的历史回答。</div>';
      let bodyHtml;
      const tlCardKey = `tl|${meeting.id}|${sid}|${turn._live ? 'live' : turn.n}`;
      const tlHost = _gcRegisterCard(tlCardKey, sid, _gcTurnFromBlocks({
        id: `gctl-${tlCardKey}`,
        kind,
        text: (turn.by || {})[sid] || '',
        blocks: turn._live ? turn._partialBlocks : null,
      }));
      if (tlHost) {
        bodyHtml = tlHost + (turn._live ? '<span class="mr-ft-cursor"></span>' : '');
      } else if (turn._live) {
        bodyHtml = '<div class="mr-gc-tl-empty" style="opacity:.6">💭 思考中…等待 AI 输出</div>'
          + '<span class="mr-ft-cursor"></span>';
      } else {
        bodyHtml = '';
      }
      const userIn = (turn.userInput || '').trim();
      const userBlock = userIn
        ? `<div class="mr-gc-tl-user">用户输入：${escapeHtml(userIn.slice(0, 400))}${userIn.length > 400 ? '…' : ''}</div>`
        : '';
      const decisionTag = turn.decisionTitle
        ? `<div class="mr-gc-tl-decision-row">📌 决策标题：${escapeHtml(turn.decisionTitle)}</div>`
        : '';
      return `${decisionTag}${userBlock}<div class="mr-gc-tl-body">${bodyHtml}</div>`;
    };

    const tabsHtml = turnsWithAns.map((t, i) => {
      const modeLabel = { fanout: '提问', debate: '辩论', summary: '综合' }[t.mode] || t.mode;
      const isLatest = i === 0;
      const liveTag = t._live ? '<span class="mr-gc-tl-tab-latest" style="background:#22863a">实时</span>' : '';
      const latestTag = (isLatest && !t._live) ? '<span class="mr-gc-tl-tab-latest">最新</span>' : '';
      return `<button type="button" class="mr-gc-tl-tab ${isLatest ? 'active' : ''}" data-tab-idx="${i}" data-tab-live="${t._live ? '1' : '0'}" title="第 ${t.n} 轮 · ${escapeHtml(modeLabel)}">
        <span class="mr-gc-tl-tab-turn">第 ${t.n} 轮</span>
        <span class="mr-gc-tl-tab-mode ${escapeHtml(t.mode)}">${escapeHtml(modeLabel)}</span>
        ${liveTag}${latestTag}
      </button>`;
    }).join('');

    const hasAnyTab = turnsWithAns.length > 0;

    overlay.innerHTML = `
      <div class="mr-gc-tl-backdrop" data-gc-tl-close="1"></div>
      <aside class="mr-gc-tl-drawer mr-gc-tl-${slotClsTl}" role="dialog" aria-label="${escapeHtml(headerLabel)} 时间线">
        <header class="mr-gc-tl-drawer-head">
          <span class="mr-gc-tl-drawer-title">${escapeHtml(headerLabel)} · 历史回答</span>
          <span class="mr-gc-tl-drawer-meta">共 ${turnsWithAns.length} 轮</span>
          <button type="button" class="mr-gc-tl-close" data-gc-tl-close="1" aria-label="关闭">×</button>
        </header>
        ${hasAnyTab ? `<nav class="mr-gc-tl-tabs" role="tablist">${tabsHtml}</nav>` : ''}
        <div class="mr-gc-tl-content" id="mr-gc-tl-content">${renderTurnBody(turnsWithAns[0])}</div>
      </aside>
    `;
    overlay.style.display = 'block';

    // 2026-05-05 道雪：抽屉字号 scale —— 打开时从 localStorage 读上次值（默认 1.2，正文从
    //   13px 提升到 ~16px），Ctrl+滚轮 ±0.1 调整，clamp [0.8, 2.0]，preventDefault 拦掉
    //   Electron 默认整窗 zoom（仅抽屉内拦，抽屉外仍可整窗 zoom）。CSS 通过 --drawer-font-scale
    //   缩放 .mr-gc-tl-content 内的正文；header/tab 不受影响。
    const _drawerEl = overlay.querySelector('.mr-gc-tl-drawer');
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
    _gcTimelineLive = (liveTurn && turnsWithAns[0] && turnsWithAns[0]._live)
      ? { sid, mid: meeting.id, kind } : null;

    const contentEl = overlay.querySelector('#mr-gc-tl-content');
    // 首屏 tab 的正文也是挂载点（overlay.innerHTML 刚写完），这里 hydrate 出真卡片。
    if (contentEl) _hydrateGroupChatCards(contentEl);
    overlay.querySelectorAll('.mr-gc-tl-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        overlay.querySelectorAll('.mr-gc-tl-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const idx = parseInt(btn.getAttribute('data-tab-idx') || '0', 10);
        const isLive = btn.getAttribute('data-tab-live') === '1';
        if (contentEl) {
          contentEl.innerHTML = renderTurnBody(turnsWithAns[idx]);
          _hydrateGroupChatCards(contentEl);
          contentEl.scrollTop = 0;
        }
        // T3：用户切走 live tab → 解订阅；切回 live tab → 重订阅
        _gcTimelineLive = (isLive && liveTurn) ? { sid, mid: meeting.id, kind } : null;
      });
    });

    const closeAll = () => {
      overlay.style.display = 'none';
      document.removeEventListener('keydown', escHandler);
      _gcTimelineLive = null;  // T3：关抽屉清订阅
      _gcTimelineCleanup = null;  // T3 fix：清掉自身指针，避免下次开抽屉重复 cleanup
    };
    const escHandler = (ev) => { if (ev.key === 'Escape') closeAll(); };
    overlay.querySelectorAll('[data-gc-tl-close]').forEach(el => {
      el.addEventListener('click', closeAll);
    });
    document.addEventListener('keydown', escHandler);
    // T3 fix（2026-05-04 道雪）：把本次 closeAll 注册为模块级清理函数。
    //   下次 _openGcTimeline 调用时会先调它，避免 escHandler 累积。
    _gcTimelineCleanup = closeAll;
  }

  // 乐观态生命周期：renderer 在 IPC 飞行期间用 _gcOptimisticTurn 标记自己写的乐观字段，
  // 一旦 IPC resolve / reject 或 server 推 turn-complete，就清掉这个标记 —— 之后 refresh
  const _gcOptimisticTurn = {}; // { [meetingId]: { mode, t, gen } }
  // 抢占式连发代际（2026-06-24 道雪）：每个 meeting 每次发送自增，clearOptimistic 只认
  //   最新代际，防「连发时旧轮 invoke 先返回」误清新轮的乐观思考态。
  const _gcSendGen = {}; // { [meetingId]: int }
  // 本轮/本步真正被 dispatch 的 sid 集合（串行工作流每步只发子集）。渲染 thinking 时用它过滤；
  // 未设置时 fallback 到 meeting.participants（普通群聊全员），保持原行为。
  const _gcActiveSids = {}; // { [meetingId]: Set<sid> }

  function triggerGroupChat(meeting, opts = {}) {
    const mid = meeting.id;
    const cached = _gcPanelState[mid];
    _gcTurnStartTs[mid] = Date.now();
    // 抢占式连发代际：每次发送自增；clearOptimistic 只认最新代际，避免连发时「旧轮 invoke
    //   先返回」把新轮乐观思考态误清（旧 invoke resolve 时 gen 已不是最新 → 直接跳过）。
    const myGen = (_gcSendGen[mid] = (_gcSendGen[mid] || 0) + 1);
    _gcOptimisticTurn[mid] = { mode: 'group', t: Date.now(), gen: myGen };
    _gcActiveSids[mid] = new Set(_expectedParticipantSids(meeting));

    if (cached) {
      cached.currentMode = 'group';
      cached._partialBy = null;
    }
    refreshGroupChatPanel(meeting, { forceGroupChatBottom: true });
    renderToolbar(meeting);

    const clearOptimistic = () => {
      if (_gcSendGen[mid] !== myGen) return;
      delete _gcOptimisticTurn[mid];
      const c = _gcPanelState[mid];
      if (c) c.currentMode = null;
      refreshGroupChatPanel(meeting);
      renderToolbar(meeting);
    };

    const restoreFailedSend = (reason) => {
      const isLatest = _gcSendGen[mid] === myGen;
      if (isLatest) delete _gcActiveSids[mid];
      _discardPendingUserMessage(mid, { clientId: opts.pendingClientId });
      if (opts.heroIdBySid && Object.keys(opts.heroIdBySid).length) {
        _restoreHeroAssignments(meetingData[mid] || meeting, opts.heroIdBySid);
      }
      clearOptimistic();
      const recovery = _restoreQuestionAndPreserveDraft(mid, opts.userInput);
      const recoveryText = recovery.mergedWithDraft
        ? '；失败问题与当前草稿均已保留在输入框'
        : recovery.restored ? '；问题已恢复到输入框' : '';
      _showGcEscapeNotice((reason || 'AI 群聊发送失败') + recoveryText, 'error');
    };

    ipcRenderer.invoke('groupchat:turn', {
      meetingId: meeting.id,
      userInput: opts.userInput || '',
      heroIdBySid: opts.heroIdBySid || {},
    }).then((result) => {
      console.log('[groupchat] turn IPC resolved:', result && result.status, 'turn=', result && result.turnNum);
      if (result && result.status === 'completed') clearOptimistic();
      else restoreFailedSend((result && result.reason) || `AI 群聊发送失败（${(result && result.status) || 'unknown'}）`);
    }).catch((e) => {
      console.error('[groupchat] turn IPC failed:', e.message);
      restoreFailedSend(`AI 群聊发送异常：${e && e.message ? e.message : String(e)}`);
    });
    meeting.lastMessageTime = Date.now();
    ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { lastMessageTime: meeting.lastMessageTime } });
  }

  // === 串行工作流（2026-06-17 道雪）===
  // 复用 groupchat:turn（已透传 targetMemberIds）逐步派发：每步换一组 AI、await 串行；
  // 步内多 AI 由 dispatcher 的 Promise.all 并行；跨步上下文靠 orchestrator delta 机制自动透传
  //（后说话的 AI 首次参与时 delta 会补齐它没看过的前序发言），故后端零改动，这里只是驱动循环。
  function _buildWorkflowMembers(meeting) {
    const subSids = (meeting && Array.isArray(meeting.subSessions)) ? meeting.subSessions : [];
    const out = [];
    for (let i = 0; i < subSids.length; i++) {
      const sid = subSids[i];
      const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      if (!s) continue;
      const kind = s.kind || 'claude';
      const title = s.title || (typeof _KIND_LABELS !== 'undefined' && _KIND_LABELS[kind]) || kind || `AI ${i + 1}`;
      // memberId 必须与后端 dispatcher.groupMembersForMeeting 的 `m${idx+1}` 对齐（idx = subSessions 原始下标）
      out.push({ memberId: `m${i + 1}`, kind, title });
    }
    return out;
  }

  async function _ensureWorkflowMembersReady(meeting, targetMemberIds) {
    const ids = Array.isArray(targetMemberIds) ? targetMemberIds : [];
    const wakeTasks = ids.map(async (memberId) => {
      const index = parseInt(String(memberId).slice(1), 10) - 1;
      const sid = Number.isInteger(index) && index >= 0 ? (meeting.subSessions || [])[index] : null;
      if (!sid) throw new Error(`工作流成员 ${memberId} 不存在`);
      const session = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      if (!session) throw new Error(`工作流成员 ${memberId} 会话不存在`);
      if (session.status !== 'dormant') return session;
      if (typeof window.resumeDormantSession !== 'function') {
        throw new Error(`工作流成员 ${memberId} 无法唤醒`);
      }
      const resumed = await window.resumeDormantSession(sid);
      if (!resumed) throw new Error(`工作流成员 ${memberId} 唤醒失败`);
      return resumed;
    });
    return Promise.all(wakeTasks);
  }

  function _updateWorkflowBtnState(meeting) {
    const btn = document.getElementById('mr-workflow-btn');
    if (!btn) return;
    // 2026-07-20 道雪 [修#7d]：非群聊会议隐藏 workflow 按钮。
    btn.style.display = (meeting && meeting.groupChat) ? '' : 'none';
    if (!(meeting && meeting.groupChat)) return;
    const badge = document.getElementById('mr-workflow-badge');
    const wf = meeting && meeting.serialWorkflow;
    const on = !!(wf && wf.enabled && Array.isArray(wf.steps) && wf.steps.length);
    const workflowApi = window.WorkflowTemplates;
    const presetMeta = on && workflowApi && typeof workflowApi.getTemplateMeta === 'function'
      ? workflowApi.getTemplateMeta(wf.templateId)
      : null;
    const workflowLabel = presetMeta ? presetMeta.name : '串行工作流';
    btn.classList.toggle('active', on);
    if (badge) badge.textContent = on ? String(wf.steps.length) : '';
    btn.title = on ? `${workflowLabel}已启用：${wf.steps.length} 步（点击修改）` : '串行工作流设置';
    btn.setAttribute('aria-label', on ? `${workflowLabel}，${wf.steps.length} 步，点击修改` : '串行工作流设置');
  }

  async function runSerialWorkflow(meeting, userInput, opts = {}) {
    const m = meetingData[meeting.id] || meeting;
    const steps = (m.serialWorkflow && Array.isArray(m.serialWorkflow.steps)) ? m.serialWorkflow.steps : [];
    if (!steps.length) { handleMeetingSend(userInput, m, opts); return; }
    const workflowApi = window.WorkflowTemplates;
    const stepConfigs = workflowApi && typeof workflowApi.normalizeStepConfigs === 'function'
      ? workflowApi.normalizeStepConfigs(steps, m.serialWorkflow && m.serialWorkflow.stepConfigs)
      : steps.map((_step, i) => ((m.serialWorkflow && m.serialWorkflow.stepConfigs || [])[i] || {}));

    // 用户问题进 timeline/groupchat 消息各一次；后续步骤复用同一个可见 turn，只追加 AI 回答。
    const trimmed = (userInput || '').trim();
    const pendingUser = trimmed ? _rememberPendingUserMessage(m, trimmed) : null;
    try {
      await ipcRenderer.invoke('meeting-append-user-turn', { meetingId: m.id, text: userInput });
    } catch (e) { console.warn('[workflow] append-user-turn failed:', e && e.message); }

    _gcTurnStartTs[m.id] = Date.now();
    let workflowTurnNum = null;
    let workflowFailure = null;
    // 'interrupted' | 'superseded' | null —— 用户在工作流跑到一半时接管的原因。
    let workflowTakenOver = null;
    for (let i = 0; i < steps.length; i++) {
      const targetMemberIds = (steps[i] || []).filter(Boolean);
      if (!targetMemberIds.length) continue;
      _gcOptimisticTurn[m.id] = { mode: 'group', t: Date.now() };
      // 本步活跃 sid：memberId 'm{i+1}' → subSessions[i]，让 UI 只对本步真正在动的 AI 显示思考中
      _gcActiveSids[m.id] = new Set(
        targetMemberIds.map(id => m.subSessions[parseInt(String(id).slice(1), 10) - 1]).filter(Boolean)
      );
      const cached = _gcPanelState[m.id];
      if (cached) { cached.currentMode = 'group'; cached._partialBy = null; }
      refreshGroupChatPanel(m);
      renderToolbar(m);
      try {
        // 串行工作流按步唤醒：打开房间不再同时常驻全部 CLI/MCP，
        // 但本步发送前仍保证目标会话已经在 main 进程创建完成。
        await _ensureWorkflowMembersReady(m, targetMemberIds);
        const stepInput = workflowApi && typeof workflowApi.buildSerialStepPrompt === 'function'
          ? workflowApi.buildSerialStepPrompt(userInput, stepConfigs[i], i, steps.length)
          : userInput;
        const result = await ipcRenderer.invoke('groupchat:turn', {
          meetingId: m.id,
          // v2：模板/自定义 prompt 按步骤注入；留空 prompt 时完全兼容旧行为。
          // 后说话的 AI 仍通过 groupchat delta 看到前序步骤回答。
          userInput: stepInput,
          targetMemberIds,
          reuseTurnNum: workflowTurnNum,
          appendUserMessage: !workflowTurnNum,
          dispatchMode: 'serial',
          heroIdBySid: opts.heroIdBySid || {},
        });
        if (result && result.status === 'completed' && result.turnNum && !workflowTurnNum) workflowTurnNum = result.turnNum;
        if (!result || result.status !== 'completed') {
          workflowFailure = `串行工作流第 ${i + 1}/${steps.length} 步失败：${(result && result.reason) || (result && result.status) || '未知错误'}`;
          break;
        }
        // 2026-07-29 道雪 [群聊运行中可操作]：本步被用户接管 —— 点了「停止本轮」(interrupted)
        //   或直接追问下一题把本步抢占掉 (superseded)。语义明确定为「中断整个工作流」，
        //   不是「排到下一步」：后续步骤的 prompt 依赖本步产出，本步已作废，继续跑只会
        //   拿空结果编排出垃圾。用户可自行重新发起工作流。
        if (result.interrupted || result.superseded) {
          workflowTakenOver = result.interrupted ? 'interrupted' : 'superseded';
          break;
        }
      } catch (e) {
        console.error('[workflow] step failed:', e);
        workflowFailure = `串行工作流第 ${i + 1}/${steps.length} 步异常：${(e && e.message) ? e.message : e}`;
        break;
      }
    }
    // 被用户接管（interrupted / superseded）时不要清乐观思考态：superseded 意味着
    //   用户已经发了新一轮，新轮的思考态正在跑，清掉会把它抹成 idle（与 turn-complete
    //   的 superseded 早退同一道理）。interrupted 由 turn-complete 正常收敛。
    if (!workflowTakenOver) {
      delete _gcOptimisticTurn[m.id];
      delete _gcActiveSids[m.id];
      const c = _gcPanelState[m.id];
      if (c) c.currentMode = null;
      refreshGroupChatPanel(m);
      renderToolbar(m);
    }
    if (workflowTakenOver === 'interrupted') {
      _discardPendingUserMessage(m.id, { clientId: pendingUser && pendingUser.clientId });
      _showGcEscapeNotice(`串行工作流已在第 ${steps.length} 步流程中被你停止，后续步骤未执行`);
    } else if (workflowTakenOver === 'superseded') {
      _discardPendingUserMessage(m.id, { clientId: pendingUser && pendingUser.clientId });
      _showGcEscapeNotice('串行工作流已被你的新提问接管，后续步骤未执行');
    }
    if (workflowFailure) {
      if (!workflowTurnNum && opts.heroIdBySid && Object.keys(opts.heroIdBySid).length) {
        _restoreHeroAssignments(m, opts.heroIdBySid);
      }
      _discardPendingUserMessage(m.id, { clientId: pendingUser && pendingUser.clientId });
      const recovery = !workflowTurnNum
        ? _restoreQuestionAndPreserveDraft(m.id, trimmed)
        : { restored: false, mergedWithDraft: false };
      const recoveryText = recovery.mergedWithDraft
        ? '；失败问题与当前草稿均已保留在输入框'
        : recovery.restored ? '；问题已恢复到输入框' : '';
      _showGcEscapeNotice(`${workflowFailure}${recoveryText}`, 'error');
    }
    m.lastMessageTime = Date.now();
    ipcRenderer.send('update-meeting', { meetingId: m.id, fields: { lastMessageTime: m.lastMessageTime } });
  }

  // === 循环工作流（Phase 1，2026-06-29 道雪）===
  // 在串行工作流之上加：评审 gate + 不达标自动重来 + 达标后打磨。
  // 角色从 serialWorkflow.steps 派生：step[0][0] = 开发者，step[1..] 的成员 = 评审者（同质冗余）。
  // 纯逻辑（解析/合并/状态机）在 renderer/loop-workflow.js（window.LoopWorkflow），已 24 单测覆盖。
  function _loopSidOf(m, memberId) {
    const idx = parseInt(String(memberId).slice(1), 10);
    return (idx > 0 && m.subSessions) ? (m.subSessions[idx - 1] || null) : null;
  }
  function _loopLabelOf(m, memberId) {
    const sid = _loopSidOf(m, memberId);
    const s = (sid && typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
    const kind = (s && s.kind) || 'claude';
    return (s && s.title) || (typeof _KIND_LABELS !== 'undefined' && _KIND_LABELS[kind]) || kind || memberId;
  }
  function _loopTextFromResults(results, sid) {
    if (!Array.isArray(results)) return '';
    const r = results.find(x => x && x.sid === sid);
    return r ? (r.text || '') : '';
  }
  function _loopSetActive(m, memberIds) {
    _gcOptimisticTurn[m.id] = { mode: 'group', t: Date.now() };
    _gcActiveSids[m.id] = new Set(memberIds.map(id => _loopSidOf(m, id)).filter(Boolean));
    const cached = _gcPanelState[m.id];
    if (cached) { cached.currentMode = 'group'; cached._partialBy = null; }
    refreshGroupChatPanel(m); renderToolbar(m);
  }

  async function runLoopWorkflow(meeting, userInput, persistedLoopState) {
    const m = meetingData[meeting.id] || meeting;
    const LW = window.LoopWorkflow;
    if (!LW) { alert('循环工作流模块未加载 (loop-workflow.js)'); return; }
    const wf = m.serialWorkflow || {};
    const steps = Array.isArray(wf.steps) ? wf.steps : [];
    const builderId = (steps[0] || [])[0];
    const reviewerIds = Array.from(new Set([].concat(...steps.slice(1)).filter(Boolean)));
    if (!builderId || !reviewerIds.length) {
      alert('循环工作流需要：第 1 步放 1 个开发者，第 2 步起放评审者');
      return;
    }
    const loopCfg = wf.loop || {};
    const config = Object.assign(LW.defaultConfig(), {
      gate: { consecutivePass: 1 },
      polish: { enabled: false },
      stop: {
        maxRounds: loopCfg.maxRounds || 3,
        deadlineTs: loopCfg.deadlineTs || null,
        noProgressRounds: loopCfg.noProgressRounds || 2,
      },
      cwd: loopCfg.cwd || null,
    });
    let state, prevMerge = null, goal, resuming = false;
    if (persistedLoopState && persistedLoopState.status === 'running') {
      const r = LW.resumeState(persistedLoopState);
      state = r.state; prevMerge = r.prevMerge; goal = state.goal || (userInput || '').trim();
      resuming = true;
    } else {
      goal = (userInput || '').trim();
      state = LW.newLoopState(); state.goal = goal;
    }
    // v2 不再自动打磨。旧版若恰好停在 polishing，视为已经通过验收并结束。
    if (state.phase === 'polishing' && !config.polish.enabled) {
      state.phase = 'reaching';
      state.status = 'done';
      state.suggestionPool = [];
    }
    if (goal) _currentTurnUserInputByMeeting[m.id] = goal;
    m._loopState = state; // 暴露给 E2E / 调试
    try { window.__loopState = state; } catch (e) {} // 只读观测点
    try { await ipcRenderer.invoke('meeting-append-user-turn', { meetingId: m.id, text: resuming ? `🔁 续跑循环（从第 ${state.round} 轮后继续）：${goal}` : `🔁 循环目标：${goal}` }); } catch (e) {}
    console.log('[loop] ' + (resuming ? 'resume' : 'start') + ' goal=', goal, 'round=', state.round, 'builder=', builderId, 'reviewers=', reviewerIds);
    while (state.status === 'running') {
      if (state.round > config.stop.maxRounds + 2) { state.status = 'stopped_max'; break; } // 本地兜底

      const taskInfo = LW.builderTaskText(state, prevMerge, config);
      const builderStepCfg = (Array.isArray(wf.stepConfigs) && wf.stepConfigs[0]) || {};
      const reviewerStepCfg = (Array.isArray(wf.stepConfigs) && wf.stepConfigs[1]) || {};
      const builderPrompt = LW.PROMPTS.builder({ goal, cwd: config.cwd, firstRound: taskInfo.firstRound, phase: taskInfo.phase, taskText: taskInfo.taskText, rolePrompt: builderStepCfg.prompt || '' });

      // ── 开发步 ──
      state._stage = 'builder#' + (state.round + 1);
      state.currentStep = 'builder'; state.lastError = null;
      _loopSetActive(m, [builderId]);
      let bRes;
      try {
        bRes = await ipcRenderer.invoke('groupchat:turn', { meetingId: m.id, userInput: builderPrompt, targetMemberIds: [builderId], reuseTurnNum: null, appendUserMessage: true, dispatchMode: 'serial' });
      } catch (e) {
        state.status = 'paused'; state.lastError = { stage: 'builder', reason: (e && e.message) || 'builder_error', at: Date.now() };
        console.error('[loop] builder turn err', e); break;
      }
      if (!bRes || bRes.status !== 'completed') {
        state.status = 'paused'; state.lastError = { stage: 'builder', reason: (bRes && (bRes.reason || bRes.status)) || 'builder_not_completed', at: Date.now() };
        console.warn('[loop] builder not completed:', bRes && bRes.status); break;
      }
      const turnNum = bRes.turnNum;

      // ── 评审步（多评审同 turn 并行；评审经 delta 已能看到开发者本轮发言）──
      const reviewerPrompt = LW.PROMPTS.reviewer({ goal, cwd: config.cwd, rolePrompt: reviewerStepCfg.prompt || '' });
      state._stage = 'reviewer#' + (state.round + 1);
      state.currentStep = 'reviewer'; state.lastError = null;
      _loopSetActive(m, reviewerIds);
      let rRes;
      try {
        rRes = await ipcRenderer.invoke('groupchat:turn', { meetingId: m.id, userInput: reviewerPrompt, targetMemberIds: reviewerIds, reuseTurnNum: turnNum, appendUserMessage: false, dispatchMode: 'serial' });
      } catch (e) {
        state.status = 'paused'; state.lastError = { stage: 'reviewer', reason: (e && e.message) || 'reviewer_error', at: Date.now() };
        console.error('[loop] reviewer turn err', e); break;
      }
      if (!rRes || rRes.status !== 'completed') {
        state.status = 'paused'; state.lastError = { stage: 'reviewer', reason: (rRes && (rRes.reason || rRes.status)) || 'reviewer_not_completed', at: Date.now() };
        console.warn('[loop] reviewer not completed:', rRes && rRes.status); break;
      }

      // ── 解析 + 合并裁决（AND-pass / OR-fail）──
      const reviews = reviewerIds.map(id => {
        const sid = _loopSidOf(m, id);
        const text = _loopTextFromResults(rRes.results, sid);
        return { from: _loopLabelOf(m, id), verdict: LW.parseVerdict(text), raw: text };
      });
      const merge = LW.mergeVerdicts(reviews);
      prevMerge = merge;
      LW.advanceLoopState(state, merge, config, Date.now());
      state.currentStep = null; state.lastError = null;
      console.log(`[loop] round=${state.round} phase=${state.phase} pass=${merge.pass} status=${state.status} green=${state.consecutiveGreen} pool=${state.suggestionPool.length} blockers=${merge.blockers.length}`);
      // Phase 2：每轮持久化 loopState（重启可读到进度）
      try {
        m.serialWorkflow.loopState = { goal: state.goal, status: state.status, phase: state.phase, round: state.round, consecutiveGreen: state.consecutiveGreen, suggestionPool: state.suggestionPool, history: state.history, _lastBlockerSig: state._lastBlockerSig, _noProgress: state._noProgress, deadlineTs: config.stop.deadlineTs, currentStep: state.currentStep || null, lastError: state.lastError || null };
        ipcRenderer.send('update-meeting', { meetingId: m.id, fields: { serialWorkflow: m.serialWorkflow } });
      } catch (e) {}
      refreshGroupChatPanel(m);
    }

    // 收尾
    try {
      m.serialWorkflow.loopState = { goal: state.goal, status: state.status, phase: state.phase, round: state.round, consecutiveGreen: state.consecutiveGreen, suggestionPool: state.suggestionPool, history: state.history, _lastBlockerSig: state._lastBlockerSig, _noProgress: state._noProgress, deadlineTs: config.stop.deadlineTs, currentStep: state.currentStep || null, lastError: state.lastError || null };
      ipcRenderer.send('update-meeting', { meetingId: m.id, fields: { serialWorkflow: m.serialWorkflow } });
    } catch (e) {}
    delete _gcOptimisticTurn[m.id];
    delete _gcActiveSids[m.id];
    const c = _gcPanelState[m.id];
    if (c) c.currentMode = null;
    refreshGroupChatPanel(m); renderToolbar(m);
    m.lastMessageTime = Date.now();
    ipcRenderer.send('update-meeting', { meetingId: m.id, fields: { lastMessageTime: m.lastMessageTime } });
    const summary = `🔁 循环结束：${state.status}，共 ${state.round} 轮，建议池剩 ${state.suggestionPool.length} 条`;
    console.log('[loop]', summary);
    try { await ipcRenderer.invoke('meeting-append-user-turn', { meetingId: m.id, text: summary }); } catch (e) {}
    // Phase 2：生成 HTML 晨报到 Desktop/claude-artifacts（renderer nodeIntegration 可用 fs）
    try {
      const reportHtml = LW.buildReportHtml(goal, state, config, {
        builderLabel: _loopLabelOf(m, builderId),
        reviewerLabels: reviewerIds.map(id => _loopLabelOf(m, id)).join('+'),
        finishedAt: new Date().toLocaleString(),
      });
      const os = require('os'), fs = require('fs'), pathMod = require('path');
      const dir = pathMod.join(os.homedir(), 'Desktop', 'claude-artifacts');
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
      const file = pathMod.join(dir, `loop-report-${Date.now()}.html`);
      fs.writeFileSync(file, reportHtml, 'utf8');
      console.log('[loop] 晨报已生成:', file);
      try { await ipcRenderer.invoke('meeting-append-user-turn', { meetingId: m.id, text: `📄 循环复盘报告已生成：${file}` }); } catch (e) {}
    } catch (e) { console.warn('[loop] 晨报生成失败:', e && e.message); }
    return state;
  }

  // Phase 2b：从持久化 loopState 续跑（崩溃/重启后）。返回是否触发续跑。
  // 注：假设成员 session 已就绪；若 dormant，首个 builder turn 会失败 break、状态保持 running 下次再续（成员自动 wake 为进阶项）。
  window.__resumeLoopIfPending = function (meetingId) {
    try {
      const m = meetingData[meetingId];
      if (!m || !m.serialWorkflow || !m.serialWorkflow.loop || !m.serialWorkflow.loop.enabled) return false;
      const ls = m.serialWorkflow.loopState;
      if (!ls || ls.status !== 'running') return false;
      if (ls.deadlineTs && Date.now() >= ls.deadlineTs) { console.log('[loop] resume skipped: past deadline'); return false; }
      console.log('[loop] resuming pending loop for meeting', meetingId, 'from round', ls.round);
      runLoopWorkflow(m, null, ls);
      return true;
    } catch (e) { console.warn('[loop] resume check failed:', e && e.message); return false; }
  };
  // main 进程 boot 扫描到未完成循环 → 通知 renderer 续跑
  try {
    ipcRenderer.on('loop:resume-pending', (_e, payload) => {
      const id = payload && payload.meetingId;
      if (id) window.__resumeLoopIfPending(id);
    });
  } catch (e) {}

  function findSessionByKind(meeting, kind) {
    if (!meeting || !meeting.subSessions) return null;
    for (const sid of meeting.subSessions) {
      const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      if (s && s.kind === kind && s.status !== 'dormant') return sid;
    }
    return null;
  }

  // Group chat 轮次完成：清掉 partialBy + 乐观标记（防止 turn-complete 比 IPC.then 更早），
  // 从 IPC 拉最终 state（含 turn N 已持久化）
  // 2026-05-05 道雪 修3：cache 清理对所有 meeting 都做（含非 active），DOM 重渲仅 active 做。
  //   之前的 `meetingId === activeMeetingId` 守卫导致非 active AI 群聊 _partialBy 残留，
  //   切回时 cached.currentMode!=idle 但实际 server 已 idle → 卡片显示 streaming 假象。
  ipcRenderer.on('groupchat-turn-complete', (_event, { meetingId, turnNum, superseded }) => {
    const meeting = meetingData[meetingId];
    if (!_isPanelCapableMeeting(meeting)) return;
    // 抢占式连发（2026-06-24 道雪）：被新一轮抢占结算的「旧轮」完成通知 —— 新轮已在
    //   triggerGroupChat 乐观置 currentMode='group'+清 partialBy；这里若再清乐观态/
    //   currentMode 会把新轮思考态抹成 idle。旧轮 superseded 结果已持久化进 state.turns，
    //   回看历史可见，无需此刻刷新。
    if (superseded) {
      _discardPendingUserMessage(meetingId, { throughTurn: turnNum });
      return;
    }
    // === Phase 1: cache 清理（所有 meeting 都做）===
    delete _gcOptimisticTurn[meetingId];
    delete _gcActiveSids[meetingId];
    // 2026-05-05 道雪：本轮已 settle,state.turns[N].userInput 接管,清掉进行中缓存。
    _discardPendingUserMessage(meetingId, { throughTurn: turnNum });
    const cached = _gcPanelState[meetingId];
    if (cached) {
      cached._partialBy = null;
      cached.currentMode = null;
    }
    // === Phase 2: DOM 重渲（仅 active meeting）===
    //   非 active AI 群聊的全员完成通知由 renderer.js 监听同 IPC 累加 meeting.unreadCount
    //   触发侧栏 has-unread + ⏸ 等你 badge，不在此处理。
    if (meetingId !== activeMeetingId) return;
    refreshGroupChatPanel(meeting);
    if (cached) renderToolbar(meeting);
  });

  // 2026-07-29 道雪 [群聊运行中可操作]：用户点「停止本轮」后主进程的确认广播。
  //   真正的状态收敛仍由随后的 groupchat-turn-complete 完成（interrupted 结算会让
  //   dispatcher 的 allSettled 立即 resolve）；这里只做「没有 watcher 可停」的兜底：
  //   后端已把 orchestrator 收回 idle，前端也要同步清乐观思考态，否则卡片会一直转。
  ipcRenderer.on('groupchat-turn-interrupted', (_event, { meetingId, stopped, pendingDispatch }) => {
    if (!meetingId) return;
    if (Array.isArray(stopped) && stopped.length > 0) return; // 走正常 turn-complete 收敛
    if (pendingDispatch) return; // 有轮正卡在发送中，它自己会以 interrupted 收敛，别抢着清
    delete _gcOptimisticTurn[meetingId];
    delete _gcActiveSids[meetingId];
    const cached = _gcPanelState[meetingId];
    if (cached) {
      cached._partialBy = null;
      cached.currentMode = null;
    }
    if (meetingId !== activeMeetingId) return;
    const meeting = meetingData[meetingId];
    if (!_isPanelCapableMeeting(meeting)) return;
    refreshGroupChatPanel(meeting);
    renderToolbar(meeting);
  });

  // pilot redesign（2026-05-02）：timeline-append / timeline-update / _updatePilotPlaceholder 整体废弃
  //   （pilot recap 卡片不再生成，AI 群聊 timeline 只保留 fanout/debate/summary 公开发言记录）。

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

  // Group chat 单家 partial-update：T2（2026-05-04 道雪）局部 patch + diff 短路 + scrollTop 保留
  //   修复 B2 滚动条弹回：旧版 panel.innerHTML 全量重渲，三家卡片 DOM 全销毁→
  //   皮卡丘 settled 后小火龙心跳仍把皮卡丘 .mr-ft-preview 的 scrollTop 拍回 0。
  // 2026-05-05 道雪 修3：cache 同步与 DOM 解耦 ——
  //   旧版 `meetingId !== activeMeetingId → return` 让非 active AI 群聊的 cache 永远跟不上 server，
  //   切回时残留 streaming partial → 卡片显示错状态。新版 cache 同步对所有 meeting 都做，
  //   DOM 操作仅 active 时执行。
  // 2026-07-21 道雪 [修思考中口径]：后端实际发送目标 → 覆盖乐观猜测的 _gcActiveSids，
  //   思考中气泡/进度分母立即与真实发言一致（_expectedParticipantSids 优先读 _gcActiveSids）。
  ipcRenderer.on('groupchat-turn-targets', (_event, { meetingId, sids }) => {
    if (!meetingId || !Array.isArray(sids)) return;
    _gcActiveSids[meetingId] = new Set(sids);
    if (meetingId === activeMeetingId) {
      const m0 = meetingData[meetingId] || (typeof meetings !== 'undefined' && meetings[meetingId]);
      if (m0) refreshGroupChatPanel(m0);
    }
  });

  ipcRenderer.on('groupchat-partial-update', (_event, { meetingId, sid, status, text, thinkSec, tokens, blocks, source, cleanBufLen, reason }) => {
    const meeting = meetingData[meetingId];
    if (!_isPanelCapableMeeting(meeting)) return;
    // === Phase 1: cache 同步（任何 meeting 都做，含非 active）===
    let cached = _gcPanelState[meetingId];
    if (!cached) {
      // 没 cache 说明用户从没打开过这个 AI 群聊 → 异步拉 server state 建 cache。
      //   本次 partial 不写（下次 partial 来时 cache 已建会正常合并），
      //   保持与旧版行为一致避免占位 cache 导致 lastTurn=null 渲染不完整。
      _syncGroupChatCacheFromServer(meeting).then(({ ok }) => {
        if (ok && meetingId === activeMeetingId) refreshGroupChatPanel(meeting);
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
      // errored settle 带失败原因，占位文案用它解释"为什么失败"（2026-07-12）
      reason: reason || undefined,
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
    // 2026-07-29：本轮 blocks 快照。settle 后 _partialBy 会被清空，但用户刚看过的
    //   thinking / 工具调用不该在气泡转正的瞬间消失 —— 正式消息继续从这里取回。
    _rememberGcBlocks(meetingId, cached.currentTurn, sid, next.blocks);

    // === Phase 2: DOM 更新（仅 active meeting 做）===
    if (meetingId !== activeMeetingId) return;
    // 2026-05-05 道雪：时光机模式短路 — 用户在看第 N 轮历史快照时，partial-update
    //   不应该把卡片 outerHTML 替换为最新 streaming 内容（否则用户感知"被强制跳回最新轮"）。
    //   cache 已经在上面更新（保持一致性，用户退出时光机后即可看到最新态），仅跳过 DOM patch。
    //   refreshGroupChatPanel 全量路径走 _renderFusedTabs 已有 isTimeTravel 分支，不受影响。
    if (typeof _gcViewingTurnN[meetingId] === 'number') return;

    // 2026-05-15 道雪 群聊弹顶 bug 修复：群聊视图（聊天流模式）走专属局部 patch
    //   旧路径下群聊视图 DOM 没有 .mr-ft 元素 → 必走下面的 fallback 全量重渲 →
    //   每次 partial 都重建 .mr-gc-messages 容器 → scrollTop 丢失。新路径优先
    //   走 _patchGroupChatPendingMessage 只替换单条 pending article。patch 失败
    //   （DOM 节点找不到等）才退到全量重渲兜底。
    const panel = _ensureGcPanel();
    if (meeting.groupChat && _getGroupViewMode() === 'chat') {
      if (_patchGroupChatPendingMessage(panel, meeting, sid, cached)) return;
      // patch 失败：可能 pending 区还没首次渲染（meeting 刚切换、cache 刚同步），
      //   走下方 fallback 全量重渲（仍带 capture+restore 保护 scrollTop）
      const groupScroll = _captureGroupChatScroll(panel, meeting);
      try {
        _renderGcPanelInto(panel, meeting, cached, { scroll: groupScroll });
      } catch (e) {
        console.error('[groupchat] partial-update fallback rebuild failed:', e);
      }
      return;
    }
    // T2 局部 patch：找到该 sid 的 slot DOM，outerHTML 替换；其他两个 slot 完全不动
    const slotEl = panel.querySelector(`.mr-ft[data-ft-sid="${sid}"]`);
    if (!slotEl) {
      // 兜底：DOM 找不到该 slot（panel 还没渲染过）→ 全量重渲
      // silent-failure-hunter L1（2026-05-04 道雪）：并发场景（partial-update 在 turn-complete
      //   之后到、cached 字段意外 null）下 _renderGcPanelHtml 可能抛 TypeError，
      //   原版无 try/catch → 整个 IPC 回调崩溃，panel 残破。包一层让回调能 return。
      const groupScroll = _captureGroupChatScroll(panel, meeting);
      try {
        _renderGcPanelInto(panel, meeting, cached, { scroll: groupScroll });
      } catch (e) {
    console.error('[groupchat] partial-update fallback rebuild failed:', e);
      }
      return;
    }
    // T2 scrollTop 保留：替换前记录 .mr-ft-preview 的滚动位置（即使是流式增长的家自己，也尽量保留）
    const prevPreview = slotEl.querySelector('.mr-ft-preview');
    const savedScrollTop = prevPreview ? prevPreview.scrollTop : 0;
    // 计算新 HTML
    const slots = _getGcSlots(meeting);
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
      // 2026-07-29：新 slot HTML 里只有卡片挂载点，先 hydrate 出真 turn 卡片再恢复滚动，
      //   否则量到的是空容器高度、scrollTop 恢复无效。
      _hydrateGroupChatCards(newSlotEl);
      _bindSlotCardEvents(newSlotEl, meeting);
      // 恢复 scrollTop
      const newPreview = newSlotEl.querySelector('.mr-ft-preview');
      if (newPreview && savedScrollTop > 0) newPreview.scrollTop = savedScrollTop;
    }
    // T3（2026-05-04 道雪）：抽屉实时订阅 — 用户打开 ↗ 看本 sid 的实时 tab 时，
    //   不重建 overlay，仅 mutate `.mr-gc-tl-body` innerHTML，保留用户的滚动位置。
    if (_gcTimelineLive && _gcTimelineLive.sid === sid && _gcTimelineLive.mid === meetingId) {
      const overlay = document.getElementById('mr-gc-timeline-overlay');
      if (overlay && overlay.style.display !== 'none') {
        const tlBody = overlay.querySelector('.mr-gc-tl-body');
        if (tlBody) {
          // 2026-07-29：抽屉实时正文同样是真 turn 卡片
          const tlKey = `tl|${meetingId}|${sid}|live`;
          const host = _gcRegisterCard(tlKey, sid, _gcTurnFromBlocks({
            id: `gctl-${tlKey}`,
            text: next.text || '',
            blocks: Array.isArray(next.blocks) ? next.blocks : null,
          }));
          const inner = host || '<div class="mr-gc-tl-empty" style="opacity:.6">💭 思考中…等待 AI 输出</div>';
          // T3 滚动保留：mutate innerHTML 时记录旧 scrollTop，在父容器（.mr-gc-tl-content）层面恢复
          const tlContent = overlay.querySelector('#mr-gc-tl-content');
          const savedScroll = tlContent ? tlContent.scrollTop : 0;
          tlBody.innerHTML = inner;
          _hydrateGroupChatCards(tlBody);
          if (tlContent && savedScroll > 0) tlContent.scrollTop = savedScroll;
        }
      }
    }
  });

  // Stage 2 容错升级：软提醒 banner —— watcher 在 T1=90s/T2=180s 触发，UI 弹非阻塞 banner
  // 提示用户"还在等"，提供"一键提取/跳过/继续等"操作。永不阻塞按钮（按钮 disabled
  // 由 _allParticipantsSettled 决定，与本 banner 无关）。
  ipcRenderer.on('groupchat-soft-alert', (_event, { meetingId, sid, label, level, mode, turnNum }) => {
    const meeting = meetingData[meetingId];
    if (!_isPanelCapableMeeting(meeting)) return;

    // 2026-05-05 道雪 修3：cache 同步对所有 meeting 都做（写 _partialBy[sid].status='soft_alert'），
    //   切回该 AI 群聊时卡片自动显示"等待中…"状态。
    //   banner DOM 仅 active 时弹（跨 meeting 弹 banner 文案"XX 已等待"会让用户混乱当前看的不是这个 AI 群聊）。
    //   非 active AI 群聊的 soft-alert 不接入侧栏 unread —— 这是"AI 慢响应"信号，
    //   语义跟"全员完成"不同，混入侧栏会让"⏸ 等你"badge 含义模糊。
    const cached = _gcPanelState[meetingId];
    if (cached) {
      if (!cached._partialBy) cached._partialBy = {};
      const existing = cached._partialBy[sid] || {};
      cached._partialBy[sid] = { text: existing.text || '', status: 'soft_alert' };
    }
    // === Phase 2: banner DOM 与 panel 重渲（仅 active）===
    if (meetingId !== activeMeetingId) return;
    const banner = document.getElementById('mr-gc-soft-alert-banner');
    if (banner) {
      const levelLabel = level === 't2' ? '3 分钟' : '90 秒';
      const urgency = level === 't2' ? 'urgent' : '';
      // FIX-B（2026-05-01）：T2（3min）文案明确指引"用卡片按钮绕过"，不再让用户傻等
      const hint = level === 't2'
        ? '⚠ 已等待 3 分钟仍无响应，大概率卡死。请用卡片上的「一键提取 / 跳过 / 重新拉起」按钮处理这家。'
        : '可能是慢响应 / 限流 / 卡死。可用卡片上的"一键提取 / 跳过"绕过，或继续等待自然完成。';
      banner.className = `mr-gc-soft-alert-banner ${urgency}`;
      banner.innerHTML = `
        <div class="mr-gc-soft-alert-msg">
          <strong>${escapeHtml(label || sid.slice(0, 8))}</strong> 已等待 <strong>${levelLabel}</strong>。
          <span class="mr-gc-soft-alert-hint">${hint}</span>
        </div>
        <button class="mr-gc-soft-alert-close" data-gc-banner-close="1" title="关闭提示">×</button>
      `;
      banner.style.display = 'flex';
      banner.querySelectorAll('[data-gc-banner-close]').forEach(b => {
        b.addEventListener('click', () => { banner.style.display = 'none'; banner.innerHTML = ''; }, { once: true });
      });
    }
    if (cached) {
      const panel = _ensureGcPanel();
      // 群聊弹顶 bug 修复（2026-06-05 道雪）：soft-alert 90s/180s 触发时全量重渲
      //   过去无 capture/restore → .mr-gc-messages 容器 scrollTop 被拍回 0,视觉弹顶。
      const groupScroll = _captureGroupChatScroll(panel, meeting);
      _renderGcPanelInto(panel, meeting, cached, { scroll: groupScroll });
    }
  });

  // T6（2026-05-03）：send-stuck 事件 → 数据驱动写 _partialBy[sid].sendStatus='stuck'，
  //   再 refreshGroupChatPanel 重渲——这样 innerHTML 重渲后状态也能保留（H2 数据驱动方案）。
  //   H1 修复：补 activeMeetingId 守卫，与其他 groupchat-* 监听器保持一致。
  ipcRenderer.on('groupchat-send-stuck', (_e, { meetingId, sid /*, kind, mode */ }) => {
    const meeting = meetingData[meetingId];
    if (!_isPanelCapableMeeting(meeting)) return;

    // 2026-05-05 道雪 修3：cache 同步对所有 meeting 都做（写 sendStatus='stuck'），
    //   切回该 AI 群聊时卡片自动显示"⚠ 输入卡顿"状态 + [📤 发送] 按钮亮起。
    //   panel DOM 重渲仅 active 做。
    const cached = _gcPanelState[meetingId];
    if (cached) {
      if (!cached._partialBy) cached._partialBy = {};
      const existing = cached._partialBy[sid] || {};
      // 保留已有 text/status/blocks，仅追加 sendStatus='stuck'
      cached._partialBy[sid] = { ...existing, sendStatus: 'stuck' };
    }
    console.warn(`[renderer] groupchat-send-stuck meeting=${meetingId} sid=${sid.slice(0,8)}`);
    if (meetingId !== activeMeetingId) return;
    if (cached) {
      const panel = _ensureGcPanel();
      // 群聊弹顶 bug 修复（2026-06-05 道雪）：send-stuck 在用户提问瞬间常触发,
      //   过去无 capture/restore → 整个 panel 重渲后 scrollTop=0,用户视觉"弹顶"。
      const groupScroll = _captureGroupChatScroll(panel, meeting);
      _renderGcPanelInto(panel, meeting, cached, { scroll: groupScroll });
    }
  });

  // T6（2026-05-03）：turn-patched 事件 → 卡片右上角浮"自动补全 +N 字"角标 + 触发刷新
  //   H1 修复：补 activeMeetingId 守卫。
  //   M2 修复（最小化方案）：先 await refreshGroupChatPanel 拿最新 turn meta 重渲，
  //     再追加 badge 到新 DOM 节点上（旧节点已被 innerHTML 替换），避免 badge 被立即抹掉。
  ipcRenderer.on('groupchat-turn-patched', async (_e, { meetingId, turnNum, sid, charCount }) => {
    const meeting = meetingData[meetingId];
    if (!_isPanelCapableMeeting(meeting)) return;
    // 2026-05-05 道雪 修3：cache 同步（拉 server state 拿到 patch 后的 lastTurn.by）对所有 meeting 都做，
    //   切回该 AI 群聊时 lastTurn 自动是 patch 后的最新文本。
    //   "自动补全 +N 字"badge 是 3s 浮动动画，仅 active 时追加（跨切换语义弱，非 active 期间错过没影响）。
    if (meetingId === activeMeetingId) {
      // active：先重渲拿最新 turn meta，badge 在新 DOM 上追加
      await refreshGroupChatPanel(meeting);
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
      _syncGroupChatCacheFromServer(meeting);
    }
    console.log(`[renderer] groupchat-turn-patched turn=${turnNum} sid=${sid.slice(0,8)} +${charCount} chars`);
  });

  const panelEl = () => document.getElementById('meeting-room-panel');
  const headerEl = () => document.getElementById('mr-header');
  const terminalsEl = () => document.getElementById('mr-terminals');
  const toolbarEl = () => document.getElementById('mr-toolbar');
  const inputBoxEl = () => document.getElementById('mr-input-box');
  const sendBtnEl = () => document.getElementById('mr-send-btn');

  const _INPUT_DRAFTS_STORAGE_KEY = 'mr-input-drafts-v1';
  const _INPUT_HISTORY_STORAGE_KEY = 'mr-input-history-v1';
  const _INPUT_HISTORY_LIMIT = 20;
  const _LONG_INPUT_CHAR_THRESHOLD = 1200;

  function _readJsonStorage(key, fallback) {
    try {
      if (typeof localStorage === 'undefined') return fallback;
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  function _writeJsonStorage(key, value) {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(key, JSON.stringify(value || {}));
    } catch (err) {
      console.warn('[meeting-room] input storage write failed:', err && err.message ? err.message : err);
    }
  }

  // 2026-05-05 道雪：输入框草稿 per meeting 独立。2026-06-20: 升级为本地持久化，
  //   避免 Hub 重启、误刷新或切会时未发送 prompt 丢失。
  const _inputDraftByMeeting = _readJsonStorage(_INPUT_DRAFTS_STORAGE_KEY, {});
  let _inputHistoryMenuEl = null;

  // 2026-07-20 道雪 [修#10]：草稿落盘 debounce 500ms——此前每击键全量 JSON.stringify 写 localStorage
  const _inputDraftWriteTimers = {};
  function _setInputDraft(meetingId, text) {
    if (!meetingId) return;
    const normalized = String(text || '');
    if (normalized.trim()) _inputDraftByMeeting[meetingId] = normalized;
    else delete _inputDraftByMeeting[meetingId];
    clearTimeout(_inputDraftWriteTimers[meetingId]);
    _inputDraftWriteTimers[meetingId] = setTimeout(() => {
      delete _inputDraftWriteTimers[meetingId];
      _writeJsonStorage(_INPUT_DRAFTS_STORAGE_KEY, _inputDraftByMeeting);
    }, 500);
  }

  function _clearInputDraft(meetingId) {
    if (!meetingId) return;
    clearTimeout(_inputDraftWriteTimers[meetingId]);
    delete _inputDraftWriteTimers[meetingId];
    delete _inputDraftByMeeting[meetingId];
    _writeJsonStorage(_INPUT_DRAFTS_STORAGE_KEY, _inputDraftByMeeting);
  }

  function _getPromptHistory(meetingId) {
    const all = _readJsonStorage(_INPUT_HISTORY_STORAGE_KEY, {});
    const items = meetingId && Array.isArray(all[meetingId]) ? all[meetingId] : [];
    return items.filter(item => typeof item === 'string' && item.trim());
  }

  function _pushPromptHistory(meetingId, text) {
    const normalized = String(text || '').trim();
    if (!meetingId || !normalized) return;
    const all = _readJsonStorage(_INPUT_HISTORY_STORAGE_KEY, {});
    const prev = Array.isArray(all[meetingId]) ? all[meetingId] : [];
    all[meetingId] = [normalized, ...prev.filter(item => item !== normalized)].slice(0, _INPUT_HISTORY_LIMIT);
    _writeJsonStorage(_INPUT_HISTORY_STORAGE_KEY, all);
  }

  function _compactInputLine(text, maxLen = 72) {
    const oneLine = String(text || '').replace(/\s+/g, ' ').trim();
    return oneLine.length > maxLen ? oneLine.slice(0, maxLen - 1) + '…' : oneLine;
  }

  function _ensureInputPreflightRow() {
    const inputRow = document.getElementById('mr-input-row');
    if (!inputRow || !inputRow.parentNode) return null;
    let row = document.getElementById('mr-input-preflight');
    if (!row) {
      row = document.createElement('div');
      row.id = 'mr-input-preflight';
      row.className = 'mr-input-preflight';
      inputRow.parentNode.insertBefore(row, inputRow);
      // 2026-06-28 道雪：作战面板 row 不在群聊委托容器(mr-group-chat-panel)内，
      // 故在此单独绑定 nextActions 点击委托（综合共识/互相挑错/生成交接/引用焦点卡）。
      row.addEventListener('click', (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest('[data-gc-next-action]') : null;
        if (!btn || !row.contains(btn)) return;
        ev.preventDefault();
        ev.stopPropagation();
        const m = activeMeetingId ? meetingData[activeMeetingId] : null;
        if (m) _handleNextAction(btn.getAttribute('data-gc-next-action'), m);
      });
    }
    return row;
  }

  function _ensureInputTools() {
    const inputBox = document.getElementById('mr-input-box');
    if (!inputBox || !inputBox.parentNode) return;
    let historyBtn = document.getElementById('mr-input-history-btn');
    if (!historyBtn) {
      historyBtn = document.createElement('button');
      historyBtn.id = 'mr-input-history-btn';
      historyBtn.type = 'button';
      historyBtn.className = 'mr-input-tool-btn';
      historyBtn.title = '最近输入';
      historyBtn.setAttribute('aria-label', '最近输入');
      historyBtn.textContent = '↺';
      inputBox.parentNode.insertBefore(historyBtn, inputBox.nextSibling);
    }
    if (!historyBtn.dataset.bound) {
      historyBtn.dataset.bound = '1';
      historyBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        _togglePromptHistoryMenu(historyBtn, meetingData[activeMeetingId]);
      });
    }

    let expandBtn = document.getElementById('mr-input-expand-btn');
    if (!expandBtn) {
      expandBtn = document.createElement('button');
      expandBtn.id = 'mr-input-expand-btn';
      expandBtn.type = 'button';
      expandBtn.className = 'mr-input-tool-btn';
      expandBtn.title = '展开编辑';
      expandBtn.setAttribute('aria-label', '展开编辑');
      expandBtn.textContent = '⤢';
      inputBox.parentNode.insertBefore(expandBtn, historyBtn.nextSibling);
    }
    if (!expandBtn.dataset.bound) {
      expandBtn.dataset.bound = '1';
      expandBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        _openLongInputEditor(meetingData[activeMeetingId]);
      });
    }
  }

  function _updateInputHistoryButton(meeting) {
    const btn = document.getElementById('mr-input-history-btn');
    if (!btn) return;
    const count = _getPromptHistory(meeting && meeting.id).length;
    btn.disabled = count === 0;
    btn.title = count ? `最近输入 (${count})` : '最近输入为空';
  }

  function _getInputRawText() {
    const input = document.getElementById('mr-input-box');
    return input ? (input.innerText || input.textContent || '') : '';
  }

  function _renderInputChip(label, value, cls = '') {
    return `<span class="mr-input-preflight-chip ${cls}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></span>`;
  }

  // 2026-07-20 道雪 [修#8]：循环工作流运行状态跟踪——main 的 loop:progress 一直在发，
  //   renderer 此前不监听（运行中无进度、无停止入口、可误改配置）。
  const _loopStateByMeeting = {};
  ipcRenderer.on('loop:progress', (_e, payload) => {
    if (!payload || !payload.meetingId) return;
    _loopStateByMeeting[payload.meetingId] = payload;
    _updateInputPreflight(meetingData[payload.meetingId]);
  });

  function _updateInputPreflight(meeting) {
    const row = _ensureInputPreflightRow();
    if (!row) return;
    const current = meeting || meetingData[activeMeetingId];
    if (!current) {
      row.style.display = 'none';
      return;
    }
    row.style.display = '';
    const raw = _getInputRawText();
    const charCount = raw.length;
    const chips = [];
    let panelTitle = '发送检查';
    let panelDetail = '准备发送';
    if (_isPanelCapableMeeting(current)) {
      const slots = _getGcSlots(current).filter(Boolean);
      // 2026-07-20 道雪 [修#3b]：目标计数过滤休眠成员（否则"目标 3/3"实际只发 2 家）
      const awakeSlots = slots.filter(slot => {
        const sess = (typeof sessions !== 'undefined' && sessions) ? sessions.get(slot.sid) : null;
        return !(sess && sess.status === 'dormant');
      });
      const dormantSlotsN = slots.length - awakeSlots.length;
      const total = awakeSlots.length || (Array.isArray(current.subSessions) ? current.subSessions.length : 0);
      const selectedSet0 = new Set(Array.isArray(current.participants) ? current.participants : slots.map(slot => slot.slotIndex));
      const selected = awakeSlots.filter(slot => selectedSet0.has(slot.slotIndex)).length || (Array.isArray(current.participants) ? 0 : total);
      const selectedSet = new Set(Array.isArray(current.participants) ? current.participants : awakeSlots.map(slot => slot.slotIndex));
      const selectedNames = slots
        .filter(slot => selectedSet.has(slot.slotIndex))
        .map(slot => slot.displayLabel || slot.label || slot.kind || `AI ${slot.slotIndex + 1}`)
        .slice(0, 3);
      const workflowSteps = current.serialWorkflow && Array.isArray(current.serialWorkflow.steps)
        ? current.serialWorkflow.steps.length
        : 0;
      panelTitle = '作战面板';
      panelDetail = selected === 0
        ? '未选择成员，发送前需要至少勾选 1 位'
        : `发送给 ${selectedNames.join(' / ')}${selected > selectedNames.length ? ` 等 ${selected} 位` : ''}`;
      if (dormantSlotsN > 0) panelDetail += `· ${dormantSlotsN} 位休眠不计入`;
      // 2026-07-29 道雪 [B3]：发送前就把"勾了但 CLI 还没就绪"的成员亮出来。
      //   后端对未就绪成员最多等 60s 就以 cli_not_ready 落轮（不再静默丢弃），
      //   这里提前预警，让用户可以先等 CLI 起来再发，而不是发完才发现少一位。
      const notReadySlots = awakeSlots.filter(slot => selectedSet0.has(slot.slotIndex) && !_cliReadyCache[slot.sid]);
      if (notReadySlots.length > 0) {
        chips.push(_renderInputChip('未就绪', `${notReadySlots.length}`, 'warn'));
        panelDetail += ` · ${notReadySlots.map(s => s.displayLabel || s.label || s.kind).join('/')} 的 CLI 还没就绪，本轮可能发不出去`;
      }
      if (current.serialWorkflow && current.serialWorkflow.enabled && workflowSteps > 0) {
        const workflowApi = window.WorkflowTemplates;
        const presetMeta = workflowApi && typeof workflowApi.getTemplateMeta === 'function'
          ? workflowApi.getTemplateMeta(current.serialWorkflow.templateId)
          : null;
        const workflowLabel = presetMeta ? presetMeta.name : '工作流';
        chips.push(_renderInputChip('发送', `${workflowLabel} · ${workflowSteps} 步`, 'accent'));
        panelDetail += ` · ${workflowLabel}串行工作流 ${workflowSteps} 步`;
      } else {
        chips.push(_renderInputChip('目标', `${selected}/${total || selected || 0}`, selected === 0 ? 'warn' : ''));
      }
    } else {
      const sel = document.getElementById('mr-input-target');
      const targetLabel = sel && sel.selectedOptions && sel.selectedOptions[0]
        ? sel.selectedOptions[0].textContent
        : '全部';
      panelDetail = `发送给 ${targetLabel || '全部'}`;
      chips.push(_renderInputChip('目标', targetLabel || '全部'));
    }
    // 2026-07-20 道雪 [修#10]：空态降噪——引用 0 / 字数 0 不渲染 chip
    const heroAssignmentCount = Object.keys(_snapshotHeroAssignments(current)).length;
    if (heroAssignmentCount) chips.push(_renderInputChip('英雄', `${heroAssignmentCount} 位`, 'hero'));
    if (_gcQuoteChips.length) chips.push(_renderInputChip('引用', `${_gcQuoteChips.length}`, 'accent'));
    if (charCount) chips.push(_renderInputChip('字数', `${charCount}`, charCount > _LONG_INPUT_CHAR_THRESHOLD ? 'warn' : ''));
    if (_inputDraftByMeeting[current.id]) chips.push(_renderInputChip('草稿', '已保存', 'saved'));
    // 2026-07-29 道雪 [群聊运行中可操作]：本轮有 AI 在跑 → 常驻一个明确的「停止本轮」入口。
    //   等价于用户在单 session 终端里按 ESC，只是一次批量下发给本轮所有在跑成员。
    //   输入框/发送按钮**不因此禁用**：运行中追加提问是支持的（后端抢占式结算）。
    if (_isGroupTurnRunning(current)) {
      chips.push(`<span class="mr-input-preflight-chip stop clickable" data-gc-stop-turn="1" title="停止本轮：向所有还在回答的 AI 下发中断（等同你在终端按 ESC）。想直接追问就继续在下面输入，不必先停。"><span>本轮</span><strong>进行中 ⏹ 停止</strong></span>`);
    }
    // 2026-07-20 道雪 [修#8]：循环状态 chip——运行中显示轮次·阶段，点击停止
    const loopSt = _loopStateByMeeting[current.id]
      || (current.serialWorkflow && current.serialWorkflow.loopState)
      || null;
    if (loopSt && loopSt.status === 'running') {
      chips.push(`<span class="mr-input-preflight-chip warn clickable" data-loop-stop="1" title="循环工作流运行中（第 ${escapeHtml(String(loopSt.round || 1))} 轮 · ${escapeHtml(loopSt.phase || loopSt.stage || '进行中')}），点击停止"><span>循环</span><strong>R${escapeHtml(String(loopSt.round || 1))}·${escapeHtml(loopSt.phase || loopSt.stage || '进行中')} ⏹</strong></span>`);
    } else if (loopSt && loopSt.status === 'paused') {
      chips.push(`<span class="mr-input-preflight-chip warn" title="${escapeHtml((loopSt.error && loopSt.error.reason) || '步骤失败，循环已暂停')}"><span>闭环</span><strong>已暂停 · ${escapeHtml(loopSt.stage || '步骤失败')}</strong></span>`);
    }
    // 2026-06-28 道雪：把"第N轮已结束 + 综合共识/互相挑错/生成交接/引用焦点卡"融入作战面板这一行，
    //   省掉聊天区里独占的一行。仅群聊、idle、非历史时 _renderNextActionBar 才返回非空。
    const _gcState = _gcPanelState[current.id] || {};
    const nextActionsHtml = current.groupChat ? _renderNextActionBar(_gcState, current, _gcViewingTurnN[current.id]) : '';
    row.innerHTML = `
      ${current.groupChat ? '' : `<span class="mr-input-battle-label">${escapeHtml(panelTitle)}</span>`}
      <span class="mr-input-battle-detail">${escapeHtml(panelDetail)}</span>
      <span class="mr-input-battle-chips">${chips.join('')}</span>
      ${nextActionsHtml}
    `;

    const loopStopChip = row.querySelector('[data-loop-stop]');
    if (loopStopChip) loopStopChip.addEventListener('click', () => {
      ipcRenderer.invoke('loop:stop', { meetingId: current.id });
    });
    const stopTurnChip = row.querySelector('[data-gc-stop-turn]');
    if (stopTurnChip) stopTurnChip.addEventListener('click', () => {
      void _handleGcStopTurn(current);
    });
    const expandBtn = document.getElementById('mr-input-expand-btn');
    if (expandBtn) expandBtn.classList.toggle('attention', charCount > _LONG_INPUT_CHAR_THRESHOLD);
    _updateInputHistoryButton(current);
  }

  function _closePromptHistoryMenu() {
    if (_inputHistoryMenuEl) {
      _inputHistoryMenuEl.remove();
      _inputHistoryMenuEl = null;
    }
    document.removeEventListener('mousedown', _handlePromptHistoryOutside);
    document.removeEventListener('keydown', _handlePromptHistoryKeydown);
  }

  function _handlePromptHistoryOutside(ev) {
    const btn = document.getElementById('mr-input-history-btn');
    if (_inputHistoryMenuEl && !_inputHistoryMenuEl.contains(ev.target) && ev.target !== btn) {
      _closePromptHistoryMenu();
    }
  }

  function _handlePromptHistoryKeydown(ev) {
    if (ev.key === 'Escape') _closePromptHistoryMenu();
  }

  function _togglePromptHistoryMenu(anchor, meeting) {
    if (_inputHistoryMenuEl) {
      _closePromptHistoryMenu();
      return;
    }
    const items = _getPromptHistory(meeting && meeting.id);
    const rect = anchor.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.id = 'mr-input-history-menu';
    menu.className = 'mr-input-history-menu';
    menu.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - 360))}px`;
    menu.style.bottom = `${Math.max(64, window.innerHeight - rect.top + 6)}px`;
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'mr-input-history-empty';
      empty.textContent = '暂无历史输入';
      menu.appendChild(empty);
    } else {
      items.forEach((item, idx) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'mr-input-history-item';
        btn.innerHTML = `<span>${escapeHtml(_compactInputLine(item))}</span><small>${idx + 1}</small>`;
        btn.addEventListener('click', () => {
          _setMeetingInputText(meeting.id, item);
          _closePromptHistoryMenu();
        });
        menu.appendChild(btn);
      });
    }
    document.body.appendChild(menu);
    _inputHistoryMenuEl = menu;
    setTimeout(() => {
      document.addEventListener('mousedown', _handlePromptHistoryOutside);
      document.addEventListener('keydown', _handlePromptHistoryKeydown);
    }, 0);
  }

  function _openLongInputEditor(meeting) {
    const current = meeting || meetingData[activeMeetingId];
    if (!current) return;
    const existing = document.getElementById('mr-input-editor-overlay');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.id = 'mr-input-editor-overlay';
    overlay.className = 'mr-input-editor-overlay';
    overlay.innerHTML = `
      <div class="mr-input-editor" role="dialog" aria-modal="true" aria-label="展开编辑">
        <div class="mr-input-editor-head">
          <strong>展开编辑</strong>
          <span id="mr-input-editor-count">0 字</span>
        </div>
        <textarea id="mr-input-editor-textarea" class="mr-input-editor-textarea" spellcheck="false"></textarea>
        <div class="mr-input-editor-actions">
          <button type="button" class="mr-input-editor-btn" data-action="cancel">取消</button>
          <button type="button" class="mr-input-editor-btn primary" data-action="apply">应用</button>
          <button type="button" class="mr-input-editor-btn send" data-action="send">发送</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const textarea = overlay.querySelector('#mr-input-editor-textarea');
    const countEl = overlay.querySelector('#mr-input-editor-count');
    const updateCount = () => {
      if (countEl) countEl.textContent = `${textarea.value.length} 字`;
    };
    const applyText = () => {
      _setMeetingInputText(current.id, textarea.value);
      _updateInputPreflight(current);
    };
    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKeydown);
    };
    const onKeydown = (ev) => {
      if (ev.key === 'Escape') close();
    };
    textarea.value = _getInputRawText();
    updateCount();
    textarea.addEventListener('input', updateCount);
    overlay.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action');
        if (action === 'cancel') {
          close();
          return;
        }
        applyText();
        close();
        if (action === 'send') {
          const sendBtn = document.getElementById('mr-send-btn');
          if (sendBtn) sendBtn.click();
        }
      });
    });
    overlay.addEventListener('mousedown', (ev) => {
      if (ev.target === overlay) close();
    });
    document.addEventListener('keydown', onKeydown);
    setTimeout(() => textarea.focus(), 0);
  }

  // 2026-05-05 道雪：用户提问 banner 的"进行中轮"缓存。
  //   handleMeetingSend 入口写入 → turn-complete 清空 → state.turns[N].userInput 接管。
  //   这样从用户点发送 → server 推 turn-complete 之间(数秒到数分钟),banner 就能立即显示
  //   "你刚发的提问 + 进行中"标签,不必等本轮 settle 才出现。
  const _currentTurnUserInputByMeeting = {};
  const _gcPendingUserMessageByMeeting = {};
  function _pendingUserMessages(meetingId) {
    const pending = _gcPendingUserMessageByMeeting[meetingId];
    return Array.isArray(pending) ? pending : [];
  }
  function _rememberPendingUserMessage(meeting, text) {
    const content = String(text || '').trim();
    if (!meeting || !meeting.id || !content) return null;
    const state = _gcPanelState[meeting.id] || {};
    const turns = Array.isArray(state.turns) ? state.turns : [];
    const latestSettledTurn = turns.reduce((max, turn) => Math.max(max, Number(turn && turn.n) || 0), 0);
    const pendingMessages = _pendingUserMessages(meeting.id).slice();
    const previousPending = pendingMessages[pendingMessages.length - 1];
    const pendingBaseTurn = previousPending ? previousPending.afterTurn + 1 : 0;
    const afterTurn = Math.max(Number(state.currentTurn) || 0, latestSettledTurn, pendingBaseTurn);
    _currentTurnUserInputByMeeting[meeting.id] = content;
    const pending = {
      content,
      afterTurn,
      createdAt: Date.now(),
      clientId: String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8),
    };
    pendingMessages.push(pending);
    _gcPendingUserMessageByMeeting[meeting.id] = pendingMessages;
    if (meeting.id === activeMeetingId) {
      _renderActivePanelFromCache(meetingData[meeting.id] || meeting, { forceGroupChatBottom: true });
    }
    return pending;
  }
  function _discardPendingUserMessage(meetingId, opts = {}) {
    let remaining = _pendingUserMessages(meetingId);
    if (opts.clientId) {
      remaining = remaining.filter(pending => pending.clientId !== opts.clientId);
    } else if (Number.isInteger(Number(opts.throughTurn)) && Number(opts.throughTurn) > 0) {
      const throughTurn = Number(opts.throughTurn);
      remaining = remaining.filter(pending => pending.afterTurn + 1 > throughTurn);
    } else {
      remaining = [];
    }
    if (remaining.length > 0) {
      _gcPendingUserMessageByMeeting[meetingId] = remaining;
      _currentTurnUserInputByMeeting[meetingId] = remaining[remaining.length - 1].content;
    } else {
      delete _currentTurnUserInputByMeeting[meetingId];
      delete _gcPendingUserMessageByMeeting[meetingId];
    }
  }
  function _restoreQuestionAndPreserveDraft(meetingId, text) {
    const restoredText = String(text || '').trim();
    if (!restoredText) return { restored: false, mergedWithDraft: false };
    const inp = meetingId === activeMeetingId ? document.getElementById('mr-input-box') : null;
    const liveDraft = inp ? String(inp.innerText || '').trim() : '';
    const storedDraft = String(_inputDraftByMeeting[meetingId] || '').trim();
    const existingDraft = liveDraft || storedDraft;
    const mergedWithDraft = !!existingDraft && !existingDraft.includes(restoredText);
    const merged = mergedWithDraft ? `${restoredText}\n\n${existingDraft}` : (existingDraft || restoredText);
    _setInputDraft(meetingId, merged);
    if (inp) {
      inp.textContent = merged;
      _placeCaretAtEnd(inp);
    }
    return { restored: true, mergedWithDraft };
  }
  function _saveInputDraft() {
    if (!activeMeetingId) return;
    const inp = document.getElementById('mr-input-box');
    if (!inp) return;
    const text = inp.innerText || '';
    _setInputDraft(activeMeetingId, text);
    _updateInputPreflight(meetingData[activeMeetingId]);
  }
  function _restoreInputDraft(meetingId) {
    const inp = document.getElementById('mr-input-box');
    if (!inp) return;
    inp.textContent = _inputDraftByMeeting[meetingId] || '';
    _updateInputPreflight(meetingData[meetingId]);
  }

  function init() {
    // no-op — kept for backward compat; refs resolved lazily
  }

  function openMeeting(meetingId, meeting) {
    // 切换前先保存上一个 meeting 的草稿（如果有）；切换到同一个 meeting 不存。
    if (activeMeetingId && activeMeetingId !== meetingId) _saveInputDraft();
    activeMeetingId = meetingId;
    meetingData[meetingId] = meeting;
    // [投委会浮窗绑定 session] 告知 committee-ui 现在看的是哪个 meeting → 只显示属于本 session 的浮窗、隐藏别的。
    try { if (window.committeeUI && window.committeeUI.syncActiveMeeting) window.committeeUI.syncActiveMeeting(meetingId); } catch {}

    // 2026-06-21 道雪：mr-card-tab-mode 是「非群聊会议」的并列/Tab 全局态，会误伤群聊
    //   卡片视图（CSS 隐藏非 active 卡 + 头部 + 逃生栏 + 提问横幅）且群聊内无切回入口，
    //   造成跨会议污染。进群聊时清除该 body class；进非群聊会议时按 localStorage 恢复。
    if (meeting && meeting.groupChat) {
      document.body.classList.remove('mr-card-tab-mode');
    } else {
      _applyCardViewModeClass(_getCardViewMode());
    }

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
    // IF-C1：开启 CLI ready 轮询，驱动卡片"创建中→待命"切换。
    // IF-C6（多方审查 medium 修复）：拿首次 poll 的 promise，等它返回后再 refresh panel
    //   避免首屏闪烁——一次 IPC < 100ms，对用户感知近乎瞬间。
    const firstPoll = startCliReadyPoll();

    // 两模式(通用/投研)进入会议室即刷新持久化面板
    // 先做一次同步渲染（保持响应不阻塞），await 首次 poll 后再 refresh 一次（修首屏闪烁）
    if (_isPanelCapableMeeting(meeting)) {
      refreshGroupChatPanel(meeting, { forceGroupChatBottom: true });
      // 异步等首次 poll 后再 refresh 一次（poll 内部已会重渲，这里只是兜底，不阻塞 UI）
      if (firstPoll && typeof firstPoll.then === 'function') {
        firstPoll.then(() => {
          if (activeMeetingId === meetingId) {
            try { _refreshSoftAlert(meeting); } catch {}
          }
        }).catch(() => {});
      }
    } else {
      _removeGcPanel();
    }

    // IF-C3（2026-05-01）：进会议室立即刷一次软提醒 banner（AI 未 ready 时提示用户）
    try { _refreshSoftAlert(meeting); } catch {}

    // Card optimization Task 10（2026-05-01）：开启 ResizeObserver 防溢出兜底（Task 10 提供）
    if (typeof _setupMeetingResizeObserver === 'function') _setupMeetingResizeObserver();

    // IF-C2（2026-05-01）：auto-focus 输入框 — defer 到本轮渲染稳定后再 focus，
    //   让用户进会议室立即可键盘输入。
    setTimeout(() => {
      const inputBox = document.getElementById('mr-input-box');
      if (inputBox && document.activeElement !== inputBox) {
        inputBox.focus();
      }
    }, 50);
  }

  function closeMeetingPanel() {
    // 离开 AI 群聊前先保存草稿，下次重新进入时恢复。
    _saveInputDraft();
    activeMeetingId = null;
    _inputBound = false;
    // [投委会浮窗绑定 session] 离开群聊 → 通知 committee-ui 隐藏浮窗（进度仍在后台累积，重进即恢复）。
    try { if (window.committeeUI && window.committeeUI.syncActiveMeeting) window.committeeUI.syncActiveMeeting(null); } catch {}
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
    if (_gcQuoteFloatBtn) _gcQuoteFloatBtn.style.display = 'none';
    const panel = panelEl();
    if (panel) panel.style.display = 'none';
    const el = terminalsEl();
    if (el) el.innerHTML = '';
  }

  // Card optimization Task 10（2026-05-01）— 动态重排兜底：
  //   触发场景：窗口 resize / 沉浸切换 / 历史面板展开 / preview markdown 长度跳变 /
  //             session 加减 / devtools 开关
  //   策略：ResizeObserver 监 #meeting-room-panel 尺寸 + window 'resize' →
  //         debounce 100ms → 强制 reflow + 刷新历史面板高度。
  //   2026-06-18：AI 群聊内嵌 xterm 已下线，移除旧 fit 兼容路径。
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

  // Context/model status arrives independently from meeting state. Update only
  // the active member row so a CLI status tick cannot leave the room at Ctx --
  // until some unrelated group-chat event happens to trigger a full render.
  function refreshSessionMetrics(sessionId) {
    const meeting = activeMeetingId ? meetingData[activeMeetingId] : null;
    if (!meeting || !Array.isArray(meeting.subSessions)) return false;
    const slot = _getGcSlots(meeting).find(item => item && item.sid === sessionId);
    if (!slot) return false;
    const panel = document.getElementById('mr-group-chat-panel');
    if (!panel) return false;

    const session = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sessionId) : null;
    const model = session && session.currentModel
      ? (typeof modelShort === 'function' ? modelShort(session.currentModel) : session.currentModel.displayName || session.currentModel.id || '')
      : '';
    const ctxPct = session && typeof session.contextPct === 'number' ? session.contextPct : null;
    const ctxCls = ctxPct == null ? 'unknown' : _ftCtxClass(ctxPct);
    const ctxText = ctxPct == null ? 'Ctx --' : `Ctx ${ctxPct}%`;
    const ctxTitle = ctxPct == null ? '尚未从该 CLI 状态栏读取上下文占比' : `上下文已用 ${ctxPct}%`;
    const memberLabel = `@m${slot.slotIndex + 1}${model ? ` · ${model}` : ''}`;
    let changed = false;

    const rows = panel.querySelectorAll(`[data-gc-member-idx="${slot.slotIndex}"]`);
    rows.forEach((row) => {
      const ctx = row.querySelector('.mr-gc-member-ctx, .mr-card-roster-ctx');
      if (ctx) {
        const baseClass = ctx.classList.contains('mr-card-roster-ctx') ? 'mr-card-roster-ctx' : 'mr-gc-member-ctx';
        ctx.className = `${baseClass} ${ctxCls}`;
        ctx.textContent = ctxText;
        ctx.title = ctxTitle;
        changed = true;
      }
      const meta = row.querySelector('.mr-gc-member-meta, .mr-card-roster-meta');
      if (meta) {
        meta.textContent = memberLabel;
        changed = true;
      }
    });
    return changed;
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
          refreshGroupChatPanel(updated);
        } else {
          _removeGcPanel();
        }
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

    // Arch refactor 2026-05-02: 沉浸/调试切换按钮已删除。AI 群聊界面只有一种
    // 视图（永远纯卡片），shell 沉到子 session 主区。
    const groupViewMode = meeting.groupChat ? _getGroupViewMode() : null;
    const viewToggleHtml = meeting.groupChat ? `
        <div class="mr-view-toggle mr-group-view-toggle" role="group" aria-label="AI group chat view mode">
          <button class="mr-header-btn mr-view-btn ${groupViewMode === 'chat' ? 'active' : ''}" id="mr-btn-group-chat-view" title="聊天流视图">聊天</button>
          <button class="mr-header-btn mr-view-btn ${groupViewMode === 'card' ? 'active' : ''}" id="mr-btn-group-card-view" title="卡片视图">卡片</button>
        </div>` : `
        <div class="mr-view-toggle" role="group" aria-label="Card view mode">
          <button class="mr-header-btn mr-view-btn ${!_isCardTabMode() ? 'active' : ''}" id="mr-btn-view-parallel" title="并列显示 3 张 AI 卡片">并列</button>
          <button class="mr-header-btn mr-view-btn ${_isCardTabMode() ? 'active' : ''}" id="mr-btn-view-tab" title="Tab 模式：主界面只显示当前 AI 卡片">Tab</button>
        </div>`;

    // 2026-06-28 道雪：群成员按钮从群聊 topbar 移到 header（放在 聊天/卡片 切换的左边）。
    // header 不在群聊委托容器内，故下方单独绑定点击事件（不能依赖 data-gc-side-toggle 委托）。
    const gcMembersBtnHtml = meeting.groupChat ? (() => {
      const gcSlots = _getGcSlots(meeting).filter(Boolean);
      const gcSel = Array.isArray(meeting.participants) ? meeting.participants.length : gcSlots.length;
      const collapsed = _getGroupSideCollapsed();
      return `<button class="mr-header-btn mr-view-btn ${collapsed ? '' : 'active'}" id="mr-btn-group-members" title="${collapsed ? '展开群成员栏' : '收起群成员栏'}">群成员 ${gcSel}/${gcSlots.length}</button>`;
    })() : '';

    el.innerHTML = `
      <div class="mr-header-left">
        <span class="mr-header-title" id="mr-title">${escapeHtml(meeting.title)}</span>
        <span class="mr-header-meta" id="mr-header-meta"></span>
        ${meeting.workspace ? `<button type="button" class="mr-workspace-chip" id="mr-workspace-chip" title="点击复制 · ${escapeHtml(meeting.workspace)}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.8 4.4A1.4 1.4 0 0 1 3.2 3h3l1.3 1.4h5.3a1.4 1.4 0 0 1 1.4 1.4v6a1.4 1.4 0 0 1-1.4 1.4H3.2a1.4 1.4 0 0 1-1.4-1.4Z"/></svg><span>${meeting.workspaceLabel ? `${escapeHtml(meeting.workspaceLabel)} · ` : ''}${escapeHtml(meeting.workspace)}</span></button>` : ''}
      </div>
      <!-- 2026-06-28 道雪：删 header 进度条（与标题旁 meta 的"已N轮·本轮N/M"文字信息重叠），保留 meta。_updateHeaderProgress 的 progEl 分支会因元素缺失自动跳过。 -->
      <div class="mr-header-right">
        ${layoutButtonsHtml ? `<div class="mr-header-primary-actions">${layoutButtonsHtml}</div>` : ''}
        <div class="mr-header-primary-actions">${gcMembersBtnHtml}${viewToggleHtml}</div>
        <div class="mr-header-secondary-actions" aria-label="会议工具">
          ${meeting.groupChat ? `<button class="mr-header-btn" id="mr-btn-memory-preview" title="预览注入给 DeepSeek 的 Claude 主 MEMORY.md">📖 记忆</button>` : ''}
          <button class="mr-header-btn" id="mr-btn-add-sub" title="${meeting.groupChat ? '添加新的 AI 成员' : '添加子会话'}">${meeting.groupChat ? '+ 成员' : '+ 添加'}</button>
          <button class="btn-zoom btn-memo-toggle ${typeof localStorage !== 'undefined' && localStorage.getItem('claude-hub-memo-open') === 'true' ? 'active' : ''}" id="mr-btn-memo" title="Toggle memo panel"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v9a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5v-9zM4 5h8M4 8h8M4 11h5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/></svg></button>
          <button class="btn-zoom" id="mr-btn-zoom-out" title="Shrink UI">A−</button>
          <button class="btn-zoom" id="mr-btn-zoom-in" title="Enlarge UI">A+</button>
          <button class="btn-close-session" id="mr-btn-close" title="关闭会议室" aria-label="Close meeting"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg></button>
        </div>
      </div>
    `;

    const focusBtn = document.getElementById('mr-btn-focus');
    const workspaceChip = document.getElementById('mr-workspace-chip');
    if (workspaceChip) {
      // 归档提示挂在这个 chip 上，而不是自动弹全局模态（2026-07-29 用户要求）：
      // 有待归档建议时 chip 显示一个轻标记，点击才打开归档框；没有建议时保持
      // 原来的「点击复制路径」行为。用户不点就不打扰。
      // 2026-07-29 P1-2：同一套交互独立会话 header 也要有，已抽到
      // WorkspaceController.attachArchiveHint，两处共用，杜绝「只改一边」。
      const wc = window.WorkspaceController;
      const copyWorkspace = () => {
        try { if (navigator.clipboard) navigator.clipboard.writeText(meeting.workspace || ''); } catch {}
      };
      const attached = !!(wc && typeof wc.attachArchiveHint === 'function'
        && wc.attachArchiveHint(workspaceChip, 'meeting', meeting.id, {
          hintTitle: '这个任务还在临时区 · 点击归档到正式项目目录',
          onFallback: copyWorkspace,
        }));
      if (!attached) workspaceChip.addEventListener('click', copyWorkspace);
    }
    if (focusBtn) focusBtn.addEventListener('click', () => setLayout(meeting.id, 'focus'));
    const parallelBtn = document.getElementById('mr-btn-view-parallel');
    const tabBtn = document.getElementById('mr-btn-view-tab');
    const groupChatBtn = document.getElementById('mr-btn-group-chat-view');
    const groupCardBtn = document.getElementById('mr-btn-group-card-view');
    if (parallelBtn) parallelBtn.addEventListener('click', () => {
      _setCardViewMode('parallel', meeting);
      renderHeader(meeting);
    });
    if (tabBtn) tabBtn.addEventListener('click', () => {
      _setCardViewMode('tab', meeting);
      renderHeader(meeting);
    });
    if (groupChatBtn) groupChatBtn.addEventListener('click', () => {
      _setGroupViewMode('chat', meeting);
      renderHeader(meeting);
    });
    if (groupCardBtn) groupCardBtn.addEventListener('click', () => {
      _setGroupViewMode('card', meeting);
      renderHeader(meeting);
    });
    // 2026-06-28 道雪：header 群成员按钮 → toggle 右侧群成员栏（替代原 topbar 里的 data-gc-side-toggle）。
    const groupMembersBtn = document.getElementById('mr-btn-group-members');
    if (groupMembersBtn) groupMembersBtn.addEventListener('click', () => {
      _setGroupSideCollapsed(!_getGroupSideCollapsed(), meeting);
      renderHeader(meeting);
    });
    document.getElementById('mr-btn-add-sub').addEventListener('click', () => showAddSubMenu(meeting.id));
    // 2026-06-05 联邦记忆下线：📖 记忆按钮直接预览 Claude 主 MEMORY.md
    const memoryBtn = document.getElementById('mr-btn-memory-preview');
    if (memoryBtn) {
      memoryBtn.addEventListener('click', () => {
        if (typeof window.openPreviewPanel === 'function') {
          window.openPreviewPanel(_CLAUDE_MEMORY_INDEX);
        } else {
          console.warn('[memory-preview] window.openPreviewPanel not available');
        }
      });
    }
    // 注：顶部 scene toggle（群聊/投研）已删除（2026-05-04 决策：scene 创建时确定，运行时不可切换）。
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

  function showAddSubMenu(meetingId, anchorEl = null) {
    const meeting = meetingData[meetingId];
    if (!meeting || (!meeting.groupChat && meeting.subSessions.length >= 3)) return;

    const btn = anchorEl || document.getElementById('mr-btn-add-sub');
    if (!btn) return;
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
    const _CLI_SUFFIX = { claude: 'Claude Code', gemini: 'Gemini CLI', codex: 'Codex CLI', kimi: 'Kimi Code' };
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
        try {
          const result = await ipcRenderer.invoke('add-meeting-sub', { meetingId, kind });
          if (!result || !result.meeting) throw new Error('新成员会话创建失败');
          if (result.session && typeof sessions !== 'undefined' && sessions) {
            sessions.set(result.session.id, result.session);
          }
          meetingData[meetingId] = result.meeting;
          renderHeader(result.meeting);
          renderTerminals(result.meeting);
          renderToolbar(result.meeting);
          setupInput(result.meeting);
          await refreshGroupChatPanel(result.meeting);
        } catch (err) {
          console.error('[groupchat] add member failed:', err);
          _showGcEscapeNotice('添加成员失败：' + (err && err.message ? err.message : String(err)), 'error');
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

  // Arch refactor 2026-05-02: AI 群聊界面去 shell。子 session shell 只在主区挂载
  // （renderer.js: showTerminal）。保留 renderTerminals 兼容旧调用点，body 为 no-op。
  function renderTerminals(_meeting) { /* removed: shell moved to sub-session view */ }

  function startCliReadyPoll() {
    if (_cliReadyPollTimer) return;
    const pollOnceImpl = async () => {
      if (!activeMeetingId) return;
      // 2026-05-05 道雪：activeMeetingId 快照 + race guard。
      //   原版在 await invoke 后用全局 activeMeetingId 拿 cached、用 T0 闭包的 meeting 写 panel —
      //   用户在 await 期间切到 B 时，cached=cachedB + meeting=meetingA 混渲（标题来自 A 但 stepper/
      //   turns 来自 B）。同样可能让 panel 在用户感知"未操作"瞬间显示错群聊内容。
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
        const cached = _gcPanelState[startActiveMeetingId];
        if (cached) {
          const panel = _ensureGcPanel();
          // 群聊弹顶 bug 修复（2026-06-05 道雪）：CLI ready poll 每秒触发,
          //   首次 AI 思考期间从"创建中→待命"切换时会重渲,过去无 capture/restore → 弹顶。
          const groupScroll = _captureGroupChatScroll(panel, meeting);
          _renderGcPanelInto(panel, meeting, cached, { scroll: groupScroll });
        }
      }
      // 软提醒 banner（IF-C3 实装后会调），保护性调用——不存在时静默
      if (changed && typeof _refreshSoftAlert === 'function') {
        try { _refreshSoftAlert(meeting); } catch {}
      }
    };
    const pollOnce = () => {
      if (_cliReadyPollInFlight) return _cliReadyPollInFlight;
      const task = pollOnceImpl();
      _cliReadyPollInFlight = task.finally(() => {
        if (_cliReadyPollInFlight === task || _cliReadyPollInFlight === tracked) {
          _cliReadyPollInFlight = null;
        }
      });
      const tracked = _cliReadyPollInFlight;
      return tracked;
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
    _cliReadyPollInFlight = null;
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
    const head = document.getElementById('mr-gc-ob-head');
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
        const sid = card.querySelector('[data-gc-sid]')?.dataset?.gcSid;
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
        <span class="mr-gc-ob-head-icon">⏳</span>
        <span><strong>${notReady.join(' / ')}</strong> 启动中, 建议等到状态变 <strong>"待命"</strong> 再发送(避免输入丢失)</span>
      `;
    } else {
      head.classList.remove('loading');
      head.classList.add('ready');
      const defaultText = head.getAttribute('data-default-text') || 'AI 群聊已就位';
      const defaultSub = head.getAttribute('data-default-sub') || '等你抛话题';
      head.innerHTML = `
        <span class="mr-gc-ob-head-icon">✓</span>
        <span><strong>${escapeHtml(defaultText)}</strong> · ${escapeHtml(defaultSub)}</span>
      `;
    }
  }

  function switchFocusTab(_meeting, _newSid) { /* removed: embedded xterm tabs no longer exist */ }

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
  // pilot redesign v4（2026-05-02）：卡片只保留"角色层"红框，删除 dispatch 视觉特效。
  //   设计准则：副驾发言时主驾卡片保持原状，主驾发言时副驾同理。卡片自然反映真实 PTY
  //            状态（thinking/done/idle）即可——dispatch 视觉特效是"多此一举"，反而
  //            会和真实 PTY 状态打架（出现"灰化但又部分动"的怪异中间态）。
  //   dispatchMode 仍保留参数：仅用于输入框 placeholder 的文本提示。
  // --- Toolbar ---

  function renderToolbar(meeting) {
    const el = toolbarEl();
    if (!el) return;
    if (!_isPanelCapableMeeting(meeting)) {
      el.innerHTML = '';
      return;
    }

    const slotsArr = _getGcSlots(meeting);
    const cached = _gcPanelState[meeting.id];
    const inProgress = cached && cached.currentMode && cached.currentMode !== 'idle';
    const isGroupChat = !!meeting.groupChat;
    const participantIndexes = isGroupChat
      ? slotsArr.map((s, idx) => s ? idx : null).filter(idx => idx !== null)
      : [0, 1, 2];

    const slotDisplayLabel = (idx) => {
      const slot = slotsArr[idx];
      if (!slot) return `AI ${idx + 1}`;
      return slot.displayLabel || slot.label || slot.kind || `AI ${idx + 1}`;
    };
    const slotAvatarSrc = (idx) => {
      const slot = slotsArr[idx] || {};
      return `assets/ai-logos/${escapeHtml(slot.kind || 'claude')}.svg`;
    };

    el.innerHTML = '';
    const avatarsRow = document.getElementById('mr-free-avatars-row');
    if (avatarsRow) {
      const participants = Array.isArray(meeting.participants) ? meeting.participants : [];
      const partSet = new Set(participants);
      avatarsRow.innerHTML = participantIndexes.map(idx => {
        const checked = partSet.has(idx);
        // 2026-07-20 道雪 [修#3a]：休眠成员灰显禁勾（后端 dispatcher 本就跳过 dormant，勾上只会"永远等它"）
        // 2026-07-29 道雪 [群聊运行中可操作]：**运行中不再禁勾**。此前 `inProgress` 也进
        //   disabled，只要有一位 AI 在思考，整排成员头像就全灰、用户什么都改不了——这正是
        //   用户反馈的"UI 都是灰的"。勾选只影响**下一轮**的派发目标（后端在 dispatch 那一刻
        //   才读 meeting.participants），改它对正在跑的这轮零副作用，没有任何禁用的理由。
        const slot0 = slotsArr[idx] || {};
        const sess0 = (typeof sessions !== 'undefined' && sessions && slot0.sid) ? sessions.get(slot0.sid) : null;
        const isDormant0 = !!(sess0 && sess0.status === 'dormant');
        const disabledAttr = isDormant0 ? 'disabled' : '';
        const label = slotDisplayLabel(idx);
        const runningHint = (inProgress && !isDormant0) ? '（本轮进行中，改选只影响下一轮）' : '';
        return `
          <label class="mr-free-avatar-chk ${isGroupChat ? 'group' : ''} ${checked ? 'checked' : ''} ${disabledAttr}${isDormant0 ? ' dormant' : ''}"
                 data-slot-idx="${idx}" title="${escapeHtml(label)}${isDormant0 ? '（休眠中，先在侧栏唤醒）' : runningHint}">
            <input type="checkbox" class="mr-free-slot-cb" data-slot-idx="${idx}" ${checked ? 'checked' : ''} ${disabledAttr} />
            <img src="${slotAvatarSrc(idx)}" alt="${escapeHtml(label)}" />
            <span class="mr-free-avatar-chk-mark">OK</span>
          </label>
        `;
      }).join('');
    }

    let updating = false;
    document.querySelectorAll('.mr-free-avatar-chk[data-slot-idx]').forEach(label => {
      label.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (label.classList.contains('disabled') || updating) return;
        updating = true;
        const slotIdx = parseInt(label.getAttribute('data-slot-idx'), 10);
        const latestMeeting = meetingData[meeting.id] || meeting;
        const allIndexes = Array.isArray(latestMeeting.subSessions)
          ? latestMeeting.subSessions.map((_sid, index) => index)
          : [];
        const current = Array.isArray(latestMeeting.participants) ? [...latestMeeting.participants] : allIndexes;
        const wasChecked = current.includes(slotIdx);
        const next = wasChecked ? current.filter(x => x !== slotIdx) : [...current, slotIdx];
        next.sort((a, b) => a - b);
        try {
          const updated = await _setMeetingParticipants(latestMeeting, next);
          renderToolbar(updated);
          _updateInputPreflight(updated);
        } catch (err) {
          console.error('[set-participants] failed:', err);
          _showGcEscapeNotice('成员选择保存失败：' + (err && err.message ? err.message : String(err)), 'error');
        } finally {
          updating = false;
        }
      });
    });
  }

  // --- Input & Broadcasting ---

  let _inputBound = false;
  let _gcMentionActiveIndex = 0;

  // meeting-create-modal（2026-05-01）：mention 列表按当前 meeting 动态构建，
  // Mention list supports core AI kinds, repeated kinds, and precise @m1/@m2/@m3 slot mentions.
  //   当 meeting 内某个 kind 唯一出现时，额外注册 @<kind> 别名（向后兼容老 prompt）；
  //   重复 kind 时该 kind 的 @<kind> 别名不注册（避免歧义）。
  function buildGcMentionItems(meeting) {
    const items = [];
    const subSids = (meeting && Array.isArray(meeting.subSessions)) ? meeting.subSessions : [];
    const isGroupChat = !!(meeting && meeting.groupChat);
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
      const session = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      const title = session ? (session.title || kindLabel || `AI ${i + 1}`) : (kindLabel || `AI ${i + 1}`);
      items.push({
        value: isGroupChat ? `@m${i + 1}` : `@slot${i + 1}`,
        label: isGroupChat ? `m${i + 1} · ${title}` : `Slot ${i + 1}${kindLabel ? ' · ' + kindLabel : ''}`,
        hint: isGroupChat ? 'group target' : 'private ask',
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
    if (isGroupChat) {
      items.unshift({ value: '@all', label: '@all · 全体成员', hint: 'group target' });
      if (meeting && meeting.scene === 'research') {
        items.unshift(
          { value: '@英灵', label: '英灵议事 · 按任务自动选择', hint: '统一 Lens Packet' },
          { value: '@英灵 巴菲特', label: '巴菲特 · 成熟企业复利镜头', hint: 'fundamental lens' },
          { value: '@英灵 利弗莫尔', label: '利弗莫尔 · 右侧趋势镜头', hint: 'trend lens' },
        );
      }
    } else {
    }
    return items;
  }

  function _getGcMentionMenu() {
    let menu = document.getElementById('mr-gc-mention-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'mr-gc-mention-menu';
      menu.className = 'mr-gc-mention-menu';
      menu.setAttribute('role', 'listbox');
      menu.style.display = 'none';
      const row = document.getElementById('mr-input-row');
      if (row) row.appendChild(menu);
    }
    return menu;
  }

  function _hideGcMentionMenu() {
    const menu = document.getElementById('mr-gc-mention-menu');
    if (menu) {
      menu.style.display = 'none';
      menu.innerHTML = '';
    }
    _gcMentionActiveIndex = 0;
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

  function _getGcMentionMatch(inputBox) {
    const text = inputBox.innerText || '';
    const caret = _getTextCaretOffset(inputBox);
    const beforeCaret = text.slice(0, caret);
    const at = beforeCaret.lastIndexOf('@');
    if (at < 0) return null;
    const query = beforeCaret.slice(at + 1);
    if (/\s/.test(query)) return null;
    return { text, caret, start: at, query: query.toLowerCase() };
  }

  function _insertGcMention(inputBox, item, meeting) {
    const match = _getGcMentionMatch(inputBox);
    if (!match) return;
    const suffix = match.text.slice(match.caret);
    const spacer = suffix.startsWith(' ') || suffix.length === 0 ? '' : ' ';
    const inserted = `${item.value} `;
    inputBox.textContent = match.text.slice(0, match.start) + inserted + spacer + suffix;
    inputBox.focus();
    _placeCaretAtTextOffset(inputBox, match.start + inserted.length);
    _hideGcMentionMenu();
    if (meeting && meeting.groupChat) return;
    // meeting-create-modal：slot mentions 优先按 sid focus（精确指向 slot）；
    //   kind alias 走老 _focusGroupChatKind（kind 唯一时才注册此别名，确定不歧义）。
    if (item.sid) _focusGroupChatSession(meeting, item.sid);
    else if (item.kind) _focusGroupChatKind(meeting, item.kind);
  }

  function _updateGcMentionMenu(inputBox, meeting) {
    if (!_isPanelCapableMeeting(meeting)) {
      _hideGcMentionMenu();
      return;
    }
    const match = _getGcMentionMatch(inputBox);
    if (!match) {
      _hideGcMentionMenu();
      return;
    }
    const items = buildGcMentionItems(meeting).filter(item => {
      const haystack = `${item.value} ${item.label}`.toLowerCase().replace(/^@/, '');
      return haystack.includes(match.query);
    });
    if (items.length === 0) {
      _hideGcMentionMenu();
      return;
    }
    if (_gcMentionActiveIndex >= items.length) _gcMentionActiveIndex = 0;
    const menu = _getGcMentionMenu();
    menu.style.left = `${inputBox.offsetLeft}px`;
    menu.style.minWidth = `${Math.min(Math.max(inputBox.offsetWidth, 260), 420)}px`;
    menu.innerHTML = items.map((item, index) => `
      <button type="button" class="mr-gc-mention-item${index === _gcMentionActiveIndex ? ' active' : ''}" data-mention-index="${index}" role="option" aria-selected="${index === _gcMentionActiveIndex ? 'true' : 'false'}">
        <span class="mr-gc-mention-label">${escapeHtml(item.label)}</span>
        <span class="mr-gc-mention-value">${escapeHtml(item.value)}</span>
        <span class="mr-gc-mention-hint">${escapeHtml(item.hint)}</span>
      </button>
    `).join('');
    menu.style.display = 'block';
    menu.querySelectorAll('.mr-gc-mention-item').forEach(btn => {
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const index = Number(btn.getAttribute('data-mention-index'));
        _insertGcMention(inputBox, items[index], meeting);
      });
    });
  }

  function _focusGroupChatSession(meeting, sid) {
    if (!meeting || !sid || !Array.isArray(meeting.subSessions) || !meeting.subSessions.includes(sid)) return false;
    const focused = meeting.focusedSub || meeting.subSessions[0];
    if (sid === focused) return true;
    _tabState[sid] = 'idle';
    if (_tabTimers[sid]) { clearTimeout(_tabTimers[sid]); delete _tabTimers[sid]; }
    meeting.focusedSub = sid;
    ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { focusedSub: sid } });
    switchFocusTab(meeting, sid);
    refreshGroupChatPanel(meeting);
    renderHeader(meeting);
    return true;
  }

  function _focusGroupChatKind(meeting, kind) {
    const sid = findSessionByKind(meeting, kind);
    if (!sid) return false;
    return _focusGroupChatSession(meeting, sid);
  }

  function _handleGcMentionKeydown(e, inputBox, meeting) {
    const menu = document.getElementById('mr-gc-mention-menu');
    const isOpen = menu && menu.style.display !== 'none';
    if (!isOpen) return false;
    const items = buildGcMentionItems(meeting).filter(item => {
      const match = _getGcMentionMatch(inputBox);
      if (!match) return false;
      const haystack = `${item.value} ${item.label}`.toLowerCase().replace(/^@/, '');
      return haystack.includes(match.query);
    });
    if (items.length === 0) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _gcMentionActiveIndex = (_gcMentionActiveIndex + 1) % items.length;
      _updateGcMentionMenu(inputBox, meeting);
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      _gcMentionActiveIndex = (_gcMentionActiveIndex + items.length - 1) % items.length;
      _updateGcMentionMenu(inputBox, meeting);
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      _insertGcMention(inputBox, items[_gcMentionActiveIndex], meeting);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      _hideGcMentionMenu();
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
    const zeroParticipantsSelected = (_curMeetingMode === 'free') &&
      (Array.isArray(meeting.participants) && meeting.participants.length === 0);
    const isFreeZeroSelected = zeroParticipantsSelected && !meeting.groupChat;
    if (meeting.scene) {
      inputBox.dataset.placeholder = isFreeZeroSelected
        ? '请先勾选至少一位发言人'
        : 'AI 群聊：发普通文本启动一轮 / @<slot> 单聊';
    } else {
      inputBox.dataset.placeholder = '输入消息...';
    }
    if (meeting.scene && meeting.groupChat) {
      inputBox.dataset.placeholder = zeroParticipantsSelected
        ? 'AI 群聊：请勾选成员，或用 @成员名 / @m1 / @all 指定发言人'
        : 'AI 群聊：发消息给勾选成员，或 @成员名 / @m1 / @all';
    }
    // 灰态：readonly + class 切换
    if (isFreeZeroSelected) {
      inputBox.setAttribute('readonly', '');
      inputBox.classList.add('mr-gc-input-disabled');
      sendBtn.disabled = true;
    } else {
      inputBox.removeAttribute('readonly');
      inputBox.classList.remove('mr-gc-input-disabled');
      sendBtn.disabled = false;
    }

    // 串行工作流按钮状态随 meeting 切换刷新（active 高亮 + 步数角标）
    _updateWorkflowBtnState(meeting);

    // 卡片优化（2026-05-03 道雪）：粘贴图片支持。绑一次（idempotent guard 在 helper 内）。
    //   helper 由 renderer.js 暴露为 window.attachContenteditablePasteImage（先于 meeting-room.js 加载）。
    if (typeof window.attachContenteditablePasteImage === 'function') {
      window.attachContenteditablePasteImage(inputBox);
    }
    _ensureInputPreflightRow();
    _ensureInputTools();
    _renderHeroDock(meeting);
    _updateInputPreflight(meeting);
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
    // 2026-05-05 道雪：从清空改为按 meeting.id 恢复草稿 — 切换不同 AI 群聊时各自独立。
    inputBox.textContent = _inputDraftByMeeting[meeting.id] || '';
    _updateInputPreflight(meeting);

    if (targetSelect) {
      targetSelect.addEventListener('change', (e) => {
        const mid = activeMeetingId;
        const m = meetingData[mid];
        if (m) {
          m.sendTarget = e.target.value;
          ipcRenderer.send('update-meeting', { meetingId: m.id, fields: { sendTarget: m.sendTarget } });
          _updateInputPreflight(m);
        }
      });
    }

    const doSend = () => {
      const box = document.getElementById('mr-input-box');
      const userText = box ? box.innerText.trim() : '';
      // F6 Phase 3: 既无 text 又无 quote chips → 不发
      if (!userText && _gcQuoteChips.length === 0) return;
      const mid = activeMeetingId;
      const m = meetingData[mid];
      if (!m) return;
      const heroIdBySid = _snapshotHeroAssignments(m);
      // free-mode（2026-05-04）：0 人勾选时拒绝发送
      // CSS readonly 对 contenteditable 无效，必须 JS 二次防御，防 race 导致按钮意外还原
      if (m.mode === 'free' && !m.groupChat) {
        const parts = Array.isArray(m.participants) ? m.participants : [];
        if (parts.length === 0) {
          alert('请先勾选至少一位发言人');
          return;
        }
      }
      // 2026-06-24 道雪：点发送即放行 —— 不再因「本轮未结束」拦截。后端会抢占式结算
      //   上一轮没答完的 AI（标 superseded），本轮 prompt 立即组装分发；没答完的 AI 也会
      //   收到追加 prompt（现代 CLI 支持回答中接新问题）。原 _isGroupTurnBusy 拦截已移除。
      if (!m.scene) {
        const sel = document.getElementById('mr-input-target');
        if (sel) m.sendTarget = sel.value;
      } else {
        m.sendTarget = 'all';
      }
      // F6 Phase 3: 拼接引用 chips 到 prompt 头部, 让 AI 知道用户基于哪些片段追问
      let finalText = userText;
      if (_gcQuoteChips.length > 0) {
        const quoteSection = '基于以下引用追问:\n' + _gcQuoteChips.map(c =>
          `[💎 第${c.turnN}轮 ${c.slotLabel}: "${c.text}"]`
        ).join('\n');
        finalText = userText
          ? `${quoteSection}\n\n用户问题: ${userText}`
          : `${quoteSection}\n\n(请就以上引用展开评论或继续讨论)`;
      }
      // 循环工作流（评审 gate + 自动重来）→ main 进程驱动（崩溃续跑）；串行 → renderer 驱动；否则普通群聊单轮
      if (m.scene && m.serialWorkflow && m.serialWorkflow.loop && m.serialWorkflow.loop.enabled &&
          Array.isArray(m.serialWorkflow.steps) && m.serialWorkflow.steps.length) {
        const pendingLoopQuestion = _rememberPendingUserMessage(m, finalText);
        const restoreLoopStartFailure = (reason) => {
          if (Object.keys(heroIdBySid).length) _restoreHeroAssignments(m, heroIdBySid);
          _discardPendingUserMessage(m.id, { clientId: pendingLoopQuestion && pendingLoopQuestion.clientId });
          const recovery = _restoreQuestionAndPreserveDraft(m.id, finalText);
          const recoveryText = recovery.mergedWithDraft
            ? '；失败问题与当前草稿均已保留在输入框'
            : recovery.restored ? '；问题已恢复到输入框' : '';
          _showGcEscapeNotice('循环启动失败：' + (reason || '未知') + recoveryText, 'error');
        };
        // 先把原始目标作为独立用户消息落 timeline，再启动 main 驱动的内部步骤。
        // timeline 写入失败不阻断执行，但会明确记录日志；避免内部 builder prompt 冒充原问题。
        ipcRenderer.invoke('meeting-append-user-turn', { meetingId: m.id, text: finalText })
          .catch((e) => console.warn('[loop] append original goal failed:', e && e.message))
          .then(() => ipcRenderer.invoke('loop:start', { meetingId: m.id, userInput: finalText, heroIdBySid }))
          .then((r) => {
            if (!r || !r.ok) {
              console.warn('[loop] start failed:', r && r.reason);
              restoreLoopStartFailure((r && r.reason) || '未知');
            }
          }).catch((e) => {
            console.error('[loop] start IPC failed:', e && e.message);
            restoreLoopStartFailure(e && e.message);
          });
      } else if (m.scene && m.serialWorkflow && m.serialWorkflow.enabled &&
          Array.isArray(m.serialWorkflow.steps) && m.serialWorkflow.steps.length) {
        runSerialWorkflow(m, finalText, { heroIdBySid });
      } else {
        handleMeetingSend(finalText, m, { heroIdBySid });
      }
      // 一次性语义：点击发送后立即清空；普通群聊若主进程拒绝本轮，
      // triggerGroupChat.restoreFailedSend 会把同一份快照恢复回来。
      if (Object.keys(heroIdBySid).length) _clearHeroAssignments(m);
      _pushPromptHistory(m.id, userText || finalText);
      if (box) box.textContent = '';
      _clearInputDraft(m.id);
      _clearQuoteChips();
      _updateInputPreflight(m);
    };

    sendBtn.addEventListener('click', doSend);

    const workflowBtn = document.getElementById('mr-workflow-btn');
    if (workflowBtn) {
      workflowBtn.addEventListener('click', () => {
        const m = meetingData[activeMeetingId];
        if (!m || !m.groupChat) return;
        // 2026-07-20 道雪 [修#8]：循环运行中禁改配置（本次运行按旧 steps 跑，改了也不生效还误导）
        const loopSt0 = _loopStateByMeeting[m.id]
          || (m.serialWorkflow && m.serialWorkflow.loopState)
          || null;
        if (loopSt0 && loopSt0.status === 'running') {
          _showGcEscapeNotice('循环工作流运行中，停止后才能修改配置', 'error');
          return;
        }
        const members = _buildWorkflowMembers(m);
        if (!members.length) { alert('群里还没有可用的 AI 成员，先添加成员再配置工作流'); return; }
        window.openWorkflowConfigModal({
          members,
          config: m.serialWorkflow || null,
          onSave: (config) => {
            m.serialWorkflow = config;
            ipcRenderer.send('update-meeting', { meetingId: m.id, fields: { serialWorkflow: config } });
            _updateWorkflowBtnState(m);
            _updateInputPreflight(m);
            // 主动落 state.json（boot 恢复源），不赌 schedulePersist 时机
            if (typeof window.schedulePersist === 'function') window.schedulePersist();
          },
        });
      });
    }

    inputBox.addEventListener('keydown', (e) => {
      // IME composition (中/日/韩) 中, 回车/方向键是给候选词用的, 不是给应用层。
      // 不放行就会出现:中文按回车选词被当作"发送"+清空输入框,或方向键被 mention 菜单吃掉。
      if (e.isComposing || e.keyCode === 229) return;
      const mid = activeMeetingId;
      const currentMeeting = meetingData[mid] || meeting;
      if (_handleGcMentionKeydown(e, inputBox, currentMeeting)) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    });

    inputBox.addEventListener('input', () => {
      const mid = activeMeetingId;
      _saveInputDraft();
      _updateGcMentionMenu(inputBox, meetingData[mid] || meeting);
    });
    inputBox.addEventListener('keyup', (e) => {
      if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) return;
      const mid = activeMeetingId;
      _updateGcMentionMenu(inputBox, meetingData[mid] || meeting);
    });
    inputBox.addEventListener('click', () => {
      const mid = activeMeetingId;
      _updateGcMentionMenu(inputBox, meetingData[mid] || meeting);
    });
    inputBox.addEventListener('blur', () => {
      setTimeout(_hideGcMentionMenu, 120);
    });
  }

  async function handleMeetingSend(text, meeting, opts = {}) {
    const current = meetingData[meeting.id] || meeting;

    // AI 群聊统一路由。
    if (current.scene) {
      const _userInputForBanner = text.trim();
      const pendingUser = _userInputForBanner
        ? _rememberPendingUserMessage(current, _userInputForBanner)
        : null;
      try {
        await ipcRenderer.invoke('meeting-append-user-turn', { meetingId: meeting.id, text });
      } catch (e) { console.warn('[meeting-room] append-user-turn failed:', e.message); }
      triggerGroupChat(current, {
        userInput: text,
        pendingClientId: pendingUser && pendingUser.clientId,
        heroIdBySid: opts.heroIdBySid || {},
      });
      return;
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

  async function buildContextSummary(meeting, excludeSessionId) {
    const others = meeting.subSessions.filter(id => id !== excludeSessionId);
    if (others.length === 0) return '';

    const lines = [];
    for (const id of others) {
      const session = sessions ? sessions.get(id) : null;
      const label = session ? (session.kind || 'session') : 'session';

      const raw = await ipcRenderer.invoke('get-ring-buffer', id);
      let content = raw ? (raw.length > 1000 ? raw.slice(-1000) : raw) : '';
      if (!content) continue;

      lines.push(`【${label}】${content}`);
    }

    if (lines.length === 0) return '';
    return `[会议室协作同步]\n${lines.join('\n')}\n---\n`;
  }

  // --- Helpers ---

  // --- Tab output state tracking ---
  function _handleTerminalActivity(sessionId) {
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
  }
  ipcRenderer.on('terminal-data', (_e, { sessionId }) => _handleTerminalActivity(sessionId));
  ipcRenderer.on('meeting-terminal-activity', (_e, { sessionId }) => _handleTerminalActivity(sessionId));

  // 归档建议到达时立刻把 chip 点亮，否则要等下一次 header 渲染才看得见。
  // 只重画 header，不弹任何东西 —— 是否归档由用户点 chip 决定。
  window.addEventListener('workspace-archive-suggestion', (event) => {
    const detail = event && event.detail;
    if (!detail || detail.scope !== 'meeting') return;
    if (!activeMeetingId || detail.id !== activeMeetingId) return;
    const meeting = meetingData[activeMeetingId];
    if (meeting) renderHeader(meeting);
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
        const cached = _gcPanelState[activeMeetingId];
        if (cached) {
          const panel = _ensureGcPanel();
          // 群聊弹顶 bug 修复（2026-06-05 道雪）：session-closed 在 CLI 崩溃时触发全量重渲,
          //   过去无 capture/restore → scrollTop=0,刚崩溃用户视觉"弹顶"信息找不回。
          const meeting = meetingData[activeMeetingId];
          const groupScroll = _captureGroupChatScroll(panel, meeting);
          _renderGcPanelInto(panel, meeting, cached, { scroll: groupScroll });
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

  // --- Expose global ---

  const meetingRoomApi = {
    init,
    openMeeting,
    closeMeetingPanel,
    getActiveMeetingId,
    getMeetingData,
    refreshSessionMetrics,
    updateMeetingData,
  };
  if (process && process.env && process.env.CLAUDE_HUB_E2E === '1') {
    meetingRoomApi.debugRenderGroupChatState = function debugRenderGroupChatState(meetingId, state) {
      const meeting = meetingData[meetingId];
      if (!meeting || !_isPanelCapableMeeting(meeting)) return { ok: false, reason: 'meeting_not_found' };
      const panel = _ensureGcPanel();
      _gcPanelState[meetingId] = state || {};
      _renderGcPanelInto(panel, meeting, _gcPanelState[meetingId]);
      return { ok: true, text: panel.innerText || '' };
    };
  }
  window.MeetingRoom = meetingRoomApi;

})();

// Node 测试环境兼容（renderer 真实运行时为 IIFE 浏览器环境，typeof module 为 undefined 走不到这）
if (typeof module !== 'undefined' && module.exports) {
  // 让 unit test 能 require 到 _isPartialUnchanged。这种"双模兼容"模式同 group-chat modules。
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
