'use strict';
/**
 * 投委会 UI 壳（task#6/7 + 第二轮 task#16）：electron IPC + DOM 挂载。纯逻辑在 committee-ui-core.js。
 * - showModal(meeting)：开投委会弹窗（输股票+轮次+一键开始）→ invoke('committee:start')
 * - showHistory(meeting)：固定按钮唤起「过往投委会」历史列表（live 在跑的置顶）→ 点一场回看五幕
 * - 自注册 committee:progress 监听 → 独立浮层面板；面板可拖动、五幕 tab 可点看每幕每个 AI 发言。
 *
 * 视图三态（_view）：live（正在跑/最近一场，onProgress 实时刷新）/ history-list（历史列表）/
 * history-detail（回看某历史场）。_liveState 始终接收进度，回看历史时不被打断。
 */
(function () {
  const { ipcRenderer } = require('electron');
  const core = require('./committee-ui-core.js');

  let _modalEl = null;
  let _panelEl = null;
  let _liveState = core.initState(); // 正在跑/最近一场投委会（onProgress 持续更新）
  let _histState = null;             // 当前回看的历史场（recordToState 产物）
  let _histItems = [];               // 历史摘要列表
  let _screenerState = core.initScreenerState(); // 技术初筛独立面板状态
  let _view = 'live';                // live | history-list | history-detail
  let _meetingId = null;             // 浮窗绑定的投研 session（这场投委会属于哪个 meeting）
  let _activeMeetingId = null;       // 用户当前正在查看的 session（meeting-room 切换时 syncActiveMeeting 同步进来）
  let _pos = null;                   // 拖动后的位置 {left, top}，跨重渲染保持

  function _q(sel, root) { return (root || document).querySelector(sel); }
  function _qa(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  function _curState() {
    if (_view === 'history-list') return Object.assign(core.initState(), { view: 'history', historyList: _histItems });
    if (_view === 'history-detail' && _histState) return _histState;
    if (_view === 'screener') return _screenerState;
    return _liveState;
  }

  // ── 开投委会弹窗 ──
  function showModal(meeting) {
    _meetingId = meeting && meeting.id;
    _activeMeetingId = _meetingId;   // 用户在当前 session 主动开投委会 → 当前看的就是这个 meeting
    closeModal();
    _modalEl = document.createElement('div');
    _modalEl.className = 'cm-modal-mask';
    _modalEl.innerHTML = core.modalHtml('');
    document.body.appendChild(_modalEl);
    _modalEl.addEventListener('click', (e) => { if (e.target === _modalEl) closeModal(); });
    const cancel = _q('[data-cm-cancel]', _modalEl); if (cancel) cancel.onclick = closeModal;
    const start = _q('[data-cm-start]', _modalEl); if (start) start.onclick = onStart;
    const ta = _q('[data-cm-stocks]', _modalEl); if (ta) ta.focus();
  }
  function closeModal() { if (_modalEl) { _modalEl.remove(); _modalEl = null; } }

  async function onStart() {
    if (!_modalEl) return;
    const raw = (_q('[data-cm-stocks]', _modalEl) || {}).value || '';
    const rounds = Number((_q('[data-cm-rounds]', _modalEl) || {}).value) || 4;
    const stocks = core.parseStocks(raw);
    const errEl = _q('[data-cm-err]', _modalEl);
    if (!stocks.length) { if (errEl) errEl.textContent = '请至少输入一只股票（代码或名称）'; return; }
    closeModal();
    _liveState = core.initState();
    _view = 'live';
    ensurePanel();
    renderPanel();
    try {
      const r = await ipcRenderer.invoke('committee:start', { meetingId: _meetingId, stocks, rounds });
      if (r && r.status === 'error') { _liveState = core.reduceProgress(_liveState, { type: 'error', reason: r.reason }); if (_view === 'live') renderPanel(); }
    } catch (e) {
      _liveState = core.reduceProgress(_liveState, { type: 'error', reason: (e && e.message) || '启动失败' });
      if (_view === 'live') renderPanel();
    }
  }

  // ── 过往投委会：固定按钮唤起历史列表（live 在跑的置顶）→ 点一场回看 ──
  async function showHistory(meeting) {
    if (meeting && meeting.id) { _meetingId = meeting.id; _activeMeetingId = meeting.id; }
    let items = [];
    try {
      const r = await ipcRenderer.invoke('committee:history:list');
      if (r && r.status === 'ok') items = r.items || [];
    } catch (e) { /* 列表失败给空 */ }
    if (_liveState && _liveState.active) {
      items = [{ id: '__live__', live: true, stocks: _liveState.stocks, chair: _liveState.chair, rounds: _liveState.rounds }].concat(items);
    }
    _histItems = items;
    _view = 'history-list';
    ensurePanel();
    renderPanel();
  }

  async function loadHistory(id) {
    if (id === '__live__') { _view = 'live'; renderPanel(); return; }
    try {
      const r = await ipcRenderer.invoke('committee:history:get', { id });
      if (r && r.status === 'ok' && r.record) { _histState = core.recordToState(r.record); _view = 'history-detail'; renderPanel(); }
    } catch (e) { /* ignore */ }
  }

  // ── 面板挂载 / 渲染 / 交互 ──
  function ensurePanel() {
    if (!_panelEl) {
      _panelEl = document.createElement('div');
      _panelEl.className = 'cm-panel';
      document.body.appendChild(_panelEl);
    }
    if (_pos) { _panelEl.style.left = _pos.left + 'px'; _panelEl.style.top = _pos.top + 'px'; _panelEl.style.right = 'auto'; }
    _applyPanelVisibility();
  }
  function renderPanel() {
    if (!_panelEl) return;
    _panelEl.innerHTML = core.panelHtml(_curState());
    const c = _q('[data-cm-panel-close]', _panelEl); if (c) c.onclick = closePanel;
    const ho = _q('[data-cm-hist-open]', _panelEl); if (ho) ho.onclick = () => showHistory();
    _qa('[data-cm-tab]', _panelEl).forEach(el => { el.onclick = () => _onTab(el.getAttribute('data-cm-tab')); });
    _qa('[data-cm-hist-id]', _panelEl).forEach(el => { el.onclick = () => loadHistory(el.getAttribute('data-cm-hist-id')); });
    const head = _q('[data-cm-drag]', _panelEl); if (head) _makeDraggable(head);
  }
  function _onTab(tab) {
    if (_view === 'history-detail' && _histState) _histState = Object.assign({}, _histState, { activeTab: tab });
    else _liveState = Object.assign({}, _liveState, { activeTab: tab });
    renderPanel();
  }
  function closePanel() { if (_panelEl) { _panelEl.remove(); _panelEl = null; } }

  // 浮窗与所属投研 session 绑定：只在「它绑定的 meeting 正被查看」时显示；切到别的 session 隐藏
  //   （DOM + _liveState 全保留，progress 继续在后台累积，切回该 session 即恢复，不丢进度）。
  function _applyPanelVisibility() {
    if (!_panelEl) return;
    const mine = !!(_meetingId && _activeMeetingId === _meetingId);
    _panelEl.style.display = mine ? '' : 'none';
  }
  // meeting-room 切换/打开 session 时调用，告知现在在看哪个 meeting（null = 离开群聊）。
  function syncActiveMeeting(activeId) {
    _activeMeetingId = activeId || null;
    _applyPanelVisibility();
  }

  function _makeDraggable(handle) {
    handle.onmousedown = (e) => {
      if (e.target.closest('button')) return; // 头部的按钮（关闭/历史）不触发拖动
      e.preventDefault();
      const rect = _panelEl.getBoundingClientRect();
      const ox = e.clientX - rect.left, oy = e.clientY - rect.top;
      const onMove = (ev) => {
        const left = Math.max(0, Math.min(window.innerWidth - 60, ev.clientX - ox));
        const top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - oy));
        _panelEl.style.left = left + 'px'; _panelEl.style.top = top + 'px'; _panelEl.style.right = 'auto';
        _pos = { left, top };
      };
      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };
  }

  function _newRunId() {
    return 'scr-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  // 技术初筛 = 独立功能（趋势龙雷达 / 投研门户），与投委会解耦；在 Hub 内显示进度和最终榜单。
  async function showScreener(meeting) {
    if (meeting && meeting.id) { _meetingId = meeting.id; _activeMeetingId = meeting.id; }
    const runId = _newRunId();
    _screenerState = core.reduceScreenerProgress(core.initScreenerState({ meetingId: _meetingId, runId }), {
      type: 'start',
      stage: '启动',
      percent: 1,
      message: '准备读取技术初筛快照',
    });
    _view = 'screener';
    ensurePanel();
    renderPanel();
    try {
      const r = await ipcRenderer.invoke('committee:screener:run', { meetingId: _meetingId, runId, limit: 12 });
      if (r && r.status === 'error') {
        _screenerState = core.reduceScreenerProgress(_screenerState, { type: 'error', reason: r.reason || '技术初筛失败', percent: 100 });
      } else if (r && r.result && !_screenerState.done) {
        _screenerState = core.reduceScreenerProgress(_screenerState, { type: 'done', result: r.result, percent: 100, message: '技术初筛结果已生成' });
      }
      if (_view === 'screener') renderPanel();
    } catch (e) {
      _screenerState = core.reduceScreenerProgress(_screenerState, { type: 'error', reason: (e && e.message) || '技术初筛失败', percent: 100 });
      if (_view === 'screener') renderPanel();
    }
  }

  function onProgress(payload) {
    if (!payload) return;
    if (_meetingId && payload.meetingId && payload.meetingId !== _meetingId) return; // 只认本房间
    _liveState = core.reduceProgress(_liveState, payload); // 始终更新 live（即使在回看历史）
    if (_view === 'live') { ensurePanel(); renderPanel(); }
  }

  function onScreenerProgress(payload) {
    if (!payload) return;
    if (_meetingId && payload.meetingId && payload.meetingId !== _meetingId) return;
    if (_screenerState && _screenerState.runId && payload.runId && payload.runId !== _screenerState.runId) return;
    _screenerState = core.reduceScreenerProgress(_screenerState, payload);
    if (_view === 'screener') { ensurePanel(); renderPanel(); }
  }

  try { ipcRenderer.on('committee:progress', (_e, payload) => onProgress(payload)); } catch (e) { /* 非 electron 环境忽略 */ }
  try { ipcRenderer.on('committee:screener:progress', (_e, payload) => onScreenerProgress(payload)); } catch (e) { /* 非 electron 环境忽略 */ }

  window.committeeUI = { showModal, closeModal, closePanel, showHistory, onProgress, showScreener, showScreenerHint: showScreener, onScreenerProgress, syncActiveMeeting, _getState: () => _curState() };
})();
