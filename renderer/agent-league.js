'use strict';

function createAgentLeaguePanel(options = {}) {
  const document = options.document || window.document;
  const ipcRenderer = options.ipcRenderer;
  const notify = typeof options.toast === 'function' ? options.toast : () => {};
  const state = {
    mounted: false,
    loading: false,
    sort: 'return',
    agents: [],
    schedule: null,
    run: null,
    catalog: null,
    selectedId: null,
  };
  let root = null;

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
  }

  function icon(name) {
    const paths = {
      plus: '<path d="M12 5v14M5 12h14"/>',
      play: '<path d="m8 5 11 7-11 7Z"/>',
      chevron: '<path d="m9 5 7 7-7 7"/>',
      close: '<path d="m5 5 14 14M19 5 5 19"/>',
      terminal: '<path d="m4 6 5 5-5 5M11 18h8"/>',
      cards: '<path d="M4 5h16v11H8l-4 4zM8 9h8M8 12h5"/>',
      folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
      refresh: '<path d="M20 6v5h-5M4 18v-5h5M6.1 8A7 7 0 0 1 18 6l2 5M17.9 16A7 7 0 0 1 6 18l-2-5"/>',
      settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
    };
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ''}</svg>`;
  }

  function providerLogo(agent) {
    const base = String(agent.kind || '').replace(/-resume$/, '');
    const safe = ['codex', 'claude', 'gemini', 'kimi', 'deepseek'].includes(base) ? base : 'codex';
    return `<span class="cxl-provider cxl-provider-${safe}"><img src="assets/ai-logos/${safe}.svg" alt=""><b>${escapeHtml(agent.name || safe).slice(0, 2)}</b></span>`;
  }

  function formatMoney(value) {
    const number = Number(value || 0);
    return `¥${number.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;
  }

  function formatPct(value) {
    const number = Number(value || 0) * 100;
    return `${number >= 0 ? '+' : ''}${number.toFixed(2)}%`;
  }

  function tone(value) {
    return Number(value || 0) >= 0 ? 'up' : 'down';
  }

  function sessionState(agent) {
    const status = String(agent.session && agent.session.status || 'unbound');
    if (agent.session && agent.session.live) return status === 'running' ? ['running', '运行中'] : ['active', status === 'idle' ? '空闲' : '活跃'];
    if (status === 'unbound') return ['unbound', '未绑定'];
    return ['sleep', '休眠'];
  }

  function build(container) {
    root = container;
    root.classList.add('cxl-root');
    root.innerHTML = `
      <header class="cxl-page-head">
        <div><p>AGENT LEAGUE · LIVE RANKING · NATIVE HUB SESSION</p><h1>Agent 投资联赛</h1><span>首页只回答谁领先、谁落后；点击一行再查看理念、操作、进化和原生 Session。</span></div>
        <div class="cxl-page-actions">
          <button type="button" class="cxl-btn" data-action="new-agent">${icon('plus')}新增 Agent</button>
          <button type="button" class="cxl-btn primary" data-action="run-day">${icon('play')}运行今日赛程</button>
        </div>
      </header>
      <section class="cxl-note"><p data-role="league-note">读取联赛状态…</p><span data-role="runtime-summary"></span></section>
      <section class="cxl-board">
        <header><div><h2>实时排行榜</h2><p data-role="board-subtitle">当前快照 · 点击任意 Agent 行查看详情</p></div><div class="cxl-board-tools"><button type="button" class="cxl-icon-btn" data-action="refresh" title="刷新">${icon('refresh')}</button><button type="button" class="cxl-auto" data-action="toggle-auto"></button><div class="cxl-sort"><button class="active" data-sort="return">按收益率</button><button data-sort="asset">按当前资产</button></div></div></header>
        <div class="cxl-table-head cxl-grid"><span>排名</span><span>Agent</span><span class="cxl-wide">状态</span><span>当前资产</span><span>累计收益</span><span class="cxl-wide">今日</span><span class="cxl-wide">最大回撤</span><span class="cxl-wide">仓位</span><span class="cxl-wide">最近决策</span><span></span></div>
        <div class="cxl-ranking" data-role="ranking" aria-live="polite"></div>
        <footer><span>一屏容纳 8 行；更多 Agent 在当前区域继续向下滚动</span><code data-role="root-path"></code></footer>
      </section>
      <div class="cxl-empty" data-role="empty" hidden><h2>还没有参赛 Agent</h2><p>从一个明确投资理念开始，系统会创建独立 Markdown 文件夹和普通 AI Hub Session。</p><button type="button" class="cxl-btn primary" data-action="new-agent">${icon('plus')}创建第一个 Agent</button></div>
      <div class="cxl-overlay" data-role="detail-overlay" hidden><aside class="cxl-drawer" data-role="drawer"></aside></div>
      <div class="cxl-overlay modal" data-role="create-overlay" hidden>
        <form class="cxl-create" data-role="create-form">
          <header><div><h2>新增参赛 Agent</h2><p>理念与 AI Provider 分开选择，不预设模型擅长哪种风格。</p></div><button type="button" class="cxl-close" data-action="close-create" aria-label="关闭">${icon('close')}</button></header>
          <div class="cxl-form-grid">
            <label><span>Agent 名称</span><input name="name" maxlength="40" required placeholder="例如：逐浪"></label>
            <label><span>英文 ID（可留空）</span><input name="id" maxlength="40" placeholder="wave-rider"></label>
            <label><span>AI Provider</span><select name="provider" required></select></label>
            <label><span>模型</span><select name="model" required></select></label>
            <label class="full"><span>投资理念</span><select name="philosophyKey" required></select><small data-role="philosophy-note"></small></label>
            <label><span>初始模拟资金</span><input name="initialCash" type="number" min="10000" step="10000" value="1000000" required></label>
          </div>
          <footer><button type="button" class="cxl-btn" data-action="close-create">取消</button><button type="submit" class="cxl-btn primary">创建文件夹并绑定 Session</button></footer>
        </form>
      </div>`;
    bindEvents();
    state.mounted = true;
  }

  function bindEvents() {
    root.addEventListener('click', async (event) => {
      const actionEl = event.target.closest('[data-action]');
      if (actionEl) {
        const action = actionEl.dataset.action;
        if (action === 'new-agent') openCreate();
        else if (action === 'close-create') closeCreate();
        else if (action === 'close-detail') closeDetail();
        else if (action === 'refresh') await refresh(true);
        else if (action === 'run-day') await runDay(actionEl);
        else if (action === 'toggle-auto') await toggleAuto();
        else if (action === 'open-card') await openSession(actionEl.dataset.agent, 'card');
        else if (action === 'open-pty') await openSession(actionEl.dataset.agent, 'pty');
        else if (action === 'open-folder') await openFolder(actionEl.dataset.agent);
        return;
      }
      const sort = event.target.closest('[data-sort]');
      if (sort) {
        state.sort = sort.dataset.sort === 'asset' ? 'asset' : 'return';
        root.querySelectorAll('[data-sort]').forEach((button) => button.classList.toggle('active', button === sort));
        renderRanking();
        return;
      }
      const row = event.target.closest('[data-agent-row]');
      if (row) openDetail(row.dataset.agentRow);
      if (event.target.matches('[data-role="detail-overlay"]')) closeDetail();
      if (event.target.matches('[data-role="create-overlay"]')) closeCreate();
    });
    root.querySelector('[data-role="create-form"]').addEventListener('submit', createAgent);
    root.querySelector('[name="provider"]').addEventListener('change', renderModelOptions);
    root.querySelector('[name="philosophyKey"]').addEventListener('change', renderPhilosophyNote);
    for (const channel of ['agent-league:run-updated', 'agent-league:run-finished', 'agent-league:agent-started', 'agent-league:agent-completed', 'agent-league:agent-failed']) {
      ipcRenderer.on(channel, () => { if (root && root.offsetParent !== null) refresh(false); });
    }
  }

  async function loadCatalog() {
    if (state.catalog) return state.catalog;
    const result = await ipcRenderer.invoke('agent-league:catalog');
    if (!result || !result.ok) throw new Error(result && result.message || '联赛目录读取失败');
    state.catalog = result;
    return result;
  }

  async function refresh(showError = true) {
    if (state.loading) return;
    state.loading = true;
    root.classList.add('loading');
    try {
      await loadCatalog();
      const result = await ipcRenderer.invoke('agent-league:list', { sort: state.sort });
      if (!result || !result.ok) throw new Error(result && result.message || '排行榜读取失败');
      state.agents = Array.isArray(result.agents) ? result.agents : [];
      state.schedule = result.schedule || {};
      state.run = result.run || null;
      root.querySelector('[data-role="root-path"]').textContent = result.root || '';
      render();
    } catch (error) {
      if (showError) notify(`Agent 联赛读取失败：${error.message}`, true);
    } finally {
      state.loading = false;
      root.classList.remove('loading');
    }
  }

  function render() {
    const empty = root.querySelector('[data-role="empty"]');
    const board = root.querySelector('.cxl-board');
    empty.hidden = state.agents.length > 0;
    board.hidden = state.agents.length === 0;
    const active = state.agents.filter((agent) => agent.session && agent.session.live && agent.session.status !== 'idle').length;
    const idle = state.agents.filter((agent) => agent.session && agent.session.live && agent.session.status === 'idle').length;
    const sleeping = state.agents.filter((agent) => !agent.session || !agent.session.live).length;
    root.querySelector('[data-role="runtime-summary"]').innerHTML = `<i></i>${active} 活跃 · ${idle} 空闲 · ${sleeping} 休眠`;
    root.querySelector('[data-role="league-note"]').innerHTML = `<b>${state.agents.length} 个 Agent · 独立 Markdown 文件夹</b>　当前资产与收益率同时展示；不统计无意义的联赛总资产。`;
    const auto = root.querySelector('[data-action="toggle-auto"]');
    auto.classList.toggle('active', !!state.schedule.enabled);
    auto.textContent = state.schedule.enabled ? `自动赛程 ${state.schedule.runTime || '18:30'}` : '自动赛程未启用';
    const runButton = root.querySelector('[data-action="run-day"]');
    runButton.disabled = !!state.run;
    runButton.innerHTML = state.run ? `${icon('play')}赛程运行中` : `${icon('play')}运行今日赛程`;
    root.querySelector('[data-role="board-subtitle"]').textContent = state.run
      ? `${state.run.asOf} · ${state.run.completed.length}/${state.agents.length} 已完成 · ${state.run.active.length} 运行中`
      : `最近赛程：${state.schedule.lastSnapshotAsOf || '尚未运行'} · 点击任意 Agent 行查看详情`;
    renderRanking();
    if (state.selectedId) {
      const selected = state.agents.find((agent) => agent.id === state.selectedId);
      if (selected && !root.querySelector('[data-role="detail-overlay"]').hidden) renderDrawer(selected);
    }
  }

  function renderRanking() {
    const ranking = root.querySelector('[data-role="ranking"]');
    const sorted = [...state.agents].sort((a, b) => state.sort === 'asset'
      ? Number(b.stats.nav) - Number(a.stats.nav)
      : Number(b.stats.totalReturn) - Number(a.stats.totalReturn));
    ranking.innerHTML = sorted.map((agent, index) => {
      const [statusClass, statusText] = sessionState(agent);
      const stats = agent.stats || {};
      return `<button type="button" class="cxl-row cxl-grid ${state.selectedId === agent.id ? 'selected' : ''}" data-agent-row="${escapeHtml(agent.id)}" aria-label="第 ${index + 1} 名，${escapeHtml(agent.name)}，累计收益 ${formatPct(stats.totalReturn)}">
        <span class="cxl-rank ${index < 3 ? `top${index + 1}` : ''}">${index + 1}</span>
        <span class="cxl-agent">${providerLogo(agent)}<span><b>${escapeHtml(agent.name)}</b><small>${escapeHtml(agent.philosophy && agent.philosophy.title || '')} · ${escapeHtml(agent.provider)}</small></span></span>
        <span class="cxl-status ${statusClass} cxl-wide"><i></i>${statusText}</span>
        <span class="cxl-number"><b>${formatMoney(stats.nav)}</b><small>初始 ${formatMoney(agent.initialCash || stats.nav)}</small></span>
        <span class="cxl-return ${tone(stats.totalReturn)}">${formatPct(stats.totalReturn)}</span>
        <span class="cxl-small ${tone(stats.dailyReturn)} cxl-wide">${formatPct(stats.dailyReturn)}</span>
        <span class="cxl-small cxl-wide">${formatPct(stats.maxDrawdown)}</span>
        <span class="cxl-position cxl-wide"><b>${formatPct(stats.positionWeight).replace('+', '')}</b><i><em style="width:${Math.max(0, Math.min(100, Number(stats.positionWeight || 0) * 100))}%"></em></i></span>
        <span class="cxl-small cxl-wide">${escapeHtml((agent.lastDecisionAt || '尚未决策').replace('T', ' ').slice(0, 16))}</span>
        <span class="cxl-arrow">${icon('chevron')}</span>
      </button>`;
    }).join('');
  }

  function openDetail(agentId) {
    const agent = state.agents.find((row) => row.id === agentId);
    if (!agent) return;
    state.selectedId = agentId;
    renderRanking();
    renderDrawer(agent);
    root.querySelector('[data-role="detail-overlay"]').hidden = false;
  }

  function closeDetail() {
    root.querySelector('[data-role="detail-overlay"]').hidden = true;
  }

  function renderDrawer(agent) {
    const stats = agent.stats || {};
    const [statusClass, statusText] = sessionState(agent);
    const positions = agent.portfolio && Array.isArray(agent.portfolio.positions) ? agent.portfolio.positions : [];
    const drawer = root.querySelector('[data-role="drawer"]');
    drawer.innerHTML = `<header><div class="cxl-drawer-id">${providerLogo(agent)}<div><h2>${escapeHtml(agent.name)}</h2><p>${escapeHtml(agent.philosophy && agent.philosophy.title || '')} · ${escapeHtml(agent.provider)} · ${escapeHtml(agent.model)}</p></div></div><button type="button" class="cxl-close" data-action="close-detail" aria-label="关闭">${icon('close')}</button></header>
      <div class="cxl-drawer-actions"><button type="button" class="cxl-btn primary" data-action="open-card" data-agent="${escapeHtml(agent.id)}">${icon('cards')}打开卡片 Session</button><button type="button" class="cxl-btn" data-action="open-pty" data-agent="${escapeHtml(agent.id)}">${icon('terminal')}打开 PTY</button></div>
      <div class="cxl-detail-metrics"><div><span>当前资产</span><b>${formatMoney(stats.nav)}</b><small class="${tone(stats.totalReturn)}">${formatPct(stats.totalReturn)}</small></div><div><span>今日收益</span><b class="${tone(stats.dailyReturn)}">${formatPct(stats.dailyReturn)}</b><small>${escapeHtml(stats.lastAsOf || '尚未结算')}</small></div><div><span>最大回撤</span><b>${formatPct(stats.maxDrawdown)}</b><small>${stats.tradingDays || 0} 个统计日</small></div><div><span>Session</span><b class="cxl-status ${statusClass}"><i></i>${statusText}</b><small>${escapeHtml(agent.session && agent.session.hubSessionId || '尚未绑定')}</small></div></div>
      <section class="cxl-detail-section"><h3>核心理念</h3><p>${escapeHtml(agent.philosophy && agent.philosophy.summary || '自定义理念')}</p><blockquote>${escapeHtml(agent.philosophy && agent.philosophy.edge || '')}</blockquote></section>
      <section class="cxl-detail-section"><div class="cxl-section-head"><h3>当前持仓</h3><span>PORTFOLIO.md</span></div>${positions.length ? `<div class="cxl-holdings">${positions.map((position) => `<div><span><b>${escapeHtml(position.name || position.symbol)}</b><small>${escapeHtml(position.symbol)} · ${Number(position.quantity || 0).toLocaleString('zh-CN')} 股</small></span><span>${formatMoney(position.marketValue || position.quantity * position.lastPrice)}</span></div>`).join('')}</div>` : '<p class="cxl-muted">当前为空仓。</p>'}</section>
      <section class="cxl-detail-section"><div class="cxl-section-head"><h3>每日进化</h3><span>${agent.evolutionDays || 0} 天</span></div>${agent.recentLessons && agent.recentLessons.length ? `<ul>${agent.recentLessons.map((lesson) => `<li><b>${escapeHtml(lesson.date || '')}</b>${escapeHtml(lesson.text || '')}</li>`).join('')}</ul>` : '<p class="cxl-muted">尚无待验证经验。</p>'}</section>
      <section class="cxl-detail-section"><div class="cxl-section-head"><h3>最近操作</h3><span>${stats.tradeCount || 0} 笔</span></div>${agent.recentTrades && agent.recentTrades.length ? `<div class="cxl-trades">${agent.recentTrades.map((trade) => `<div><b class="${trade.side === 'BUY' ? 'up' : 'down'}">${escapeHtml(trade.side)}</b><span>${escapeHtml(trade.name || trade.symbol)} · ${trade.quantity} 股</span><em>${formatMoney(trade.notional)}</em></div>`).join('')}</div>` : '<p class="cxl-muted">尚无模拟成交。</p>'}</section>
      <footer><code>${escapeHtml(agent.folder)}</code><button type="button" data-action="open-folder" data-agent="${escapeHtml(agent.id)}">${icon('folder')}打开 Agent 文件夹</button></footer>`;
  }

  async function openSession(agentId, view) {
    let agent = state.agents.find((row) => row.id === agentId);
    if (!agent) return;
    const bridge = window.__chuxinSessionBridge;
    let result = null;
    if (bridge && agent.session && agent.session.hubSessionId) {
      try { result = await bridge.open(agent.session.hubSessionId, view); } catch {}
    }
    if (!result || !result.ok) {
      const ensured = await ipcRenderer.invoke('agent-league:ensure-session', { agentId });
      if (!ensured || !ensured.ok) {
        notify((ensured && ensured.message) || 'Agent Session 打开失败', true);
        return;
      }
      for (let i = 0; i < 30 && bridge && !bridge.get(ensured.session.id); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      result = bridge ? await bridge.open(ensured.session.id, view) : null;
    }
    if (!result || !result.ok) notify('Session 已启动，但 Hub 界面尚未收到 session-created 事件，请在左侧栏打开。', true);
  }

  async function openFolder(agentId) {
    const agent = state.agents.find((row) => row.id === agentId);
    if (!agent) return;
    const error = await ipcRenderer.invoke('open-path', agent.folder);
    if (error) notify(`打开文件夹失败：${error}`, true);
  }

  async function runDay(button) {
    button.disabled = true;
    try {
      const result = await ipcRenderer.invoke('agent-league:run-day', { trigger: 'manual' });
      if (!result || !result.ok) throw new Error(result && result.message || '赛程启动失败');
      notify(result.alreadyRun ? '当前冻结快照已经完成赛程' : '赛程已启动；Agent 将按并发上限依次运行');
      await refresh(false);
    } catch (error) {
      notify(`运行赛程失败：${error.message}`, true);
    } finally {
      button.disabled = false;
    }
  }

  async function toggleAuto() {
    const enabled = !(state.schedule && state.schedule.enabled);
    const result = await ipcRenderer.invoke('agent-league:update-schedule', {
      enabled,
      runTime: state.schedule && state.schedule.runTime || '18:30',
      maxConcurrency: state.schedule && state.schedule.maxConcurrency || 2,
    });
    if (!result || !result.ok) return notify('自动赛程设置失败', true);
    state.schedule = result.schedule;
    notify(enabled ? '自动赛程已启用（北京时间 18:30 后检查新快照）' : '自动赛程已停用');
    render();
  }

  async function openCreate() {
    try { await loadCatalog(); } catch (error) { return notify(error.message, true); }
    const overlay = root.querySelector('[data-role="create-overlay"]');
    const provider = overlay.querySelector('[name="provider"]');
    const philosophy = overlay.querySelector('[name="philosophyKey"]');
    provider.innerHTML = state.catalog.providers.map((row) => `<option value="${escapeHtml(row.provider)}">${escapeHtml(row.name)}</option>`).join('');
    philosophy.innerHTML = state.catalog.philosophies.map((row) => `<option value="${escapeHtml(row.key)}">${escapeHtml(row.title)}</option>`).join('');
    renderModelOptions();
    renderPhilosophyNote();
    overlay.hidden = false;
    setTimeout(() => overlay.querySelector('[name="name"]').focus(), 30);
  }

  function closeCreate() {
    root.querySelector('[data-role="create-overlay"]').hidden = true;
  }

  function renderModelOptions() {
    if (!state.catalog) return;
    const form = root.querySelector('[data-role="create-form"]');
    const provider = form.elements.provider.value;
    const row = state.catalog.providers.find((item) => item.provider === provider) || state.catalog.providers[0];
    form.elements.model.innerHTML = (row.models || []).map((model) => `<option value="${escapeHtml(model.id)}" ${model.id === row.defaultModel ? 'selected' : ''}>${escapeHtml(model.label || model.id)}</option>`).join('');
  }

  function renderPhilosophyNote() {
    if (!state.catalog) return;
    const form = root.querySelector('[data-role="create-form"]');
    const row = state.catalog.philosophies.find((item) => item.key === form.elements.philosophyKey.value) || state.catalog.philosophies[0];
    root.querySelector('[data-role="philosophy-note"]').textContent = `${row.summary} 典型周期：${row.horizon}`;
  }

  async function createAgent(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const payload = Object.fromEntries(new FormData(form).entries());
      payload.initialCash = Number(payload.initialCash || 1000000);
      const result = await ipcRenderer.invoke('agent-league:create', payload);
      if (!result || !result.ok) throw new Error(result && result.message || '创建失败');
      closeCreate();
      form.reset();
      notify(`${result.agent.name} 已创建，并绑定普通 ${result.agent.provider} Session`);
      await refresh(false);
      openDetail(result.agent.id);
    } catch (error) {
      notify(`创建 Agent 失败：${error.message}`, true);
    } finally {
      submit.disabled = false;
    }
  }

  return {
    mount(container) { if (!state.mounted) build(container); return this; },
    async show() { if (!state.mounted) throw new Error('AgentLeaguePanel is not mounted'); await refresh(true); },
    refresh,
    getState: () => ({ ...state, agents: [...state.agents] }),
  };
}

module.exports = {
  createAgentLeaguePanel,
};
