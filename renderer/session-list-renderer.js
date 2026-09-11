// 纯函数：按最新 AI 回答时间年龄分桶。pinned 永远进 recent（置顶不折叠）。
//   recent: <24h（保持现状 UI 置顶）· mid: 24-72h · old: ≥72h
const { isGroupChatMemberRunning } = require('../core/groupchat-running-state.js');
const { compareLatestActivityDesc, latestActivityTime } = require('../core/session-recency.js');
const {
  sessionHasCompletedUnread,
} = require('../core/session-attention-state.js');
const { hasStreamDisconnectIssue } = require('../core/stream-disconnect.js');
const { KIND_LABELS } = require('../core/ai-kinds.js');
const {
  RUNTIME_STARTING,
  RUNTIME_RUNNING,
  RUNTIME_WAITING,
  RUNTIME_FAILED,
  RUNTIME_DORMANT,
  RUNTIME_UNKNOWN,
  getSessionRuntimeTruth,
  runtimeTruthSummary,
  sessionRuntimeIsActive,
} = require('../core/session-runtime-truth.js');

function partitionSessionsByAge(items, now) {
  const DAY = 86400000;
  const recent = [], mid = [], old = [];
  for (const s of items || []) {
    const t = latestActivityTime(s, now);
    const age = now - t;
    if (s.pinned || age < DAY) recent.push(s);
    else if (age < 3 * DAY) mid.push(s);
    else old.push(s);
  }
  return { recent, mid, old };
}

function isPinnedToBottom(item) {
  return !!(item && item.bottomed && !item.pinned);
}

function compareSidebarPlacement(left, right) {
  const leftPinned = !!(left && left.pinned);
  const rightPinned = !!(right && right.pinned);
  if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
  const leftBottomed = isPinnedToBottom(left);
  const rightBottomed = isPinnedToBottom(right);
  if (leftBottomed !== rightBottomed) return leftBottomed ? 1 : -1;
  return compareLatestActivityDesc(left, right);
}

// --- 侧栏 AI 家族筛选 ---
// 家族由 kind（哪个 CLI）决定，模型只是家族内部的选择：Opus / Fable / Sonnet 都是
// Claude CLI 起的会话，GPT 各版本都是 Codex CLI 起的。所以按 kind 分族，与用户
// 心里的「这是 Claude 还是 Codex」完全对得上，不需要再解析 currentModel。
// DeepSeek 现在由 Codex CLI + Responses API 启动，但品牌仍是独立的一家，归「其他」。
const SESSION_FAMILY_TABS = [
  { key: 'all', label: '全部', hint: '所有会话与群聊' },
  { key: 'claude', label: 'Claude', hint: 'Claude Code（Opus / Fable / Sonnet / Haiku）' },
  { key: 'codex', label: 'Codex', hint: 'Codex CLI（GPT 各版本）' },
  { key: 'other', label: '其他', hint: 'Gemini / DeepSeek / Kimi / PowerShell' },
];
const SESSION_FAMILY_KEYS = SESSION_FAMILY_TABS.map(tab => tab.key);

// --- Agent 自建会话的分组收纳 ---------------------------------------------
// 学习教练、投研联赛选手这类会话是**机器创建**的：数量随功能增加而膨胀，而且
// 用户平时不需要在列表里逐个看到它们（要用时点开一个就够）。混在人工会话里
// 会把「最近」那一段挤没，侧栏就失去了可读性。
//
// 按 purpose 分组，加新的 Agent 系统时只在这张表里加一行，不改渲染逻辑。
// 注意 chuxin-research 不在这里：它在下面的基础过滤里本来就被完全排除，
// 属于「永远不进侧栏」，而不是「可收可展」。
const AGENT_SESSION_GROUPS = [
  { key: 'study', label: '学习', purposes: ['study-companion'] },
  { key: 'league', label: '投研', purposes: ['agent-league', 'agent-league-virtual'] },
];
const AGENT_GROUP_KEYS = AGENT_SESSION_GROUPS.map(g => g.key);
const AGENT_PURPOSE_TO_GROUP = new Map();
for (const g of AGENT_SESSION_GROUPS) {
  for (const p of g.purposes) AGENT_PURPOSE_TO_GROUP.set(p, g.key);
}
function agentGroupOf(session) {
  return AGENT_PURPOSE_TO_GROUP.get(String(session && session.purpose || '')) || '';
}

function familyOfKind(kind) {
  const base = String(kind || '').replace(/-resume$/, '');
  if (base === 'claude') return 'claude';
  if (base === 'codex') return 'codex';
  return 'other';
}

// 返回条目所属的家族集合。群聊按成员归属，可以同时属于多个家族——混合群聊只算
// 一个家族的话，切到另一个页签时它会凭空消失，而它确实有那边的成员在跑。
function sessionFamilies(item, sessionMap) {
  if (!item) return new Set();
  if (!item._isMeeting) return new Set([familyOfKind(item.kind)]);
  const ids = (item._meeting && item._meeting.subSessions) || [];
  const families = new Set();
  for (const id of ids) {
    const sub = sessionMap && typeof sessionMap.get === 'function' ? sessionMap.get(id) : null;
    if (sub) families.add(familyOfKind(sub.kind));
  }
  // 成员还没同步进 map 的新群聊不能凭空消失，落到「其他」保底可见。
  if (families.size === 0) families.add('other');
  return families;
}

// Search reads the sidebar's live catalogue, scoped to its document.
const sidebarSources = new WeakMap();
function getSidebarSearchEntries(doc) {
  return sidebarSources.get(doc)?.() || [];
}

function partitionSidebarSessions(items, { now = Date.now(), sessionMap = new Map(), activeSessionId = null, activeMeetingId = null, groupMemberIds = new Set() } = {}) {
  const pinned = [], respond = [], failed = [], running = [], completed = [], today = [], archive = [], older = [];
  const states = new Map();
  for (const s of [...(items || [])].sort(compareSidebarPlacement)) {
    const truth = s._isMeeting ? null : getSessionRuntimeTruth(s, { now });
    const meeting = s._isMeeting ? _meetingRuntimeAggregate(s._meeting, sessionMap, now) : null;
    const dormant = s._isMeeting ? s.status === 'dormant' : truth.state === RUNTIME_DORMANT;
    const selected = s.id === (s._isMeeting ? activeMeetingId : activeSessionId);
    const fresh = now - latestActivityTime(s, now) < 86400000;
    const waiting = meeting ? meeting.waiting : truth.state === RUNTIME_WAITING;
    const error = meeting ? meeting.failed : truth.state === RUNTIME_FAILED || hasStreamDisconnectIssue(s);
    const working = s._resumePending || (meeting ? meeting.running
      : (s.meetingId || groupMemberIds.has(s.id)) ? isGroupChatMemberRunning(s, now) : sessionRuntimeIsActive(s, { now }));
    const unread = !selected && (!dormant || fresh) && (s._isMeeting ? s.unreadAnsweredSize > 0 : sessionHasCompletedUnread(s));
    states.set(s.id, waiting ? 'wait' : error ? 'error' : working ? 'run' : unread ? 'unread' : dormant ? 'dorm' : truth?.state === RUNTIME_UNKNOWN ? 'unknown' : 'idle');
    if (s.pinned) pinned.push(s);
    else if (waiting) respond.push(s);
    else if (error) failed.push(s);
    else if (working) running.push(s);
    else if (unread) completed.push(s);
    else if (dormant) archive.push(s);
    else if (fresh) today.push(s);
    else older.push(s);
  }
  return { pinned, active: [...respond, ...failed, ...running, ...completed], today, archive, older, archiveCount: archive.length, states };
}

function _meetingRuntimeAggregate(meeting, sessionMap, now = Date.now()) {
  const truths = ((meeting && meeting.subSessions) || [])
    .map(id => sessionMap.get(id))
    .filter(Boolean)
    .map(session => ({ session, truth: getSessionRuntimeTruth(session, { now }) }));
  return {
    waiting: truths.some(item => item.truth.state === RUNTIME_WAITING),
    running: meeting && !meeting.groupChat && meeting.status === 'running'
      || truths.some(item => isGroupChatMemberRunning(item.session, now)),
    disconnected: truths.some(item => hasStreamDisconnectIssue(item.session)),
    failed: truths.some(item => item.truth.state === RUNTIME_FAILED || hasStreamDisconnectIssue(item.session)),
    truths,
  };
}


function createSessionListRenderer(options = {}) {
  const { detailsHtml } = require('./session-details.js');
  const doc = options.document || document;
  const storage = options.localStorage || localStorage;
  const sectionKeys = ['sec-pinned', 'sec-active', 'sec-today', 'sec-dormant'];
  let collapsedSections = new Set();
  let dormantDays = 1;
  let modelFilter = 'all';
  try {
    const saved = JSON.parse(storage.getItem('hubSidebarCollapsedSections') || '[]');
    if (Array.isArray(saved)) collapsedSections = new Set(saved.filter(key => sectionKeys.includes(key)));
    const days = Number(storage.getItem('hubSidebarDormantDays'));
    if ([1, 3, 7].includes(days)) dormantDays = days;
    const model = storage.getItem('hubSidebarModelFilter');
    if (SESSION_FAMILY_KEYS.includes(model)) modelFilter = model;
  } catch (error) { console.warn('[sidebar] preferences could not be read:', error.message); }
  function savePreference(key, value) {
    try { storage.setItem(key, value); }
    catch (error) { console.warn('[sidebar] preference could not be saved:', error.message); }
  }
  const modelControl = doc.getElementById?.('session-model-filter');
  if (modelControl) {
    modelControl.value = modelFilter;
    modelControl.addEventListener('change', () => {
      modelFilter = SESSION_FAMILY_KEYS.includes(modelControl.value) ? modelControl.value : 'all';
      savePreference('hubSidebarModelFilter', modelFilter);
      renderSessionList();
    });
  }
  let detailsEnabled = false;
  try { detailsEnabled = storage.getItem('hubSessionDetails') === 'true'; } catch {}
  const collapsedDetailsMeetings = new Set();
  let hoveredMeetingId = null;
  let hoverPoint = null;
  const detailsButton = doc.getElementById?.('btn-session-details');
  const syncDetailsButton = () => detailsButton?.setAttribute?.('aria-pressed', String(detailsEnabled));
  syncDetailsButton();
  detailsButton?.addEventListener('click', () => {
    detailsEnabled = !detailsEnabled;
    try { storage.setItem('hubSessionDetails', String(detailsEnabled)); }
    catch (error) { console.warn('[sidebar] detail preference could not be saved:', error.message); }
    syncDetailsButton();
    renderSessionList();
  });
  const sessionListEl = options.sessionListEl;
  const getSessions = typeof options.getSessions === 'function' ? options.getSessions : () => new Map();
  const getMeetings = typeof options.getMeetings === 'function' ? options.getMeetings : () => ({});
  const getActiveSessionId = typeof options.getActiveSessionId === 'function' ? options.getActiveSessionId : () => null;
  const getActiveMeetingId = typeof options.getActiveMeetingId === 'function' ? options.getActiveMeetingId : () => null;
  const isAiKind = options.isAiKind;
  const modelShort = options.modelShort;
  const modelClass = options.modelClass;
  const escapeHtml = options.escapeHtml;
  const formatTime = options.formatTime;
  const pctClass = options.pctClass;
  const getResourceUsage = typeof options.getResourceUsage === 'function' ? options.getResourceUsage : () => null;
  const getProxyInfo = typeof options.getProxyInfo === 'function' ? options.getProxyInfo : () => null;
  const acknowledgeNetworkChange = typeof options.acknowledgeNetworkChange === 'function'
    ? options.acknowledgeNetworkChange
    : null;
  const selectSession = options.selectSession;
  const selectMeeting = options.selectMeeting;
  const openContextMenu = options.openContextMenu;
  // 「已完成未读」组头上的一键已读。渲染层只负责按钮，真正清状态由 renderer.js 注入。
  const markAllSessionsRead = typeof options.markAllSessionsRead === 'function'
    ? options.markAllSessionsRead
    : null;
  // 2026-07-19 方案C：列表渲染完成后的回调（renderer 用来刷新 ctx chip/中断钮/等你响应浮动条）
  const afterRender = typeof options.afterRender === 'function' ? options.afterRender : null;
  const renderStats = { renders: 0, slowRenders: 0, lastMs: 0, maxMs: 0 };
  const nowMs = typeof options.nowMs === 'function'
    ? options.nowMs
    : () => (typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now());

// --- Sidebar tree state: which meeting entries are expanded to show their sub-sessions ---
// Persists across reloads. Default = collapsed (白名单未命中即折叠)；用户点 ▶ 后才进
// _expandedMeetings 集合并落盘。2026-05-05 道雪改：新 AI 群聊不再默认展开，折叠态本来
// 就有 3 个迷你头像跳转按钮可用。
const _expandedMeetings = (() => {
  try {
    const raw = storage.getItem('hubExpandedMeetings');
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
})();
function _persistExpandedMeetings() {
  try {
    storage.setItem('hubExpandedMeetings', JSON.stringify([..._expandedMeetings]));
  } catch {}
}
function toggleMeetingExpand(meetingId) {
  if (detailsEnabled && getMeetings()[meetingId]?.groupChat) {
    if (collapsedDetailsMeetings.has(meetingId)) collapsedDetailsMeetings.delete(meetingId);
    else collapsedDetailsMeetings.add(meetingId);
    renderSessionList();
    return;
  }
  if (_expandedMeetings.has(meetingId)) _expandedMeetings.delete(meetingId);
  else _expandedMeetings.add(meetingId);
  _persistExpandedMeetings();
  renderSessionList();
}

function _logoKind(kind) {
  const k = String(kind || '').replace(/-resume$/, '');
  if (k.startsWith('deepseek')) return 'deepseek'; // deepseek-legacy 复用 DS 图标
  if (k === 'powershell' || isAiKind(k)) return k;
  return '';
}

// AI mini logo for sidebar sub-session items. Reuses the .ai-logo + .logo-<kind>
// classes already defined in styles.css for the toolbar dropdown.
function _aiLogoHtml(kind) {
  const k = _logoKind(kind);
  return k ? `<span class="ai-logo logo-${k}" aria-hidden="true"></span>` : '';
}

// 2026-09-01 · 侧栏瘦身：时间左边的「Opus 5 / gpt-5.6-sol」字串换成一枚品牌小图标。
//   扫列表时真正要一眼分辨的只是"哪家 CLI"，具体型号是二级信息 → 退到 tooltip
//   （sl-title 的 titleTip 里本来就有完整 displayName，这里再给一份就近的）。
//   拿不到图标的 kind 回落成原来的文字列，避免这一列直接消失。
function _sessionKindHtml(kind, modelTxt) {
  const k = _logoKind(kind);
  if (!k) return `<span class="sl-model">${escapeHtml(modelTxt || '')}</span>`;
  const label = KIND_LABELS[k] || k;
  const tip = modelTxt ? `${label} · ${modelTxt}` : label;
  return `<span class="sl-kind ai-logo logo-${k}" role="img" aria-label="${escapeHtml(label)}" title="${escapeHtml(tip)}"></span>`;
}

const PIN_SVG = '<svg class="sl-pin" viewBox="0 0 24 24" aria-label="置顶"><path d="m8 3 8 0-1 7 4 4H5l4-4-1-7Zm4 11v7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
function _warningHtml(message) {
  return message ? `<svg class="sl-warning" viewBox="0 0 24 24" role="img" aria-label="${escapeHtml(message)}"><title>${escapeHtml(message)}</title><path d="M12 3 2 21h20L12 3Zm0 6v5m0 3v1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>` : '';
}
function _ringHtml(ctxPct, dotCls) {
  const labels = { wait: '等你响应', error: '运行异常', run: '运行中', start: '唤醒中', unread: '已完成未读', dorm: '休眠', idle: '就绪', unknown: '状态未知' };
  return '<span class="sl-dot ' + dotCls + '" role="img" aria-label="' + (labels[dotCls] || '就绪') + '"></span>';
}

function _subIsRunning(sub) {
  return isGroupChatMemberRunning(sub);
}


function _sessionWarningText(session) {
  if (!session) return '';
  const warnings = [];
  if (session.cwdFellBackFrom) {
    warnings.push(`原目录失效：${session.cwdFellBackFrom}；当前回落到：${session.cwd || '(unknown)'}`);
  }
  if (session.memoryLinkWarning) {
    warnings.push(`记忆未接入规范库：${session.memoryLinkWarning}`);
  }
  if (hasStreamDisconnectIssue(session)) {
    warnings.push(`网络断连：${String(session.connectionIssue.message || '连接已中断')}`);
  }
  return warnings.join('；');
}

  function _meetingAnySubRunning(meeting, sessionMap) {
    const aggregate = _meetingRuntimeAggregate(meeting, sessionMap);
    return aggregate.running && !aggregate.disconnected;
  }

  // 代理配置只用于 tooltip；可见文案必须是 main 进程实测的公网 IP + 城市。
  // 只显示 host:port，隐去可能带凭据的 user:pass@ 部分。
  function _shortProxy(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    try {
      const u = new URL(s.includes('://') ? s : `http://${s}`);
      return u.port ? `${u.hostname}:${u.port}` : u.hostname;
    } catch {
      return s.replace(/^[a-z0-9+.-]+:\/\//i, '').replace(/^[^@/]*@/, '').split('/')[0] || null;
    }
  }

  function renderSidebarStrip(sessionMap = getSessions()) {
    const stripEl = doc.getElementById('sidebar-strip');
    if (!stripEl) return;

    const usage = getResourceUsage() || {};
    const cpuPct = Number.isFinite(usage.cpuPct) ? Math.round(usage.cpuPct) : null;
    const memoryPct = Number.isFinite(usage.memoryPct) ? Math.round(usage.memoryPct) : null;
    const metricClass = value => value != null && value >= 85 ? ' strip-resource-high' : '';
    const proxy = typeof getProxyInfo === 'function' ? getProxyInfo() : null;
    const proxyShort = _shortProxy(proxy && proxy.proxy);
    const egress = proxy && proxy.egress;
    const foreign = egress && egress.foreign;
    const domestic = egress && egress.domestic;
    const displayRoute = proxyShort ? foreign : domestic;
    const alert = egress && egress.alert;

    const ackAttr = alert && alert.acknowledgeable ? ' data-egress-ack="true"' : '';
    const foreignTitle = [
      proxyShort ? 'Claude / Codex 订阅、Gemini：经 VPN 代理' : '未配置 VPN，显示直连出口',
      proxyShort ? `本地代理：${proxyShort}` : '本地代理：未配置',
      displayRoute && displayRoute.ok ? `出口地区：${displayRoute.locationLabel || '未知地区'}` : `状态：${displayRoute && displayRoute.error || '检测中'}`,
      alert ? `${alert.title || '节点异常'}：${alert.message || ''}` : '',
      alert && alert.acknowledgeable ? '点击此行确认当前节点' : '',
    ].filter(Boolean).join('\n');
    const domesticTitle = [
      'Kimi / DeepSeek：清空 HTTP(S)_PROXY 后直连',
      domestic && domestic.ok ? `出口地区：${domestic.locationLabel || '未知地区'}` : `状态：${domestic && domestic.error || '检测中'}`,
    ].join('\n');

    const routeClass = (route, warning) => !egress ? 'pending' : warning || !route?.ok ? 'warning' : 'ok';
    const metric = (label, value) => `<span class="strip-resource${metricClass(value)}" title="${label} ${value == null ? '检测中' : value + '%'}">${label}<b>${value == null ? '—' : value + '%'}</b><span class="strip-mini-track"><i style="width:${value == null ? 0 : Math.max(0, Math.min(100, value))}%"></i></span></span>`;
    const location = displayRoute?.ok
      ? [displayRoute.countryZh || displayRoute.country || '国家未知', displayRoute.cityZh || displayRoute.city || '城市未知'].join(' ')
      : '出口未知';
    const domesticLabel = !egress ? '国内检测中' : domestic?.ok ? '国内正常' : '国内异常';
    stripEl.innerHTML =
      '<div class="strip-resources">' + metric('CPU', cpuPct) + metric('内存', memoryPct) + '</div>' +
      `<div class="strip-network"><button type="button" class="strip-route-row strip-route-foreign strip-proxy" title="${escapeHtml(foreignTitle)}"${ackAttr}><span class="strip-route-dot ${routeClass(displayRoute, proxyShort ? alert : null)}"></span><span>${proxyShort ? 'VPN' : '直连'}</span><span class="strip-location">${escapeHtml(location)}</span></button>` +
      `<span class="strip-route-row strip-route-domestic" title="${escapeHtml(domesticTitle)}"><span class="strip-route-dot ${routeClass(domestic)}"></span>${domesticLabel}</span></div>`;
    stripEl.title = '';
    stripEl.style.display = 'flex';

    const acknowledgeRow = stripEl.querySelector('[data-egress-ack="true"]');
    if (acknowledgeRow && acknowledgeNetworkChange) {
      acknowledgeRow.addEventListener('click', async () => {
        if (acknowledgeRow.classList.contains('acknowledging')) return;
        acknowledgeRow.classList.add('acknowledging');
        try { await acknowledgeNetworkChange(); } finally { acknowledgeRow.classList.remove('acknowledging'); }
      });
    }
  }

  // Session rows are rebuilt wholesale whenever status/recency changes. With
  // hundreds of rows, a rebuild can land between pointer-down and pointer-up;
  // a click listener attached to the removed row then never fires. Capture the
  // navigation intent on the stable list container and finish it on pointer-up.
  const POINTER_NAV_MAX_MOVE_PX = 8;
  const POINTER_CLICK_SUPPRESS_MS = 750;
  const POINTER_REPEAT_INTENT_MS = 500;
  let pendingPointerNavigation = null;
  let lastPointerNavigationAt = 0;
  let lastPointerActivation = null;

  function navigationIntentFromTarget(target) {
    if (!target || typeof target.closest !== 'function') return null;
    const usage = target.closest('[data-usage-id]');
    if (usage) return { type: 'usage', id: usage.getAttribute('data-usage-id') };
    const jump = target.closest('[data-sub-id]');
    if (jump) return { type: 'session', id: jump.getAttribute('data-sub-id') };
    const toggle = target.closest('[data-action="toggle-expand"]');
    if (toggle) {
      const meeting = toggle.closest('[data-meeting-id]');
      return meeting ? { type: 'toggle-meeting', id: meeting.getAttribute('data-meeting-id') } : null;
    }
    const meeting = target.closest('[data-meeting-id]');
    if (meeting) return { type: 'meeting', id: meeting.getAttribute('data-meeting-id') };
    const session = target.closest('[data-session-id]');
    if (session) return { type: 'session', id: session.getAttribute('data-session-id') };
    return null;
  }

  function activateNavigationIntent(intent) {
    if (!intent || !intent.id) return false;
    try {
      if (intent.type === 'usage') {
        // Usage details live in the hover tooltip. Consume the click so it
        // does not activate or resume the surrounding session row.
        return true;
      }
      if (intent.type === 'toggle-meeting') {
        toggleMeetingExpand(intent.id);
        return true;
      }
      const action = intent.type === 'meeting'
        ? selectMeeting(intent.id, { forceScrollBottom: true })
        : selectSession(intent.id, { forceScrollBottom: intent.id === getActiveSessionId() });
      Promise.resolve(action).catch(error => console.warn('[sidebar] navigation failed:', error));
      return true;
    } catch (error) {
      console.warn('[sidebar] navigation failed:', error);
      return false;
    }
  }

  sessionListEl.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const rawIntent = navigationIntentFromTarget(event.target);
    const now = Date.now();
    const x = Number(event.clientX) || 0;
    const y = Number(event.clientY) || 0;
    // A first click can immediately reorder the selected/resuming row. The
    // second half of a physical double-click then lands on whatever row moved
    // into the old coordinates, even though the user's intent did not change.
    // Keep the first intent for a same-position repeat inside the native
    // double-click window; a deliberate click elsewhere still uses its row.
    const repeatedAtSamePoint = lastPointerActivation
      && now - lastPointerActivation.at <= POINTER_REPEAT_INTENT_MS
      && Math.hypot(x - lastPointerActivation.x, y - lastPointerActivation.y) <= POINTER_NAV_MAX_MOVE_PX;
    const intent = rawIntent && repeatedAtSamePoint ? lastPointerActivation.intent : rawIntent;
    if (!intent || !intent.id) return;
    pendingPointerNavigation = {
      intent,
      pointerId: event.pointerId,
      x,
      y,
    };
    try { sessionListEl.setPointerCapture?.(event.pointerId); } catch {}
  });

  sessionListEl.addEventListener('pointerup', (event) => {
    const pending = pendingPointerNavigation;
    if (!pending || pending.pointerId !== event.pointerId) return;
    pendingPointerNavigation = null;
    try { sessionListEl.releasePointerCapture?.(event.pointerId); } catch {}
    const moved = Math.hypot(
      (Number(event.clientX) || 0) - pending.x,
      (Number(event.clientY) || 0) - pending.y,
    );
    lastPointerNavigationAt = Date.now();
    if (moved > POINTER_NAV_MAX_MOVE_PX) return;
    lastPointerActivation = {
      intent: pending.intent,
      x: pending.x,
      y: pending.y,
      at: Date.now(),
    };
    event.preventDefault();
    event.stopPropagation();
    activateNavigationIntent(pending.intent);
  });

  sessionListEl.addEventListener('pointercancel', (event) => {
    if (pendingPointerNavigation && pendingPointerNavigation.pointerId === event.pointerId) {
      pendingPointerNavigation = null;
    }
  });

  // Keyboard activation and older PointerEvent fallbacks still arrive as
  // click. Suppress the synthetic click that follows a handled pointer-up.
  sessionListEl.addEventListener('click', (event) => {
    const intent = navigationIntentFromTarget(event.target);
    if (!intent || !intent.id) return;
    // A wholesale rebuild may put a *different* row under the pointer before
    // Chromium emits its compatibility click. The pointer-up already honored
    // the captured intent, so suppress any immediately following mouse click,
    // not only one whose new DOM target happens to have the same id. Keyboard
    // and programmatic activation use detail=0 and remain available.
    const duplicate = lastPointerNavigationAt > 0
      && event.detail !== 0
      && Date.now() - lastPointerNavigationAt <= POINTER_CLICK_SUPPRESS_MS;
    event.preventDefault();
    event.stopPropagation();
    if (!duplicate) activateNavigationIntent(intent);
  });

sessionListEl.addEventListener('keydown', event => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
  const row = event.target?.closest?.('.session-item');
  if (!row) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const rows = [...sessionListEl.querySelectorAll('.session-item')]
      .filter(el => !el.getClientRects || el.getClientRects().length > 0);
    const index = rows.indexOf(row);
    const next = rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
    event.preventDefault(); event.stopPropagation(); next?.focus();
  } else if (event.key === 'Enter' && event.target === row) {
    event.preventDefault(); event.stopPropagation();
    activateNavigationIntent(navigationIntentFromTarget(row));
  }
});

// --- Session list rendering ---
// Sort: pinned sessions first, ordinary/group sessions by latest activity, and
// explicit bottomed sessions last.  The final render also gives bottomed items
// their own literal last section so age/status buckets cannot move below them.
// Tree shape: meeting entries optionally expand to show their child sub-sessions.
// Top-level regular sessions (no meetingId) sit alongside meetings in the same sort order.
  function collectSidebarItems(sessionMap = getSessions()) {
    const memberIds = new Set(Object.values(getMeetings()).flatMap(m => m.subSessions || []));
    const regularSessions = Array.from(sessionMap.values())
    .filter(s => !s.meetingId && !memberIds.has(s.id) && s.kind !== 'chuxin-run' && !s.hiddenFromSidebar && s.purpose !== 'chuxin-research');

  const meetingItems = Object.values(getMeetings()).map(m => ({
    id: m.id,
    title: m.title,
    lastMessageTime: m.lastMessageTime,
    lastCompletedAt: m.lastCompletedAt,
    createdAt: m.createdAt,
    lastOutputPreview: m.groupChat
      ? `AI 群聊 · ${(m.participants || m.subSessions || []).length}/${(m.subSessions || []).length} 已选`
      : `${m.subSessions.length} 个子会话`,
    status: m.status || 'idle',
    // 2026-05-05 道雪 修3：AI 群聊 item 接入 unread 机制 —— 全员答完且非 active 时累加，
    //   selectMeeting 时清零。替代旧 Web Notification + title 闪烁，统一走 Hub 侧栏哲学。
    // 2026-05-31 道雪：unread 语义改为"本轮已答 AI 数（Set<sid>.size）" — 任一 AI 答完 +1，
    //   显示"已答 N"（1-3）；turnNum 变 / selectMeeting 时清零（详见 renderer.js partial-update handler）。
    unreadAnsweredSize: m.unreadAnswered instanceof Set ? m.unreadAnswered.size : 0,
    pinned: m.pinned,
    bottomed: m.bottomed,
    _isMeeting: true,
    _meeting: m,
  }));

  const all = regularSessions.concat(meetingItems);

  const sorted = all.sort(compareSidebarPlacement);

  // Hide any leftover legacy background PTY sessions from the removed room path.
  const everything = sorted.filter(s => !s.title || !s.title.startsWith('[Team] '));

    return everything;
  }
  sidebarSources.set(doc, () => {
    const sessionMap = getSessions();
    const items = collectSidebarItems(sessionMap);
    const parts = partitionSidebarSessions(items, { sessionMap, activeSessionId: getActiveSessionId(), activeMeetingId: getActiveMeetingId() });
    const archived = new Set(parts.archive.map(s => s.id));
    return items.map(s => ({ ...s,
      key: (s._isMeeting ? 'live-meeting:' : 'live-session:') + s.id,
      hubSessionId: s._isMeeting ? null : s.id, meetingId: s._isMeeting ? s.id : null,
      provider: s._isMeeting ? 'meeting' : String(s.kind || '').replace(/-resume$/, '').replace(/^deepseek.*$/, 'deepseek'),
      archived: archived.has(s.id), agentGroup: agentGroupOf(s),
      updatedAt: latestActivityTime(s),
      cwd: s._isMeeting ? s._meeting.workspace : s.cwd,
      projectLabel: s._isMeeting ? s._meeting.workspaceLabel : s.workspaceLabel,
    }));
  });
  function openSearch(detail) {
    if (typeof options.openSearch === 'function') return options.openSearch(detail);
    doc.dispatchEvent(new doc.defaultView.CustomEvent('sidebar:open-search', { detail }));
  }
  function filteredSidebarItems(sessionMap = getSessions()) {
    return collectSidebarItems(sessionMap).filter(item => modelFilter === 'all' || sessionFamilies(item, sessionMap).has(modelFilter));
  }
  function revealSearchItem(id, memberId = null) {
    const item = collectSidebarItems().find(entry => entry.id === id);
    if (!item) return;
    const member = memberId && item._meeting?.subSessions?.includes(memberId) ? getSessions().get(memberId) : null;
    if (modelFilter !== 'all' && !(member ? sessionFamilies(member, getSessions()) : sessionFamilies(item, getSessions())).has(modelFilter)) {
      modelFilter = 'all';
      if (modelControl) modelControl.value = modelFilter;
      savePreference('hubSidebarModelFilter', modelFilter);
    }
    if (member) {
      collapsedDetailsMeetings.delete(id);
      _expandedMeetings.add(id);
      _persistExpandedMeetings();
    }
    const parts = partitionSidebarSessions([item], { sessionMap: getSessions(), activeSessionId: getActiveSessionId(), activeMeetingId: getActiveMeetingId() });
    const key = parts.pinned.length ? 'sec-pinned' : parts.active.length ? 'sec-active' : parts.archive.length ? 'sec-dormant' : 'sec-today';
    collapsedSections.delete(key);
    savePreference('hubSidebarCollapsedSections', JSON.stringify([...collapsedSections]));
    renderSessionList();
  }
  doc.addEventListener?.('sidebar:manage-pin', event => {
    if (!collectSidebarItems().some(item => item.id === event.detail?.id && item.pinned)) return;
    openContextMenu(event.detail.id, event.detail.x, event.detail.y);
  });
  let archivingToday = false;
  async function archiveToday() {
    if (archivingToday) return;
    archivingToday = true;
    const failures = [];
    try {
      const ipc = options.ipcRenderer || require('electron').ipcRenderer;
      const current = partitionSidebarSessions(filteredSidebarItems(), { sessionMap: getSessions(), activeSessionId: getActiveSessionId(), activeMeetingId: getActiveMeetingId() });
      for (const item of current.today) {
        try {
          const members = item._isMeeting ? (item._meeting.subSessions || []) : [item.id];
          for (const id of members) {
            if (getSessions().get(id)?.status === 'dormant') continue;
            const result = await ipc.invoke('suspend-session', { sessionId: id });
            if (!result?.ok) throw new Error(result?.message || result?.error || '休眠失败');
          }
          if (item._isMeeting) {
            const updated = await ipc.invoke('update-meeting-sync', { meetingId: item.id, fields: { status: 'dormant' } });
            if (!updated) throw new Error('群聊归档状态保存失败');
          }
        } catch (error) { failures.push((item.title || item.id) + '：' + error.message); }
      }
    } catch (error) { failures.push(error.message); }
    finally { archivingToday = false; renderSessionList(); }
    if (failures.length) {
      const message = '部分会话未归档，仍保留原入口：\n' + failures.join('\n');
      console.warn('[sidebar] archive:', message);
      if (options.notify) options.notify(message);
      else doc.defaultView?.alert(message);
    }
  }

  function renderSessionList() {
    const renderStartedAt = nowMs();
    const sessionMap = getSessions();
  const visible = filteredSidebarItems(sessionMap);
  const sections = partitionSidebarSessions(visible, { sessionMap, activeSessionId: getActiveSessionId(), activeMeetingId: getActiveMeetingId() });
  // Preserve scroll position across rebuilds — without this, any re-render
  // (every status-event, silence-timer, or session-updated) snaps the list
  // back to the top, which feels like the sidebar is "fighting" the user.
  const savedScrollTop = sessionListEl.scrollTop;
  const focused = doc.activeElement;
  const focusId = focused?.dataset?.sessionId || focused?.dataset?.meetingId;
  const focusControl = focused?.dataset?.sidebarControl;
  const hadListFocus = focused && sessionListEl.contains?.(focused);
  // Build the entire status reclassification off-DOM, then commit once. A
  // running -> needs-input transition used to clear and repopulate the live
  // sidebar one node at a time, forcing repeated style/layout work and making
  // the window look frozen exactly when categories jumped.
  const fragment = typeof doc.createDocumentFragment === 'function'
    ? doc.createDocumentFragment()
    : null;
  const renderTarget = fragment || sessionListEl;
  if (!fragment) sessionListEl.innerHTML = '';

  // 单条渲染（会话/会议），供「置顶 recent + 时间组」复用。
  const detailSessionIds = new Set();
  function appendItem(s, child = false, target = renderTarget) {
    if (s._isMeeting) {
      const isActive = getActiveMeetingId() === s.id;
      const isGroupChat = !!s._meeting.groupChat;
      // Compact groups reveal members on hover/focus; detail mode has an
      // explicit collapse arrow. Legacy meeting expansion stays unchanged.
      const canExpand = !isGroupChat || detailsEnabled;
      const isExpanded = isGroupChat && detailsEnabled
        ? !collapsedDetailsMeetings.has(s.id) : canExpand && _expandedMeetings.has(s.id);
      const groupContainer = isGroupChat ? doc.createElement('div') : null;
      if (groupContainer) {
        groupContainer.className = 'sidebar-group' + (detailsEnabled ? ' detailed-group' : ' compact-group')
          + (s._meeting.subSessions?.includes(getActiveSessionId()) ? ' has-active-member' : '')
          + (hoveredMeetingId === s.id ? ' hover-open' : '');
        groupContainer.dataset.sidebarGroup = s.id;
        target.appendChild(groupContainer);
      }
      const div = doc.createElement('div');
      // 2026-07-19 道雪 · 方案C：群聊两行卡（行1 状态+标题+时间，行2 成员 mini-jump），
      //   不再渲染 badge pill（等你/休眠进 sl-state，已选数进行2 末尾）。
      const isDormantMeeting = s.status === 'dormant';
      const hasUnread = !isActive && (s.unreadAnsweredSize > 0);
      // 2026-07-20 道雪：群聊运行中 = 任一成员 agent 在运行（成员 running 已语义化）
      const meetingRuntime = _meetingRuntimeAggregate(s._meeting, sessionMap);
      const anySubRunning = meetingRuntime.running;
      const anySubWaiting = meetingRuntime.waiting;
      const anySubFailed = meetingRuntime.failed;
      const anySubDisconnected = meetingRuntime.disconnected;
      div.className = 'session-item slim meeting' + (isGroupChat ? ' gc' : '')
        + (detailsEnabled ? ' has-session-details' : '')
        + (isActive ? ' selected' : '')
        + (isExpanded ? ' expanded' : '') + (isDormantMeeting ? ' dormant' : '')
        + (hasUnread ? ' need-unread' : '');
      div.dataset.meetingId = s.id;
      div.tabIndex = 0;
      const SLOT_LABELS_M = ['一号位', '二号位', '三号位'];
      const miniSids = isGroupChat ? (s._meeting.subSessions || []) : (s._meeting.subSessions || []).slice(0, 3);
      const memberTotal = (s._meeting.subSessions || []).length;
      const memberSelected = isGroupChat
        ? (Array.isArray(s._meeting.participants) ? s._meeting.participants.length : memberTotal)
        : memberTotal;
      if (isDormantMeeting) div.title = `${s.title} · 休眠中 · ${memberSelected}/${memberTotal} 已选 · 点击打开群聊`;
      // 群聊子会话默认折叠，若只在普通 session 行画告警，Claude/DeepSeek 成员的
      // memory link 错误在最常用的群聊视图里仍然不可见。父行聚合显示，mini-jump
      // tooltip 再指出具体成员。
      const meetingWarning = miniSids.map((subId, idx) => {
        const sub = sessionMap.get(subId);
        const warning = _sessionWarningText(sub);
        if (!warning) return '';
        return `${(sub && (sub.title || sub.kind)) || `AI ${idx + 1}`}：${warning}`;
      }).filter(Boolean).join('；');
      const miniJumpsHtml = isGroupChat ? '' : miniSids.map((subId, idx) => {
        const sub = sessionMap.get(subId);
        const label = isGroupChat
          ? ((sub && (sub.title || sub.kind)) || `AI ${idx + 1}`)
          : (SLOT_LABELS_M[idx] || `Slot ${idx + 1}`);
        const avatarSrc = sub && sub.kind
          // *-resume 没有专属 svg，归一到基础 kind 头像（assets 只有 5+1 个基础 logo）
          ? `assets/ai-logos/${String(sub.kind).replace(/-resume$/, '')}.svg`
          : '';
        const modelLabel = sub && sub.currentModel ? (typeof modelShort === 'function' ? modelShort(sub.currentModel) : sub.currentModel.id) : '';
        const subRuntime = sub ? getSessionRuntimeTruth(sub) : null;
        let statusCls = 'mini-st-ready';
        if (!sub) statusCls = 'mini-st-init';
        else if (subRuntime.state === RUNTIME_DORMANT) statusCls = 'mini-st-dormant';
        else if (hasStreamDisconnectIssue(sub) || subRuntime.state === RUNTIME_FAILED) statusCls = 'mini-st-error';
        else if (subRuntime.state === RUNTIME_WAITING) statusCls = 'mini-st-waiting';
        else if (_subIsRunning(sub)) statusCls = 'mini-st-thinking';
        else if (subRuntime.state === RUNTIME_UNKNOWN) statusCls = 'mini-st-unknown';
        const isActiveChild = subId === getActiveSessionId();
        const ctxPct = isGroupChat && sub && typeof sub.contextPct === 'number' ? sub.contextPct : null;
        const ctxCls = ctxPct != null && typeof pctClass === 'function' ? pctClass(ctxPct) : '';
        const ctxLabelHtml = ctxPct != null
          ? `<span class="mini-jump-ctx ${ctxCls}" title="Context ${ctxPct}%">${ctxPct}%</span>`
          : '';
        const subWarning = _sessionWarningText(sub);
        const runtimeTip = subRuntime ? runtimeTruthSummary(subRuntime) : '尚未初始化';
        const tooltip = `${label}${modelLabel ? ' · ' + modelLabel : ''}${ctxPct != null ? ' · Ctx ' + ctxPct + '%' : ''} · ${runtimeTip}${subWarning ? ' · ⚠ ' + subWarning : ''} (点击跳转)`;
        const avatarHtml = isGroupChat
          ? `<span class="mini-jump-text">${escapeHtml(sub && sub.kind ? sub.kind : ('AI' + (idx + 1)))}</span>`
          : (avatarSrc
            ? `<img src="${avatarSrc}" alt="${escapeHtml(label)}" />`
            : `<span class="mini-jump-letter">${escapeHtml(String(idx + 1))}</span>`);
        return `<span class="mini-jump-cell">
          <button class="mini-jump-btn slot-${idx + 1}${isGroupChat ? ' group' : ''}${isActiveChild ? ' active' : ''}" data-sub-id="${subId}" title="${escapeHtml(tooltip)}">
            ${avatarHtml}
            <span class="mini-jump-status-dot ${statusCls}"></span>
          </button>${ctxLabelHtml}
        </span>`;
      }).join('');
      // 状态点优先级与普通 session 一致：等待 > 运行 > 异常 > 未读 > 休眠 > 空闲。
      const dotCls = sections.states.get(s.id) || 'idle';
      const logos = (s._meeting.subSessions || []).slice(0, 2).map(id => _aiLogoHtml(sessionMap.get(id)?.kind)).join('');
      const progress = memberTotal ? Math.min(100, s.unreadAnsweredSize / memberTotal * 100) : 0;
      div.innerHTML = [
        '<div class="sl-line1' + (canExpand ? ' with-arrow' : '') + '">',
        canExpand ? '<span class="expand-arrow" data-action="toggle-expand" title="展开成员">▸</span>' : '',
        isGroupChat ? `<svg class="sl-group-icon ${dotCls}" viewBox="0 0 24 24" aria-label="群聊"><path d="M15 11a3 3 0 1 0 0-6m2 15v-2a4 4 0 0 0-2-3.5M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3 20v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/></svg>` : _ringHtml(null, dotCls),
        '<span class="sl-title" title="' + escapeHtml([s.title, meetingWarning, '已答 ' + s.unreadAnsweredSize + '/' + memberTotal].filter(Boolean).join(' · ')) + '">' + (s.pinned ? PIN_SVG : '') + _warningHtml(meetingWarning) + escapeHtml(s.title) + '</span>',
        '<span class="sl-group-logos" aria-label="群聊">' + logos + '</span>',
        '<span class="sl-time">' + formatTime(latestActivityTime(s)) + '</span></div>',
        isGroupChat ? '' : '<div class="session-mini-jumps">' + miniJumpsHtml + '<span class="sl-members-hint">' + memberSelected + '/' + memberTotal + ' 已选</span></div>',
        isGroupChat ? '<span class="sl-group-progress" title="已答 ' + s.unreadAnsweredSize + '/' + memberTotal + '"><i style="width:' + progress + '%"></i></span>' : '',
      ].join('');
      div.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const member = e.target.closest('.mini-jump-btn[data-sub-id]');
        openContextMenu(member ? member.dataset.subId : s.id, e.clientX, e.clientY);
      });
      (groupContainer || target).appendChild(div);

      if (isGroupChat) {
        if (!detailsEnabled || isExpanded) {
          const children = doc.createElement('div');
          children.className = 'sidebar-group-children';
          groupContainer.appendChild(children);
          for (const id of s._meeting.subSessions || []) {
            const member = sessionMap.get(id);
            if (member && (modelFilter === 'all' || familyOfKind(member.kind) === modelFilter)) appendItem(member, true, children);
          }
        }
        return;
      }

      // Render child sub-sessions if expanded (clicking goes straight to shell view).
      if (isExpanded) {
        for (const subId of s._meeting.subSessions) {
          const sub = sessionMap.get(subId);
          if (!sub) continue;
          if (modelFilter !== 'all' && familyOfKind(sub.kind) !== modelFilter) continue;
          if (detailsEnabled) { appendItem(sub, true, target); continue; }
          const childDiv = doc.createElement('div');
          const isChildActive = subId === getActiveSessionId();
          const childRuntime = getSessionRuntimeTruth(sub);
          const childResumePending = sub._resumePending === true;
          const childDormantCls = childRuntime.state === RUNTIME_DORMANT ? ' dormant' : '';
          const childDisconnected = hasStreamDisconnectIssue(sub);
          const childUnreadCount = Math.max(0, Number(sub.unreadCount) || 0);
          const childShowUnread = !isChildActive && childUnreadCount > 0;
          childDiv.className = 'session-item slim child' + (isChildActive ? ' selected' : '')
            + (childShowUnread ? ' need-unread' : '') + childDormantCls
            + (childResumePending ? ' resuming' : '')
            + (childDisconnected ? ' disconnected' : '');
          childDiv.tabIndex = 0;
          childDiv.dataset.sessionId = subId;
          childDiv.dataset.runtimeState = childRuntime.state;
          const modelLabel = sub.currentModel
            ? `<span class="child-model-badge ${modelClass(sub.currentModel.id)}" title="${escapeHtml(sub.currentModel.displayName || sub.currentModel.id)}">${escapeHtml(modelShort(sub.currentModel))}</span>`
            : '';
          const childWarning = _sessionWarningText(sub);
          const childStateTip = childResumePending
            ? '正在唤醒原生 CLI 与历史上下文'
            : childRuntime.state === RUNTIME_DORMANT
            ? `${sub.suspendReason === 'idle-timeout' ? '自动休眠' : '休眠中'}${childShowUnread ? `，有 ${childUnreadCount} 条未读` : ''}，点击唤醒`
            : [runtimeTruthSummary(childRuntime), childShowUnread ? `有 ${childUnreadCount} 条未读` : ''].filter(Boolean).join(' · ');
          childDiv.innerHTML = `
            ${_aiLogoHtml(sub.kind)}
            <span class="child-title" title="${escapeHtml([childWarning, childStateTip].filter(Boolean).join(' · '))}">${childDisconnected ? '<span class="sl-disconnect-label">断连</span>' : ''}${childWarning ? '<span class="sl-pin">⚠</span>' : ''}${escapeHtml(sub.title)}${childShowUnread ? `<span class="sl-un">● ${childUnreadCount}</span>` : ''}</span>
            ${modelLabel}
          `;
          // Use the existing selectSession path: it hides meeting-room-panel,
          // shows terminal-panel, and mounts the cached xterm container.
          // This is exactly the "single-viewer strict switch" the spec calls for.
          childDiv.addEventListener('contextmenu', (ev) => { ev.preventDefault(); openContextMenu(subId, ev.clientX, ev.clientY); });
          target.appendChild(childDiv);
        }
      }
      return;
    }

    // 2026-07-19 道雪 · 方案C：普通 session 单行密排（状态点/标题/模型/ctx/时间）。
    //   badge pill（等你/模型/Ctx/burn）全部移除：等待与未读改行底色+状态点，
    //   burn 聚合到侧栏底部 strip，模型与 ctx 变等宽小字列。
    const isActive = s.id === getActiveSessionId();
    const runtimeTruth = getSessionRuntimeTruth(s, { now: Date.now() });
    const div = doc.createElement('div');
    div.tabIndex = 0;
    div.dataset.sessionId = s.id;
    div.dataset.runtimeState = runtimeTruth.state;
    div.dataset.runtimeSource = runtimeTruth.source || '';
    div.dataset.runtimeConfidence = runtimeTruth.confidence || '';
    const isDormant = runtimeTruth.state === RUNTIME_DORMANT;
    const isResumePending = s._resumePending === true;
    const isDisconnected = hasStreamDisconnectIssue(s);
    const dormantCls = isDormant ? ' dormant' : '';
    const showWaiting = runtimeTruth.state === RUNTIME_WAITING;
    const unreadCount = Math.max(0, Number(s.unreadCount) || 0);
    const showUnread = sessionHasCompletedUnread(s) && !isActive && !showWaiting;
    // 状态点优先级：等待输入 > 网络断连 > 未读 > 运行 > 休眠 > 空闲
    const dotCls = s._resumePending ? 'start' : (child
      ? partitionSidebarSessions([s], { sessionMap, activeSessionId: getActiveSessionId(), groupMemberIds: new Set([s.id]) }).states.get(s.id)
      : sections.states.get(s.id)) || 'idle';
    const showRunning = dotCls === 'run' || dotCls === 'start';
    div.className = 'session-item slim' + (isActive ? ' selected' : '')
      + (showWaiting ? ' need-wait' : '') + (showUnread ? ' need-unread' : '') + dormantCls
      + (showRunning ? ' running' : '')
      + (isResumePending ? ' resuming' : '')
      + (isDisconnected ? ' disconnected' : '');
    const ctxPct = typeof s.contextPct === 'number' ? s.contextPct : null;
    const modelTxt = s.currentModel ? modelShort(s.currentModel) : '';
    const anyWarning = _sessionWarningText(s);
    const dormantStateTip = isResumePending
      ? '正在唤醒原生 CLI 与历史上下文'
      : isDormant
      ? `${s.suspendReason === 'idle-timeout' ? '自动休眠' : '休眠中'}${showUnread ? `，有 ${unreadCount} 条未读` : ''}，点击唤醒`
      : '';
    const titleTip = [s.title,
      s.currentModel ? (s.currentModel.displayName || s.currentModel.id) : '',
      ctxPct != null ? `Ctx ${ctxPct}%` : '',
      anyWarning,
      isDisconnected ? '网络断连，点击进入后可重试' : '',
      runtimeTruthSummary(runtimeTruth),
      dormantStateTip || (showWaiting
        ? (s.waitingText || '等你输入')
        : (showUnread ? (s.replyReadyText || s.lastOutputPreview || '有完成结果尚未查看') : '')),
    ].filter(Boolean).join(' · ');
    div.title = isResumePending ? '正在唤醒会话' : runtimeTruthSummary(runtimeTruth);
    div.innerHTML = _ringHtml(ctxPct, dotCls)
      + '<span class="sl-title" title="' + escapeHtml(titleTip) + '">' + (s.pinned ? PIN_SVG : '') + _warningHtml(anyWarning) + escapeHtml(s.title) + '</span>'
      + _sessionKindHtml(s.kind, modelTxt)
      + '<span class="sl-time">' + formatTime(latestActivityTime(s)) + '</span>';
    if (child) div.className += ' child';
    if (detailsEnabled) {
      div.className += ' has-details';
      div.innerHTML = '<div class="sl-line1">' + div.innerHTML + '</div>'
        + detailsHtml(s, { escapeHtml, modelShort });
      detailSessionIds.add(s.id);
    }
    div.addEventListener('contextmenu', (e) => { e.preventDefault(); openContextMenu(s.id, e.clientX, e.clientY); });
    target.appendChild(div);
  }

  function appendSecHeader(label, items, cls, action, onAction) {
    const collapsed = collapsedSections.has(cls);
    const h = doc.createElement('div');
    h.className = 'session-sec-header ' + cls;
    h.innerHTML = '<button type="button" class="sec-collapse" data-sidebar-control="' + cls + '" aria-label="' + (collapsed ? '展开' : '折叠') + label + '" aria-expanded="' + !collapsed + '">' + (collapsed ? '▸' : '▾') + '</button><span>' + label + '</span><span class="sec-count">' + items.length + '</span><span class="sec-rule"></span>'
      + (action ? '<button type="button" class="sec-action ' + (cls === 'sec-active' ? 'sec-mark-all-read' : '') + '">' + action + '</button>' : '');
    h.addEventListener('click', event => {
      if (event.target?.closest?.('.sec-collapse') || /sec-collapse/.test(event.target?.className || '')) {
        event.preventDefault(); event.stopPropagation();
        if (collapsedSections.has(cls)) collapsedSections.delete(cls); else collapsedSections.add(cls);
        savePreference('hubSidebarCollapsedSections', JSON.stringify([...collapsedSections]));
        renderSessionList();
        return;
      }
      if (!event.target?.closest?.('.sec-action') && !/sec-action|sec-mark-all-read/.test(event.target?.className || '')) return;
      event.preventDefault(); event.stopPropagation();
      return onAction?.();
    });
    if (cls === 'sec-dormant') {
      const range = doc.createElement('select');
      range.className = 'sec-dormant-range';
      range.dataset.sidebarControl = 'dormant-range';
      range.setAttribute?.('aria-label', '休眠显示范围');
      range.innerHTML = '<option value="1">最近24小时</option><option value="3">最近3天</option><option value="7">最近7天</option>';
      range.value = String(dormantDays);
      range.addEventListener('change', () => {
        const days = Number(range.value);
        if (![1, 3, 7].includes(days)) return;
        dormantDays = days;
        savePreference('hubSidebarDormantDays', String(days));
        renderSessionList();
      });
      h.appendChild(range);
    }
    renderTarget.appendChild(h);
    if (!collapsed) for (const item of items) appendItem(item);
  }
  appendSecHeader('置顶', sections.pinned, 'sec-pinned', '管理', () => openSearch({ scope: 'pinned' }));
  appendSecHeader('活跃', sections.active, 'sec-active', markAllSessionsRead ? '全部已读' : '', markAllSessionsRead);
  appendSecHeader('今天', sections.today, 'sec-today', sections.today.length ? '归档全部' : '', archiveToday);
  appendSecHeader('休眠', sections.archive.filter(item => Date.now() - latestActivityTime(item) < dormantDays * 86400000), 'sec-dormant');
  const archive = doc.createElement('button');
  archive.type = 'button';
  archive.className = 'session-archive-entry';
  archive.innerHTML = '<span>归档</span><span class="archive-count">' + sections.archiveCount + '</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
  archive.addEventListener('click', () => openSearch({ scope: 'dormant' }));
  renderTarget.appendChild(archive);

  if (fragment) {
    if (typeof sessionListEl.replaceChildren === 'function') sessionListEl.replaceChildren(fragment);
    else {
      sessionListEl.innerHTML = '';
      sessionListEl.appendChild(fragment);
    }
  }

  renderSidebarStrip(sessionMap);

  if (afterRender) afterRender();
  if (detailsEnabled && options.requestSessionUsage) options.requestSessionUsage([...detailSessionIds]);

  sessionListEl.scrollTop = savedScrollTop;
  // Whole-list updates must preserve a stationary pointer's expanded group.
  // If sorting moved that group away, release it at its new geometry.
  if (hoverPoint && hoveredMeetingId && sessionListEl.querySelectorAll) {
    const group = [...sessionListEl.querySelectorAll('.sidebar-group')].find(el => el.dataset.sidebarGroup === hoveredMeetingId);
    const rect = group?.getBoundingClientRect();
    if (!rect || hoverPoint.x < rect.left || hoverPoint.x > rect.right || hoverPoint.y < rect.top || hoverPoint.y > rect.bottom) {
      hoveredMeetingId = null;
      group?.classList.remove('hover-open');
    }
  }
  if (hadListFocus && focusId) {
    const replacement = [...sessionListEl.querySelectorAll('.session-item')].find(row => (row.dataset.sessionId || row.dataset.meetingId) === focusId);
    replacement?.focus({ preventScroll: true });
  }
  if (hadListFocus && focusControl) {
    [...sessionListEl.querySelectorAll('[data-sidebar-control]')].find(control => control.dataset.sidebarControl === focusControl)?.focus({ preventScroll: true });
  }
  const elapsed = Math.max(0, nowMs() - renderStartedAt);
  renderStats.renders += 1;
  renderStats.lastMs = elapsed;
  renderStats.maxMs = Math.max(renderStats.maxMs, elapsed);
  if (elapsed >= 50) renderStats.slowRenders += 1;
}

// --- Session card hover light-tracking + click ripple (event delegation) ---
sessionListEl.addEventListener('mousemove', (e) => {
  const group = e.target.closest('.sidebar-group');
  hoveredMeetingId = group?.dataset.sidebarGroup || null;
  hoverPoint = { x: e.clientX, y: e.clientY };
  for (const wrapper of sessionListEl.querySelectorAll('.sidebar-group')) {
    wrapper.classList.toggle('hover-open', wrapper.dataset.sidebarGroup === hoveredMeetingId);
  }
  const item = e.target.closest('.session-item');
  if (!item) return;
  const rect = item.getBoundingClientRect();
  item.style.setProperty('--mx', ((e.clientX - rect.left) / rect.width * 100) + '%');
  item.style.setProperty('--my', ((e.clientY - rect.top) / rect.height * 100) + '%');
});
sessionListEl.addEventListener('mouseleave', () => {
  hoveredMeetingId = null;
  hoverPoint = null;
  for (const wrapper of sessionListEl.querySelectorAll('.sidebar-group')) wrapper.classList.remove('hover-open');
});
sessionListEl.addEventListener('mousedown', (e) => {
  const item = e.target.closest('.session-item');
  if (!item) return;
  const rect = item.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  const r = doc.createElement('span');
  r.className = 'ripple-fx';
  r.style.width = r.style.height = size + 'px';
  r.style.left = (e.clientX - rect.left - size / 2) + 'px';
  r.style.top = (e.clientY - rect.top - size / 2) + 'px';
  item.appendChild(r);
  setTimeout(() => r.remove(), 450);
});



  return {
    renderSessionList,
    revealSearchItem,
    renderSidebarStrip,
    getRenderStats: () => ({ ...renderStats }),
  };
}

module.exports = {
  createSessionListRenderer,
  compareLatestActivityDesc,
  compareSidebarPlacement,
  isPinnedToBottom,
  partitionSessionsByAge,
  latestActivityTime,
  familyOfKind,
  sessionFamilies,
  SESSION_FAMILY_TABS,
  AGENT_SESSION_GROUPS,
  agentGroupOf,
  partitionSidebarSessions,
  getSidebarSearchEntries,
};
