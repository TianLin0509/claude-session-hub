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

  let API = process.env.CHUXIN_API_BASE || 'http://127.0.0.1:3004';
  let WEB = process.env.CHUXIN_WEB_BASE || 'http://127.0.0.1:3003';
  const WS_KEY = 'chuxin.hub.workspace';
  const PRIMARY_WORKSPACE = 'hub-primary-workspace';
  const TAB_KEY = 'chuxin.hub.active-tab';

  // 初心投研只承担数据工作台。AI 对话和投委会都回到 Hub
  // 原生 Session / 群聊，不再在这里复制一套 AI 产品入口。
  const PRIMARY_TABS = [
    { id: 'today', label: '今日概况', hash: 'today' },
    { id: 'market', label: '实时行情', hash: 'market' },
    { id: 'technical', label: '技术雷达', hash: 'technical' },
    { id: 'news', label: '消息雷达', hash: 'news' },
    { id: 'targets', label: '观察池', hash: 'watch' },
    { id: 'holding', label: '持仓信息', hash: 'holding' },
    { id: 'notes', label: '知识库', hash: 'notes' },
    // Agent 联赛（5 个 Agent + PTY 编排）已由初心投研后端里的「作手林铛」单 Agent 取代：
    // 决策、报告与收益统计都在 chuxin-research 里，这里只要一个普通 iframe Tab。
    { id: 'lindang', label: '作手林铛', hash: 'lindang' },
    // 数据底座：每个数据源能不能用、要不要登录、谁在用（2026-09-28）
    { id: 'data', label: '账号数据', hash: 'data' },
  ];

  const state = {
    opened: false,
    online: false,
    nativeTabActive: false,
    loadToken: String(Date.now()),
    loadedVersion: '',
    availableVersion: '',
    versionError: '',
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
    // 初心是这台电脑上的个人工作台，不是多租户站点。过去的随机 ID 会随
    // Electron profile 轮换，导致已落盘持仓看起来“消失”；固定身份后重开仍
    // 指向同一份快照。后端只在本机配置中启用这项映射。
    if (localStorage.getItem(WS_KEY) !== PRIMARY_WORKSPACE) {
      localStorage.setItem(WS_KEY, PRIMARY_WORKSPACE);
    }
    return PRIMARY_WORKSPACE;
  }
  function toast(msg, isErr) {
    const t = el('div', 'cx-toast' + (isErr ? ' error' : ''), msg);
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4200);
  }
  // ---------- API ----------
  async function apiGet(pathname) {
    const r = await fetch(API + pathname, { headers: { 'X-Chuxin-Workspace': workspace() } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  // ---------- 面板骨架 ----------
  // 2026-09-27 田哥选定方案 D（牛牛风格，再简单些）：投研面板只有左侧这一列 tab，
  // 每项「单色图标 + 名称 + 计数」；后端状态和「启动投研后端」放在 tab 列底部，不再单独占一行标题。
  const TAB_ICONS = {
    today: '<path d="M4 6h16M4 12h16M4 18h10"/>',
    market: '<path d="M3 17l5-6 4 4 8-9"/><path d="M15 6h5v5"/>',
    technical: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="0.5"/>',
    news: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 9h8M8 13h8M8 16h5"/>',
    targets: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    holding: '<path d="M12 3v9l7 4"/><circle cx="12" cy="12" r="9"/>',
    notes: '<path d="M5 4h11l3 3v13H5z"/><path d="M9 9h6M9 13h6M9 17h4"/>',
    lindang: '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M9 16h6"/>',
    data: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
  };
  function tabIcon(id) {
    return '<svg class="cx-tab-icon" viewBox="0 0 24 24" aria-hidden="true">' + (TAB_ICONS[id] || '') + '</svg>';
  }

  let root = null;
  function buildSkeleton() {
    root = document.getElementById('chuxin-panel');
    if (!root) return;
    root.innerHTML = '';

    state.tabsBar = el('nav', 'cx-primary-nav');
    state.tabsBar.setAttribute('aria-label', '初心投研主要功能');
    const brand = el('div', 'cx-brand');
    brand.innerHTML = '<span class="cx-brand-dot"></span>初心投研';
    const list = el('div', 'cx-tab-list');
    state.badges = {};
    state.tabButtons = [];  // 高亮只作用在 tab 按钮上（tab 列里还有品牌行和底部状态）
    for (const t of PRIMARY_TABS) {
      const b = el('button', 'cx-primary-tab');
      b.dataset.tab = t.id;
      b.type = 'button';
      b.innerHTML = tabIcon(t.id) + '<span class="cx-tab-label">' + esc(t.label) + '</span>';
      const badge = el('span', 'cx-tab-badge');
      state.badges[t.id] = badge;
      b.append(badge);
      b.addEventListener('click', () => switchTab(t.id));
      list.append(b);
      state.tabButtons.push(b);
    }
    // 后端状态、启动按钮和启动失败说明：都在 tab 列底部
    const foot = el('div', 'cx-nav-foot');
    state.statusEl = el('span', 'cx-status unknown');
    state.statusEl.innerHTML = '<span class="dot"></span><span class="txt">检测中…</span>';
    state.asofEl = el('span', 'cx-asof');
    state.startBtn = el('button', 'cx-btn', '启动投研后端');
    state.startBtn.id = 'cx-start-service';
    state.startBtn.style.display = 'none';
    state.startBtn.addEventListener('click', startService);
    state.providerEl = el('span', 'cx-provider');
    state.startErrorEl = el('div', 'cx-start-error');
    state.startErrorEl.style.display = 'none';
    foot.append(state.statusEl, state.asofEl, state.startBtn, state.providerEl, state.startErrorEl);
    state.tabsBar.append(brand, list, foot);

    // 所有 Tab 必须共用一个 iframe。旧实现为每个 Tab 各建一份前端状态，
    // 在技术雷达加入观察后，观察池 iframe 仍停留在旧快照，产生“已在观察，
    // 但观察池为空”的矛盾。
    state.frameView = el('div', 'cx-view-frame');
    state.frameView.dataset.view = 'workbench';
    state.frameView.style.display = 'flex';
    state.frame = null;

    root.append(state.tabsBar, state.frameView);
    const storedTab = localStorage.getItem(TAB_KEY) || 'today';
    const legacyMap = {
      observe: 'today', chat: 'today', insights: 'notes', developer: 'today',
      watch: 'targets', committee: 'today', clues: 'news',
      league: 'lindang',
    };
    const migratedTab = legacyMap[storedTab] || storedTab;
    switchTab(migratedTab);
  }

  // tab 上的计数：技术候选、消息事件、观察池、持仓、知识库篇数、林铛目标仓位。
  // 只读几个现成接口，失败就留空，不影响切页；一分钟最多刷一次。
  function setBadge(id, text, tone) {
    const badge = state.badges && state.badges[id];
    if (!badge) return;
    badge.textContent = text == null ? '' : String(text);
    badge.className = 'cx-tab-badge' + (tone ? ' ' + tone : '');
  }
  async function refreshBadges(force) {
    if (!state.online || (!force && Date.now() - (state.badgesAt || 0) < 60000)) return;
    state.badgesAt = Date.now();
    const [overview, holdings, knowledge, desk, sources] = await Promise.allSettled([
      apiGet('/api/observe/overview'), apiGet('/api/holdings'), apiGet('/api/knowledge'), apiGet('/api/lindang/desk'),
      apiGet('/api/data-sources/summary'),
    ]);
    if (overview.status === 'fulfilled') {
      const header = overview.value.header || {};
      const counts = header.counts || {};
      setBadge('technical', counts.technical);
      setBadge('news', counts.news_events);
      setBadge('targets', counts.watching);
      if (state.asofEl) state.asofEl.textContent = header.data_asof ? '数据截至 ' + header.data_asof : '';
    }
    if (holdings.status === 'fulfilled') {
      const rows = (holdings.value.positions || []).length;
      if (holdings.value.broker_snapshot_at) setBadge('holding', rows);
      else setBadge('holding', '未同步', 'warn');
    }
    if (knowledge.status === 'fulfilled') {
      const counts = knowledge.value.counts || {};
      setBadge('notes', Object.values(counts).reduce((sum, value) => sum + (Number(value) || 0), 0));
    }
    if (desk.status === 'fulfilled') {
      const exposure = ((desk.value.account || {}).target || {}).exposure;
      setBadge('lindang', exposure == null ? '' : Math.round(Number(exposure) * 100) + '%', 'accent');
    }
    // 账号数据：只在有源失败或待登录时亮一个橙色数字，全部正常就不打扰
    if (sources.status === 'fulfilled') {
      const attention = Number(sources.value.attention) || 0;
      setBadge('data', attention ? attention : '', 'warn');
    }
  }

  function switchTab(tabId) {
    const tab = PRIMARY_TABS.find((row) => row.id === tabId) || PRIMARY_TABS[0];
    localStorage.setItem(TAB_KEY, tab.id);
    for (const b of state.tabButtons || []) {
      b.classList.toggle('active', b.dataset.tab === tab.id);
      b.setAttribute('aria-current', b.dataset.tab === tab.id ? 'page' : 'false');
    }
    const returningFromNative = state.nativeTabActive;
    state.nativeTabActive = false;
    state.frameView.style.display = 'flex';
    const frameUrl = () => WEB + '/?api=' + encodeURIComponent(API)
      + '&workspace=' + encodeURIComponent(workspace()) + '&embed=hub&hubUi=' + state.loadToken + '#' + tab.hash;
    if (!state.frame) {
      state.frame = document.createElement('iframe');
      state.frame.className = 'cx-frame';
      state.frame.name = 'hub-chuxin';
      state.frame.setAttribute('allow', 'clipboard-read; clipboard-write');
      state.frameView.append(state.frame);
      state.frame.addEventListener('load', () => {
        state.frame.contentWindow.postMessage({ source: 'hub', type: 'chuxin-ui-version-request', requestId: state.loadToken }, new URL(WEB).origin);
      });
    }
    const navigate = () => {
      if (state.frame.dataset.hash !== tab.hash || state.frame.src !== frameUrl()) {
        state.frame.dataset.hash = tab.hash;
        state.frame.src = frameUrl();
      }
    };
    // Chromium may keep an OOP iframe document.hidden=true when navigation is
    // started in the same task that unhides its parent. Chuxin live charts
    // intentionally pause while hidden, so let layout visibility settle first.
    if (returningFromNative) setTimeout(navigate, 50);
    else navigate();
  }

  function validVersion(value) {
    return typeof value === 'string' && /^\d{8}\.\d{1,3}$/.test(value) ? value : '';
  }
  function publishVersion() {
    window.__chuxinVersionInfo = {
      loaded: state.loadedVersion, available: state.availableVersion, error: state.versionError,
    };
    window.dispatchEvent(new CustomEvent('chuxin-version-changed'));
  }
  async function checkVersion() {
    if (state.versionCheck) return state.versionCheck;
    const base = WEB;
    state.versionCheck = (async () => {
      try {
        const r = await fetch(base + '/ui-version.json?t=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(5000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const version = validVersion((await r.json()).version);
        if (!version) throw new Error('版本信息不完整');
        if (base !== WEB) return;
        state.availableVersion = version;
        state.versionError = '';
      } catch (error) {
        if (base !== WEB) return;
        state.versionError = '更新检查失败：' + error.message;
      } finally {
        publishVersion();
      }
    })();
    try { await state.versionCheck; } finally { state.versionCheck = null; }
  }
  function refreshResearch() {
    state.loadToken = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 7);
    state.loadedVersion = '';
    publishVersion();
    switchTab(localStorage.getItem(TAB_KEY));
    void checkVersion();
  }
  window.__chuxinCheckVersion = checkVersion;
  window.__chuxinRefresh = refreshResearch;

  // ---------- 作手林铛：把一次决策开成左侧栏里的普通会话 ----------
  //
  // 投研页面是个跨源 iframe，拿不到 Hub 的 IPC，所以它 postMessage 上来，这里转成 IPC。
  // 只认自己那个 iframe 的 window，并且只认一种消息类型——别把这里做成通用桥。
  async function openLindangSession(runId) {
    if (!runId) return;
    try {
      // 先刷一遍：把 chuxin 后端最新的运行（含会话身份）收进注册表
      await ipcRenderer.invoke('chuxin:lindang-sessions');
      const opened = await ipcRenderer.invoke('chuxin:open-lindang-session', { runId });
      if (!opened || !opened.ok) {
        toast((opened && opened.message) || '这次决策的会话打不开', true);
        return;
      }
      const bridge = window.__chuxinSessionBridge;
      if (!bridge) { toast('会话已启动，请在左侧栏打开。', true); return; }
      for (let i = 0; i < 40 && !bridge.get(opened.session.id); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // card 视图就是用户要的「卡片视图」：一问一答分开看，而不是一屏终端流水。
      const result = await bridge.open(opened.session.id, 'card', opened.session);
      if (!result || !result.ok) toast('会话已启动，但界面还没收到它，请在左侧栏打开。', true);
    } catch (error) {
      toast('打开决策会话失败：' + error.message, true);
    }
  }

  window.addEventListener('message', (event) => {
    if (!state.frame || event.source !== state.frame.contentWindow) return;
    if (event.origin !== new URL(WEB).origin) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.source !== 'chuxin') return;
    if (data.type === 'chuxin-ui-version' && data.requestId === state.loadToken) {
      const version = validVersion(data.version);
      if (version) { state.loadedVersion = version; publishVersion(); }
    }
    if (data.type === 'open-lindang-session') void openLindangSession(String(data.runId || ''));
    if (data.type === 'chuxin-view') rememberInnerView(String(data.hash || ''));
  });

  // 初心页面内跳转（比如林铛工作台点「打开档案」跳到知识库）后，tab 高亮跟过去，并记住当前页。
  // 只记，不导航——iframe 已经在那一页了，再设 src 会整页重载。
  const HASH_TO_TAB = { watch: 'targets', bingdian: 'lindang' };
  function rememberInnerView(hash) {
    const tabId = HASH_TO_TAB[hash] || hash;
    const tab = PRIMARY_TABS.find((row) => row.id === tabId);
    if (!tab || !state.tabsBar) return;
    localStorage.setItem(TAB_KEY, tab.id);
    for (const b of state.tabButtons || []) {
      b.classList.toggle('active', b.dataset.tab === tab.id);
      b.setAttribute('aria-current', b.dataset.tab === tab.id ? 'page' : 'false');
    }
  }

  // ---------- 状态检测 / 启动 ----------
  async function refreshStatus() {
    try {
      const s = await ipcRenderer.invoke('chuxin:status');
      if (s && s.api_base) API = s.api_base;
      if (s && s.web_base && WEB !== s.web_base) {
        WEB = s.web_base;
        state.availableVersion = '';
        refreshResearch();
      }
      state.online = !!s.online;
      if (root) root.classList.toggle('cx-online', state.online);
      if (state.online) {
        state.startErrorEl.style.display = 'none';
        state.startErrorEl.textContent = '';
        state.statusEl.className = 'cx-status online';
        state.statusEl.innerHTML = '<span class="dot"></span><span class="txt">后端在线</span>';
        state.statusEl.title = '投研后端 ' + API.replace(/^https?:\/\//, '');
        state.startBtn.style.display = 'none';
        void refreshBadges(false);
        void checkVersion();
      } else {
        state.statusEl.className = 'cx-status offline';
        state.statusEl.innerHTML = '<span class="dot"></span><span class="txt">投研后端未启动</span>';
        state.startBtn.style.display = '';
        if (state.providerEl) state.providerEl.textContent = s.error || '';
      }
    } catch (e) {
      state.online = false;
      if (root) root.classList.remove('cx-online');
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

  // ---------- 视图切换（与 Hub 其他主区面板互斥） ----------
  function setPanelVisible(visible) {
    state.opened = visible;
    const tp = document.getElementById('terminal-panel');
    const mrp = document.getElementById('meeting-room-panel');
    const homeButton = document.getElementById('btn-home');
    const researchButton = document.getElementById('btn-research');
    if (root) root.style.display = visible ? 'grid' : 'none';
    if (researchButton) {
      researchButton.classList.toggle('active', visible);
      if (visible) researchButton.setAttribute('aria-current', 'page');
      else researchButton.removeAttribute('aria-current');
    }
    if (visible && homeButton) {
      homeButton.classList.remove('active');
      homeButton.removeAttribute('aria-current');
    }
    if (visible) {
      // 打开投研：接管主区（terminal / 群聊面板由本函数隐藏；
      // 反向切换由 selectSession / selectMeeting 调 __chuxinHide，本函数不替它们恢复 tp）
      if (tp) tp.style.display = 'none';
      if (mrp) mrp.style.display = 'none';
      // 2026-09-01：学习面板是主区第四视图，同样要互斥，否则两块会叠在一起
      if (window.__studyHide) window.__studyHide();
      if (window.__ranHide) window.__ranHide(); // 2026-09-04 RAN 工作台面板互斥
      if (window.__writingHide) window.__writingHide(); // 2026-09-30 写作面板互斥
      if (window.__hubSidebar) window.__hubSidebar.collapseForPanel();
      state.badgesAt = 0;
      refreshStatus();
    } else if (window.__hubSidebar) {
      window.__hubSidebar.restore();
    }
    // 后端中途挂了要让 tab 列底部的「启动投研后端」自己回来，所以面板开着就定时查一次
    clearInterval(state.statusTimer);
    state.statusTimer = visible ? setInterval(refreshStatus, 20000) : null;
  }

  function bindEntry() {
    document.querySelectorAll('#btn-chuxin, [data-chuxin-entry]').forEach(button => {
      button.addEventListener('click', () => setPanelVisible(true));
    });
  }

  // 供 renderer.js 在 selectSession / 进入群聊时调用，确保面板被隐藏
  window.__chuxinHide = function () {
    if (state.opened) setPanelVisible(false);
  };
  window.__chuxinShow = function () { setPanelVisible(true); };

  function init() {
    buildSkeleton();
    bindEntry();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
