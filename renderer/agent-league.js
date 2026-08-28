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
    promptAgentId: null,
    promptWorkbench: null,
    promptKey: null,
    promptDirty: false,
    promptSaving: false,
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
      sunrise: '<path d="M12 3v3M4.2 7.2l2.1 2.1M19.8 7.2l-2.1 2.1M3 16h18M6 16a6 6 0 0 1 12 0M5 21h14"/>',
      check: '<path d="m5 12 4 4L19 6"/>',
      book: '<path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H20v17H7.5A3.5 3.5 0 0 0 4 22Z"/><path d="M4 5.5V22M8 7h8M8 11h6"/>',
      edit: '<path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>',
      save: '<path d="M5 3h12l2 2v16H5Z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/>',
      file: '<path d="M6 3h9l4 4v14H6Z"/><path d="M15 3v5h5M9 13h6M9 17h6"/>',
      lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
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
    const native = agent.session && agent.session.nativeSession || {};
    const nativeBound = !!(native.codexSid || native.ccSessionId || native.geminiChatId || native.kimiSid);
    if (agent.session && agent.session.hubSessionId && !nativeBound) return ['pending', '待首次运行'];
    if (agent.session && agent.session.live) return status === 'running' ? ['running', '运行中'] : ['active', status === 'idle' ? '空闲' : '活跃'];
    if (!agent.session || !agent.session.hubSessionId || status === 'unbound') return ['unbound', '未创建'];
    return ['sleep', '休眠'];
  }

  function nativeSessionId(agent) {
    const native = agent.session && agent.session.nativeSession || {};
    return native.codexSid || native.ccSessionId || native.geminiChatId || native.kimiSid || '';
  }

  function build(container) {
    root = container;
    root.classList.add('cxl-root');
    root.innerHTML = `
      <header class="cxl-page-head">
        <div><p>AGENT LEAGUE · DAILY DECISION · NATIVE HUB SESSION</p><h1>Agent 投资联赛</h1><span>交易日盘前预案 → 同 Session 自检 Hook → 开盘一次执行；周六沉淀。点击一行查看完整思考与原生 Session。</span></div>
        <div class="cxl-page-actions">
          <button type="button" class="cxl-btn" data-action="new-agent">${icon('plus')}新增 Agent</button>
          <button type="button" class="cxl-btn primary" data-action="run-day">${icon('play')}盘前决策</button>
          <button type="button" class="cxl-btn" data-action="execute-open">${icon('sunrise')}开盘执行</button>
          <button type="button" class="cxl-btn" data-action="record-close">${icon('check')}收盘记账</button>
          <button type="button" class="cxl-btn" data-action="run-weekly">${icon('book')}周六沉淀</button>
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
            <label><span>初始模拟资金</span><input name="initialCash" type="number" min="10000" step="10000" value="500000" required></label>
          </div>
          <footer><button type="button" class="cxl-btn" data-action="close-create">取消</button><button type="submit" class="cxl-btn primary">创建文件夹并绑定 Session</button></footer>
        </form>
      </div>
      <div class="cxl-overlay modal cxl-prompt-overlay" data-role="prompt-overlay" hidden>
        <section class="cxl-prompt-workbench" role="dialog" aria-modal="true" aria-labelledby="cxl-prompt-title">
          <header><div><p>PROMPT INSPECTOR · VERSIONED MARKDOWN</p><h2 id="cxl-prompt-title">Agent 提示词工作台</h2><span data-role="prompt-agent-note">加载 Agent 文件…</span></div><button type="button" class="cxl-close" data-action="close-prompts" aria-label="关闭提示词工作台">${icon('close')}</button></header>
          <div class="cxl-prompt-load-order" data-role="prompt-load-order"></div>
          <div class="cxl-prompt-layout">
            <aside><div class="cxl-prompt-filter"><button type="button" class="active" data-prompt-group="all">全部</button><button type="button" data-prompt-group="investment">投资内核</button><button type="button" data-prompt-group="runtime">运行提示</button><button type="button" data-prompt-group="provider">Provider</button><button type="button" data-prompt-group="context">长期上下文</button><button type="button" data-prompt-group="contract">系统合同</button><button type="button" data-prompt-group="system-ledger">系统 / 账本</button></div><nav data-role="prompt-files" aria-label="Agent 提示词文件"></nav></aside>
            <main><header class="cxl-editor-head"><div><span data-role="prompt-group-label">文件</span><h3 data-role="prompt-file-title">选择一个文件</h3><p data-role="prompt-file-description"></p></div><div><span class="cxl-editor-mode" data-role="prompt-mode">只读</span><code data-role="prompt-hash"></code></div></header><textarea data-role="prompt-editor" spellcheck="false" aria-label="提示词 Markdown 编辑器" readonly></textarea><details class="cxl-machine-state" data-role="machine-state"><summary>受保护的机器状态</summary><pre></pre></details></main>
          </div>
          <footer><div><span data-role="prompt-status">选择左侧文件查看完整内容</span><small>可编辑文件保存前会自动备份；系统账本与结构合同只读。</small></div><div><button type="button" class="cxl-btn" data-action="reload-prompt">重新载入</button><button type="button" class="cxl-btn" data-action="discard-prompt" disabled>放弃修改</button><button type="button" class="cxl-btn primary" data-action="save-prompt" disabled>${icon('save')}保存</button></div></footer>
        </section>
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
        else if (action === 'execute-open') await runPhase(actionEl, 'agent-league:execute-open', '正在读取开盘价并机械执行目标组合', '开盘执行完成');
        else if (action === 'record-close') await runPhase(actionEl, 'agent-league:record-close', '正在读取收盘行情并更新净值', '收盘记账完成');
        else if (action === 'run-weekly') await runPhase(actionEl, 'agent-league:run-weekly', '正在唤醒同一 Session 做周度沉淀', '周度沉淀已启动');
        else if (action === 'toggle-auto') await toggleAuto();
        else if (action === 'open-card') await openSession(actionEl.dataset.agent, 'card');
        else if (action === 'open-pty') await openSession(actionEl.dataset.agent, 'pty');
        else if (action === 'open-folder') await openFolder(actionEl.dataset.agent);
        else if (action === 'edit-prompts') await openPromptWorkbench(actionEl.dataset.agent);
        else if (action === 'close-prompts') closePromptWorkbench();
        else if (action === 'save-prompt') await savePromptFile();
        else if (action === 'reload-prompt') await reloadPromptWorkbench();
        else if (action === 'discard-prompt') discardPromptChanges();
        return;
      }
      const promptGroup = event.target.closest('[data-prompt-group]');
      if (promptGroup) {
        root.querySelectorAll('[data-prompt-group]').forEach((button) => button.classList.toggle('active', button === promptGroup));
        renderPromptFileList(promptGroup.dataset.promptGroup || 'all');
        return;
      }
      const promptFile = event.target.closest('[data-prompt-key]');
      if (promptFile) {
        selectPromptFile(promptFile.dataset.promptKey);
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
      if (event.target.matches('[data-role="prompt-overlay"]')) closePromptWorkbench();
    });
    root.querySelector('[data-role="create-form"]').addEventListener('submit', createAgent);
    root.querySelector('[name="provider"]').addEventListener('change', renderModelOptions);
    root.querySelector('[name="philosophyKey"]').addEventListener('change', renderPhilosophyNote);
    const promptEditor = root.querySelector('[data-role="prompt-editor"]');
    promptEditor.addEventListener('input', () => setPromptDirty(true));
    promptEditor.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 's') {
        event.preventDefault();
        savePromptFile();
      }
    });
    for (const channel of ['agent-league:run-updated', 'agent-league:run-finished', 'agent-league:agent-started', 'agent-league:hook-started', 'agent-league:agent-completed', 'agent-league:agent-failed', 'agent-league:execution-completed', 'agent-league:close-completed', 'agent-league:session-updated']) {
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
    root.querySelector('[data-role="league-note"]').innerHTML = `<b>${state.agents.length} 个 Agent · 每席 ¥500,000 · 沪深全市场（不含北交所）</b>　费用：佣金双边万一、卖出印花税千一；投资风险由 Agent 自检，申报单位由系统机械执行。`;
    const auto = root.querySelector('[data-action="toggle-auto"]');
    auto.classList.toggle('active', !!state.schedule.enabled);
    auto.textContent = state.schedule.enabled ? `自动 ${state.schedule.decisionTime || '08:30'} / 周六 ${state.schedule.weeklyTime || '10:00'}` : '自动赛程未启用';
    const runButton = root.querySelector('[data-action="run-day"]');
    runButton.disabled = !!state.run;
    runButton.innerHTML = state.run ? `${icon('play')}赛程运行中` : `${icon('play')}盘前决策`;
    for (const action of ['execute-open', 'record-close', 'run-weekly']) {
      const button = root.querySelector(`[data-action="${action}"]`);
      if (button) button.disabled = !!state.run;
    }
    root.querySelector('[data-role="board-subtitle"]').textContent = state.run
      ? `${state.run.mode === 'weekly' ? '周度沉淀' : '盘前决策'} ${state.run.decisionDate || state.run.asOf} · ${state.run.completed.length}/${state.agents.length} 已完成 · ${state.run.active.length} 运行中`
      : `最近决策：${state.schedule.lastDecisionDate || '尚未运行'} · 开盘执行：${state.schedule.lastExecutionDate || '无'} · 点击任意 Agent 行查看详情`;
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
        <span class="cxl-small cxl-wide"><b>${escapeHtml(agent.lastHookVerdict || '—')}</b><small>${escapeHtml(agent.latestDaily && agent.latestDaily.decisionDate || (agent.lastDecisionAt || '尚未决策').replace('T', ' ').slice(0, 10))}</small></span>
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

  function decisionTargets(decision) {
    if (!decision || !Array.isArray(decision.targets) || !decision.targets.length) return '<p class="cxl-muted">全现金或不调整股票目标。</p>';
    return `<div class="cxl-decision-targets">${decision.targets.map((target) => `<div><span><b>${escapeHtml(target.name || target.symbol)}</b><small>${escapeHtml(target.symbol)} · ${(Number(target.target_weight || 0) * 100).toFixed(1)}% · ${escapeHtml((target.rule_refs || []).join('/'))}</small></span><p>${escapeHtml(target.thesis || '')}</p></div>`).join('')}</div>`;
  }

  function dailyFlowHtml(agent) {
    const daily = agent.latestDaily;
    if (!daily) return '<p class="cxl-muted">尚无每日决策记录。</p>';
    const hook = daily.hook || {};
    const brief = daily.dailyBrief || {};
    const checks = Array.isArray(hook.rule_checks) ? hook.rule_checks : [];
    return `<div class="cxl-flow-meta"><span>${escapeHtml(daily.decisionDate || '')}</span><span>数据截至 ${escapeHtml(daily.dataAsOf || '—')}</span><span class="cxl-hook-verdict ${escapeHtml(String(hook.verdict || '').toLowerCase())}">${escapeHtml(hook.verdict || daily.status || '—')}</span></div>
      <div class="cxl-decision-compare"><article><header><b>DRAFT</b><span>盘前原始预案</span></header><p>${escapeHtml(daily.draft && daily.draft.action_summary || '尚未形成')}</p>${decisionTargets(daily.draft)}</article><article><header><b>FINAL</b><span>Hook 后锁定</span></header><p>${escapeHtml(daily.decision && daily.decision.action_summary || '尚未锁定')}</p>${decisionTargets(daily.decision)}</article></div>
      ${checks.length ? `<div class="cxl-hook-checks">${checks.map((row) => `<div><b>${escapeHtml(row.rule_id)}</b><span class="${escapeHtml(String(row.status || '').toLowerCase())}">${escapeHtml(row.status)}</span><p>${escapeHtml(row.comment)}</p></div>`).join('')}</div>` : ''}
      ${brief.body ? `<article class="cxl-brief"><header><span>DAILY BRIEF</span><h4>${escapeHtml(brief.headline || '今日思考')}</h4></header><p>${escapeHtml(brief.body)}</p><blockquote>Hook 变化：${escapeHtml(brief.hook_change || '无')}</blockquote></article>` : ''}`;
  }

  function weeklyHtml(agent) {
    const weekly = agent.latestWeekly;
    if (!weekly) return '<p class="cxl-muted">尚未运行周六沉淀。</p>';
    if (weekly.status !== 'completed' || !weekly.review) return `<p class="cxl-muted">${escapeHtml(weekly.saturdayDate || '')} · ${escapeHtml(weekly.status || '等待中')}${weekly.error ? ` · ${escapeHtml(weekly.error)}` : ''}</p>`;
    const review = weekly.review;
    return `<div class="cxl-weekly"><p>${escapeHtml(review.summary || '')}</p><div><span><b>过程做对</b>${escapeHtml(review.process_win || '')}</span><span><b>过程需改</b>${escapeHtml(review.process_mistake || '')}</span></div><blockquote>${escapeHtml(review.lesson || '')}</blockquote><small>最强反例：${escapeHtml(review.strongest_counterexample || '')}</small>${review.checklist_proposal ? `<em>规则提案 ${escapeHtml(review.checklist_proposal.rule_id)}：${escapeHtml(review.checklist_proposal.proposed_rule || '')}</em>` : ''}</div>`;
  }

  function renderDrawer(agent) {
    const stats = agent.stats || {};
    const [statusClass, statusText] = sessionState(agent);
    const positions = agent.portfolio && Array.isArray(agent.portfolio.positions) ? agent.portfolio.positions : [];
    const drawer = root.querySelector('[data-role="drawer"]');
    drawer.innerHTML = `<header><div class="cxl-drawer-id">${providerLogo(agent)}<div><h2>${escapeHtml(agent.name)}</h2><p>${escapeHtml(agent.philosophy && agent.philosophy.title || '')} · ${escapeHtml(agent.provider)} · ${escapeHtml(agent.model)}</p></div></div><button type="button" class="cxl-close" data-action="close-detail" aria-label="关闭">${icon('close')}</button></header>
      <div class="cxl-drawer-actions"><button type="button" class="cxl-btn primary" data-action="open-card" data-agent="${escapeHtml(agent.id)}">${icon('cards')}${agent.session && agent.session.hubSessionId ? '打开卡片 Session' : '创建卡片 Session'}</button><button type="button" class="cxl-btn" data-action="open-pty" data-agent="${escapeHtml(agent.id)}">${icon('terminal')}${agent.session && agent.session.hubSessionId ? '打开 PTY' : '创建并打开 PTY'}</button><button type="button" class="cxl-btn prompt" data-action="edit-prompts" data-agent="${escapeHtml(agent.id)}">${icon('edit')}查看 / 编辑全部提示词</button></div>
      <div class="cxl-detail-metrics"><div><span>当前资产</span><b>${formatMoney(stats.nav)}</b><small class="${tone(stats.totalReturn)}">${formatPct(stats.totalReturn)}</small></div><div><span>今日收益</span><b class="${tone(stats.dailyReturn)}">${formatPct(stats.dailyReturn)}</b><small>${escapeHtml(stats.lastAsOf || '尚未结算')}</small></div><div><span>最大回撤</span><b>${formatPct(stats.maxDrawdown)}</b><small>${stats.tradingDays || 0} 个统计日</small></div><div><span>Session</span><b class="cxl-status ${statusClass}"><i></i>${statusText}</b><small>${escapeHtml(nativeSessionId(agent) ? `原生 SID ${nativeSessionId(agent).slice(0, 8)}…` : agent.session && agent.session.hubSessionId ? 'Hub 已绑定 · 首次运行后生成原生 SID' : '点击上方按钮创建普通 Session')}</small></div></div>
      <section class="cxl-detail-section"><div class="cxl-section-head"><h3>核心理念</h3><span>${agent.strategyPendingConfirmation ? '第一版 · 待你确认' : `策略 ${escapeHtml(agent.strategyVersion || 'v1')}`}</span></div><p>${escapeHtml(agent.philosophy && agent.philosophy.summary || '自定义理念')}</p><blockquote>${escapeHtml(agent.philosophy && agent.philosophy.edge || '')}</blockquote></section>
      <section class="cxl-detail-section cxl-prompt-summary"><div class="cxl-section-head"><h3>这个 Agent 实际会读什么</h3><button type="button" data-action="edit-prompts" data-agent="${escapeHtml(agent.id)}">完整查看与编辑 →</button></div><div><span><b>投资内核</b>AGENT / STRATEGY / CHECKLIST</span><span><b>三段运行提示</b>盘前 DRAFT / 决策 Hook / 周六沉淀</span><span><b>Provider 指令</b>AGENTS / CLAUDE / GEMINI</span><span><b>长期上下文</b>MEMORY / EVOLUTION</span><span><b>系统合同</b>完整编译预览，只读</span></div></section>
      <section class="cxl-detail-section cxl-daily-flow"><div class="cxl-section-head"><h3>今日决策链</h3><span>DRAFT → HOOK → FINAL</span></div>${dailyFlowHtml(agent)}</section>
      <section class="cxl-detail-section"><div class="cxl-section-head"><h3>个人 CHECKLIST</h3><span>${(agent.checklist && agent.checklist.rules || []).length} 条规则</span></div><div class="cxl-checklist">${(agent.checklist && agent.checklist.rules || []).map((rule) => `<div><b>${escapeHtml(rule.id)}</b><p>${escapeHtml(rule.text)}</p></div>`).join('') || '<p class="cxl-muted">尚未配置。</p>'}</div></section>
      <section class="cxl-detail-section"><div class="cxl-section-head"><h3>当前持仓</h3><span>PORTFOLIO.md</span></div>${positions.length ? `<div class="cxl-holdings">${positions.map((position) => `<div><span><b>${escapeHtml(position.name || position.symbol)}</b><small>${escapeHtml(position.symbol)} · ${Number(position.quantity || 0).toLocaleString('zh-CN')} 股</small></span><span>${formatMoney(position.marketValue || position.quantity * position.lastPrice)}</span></div>`).join('')}</div>` : '<p class="cxl-muted">当前为空仓。</p>'}</section>
      <section class="cxl-detail-section"><div class="cxl-section-head"><h3>周六沉淀</h3><span>${agent.weeklyReviewCount || 0} 次</span></div>${weeklyHtml(agent)}</section>
      <section class="cxl-detail-section"><div class="cxl-section-head"><h3>待验证经验</h3><span>MEMORY.md</span></div>${agent.recentLessons && agent.recentLessons.length ? `<ul>${agent.recentLessons.map((lesson) => `<li><b>${escapeHtml(lesson.date || '')}</b>${escapeHtml(lesson.text || '')}</li>`).join('')}</ul>` : '<p class="cxl-muted">周六沉淀后才会新增经验。</p>'}</section>
      <section class="cxl-detail-section"><div class="cxl-section-head"><h3>最近操作</h3><span>${stats.tradeCount || 0} 笔</span></div>${agent.recentTrades && agent.recentTrades.length ? `<div class="cxl-trades">${agent.recentTrades.map((trade) => `<div><b class="${trade.side === 'BUY' ? 'up' : 'down'}">${escapeHtml(trade.side)}</b><span>${escapeHtml(trade.name || trade.symbol)} · ${trade.quantity} 股</span><em>${formatMoney(trade.notional)}</em></div>`).join('')}</div>` : '<p class="cxl-muted">尚无模拟成交。</p>'}</section>
      <footer><code>${escapeHtml(agent.folder)}</code><button type="button" data-action="open-folder" data-agent="${escapeHtml(agent.id)}">${icon('folder')}打开 Agent 文件夹</button></footer>`;
  }

  async function openSession(agentId, view) {
    try {
      let agent = state.agents.find((row) => row.id === agentId);
      if (!agent) return { ok: false, error: 'agent-missing' };
      const bridge = window.__chuxinSessionBridge;
      const ensured = await ipcRenderer.invoke('agent-league:ensure-session', { agentId });
      if (!ensured || !ensured.ok) {
        notify((ensured && ensured.message) || 'Agent Session 打开失败', true);
        return { ok: false, error: ensured && ensured.error || 'ensure-session-failed' };
      }
      if (ensured.agent) {
        state.agents = state.agents.map((row) => row.id === ensured.agent.id ? ensured.agent : row);
        agent = ensured.agent;
        render();
      }
      for (let i = 0; i < 40 && bridge && !bridge.get(ensured.session.id); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const result = bridge ? await bridge.open(ensured.session.id, view, ensured.session) : null;
      if (!result || !result.ok) {
        notify('Session 已启动，但 Hub 界面尚未收到 session-created 事件，请在左侧栏打开。', true);
        return { ok: false, error: result && result.error || 'bridge-open-failed' };
      }
      await refresh(false);
      return { ok: true, agentId, sessionId: ensured.session.id, view };
    } catch (error) {
      notify(`Agent Session 打开失败：${error.message}`, true);
      return { ok: false, error: 'session-open-exception', message: error.message };
    }
  }

  async function openFolder(agentId) {
    const agent = state.agents.find((row) => row.id === agentId);
    if (!agent) return;
    try {
      const error = await ipcRenderer.invoke('open-path', agent.folder);
      if (error) notify(`打开文件夹失败：${error}`, true);
    } catch (error) {
      notify(`打开文件夹失败：${error.message}`, true);
    }
  }

  function promptItems() {
    if (!state.promptWorkbench) return [];
    return [...(state.promptWorkbench.files || []), ...(state.promptWorkbench.contracts || [])];
  }

  function currentPromptItem() {
    return promptItems().find((item) => item.key === state.promptKey) || null;
  }

  function promptGroupLabel(group) {
    return {
      investment: '投资内核', runtime: '运行提示', provider: 'Provider 目录指令',
      context: '长期上下文', contract: '系统运行合同', system: '系统状态', ledger: '模拟账本',
    }[group] || 'Agent 文件';
  }

  async function openPromptWorkbench(agentId) {
    const agent = state.agents.find((row) => row.id === agentId);
    if (!agent) return;
    state.promptAgentId = agentId;
    const overlay = root.querySelector('[data-role="prompt-overlay"]');
    overlay.hidden = false;
    root.querySelector('[data-role="prompt-agent-note"]').textContent = `${agent.name} · 正在读取实际 Markdown 与系统合同…`;
    try {
      const result = await ipcRenderer.invoke('agent-league:prompt-files', { agentId });
      if (!result || !result.ok) throw new Error(result && result.message || '提示词读取失败');
      state.promptWorkbench = result;
      state.promptDirty = false;
      root.querySelector('[data-role="prompt-agent-note"]').textContent = `${agent.name} · ${result.files.length} 个 Markdown 文件 · ${result.contracts.length} 份系统合同`;
      root.querySelector('[data-role="prompt-load-order"]').innerHTML = `<b>实际加载顺序</b>${(result.loadOrder || []).map((row, index) => `<span><i>${index + 1}</i>${escapeHtml(row)}</span>`).join('')}`;
      root.querySelectorAll('[data-prompt-group]').forEach((button) => button.classList.toggle('active', button.dataset.promptGroup === 'all'));
      renderPromptFileList('all');
      selectPromptFile('agent', true);
    } catch (error) {
      notify(`提示词工作台打开失败：${error.message}`, true);
      overlay.hidden = true;
    }
  }

  function closePromptWorkbench() {
    if (state.promptDirty && !window.confirm('当前提示词尚未保存，确认关闭并丢弃修改？')) return;
    root.querySelector('[data-role="prompt-overlay"]').hidden = true;
    state.promptAgentId = null;
    state.promptWorkbench = null;
    state.promptKey = null;
    state.promptDirty = false;
  }

  function renderPromptFileList(filter = 'all') {
    const nav = root.querySelector('[data-role="prompt-files"]');
    const rows = promptItems().filter((item) => filter === 'all'
      || item.group === filter
      || (filter === 'system-ledger' && ['system', 'ledger'].includes(item.group)));
    const groups = [];
    for (const row of rows) if (!groups.includes(row.group)) groups.push(row.group);
    nav.innerHTML = groups.map((group) => `<section><h4>${escapeHtml(promptGroupLabel(group))}</h4>${rows.filter((row) => row.group === group).map((row) => `<button type="button" class="${row.key === state.promptKey ? 'active' : ''}" data-prompt-key="${escapeHtml(row.key)}"><span>${row.editable ? icon('file') : icon('lock')}<b>${escapeHtml(row.title)}</b></span><small>${escapeHtml(row.name || (row.group === 'contract' ? '编译预览' : ''))}</small></button>`).join('')}</section>`).join('');
  }

  function selectPromptFile(key, force = false) {
    if (!force && state.promptDirty && !window.confirm('切换文件会丢弃尚未保存的修改，是否继续？')) return;
    const item = promptItems().find((row) => row.key === key);
    if (!item) return;
    state.promptKey = key;
    state.promptDirty = false;
    const editor = root.querySelector('[data-role="prompt-editor"]');
    editor.value = item.content || '';
    editor.readOnly = !item.editable;
    root.querySelector('[data-role="prompt-group-label"]').textContent = promptGroupLabel(item.group);
    root.querySelector('[data-role="prompt-file-title"]').textContent = item.title || item.name || key;
    root.querySelector('[data-role="prompt-file-description"]').textContent = `${item.description || ''}${item.path ? ` · ${item.path}` : ''}`;
    const mode = root.querySelector('[data-role="prompt-mode"]');
    mode.textContent = item.editable ? '可编辑 · Ctrl+S 保存' : '只读';
    mode.classList.toggle('editable', !!item.editable);
    root.querySelector('[data-role="prompt-hash"]').textContent = item.sha256 ? `SHA ${item.sha256.slice(0, 10)} · ${item.bytes || 0} B` : '运行时编译预览';
    const machine = root.querySelector('[data-role="machine-state"]');
    machine.hidden = !item.machineState;
    machine.querySelector('pre').textContent = item.machineState ? JSON.stringify(item.machineState, null, 2) : '';
    root.querySelector('[data-role="prompt-status"]').textContent = item.editable
      ? '正文可直接编辑；受保护机器状态在下方单独展示，保存时不会被误覆盖。'
      : '该内容由系统生成或维护，只用于完整感知。';
    renderPromptFileList(root.querySelector('[data-prompt-group].active')?.dataset.promptGroup || 'all');
    updatePromptButtons();
    setTimeout(() => editor.focus(), 20);
  }

  function setPromptDirty(value) {
    const item = currentPromptItem();
    state.promptDirty = !!value && !!(item && item.editable);
    if (state.promptDirty) root.querySelector('[data-role="prompt-status"]').textContent = '有未保存修改；Ctrl+S 保存。';
    updatePromptButtons();
  }

  function updatePromptButtons() {
    const item = currentPromptItem();
    const editable = !!(item && item.editable);
    root.querySelector('[data-action="save-prompt"]').disabled = !editable || !state.promptDirty || state.promptSaving;
    root.querySelector('[data-action="discard-prompt"]').disabled = !editable || !state.promptDirty || state.promptSaving;
  }

  function discardPromptChanges() {
    const item = currentPromptItem();
    if (!item) return;
    root.querySelector('[data-role="prompt-editor"]').value = item.content || '';
    state.promptDirty = false;
    root.querySelector('[data-role="prompt-status"]').textContent = '已恢复为最近一次保存内容。';
    updatePromptButtons();
  }

  async function reloadPromptWorkbench() {
    if (!state.promptAgentId) return;
    if (state.promptDirty && !window.confirm('重新载入会丢弃当前修改，是否继续？')) return;
    const keepKey = state.promptKey;
    const result = await ipcRenderer.invoke('agent-league:prompt-files', { agentId: state.promptAgentId });
    if (!result || !result.ok) return notify((result && result.message) || '重新载入失败', true);
    state.promptWorkbench = result;
    selectPromptFile(keepKey || 'agent', true);
    root.querySelector('[data-role="prompt-status"]').textContent = '已从磁盘重新载入。';
  }

  async function savePromptFile() {
    const item = currentPromptItem();
    if (!item || !item.editable || !state.promptDirty || state.promptSaving) return;
    state.promptSaving = true;
    updatePromptButtons();
    root.querySelector('[data-role="prompt-status"]').textContent = '正在原子保存并创建历史备份…';
    try {
      const result = await ipcRenderer.invoke('agent-league:save-prompt-file', {
        agentId: state.promptAgentId,
        key: item.key,
        content: root.querySelector('[data-role="prompt-editor"]').value,
        expectedSha256: item.sha256 || '',
      });
      if (!result || !result.ok) throw new Error(result && result.message || '保存失败');
      state.promptWorkbench = result.workbench;
      state.promptDirty = false;
      selectPromptFile(item.key, true);
      root.querySelector('[data-role="prompt-status"]').textContent = '保存成功；下一个自动任务会读取新版本。';
      notify(`${item.name} 已保存并备份`);
      await refresh(false);
    } catch (error) {
      root.querySelector('[data-role="prompt-status"]').textContent = `保存失败：${error.message}`;
      notify(`提示词保存失败：${error.message}`, true);
    } finally {
      state.promptSaving = false;
      updatePromptButtons();
    }
  }

  function actionAgentId(result = {}) {
    const run = result.run || {};
    const candidateIds = [
      state.selectedId,
      ...(Array.isArray(run.active) ? run.active : []),
      ...(Array.isArray(run.queue) ? run.queue : []),
      state.agents[0] && state.agents[0].id,
    ].filter(Boolean);
    return candidateIds.find((id) => state.agents.some((agent) => agent.id === id)) || null;
  }

  async function jumpToActionPty(result = {}) {
    const agentId = actionAgentId(result);
    if (!agentId) return { ok: false, error: 'no-agent' };
    return openSession(agentId, 'pty');
  }

  async function runDay(button) {
    button.disabled = true;
    const previous = button.innerHTML;
    button.innerHTML = `${icon('terminal')}启动并跳转 PTY…`;
    try {
      const result = await ipcRenderer.invoke('agent-league:run-day', { trigger: 'manual' });
      if (!result || !result.ok) throw new Error(result && result.message || '赛程启动失败');
      notify(result.alreadyRun ? '今天的盘前决策已经完成，正在打开对应 PTY' : '盘前决策已启动，正在打开对应 Agent PTY');
      const opened = await jumpToActionPty(result);
      if (!opened || !opened.ok) throw new Error('赛程已启动，但对应 PTY 跳转失败');
    } catch (error) {
      notify(`运行赛程失败：${error.message}`, true);
    } finally {
      button.disabled = false;
      button.innerHTML = previous;
    }
  }

  async function runPhase(button, channel, progressText, successText) {
    const forceWeekly = channel === 'agent-league:run-weekly'
      && window.confirm('自动赛程只在周六运行。现在继续会作为手动验收立即沉淀最近交易日，是否继续？');
    if (channel === 'agent-league:run-weekly' && !forceWeekly) return;
    button.disabled = true;
    const previous = button.innerHTML;
    button.innerHTML = `${icon('terminal')}执行并跳转 PTY…`;
    try {
      notify(progressText);
      const result = await ipcRenderer.invoke(channel, { trigger: 'manual', ...(forceWeekly ? { force: true } : {}) });
      if (!result || !result.ok) throw new Error(result && result.message || `${channel} 失败`);
      notify(result.alreadyRun ? `${result.message || '没有待处理内容'}，正在打开对应 PTY` : `${successText}，正在打开对应 PTY`);
      const opened = await jumpToActionPty(result);
      if (!opened || !opened.ok) throw new Error(`${successText}，但对应 PTY 跳转失败`);
    } catch (error) {
      notify(`${successText}失败：${error.message}`, true);
    } finally {
      button.disabled = false;
      button.innerHTML = previous;
    }
  }

  async function toggleAuto() {
    const enabled = !(state.schedule && state.schedule.enabled);
    try {
      const result = await ipcRenderer.invoke('agent-league:update-schedule', {
        enabled,
        decisionTime: state.schedule && state.schedule.decisionTime || '08:30',
        decisionCutoff: state.schedule && state.schedule.decisionCutoff || '09:15',
        executionTime: state.schedule && state.schedule.executionTime || '09:35',
        resultTime: state.schedule && state.schedule.resultTime || '15:10',
        weeklyTime: state.schedule && state.schedule.weeklyTime || '10:00',
        maxConcurrency: state.schedule && state.schedule.maxConcurrency || 2,
      });
      if (!result || !result.ok) return notify('自动赛程设置失败', true);
      state.schedule = result.schedule;
      notify(enabled ? '自动赛程已启用：交易日 08:30 决策、09:35 执行、15:10 记账，周六 10:00 沉淀' : '自动赛程已停用');
      render();
    } catch (error) {
      notify(`自动赛程设置失败：${error.message}`, true);
    }
  }

  async function openCreate() {
    try { await loadCatalog(); } catch (error) { return notify(error.message, true); }
    const overlay = root.querySelector('[data-role="create-overlay"]');
    const provider = overlay.querySelector('[name="provider"]');
    const philosophy = overlay.querySelector('[name="philosophyKey"]');
    provider.innerHTML = state.catalog.providers.map((row) => `<option value="${escapeHtml(row.provider)}">${escapeHtml(row.name)}</option>`).join('');
    philosophy.innerHTML = state.catalog.philosophies.map((row) => `<option value="${escapeHtml(row.key)}">${escapeHtml(row.title)}</option>`).join('');
    if (state.catalog.philosophies.some((row) => row.key === 'chuxin-value-speculation')) philosophy.value = 'chuxin-value-speculation';
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
      payload.initialCash = Number(payload.initialCash || 500000);
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
