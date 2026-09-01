'use strict';

function createAgentLeaguePanel(options = {}) {
  const document = options.document || window.document;
  const ipcRenderer = options.ipcRenderer;
  const notify = typeof options.toast === 'function' ? options.toast : () => {};
  const state = {
    mounted: false,
    loading: false,
    environment: 'live',
    sort: 'return',
    filter: 'all',
    agents: [],
    schedule: null,
    schedulerRuntime: null,
    run: null,
    catalog: null,
    selectedId: null,
    promptAgentId: null,
    promptWorkbench: null,
    promptKey: null,
    promptDirty: false,
    promptSaving: false,
    virtual: null,
    virtualSelfTest: null,
    health: null,
    dashboard: null,
    operationsOpen: false,
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
      flask: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3"/><path d="M7.5 16h9"/>',
      next: '<path d="m8 5 7 7-7 7"/><path d="M16 5v14"/>',
      trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14"/>',
      alert: '<path d="M12 3 2.8 20h18.4Z"/><path d="M12 9v5M12 17h.01"/>',
      activity: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
      eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/>',
      history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
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

  function durableRuntime() {
    return state.schedulerRuntime && state.schedulerRuntime.durable || {};
  }

  function durableTask(agentId) {
    const run = durableRuntime().activeRun;
    return run && Array.isArray(run.tasks) ? run.tasks.find((task) => task.agentId === agentId) || null : null;
  }

  function durableStageLabel(task) {
    if (!task) return '';
    const stage = { draft: 'DRAFT', hook: 'Hook', weekly: '周复盘', open: '开盘', close: '收盘', complete: '完成' }[task.stage] || task.stage;
    if (task.status === 'running') return `${stage} 运行中`;
    if (task.status === 'pending') return `${stage} 待接续`;
    if (task.status === 'completed') return stage === '完成' ? '已完成' : `${stage} 已完成`;
    if (task.status === 'technical-forfeit') return '技术弃权';
    return `${stage} · ${task.status}`;
  }

  function sessionState(agent) {
    const task = durableTask(agent.id);
    if (task) {
      if (task.status === 'running') return ['running', durableStageLabel(task)];
      if (task.status === 'pending') return ['pending', durableStageLabel(task)];
      if (task.status === 'technical-forfeit') return ['unbound', '技术弃权'];
      if (task.status === 'completed' && durableRuntime().activeRun) return ['active', '本阶段完成'];
    }
    const status = String(agent.session && agent.session.status || 'unbound');
    const native = agent.session && agent.session.nativeSession || {};
    const nativeBound = !!(native.codexSid || native.ccSessionId || native.geminiChatId || native.kimiSid);
    if (agent.session && agent.session.live && status === 'running') {
      if (agent.latestWeekly && agent.latestWeekly.status === 'running') return ['running', '周复盘中'];
      if (agent.latestDaily && (agent.latestDaily.stage === 'hook' || agent.latestDaily.status === 'hook-running')) return ['running', 'Hook 中'];
      return ['running', 'DRAFT 中'];
    }
    if (agent.session && agent.session.hubSessionId && !nativeBound) return ['pending', '待首次运行'];
    if (agent.session && agent.session.live) return ['active', status === 'idle' ? '空闲' : '活跃'];
    if (!agent.session || !agent.session.hubSessionId || status === 'unbound') return ['unbound', '未创建'];
    return ['sleep', '休眠'];
  }

  function nativeSessionId(agent) {
    const native = agent.session && agent.session.nativeSession || {};
    return native.codexSid || native.ccSessionId || native.geminiChatId || native.kimiSid || '';
  }

  function leagueChannel(name) {
    const prefix = state.environment === 'virtual' ? 'agent-league-virtual' : 'agent-league';
    return `${prefix}:${name}`;
  }

  function build(container) {
    root = container;
    root.classList.add('cxl-root');
    root.innerHTML = `
      <header class="cxl-page-head">
        <div><p data-role="league-eyebrow">AGENT LEAGUE · DAILY DECISION · NATIVE HUB SESSION</p><h1 data-role="league-title">Agent 投资联赛</h1><span data-role="league-description">“全体盘前决策”会一次启动所有尚未完成的 Agent；运行中可选择 Agent 并查看其 DRAFT / Hook 进度。</span></div>
        <div class="cxl-page-actions">
          <button type="button" class="cxl-btn debug" data-action="toggle-virtual">${icon('flask')}虚拟调试</button>
          <button type="button" class="cxl-btn" data-action="health-check">${icon('check')}联赛健康</button>
          <button type="button" class="cxl-btn" data-action="new-agent">${icon('plus')}新增 Agent</button>
          <button type="button" class="cxl-btn primary" data-action="run-day">${icon('play')}全体盘前决策</button>
          <button type="button" class="cxl-btn" data-action="execute-open">${icon('sunrise')}开盘执行</button>
          <button type="button" class="cxl-btn" data-action="record-close">${icon('check')}收盘记账</button>
          <button type="button" class="cxl-btn" data-action="run-weekly">${icon('book')}周六沉淀</button>
        </div>
      </header>
      <section class="cxl-virtual-lab" data-role="virtual-lab" hidden>
        <div class="cxl-virtual-copy"><p>VIRTUAL LIVE LAB · ISOLATED SANDBOX</p><h2>虚拟实盘调试台</h2><span>独立 Agent、Session、持仓与排行榜；时间和行情均为确定性合成数据，不读取实盘价格，也不写正式联赛。</span></div>
        <div class="cxl-virtual-clock"><span>虚拟交易日</span><b data-role="virtual-date">—</b><em data-role="virtual-phase">未初始化</em></div>
        <label class="cxl-virtual-scenario"><span>行情场景</span><select data-role="virtual-scenario"></select></label>
        <div class="cxl-virtual-actions">
          <button type="button" class="cxl-btn" data-action="configure-virtual">应用场景</button>
          <button type="button" class="cxl-btn" data-action="self-test-virtual">运行账本自检</button>
          <button type="button" class="cxl-btn" data-action="advance-virtual">${icon('next')}下一交易日</button>
          <button type="button" class="cxl-btn danger" data-action="reset-virtual">${icon('trash')}重置沙盒</button>
        </div>
        <p class="cxl-virtual-status" data-role="virtual-status">等待初始化。</p>
      </section>
      <section class="cxl-note"><p data-role="league-note">读取联赛状态…</p><span data-role="runtime-summary"></span></section>
      <section class="cxl-command-center" data-role="command-center" aria-labelledby="cxl-command-title">
        <header><div><p>DECISION TRUTH · AUDITABLE COVERAGE</p><h2 id="cxl-command-title" data-role="command-headline">等待联赛状态</h2><span data-role="command-summary" aria-live="polite">正在核对有效 FINAL、技术失败与执行覆盖。</span></div><button type="button" class="cxl-btn" data-action="toggle-operations" aria-expanded="false">${icon('eye')}展开运行详情</button></header>
        <div class="cxl-command-metrics">
          <article data-metric="coverage"><span>今日有效 FINAL</span><b data-role="metric-coverage">—</b><small data-role="metric-coverage-note">尚无赛程</small><i><em data-role="metric-coverage-bar"></em></i></article>
          <article data-metric="failures"><span>技术 / 运行异常</span><b data-role="metric-failures">0</b><small data-role="metric-failures-note">当前无异常</small></article>
          <article data-metric="execution"><span>开盘可执行覆盖</span><b data-role="metric-execution">—</b><small data-role="metric-execution-note">尚未执行</small></article>
          <article data-metric="reliability"><span>近260次有效决策率</span><b data-role="metric-reliability">—</b><small data-role="metric-reliability-note">没有已终态样本</small></article>
        </div>
        <div class="cxl-operations" data-role="operations" hidden><div data-role="attention-list"></div></div>
      </section>
      <section class="cxl-health" data-role="health" hidden><header><div><b data-role="health-title">联赛健康检查</b><span data-role="health-summary"></span></div><button type="button" class="cxl-close" data-action="close-health" aria-label="关闭健康检查">${icon('close')}</button></header><div data-role="health-checks"></div></section>
      <section class="cxl-board">
        <header><div><h2 data-role="board-title">实时排行榜</h2><p data-role="board-subtitle">当前快照 · 点击任意 Agent 行查看详情</p></div><div class="cxl-board-tools"><button type="button" class="cxl-icon-btn" data-action="refresh" title="刷新">${icon('refresh')}</button><button type="button" class="cxl-auto" data-action="toggle-auto"></button><button type="button" class="cxl-auto" data-action="toggle-background"></button><div class="cxl-sort"><button class="active" data-sort="return">按收益率</button><button data-sort="asset">按当前资产</button></div></div></header>
        <div class="cxl-board-filters" role="toolbar" aria-label="筛选参赛 Agent"><button type="button" class="active" data-agent-filter="all" aria-pressed="true">全部 <span data-filter-count="all">0</span></button><button type="button" data-agent-filter="attention" aria-pressed="false">需关注 <span data-filter-count="attention">0</span></button><button type="button" data-agent-filter="positions" aria-pressed="false">有持仓 <span data-filter-count="positions">0</span></button><button type="button" data-agent-filter="incomplete" aria-pressed="false">覆盖不足 <span data-filter-count="incomplete">0</span></button><small data-role="filter-summary" aria-live="polite"></small></div>
        <div class="cxl-table-head cxl-grid"><span>排名</span><span>Agent</span><span class="cxl-wide">状态</span><span>当前资产</span><span>累计收益</span><span class="cxl-wide">最近一日</span><span class="cxl-wide">最大回撤</span><span class="cxl-wide">仓位</span><span class="cxl-wide">最近决策</span><span></span></div>
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
        if (action === 'toggle-virtual') await toggleVirtualMode();
        else if (action === 'configure-virtual') await configureVirtual();
        else if (action === 'self-test-virtual') await selfTestVirtual();
        else if (action === 'advance-virtual') await advanceVirtual();
        else if (action === 'reset-virtual') await resetVirtual();
        else if (action === 'new-agent') openCreate();
        else if (action === 'close-create') closeCreate();
        else if (action === 'close-detail') closeDetail();
        else if (action === 'refresh') await refresh(true);
        else if (action === 'health-check') await runHealthCheck(actionEl);
        else if (action === 'close-health') closeHealth();
        else if (action === 'toggle-operations') toggleOperations();
        else if (action === 'open-agent-detail') openDetail(actionEl.dataset.agent);
        else if (action === 'run-day') await runDay(actionEl);
        else if (action === 'run-agent-day') await runAgentDay(actionEl, actionEl.dataset.agent);
        else if (action === 'execute-open') await runPhase(actionEl, 'execute-open', '正在读取开盘价并机械执行目标组合', '开盘执行完成');
        else if (action === 'record-close') await runPhase(actionEl, 'record-close', '正在读取收盘行情并更新净值', '收盘记账完成');
        else if (action === 'run-weekly') await runPhase(actionEl, 'run-weekly', '正在唤醒同一 Session 做周度沉淀', '周度沉淀已启动');
        else if (action === 'toggle-auto') await toggleAuto();
        else if (action === 'toggle-background') await toggleBackground();
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
      const filter = event.target.closest('[data-agent-filter]');
      if (filter) {
        state.filter = ['attention', 'positions', 'incomplete'].includes(filter.dataset.agentFilter) ? filter.dataset.agentFilter : 'all';
        renderDashboardFilters();
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
    const eventNames = ['run-updated', 'run-finished', 'agent-started', 'hook-started', 'agent-completed', 'agent-failed', 'agent-retrying', 'handoff-started', 'late-output-ignored', 'execution-completed', 'close-completed', 'session-updated', 'debug-updated'];
    for (const channel of ['agent-league', 'agent-league-virtual'].flatMap((prefix) => eventNames.map((name) => `${prefix}:${name}`))) {
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
      if (state.environment === 'virtual') {
        const debugState = await ipcRenderer.invoke('agent-league:virtual-state');
        if (!debugState || !debugState.ok || !debugState.debug || !debugState.debug.initialized) {
          throw new Error(debugState && debugState.message || '虚拟实盘尚未初始化');
        }
        state.virtual = debugState.debug;
      }
      const result = await ipcRenderer.invoke(leagueChannel('list'), { sort: state.sort });
      if (!result || !result.ok) throw new Error(result && result.message || '排行榜读取失败');
      state.agents = Array.isArray(result.agents) ? result.agents : [];
      state.schedule = result.schedule || {};
      state.schedulerRuntime = result.schedulerRuntime || null;
      state.run = result.run || null;
      state.dashboard = result.dashboard || null;
      root.querySelector('[data-role="root-path"]').textContent = result.root || '';
      root.classList.toggle('virtual-mode', state.environment === 'virtual');
      render();
    } catch (error) {
      if (showError) notify(`Agent 联赛读取失败：${error.message}`, true);
    } finally {
      state.loading = false;
      root.classList.remove('loading');
    }
  }

  function render() {
    const isVirtual = state.environment === 'virtual';
    const virtual = state.virtual || {};
    const empty = root.querySelector('[data-role="empty"]');
    const board = root.querySelector('.cxl-board');
    empty.hidden = state.agents.length > 0;
    board.hidden = state.agents.length === 0;
    const active = state.agents.filter((agent) => agent.session && agent.session.live && agent.session.status !== 'idle').length;
    const idle = state.agents.filter((agent) => agent.session && agent.session.live && agent.session.status === 'idle').length;
    const sleeping = state.agents.filter((agent) => !agent.session || !agent.session.live).length;
    const durable = durableRuntime();
    const durableRun = durable.activeRun || null;
    const durableTasks = durableRun && Array.isArray(durableRun.tasks) ? durableRun.tasks : [];
    const durableDone = durableTasks.filter((task) => ['completed', 'technical-forfeit'].includes(task.status)).length;
    const runtimeSummary = isVirtual
      ? `${active} 活跃 · ${idle} 空闲 · ${sleeping} 休眠`
      : !durable.available
        ? `事务运行库不可用${durable.error ? ` · ${escapeHtml(durable.error)}` : ''}`
        : durable.leader && durable.leader.active
          ? `Runner PID ${Number(durable.leader.ownerPid || 0)} · epoch ${Number(durable.leader.epoch || 0)}${durableRun ? ` · ${durableDone}/${durableTasks.length} 终态` : ''}`
          : `事务运行库就绪 · ${active} 活跃 · ${sleeping} 休眠`;
    const runtimeSummaryEl = root.querySelector('[data-role="runtime-summary"]');
    runtimeSummaryEl.classList.toggle('error', !isVirtual && durable.available === false);
    runtimeSummaryEl.classList.toggle('remote', !!(durable.leader && durable.leader.active && !durable.ownerIsThisHub));
    runtimeSummaryEl.innerHTML = `<i></i>${runtimeSummary}`;
    root.querySelector('[data-role="league-eyebrow"]').textContent = isVirtual
      ? 'AGENT LEAGUE · VIRTUAL LIVE DEBUG · ISOLATED'
      : 'AGENT LEAGUE · DAILY DECISION · NATIVE HUB SESSION';
    root.querySelector('[data-role="league-title"]').textContent = isVirtual ? 'Agent 联赛 · 虚拟实盘' : 'Agent 投资联赛';
    root.querySelector('[data-role="league-description"]').textContent = isVirtual
      ? '“全体虚拟盘前决策”会启动沙盒中的全部 Agent；运行中可选择 Agent 并查看其 DRAFT / Hook 进度。'
      : '“全体盘前决策”会一次启动所有尚未完成的 Agent；运行中可选择 Agent 并查看其 DRAFT / Hook 进度。';
    const virtualToggle = root.querySelector('[data-action="toggle-virtual"]');
    virtualToggle.innerHTML = isVirtual ? `${icon('close')}退出虚拟调试` : `${icon('flask')}虚拟调试`;
    virtualToggle.classList.toggle('active', isVirtual);
    root.querySelector('[data-role="league-note"]').innerHTML = isVirtual
      ? `<b>${state.agents.length} 个隔离 Agent · 虚拟交易日 ${escapeHtml(virtual.virtualDate || '—')} · ${escapeHtml(virtual.scenarioLabel || '合成行情')}</b>　一次启动全部 Agent；运行中再次点击顶部按钮会打开选中 Agent 的进度。`
      : `<b>${state.agents.length} 个 Agent · 每席 ¥500,000 · 沪深全市场（不含北交所）</b>　一次启动全部 Agent；运行中再次点击顶部按钮会打开选中 Agent 的进度。`;
    const lab = root.querySelector('[data-role="virtual-lab"]');
    lab.hidden = !isVirtual;
    if (isVirtual) renderVirtualLab();
    const auto = root.querySelector('[data-action="toggle-auto"]');
    auto.hidden = isVirtual;
    auto.classList.toggle('active', !!state.schedule.enabled);
    auto.textContent = state.schedule.enabled ? `自动 ${state.schedule.decisionTime || '08:30'} / 周六 ${state.schedule.weeklyTime || '10:00'}` : '自动赛程未启用';
    const background = root.querySelector('[data-action="toggle-background"]');
    background.hidden = isVirtual;
    background.classList.toggle('active', state.schedule.keepAliveOnClose !== false);
    background.textContent = state.schedule.keepAliveOnClose === false ? '关窗即退出' : '关窗后台守护';
    const runButton = root.querySelector('[data-action="run-day"]');
    const remoteRun = !isVirtual && !state.run && durableRun && durable.leader && durable.leader.active;
    const runningCount = state.run
      ? (state.run.active || []).length + (state.run.queue || []).length
      : remoteRun ? durableTasks.filter((task) => !['completed', 'technical-forfeit'].includes(task.status)).length : 0;
    runButton.disabled = !state.run && isVirtual && virtual.phase !== 'pre-market';
    runButton.innerHTML = state.run
      ? `${icon('terminal')}${state.run.mode === 'weekly' ? '查看沉淀进度' : `查看决策进度${runningCount ? `（${runningCount}）` : ''}`}`
      : remoteRun
        ? `${icon('refresh')}其他 Hub 运行中${runningCount ? `（${runningCount}）` : ''}`
      : `${icon('play')}${isVirtual ? '全体虚拟盘前决策' : '全体盘前决策'}`;
    runButton.title = state.run
      ? '全部符合条件的 Agent 已在运行或排队；选择排行榜中的 Agent 后点击这里查看它的 PTY。'
      : remoteRun
        ? `运行权属于 PID ${Number(durable.leader.ownerPid || 0)}；点击刷新共享检查点，不会在本 Hub 重复启动。`
        : '一次启动所有尚未完成当日决策的 Agent。';
    for (const action of ['execute-open', 'record-close', 'run-weekly']) {
      const button = root.querySelector(`[data-action="${action}"]`);
      if (!button) continue;
      if (!isVirtual) button.disabled = !!state.run || !!remoteRun;
      else if (action === 'execute-open') button.disabled = !!state.run || virtual.phase !== 'decision-ready';
      else if (action === 'record-close') button.disabled = !!state.run || virtual.phase !== 'intraday';
      else button.disabled = !!state.run || virtual.phase !== 'closed';
    }
    root.querySelector('[data-role="board-title"]').textContent = isVirtual ? '虚拟排行榜' : '实时排行榜';
    const runTotal = state.run
      ? (state.run.completed || []).length + (state.run.active || []).length + (state.run.queue || []).length + (state.run.failed || []).length
      : 0;
    root.querySelector('[data-role="board-subtitle"]').textContent = state.run
      ? `${state.run.mode === 'weekly' ? '周度沉淀' : '全体盘前决策'} ${state.run.decisionDate || state.run.asOf} · ${state.run.completed.length}/${runTotal} 已完成 · ${state.run.active.length} 运行中${state.run.queue.length ? ` · ${state.run.queue.length} 排队` : ''}`
      : remoteRun
        ? `${durableRun.phase} ${durableRun.decisionDate} · 运行于 PID ${Number(durable.leader.ownerPid || 0)} · ${durableDone}/${durableTasks.length} 终态 · 当前 Hub 只读观察`
      : isVirtual
        ? `${escapeHtml(virtual.virtualDate || '—')} · ${virtualPhaseLabel(virtual.phase)} · 最近决策 ${state.schedule.lastDecisionDate || '无'} · 最近收盘 ${state.schedule.lastResultDate || '无'}`
        : `${state.dashboard && state.dashboard.headline || `最近赛程：${state.schedule.lastDecisionDate || '尚未运行'}`} · 开盘阶段：${state.schedule.lastExecutionDate || '无'} / ${state.schedule.lastExecutionStatus || 'never'} · 点击任意 Agent 查看证据`;
    renderCommandCenter();
    renderDashboardFilters();
    renderRanking();
    renderHealth();
    if (state.selectedId) {
      const selected = state.agents.find((agent) => agent.id === state.selectedId);
      if (selected && !root.querySelector('[data-role="detail-overlay"]').hidden) renderDrawer(selected);
    }
  }

  function virtualPhaseLabel(phase) {
    return {
      'pre-market': '盘前待决策',
      'decision-running': 'AI 决策运行中',
      'decision-ready': '决策已锁定，待开盘',
      intraday: '已开盘，待收盘记账',
      closed: '当日已收盘',
      'weekly-running': '周度沉淀运行中',
    }[phase] || String(phase || '未知阶段');
  }

  function renderVirtualLab() {
    const virtual = state.virtual || {};
    root.querySelector('[data-role="virtual-date"]').textContent = virtual.virtualDate || '—';
    root.querySelector('[data-role="virtual-phase"]').textContent = virtualPhaseLabel(virtual.phase);
    const scenario = root.querySelector('[data-role="virtual-scenario"]');
    scenario.innerHTML = (virtual.scenarios || []).map((row) => `<option value="${escapeHtml(row.id)}" ${row.id === virtual.scenario ? 'selected' : ''}>${escapeHtml(row.label)} · ${escapeHtml(row.description)}</option>`).join('');
    scenario.disabled = virtual.phase !== 'pre-market';
    root.querySelector('[data-action="configure-virtual"]').disabled = virtual.phase !== 'pre-market';
    root.querySelector('[data-action="advance-virtual"]').disabled = virtual.phase !== 'closed';
    root.querySelector('[data-action="reset-virtual"]').disabled = !!state.run;
    const report = state.virtualSelfTest;
    root.querySelector('[data-role="virtual-status"]').textContent = report
      ? `${report.ok ? '账本自检 PASS' : '账本自检 FAIL'} · ${(report.checks || []).filter((row) => row.pass).length}/${(report.checks || []).length} 项通过 · 沙盒路径 ${virtual.root || ''}`
      : `隔离沙盒：${virtual.root || ''}`;
  }

  function percentRate(value) {
    return value == null || !Number.isFinite(Number(value)) ? '—' : `${(Number(value) * 100).toFixed(0)}%`;
  }

  function renderCommandCenter() {
    const dashboard = state.dashboard || {};
    const current = dashboard.current || {};
    const overall = dashboard.overall || {};
    const center = root.querySelector('[data-role="command-center"]');
    center.className = `cxl-command-center ${escapeHtml(dashboard.severity || 'pass')}`;
    root.querySelector('[data-role="command-headline"]').textContent = dashboard.headline || '尚无盘前赛程';
    root.querySelector('[data-role="command-summary"]').textContent = current.decisionDate
      ? `${current.decisionDate} · ${Number(current.completed || 0)} 有效 · ${Number(current.technicalForfeits || 0)} 技术弃权 · ${Number(current.failed || 0)} 运行失败 · ${Number(current.missing || 0)} 缺失`
      : '系统会把有效 FINAL、技术故障和未参赛记录分开呈现。';
    root.querySelector('[data-role="metric-coverage"]').textContent = current.expectedAgents
      ? `${Number(current.completed || 0)}/${Number(current.expectedAgents || 0)}` : '—';
    root.querySelector('[data-role="metric-coverage-note"]').textContent = current.expectedAgents
      ? `${percentRate(current.coverageRate)} 覆盖 · ${current.runStatus || 'never'}` : '尚无赛程';
    root.querySelector('[data-role="metric-coverage-bar"]').style.width = `${Math.max(0, Math.min(100, Number(current.coverageRate || 0) * 100))}%`;
    const failures = Number(current.technicalForfeits || 0) + Number(current.failed || 0) + Number(current.missing || 0);
    root.querySelector('[data-role="metric-failures"]').textContent = String(failures);
    root.querySelector('[data-role="metric-failures-note"]').textContent = failures
      ? `${Number(current.technicalForfeits || 0)} 技术弃权 · ${Number(current.failed || 0)} 失败 · ${Number(current.missing || 0)} 缺失`
      : current.running ? `${Number(current.running)} 个任务仍在运行` : '当前无异常';
    const executionSameDay = current.decisionDate && current.executionDate === current.decisionDate;
    root.querySelector('[data-role="metric-execution"]').textContent = executionSameDay && current.expectedAgents
      ? `${Number(current.executionEligible || 0)}/${Number(current.expectedAgents || 0)}` : '待执行';
    root.querySelector('[data-role="metric-execution-note"]').textContent = executionSameDay
      ? `${current.executionStatus || 'never'} · ${Number(current.executionUnavailable || 0)} 个 Agent 无有效 FINAL`
      : current.executionDate ? `最近 ${current.executionDate} · ${current.executionStatus || 'never'}` : '尚无开盘阶段';
    root.querySelector('[data-role="metric-reliability"]').textContent = percentRate(overall.validRate);
    root.querySelector('[data-role="metric-reliability-note"]').textContent = overall.resolvedDays
      ? `${Number(overall.completedDecisions || 0)} 次有效 / ${Number(overall.resolvedDays || 0)} 次终态`
      : '没有已终态样本';
    const operations = root.querySelector('[data-role="operations"]');
    operations.hidden = !state.operationsOpen;
    const toggle = root.querySelector('[data-action="toggle-operations"]');
    toggle.setAttribute('aria-expanded', state.operationsOpen ? 'true' : 'false');
    toggle.innerHTML = state.operationsOpen ? `${icon('close')}收起运行详情` : `${icon('eye')}展开运行详情`;
    const attention = Array.isArray(dashboard.attention) ? dashboard.attention : [];
    root.querySelector('[data-role="attention-list"]').innerHTML = attention.length
      ? attention.map((item) => `<article class="${escapeHtml(item.severity || 'warn')}" ${item.severity === 'fail' ? 'role="alert"' : ''}><span class="cxl-attention-icon">${icon(item.severity === 'fail' ? 'alert' : 'activity')}</span><div><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.detail || '')}</small></div>${item.agentId ? `<button type="button" data-action="open-agent-detail" data-agent="${escapeHtml(item.agentId)}">查看 Agent ${icon('chevron')}</button>` : ''}</article>`).join('')
      : `<div class="cxl-all-clear"><span class="cxl-attention-icon">${icon('check')}</span><div><b>当前没有需要人工处理的联赛异常</b><small>仍可运行“联赛健康”检查 CLI、数据源和事务运行库。</small></div></div>`;
  }

  function toggleOperations() {
    state.operationsOpen = !state.operationsOpen;
    renderCommandCenter();
  }

  function renderDashboardFilters() {
    const counts = state.dashboard && state.dashboard.filterCounts || { all: state.agents.length, attention: 0, positions: 0, incomplete: 0 };
    root.querySelectorAll('[data-agent-filter]').forEach((button) => {
      const active = button.dataset.agentFilter === state.filter;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    for (const key of ['all', 'attention', 'positions', 'incomplete']) {
      const target = root.querySelector(`[data-filter-count="${key}"]`);
      if (target) target.textContent = String(Number(counts[key] || 0));
    }
    const labels = { all: '全部 Agent', attention: '需要关注', positions: '当前有持仓', incomplete: '有效决策覆盖不足' };
    root.querySelector('[data-role="filter-summary"]').textContent = `${labels[state.filter] || labels.all} · ${Number(counts[state.filter] || 0)} 个`;
  }

  function renderRanking() {
    const ranking = root.querySelector('[data-role="ranking"]');
    const sorted = [...state.agents].sort((a, b) => state.sort === 'asset'
      ? Number(b.stats.nav) - Number(a.stats.nav)
      : Number(b.stats.totalReturn) - Number(a.stats.totalReturn));
    const attentionIds = new Set(state.dashboard && state.dashboard.attentionIds || []);
    const incompleteIds = new Set(state.dashboard && state.dashboard.incompleteIds || []);
    const ranked = sorted.map((agent, index) => ({ agent, rank: index + 1 })).filter(({ agent }) => {
      if (state.filter === 'attention') return attentionIds.has(agent.id);
      if (state.filter === 'positions') return Number(agent.stats && agent.stats.positionWeight || 0) > 0;
      if (state.filter === 'incomplete') return incompleteIds.has(agent.id);
      return true;
    });
    if (!ranked.length) {
      ranking.innerHTML = '<div class="cxl-filter-empty">当前筛选下没有 Agent。切回“全部”可查看完整排行榜。</div>';
      return;
    }
    ranking.innerHTML = ranked.map(({ agent, rank }) => {
      const [statusClass, statusText] = agentOperationalState(agent);
      const stats = agent.stats || {};
      const reliability = agent.decisionReliability || {};
      const finalDaily = agent.latestCompletedDaily || null;
      const verdict = finalDaily && finalDaily.hook && finalDaily.hook.verdict || '—';
      const finalDate = finalDaily && finalDaily.decisionDate || '尚无有效决策';
      return `<button type="button" class="cxl-row cxl-grid ${state.selectedId === agent.id ? 'selected' : ''} ${attentionIds.has(agent.id) ? 'needs-attention' : ''}" data-agent-row="${escapeHtml(agent.id)}" aria-label="第 ${rank} 名，${escapeHtml(agent.name)}，累计收益 ${formatPct(stats.totalReturn)}，${escapeHtml(statusText)}">
        <span class="cxl-rank ${rank <= 3 ? `top${rank}` : ''}">${rank}</span>
        <span class="cxl-agent">${providerLogo(agent)}<span><b>${escapeHtml(agent.name)}</b><small>${escapeHtml(agent.philosophy && agent.philosophy.title || '')} · 有效 ${Number(reliability.completedDecisions || 0)}/${Number(reliability.resolvedDays || 0)}</small></span></span>
        <span class="cxl-status ${statusClass} cxl-wide"><i></i>${statusText}</span>
        <span class="cxl-number"><b>${formatMoney(stats.nav)}</b><small>初始 ${formatMoney(agent.initialCash || stats.nav)}</small></span>
        <span class="cxl-return ${tone(stats.totalReturn)}">${formatPct(stats.totalReturn)}</span>
        <span class="cxl-small ${tone(stats.dailyReturn)} cxl-wide">${formatPct(stats.dailyReturn)}</span>
        <span class="cxl-small cxl-wide">${formatPct(stats.maxDrawdown)}</span>
        <span class="cxl-position cxl-wide"><b>${formatPct(stats.positionWeight).replace('+', '')}</b><i><em style="width:${Math.max(0, Math.min(100, Number(stats.positionWeight || 0) * 100))}%"></em></i></span>
        <span class="cxl-small cxl-wide"><b>${escapeHtml(verdict)}</b><small>${escapeHtml(finalDaily ? `有效 ${finalDate}` : finalDate)}</small></span>
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
    const failed = daily.status === 'failed';
    const failureBlock = failed ? `<article class="cxl-decision-error" role="alert"><div>${icon('alert')}<span><b>${daily.failureKind === 'technical-forfeit' ? '技术弃权：没有形成策略结论' : '运行失败：没有形成策略结论'}</b><small>${escapeHtml(daily.error || '模型回复未通过结构化校验')}</small></span></div><button type="button" class="cxl-btn" data-action="run-agent-day" data-agent="${escapeHtml(agent.id)}">${icon('play')}安排下一次有效盘前决策</button></article>` : '';
    return `<div class="cxl-flow-meta"><span>${escapeHtml(daily.decisionDate || '')}</span><span>数据截至 ${escapeHtml(daily.dataAsOf || '—')}</span><span class="cxl-hook-verdict ${escapeHtml(String(hook.verdict || '').toLowerCase())}">${escapeHtml(hook.verdict || daily.status || '—')}</span></div>
      ${failureBlock}
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

  function decisionReliabilityHtml(agent) {
    const reliability = agent.decisionReliability || {};
    const latestAttempt = reliability.latestAttempt || null;
    const latestCompleted = reliability.latestCompleted || null;
    const recent = Array.isArray(reliability.recentDays) ? reliability.recentDays : [];
    const latestIsFailure = latestAttempt && latestAttempt.status === 'failed';
    return `<div class="cxl-reliability-summary">
      <article><span>有效决策</span><b>${Number(reliability.completedDecisions || 0)}/${Number(reliability.resolvedDays || 0)}</b><small>${percentRate(reliability.validRate)} 有效率</small></article>
      <article><span>运行失败</span><b>${Number(reliability.failedDays || 0)}</b><small>${Number(reliability.technicalForfeits || 0)} 次技术弃权</small></article>
      <article><span>最近有效 FINAL</span><b>${escapeHtml(latestCompleted && latestCompleted.verdict || '—')}</b><small>${escapeHtml(latestCompleted && latestCompleted.decisionDate || '尚无')}</small></article>
    </div>
    ${latestIsFailure ? `<div class="cxl-truth-warning" role="alert">${icon('alert')}<span><b>${escapeHtml(latestAttempt.decisionDate)} 的记录是技术过程失败</b><small>它不会继承上一轮 ${escapeHtml(latestCompleted && latestCompleted.verdict || 'verdict')}，也不代表 Agent 主动选择空仓。</small></span></div>` : ''}
    <div class="cxl-decision-history">${recent.length ? recent.map((day) => {
      const completed = day.status === 'decision-queued' && day.stage === 'complete';
      const label = completed ? (day.verdict || 'FINAL') : day.status === 'failed' ? (day.failureKind === 'technical-forfeit' ? '技术弃权' : '运行失败') : day.status || day.stage;
      return `<div class="${completed ? 'complete' : day.status === 'failed' ? 'failed' : 'pending'}"><i></i><span><b>${escapeHtml(day.decisionDate)}</b><small>${escapeHtml(label)}${day.error ? ` · ${escapeHtml(day.error)}` : ''}</small></span></div>`;
    }).join('') : '<p class="cxl-muted">尚无盘前决策记录。</p>'}</div>`;
  }

  function renderDrawer(agent) {
    const stats = agent.stats || {};
    const [statusClass, statusText] = agentOperationalState(agent);
    const positions = agent.portfolio && Array.isArray(agent.portfolio.positions) ? agent.portfolio.positions : [];
    const drawer = root.querySelector('[data-role="drawer"]');
    drawer.innerHTML = `<header><div class="cxl-drawer-id">${providerLogo(agent)}<div><h2>${escapeHtml(agent.name)}</h2><p>${escapeHtml(agent.philosophy && agent.philosophy.title || '')} · ${escapeHtml(agent.provider)} · ${escapeHtml(agent.model)}</p></div></div><button type="button" class="cxl-close" data-action="close-detail" aria-label="关闭">${icon('close')}</button></header>
      <div class="cxl-drawer-actions"><button type="button" class="cxl-btn primary" data-action="run-agent-day" data-agent="${escapeHtml(agent.id)}">${icon('play')}只跑这个 Agent 的盘前决策</button><button type="button" class="cxl-btn" data-action="open-card" data-agent="${escapeHtml(agent.id)}">${icon('cards')}${agent.session && agent.session.hubSessionId ? '打开卡片 Session' : '创建卡片 Session'}</button><button type="button" class="cxl-btn" data-action="open-pty" data-agent="${escapeHtml(agent.id)}">${icon('terminal')}${agent.session && agent.session.hubSessionId ? '打开 PTY' : '创建并打开 PTY'}</button><button type="button" class="cxl-btn prompt" data-action="edit-prompts" data-agent="${escapeHtml(agent.id)}">${icon('edit')}查看 / 编辑全部提示词</button></div>
      <div class="cxl-detail-metrics"><div><span>当前资产</span><b>${formatMoney(stats.nav)}</b><small class="${tone(stats.totalReturn)}">${formatPct(stats.totalReturn)}</small></div><div><span>最近一日收益</span><b class="${tone(stats.dailyReturn)}">${formatPct(stats.dailyReturn)}</b><small>${escapeHtml(stats.lastAsOf || '尚未结算')}</small></div><div><span>最大回撤</span><b>${formatPct(stats.maxDrawdown)}</b><small>${stats.tradingDays || 0} 个统计日</small></div><div><span>Session</span><b class="cxl-status ${statusClass}"><i></i>${statusText}</b><small>${escapeHtml(nativeSessionId(agent) ? `原生 SID ${nativeSessionId(agent).slice(0, 8)}…` : agent.session && agent.session.hubSessionId ? 'Hub 已绑定 · 首次运行后生成原生 SID' : '点击上方按钮创建普通 Session')}</small></div></div>
      <section class="cxl-detail-section cxl-reliability"><div class="cxl-section-head"><h3>决策可靠性</h3><span>策略结论与技术状态分账</span></div>${decisionReliabilityHtml(agent)}</section>
      <section class="cxl-detail-section"><div class="cxl-section-head"><h3>核心理念</h3><span>${agent.strategyPendingConfirmation ? '第一版 · 待你确认' : `策略 ${escapeHtml(agent.strategyVersion || 'v1')}`}</span></div><p>${escapeHtml(agent.philosophy && agent.philosophy.summary || '自定义理念')}</p><blockquote>${escapeHtml(agent.philosophy && agent.philosophy.edge || '')}</blockquote></section>
      <section class="cxl-detail-section cxl-prompt-summary"><div class="cxl-section-head"><h3>这个 Agent 实际会读什么</h3><button type="button" data-action="edit-prompts" data-agent="${escapeHtml(agent.id)}">完整查看与编辑 →</button></div><div><span><b>投资内核</b>AGENT / STRATEGY / CHECKLIST</span><span><b>三段运行提示</b>盘前 DRAFT / 决策 Hook / 周六沉淀</span><span><b>Provider 指令</b>AGENTS / CLAUDE / GEMINI</span><span><b>长期上下文</b>MEMORY / EVOLUTION</span><span><b>系统合同</b>完整编译预览，只读</span></div></section>
      <section class="cxl-detail-section cxl-daily-flow"><div class="cxl-section-head"><h3>最近一次赛程</h3><span>DRAFT → HOOK → FINAL</span></div>${dailyFlowHtml(agent)}</section>
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
      const ensured = await ipcRenderer.invoke(leagueChannel('ensure-session'), { agentId });
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
      const result = await ipcRenderer.invoke(leagueChannel('prompt-files'), { agentId });
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
    const result = await ipcRenderer.invoke(leagueChannel('prompt-files'), { agentId: state.promptAgentId });
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
      const result = await ipcRenderer.invoke(leagueChannel('save-prompt-file'), {
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
    const activeIds = Array.isArray(run.active) ? run.active : [];
    const queuedIds = Array.isArray(run.queue) ? run.queue : [];
    const selectedRunning = state.selectedId && [...activeIds, ...queuedIds].includes(state.selectedId)
      ? state.selectedId : null;
    const candidateIds = [
      selectedRunning,
      ...activeIds,
      ...queuedIds,
      state.selectedId,
      state.agents[0] && state.agents[0].id,
    ].filter(Boolean);
    return candidateIds.find((id) => state.agents.some((agent) => agent.id === id)) || null;
  }

  async function jumpToActionPty(result = {}) {
    const agentId = actionAgentId(result);
    if (!agentId) return { ok: false, error: 'no-agent' };
    return openSession(agentId, 'pty');
  }

  function agentOperationalState(agent) {
    const task = durableTask(agent.id);
    if (task) return sessionState(agent);
    const daily = agent.latestDaily;
    if (daily && daily.status === 'failed') {
      const label = daily.failureKind === 'technical-forfeit' ? '技术弃权' : `${daily.stage === 'hook' ? 'Hook' : 'DRAFT'} 失败`;
      return ['error', `${daily.decisionDate || ''} ${label}`.trim()];
    }
    if (daily && daily.status === 'retrying') return ['pending', `${daily.stage === 'hook' ? 'Hook' : 'DRAFT'} 重试中`];
    return sessionState(agent);
  }

  function renderHealth() {
    const panel = root.querySelector('[data-role="health"]');
    if (!state.health) { panel.hidden = true; return; }
    panel.hidden = false;
    panel.className = `cxl-health ${escapeHtml(state.health.severity || 'warn')}`;
    root.querySelector('[data-role="health-title"]').textContent = state.health.severity === 'pass'
      ? '联赛可以正常自动运行' : state.health.severity === 'fail' ? '联赛存在阻断项' : '联赛可运行，但有提醒';
    root.querySelector('[data-role="health-summary"]').textContent = `${state.health.counts.pass} 通过 · ${state.health.counts.warn} 提醒 · ${state.health.counts.fail} 阻断 · 下一决策日 ${state.health.nextDecisionDate || '待定'}`;
    root.querySelector('[data-role="health-checks"]').innerHTML = (state.health.checks || []).map((check) => `<article class="${escapeHtml(check.status)}"><i></i><span><b>${escapeHtml(check.label)}</b><small>${escapeHtml(check.message)}</small></span></article>`).join('');
  }

  async function runHealthCheck(button) {
    if (state.environment === 'virtual') return notify('虚拟沙盒使用独立自检，请在虚拟调试台运行账本自检', true);
    button.disabled = true;
    const previous = button.innerHTML;
    button.innerHTML = `${icon('refresh')}检查中…`;
    try {
      const result = await ipcRenderer.invoke(leagueChannel('health'), {});
      if (!result || !result.ok) throw new Error(result && result.message || '健康检查失败');
      state.health = result.report;
      renderHealth();
      notify(result.report.severity === 'pass' ? '联赛健康检查通过' : `联赛健康检查完成：${result.report.counts.fail} 个阻断、${result.report.counts.warn} 个提醒`, result.report.severity === 'fail');
    } catch (error) {
      notify(`联赛健康检查失败：${error.message}`, true);
    } finally {
      button.disabled = false;
      button.innerHTML = previous;
    }
  }

  function closeHealth() {
    state.health = null;
    renderHealth();
  }

  async function runAgentDay(button, agentId) {
    const agent = state.agents.find((row) => row.id === agentId);
    if (!agent) return notify('Agent 不存在', true);
    const durable = durableRuntime();
    if (state.run || (durable.activeRun && durable.leader && durable.leader.active)) {
      notify('联赛已有阶段任务在运行；请等待本轮终态后再单独补跑。', true);
      return;
    }
    button.disabled = true;
    const previous = button.innerHTML;
    button.innerHTML = `${icon('terminal')}启动并跳转 PTY…`;
    try {
      const result = await ipcRenderer.invoke(leagueChannel('run-day'), { trigger: 'manual', agentIds: [agentId] });
      if (!result || !result.ok) throw new Error(result && result.message || '启动失败');
      const target = result.decisionDate || result.run && result.run.decisionDate || '';
      const moved = result.scheduledFrom ? `（${result.scheduledFrom} 已过截止或休市，改为 ${target}）` : target ? `（${target}）` : '';
      notify(result.alreadyRun
        ? `${agent.name} 在 ${target || '该交易日'} 已有终态决策，无需补跑。`
        : `已单独启动 ${agent.name} 的盘前决策${moved}；其他 Agent 不受影响。`);
      if (!result.alreadyRun) {
        const opened = await jumpToActionPty(result);
        if (!opened || !opened.ok) throw new Error('已启动，但 PTY 跳转失败');
      }
    } catch (error) {
      notify(`单独运行失败：${error.message}`, true);
    } finally {
      button.disabled = false;
      button.innerHTML = previous;
    }
  }

  async function runDay(button) {
    const durable = durableRuntime();
    if (!state.run && state.environment !== 'virtual' && durable.activeRun && durable.leader && durable.leader.active) {
      await refresh(true);
      const run = durableRuntime().activeRun;
      const tasks = run && Array.isArray(run.tasks) ? run.tasks : [];
      const done = tasks.filter((task) => ['completed', 'technical-forfeit'].includes(task.status)).length;
      notify(`联赛正在 PID ${Number(durableRuntime().leader && durableRuntime().leader.ownerPid || 0)} 上运行；当前 Hub 只读观察，共享检查点 ${done}/${tasks.length} 已终态。`);
      return;
    }
    if (state.run) {
      const activeCount = (state.run.active || []).length;
      const queuedCount = (state.run.queue || []).length;
      notify(`全部符合条件的 Agent 已启动：${activeCount} 个运行中${queuedCount ? `，${queuedCount} 个排队中` : ''}。正在打开选中 Agent 的进度。`);
      const opened = await jumpToActionPty({ run: state.run });
      if (!opened || !opened.ok) notify('赛程仍在运行，但对应 Agent PTY 暂时无法打开', true);
      return;
    }
    button.disabled = true;
    const previous = button.innerHTML;
    button.innerHTML = `${icon('terminal')}启动并跳转 PTY…`;
    try {
      const result = await ipcRenderer.invoke(leagueChannel('run-day'), { trigger: 'manual' });
      if (!result || !result.ok) throw new Error(result && result.message || '赛程启动失败');
      const target = result.decisionDate || result.run && result.run.decisionDate || '';
      const moved = result.scheduledFrom ? `（${result.scheduledFrom} 休市，已自动安排 ${target}）` : target ? `（${target}）` : '';
      const startedCount = result.run
        ? (result.run.active || []).length + (result.run.queue || []).length
        : state.agents.length;
      notify(result.alreadyRun
        ? `${target || '该交易日'}的盘前决策已经完成，正在打开对应 PTY`
        : `${startedCount} 个 Agent 的盘前决策已统一启动${moved}；系统会按并发上限运行或排队。`);
      const opened = await jumpToActionPty(result);
      if (!opened || !opened.ok) throw new Error('赛程已启动，但对应 PTY 跳转失败');
    } catch (error) {
      notify(`运行赛程失败：${error.message}`, true);
    } finally {
      button.disabled = false;
      button.innerHTML = previous;
    }
  }

  async function runPhase(button, action, progressText, successText) {
    const forceWeekly = action === 'run-weekly' && state.environment !== 'virtual'
      && window.confirm('自动赛程只在周六运行。现在继续会作为手动验收立即沉淀最近交易日，是否继续？');
    if (action === 'run-weekly' && state.environment !== 'virtual' && !forceWeekly) return;
    button.disabled = true;
    const previous = button.innerHTML;
    button.innerHTML = `${icon('terminal')}执行并跳转 PTY…`;
    try {
      notify(progressText);
      const result = await ipcRenderer.invoke(leagueChannel(action), { trigger: 'manual', ...(forceWeekly ? { force: true } : {}) });
      if (!result || !result.ok) throw new Error(result && result.message || `${action} 失败`);
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

  async function toggleVirtualMode() {
    if (state.run) return notify('当前赛程仍在运行，完成后再切换环境', true);
    if (state.environment === 'virtual') {
      state.environment = 'live';
      state.virtual = null;
      state.selectedId = null;
      closeDetail();
      closePromptWorkbench();
      while (state.loading) await new Promise((resolve) => setTimeout(resolve, 20));
      await refresh(true);
      notify('已返回正式联赛；虚拟沙盒保留，可稍后继续');
      return;
    }
    const previousEnvironment = state.environment;
    state.environment = 'virtual';
    try {
      const result = await ipcRenderer.invoke('agent-league:virtual-initialize', {});
      if (!result || !result.ok) throw new Error(result && result.message || '虚拟实盘初始化失败');
      state.virtual = result.debug;
      state.selectedId = null;
      closeDetail();
      while (state.loading) await new Promise((resolve) => setTimeout(resolve, 20));
      await refresh(true);
      notify(`已进入隔离虚拟实盘：${result.debug.virtualDate} · ${result.debug.scenarioLabel}`);
    } catch (error) {
      state.environment = previousEnvironment;
      while (state.loading) await new Promise((resolve) => setTimeout(resolve, 20));
      await refresh(false);
      notify(`虚拟实盘初始化失败：${error.message}`, true);
    }
  }

  async function configureVirtual() {
    if (state.environment !== 'virtual') return;
    try {
      const scenario = root.querySelector('[data-role="virtual-scenario"]').value;
      const result = await ipcRenderer.invoke('agent-league:virtual-configure', { scenario });
      if (!result || !result.ok) throw new Error(result && result.message || '虚拟行情配置失败');
      state.virtual = result.debug;
      notify(`虚拟行情已切换为：${result.debug.scenarioLabel}`);
      render();
    } catch (error) {
      notify(`虚拟行情配置失败：${error.message}`, true);
    }
  }

  async function selfTestVirtual() {
    try {
      const result = await ipcRenderer.invoke('agent-league:virtual-self-test');
      if (!result || !result.ok || !result.report) throw new Error(result && result.message || '账本自检未返回报告');
      state.virtualSelfTest = result.report;
      renderVirtualLab();
      const failed = (result.report.checks || []).filter((row) => !row.pass);
      notify(failed.length ? `虚拟账本自检失败：${failed.map((row) => row.id).join('、')}` : '虚拟账本自检 PASS：交易、费用、仓位、收益率与清仓链全部通过', failed.length > 0);
    } catch (error) {
      notify(`虚拟账本自检失败：${error.message}`, true);
    }
  }

  async function advanceVirtual() {
    if (state.environment !== 'virtual') return;
    try {
      const scenario = root.querySelector('[data-role="virtual-scenario"]').value;
      const result = await ipcRenderer.invoke('agent-league:virtual-advance', { scenario });
      if (!result || !result.ok) throw new Error(result && result.message || '虚拟日期推进失败');
      state.virtual = result.debug;
      await refresh(false);
      notify(`虚拟时钟已推进到 ${result.debug.virtualDate}`);
    } catch (error) {
      notify(`虚拟日期推进失败：${error.message}`, true);
    }
  }

  async function resetVirtual() {
    if (state.environment !== 'virtual') return;
    if (!window.confirm('重置只会删除隔离虚拟沙盒中的 Agent、Session、交易和统计；正式联赛不会受影响。确认继续？')) return;
    try {
      const scenario = root.querySelector('[data-role="virtual-scenario"]').value;
      const result = await ipcRenderer.invoke('agent-league:virtual-reset', { scenario });
      if (!result || !result.ok) throw new Error(result && result.message || '虚拟沙盒重置失败');
      state.virtual = result.debug;
      state.virtualSelfTest = null;
      state.selectedId = null;
      closeDetail();
      await refresh(false);
      notify(`虚拟沙盒已重置；正式联赛未改动，当前日期 ${result.debug.virtualDate}`);
    } catch (error) {
      notify(`虚拟沙盒重置失败：${error.message}`, true);
    }
  }

  async function toggleAuto() {
    if (state.environment === 'virtual') return notify('虚拟实盘由调试台手动推进，不启用真实时钟调度', true);
    const enabled = !(state.schedule && state.schedule.enabled);
    try {
      const result = await ipcRenderer.invoke(leagueChannel('update-schedule'), {
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

  async function toggleBackground() {
    if (state.environment === 'virtual') return;
    const keepAliveOnClose = state.schedule.keepAliveOnClose === false;
    try {
      const result = await ipcRenderer.invoke(leagueChannel('update-schedule'), {
        enabled: state.schedule.enabled === true,
        keepAliveOnClose,
        decisionTime: state.schedule.decisionTime || '08:30',
        decisionCutoff: state.schedule.decisionCutoff || '09:15',
        executionTime: state.schedule.executionTime || '09:35',
        resultTime: state.schedule.resultTime || '15:10',
        weeklyTime: state.schedule.weeklyTime || '10:00',
        maxConcurrency: state.schedule.maxConcurrency || 2,
      });
      if (!result || !result.ok) throw new Error(result && result.message || '设置失败');
      state.schedule = result.schedule;
      notify(keepAliveOnClose
        ? '已启用关窗后台守护：关闭窗口后联赛继续运行，可从托盘重新打开'
        : '已关闭后台守护：关闭窗口将退出此 Hub；其他 Hub 可按检查点接班');
      render();
    } catch (error) {
      notify(`后台守护设置失败：${error.message}`, true);
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
      const result = await ipcRenderer.invoke(leagueChannel('create'), payload);
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
