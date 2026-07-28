'use strict';
/**
 * 初心投研面板（chuxin-panel）— 2026-07-23 Kimi 移植
 * 作为 Hub 第三主区视图（与 terminal-panel / meeting-room-panel 平级）。
 * 数据来源：chuxin-research 本机 API（127.0.0.1:3004），全部直连；
 * 服务探测/拉起走 main/ipc/chuxin-handlers.js。
 * 设计原则：信任 Agent——面板只下任务、看过程、收结果，不预取、不代查。
 */
(function () {
  const { ipcRenderer } = require('electron');

  let API = 'http://127.0.0.1:3004';
  let WEB = 'http://127.0.0.1:3003';
  const WS_KEY = 'chuxin.hub.workspace';
  const SELECT_KEY = 'chuxin.hub.selected-heroes';
  const LAST_KEY = 'chuxin.hub.last-run';
  const TAB_KEY = 'chuxin.hub.active-tab';
  const PROVIDER_KEY = 'chuxin.hub.answer-provider';
  const MODEL_KEY = 'chuxin.hub.agent-models';
  const SESSION_KEY = 'chuxin.hub.research-session';
  const AGENTS = [];

  // 只保留初心投研原始的五项产品导航。技术/消息/线索/观察池/投委会
  // 都属于“观察”内部来源，不再在 Hub 外壳重复铺一层路由。
  const PRIMARY_TABS = [
    { id: 'observe', label: '观察', hash: 'technical' },
    { id: 'chat', label: 'AI群聊', hash: 'chat' },
    { id: 'holding', label: '持有', hash: 'holding' },
    { id: 'heroes', label: '英雄大厅', native: true },
    { id: 'insights', label: '今日感悟', hash: 'insights' },
  ];
  const WORKSPACE_RE = /^[A-Za-z0-9_-]{16,128}$/;

  const state = {
    opened: false,
    online: false,
    heroes: [],           // /api/spirits 拉取
    providerStatus: {},
    selectedProvider: localStorage.getItem(PROVIDER_KEY) || 'codex-cli',
    selectedModels: (() => { try { return JSON.parse(localStorage.getItem(MODEL_KEY) || '{}'); } catch { return {}; } })(),
    researchSessions: [],
    selectedResearchSessionId: localStorage.getItem(SESSION_KEY) || '',
    activeHubSessionId: '',
    selected: new Set(),  // spirit_id 集合
    running: false,
    runId: null,
    events: [],
    lastEventAt: 0,
    startedAt: 0,
    timer: null,
    beatTimer: null,
    abort: null,
    developer: {},
    prompt: null,
    previewTimer: null,
    previewSeq: 0,
    developerTimer: null,
  };

  // ---------- 小工具 ----------
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  function workspace() {
    let ws = localStorage.getItem(WS_KEY) || '';
    if (!WORKSPACE_RE.test(ws)) {
      ws = 'hub-' + Array.from(crypto.getRandomValues(new Uint8Array(12)))
        .map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
      localStorage.setItem(WS_KEY, ws);
    }
    return ws;
  }
  function toast(msg, isErr) {
    const t = el('div', 'cx-toast' + (isErr ? ' error' : ''), msg);
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4200);
  }
  function fmtTime(ts) {
    const d = ts ? new Date(ts) : new Date();
    return d.toTimeString().slice(0, 8);
  }
  function fmtElapsed(ms) {
    const s = Math.floor(ms / 1000);
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  /** 轻量 markdown → HTML（标题/粗斜体/列表/表格/代码/引用/分割线），先全量 escape 再还原标记 */
  function md(src) {
    let t = esc(src || '');
    t = t.replace(/^######\s?(.*)$/gm, '<h6>$1</h6>')
      .replace(/^#####\s?(.*)$/gm, '<h5>$1</h5>')
      .replace(/^####\s?(.*)$/gm, '<h4>$1</h4>')
      .replace(/^###\s?(.*)$/gm, '<h3>$1</h3>')
      .replace(/^##\s?(.*)$/gm, '<h2>$1</h2>')
      .replace(/^#\s?(.*)$/gm, '<h1>$1</h1>')
      .replace(/^---+$/gm, '<hr>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>');
    // 表格：| a | b | 行块
    t = t.replace(/((?:^\|[^\n]*\|\s*$\n?){2,})/gm, (block) => {
      const rows = block.trim().split('\n').filter((r) => r.trim());
      if (rows.length < 2) return block;
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(rows[0]);
      const body = rows.slice(1).filter((r) => !/^[\s|:-]+$/.test(r)).map(cells);
      let html = '<table><thead><tr>' + head.map((c) => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>';
      for (const r of body) html += '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>';
      return html + '</tbody></table>';
    });
    // 列表
    t = t.replace(/((?:^\s*[-*]\s+.*$\n?)+)/gm, (block) => {
      const items = block.trim().split('\n').map((r) => '<li>' + r.replace(/^\s*[-*]\s+/, '') + '</li>').join('');
      return '<ul>' + items + '</ul>';
    });
    t = t.replace(/((?:^\s*\d+\.\s+.*$\n?)+)/gm, (block) => {
      const items = block.trim().split('\n').map((r) => '<li>' + r.replace(/^\s*\d+\.\s+/, '') + '</li>').join('');
      return '<ol>' + items + '</ol>';
    });
    // 段落：剩余孤立行包 <p>
    t = t.split('\n').map((line) => {
      const s = line.trim();
      if (!s) return '';
      if (/^<(h\d|ul|ol|table|hr|blockquote|li|thead|tbody|tr|td|th|\/)/.test(s)) return line;
      return '<p>' + line + '</p>';
    }).join('\n');
    return t;
  }

  // ---------- API ----------
  async function apiGet(pathname) {
    const r = await fetch(API + pathname, { headers: { 'X-Chuxin-Workspace': workspace() } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  async function apiPost(pathname, body) {
    const r = await fetch(API + pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Chuxin-Workspace': workspace() },
      body: JSON.stringify(body || {}),
    });
    if (!r.ok) {
      let detail = 'HTTP ' + r.status;
      try { detail = (await r.json()).detail || detail; } catch {}
      throw new Error(detail);
    }
    return r.json();
  }

  // ---------- 面板骨架 ----------
  let root = null;
  function buildSkeleton() {
    root = document.getElementById('chuxin-panel');
    if (!root) return;
    root.innerHTML = '';
    const header = el('div', 'cx-header');
    const title = el('div', 'cx-title');
    title.innerHTML = '初心投研<small>英雄 Skill × 底座 Agent · 数据与审计由 chuxin-research 提供</small>';
    state.statusEl = el('span', 'cx-status unknown');
    state.statusEl.innerHTML = '<span class="dot"></span><span class="txt">检测中…</span>';
    state.startBtn = el('button', 'cx-btn', '启动投研后端');
    state.startBtn.id = 'cx-start-service';
    state.startBtn.style.display = 'none';
    state.startBtn.addEventListener('click', startService);
    state.providerEl = el('span', 'cx-provider');
    header.append(title, state.statusEl, state.startBtn, state.providerEl);
    state.startErrorEl = el('div', 'cx-start-error');
    state.startErrorEl.style.display = 'none';

    // 唯一产品导航：视觉和信息层级与初心投研原应用一致。
    state.tabsBar = el('nav', 'cx-primary-nav');
    state.tabsBar.setAttribute('aria-label', '初心投研主要功能');
    for (const t of PRIMARY_TABS) {
      const b = el('button', 'cx-primary-tab', t.label);
      b.dataset.tab = t.id;
      b.type = 'button';
      b.addEventListener('click', () => switchTab(t.id));
      state.tabsBar.append(b);
    }

    // 原生英雄大厅视图
    const nativeView = el('div', 'cx-view-native');
    nativeView.dataset.view = 'heroes';

    const heroSec = el('div', 'cx-section');
    const heroSecHead = el('div', 'cx-section-head');
    heroSecHead.append(el('div', 'cx-section-title', '选择英雄（多位将各自独立取证并保留分歧）'));
    state.developerButton = el('button', 'cx-review-prompt', '审查本轮 Prompt');
    state.developerButton.id = 'cx-open-developer';
    state.developerButton.type = 'button';
    state.developerButton.addEventListener('click', () => switchTab('developer'));
    heroSecHead.append(state.developerButton);
    heroSec.append(heroSecHead);
    state.heroGrid = el('div', 'cx-heroes');
    state.heroGrid.innerHTML = '<div class="cx-ask-hint">正在加载英雄名册…</div>';
    heroSec.append(state.heroGrid);

    const agentSec = el('div', 'cx-section');
    agentSec.append(el('div', 'cx-section-title', '选择底座 Agent 与模型（直接复用 Hub 原生 CLI）'));
    state.agentGrid = el('div', 'cx-agents');
    agentSec.append(state.agentGrid);

    const sessionSec = el('div', 'cx-section cx-session-section');
    sessionSec.append(el('div', 'cx-section-title', '投研 Session（全局共享，重启后可从原生会话继续）'));
    const sessionRow = el('div', 'cx-session-row');
    state.sessionSelect = el('select', 'cx-session-select');
    state.sessionSelect.addEventListener('change', () => {
      state.selectedResearchSessionId = state.sessionSelect.value === '__new__' ? '' : state.sessionSelect.value;
      localStorage.setItem(SESSION_KEY, state.selectedResearchSessionId);
      void applySelectedSession().finally(schedulePromptPreview);
      renderAgents();
      renderDeveloper();
    });
    state.sessionRefreshBtn = el('button', 'cx-btn subtle', '刷新 Session');
    state.sessionRefreshBtn.addEventListener('click', loadResearchSessions);
    sessionRow.append(state.sessionSelect, state.sessionRefreshBtn);
    sessionSec.append(sessionRow, el('div', 'cx-ask-hint', '复用已有 Session 会保留上下文并锁定原 Agent/模型；选“新开 CLI”才可重新选择。'));

    const askSec = el('div', 'cx-section');
    askSec.append(el('div', 'cx-section-title', '你真正想问什么'));
    state.askBox = el('textarea', 'cx-ask-box');
    state.askBox.placeholder = '例：现在能否购买澜起科技（688008）？请直接给参谋意见，也明确哪些最新资料本轮没有取到。';
    state.askBox.addEventListener('input', () => {
      renderDeveloper();
      schedulePromptPreview();
    });
    const askRow = el('div', 'cx-ask-row');
    state.runBtn = el('button', 'cx-btn primary', '让 Agent 独立取证作答');
    state.runBtn.addEventListener('click', runAnalysis);
    askRow.append(state.runBtn, el('span', 'cx-ask-hint', '运行后，下方就是同一份真实 PTY；可直接看工具调用与中间过程'));
    askSec.append(state.askBox, askRow);

    const terminalSec = el('div', 'cx-section cx-terminal-section');
    const terminalHead = el('div', 'cx-terminal-section-head');
    terminalHead.append(el('div', 'cx-section-title', '原生 CLI'), el('span', 'cx-ask-hint', 'PTY 与友好结果来自同一轮执行'));
    state.terminalHost = el('div', 'cx-native-terminal terminal-panel');
    state.terminalHost.innerHTML = '<div class="cx-terminal-empty">选择已有 Session，或发起任务后在这里查看原生 CLI。</div>';
    terminalSec.append(terminalHead, state.terminalHost);

    state.liveEl = el('div', 'cx-live');
    state.liveEl.style.display = 'none';

    state.resultEl = el('div', 'cx-results');
    nativeView.append(heroSec, agentSec, sessionSec, askSec, state.liveEl, terminalSec, state.resultEl);

    const developerView = el('div', 'cx-view-developer');
    developerView.dataset.view = 'developer';
    developerView.style.display = 'none';
    state.developerView = developerView;
    renderDeveloper();

    // iframe 视图（懒加载）
    state.frameViews = {};
    const frames = [];
    for (const t of PRIMARY_TABS) {
      if (t.native) continue;
      const wrap = el('div', 'cx-view-frame');
      wrap.dataset.view = t.id;
      wrap.style.display = 'none';
      state.frameViews[t.id] = wrap;
      frames.push(wrap);
    }

    root.append(header, state.startErrorEl, state.tabsBar, nativeView, developerView, ...frames);
    const storedTab = localStorage.getItem(TAB_KEY) || 'heroes';
    const migratedTab = ['technical', 'watch', 'committee', 'clues', 'news'].includes(storedTab)
      ? 'observe' : (storedTab === 'developer' ? 'heroes' : storedTab);
    switchTab(migratedTab);
  }

  function switchTab(tabId) {
    const developerMode = tabId === 'developer';
    const tab = developerMode
      ? PRIMARY_TABS.find((row) => row.id === 'heroes')
      : (PRIMARY_TABS.find((row) => row.id === tabId) || PRIMARY_TABS[0]);
    localStorage.setItem(TAB_KEY, developerMode ? 'heroes' : tab.id);
    for (const b of state.tabsBar.children) {
      b.classList.toggle('active', b.dataset.tab === tab.id);
      b.setAttribute('aria-current', b.dataset.tab === tab.id ? 'page' : 'false');
    }
    const nativeView = root.querySelector('.cx-view-native');
    if (nativeView) nativeView.style.display = tab.native && !developerMode ? '' : 'none';
    if (state.developerView) state.developerView.style.display = developerMode ? '' : 'none';
    if (developerMode) {
      renderDeveloper();
      refreshDeveloper(state.runId || localStorage.getItem(LAST_KEY));
    }
    for (const [id, wrap] of Object.entries(state.frameViews)) {
      const show = id === tab.id;
      wrap.style.display = show ? 'flex' : 'none';
      if (show && !wrap.dataset.loaded) {
        wrap.dataset.loaded = '1';
        const frame = document.createElement('iframe');
        frame.className = 'cx-frame';
        // 与原生英雄页共用同一匿名 workspace：数据与审计不再分散（chuxin 前端支持 ?workspace= 导入）
        frame.src = WEB + '/?api=' + encodeURIComponent(API) + '&workspace=' + encodeURIComponent(workspace()) + '&embed=hub#' + tab.hash;
        frame.setAttribute('allow', 'clipboard-read; clipboard-write');
        wrap.append(frame);
      }
    }
  }

  // ---------- 状态检测 / 启动 ----------
  async function refreshStatus() {
    try {
      const s = await ipcRenderer.invoke('chuxin:status');
      if (s && s.api_base) API = s.api_base;
      if (s && s.web_base) WEB = s.web_base;
      state.online = !!s.online;
      if (state.online) {
        state.startErrorEl.style.display = 'none';
        state.startErrorEl.textContent = '';
        state.statusEl.className = 'cx-status online';
        state.statusEl.innerHTML = '<span class="dot"></span><span class="txt">投研后端在线 · ' + esc(API.replace(/^https?:\/\//, '')) + '</span>';
        state.startBtn.style.display = 'none';
        await loadAgentCatalog();
        await loadHeroes();
        await loadResearchSessions();
        await restoreRun(localStorage.getItem(LAST_KEY));
      } else {
        state.statusEl.className = 'cx-status offline';
        state.statusEl.innerHTML = '<span class="dot"></span><span class="txt">投研后端未启动</span>';
        state.startBtn.style.display = '';
        state.providerEl.textContent = s.error || '';
        state.heroGrid.innerHTML = '<div class="cx-ask-hint">后端离线：点击上方「启动投研后端」，或手动执行 C:\\Users\\lintian\\chuxin-research\\run.ps1</div>';
      }
    } catch (e) {
      state.statusEl.className = 'cx-status offline';
      state.statusEl.innerHTML = '<span class="dot"></span><span class="txt">状态检测失败</span>';
      state.startBtn.style.display = '';
    }
  }
  async function startService() {
    state.startBtn.disabled = true;
    state.startBtn.textContent = '正在启动…';
    try {
      const r = await ipcRenderer.invoke('chuxin:start-service');
      if (r.healthy) {
        state.startErrorEl.style.display = 'none';
        state.startErrorEl.textContent = '';
        toast(r.already_running ? '投研后端已在运行' : '投研后端已启动');
      } else {
        const detail = r.error || '健康检查未通过';
        state.startErrorEl.style.display = '';
        state.startErrorEl.textContent = '启动失败：' + detail + (r.logs && r.logs.launcher ? ' · 日志：' + r.logs.launcher : '');
        toast('投研后端启动失败：' + detail, true);
      }
    } catch (e) {
      state.startErrorEl.style.display = '';
      state.startErrorEl.textContent = '启动失败：' + e.message;
      toast('启动失败：' + e.message, true);
    }
    state.startBtn.disabled = false;
    state.startBtn.textContent = '启动投研后端';
    refreshStatus();
  }

  async function loadAgentCatalog() {
    try {
      const data = await ipcRenderer.invoke('chuxin:model-catalog');
      const rows = data && Array.isArray(data.agents) ? data.agents : [];
      AGENTS.splice(0, AGENTS.length, ...rows.map((row) => ({
        id: row.provider,
        kind: row.kind,
        name: row.name,
        mark: row.mark,
        defaultModel: row.defaultModel,
        models: row.models || [],
        note: `${row.name} 原生 PTY · Hub 统一模型目录`,
      })));
      if (!AGENTS.some((row) => row.id === state.selectedProvider)) state.selectedProvider = 'codex-cli';
      for (const row of AGENTS) {
        const valid = row.models.some((item) => item.id === state.selectedModels[row.id]);
        if (!valid) state.selectedModels[row.id] = row.defaultModel;
      }
      localStorage.setItem(MODEL_KEY, JSON.stringify(state.selectedModels));
      renderAgents();
    } catch (error) {
      toast('读取 Hub 模型目录失败：' + error.message, true);
    }
  }

  async function loadResearchSessions() {
    if (!state.sessionSelect) return;
    try {
      const data = await ipcRenderer.invoke('chuxin:list-research-sessions');
      state.researchSessions = data && Array.isArray(data.sessions) ? data.sessions : [];
      const previous = state.selectedResearchSessionId;
      state.sessionSelect.innerHTML = '';
      const fresh = el('option', '', '＋ 新开 CLI（可选 Agent / 模型）');
      fresh.value = '__new__';
      state.sessionSelect.append(fresh);
      for (const row of state.researchSessions) {
        const stateMark = row.live ? '● 本机' : (row.busyElsewhere ? '◉ 另一 Hub 运行中' : '○ 可恢复');
        const option = el('option', '', `${stateMark} · ${row.title || row.researchSessionId} · ${row.model || row.kind}`);
        option.value = row.researchSessionId;
        state.sessionSelect.append(option);
      }
      state.selectedResearchSessionId = state.researchSessions.some((row) => row.researchSessionId === previous) ? previous : '';
      state.sessionSelect.value = state.selectedResearchSessionId || '__new__';
      localStorage.setItem(SESSION_KEY, state.selectedResearchSessionId);
      if (state.selectedResearchSessionId) await applySelectedSession();
      else if (state.terminalHost && window.__chuxinSessionBridge) window.__chuxinSessionBridge.clear(state.terminalHost);
      renderAgents();
    } catch (error) {
      toast('读取投研 Session 失败：' + error.message, true);
    }
  }

  async function applySelectedSession() {
    const record = state.researchSessions.find((row) => row.researchSessionId === state.selectedResearchSessionId);
    if (!record) {
      state.activeHubSessionId = '';
      if (state.terminalHost && window.__chuxinSessionBridge) window.__chuxinSessionBridge.clear(state.terminalHost);
      return;
    }
    if (WORKSPACE_RE.test(String(record.workspace || ''))) {
      localStorage.setItem(WS_KEY, record.workspace);
    }
    state.selectedProvider = record.provider;
    state.selectedModels[record.provider] = record.model;
    localStorage.setItem(PROVIDER_KEY, state.selectedProvider);
    localStorage.setItem(MODEL_KEY, JSON.stringify(state.selectedModels));
    let hubSessionId = record.live ? record.hubSessionId : '';
    if (!hubSessionId) {
      const resumed = await ipcRenderer.invoke('chuxin:resume-research-session', {
        researchSessionId: record.researchSessionId,
        workspace: workspace(),
      });
      if (!resumed || !resumed.ok) {
        toast((resumed && resumed.message) || '原生会话恢复失败', true);
        return;
      }
      hubSessionId = resumed.session.id;
      record.live = true;
      record.hubSessionId = hubSessionId;
    }
    state.activeHubSessionId = hubSessionId;
    if (window.__chuxinSessionBridge && state.terminalHost) {
      await window.__chuxinSessionBridge.mount(hubSessionId, state.terminalHost);
    }
    if (record.lastRunId) await restoreRun(record.lastRunId);
  }

  // ---------- 英雄名册 ----------
  async function loadHeroes() {
    try {
      const data = await apiGet('/api/spirits');
      const list = Array.isArray(data.spirits) ? data.spirits : [];
      state.heroes = list;
      state.providerStatus = (data.answer_providers && data.answer_providers.providers) || {};
      renderHeroes();
      renderAgents();
    } catch (e) {
      state.heroGrid.innerHTML = '<div class="cx-ask-hint">名册加载失败：' + esc(e.message) + '</div>';
    }
  }
  function heroName(h) {
    return h.display_name || h.hero_title || h.short_name || h.spirit_id;
  }
  function renderHeroes() {
    const saved = new Set(JSON.parse(localStorage.getItem(SELECT_KEY) || '[]'));
    state.heroGrid.innerHTML = '';
    if (!state.heroes.length) {
      state.heroGrid.innerHTML = '<div class="cx-ask-hint">注册表中没有可用英雄。</div>';
      return;
    }
    for (const h of state.heroes) {
      const id = h.spirit_id;
      if (state.selected.size === 0 && saved.size === 0) state.selected.add(id);
      else if (saved.has(id)) state.selected.add(id);
      const card = el('div', 'cx-hero-card' + (state.selected.has(id) ? ' selected' : ''));
      card.dataset.sid = id;
      const nm = heroName(h);
      const first = id.split('.')[0];
      card.innerHTML =
        '<div class="name">' + esc(nm) + '<span class="check">' + (state.selected.has(id) ? '✓' : '') + '</span></div>' +
        '<div class="tagline">' + esc(h.hero_tagline || h.tagline || h.hero_role || '') + '</div>' +
        '<div class="meta"><span>' + esc(first) + '</span><span>v' + esc(h.version || '?') + '</span>' +
        (h.status ? '<span>' + esc(h.status) + '</span>' : '') +
        (h.rule_count ? '<span>' + esc(h.rule_count) + ' 规则</span>' : '') + '</div>';
      card.addEventListener('click', () => {
        if (state.selected.has(id)) state.selected.delete(id);
        else state.selected.add(id);
        localStorage.setItem(SELECT_KEY, JSON.stringify([...state.selected]));
        renderHeroes();
        renderDeveloper();
        schedulePromptPreview();
      });
      state.heroGrid.append(card);
    }
  }

  function selectedAgent() {
    return AGENTS.find((row) => row.id === state.selectedProvider) || AGENTS[0];
  }

  function selectedModel(agent = selectedAgent()) {
    return agent ? (state.selectedModels[agent.id] || agent.defaultModel) : '';
  }

  function taskPayload(question = state.askBox ? state.askBox.value.trim() : '') {
    const agent = selectedAgent();
    return {
      question,
      spirit_ids: [...state.selected],
      answer_provider: state.selectedProvider,
      model: selectedModel(agent),
      session_bootstrapped: !!state.selectedResearchSessionId,
      research_session_id: state.selectedResearchSessionId,
      mandate: 'value_speculation',
      research_mode: 'auto',
      context: { type: 'free', data: {} },
    };
  }

  function schedulePromptPreview() {
    if (state.previewTimer) clearTimeout(state.previewTimer);
    const question = state.askBox ? state.askBox.value.trim() : '';
    if (!state.online || state.running || question.length < 2 || !state.selected.size || !selectedAgent()) {
      if (!state.running && question.length < 2) state.prompt = null;
      return;
    }
    const seq = ++state.previewSeq;
    state.previewTimer = setTimeout(async () => {
      try {
        const data = await apiPost('/api/spirits/agent-tasks/preview', taskPayload(question));
        if (seq !== state.previewSeq || state.running) return;
        state.prompt = data.prompt || null;
        state.developer = {
          prompt_artifacts: state.prompt ? [{
            prompt_components: state.prompt.developer_components || [],
            compiled_prompt: state.prompt.agent_input || '',
          }] : [],
        };
        renderDeveloper();
      } catch (error) {
        if (seq !== state.previewSeq || state.running) return;
        state.prompt = null;
        state.developer = { preview_error: error.message };
        renderDeveloper();
      }
    }, 320);
  }

  function updateProviderUi() {
    const agent = selectedAgent();
    const model = selectedModel(agent);
    if (state.providerEl) {
      state.providerEl.innerHTML = agent ? '本轮底座 <b>' + esc(agent.name) + '</b> · ' + esc(model) : '正在读取 Hub 模型目录';
    }
    if (state.runBtn && agent) state.runBtn.textContent = '让 ' + agent.name + ' 在原生 CLI 中作答';
  }

  function renderAgents() {
    if (!state.agentGrid) return;
    state.agentGrid.innerHTML = '';
    const locked = state.researchSessions.find((row) => row.researchSessionId === state.selectedResearchSessionId);
    for (const agent of AGENTS) {
      // Agent 能力由 Hub 原生 CLI 与统一模型目录提供，不再受 Chuxin 旧 API provider 状态约束。
      const unavailable = false;
      const card = el('div', 'cx-agent' + (state.selectedProvider === agent.id ? ' selected' : '') + (unavailable ? ' unavailable' : '') + (locked && locked.provider !== agent.id ? ' locked' : ''));
      card.dataset.provider = agent.id;
      const mark = el('span', 'mark', agent.mark);
      const copy = el('span', 'copy');
      const name = el('b', '', agent.name);
      const select = el('select', 'cx-model-select');
      for (const optionRow of agent.models || []) {
        const option = el('option', '', optionRow.label);
        option.value = optionRow.id;
        select.append(option);
      }
      select.value = locked && locked.provider === agent.id ? locked.model : selectedModel(agent);
      select.disabled = !!locked || unavailable;
      select.addEventListener('click', (event) => event.stopPropagation());
      select.addEventListener('change', (event) => {
        event.stopPropagation();
        state.selectedModels[agent.id] = select.value;
        localStorage.setItem(MODEL_KEY, JSON.stringify(state.selectedModels));
        updateProviderUi();
        renderDeveloper();
        schedulePromptPreview();
      });
      copy.append(name, select, el('small', '', locked ? '已有 Session 锁定模型' : agent.note));
      card.append(mark, copy, el('span', 'pick', state.selectedProvider === agent.id ? '✓' : ''));
      card.addEventListener('click', () => {
        if (unavailable || (locked && locked.provider !== agent.id)) return;
        state.selectedProvider = agent.id;
        localStorage.setItem(PROVIDER_KEY, agent.id);
        renderAgents();
        updateProviderUi();
        renderDeveloper();
        schedulePromptPreview();
      });
      state.agentGrid.append(card);
    }
    updateProviderUi();
  }

  // ---------- 发起分析 + SSE ----------
  async function runAnalysis() {
    const question = state.askBox.value.trim();
    if (!question) return toast('先写下你真正想问的问题', true);
    if (!state.selected.size) return toast('至少选择一位英雄', true);
    if (state.running) return toast('上一轮还在进行中');
    state.running = true;
    state.runBtn.disabled = true;
    state.events = [];
    state.resultEl.innerHTML = '';
    showLive();
    pushEvent({ summary: '正在编译精简 AgentTask…', ts: Date.now() });
    try {
      const agent = selectedAgent();
      const resp = await ipcRenderer.invoke('chuxin:run-agent-task', {
        workspace: workspace(),
        question,
        spiritIds: [...state.selected],
        provider: state.selectedProvider,
        model: selectedModel(agent),
        researchSessionId: state.selectedResearchSessionId,
        mandate: 'value_speculation',
        researchMode: 'auto',
        context: { type: 'free', data: {} },
      });
      if (!resp || !resp.ok) throw new Error((resp && resp.message) || 'Hub 未能启动原生 AgentTask');
      state.runId = resp.runId;
      state.prompt = resp.prompt || null;
      state.activeHubSessionId = resp.session.id;
      state.selectedResearchSessionId = resp.research.researchSessionId;
      localStorage.setItem(SESSION_KEY, state.selectedResearchSessionId);
      localStorage.setItem(LAST_KEY, state.runId);
      pushEvent({ summary: 'Prompt 已提交到同一份原生 PTY · ' + state.runId, ts: Date.now(), status: 'running' });
      if (window.__chuxinSessionBridge && state.terminalHost) {
        await window.__chuxinSessionBridge.mount(resp.session.id, state.terminalHost);
      }
      await loadResearchSessions();
      state.developer = {
        prompt_artifacts: [{ prompt_components: state.prompt.developer_components || [], compiled_prompt: state.prompt.agent_input }],
      };
      renderDeveloper();
    } catch (e) {
      pushEvent({ summary: '创建失败：' + e.message, ts: Date.now(), fail: true });
      finishLive();
      toast('发起失败：' + e.message, true);
    }
  }

  // ---------- 实况渲染 ----------
  function showLive() {
    state.startedAt = Date.now();
    state.lastEventAt = Date.now();
    state.liveEl.style.display = '';
    state.liveEl.innerHTML =
      '<div class="cx-live-top"><span class="cx-beat" id="cx-beat"></span><b>' + esc(selectedAgent().name) + ' Agent 正在独立取证</b>' +
      '<span class="cx-ask-hint">Hub 里程碑 <span id="cx-evt-count">0</span> 条 · 细节看下方原生 PTY</span>' +
      '<span class="cx-elapsed" id="cx-elapsed">00:00</span></div>' +
      '<div class="cx-events" id="cx-events"></div>';
    state.timer = setInterval(() => {
      const e = document.getElementById('cx-elapsed');
      if (e) e.textContent = fmtElapsed(Date.now() - state.startedAt);
    }, 1000);
    state.beatTimer = setInterval(() => {
      const b = document.getElementById('cx-beat');
      if (!b) return;
      const silent = Date.now() - state.lastEventAt;
      b.className = 'cx-beat' + (silent > 30000 ? ' dead' : silent > 12000 ? ' stale' : '');
    }, 2000);
  }
  function pushEvent(row) {
    state.events.push(row);
    const box = document.getElementById('cx-events');
    const cnt = document.getElementById('cx-evt-count');
    if (cnt) cnt.textContent = String(state.events.length);
    if (!box) return;
    const line = el('div', 'cx-evt');
    const isFail = row.fail || /failed|timed_out|失败|超时/.test(String(row.status || ''));
    const isDone = /completed|success/.test(String(row.status || '')) && !isFail;
    line.innerHTML =
      '<span class="t">' + fmtTime(row.ts) + '</span>' +
      '<span>' + esc(row.summary || row.event_type || '…') + '</span>' +
      (isFail ? '<span class="fail">✗</span>' : isDone ? '<span class="ok">✓</span>' : '');
    box.append(line);
    box.scrollTop = box.scrollHeight;
    renderDeveloper();
  }
  function finishLive() {
    state.running = false;
    state.runBtn.disabled = false;
    clearInterval(state.timer);
    clearInterval(state.beatTimer);
  }

  function heroAccent(spiritId) {
    const first = String(spiritId || '').split('.')[0].toLowerCase();
    if (first.includes('buffett')) return 'buffett';
    if (first.includes('livermore')) return 'livermore';
    return 'other';
  }

  function renderResult(run) {
    const wrap = state.resultEl;
    wrap.innerHTML = '';
    const engine = el('div', 'cx-engine-strip');
    engine.innerHTML = '<span>' + esc((run.provider || '').replace('-cli', '').toUpperCase() || 'AGENT') + '</span><b>' + esc(run.model || run.provider || 'Agent') + '</b><small>英雄方法不变 · 本轮由该 Agent 自主取证</small>';
    wrap.append(engine);
    if (run.synthesis_markdown) {
      const strip = el('div', 'cx-verdict-strip');
      strip.innerHTML = '<b>参谋总览</b> ' + md(run.synthesis_markdown);
      wrap.append(strip);
    }
    const dialogues = Array.isArray(run.hero_dialogues) ? run.hero_dialogues : [];
    if (dialogues.length) {
      const grid = el('div', 'cx-dialogues');
      for (const d of dialogues) {
        const accent = heroAccent(d.spirit_id);
        const card = el('article', 'cx-dialogue ' + accent);
        const nm = d.name || (run.spirit_names && run.spirit_names[d.spirit_id]) || d.spirit_id;
        card.innerHTML =
          '<div class="head"><div class="avatar">' + esc(String(nm).slice(0, 1)) + '</div>' +
          '<div class="who"><div class="n">' + esc(nm) + '</div><div class="r">投资参谋 · 公开方法蒸馏</div></div>' +
          '<span class="badge">非本人</span></div>' +
          '<div class="body">' + md(d.markdown || '') + '</div>';
        grid.append(card);
      }
      wrap.append(grid);
    } else if (run.analysis_markdown) {
      const single = el('article', 'cx-dialogue other');
      single.innerHTML = '<div class="body" style="padding:16px">' + md(run.analysis_markdown) + '</div>';
      wrap.append(single);
    }
    // 工具轨迹
    const ar = run.agent_runtime || {};
    const calls = ar.tool_calls || [];
    if (calls.length) {
      const det = el('details', 'cx-tools');
      const ok = calls.filter((c) => /completed|success|ok/i.test(String(c.status))).length;
      det.innerHTML = '<summary>Agent 自主工具轨迹 · ' + calls.length + ' 次调用 / ' + ok + ' 成功' +
        (ar.latency_ms ? ' · 取证 ' + Math.round(ar.latency_ms / 1000) + 's' : '') + '</summary>';
      const list = el('div', 'cx-tools-list');
      for (const c of calls) {
        const row = el('div', 'cx-tool-row');
        const good = /completed|success|ok/i.test(String(c.status));
        row.innerHTML =
          '<span class="' + (good ? 'ok' : 'fail') + '">' + (good ? '✓' : '✗') + '</span>' +
          '<span>' + esc(c.server ? c.server + '.' + c.name : c.name) + '</span>' +
          (c.arguments ? '<span class="args">' + esc(String(c.arguments).slice(0, 90)) + '</span>' : '') +
          (c.duration_ms ? '<span class="args">' + c.duration_ms + 'ms</span>' : '');
        list.append(row);
      }
      det.append(list);
      det.open = true;
      wrap.append(det);
    }
    if (run.raw_analysis_markdown) {
      const raw = el('details', 'cx-raw');
      raw.innerHTML = '<summary>查看原生 Agent 完整原文</summary>' +
        '<div class="cx-raw-body">' + esc(run.raw_analysis_markdown) + '</div>';
      wrap.append(raw);
    }
  }

  function renderDeveloper() {
    if (!state.developerView) return;
    const agent = selectedAgent();
    const heroes = [...state.selected].map((id) => {
      const hero = state.heroes.find((row) => row.spirit_id === id);
      return hero ? heroName(hero) : id;
    });
    const artifacts = Array.isArray(state.developer.prompt_artifacts) ? state.developer.prompt_artifacts : [];
    const artifact = artifacts.length ? artifacts[artifacts.length - 1] : null;
    const prompt = state.prompt || null;
    const components = prompt && Array.isArray(prompt.developer_components)
      ? prompt.developer_components
      : (artifact && Array.isArray(artifact.prompt_components) ? artifact.prompt_components : []);
    const exactInput = prompt ? (prompt.agent_input || prompt.rendered_prompt || '') : (artifact ? artifact.compiled_prompt || '' : '');
    const previewError = state.developer && state.developer.preview_error ? String(state.developer.preview_error) : '';
    const inputBytes = new TextEncoder().encode(exactInput).length;
    const componentHtml = components.map((row) => '<details class="cx-dev-component"><summary><span>' + esc(row.label || row.id) + '</span><small>' + Number(row.bytes || 0).toLocaleString() + ' B · ' + esc(String(row.sha256 || '').slice(0, 10)) + '…</small></summary><pre>' + esc(row.content || '') + '</pre></details>').join('');
    const eventHtml = state.events.length
      ? state.events.map((row) => '<details class="cx-dev-event"><summary><time>' + esc(fmtTime(row.ts)) + '</time><b>' + esc(row.summary || row.event_type || '事件') + '</b><span>' + esc(row.status || 'running') + '</span></summary><pre>' + esc(JSON.stringify(row, null, 2)) + '</pre></details>').join('')
      : '<div class="cx-dev-empty">尚无任务里程碑。Agent 的逐步执行、工具调用与等待状态直接显示在原生 PTY。</div>';
    const question = state.askBox ? state.askBox.value.trim() : '';
    const sessionRecord = state.researchSessions.find((row) => row.researchSessionId === state.selectedResearchSessionId);
    state.developerView.innerHTML = '<div class="cx-dev-head"><div><button type="button" class="cx-dev-back" id="cx-developer-back">← 返回英雄大厅</button><span>DEVELOPER MODE</span><h2>本轮 Prompt 与原生 Session</h2><p>Prompt 拆解在这里；逐字符 CLI、工具调用和中间状态在英雄大厅的原生 PTY。两者属于同一轮执行。</p></div><div class="cx-dev-run"><b>' + esc(state.runId || localStorage.getItem(LAST_KEY) || '尚未运行') + '</b><span>' + state.events.length + ' MILESTONES</span></div></div>' +
      '<div class="cx-dev-recipe"><div><span>底座 Agent</span><b>' + esc((agent ? agent.name : 'Agent') + ' · ' + selectedModel(agent)) + '</b></div><div><span>投研 Session</span><b>' + esc(sessionRecord ? sessionRecord.researchSessionId : '新开 CLI') + '</b></div><div><span>英雄方法</span><b>' + esc(heroes.join(' / ') || '尚未选择') + '</b></div><div><span>Prompt 版本</span><b>' + esc(prompt ? (prompt.prompt_version || 'unknown') : '等待编译') + '</b></div><div class="wide"><span>用户问题</span><p>' + esc(question || '等待输入；这里会随输入实时变化。') + '</p></div><div class="wide"><span>组成原则</span><p>精简运行政策 + 英雄 5 项注意力地图 + UI 分段契约 + 用户背景 + Agent 自主取证授权；完整规则仅按需读取。</p></div></div>' +
      '<div class="cx-dev-columns"><section><header><b>Hub 生命周期</b><span>细节在原生 PTY</span></header><div class="cx-dev-scroll">' + eventHtml + '</div></section><section><header><b>最终 Agent 输入</b><span>' + (exactInput ? inputBytes.toLocaleString() + ' B · native PTY' : '等待编译') + '</span></header><div class="cx-dev-scroll">' + (exactInput ? componentHtml + '<details class="cx-dev-exact" open><summary>完整 Agent 输入</summary><pre>' + esc(exactInput) + '</pre></details>' : '<div class="cx-dev-empty">' + (previewError ? '实时预览失败：' + esc(previewError) : '输入问题后，这里会用执行时同一条后端编译路径实时展示完整文本。') + '</div>') + '</div></section></div>';
    const back = state.developerView.querySelector('#cx-developer-back');
    if (back) back.addEventListener('click', () => switchTab('heroes'));
  }

  async function refreshDeveloper(runId) {
    if (!runId || !state.online) return;
    try {
      const data = await apiGet('/api/spirits/analyze/jobs/' + encodeURIComponent(runId) + '/developer');
      state.developer = data.developer || {};
      const history = Array.isArray(state.developer.event_history)
        ? state.developer.event_history
        : [];
      // A completed run is restored without reopening SSE. Rehydrate its exact
      // append-only event log so Developer mode remains a real replay surface.
      // During a live run state.events remains authoritative to avoid duplicates.
      if (!state.running && state.events.length === 0 && history.length) {
        state.events = history;
        state.lastEventAt = Date.now();
      }
      renderDeveloper();
    } catch { /* 调试视图不能阻塞主回答 */ }
  }

  async function restoreRun(runId) {
    if (!runId || !state.online) return false;
    try {
      const data = await apiGet('/api/spirits/analyze/jobs/' + encodeURIComponent(runId));
      const job = data && data.job;
      if (!job || job.status !== 'completed' || !job.result) return false;
      state.runId = runId;
      localStorage.setItem(LAST_KEY, runId);
      renderResult(job.result);
      await refreshDeveloper(runId);
      return true;
    } catch {
      return false;
    }
  }

  ipcRenderer.on('chuxin:task-started', async (_event, payload = {}) => {
    if (!payload.runId) return;
    state.runId = payload.runId;
    state.prompt = payload.prompt || state.prompt;
    state.activeHubSessionId = payload.session && payload.session.id || state.activeHubSessionId;
    if (payload.research && payload.research.researchSessionId) {
      state.selectedResearchSessionId = payload.research.researchSessionId;
      localStorage.setItem(SESSION_KEY, state.selectedResearchSessionId);
    }
    state.lastEventAt = Date.now();
    if (state.opened && state.activeHubSessionId && window.__chuxinSessionBridge && state.terminalHost) {
      await window.__chuxinSessionBridge.mount(state.activeHubSessionId, state.terminalHost);
    }
    renderDeveloper();
  });

  ipcRenderer.on('chuxin:task-completed', async (_event, payload = {}) => {
    if (!payload.runId || (state.runId && payload.runId !== state.runId)) return;
    state.runId = payload.runId;
    localStorage.setItem(LAST_KEY, payload.runId);
    pushEvent({ summary: '原生 Agent 已完成，回答已解析为英雄对话卡', ts: Date.now(), status: 'completed' });
    if (payload.run) renderResult(payload.run);
    finishLive();
    await refreshDeveloper(payload.runId);
    await loadResearchSessions();
  });

  ipcRenderer.on('chuxin:task-failed', (_event, payload = {}) => {
    if (state.runId && payload.runId && payload.runId !== state.runId) return;
    pushEvent({ summary: '结果回写失败：' + (payload.message || '未知错误'), ts: Date.now(), status: 'failed', fail: true });
    finishLive();
  });

  ipcRenderer.on('terminal-data', (_event, payload = {}) => {
    if (payload.sessionId && payload.sessionId === state.activeHubSessionId) state.lastEventAt = Date.now();
  });

  window.addEventListener('chuxin-session-closed', (event) => {
    if (event.detail && event.detail.sessionId === state.activeHubSessionId) {
      state.activeHubSessionId = '';
      if (state.terminalHost && window.__chuxinSessionBridge) window.__chuxinSessionBridge.clear(state.terminalHost);
    }
    void loadResearchSessions();
  });

  // ---------- 视图切换（与 Hub 其他主区面板互斥） ----------
  function setPanelVisible(visible) {
    state.opened = visible;
    const tp = document.getElementById('terminal-panel');
    const mrp = document.getElementById('meeting-room-panel');
    if (root) root.style.display = visible ? 'flex' : 'none';
    if (visible) {
      // 打开投研：接管主区（terminal / 群聊面板由本函数隐藏；
      // 反向切换由 selectSession / selectMeeting 调 __chuxinHide，本函数不替它们恢复 tp）
      if (tp) tp.style.display = 'none';
      if (mrp) mrp.style.display = 'none';
      refreshStatus();
    }
  }

  function bindEntry() {
    const btn = document.getElementById('btn-chuxin');
    if (btn) btn.addEventListener('click', () => setPanelVisible(true));
  }

  // 供 renderer.js 在 selectSession / 进入群聊时调用，确保面板被隐藏
  window.__chuxinHide = function () {
    if (state.opened) setPanelVisible(false);
  };

  function init() {
    buildSkeleton();
    bindEntry();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
