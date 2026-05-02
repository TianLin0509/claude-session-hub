// renderer/meeting-room.js
// Meeting Room UI — manages the parallel terminal panel.
// Exposes global `MeetingRoom` object consumed by renderer.js.

(function () {
  const { ipcRenderer } = require('electron');
  const _scenes = require('../core/roundtable-scenes.js');
  const { isSlotParticipatingThisTurn } = require('../core/meeting-room.js');
  const { isPasteSensitive, kindRegexAlternation } = require('../core/ai-kinds.js');

  let activeMeetingId = null;
  let meetingData = {};
  let subTerminals = {};
  let _markerStatusCache = {};
  let _markerPollTimer = null;
  // IF-C1（2026-05-01）：CLI ready 状态 cache（per-sid bool），由 cli-ready-status IPC 1s 轮询填充
  //   驱动 isInitializing 判断（修 P0 阻塞 bug B：原 markerStatus 永远 'none' 导致永久卡"创建中"）
  let _cliReadyCache = {};
  let _cliReadyPollTimer = null;
  // IF-C3（2026-05-01）：banner dismiss 状态记录 — meetingId，dismiss 后同会议不再显示，
  //   关闭会议（closeMeetingPanel）会重置，下次进同会议又显示
  let _bannerDismissedFor = null;
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
  // 支持 @debate / @summary @<who> / @all / @<who> 单聊
  // 2026-05-02 修复：summaryRe / tokenRe 正则原本硬编码 (claude|gemini|codex|deepseek|glm)
  //   字符串，未来加新 AI 必须同步改正则（容易漏）。改为从 ai-kinds.js 的
  //   kindRegexAlternation() 动态构造，单一真理源。
  const _RT_KIND_ALT = kindRegexAlternation();
  const _summaryRe = new RegExp('^@summary\\s+@(' + _RT_KIND_ALT + ')\\b\\s*', 'i');
  const _tokenRe = new RegExp('^@(' + _RT_KIND_ALT + ')\\b\\s*', 'i');
  function parseRoundtableCommand(text, meeting) {
    if (!meeting || !meeting.scene) return { type: 'normal', text, targets: null };
    let rest = text.trim();
    const debateRe = /^@debate\b\s*/i;
    let m;
    if ((m = rest.match(_summaryRe))) {
      return { type: 'rt-summary', summarizerKind: m[1].toLowerCase(), text: rest.slice(m[0].length) };
    }
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
  // _rtPanelState[meetingId] 缓存渲染状态，避免 IPC 频繁调用
  // partialBy: 当前进行中轮次的部分回答 { sid: { text, status } } — 单家完成立即更新
  const _rtPanelState = {};
  let _rtHistoryExpanded = false;
  // pilot redesign（2026-05-02）：_privateCountCache 已废弃（圆桌不再桥接子会话私聊）
  const _thinkStartTs = {};
  let _thinkTimer = null;
  // Stage 2 容错升级：每轮 prompt 发送时间戳（用于 manual-extract IPC 的 sincePromptTs 参数）
  const _rtTurnStartTs = {};

  // Card optimization Task 9（2026-05-01）— 沉浸/调试模式 per-meetingId 状态（renderer 内存镜像）。
  //   首次 openMeeting 走 IPC 'get-immersive-mode' 拿主进程持久化值；切换走 'save-immersive-mode' 写回。
  //   _toggleMeetingMode 切换 panel.classList.immersive + 按钮 .active class + icon/label 文本。
  const _immersiveByMeeting = {};

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
    // Arch refactor 2026-05-02 (Task 6): 截断方向反转 — 保头去尾，让用户能从开头读起。
    //   原 slice(-X) 截头保尾的设计是为了适配老沉浸模式下小卡片只看最新输出；现在
    //   shell 已经独立到子 session 主区，长输出请用户点 [🔧 进 shell] 看真实 PTY。
    //   截断时追加点击提示链接到 shell view。
    const truncatedHint = sid
      ? `<span class="mr-truncated-hint" data-rt-escape="enter-shell" data-rt-sid="${sid}" title="切换到该家 shell 主视图，查看完整输出">▾ 内容已截断 · 进 shell 看完整 →</span>`
      : `<span class="mr-truncated-hint">▾ 内容已截断 · 切到该家 session 看完整 →</span>`;
    const html = [];
    for (const block of filtered) {
      if (block.type === 'thinking') {
        const raw = String(block.text || '');
        const t = raw.slice(0, 400);
        const truncMark = raw.length > 400 ? truncatedHint : '';
        html.push(`<div class="mr-ft-think">${escapeHtml(t)}${truncMark}</div>`);
      } else if (block.type === 'tool_use') {
        const summary = _formatToolUseBlock(block);
        html.push(`<span class="mr-ft-tool">${escapeHtml(summary)}</span>`);
      } else if (block.type === 'text') {
        const raw = String(block.text || '');
        const t = raw.slice(0, 2000);
        const md = _renderMarkdown(t);
        const truncMark = raw.length > 2000 ? truncatedHint : '';
        html.push(`<div class="mr-ft-md">${md}${truncMark}</div>`);
      }
    }
    return html.join('');
  }

  // --- Two-state mode toggle (圆桌 / 投研) ---

  function _renderModeToggle(meeting) {
    if (!meeting) return '';
    const current = meeting.scene || 'general';
    return `
      <div class="mr-mode-toggle" role="radiogroup" aria-label="会议场景">
        <button type="button" class="mr-mode-btn ${current === 'general' ? 'active' : ''}" data-scene="general" title="通用圆桌：三家平等讨论">圆桌</button>
        <button type="button" class="mr-mode-btn ${current === 'research' ? 'active' : ''}" data-scene="research" title="投研圆桌：A 股专题">投研</button>
      </div>
    `;
  }

  function _bindModeToggle(rootEl, meeting) {
    if (!rootEl || !meeting) return;
    rootEl.querySelectorAll('.mr-mode-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const scene = btn.getAttribute('data-scene');
        if (!scene || scene === meeting.scene) return;
        try {
          const res = await ipcRenderer.invoke('switch-scene', { meetingId: meeting.id, scene });
          if (res && !res.ok) console.warn('[mode-toggle] switch-scene failed:', res.error);
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
      deepseek: 'assets/pokemon/pikachu.png', // DeepSeek 跑在 claude CLI 上 → 复用皮卡丘
      glm:      'assets/pokemon/pikachu.png', // GLM 同理
    })[kind] || '';
  }
  function _avatarFallbackFor(kind) {
    return ({ claude: '🟡', gemini: '🟠', codex: '🔵', deepseek: '🟢', glm: '🟣' })[kind] || '🤖';
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
  //   返回 [slot0, slot1, slot2]，每个 slot 是 { sid, kind, label } 或 null。
  //   老 meeting 兼容：subSessions 顺序就是 slot 顺序（自然吻合）。
  function _getRtSlots(meeting) {
    const slots = [null, null, null];
    if (!meeting || !Array.isArray(meeting.subSessions)) return slots;
    for (let i = 0; i < meeting.subSessions.length && i < 3; i++) {
      const sid = meeting.subSessions[i];
      const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      if (!s) continue;
      slots[i] = { sid, kind: s.kind, label: s.title || s.kind || `Slot ${i + 1}` };
    }
    return slots;
  }

  // 兼容老 kind label 字典 + 新加的 deepseek/glm
  const _KIND_LABELS = { claude: 'Claude', gemini: 'Gemini', codex: 'Codex', deepseek: 'DeepSeek', glm: 'GLM' };

  function _renderFusedTabs(state, subs, currentMode, partialBy, meeting) {
    const lastTurn = state.turns.length > 0 ? state.turns[state.turns.length - 1] : null;
    const summarizerKind = state.currentSummarizerKind || null;
    const tabs = [];
    const meetingId = meeting && meeting.id;
    const focused = meeting.focusedSub || meeting.subSessions[0];
    let anyThinking = false;
    // meeting-create-modal（2026-05-01）：sid 索引化重构 — 旧版 for(kind of [...]) + subs[kind]
    //   只支持固定三家。新版按 subSessions 数组顺序还原 slot[0..2]，每 slot 包含 sid+kind+label，
    //   渲染按 slot index 派头像（皮卡丘永远 slot 1，与 kind 解绑）。
    const slots = _getRtSlots(meeting);
    for (let slotIndex = 0; slotIndex < 3; slotIndex++) {
      const slot = slots[slotIndex];
      if (!slot) continue;
      const kind = slot.kind;
      const sub = { sid: slot.sid, label: slot.label };
      const partial = partialBy ? partialBy[sub.sid] : null;
      const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sub.sid) : null;
      const markerState = _markerStatusCache[sub.sid];
      // IF-C1（2026-05-01）：用 _cliReadyCache 替代 markerStatus 判 isInitializing。
      //   原 markerState 检测 summary marker，AI ready 但无人问过时永远 'none' →
      //   卡片永久"创建中"卡死（P0 阻塞 bug B）。新方案靠 cli-ready-status IPC 实时
      //   读 PTY buffer 长度/marker 判断 CLI 真就绪。
      const isInitializing = s && !_cliReadyCache[sub.sid];
      let status = 'idle';
      let preview = '';

      if (isInitializing && !partial && !(currentMode && currentMode !== 'idle') && !lastTurn) {
        status = 'initializing';
      } else if (partial) {
        if (partial.status === 'streaming') {
          status = 'streaming';
          preview = partial.text || '';
          anyThinking = true;
        } else {
          status = partial.status === 'timeout' ? 'timeout' : 'completed';
          preview = partial.text || '';
        }
      } else if (currentMode && currentMode !== 'idle') {
        // pilot redesign v5（2026-05-02）：参与名单委托给 core/meeting-room.js
        //   的 isSlotParticipatingThisTurn 纯函数，与 main.js dispatchRoundtableTurn
        //   的 targetSubs 公式共用同一份真理。
        //   v4 旧逻辑只判 "slot != pilotSlot" 当作 observer，造成：
        //     - 群策群力 + 已选主驾：副驾真在 thinking，卡片错显 idle
        //     - 副驾发言：主驾错显 thinking，副驾错显 idle（语义完全反了）
        //   v5：把判定抽到 core/，单测固化；renderer 与后端对齐。
        if (!isSlotParticipatingThisTurn(meeting, slotIndex)) {
          // 本轮不参与：保持上轮显示或 idle
          status = lastTurn && lastTurn.by && lastTurn.by[sub.sid] ? 'completed' : 'idle';
          preview = lastTurn ? (lastTurn.by[sub.sid] || '') : '';
        } else if (currentMode === 'summary' && summarizerKind && summarizerKind !== kind) {
          status = lastTurn && lastTurn.by[sub.sid] ? 'completed' : 'idle';
          preview = lastTurn ? (lastTurn.by[sub.sid] || '') : '';
        } else {
          status = 'thinking';
          anyThinking = true;
        }
      } else if (lastTurn) {
        // FIX-A（2026-05-01）：已结束轮的卡片状态必须读 byStatus，不能只看 by[sid] 文本。
        //   旧逻辑 if (lastTurn.by[sub.sid]) → errored / absent 因 by[sid]=='' 直接 fall through 到
        //   默认 'idle'，卡片显"待命"无角标无逃生按钮（用户场景：Codex CLI 自我更新后卡死 30min）。
        //   现按 byStatus 区分四种终态：completed / manual_extracted / errored / absent。
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
        // 否则保持 'idle'（首次未参与 / 老格式无 byStatus + 无 by 文本）
      }

      const isActive = sub.sid === focused;
      const modelName = s && s.currentModel ? (typeof modelShort === 'function' ? modelShort(s.currentModel) : s.currentModel.displayName || '') : '';
      const modelCls = s && s.currentModel && typeof modelClass === 'function' ? modelClass(s.currentModel.id) : '';
      const ctxPct = s && typeof s.contextPct === 'number' ? s.contextPct : null;
      const ctxCls = _ftCtxClass(ctxPct);
      const labelDisplay = _KIND_LABELS[kind] || (kind ? kind : `Slot ${slotIndex + 1}`);

      // Stage 2 容错升级：状态机扩展（manual_extracted / absent / soft_alert / errored / interrupted / transport_lost）
      // 状态来源：partial.status（后端 watcher 设置）+ 'roundtable-soft-alert' IPC 注入 status='soft_alert'
      const statusLabel = {
        idle: '待命',
        initializing: '创建中…',
        thinking: '思考中',
        streaming: '输出中',
        completed: '已答 ✓',
        timeout: '超时',           // 老路径兼容（commit 2 已改 watcher，此值不再产生）
        manual_extracted: '已答 ✓ 手动',
        absent: '本轮缺席',
        soft_alert: '等待中…',
        errored: '错误',
        interrupted: '已中断',
        transport_lost: '连接断开',
      }[status] || status;
      const tabState = _tabState[sub.sid] || 'idle';
      const newBadge = tabState === 'new-output' && !isActive ? '<span class="mr-ft-new">NEW</span>' : '';

      // T7（2026-05-01）：blocks 优先 / text 兼容 / lastTurn 历史回显 / 占位
      //   partial.blocks（数组、非空）→ 结构化渲染（thinking/tool/text）
      //   partial.text（字符串）→ 包成 [{type:'text',text}] 走同一渲染（向后兼容）
      //   历史轮 lastTurn.by[sid] → 同上（包成 text 块）
      //   都没有 → "等待…" 占位
      const blocksFromPartial = (partial && Array.isArray(partial.blocks) && partial.blocks.length > 0)
        ? partial.blocks
        : null;
      const textFromPartial = (partial && typeof partial.text === 'string' && partial.text)
        ? partial.text
        : null;
      const textFromHistory = (!partial && lastTurn && lastTurn.by && lastTurn.by[sub.sid])
        ? lastTurn.by[sub.sid]
        : null;

      // Card redesign（2026-05-01）：bottom 区内容（progress / streaming preview / completed preview / 占位）
      let bottomHtml = '';
      if (status === 'thinking') {
        if (!_thinkStartTs[meetingId]) _thinkStartTs[meetingId] = Date.now();
        bottomHtml = `<div class="mr-ft-progress"><div class="mr-ft-progress-bar slot-${slotIndex + 1}"></div></div>`;
      } else if (status === 'streaming') {
        if (!_thinkStartTs[meetingId]) _thinkStartTs[meetingId] = Date.now();
        // T7：streaming 状态下也走 blocks 渲染（如 transcript-tap 已就绪），fallback 到旧 snippet
        // fix（2026-05-01 多方审查反馈方案 C）：tap 没数据时不再 fallback 到 PTY ringBuffer
        //   （会被 Claude TUI throbbing 字符 / Codex prompt echo 残片污染）。
        //   显示"💭 思考中..."占位，承认 streaming 阶段 PTY 不可信，等 transcript 落盘再渲染。
        let inner;
        if (blocksFromPartial) {
          inner = _renderPreviewBlocks(blocksFromPartial, sub.sid);
        } else if (textFromPartial) {
          inner = _renderPreviewBlocks([{ type: 'text', text: textFromPartial }], sub.sid);
        } else {
          inner = '<div class="mr-ft-thinking-placeholder">💭 思考中...</div>';
        }
        bottomHtml = `<div class="mr-ft-preview streaming mr-ft-preview-md">${inner}<span class="mr-ft-cursor"></span></div>`;
      } else if (blocksFromPartial || textFromPartial || textFromHistory) {
        // IF-C0（2026-05-01）：completed/已答状态用 marked + DOMPurify 渲染 markdown
        //   T7：所有 preview 都走 _renderPreviewBlocks，统一管线
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
        // 占位文本，保持卡片底部不空（防视觉空洞）
        bottomHtml = '<div class="mr-ft-preview" style="opacity:0.5;font-style:italic">等待…</div>';
      }

      // meeting-create-modal（2026-05-01）：aiStats 现在是 sid 索引（让多 Claude
      //   slot 各自独立累加），先按 sid 取，再回退到 kind（兼容老 state.json）。
      const aiStats = (state.aiStats && (state.aiStats[sub.sid] || state.aiStats[kind]))
        || { totalThinkSec: 0, totalTokens: 0 };
      let thinkCurrentSec = 0;
      let tokensCurrentN = 0;
      if (status === 'thinking' || status === 'streaming') {
        // 实时计算（粗粒度，按整秒避免抖动）
        thinkCurrentSec = _thinkStartTs[meetingId]
          ? Math.round((Date.now() - _thinkStartTs[meetingId]) / 1000)
          : 0;
        if (partial && partial.tokens && typeof partial.tokens.total === 'number') {
          tokensCurrentN = partial.tokens.total;
        }
      } else if (lastTurn && lastTurn.thinkSecBy && lastTurn.thinkSecBy[sub.sid] != null) {
        // 已完成：从 lastTurn 持久化字段精准回显
        thinkCurrentSec = lastTurn.thinkSecBy[sub.sid] || 0;
        tokensCurrentN = (lastTurn.tokensBy && lastTurn.tokensBy[sub.sid]) || 0;
      }
      const thinkCurrent = _formatThinkTime(thinkCurrentSec);
      const thinkTotal   = _formatThinkTime(aiStats.totalThinkSec || 0);
      const tokensCurrent = _formatTokens(tokensCurrentN);
      const tokensTotal   = _formatTokens(aiStats.totalTokens || 0);

      tabs.push(_ftHtml(
        kind, isActive, sub.sid, labelDisplay, statusLabel, status,
        modelName, modelCls, ctxPct, ctxCls, bottomHtml,
        thinkCurrent, thinkTotal, tokensCurrent, tokensTotal, newBadge,
        slotIndex
      ));
    }
    if (!anyThinking && meetingId) delete _thinkStartTs[meetingId];
    return `<div class="mr-ft-strip">${tabs.join('')}</div>`;
  }

  function _ftHtml(kind, isActive, sid, name, statusLabel, statusCls, modelName, modelCls, ctxPct, ctxCls, bottomHtml,
                   thinkCurrent, thinkTotal, tokensCurrent, tokensTotal, newBadge, slotIndex) {
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
    //   再次发生）。无论卡片状态（idle/completed/thinking/error/...），三大按钮始终
    //   显示，给用户随时可用的兜底口：
    //     [一键提取]    — 任何状态都能从 transcript 直读拼接
    //     [跳过]        — 任何状态都能跳过本轮 / 暂停后续期待
    //     [🔧 进 shell] — 任何状态都能进子 session 看真实 PTY
    //   仅 [🔄 重新拉起] 保持仅终态显示（idle 没什么可拉起的，会让用户困惑）。
    const isTerminalErrorState = statusCls === 'errored' || statusCls === 'absent';
    const relaunchBtn = isTerminalErrorState
      ? `<button class="mr-ft-escape-btn" data-rt-escape="resend" data-rt-sid="${sid}" data-rt-kind="${kind}" title="重新拉起该家：重发本轮 prompt">🔄 重新拉起</button>`
      : '';
    const escapeBar = `
      <div class="mr-ft-escape-bar">
        <button class="mr-ft-escape-btn" data-rt-escape="extract" data-rt-sid="${sid}" data-rt-kind="${kind}" title="从 transcript 直读拼接（卡死时绕过完成检测）">一键提取</button>
        <button class="mr-ft-escape-btn" data-rt-escape="skip" data-rt-sid="${sid}" data-rt-kind="${kind}" title="本轮跳过这家，下游 prompt 不引用">跳过</button>
        <button class="mr-ft-escape-btn" data-rt-escape="enter-shell" data-rt-sid="${sid}" data-rt-kind="${kind}" title="切换到该家的 shell 主视图，直接查看 PTY 真实输出">🔧 进 shell</button>
        ${relaunchBtn}
      </div>`;

    // T8（2026-05-01）：row3/row4 stats 合并到 row1/row2 末尾（margin-left:auto push to right），
    //   删除 row3/row4 div，让 preview 区多 ~44px 给 markdown 内容。
    //   timeout 着色迁移：原 .mr-ft-row3.timeout .mr-ft-stat-current 高亮，
    //   现统一以 .mr-ft-row1.timeout .mr-ft-stat-inline 着色（CSS 处理）。
    const row1TimeoutCls = statusCls === 'timeout' ? ' timeout' : '';
    const timeStat = `<span class="mr-ft-stat-inline" title="本轮 / 累计 思考时间">⏱ <span class="num">${escapeHtml(thinkCurrent)}</span> · ${escapeHtml(thinkTotal)}</span>`;
    const tokenStat = `<span class="mr-ft-stat-inline" title="本轮 / 累计 token">🪙 <span class="num">${escapeHtml(tokensCurrent)}</span> · ${escapeHtml(tokensTotal)}</span>`;

    return `<div class="${cls.join(' ')}" data-ft-sid="${sid}" data-ft-kind="${kind}">
      <button class="mr-ft-expand" data-ft-expand-sid="${sid}" data-ft-expand-kind="${kind}" title="展开详细回答">↗</button>${cornerBadge}
      <div class="mr-ft-head">
        ${avatarHtml}
        <div class="mr-ft-info">
          <div class="mr-ft-row1${row1TimeoutCls}">
            <span class="mr-ft-name ${slotCls}">${name}</span>
            <span class="mr-ft-status ${statusCls}">${statusLabel}</span>${newBadge}
            ${timeStat}
          </div>
          <div class="mr-ft-row2">${modelBadge}${ctxBadge}${tokenStat}</div>
        </div>
      </div>
      <div class="mr-ft-bottom">${bottomHtml}${escapeBar}</div>
    </div>`;
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

  function _renderTurnStepper(turns, currentMode) {
    if (turns.length === 0) return '';
    const maxDots = 8;
    const showDots = turns.slice(-maxDots);
    const dots = showDots.map(t =>
      `<span class="mr-rt-step-dot" title="第 ${t.n} 轮 · ${t.mode}"></span>`
    ).join('<span class="mr-rt-step-line"></span>');
    const activeDot = currentMode && currentMode !== 'idle'
      ? '<span class="mr-rt-step-line"></span><span class="mr-rt-step-dot active"></span>'
      : '';
    const label = currentMode && currentMode !== 'idle'
      ? `第 ${turns.length + 1} 轮 · ${{ fanout: '提问中', debate: '辩论中', summary: '综合中' }[currentMode] || currentMode}`
      : `已 ${turns.length} 轮 · 等待提问`;
    return `<span class="mr-rt-stepper">${dots}${activeDot}<span class="mr-rt-step-label">${label}</span></span>`;
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

  function _renderCmdBar(turns, currentMode, partialBy, expectedSids) {
    const suggested = _suggestedCmd(turns, currentMode);
    const rawInProgress = currentMode && currentMode !== 'idle';
    // effectiveInProgress：考虑 partialBy 中各家 settle 状态——如果都 settled 就视为已结束
    const inProgress = rawInProgress && !_allParticipantsSettled(partialBy, expectedSids);
    const dis = inProgress ? ' disabled' : '';
    const noDebate = (turns.length < 1 || inProgress) ? ' disabled' : '';
    const cls = (cmd) => `mr-rt-cmd-btn${suggested === cmd ? ' mr-rt-cmd-suggested' : ''}`;
    return `<div class="mr-rt-cmd-bar">
      <button class="${cls('ask')}" data-rt-cmd="ask"${dis}>💬 直接提问 <span class="mr-rt-cmd-hint">三家独立答</span></button>
      <button class="${cls('debate')}" data-rt-cmd="debate"${noDebate}>⚔ @debate <span class="mr-rt-cmd-hint">互相点评</span></button>
      <button class="${cls('summary')}" data-rt-cmd="summary"${noDebate}>📋 @summary <span class="mr-rt-cmd-hint">综合总结</span></button>
    </div>`;
  }

  function _renderOnboarding(meeting) {
    const sceneKey = meeting && meeting.scene || 'general';
    const scene = _scenes.getScene(sceneKey);
    const examples = (scene && scene.onboardingExamples) || [];
    const titleText = scene ? scene.name : '圆桌讨论';
    const exCards = examples.map(ex =>
      `<div class="mr-rt-ob-card" data-ob-q="${escapeHtml(ex.q)}">
        <div class="mr-rt-ob-icon">${ex.icon}</div>
        <div class="mr-rt-ob-title">${escapeHtml(ex.title)}</div>
        <div class="mr-rt-ob-q">"${escapeHtml(ex.q)}"</div>
        <div class="mr-rt-ob-hint">${escapeHtml(ex.hint)}</div>
      </div>`
    ).join('');
    return `<div class="mr-rt-onboarding">
      <div class="mr-rt-ob-head">${scene ? scene.icon : '🎯'} ${escapeHtml(titleText)}已创建</div>
      <div class="mr-rt-ob-sub">三家 AI（Claude / Gemini / Codex）已就位，等你抛话题</div>
      <div class="mr-rt-ob-hint-bar">⏱ 首次发送：<strong>约 25s</strong> 冷启动 + OAuth · 后续轮次会快很多</div>
      <div class="mr-rt-ob-examples">${exCards}</div>
    </div>`;
  }

  function _renderRtPanelHtml(state, meeting) {
    const subs = _getRtSubInfo(meeting);
    const mode = state.currentMode || 'idle';
    const partialBy = state._partialBy || null;
    const fusedTabs = _renderFusedTabs(state, subs, mode, partialBy, meeting);
    const history = _renderRtHistory(state, meeting);
    const titleText = meeting && meeting.scene === 'research' ? '投研圆桌' : '圆桌讨论';
    const stepper = _renderTurnStepper(state.turns, mode);
    // FIX-E（2026-05-01）：cmdBar 推进按钮判定要按"期望家集合"，不是 partialBy 自身的 keys。
    // meeting-create-modal（2026-05-01）：期望家 = meeting.subSessions（按 slot 顺序），
    //   不再硬编码 ['claude','gemini','codex']——多 claude / DeepSeek+GLM 混搭的圆桌也能正确判完成。
    const expectedSids = Array.isArray(meeting.subSessions) ? meeting.subSessions.slice() : [];
    const cmdBar = _renderCmdBar(state.turns, mode, partialBy, expectedSids);
    const onboarding = (state.turns.length === 0 && mode === 'idle') ? _renderOnboarding(meeting) : '';
    // Stage 2 容错升级：软提醒 banner 容器
    const softBanner = `<div id="mr-rt-soft-alert-banner" class="mr-rt-soft-alert-banner" style="display:none"></div>`;
    // pilot redesign（2026-05-02）：废弃 pilotRecaps 卡片 + 主驾占位容器（圆桌不再桥接子会话私聊）。
    return `
      <div class="mr-rt-track">
        <div class="mr-rt-track-row">
          <div class="mr-rt-track-title-grp">
            <span class="mr-rt-title">${titleText}</span>
            ${stepper}
          </div>
          ${cmdBar}
        </div>
      </div>
      ${softBanner}
      ${fusedTabs}
      ${onboarding}
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
    // pilot redesign（2026-05-02）：panel.innerHTML 重渲后用 rAF 包裹，确保 paint 后再涂卡片视觉。
    //   旧实现直接调用，理论上同步生效，但截图显示 class 偶尔没生效——猜测是 panel innerHTML 后浏览器
    //   还没完成布局/合成的瞬间 querySelectorAll 拿到的引用与最终 paint 的 DOM 不一致。
    const pilotSlotForVisual = (typeof meeting.pilotSlot === 'number' && meeting.pilotSlot >= 0 && meeting.pilotSlot <= 2)
      ? meeting.pilotSlot : null;
    const dispatchModeForVisual = ['all', 'pilot', 'observer'].includes(meeting.dispatchMode)
      ? meeting.dispatchMode : 'all';
    requestAnimationFrame(() => {
      _applyPilotCardVisual(meeting, pilotSlotForVisual, dispatchModeForVisual);
    });
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
    panel.querySelectorAll('.mr-ft[data-ft-sid]').forEach(tab => {
      tab.addEventListener('click', () => {
        const sid = tab.getAttribute('data-ft-sid');
        if (sid) _focusRoundtableSession(meeting, sid);
      });
    });
    panel.querySelectorAll('.mr-ft-expand[data-ft-expand-sid]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sid = btn.getAttribute('data-ft-expand-sid');
        const kind = btn.getAttribute('data-ft-expand-kind');
        _openRtTimeline(meeting, sid, kind);
      });
    });
    panel.querySelectorAll('.mr-rt-cmd-btn[data-rt-cmd]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.hasAttribute('disabled')) return;
        const cmd = btn.getAttribute('data-rt-cmd');
        const input = document.getElementById('mr-input-box');
        if (!input) return;
        if (cmd === 'ask') { input.focus(); }
        else if (cmd === 'debate') { input.textContent = '@debate '; input.focus(); _placeCaretAtEnd(input); }
        else if (cmd === 'summary') { input.textContent = '@summary @claude '; input.focus(); _placeCaretAtEnd(input); }
      });
    });
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

    // Stage 2 容错升级：逃生工具栏按钮（提取/跳过/进 shell/重发）+ 截断提示链接（Task 6）。
    //   选择器从 .mr-ft-escape-btn[data-rt-escape] 放宽到 [data-rt-escape]，让
    //   .mr-truncated-hint 也能触发 enter-shell（共享同一段 click 处理逻辑）。
    panel.querySelectorAll('[data-rt-escape]').forEach(btn => {
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
              alert(`提取失败：${r?.reason || 'unknown'}\n\n${r?.detail || ''}`);
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
          } else if (action === 'resend') {
            const r = await ipcRenderer.invoke('roundtable-resend-participant', { meetingId: meeting.id, sid });
            if (r && r.ok) {
              console.log(`[rt-escape] resend ok: ${kind}`);
            } else {
              // FIX-C 阶段：FIX-F 还没落地前，重发 IPC 是 stub，给用户清晰指引
              alert(`暂未支持单家"重新拉起"。\n\n建议操作：\n1. 在该卡片底部按"跳过"，下游 prompt 不会引用此家。\n2. 或者发起新一轮（直接提问 / @debate），系统会自动重启卡死的 CLI。\n3. 或者点 [🔧 进 shell] 自己看 PTY 真实情况。\n\n（错误信息：${r?.reason || 'unknown'}）`);
            }
          }
        } catch (err) {
          console.error(`[rt-escape] ${action} threw:`, err);
        } finally {
          if (!_btnTextHandledExternally) {
            btn.disabled = false;
            btn.textContent = oldText;
          }
        }
      });
    });

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
  function _openRtTimeline(meeting, sid, kind) {
    const state = _rtPanelState[meeting.id];
    if (!state || !Array.isArray(state.turns)) return;

    const labelDisplay = _KIND_LABELS[kind] || kind;
    const subs = _getRtSubInfo(meeting);
    const sub = subs[kind];
    const headerLabel = sub && sub.label ? sub.label : labelDisplay;
    // 抽屉边框色与卡片同槽位 — 按 sid 在 subSessions 数组里的位置算 slot
    const slotIdxTl = (meeting && Array.isArray(meeting.subSessions))
      ? Math.max(0, meeting.subSessions.indexOf(sid))
      : 0;
    const slotClsTl = `slot-${slotIdxTl + 1}`;

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

    // pilot redesign（2026-05-02）：私聊 tab 已删除（圆桌不再桥接子会话私聊）。
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

    const contentEl = overlay.querySelector('#mr-rt-tl-content');
    overlay.querySelectorAll('.mr-rt-tl-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        overlay.querySelectorAll('.mr-rt-tl-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const idx = parseInt(btn.getAttribute('data-tab-idx') || '0', 10);
        if (contentEl) {
          contentEl.innerHTML = renderTurnBody(turnsWithAns[idx]);
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
    // Stage 2 容错升级：记录本轮 prompt 发送时间戳，逃生工具栏的 manual-extract 用此过滤 JSONL
    _rtTurnStartTs[meeting.id] = Date.now();
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
      // pilot redesign（2026-05-02）：传当前 dispatchMode（'all'|'pilot'|'observer'）。
      //   后端会校验 + 按值过滤 targetSubs；未传时按 meeting 持久化字段兜底（默认 'all'）。
      dispatchMode: meeting.dispatchMode || 'all',
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

  // pilot redesign（2026-05-02）：timeline-append / timeline-update / _updatePilotPlaceholder 整体废弃
  //   （pilot recap 卡片不再生成，圆桌 timeline 只保留 fanout/debate/summary 公开发言记录）。

  // Roundtable 单家 partial-update：单卡片立即刷新，不等所有家完成
  ipcRenderer.on('roundtable-partial-update', (_event, { meetingId, sid, status, text, thinkSec, tokens, blocks, source }) => {
    const meeting = meetingData[meetingId];
    if (!_isPanelCapableMeeting(meeting) || meetingId !== activeMeetingId) return;
    const cached = _rtPanelState[meetingId];
    if (!cached) {
      // 首次：直接 refresh（拉 state），下次 partial 才能本地更新
      refreshRoundtablePanel(meeting);
      return;
    }
    if (!cached._partialBy) cached._partialBy = {};
    // Card redesign（2026-05-01）：partial 携带 thinkSec / tokens 时一并存入，
    //   让卡片 row3/row4 在 streaming 完成→completed 切换那一刻拿到精准值（不必等下次 state refresh）
    // T7（2026-05-01）：blocks 数组（thinking/text/tool_use 结构化块）+ source（'tap'|'pty'）
    //   也写进 cache，_renderFusedTabs 优先读 partial.blocks 走结构化渲染
    cached._partialBy[sid] = {
      text: text || '',
      status: status || 'completed',
      thinkSec: typeof thinkSec === 'number' ? thinkSec : undefined,
      tokens: tokens || undefined,
      blocks: Array.isArray(blocks) ? blocks : undefined,
      source: source || undefined,
    };
    // 直接本地重渲染（不调 IPC，省一次 round-trip）
    const panel = _ensureRtPanel();
    panel.innerHTML = _renderRtPanelHtml(cached, meeting);
    _bindRtPanelEvents(panel, meeting);
  });

  // Stage 2 容错升级：软提醒 banner —— watcher 在 T1=90s/T2=180s 触发，UI 弹非阻塞 banner
  // 提示用户"还在等"，提供"一键提取/跳过/继续等"操作。永不阻塞按钮（按钮 disabled
  // 由 _allParticipantsSettled 决定，与本 banner 无关）。
  ipcRenderer.on('roundtable-soft-alert', (_event, { meetingId, sid, label, level, mode, turnNum }) => {
    const meeting = meetingData[meetingId];
    if (!_isPanelCapableMeeting(meeting) || meetingId !== activeMeetingId) return;
    // 同时把 sid 状态切到 soft_alert，让卡片状态文本变 "等待中…" + 显示逃生工具栏
    const cached = _rtPanelState[meetingId];
    if (cached) {
      if (!cached._partialBy) cached._partialBy = {};
      const existing = cached._partialBy[sid] || {};
      cached._partialBy[sid] = { text: existing.text || '', status: 'soft_alert' };
    }
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
    activeMeetingId = null;
    _inputBound = false;
    stopMarkerPoll();
    _markerStatusCache = {};
    // IF-C1：关闭轮询并清空 ready cache，下次 openMeeting 重新检测
    stopCliReadyPoll();
    _cliReadyCache = {};
    // IF-C3：清空 banner dismiss 状态 + 隐藏 banner，下次进同会议再显示一次
    _bannerDismissedFor = null;
    const _banner = document.getElementById('mr-input-soft-alert');
    if (_banner) { _banner.style.display = 'none'; _banner.innerHTML = ''; }
    // Card optimization Task 10（2026-05-01）：拆 ResizeObserver / window resize 监听，避免 panel 隐藏后还触发 fit
    if (typeof _teardownMeetingResizeObserver === 'function') _teardownMeetingResizeObserver();
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
    const showLayoutButtons = !_isPanelCapableMeeting(meeting);
    const layoutButtonsHtml = showLayoutButtons ? `
        <button class="mr-header-btn ${meeting.layout === 'focus' ? 'active' : ''}" id="mr-btn-focus">Focus</button>` : '';

    // Arch refactor 2026-05-02: 沉浸/调试切换按钮已删除。圆桌界面只有一种
    // 视图（永远纯卡片），shell 沉到子 session 主区。

    el.innerHTML = `
      <div class="mr-header-left">
        ${_renderModeToggle(meeting)}
        <span class="mr-header-title" id="mr-title">${escapeHtml(meeting.title)}</span>
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
      const meeting = meetingData[activeMeetingId];
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
      if (needRefresh && _isPanelCapableMeeting(meeting)) {
        // 触发 panel 重渲染让 isInitializing 立即生效（卡片切到"待命"）
        const cached = _rtPanelState[activeMeetingId];
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
    const firstPollPromise = pollOnce();
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
  function _refreshSoftAlert(meeting) {
    const banner = document.getElementById('mr-input-soft-alert');
    if (!banner || !meeting || !Array.isArray(meeting.subSessions)) return;

    // dismiss 状态判断
    if (_bannerDismissedFor === meeting.id) {
      banner.style.display = 'none';
      return;
    }

    // 列出未 ready 的 AI 标签
    const labelOf = sid => {
      const sess = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      const kind = sess && sess.kind;
      return ({ claude: 'Claude', gemini: 'Gemini', codex: 'Codex', glm: 'GLM', deepseek: 'DeepSeek' }[kind])
        || (sess && sess.title) || sid.slice(0, 6);
    };
    const notReady = meeting.subSessions.filter(sid => !_cliReadyCache[sid]).map(labelOf);

    if (notReady.length === 0) {
      banner.style.display = 'none';
      banner.innerHTML = '';
      return;
    }

    banner.innerHTML = `
      <span class="mr-input-soft-alert-icon">⏳</span>
      <span class="mr-input-soft-alert-msg">
        <strong>${notReady.join(' / ')}</strong> 启动中，建议等到状态变"待命"再发送（避免输入丢失）。
      </span>
      <button class="mr-input-soft-alert-close" data-soft-alert-close="1" title="关闭提示">×</button>
    `;
    banner.style.display = 'flex';
    const closeBtn = banner.querySelector('[data-soft-alert-close]');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        _bannerDismissedFor = meeting.id;
        banner.style.display = 'none';
        banner.innerHTML = '';
      }, { once: true });
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
        : '圆桌讨论：发普通文本启动一轮 / @debate / @summary @<who>';
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
      // Plan 阶段 2: 动态枚举 _KIND_LABELS 全部 kind, 支持 deepseek/glm 作为 @summary 总结人
      const opts = Object.keys(_KIND_LABELS)
        .filter(k => subs[k])
        .map(k => `<option value="${k}">${escapeHtml(_KIND_LABELS[k])}</option>`)
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
      const dispatchAllDisabled = inProgress ? 'disabled' : '';

      // debate: 'pilot' 模式下一家无法辩论 → disable
      const debateDisabled = (turns < 1 || inProgress || dispatchMode === 'pilot') ? 'disabled' : '';
      const summaryDisabled = inProgress ? 'disabled' : '';
      const summaryPickDisabled = inProgress ? 'disabled' : '';

      // 主驾按钮 label
      const slotPokemon = ['⚡皮卡丘', '🔥小火龙', '💎杰尼龟'];
      const pilotBtnLabel = pilotOn ? `${slotPokemon[pilotSlot]}` : '未选';
      const pilotBtnCls = pilotOn ? 'mr-rt-tb-btn pilot active' : 'mr-rt-tb-btn pilot';

      // 状态行（toolbar 顶部一行小字，文字冗余兜底）
      const dispatchModeLabel = { all: '群策群力', pilot: '主驾发言', observer: '副驾发言' }[dispatchMode];
      const pilotLabel = pilotOn ? `Slot ${pilotSlot + 1}` : '未选';
      const statusLine = `<div class="mr-status-line">分发: <strong>${dispatchModeLabel}</strong> · 主驾: <strong>${pilotLabel}</strong>${
        inProgress ? ' · <strong>⏳ 处理中</strong>' : (turns > 0 ? ` · 已 ${turns} 轮` : '')
      }</div>`;

      el.innerHTML = `
        ${statusLine}
        <div class="mr-rt-toolbar">
          <div class="mr-rt-dispatch-group" role="group" aria-label="分发模式">
            <button class="mr-rt-dispatch-btn ${dispatchMode === 'all' ? 'active' : ''}" data-dispatch-mode="all" ${dispatchAllDisabled} title="群策群力：本轮 prompt 发给全员">🤝 群策群力</button>
            <button class="mr-rt-dispatch-btn ${dispatchMode === 'pilot' ? 'active' : ''}" data-dispatch-mode="pilot" ${dispatchPilotDisabled} title="主驾发言：本轮 prompt 仅发给主驾">🎯 主驾发言</button>
            <button class="mr-rt-dispatch-btn ${dispatchMode === 'observer' ? 'active' : ''}" data-dispatch-mode="observer" ${dispatchObserverDisabled} title="副驾发言：本轮 prompt 仅发给副驾两家">👥 副驾发言</button>
          </div>
          <span class="mr-rt-tb-divider"></span>
          <button class="mr-rt-tb-btn" id="mr-rt-debate-btn" ${debateDisabled} title="让目标范围内的 AI 结合彼此观点重新发言（基于上一轮）">🗣 辩论</button>
          <button class="mr-rt-tb-btn warm" id="mr-rt-summary-btn" ${summaryDisabled} title="让选中的 AI 综合所有轮次给最终意见">📝 总结</button>
          <label class="mr-rt-tb-pick">
            <span class="mr-rt-tb-pick-label">总结人:</span>
            <select id="mr-rt-summary-pick" ${summaryPickDisabled}>${opts || '<option disabled>无可用 AI</option>'}</select>
          </label>
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
          <span class="mr-rt-tb-status" id="mr-rt-tb-status">${
            inProgress ? '⏳ 处理中…' : (turns === 0 ? '先发个问题让大家本色发言' : `已 ${turns} 轮`)
          }</span>
        </div>
      `;

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
    // mode 触发（静态）
    items.push({ value: '@debate', label: '@debate', hint: 'cross-review' });
    // @summary 默认指向第一个 slot 对应的 kind
    if (subSids.length > 0) {
      const firstK = sidKind[subSids[0]] || null;
      const summaryValue = firstK && kindCount[firstK] === 1 ? `@summary @${firstK}` : '@summary';
      items.push({ value: summaryValue, label: '@summary', hint: 'final summary' });
    } else {
      items.push({ value: '@summary', label: '@summary', hint: 'final summary' });
    }
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
    inputBox.dataset.placeholder = meeting.scene
      ? '圆桌讨论：发普通文本启动一轮 / @debate / @summary @<who> / @<who> 单聊'
      : '输入消息...';

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
    // IF-C2：仅首次绑定时清空（避免后续重渲染 setupInput 擦掉用户已输入未发送内容）
    inputBox.textContent = '';

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
      if (!m.scene) {
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
    // 路由完全由 fanout/debate/summary 决定，不依赖 sendTarget/validTargets。
    if (current.scene) {
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
