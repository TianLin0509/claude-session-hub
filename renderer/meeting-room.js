// renderer/meeting-room.js
// Meeting Room UI — manages the parallel terminal panel.
// Exposes global `MeetingRoom` object consumed by renderer.js.

(function () {
  const { ipcRenderer } = require('electron');

  let activeMeetingId = null;
  let meetingData = {};
  let subTerminals = {};
  let _markerStatusCache = {};
  let _markerPollTimer = null;
  const _tabState = {};     // { sessionId: 'streaming'|'new-output'|'idle'|'error' }
  const _tabTimers = {};    // { sessionId: silenceTimerId }

  // renderer.js loads before us — its `sessions` and `getOrCreateTerminal`
  // are accessible via the global lexical scope. We access them directly.

  // 两个圆桌模式(general/research)在 UI 渲染上完全一致(卡片+CLI)。
  // 与 core/meeting-room.js 的 isRoundtableCapableMeeting 语义一致。
  function _isPanelCapableMeeting(m) {
    return !!(m && (m.researchMode || m.roundtableMode));
  }

  // --- Roundtable @command parser ---
  // 支持 @debate / @summary @<who> / @all / @<who> 单聊
  function parseRoundtableCommand(text, meeting) {
    if (!meeting) return { type: 'normal', text, targets: null };

    // Research mode: 三家平等圆桌，独立语法（@debate / @summary @<who> / 默认 fanout）
    if (meeting.researchMode) {
      let rest = text.trim();
      const summaryRe = /^@summary\s+@(claude|gemini|codex)\b\s*/i;
      const debateRe = /^@debate\b\s*/i;
      let m;
      if ((m = rest.match(summaryRe))) {
        return { type: 'rt-summary', summarizerKind: m[1].toLowerCase(), text: rest.slice(m[0].length) };
      }
      if ((m = rest.match(debateRe))) {
        return { type: 'rt-debate', text: rest.slice(m[0].length) };
      }
      return { type: 'rt-fanout', text: rest };
    }

    // 通用圆桌：默认 fanout，新增 @<who> 单聊语义
    if (meeting.roundtableMode) {
      let rest = text.trim();
      const summaryRe = /^@summary\s+@(claude|gemini|codex)\b\s*/i;
      let m;
      // 注意：`@summary` 必须带 `@<who>` 才会路由到 rt-summary，未带 @<who> 时本 regex 不匹配，
      // fall through 到下面的 @<who>/@all/纯文本逻辑。结果通常是 rt-fanout，原文照发给三家。
      // 这是 spec 默认行为；UI 友好提示见后续 Phase 增强。
      if ((m = rest.match(summaryRe))) {
        return { type: 'rt-summary', summarizerKind: m[1].toLowerCase(), text: rest.slice(m[0].length) };
      }
      const debateRe = /^@debate\b\s*/i;
      if ((m = rest.match(debateRe))) {
        return { type: 'rt-debate', text: rest.slice(m[0].length) };
      }
      const allRe = /^@all\b\s*/i;
      if ((m = rest.match(allRe))) {
        return { type: 'rt-fanout', text: rest.slice(m[0].length) };
      }
      // @<who> 单家或多家但非全员 → 私聊
      const targets = [];
      const tokenRe = /^@(claude|gemini|codex)\b\s*/i;
      while (true) {
        const t = rest.match(tokenRe);
        if (!t) break;
        const tok = t[1].toLowerCase();
        if (!targets.includes(tok)) targets.push(tok);
        rest = rest.slice(t[0].length);
      }
      if (targets.length === 3) {
        return { type: 'rt-fanout', text: rest };
      }
      if (targets.length > 0) {
        return { type: 'rt-private', targetKinds: targets, text: rest };
      }
      return { type: 'rt-fanout', text: rest };
    }

    return { type: 'normal', text, targets: null };
  }

  // --- Roundtable Mode: 持久化圆桌面板（始终显示当前状态 + 历史）---
  // _rtPanelState[meetingId] 缓存渲染状态，避免 IPC 频繁调用
  // partialBy: 当前进行中轮次的部分回答 { sid: { text, status } } — 单家完成立即更新
  const _rtPanelState = {};
  let _rtHistoryExpanded = false;
  // 私聊计数缓存：{ [meetingId]: { claude: N, gemini: N, codex: N } }
  // 在 refreshRoundtablePanel 里 best-effort 拉，用于卡片右上角 💬 角标
  const _privateCountCache = {};

  // markdown 渲染（用项目已有的 marked + DOMPurify）
  let _markedCache = null;
  let _domPurifyCache = null;
  function _renderMarkdown(text) {
    if (!text) return '';
    try {
      if (!_markedCache) _markedCache = require('marked').marked;
      if (!_domPurifyCache) _domPurifyCache = require('dompurify');
      return _domPurifyCache.sanitize(_markedCache.parse(text, { breaks: true, gfm: true }));
    } catch (e) {
      // 回退到纯文本（escapeHtml）
      return escapeHtml(text).replace(/\n/g, '<br>');
    }
  }

  // --- Two-state mode toggle (圆桌 / 投研) ---

  function _renderModeToggle(meeting) {
    if (!meeting) return '';
    const isRoundtable = !!meeting.roundtableMode;
    const isResearch = !!meeting.researchMode;
    return `
      <div class="mr-mode-toggle" role="radiogroup" aria-label="会议模式">
        <button type="button" class="mr-mode-btn ${isRoundtable ? 'active' : ''}" data-mode="roundtable" title="通用圆桌：三家平等讨论">圆桌</button>
        <button type="button" class="mr-mode-btn ${isResearch ? 'active' : ''}" data-mode="research" title="投研圆桌：A 股专题">投研</button>
      </div>
    `;
  }

  function _bindModeToggle(rootEl, meeting) {
    if (!rootEl || !meeting) return;
    rootEl.querySelectorAll('.mr-mode-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const mode = btn.getAttribute('data-mode');
        if (!mode) return;
        try {
          // 切到非 roundtable 时，先调 toggle-roundtable-mode 把 roundtableMode 标志置 false。
          // 注意：enabled=false 只切状态字段，不清理文件——prompt/covenant/private 文件统一在
          // close-meeting 时清理，避免用户切换模式查看其他视图时丢私聊历史。
          if (meeting.roundtableMode && mode !== 'roundtable') {
            try {
              await ipcRenderer.invoke('toggle-roundtable-mode', { meetingId: meeting.id, enabled: false });
            } catch (e) {
              console.warn('[mode-toggle] roundtable cleanup failed (continuing anyway):', e.message);
            }
          }
          if (mode === 'roundtable') {
            // 通用圆桌：走 toggle-roundtable-mode（含 prompt 文件写盘 + mutex 互斥）
            const res = await ipcRenderer.invoke('toggle-roundtable-mode', { meetingId: meeting.id, enabled: true });
            if (res && !res.ok) console.warn('[mode-toggle] roundtable failed:', res.error);
          } else if (mode === 'research') {
            const covenantText = (meeting.covenantText && typeof meeting.covenantText === 'string') ? meeting.covenantText : '';
            const ok = await ipcRenderer.invoke('update-meeting-sync', { meetingId: meeting.id, fields: { researchMode: true, covenantText } });
            if (!ok) console.warn('[mode-toggle] research failed: update-meeting-sync returned falsy');
          }
        } catch (e) {
          console.warn('[mode-toggle] click failed:', e.message);
        }
      });
    });
  }

  function _ensureRtPanel() {
    let panel = document.getElementById('mr-roundtable-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'mr-roundtable-panel';
      panel.className = 'mr-rt-panel';
      const container = terminalsEl();
      if (container && container.parentElement) container.parentElement.insertBefore(panel, container);
    }
    return panel;
  }

  function _removeRtPanel() {
    const p = document.getElementById('mr-roundtable-panel');
    if (p && p.parentElement) p.remove();
  }

  // sub session 信息（kind/label/sid）— 用于把 by 字段映射到三家卡片
  function _getRtSubInfo(meeting) {
    const subs = { claude: null, gemini: null, codex: null };
    if (!meeting || !meeting.subSessions) return subs;
    for (const sid of meeting.subSessions) {
      const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      if (!s) continue;
      if (s.kind === 'claude' && !subs.claude) subs.claude = { sid, label: s.title || 'Claude' };
      else if (s.kind === 'gemini' && !subs.gemini) subs.gemini = { sid, label: s.title || 'Gemini' };
      else if (s.kind === 'codex' && !subs.codex) subs.codex = { sid, label: s.title || 'Codex' };
    }
    return subs;
  }

  function _renderRtCards(state, subs, currentMode, partialBy, meeting) {
    const lastTurn = state.turns.length > 0 ? state.turns[state.turns.length - 1] : null;
    const summarizerKind = state.currentSummarizerKind || null;
    const cards = [];
    const meetingId = meeting && meeting.id;
    const countMap = (meetingId && _privateCountCache[meetingId]) || {};
    for (const kind of ['claude', 'gemini', 'codex']) {
      const sub = subs[kind];
      if (!sub) continue;
      // 优先级：partialBy（in-progress 单家完成） > lastTurn.by（已完整持久化的轮）
      const partial = partialBy ? partialBy[sub.sid] : null;
      let status = 'idle';
      let preview = '';
      let isStandby = false; // summary 轮非 summarizer 卡片的"维持上轮预览"状态

      if (partial) {
        // 当前轮已收到这家的部分结果
        status = partial.status === 'timeout' ? 'timeout' : 'completed';
        preview = partial.text || '';
      } else if (currentMode && currentMode !== 'idle') {
        // 当前正在跑某轮但本家还没回
        if (currentMode === 'summary' && summarizerKind && summarizerKind !== kind) {
          // 非 summarizer：保持上一轮（debate）的回答展示，不进入 thinking
          status = lastTurn && lastTurn.by[sub.sid] ? 'completed' : 'idle';
          preview = lastTurn ? (lastTurn.by[sub.sid] || '') : '';
          isStandby = true;
        } else {
          status = 'thinking';
          // 思考中也展示上一轮预览（保留历史）
          preview = lastTurn ? (lastTurn.by[sub.sid] || '') : '';
        }
      } else if (lastTurn && lastTurn.by[sub.sid]) {
        status = 'completed';
        preview = lastTurn.by[sub.sid];
      }

      const isSummarizer = currentMode === 'summary' && summarizerKind === kind;
      const statusLabel = { idle: '待命', thinking: '思考中', completed: '已答', timeout: '超时' }[status] || status;
      const previewClipped = preview ? preview.slice(0, 600) : '';
      const previewHtml = preview
        ? `<div class="mr-rt-card-preview">${_renderMarkdown(previewClipped)}${preview.length > 600 ? '<div class="mr-rt-card-more">… 点卡片看全文</div>' : ''}</div>`
        : '<div class="mr-rt-card-empty">尚无回答</div>';
      const labelDisplay = { claude: 'Claude', gemini: 'Gemini', codex: 'Codex' }[kind];
      const cardCls = ['mr-rt-card', kind];
      if (status === 'thinking') cardCls.push('active');
      if (isSummarizer) cardCls.push('summarizer');
      if (isStandby) cardCls.push('standby');
      const summarizerBadge = isSummarizer
        ? '<span class="mr-rt-summarizer-badge" title="本轮总结人">★ 总结人</span>'
        : '';
      const standbyHint = isStandby
        ? '<span class="mr-rt-standby-hint">上轮回答（等总结）</span>'
        : '';
      const privateCount = countMap[kind] || 0;
      const privateBadge = privateCount > 0
        ? `<span class="mr-rt-private-badge" title="有 ${privateCount} 条私聊">💬 ${privateCount}</span>`
        : '';
      cards.push(`<div class="${cardCls.join(' ')}" data-rt-sid="${sub.sid}" data-rt-kind="${kind}" role="button" tabindex="0" title="点击查看 ${labelDisplay} 的全部历史回答">
        <div class="mr-rt-card-head">
          <span class="mr-rt-card-name">${labelDisplay}${summarizerBadge}${privateBadge}</span>
          <span class="mr-rt-status ${status}">${statusLabel}${standbyHint}</span>
        </div>
        ${previewHtml}
      </div>`);
    }
    return cards.join('');
  }

  function _renderRtHistory(state) {
    if (!state.turns || state.turns.length === 0) return '';
    const items = state.turns.map(t => {
      const userIn = (t.userInput || '').slice(0, 60);
      const meta = t.decisionTitle ? ` · 标题: ${escapeHtml(t.decisionTitle.slice(0, 40))}` : '';
      return `<div class="mr-rt-history-item">
        <span class="mr-rt-history-turn">第 ${t.n} 轮</span>
        <span class="mr-rt-history-mode ${escapeHtml(t.mode)}">${escapeHtml(t.mode)}</span>
        <span class="mr-rt-history-input">${escapeHtml(userIn)}${(t.userInput || '').length > 60 ? '…' : ''}</span>
        <span class="mr-rt-history-meta">${meta}</span>
      </div>`;
    }).join('');
    const expanded = _rtHistoryExpanded;
    const toggle = `<span class="mr-rt-history-toggle" id="mr-rt-history-toggle">${expanded ? '▾' : '▸'} 历史轮次（${state.turns.length}）</span>`;
    return `<div class="mr-rt-history">
      ${toggle}
      <div class="mr-rt-history-list" style="display:${expanded ? 'flex' : 'none'}">${items}</div>
    </div>`;
  }

  function _renderRtPanelHtml(state, meeting) {
    const subs = _getRtSubInfo(meeting);
    const mode = state.currentMode || 'idle';
    const modeLabel = { idle: '待命', fanout: '提问中', debate: '辩论中', summary: '综合中' }[mode] || mode;
    const partialBy = state._partialBy || null;
    const cards = _renderRtCards(state, subs, mode, partialBy, meeting);
    const history = _renderRtHistory(state);
    // 首发提醒：完成过 1 轮后消失
    const firstRunHint = state.turns.length === 0
      ? `<div class="mr-rt-firstrun-hint">⏱ <strong>首次发送较慢</strong>（约 25 秒）— 三家 CLI 需要冷启动 + OAuth 验证。后续轮次会快很多。</div>`
      : '';
    const titleText = meeting && meeting.researchMode ? '投研圆桌' : '圆桌讨论';
    return `
      <div class="mr-rt-header">
        <span class="mr-rt-title">${titleText}</span>
        <span class="mr-rt-meta">
          <span>已 ${state.turns.length} 轮</span>
          <span class="mr-rt-mode-tag ${mode}">${escapeHtml(modeLabel)}</span>
        </span>
      </div>
      ${firstRunHint}
      <div class="mr-rt-cards">${cards}</div>
      ${history}
    `;
  }

  // 主渲染：从 IPC 拿最新 state 后重绘。
  // 乐观字段（currentMode/currentSummarizerKind）的保留条件：**只有 _rtOptimisticTurn[id] 还在**
  // —— 也就是 IPC 还在飞行中。IPC resolve 后 _rtOptimisticTurn 已被 clearOptimistic 清，
  // 此时 server state 真实状态（含 idle）才被采纳。
  // partialBy 单独保留：轮中单家完成 IPC 推 partial-update，这是轮内增量，独立处理。
  async function refreshRoundtablePanel(meeting) {
    if (!_isPanelCapableMeeting(meeting)) { _removeRtPanel(); return; }
    let state;
    try {
      state = await ipcRenderer.invoke('roundtable:get-state', { meetingId: meeting.id });
    } catch (e) {
      console.error('[roundtable] get-state failed:', e.message);
      return;
    }
    if (!state) return;
    // 私聊计数缓存（best-effort，不阻塞 panel 渲染）
    try {
      const counts = await ipcRenderer.invoke('roundtable-private:list', { meetingId: meeting.id });
      _privateCountCache[meeting.id] = {
        claude: ((counts && counts.claude) || []).length,
        gemini: ((counts && counts.gemini) || []).length,
        codex:  ((counts && counts.codex)  || []).length,
      };
    } catch (e) {
      console.warn('[meeting-room] private count cache refresh failed:', e.message);
    }
    const prev = _rtPanelState[meeting.id];
    const optimistic = _rtOptimisticTurn[meeting.id];
    if (optimistic && (!state.currentMode || state.currentMode === 'idle')) {
      // IPC 飞行期间 + server 还没 begin → 显示乐观态
      state.currentMode = optimistic.mode;
      if (optimistic.summarizerKind) state.currentSummarizerKind = optimistic.summarizerKind;
    }
    // partialBy 独立保留（轮中增量，不依赖 optimistic 标记）
    if (prev && prev._partialBy) state._partialBy = prev._partialBy;
    _rtPanelState[meeting.id] = state;
    const panel = _ensureRtPanel();
    panel.innerHTML = _renderRtPanelHtml(state, meeting);
    _bindRtPanelEvents(panel, meeting);
  }

  // 绑定 panel 内部所有交互（折叠 / 卡片点击）。每次 innerHTML 重绘后都要重新调用。
  function _bindRtPanelEvents(panel, meeting) {
    const toggle = panel.querySelector('#mr-rt-history-toggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        _rtHistoryExpanded = !_rtHistoryExpanded;
        refreshRoundtablePanel(meeting);
      });
    }
    panel.querySelectorAll('.mr-rt-card[data-rt-sid]').forEach(card => {
      const open = () => {
        const sid = card.getAttribute('data-rt-sid');
        const kind = card.getAttribute('data-rt-kind');
        _openRtTimeline(meeting, sid, kind);
      };
      card.addEventListener('click', open);
      card.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
      });
    });
  }

  // ---- AI 时间线浮层 ----------------------------------------------------
  // 点击任意卡片 → 打开右侧抽屉，顶部 Tab 列轮次（最新在最左 = 默认 active），点 Tab 切换内容。
  function _openRtTimeline(meeting, sid, kind) {
    const state = _rtPanelState[meeting.id];
    if (!state || !Array.isArray(state.turns)) return;

    const labelDisplay = { claude: 'Claude', gemini: 'Gemini', codex: 'Codex' }[kind] || kind;
    const subs = _getRtSubInfo(meeting);
    const sub = subs[kind];
    const headerLabel = sub && sub.label ? sub.label : labelDisplay;

    // 收集该 sid 有回答的轮次，按 turn n 倒序（最新在最左）
    const turnsWithAns = state.turns
      .filter(t => (t.by || {})[sid])
      .sort((a, b) => b.n - a.n);

    let overlay = document.getElementById('mr-rt-timeline-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'mr-rt-timeline-overlay';
      overlay.className = 'mr-rt-tl-overlay';
      document.body.appendChild(overlay);
    }

    const renderTurnBody = (turn) => {
      if (!turn) return '<div class="mr-rt-tl-empty">该 AI 还没有可显示的历史回答。</div>';
      const text = (turn.by || {})[sid] || '';
      const userIn = (turn.userInput || '').trim();
      const userBlock = userIn
        ? `<div class="mr-rt-tl-user">用户输入：${escapeHtml(userIn.slice(0, 400))}${userIn.length > 400 ? '…' : ''}</div>`
        : '';
      const decisionTag = turn.decisionTitle
        ? `<div class="mr-rt-tl-decision-row">📌 决策标题：${escapeHtml(turn.decisionTitle)}</div>`
        : '';
      return `${decisionTag}${userBlock}<div class="mr-rt-tl-body">${_renderMarkdown(text)}</div>`;
    };

    const tabsHtml = turnsWithAns.map((t, i) => {
      const modeLabel = { fanout: '提问', debate: '辩论', summary: '综合' }[t.mode] || t.mode;
      const isLatest = i === 0;
      return `<button type="button" class="mr-rt-tl-tab ${isLatest ? 'active' : ''}" data-tab-idx="${i}" title="第 ${t.n} 轮 · ${escapeHtml(modeLabel)}">
        <span class="mr-rt-tl-tab-turn">第 ${t.n} 轮</span>
        <span class="mr-rt-tl-tab-mode ${escapeHtml(t.mode)}">${escapeHtml(modeLabel)}</span>
        ${isLatest ? '<span class="mr-rt-tl-tab-latest">最新</span>' : ''}
      </button>`;
    }).join('');

    // 私聊 tab：放最右，data-tab-idx = turnsWithAns.length 作为哨兵
    // C1：仅在通用圆桌（roundtableMode）下展示。投研圆桌（researchMode）无私聊概念，
    // roundtable-private:list 不为 research 路由记录数据，展示空 tab 会破坏现有投研 UX。
    const showsPrivate = !!(meeting && meeting.roundtableMode);
    const privateTabIdx = turnsWithAns.length;
    const privateTabHtml = showsPrivate ? `<button type="button" class="mr-rt-tl-tab private" data-tab-idx="${privateTabIdx}" title="${escapeHtml(headerLabel)} 的私聊历史">
      <span class="mr-rt-tl-tab-turn">💬 私聊</span>
    </button>` : '';
    const tabsHtmlWithPrivate = tabsHtml + privateTabHtml;
    const hasAnyTab = turnsWithAns.length > 0 || showsPrivate;

    overlay.innerHTML = `
      <div class="mr-rt-tl-backdrop" data-rt-tl-close="1"></div>
      <aside class="mr-rt-tl-drawer mr-rt-tl-${escapeHtml(kind)}" role="dialog" aria-label="${escapeHtml(headerLabel)} 时间线">
        <header class="mr-rt-tl-drawer-head">
          <span class="mr-rt-tl-drawer-title">${escapeHtml(headerLabel)} · 历史回答</span>
          <span class="mr-rt-tl-drawer-meta">共 ${turnsWithAns.length} 轮</span>
          <button type="button" class="mr-rt-tl-close" data-rt-tl-close="1" aria-label="关闭">×</button>
        </header>
        ${hasAnyTab ? `<nav class="mr-rt-tl-tabs" role="tablist">${tabsHtmlWithPrivate}</nav>` : ''}
        <div class="mr-rt-tl-content" id="mr-rt-tl-content">${renderTurnBody(turnsWithAns[0])}</div>
      </aside>
    `;
    overlay.style.display = 'block';

    // Tab 切换：私聊 tab（idx === privateTabIdx）异步拉 list；其他 tab 走 renderTurnBody
    const contentEl = overlay.querySelector('#mr-rt-tl-content');
    const renderTurnOrPrivate = async (idx) => {
      // showsPrivate=false 时不应渲染私聊 tab；防御一手即使 idx 命中哨兵也走普通分支
      if (showsPrivate && idx === privateTabIdx) {
        let list = [];
        try {
          list = await ipcRenderer.invoke('roundtable-private:list', { meetingId: meeting.id, kind });
        } catch (e) {
          console.warn('[meeting-room] private list fetch failed:', e.message);
        }
        if (!Array.isArray(list) || list.length === 0) {
          return '<div class="mr-rt-tl-empty">尚无与该 AI 的私聊。</div>';
        }
        return list.map(turn => {
          const ans = turn.response || '';
          const userIn = turn.userInput || '';
          const ts = turn.ts ? new Date(turn.ts).toLocaleString() : '';
          return `<div class="mr-rt-tl-private-item">
            <div class="mr-rt-tl-user">用户：${escapeHtml(userIn)}</div>
            ${ans ? `<div class="mr-rt-tl-body">${_renderMarkdown(ans)}</div>` : ''}
            <div class="mr-rt-tl-private-ts">${escapeHtml(ts)}</div>
          </div>`;
        }).join('');
      }
      return renderTurnBody(turnsWithAns[idx]);
    };

    overlay.querySelectorAll('.mr-rt-tl-tab').forEach(btn => {
      btn.addEventListener('click', async () => {
        overlay.querySelectorAll('.mr-rt-tl-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const idx = parseInt(btn.getAttribute('data-tab-idx') || '0', 10);
        if (contentEl) {
          contentEl.innerHTML = '<div class="mr-rt-tl-loading">加载中…</div>';
          const result = await renderTurnOrPrivate(idx);
          // 防御异步竞态：私聊 tab 走 IPC，await 期间用户若已切换到其他 tab，
          // 此处会用过期数据覆盖新渲染，故先校验 active 标志
          if (!btn.classList.contains('active')) return;
          contentEl.innerHTML = result;
          contentEl.scrollTop = 0;
        }
      });
    });

    const closeAll = () => {
      overlay.style.display = 'none';
      document.removeEventListener('keydown', escHandler);
    };
    const escHandler = (ev) => { if (ev.key === 'Escape') closeAll(); };
    overlay.querySelectorAll('[data-rt-tl-close]').forEach(el => {
      el.addEventListener('click', closeAll);
    });
    document.addEventListener('keydown', escHandler);
  }

  // 乐观态生命周期：renderer 在 IPC 飞行期间用 _rtOptimisticTurn 标记自己写的乐观字段，
  // 一旦 IPC resolve / reject 或 server 推 turn-complete，就清掉这个标记 —— 之后 refresh
  // 拿到的 server state（含 idle）就是真值，merge 不再覆盖。
  // 不用单纯依赖 cached.currentMode 比对，避免轮次完成后 server.idle 被永远 merge 成乐观值。
  const _rtOptimisticTurn = {}; // { [meetingId]: { mode, summarizerKind, t } }

  // 兼容旧调用名（handleMeetingSend 还在用 renderRoundtableBanner）
  function renderRoundtableBanner(meeting, result) {
    refreshRoundtablePanel(meeting);
    const cached = _rtPanelState[meeting.id];
    if (cached) renderToolbar(meeting);
  }

  // 投研圆桌触发器：按钮/输入框统一入口。立即给 UI pending 反馈，再异步 invoke IPC。
  function triggerRoundtable(meeting, mode, opts = {}) {
    const cached = _rtPanelState[meeting.id];
    // 立即写本地乐观状态 + 标 _rtOptimisticTurn（IPC 完成后清掉）
    _rtOptimisticTurn[meeting.id] = {
      mode,
      summarizerKind: mode === 'summary' ? (opts.summarizerKind || 'claude') : null,
      t: Date.now(),
    };
    if (cached) {
      cached.currentMode = mode;
      if (mode === 'summary') {
        cached.currentSummarizerKind = opts.summarizerKind || 'claude';
      } else {
        delete cached.currentSummarizerKind;
      }
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
        delete c.currentSummarizerKind;
      }
      refreshRoundtablePanel(meeting);
      renderToolbar(meeting);
    };

    ipcRenderer.invoke('roundtable:turn', {
      meetingId: meeting.id,
      mode,
      userInput: opts.userInput || '',
      summarizerKind: opts.summarizerKind || null,
    }).then((result) => {
      // 不论 completed / busy / error / no_sent，IPC 已返回 → 清乐观态，后续完全信任 server
      console.log('[roundtable] turn IPC resolved:', result && result.status, 'turn=', result && result.turnNum);
      clearOptimistic();
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
  ipcRenderer.on('roundtable-turn-complete', (_event, { meetingId }) => {
    const meeting = meetingData[meetingId];
    if (_isPanelCapableMeeting(meeting) && meetingId === activeMeetingId) {
      delete _rtOptimisticTurn[meetingId];
      const cached = _rtPanelState[meetingId];
      if (cached) {
        cached._partialBy = null;
        // 让 refresh 用 server 真值（idle）覆盖
        cached.currentMode = null;
        delete cached.currentSummarizerKind;
      }
      refreshRoundtablePanel(meeting);
      if (cached) renderToolbar(meeting);
    }
  });

  // Roundtable state 元数据变更（如 summary 启动写入 currentSummarizerKind）
  ipcRenderer.on('roundtable-state-update', (_event, { meetingId }) => {
    const meeting = meetingData[meetingId];
    if (_isPanelCapableMeeting(meeting) && meetingId === activeMeetingId) {
      refreshRoundtablePanel(meeting);
    }
  });

  // Roundtable 单家 partial-update：单卡片立即刷新，不等所有家完成
  ipcRenderer.on('roundtable-partial-update', (_event, { meetingId, sid, status, text }) => {
    const meeting = meetingData[meetingId];
    if (!_isPanelCapableMeeting(meeting) || meetingId !== activeMeetingId) return;
    const cached = _rtPanelState[meetingId];
    if (!cached) {
      // 首次：直接 refresh（拉 state），下次 partial 才能本地更新
      refreshRoundtablePanel(meeting);
      return;
    }
    if (!cached._partialBy) cached._partialBy = {};
    cached._partialBy[sid] = { text: text || '', status: status || 'completed' };
    // 直接本地重渲染（不调 IPC，省一次 round-trip）
    const panel = _ensureRtPanel();
    panel.innerHTML = _renderRtPanelHtml(cached, meeting);
    _bindRtPanelEvents(panel, meeting);
  });

  const panelEl = () => document.getElementById('meeting-room-panel');
  const headerEl = () => document.getElementById('mr-header');
  const terminalsEl = () => document.getElementById('mr-terminals');
  const toolbarEl = () => document.getElementById('mr-toolbar');
  const inputBoxEl = () => document.getElementById('mr-input-box');
  const sendBtnEl = () => document.getElementById('mr-send-btn');

  function init() {
    // no-op — kept for backward compat; refs resolved lazily
  }

  function openMeeting(meetingId, meeting) {
    activeMeetingId = meetingId;
    meetingData[meetingId] = meeting;

    const panel = panelEl();
    panel.style.display = 'flex';

    renderHeader(meeting);
    renderTerminals(meeting);
    renderToolbar(meeting);
    setupInput(meeting);
    startMarkerPoll();

    // 两模式(通用/投研)进入会议室即刷新持久化面板
    if (_isPanelCapableMeeting(meeting)) {
      refreshRoundtablePanel(meeting);
    } else {
      _removeRtPanel();
    }
  }

  function closeMeetingPanel() {
    activeMeetingId = null;
    _inputBound = false;
    stopMarkerPoll();
    _markerStatusCache = {};
    const panel = panelEl();
    if (panel) panel.style.display = 'none';
    const el = terminalsEl();
    if (el) el.innerHTML = '';
    subTerminals = {};
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
        // 模式切换需强制重建终端 DOM：roundtableMode 时 renderTerminals 会清空 #mr-terminals，
        // 切回 research 时 a0561e3 的可见性切换只能 un-hide 容器但内部仍是空的，
        // 必须 force re-render 才能恢复 xterm 实例。
        const modeChanged = prev && (
          (prev.roundtableMode || false) !== (updated.roundtableMode || false) ||
          (prev.researchMode || false) !== (updated.researchMode || false)
        );
        if (prevSubs !== newSubs || modeChanged) {
          renderTerminals(updated);
          setupInput(updated);
        }
      }
    } catch (e) {
      console.error('[meeting-room] updateMeetingData error:', e);
    } finally {
      _updating = false;
    }
  }

  // --- Header ---

  function renderHeader(meeting) {
    const el = headerEl();
    if (!el) return;
    const focused = meeting.focusedSub || meeting.subSessions[0];

    let tabsHtml = '';
    if (meeting.layout === 'focus' && meeting.subSessions.length > 0) {
      const tabs = meeting.subSessions.map(sid => {
        const s = sessions ? sessions.get(sid) : null;
        const label = s ? (s.title || s.kind) : 'session';
        const badges = subModelBadgeHtml(s) + subCtxBadgeHtml(s);
        const cls = sid === focused ? 'mr-tab active' : 'mr-tab';
        const state = _tabState[sid] || 'idle';
        const markerBadge = markerStatusHtml(sid);
        const statusDot = `<span class="mr-tab-status ${state}"></span>`;
        const newBadge = state === 'new-output' ? ' <span class="new-badge">NEW</span>' : '';
        const hasNewCls = state === 'new-output' ? ' has-new' : '';
        return `<button class="${cls}${hasNewCls}" data-sid="${sid}">${statusDot}${escapeHtml(label)}${badges ? ' ' + badges : ''} ${markerBadge}${newBadge}</button>`;
      }).join('');
      tabsHtml = `<div class="mr-tabs" id="mr-tabs">${tabs}</div>`;
    }

    // 两模式(通用/投研)统一隐藏 Focus/Blackboard 按钮:
    // 卡片+CLI 是唯一布局,blackboard 已彻底废弃。
    const showLayoutButtons = !_isPanelCapableMeeting(meeting);
    const layoutButtonsHtml = showLayoutButtons ? `
        <button class="mr-header-btn ${meeting.layout === 'focus' ? 'active' : ''}" id="mr-btn-focus">Focus</button>` : '';

    el.innerHTML = `
      <div class="mr-header-left">
        ${_renderModeToggle(meeting)}
        <span class="mr-header-title" id="mr-title">${escapeHtml(meeting.title)}</span>
        ${tabsHtml}
      </div>
      <div class="mr-header-right">${layoutButtonsHtml}
        <button class="mr-header-btn" id="mr-btn-add-sub" title="添加子会话">+ 添加</button>
        <button class="btn-zoom btn-memo-toggle ${typeof localStorage !== 'undefined' && localStorage.getItem('claude-hub-memo-open') === 'true' ? 'active' : ''}" id="mr-btn-memo" title="Toggle memo panel"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v9a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5v-9zM4 5h8M4 8h8M4 11h5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/></svg></button>
        <button class="btn-zoom" id="mr-btn-zoom-out" title="Shrink UI">A−</button>
        <button class="btn-zoom" id="mr-btn-zoom-in" title="Enlarge UI">A+</button>
        <button class="btn-close-session" id="mr-btn-close" title="关闭会议室" aria-label="Close meeting"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg></button>
      </div>
    `;

    const focusBtn = document.getElementById('mr-btn-focus');
    if (focusBtn) focusBtn.addEventListener('click', () => setLayout(meeting.id, 'focus'));
    document.getElementById('mr-btn-add-sub').addEventListener('click', () => showAddSubMenu(meeting.id));
    _bindModeToggle(el, meeting);
    document.getElementById('mr-btn-memo').addEventListener('click', () => { if (typeof toggleMemoPanel === 'function') toggleMemoPanel(); });
    document.getElementById('mr-btn-zoom-out').addEventListener('click', () => { if (typeof applyZoom === 'function') applyZoom(currentZoom - 1); });
    document.getElementById('mr-btn-zoom-in').addEventListener('click', () => { if (typeof applyZoom === 'function') applyZoom(currentZoom + 1); });
    document.getElementById('mr-btn-close').addEventListener('click', async () => {
      await ipcRenderer.invoke('close-meeting', meeting.id);
      closeMeetingPanel();
    });

    // Focus mode tab click → switch focused sub-session
    const tabsEl = document.getElementById('mr-tabs');
    if (tabsEl) {
      tabsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.mr-tab');
        if (!btn) return;
        const sid = btn.dataset.sid;
        if (sid && sid !== focused) {
          _tabState[sid] = 'idle';
          if (_tabTimers[sid]) { clearTimeout(_tabTimers[sid]); delete _tabTimers[sid]; }
          meeting.focusedSub = sid;
          ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { focusedSub: sid } });
          switchFocusTab(meeting, sid);
          renderHeader(meeting);
        }
      });
    }

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

    const kinds = [
      { kind: 'claude', label: 'Claude Code' },
      { kind: 'gemini', label: 'Gemini CLI' },
      { kind: 'codex', label: 'Codex CLI' },
      { kind: 'deepseek', label: 'DeepSeek' },
      { kind: 'powershell', label: 'PowerShell' },
    ];

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
    // 通用圆桌:卡片+CLI 是全部 UI,隐藏 xterm 容器。
    // 投研圆桌:保持 xterm + panel 双视图(C1 红线,用户最满意的形态,不动)。
    if (meeting && meeting.roundtableMode) {
      container.classList.add('mr-terminals-hidden');
    } else {
      container.classList.remove('mr-terminals-hidden');
    }
  }

  function renderTerminals(meeting) {
    const container = terminalsEl();
    if (!container) return;
    for (const cached of Object.values(subTerminals)) {
      if (cached && cached.container && cached.container.parentElement) {
        cached.container.parentElement.removeChild(cached.container);
      }
    }
    container.innerHTML = '';
    applyModeContainerVisibility(meeting, container);
    // 通用圆桌:卡片+CLI 由 refreshRoundtablePanel 渲染,xterm 不渲染。
    // 投研圆桌:保留 xterm 渲染(C1 不动)。
    if (meeting && meeting.roundtableMode) {
      subTerminals = {};
      return;
    }
    container.className = 'mr-terminals focus-mode';
    subTerminals = {};
    renderFocusMode(meeting, container);
  }

  function openSubTerminal(sessionId) {
    const cached = subTerminals[sessionId];
    if (!cached || !cached.terminal || !cached.container) return;
    if (!cached.container.querySelector('.xterm-screen')) {
      cached.terminal.open(cached.container);
      cached.opened = true;
      if (typeof loadGpuRenderer === 'function') loadGpuRenderer(cached);
    }
    cached.terminal.refresh(0, cached.terminal.rows - 1);
    // Sync scroll area to prevent stale scrollHeight locking
    try {
      const vpInst = cached.terminal._core && cached.terminal._core.viewport;
      if (vpInst && typeof vpInst.syncScrollArea === 'function') {
        vpInst.syncScrollArea(true);
      }
    } catch (_) {}
    cached.terminal.scrollToBottom();
    const vp = cached.container.querySelector('.xterm-viewport');
    if (vp) vp.scrollTop = vp.scrollHeight;
  }

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
        termContainer.appendChild(cached.container);
        subTerminals[sessionId] = cached;
      }
    }

    slot.addEventListener('contextmenu', (e) => {
      handleQuoteContext(e, meeting, sessionId);
    });

    return slot;
  }

  function fitSubTerminal(sessionId) {
    const cached = subTerminals[sessionId];
    if (!cached || !cached.fitAddon) return;
    try {
      cached.fitAddon.fit();
      ipcRenderer.send('terminal-resize', {
        sessionId,
        cols: cached.terminal.cols,
        rows: cached.terminal.rows,
      });
    } catch (_) {}
  }

  function mountSubTerminal(sessionId) {
    if (!activeMeetingId || typeof getOrCreateTerminal !== 'function') return;
    const slot = document.querySelector(`.mr-sub-slot[data-session-id="${sessionId}"]`);
    if (!slot) return;
    slot.classList.remove('dormant');
    const termContainer = slot.querySelector('.mr-sub-terminal');
    if (!termContainer || termContainer.querySelector('.xterm')) return;
    const cached = getOrCreateTerminal(sessionId);
    if (cached && cached.container) {
      cached.container.style.display = 'block';
      termContainer.appendChild(cached.container);
      subTerminals[sessionId] = cached;
      openSubTerminal(sessionId);
      requestAnimationFrame(() => fitSubTerminal(sessionId));
    }
  }

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

  // rAF-loop until container has real width, then fit + resize PTY
  function robustFit(sessionId) {
    const _refit = () => {
      const cached = subTerminals[sessionId];
      if (!cached || !cached.fitAddon) return;
      const el = cached.container || cached.fitAddon._addonDispose ? null : cached.terminal.element;
      if (el && !el.offsetWidth) { requestAnimationFrame(_refit); return; }
      try {
        cached.fitAddon.fit();
        ipcRenderer.send('terminal-resize', { sessionId, cols: cached.terminal.cols, rows: cached.terminal.rows });
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
    // 仅通用圆桌阻断 layout 切换；researchMode 保持原行为（C1）
    if (meeting.roundtableMode) {
      console.warn('[meeting-room] setLayout called in roundtable mode — ignored');
      return;
    }
    meeting.layout = layout;
    if (layout === 'focus' && !meeting.focusedSub) {
      meeting.focusedSub = meeting.subSessions[0] || null;
    }
    ipcRenderer.send('update-meeting', { meetingId, fields: { layout, focusedSub: meeting.focusedSub } });
    renderHeader(meeting);
    renderTerminals(meeting);
  }

  // --- Toolbar ---

  function renderToolbar(meeting) {
    const el = toolbarEl();
    if (!el) return;

    // Module C 后 blackboard layout 已废弃,layout 字段只剩 'focus' 一种语义。
    // 两模式(通用/投研)统一 toolbar：群策群力 / 总结发言。
    if (_isPanelCapableMeeting(meeting)) {
      const subs = _getRtSubInfo(meeting);
      const opts = ['claude', 'gemini', 'codex']
        .filter(k => subs[k])
        .map(k => `<option value="${k}">${ {claude:'Claude',gemini:'Gemini',codex:'Codex'}[k] }</option>`)
        .join('');
      const cached = _rtPanelState[meeting.id];
      const inProgress = cached && cached.currentMode && cached.currentMode !== 'idle';
      const disabledAttr = inProgress ? 'disabled' : '';
      const turns = cached ? (cached.turns || []).length : 0;
      const debateDisabled = (turns < 1 || inProgress) ? 'disabled' : '';
      el.innerHTML = `
        <div class="mr-rt-toolbar">
          <button class="mr-rt-tb-btn primary" id="mr-rt-debate-btn" ${debateDisabled} title="让三家结合对方观点重新发言（基于上一轮）">🤝 群策群力</button>
          <span class="mr-rt-tb-divider"></span>
          <label class="mr-rt-tb-pick">
            <span class="mr-rt-tb-pick-label">总结人:</span>
            <select id="mr-rt-summary-pick" ${disabledAttr}>${opts || '<option disabled>无可用 AI</option>'}</select>
          </label>
          <button class="mr-rt-tb-btn warm" id="mr-rt-summary-btn" ${debateDisabled} title="让选中的 AI 综合所有轮次给最终意见">📝 总结发言</button>
          <span class="mr-rt-tb-status" id="mr-rt-tb-status">${inProgress ? '⏳ 处理中…' : (turns === 0 ? '先发个问题让三家本色发言' : `已 ${turns} 轮`)}</span>
        </div>
      `;
      const debateBtn = el.querySelector('#mr-rt-debate-btn');
      const summaryBtn = el.querySelector('#mr-rt-summary-btn');
      const pick = el.querySelector('#mr-rt-summary-pick');
      if (debateBtn) debateBtn.addEventListener('click', () => {
        if (debateBtn.hasAttribute('disabled')) return;
        const inputBox = document.getElementById('mr-input-box');
        const extra = inputBox ? inputBox.innerText.trim() : '';
        triggerRoundtable(meeting, 'debate', { userInput: extra });
        if (inputBox) inputBox.textContent = '';
      });
      if (summaryBtn) summaryBtn.addEventListener('click', () => {
        if (summaryBtn.hasAttribute('disabled')) return;
        const summarizerKind = pick ? pick.value : 'claude';
        triggerRoundtable(meeting, 'summary', { summarizerKind });
      });
      return;
    }

    // fallback toolbar:仅在老数据/异常 meeting(无 mode flag)出现,清空即可,
    // 用户应通过模式 toggle 切到圆桌或投研以使用主功能。
    el.innerHTML = '';
  }

  // --- Input & Broadcasting ---

  let _inputBound = false;
  function setupInput(meeting) {
    const inputBox = document.getElementById('mr-input-box');
    const sendBtn = document.getElementById('mr-send-btn');
    const targetSelect = document.getElementById('mr-input-target');
    if (!inputBox || !sendBtn) return;

    inputBox.textContent = '';
    inputBox.dataset.placeholder = meeting.researchMode
      ? '输入投研问题，回车发送 → 三家本色独立回答（@debate / @summary @<who> 也可继续手输）'
      : (meeting.roundtableMode
        ? '圆桌讨论：发普通文本启动一轮 / @debate / @summary @<who> / @<who> 单聊'
        : '输入消息...');

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
      const text = box ? box.innerText.trim() : '';
      if (!text) return;
      const mid = activeMeetingId;
      const m = meetingData[mid];
      if (!m) return;
      // researchMode / roundtableMode 下 sendTarget 由 fanout/debate/summary/private 路由决定，不依赖隐藏的 select
      // （select 隐藏后 value 是 ''，不能让它把 m.sendTarget 覆盖成空）
      if (!m.researchMode && !m.roundtableMode) {
        const sel = document.getElementById('mr-input-target');
        if (sel) m.sendTarget = sel.value;
      } else {
        m.sendTarget = 'all';
      }
      handleMeetingSend(text, m);
      if (box) box.textContent = '';
    };

    sendBtn.addEventListener('click', doSend);

    inputBox.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    });
  }

  async function handleMeetingSend(text, meeting) {
    const current = meetingData[meeting.id] || meeting;

    // --- Research Mode routing 优先 ---
    // 路由完全由 fanout/debate/summary 决定，不依赖 sendTarget/validTargets。
    // 必须在 validTargets 检查前判定，否则 researchMode 下 sendTarget = 'all' / subSessions 为空时会被拦掉。
    if (current.researchMode || current.roundtableMode) {
      const cmd = parseRoundtableCommand(text, current);
      // 公共轮次：fanout / debate / summary 走 orchestrator
      if (cmd.type === 'rt-fanout' || cmd.type === 'rt-debate' || cmd.type === 'rt-summary') {
        const mode = cmd.type === 'rt-fanout' ? 'fanout' : cmd.type === 'rt-debate' ? 'debate' : 'summary';
        // 也写入 meeting timeline（黑板视图回放用）
        try {
          await ipcRenderer.invoke('meeting-append-user-turn', { meetingId: meeting.id, text });
        } catch (e) { console.warn('[meeting-room] append-user-turn failed:', e.message); }
        triggerRoundtable(current, mode, {
          userInput: cmd.text || '',
          summarizerKind: cmd.summarizerKind || null,
        });
        return;
      }
      // 私聊：单家或多家但非全员，不入轮次
      if (cmd.type === 'rt-private') {
        const kinds = cmd.targetKinds || [];
        const sids = [];
        const resolvedKinds = [];
        const failedKinds = [];
        for (const kind of kinds) {
          const sid = findSessionByKind(current, kind);
          if (sid && !sids.includes(sid)) {
            sids.push(sid);
            resolvedKinds.push(kind);
          } else {
            failedKinds.push(kind);
          }
        }
        if (sids.length === 0) {
          console.warn('[meeting-room] rt-private: no matching session for kinds', kinds);
          return;
        }
        if (failedKinds.length > 0) {
          console.warn(`[meeting-room] rt-private: partial resolution — sent to [${resolvedKinds.join(',')}], skipped [${failedKinds.join(',')}] (sessions not attached or dormant)`);
        }
        // ---
        // 顺序与不变量备注：
        // 1) terminal-input 是 fire-and-forget（IPC send），私聊 store 是 best-effort async invoke
        // 2) 极端情况下 send 成功但 store append 失败，UI 仅 console.warn 不阻塞，依赖未来
        //    transcript-tap 回填 response 字段做兜底
        // 3) 我们接受这个不变量缺口换取低延迟体验，详情见 spec 私聊段落
        // ---
        const payload = cmd.text || '';
        for (const sessionId of sids) {
          ipcRenderer.send('terminal-input', { sessionId, data: payload });
          const session = sessions ? sessions.get(sessionId) : null;
          const baseDelay = session && session.kind === 'codex' ? 400 : 200;
          const sizeDelay = Math.min(Math.floor(payload.length / 100) * 10, 500);
          setTimeout(() => {
            ipcRenderer.send('terminal-input', { sessionId, data: '\r' });
          }, baseDelay + sizeDelay);
        }
        // 仅对成功送达的 kinds 写私聊 store，避免给下线 AI 留虚假记录
        for (const kind of resolvedKinds) {
          ipcRenderer.invoke('roundtable-private:append', {
            meetingId: meeting.id,
            kind,
            userInput: payload,
            response: '',
          }).catch(e => console.warn('[meeting-room] private append failed:', e.message));
        }
        meeting.lastMessageTime = Date.now();
        ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { lastMessageTime: meeting.lastMessageTime } });
        return;
      }
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
      const baseDelay = session && session.kind === 'codex' ? 400 : 200;
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
