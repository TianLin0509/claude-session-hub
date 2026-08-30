// 纯函数：按最新 AI 回答时间年龄分桶。pinned 永远进 recent（置顶不折叠）。
//   recent: <24h（保持现状 UI 置顶）· mid: 24-72h · old: ≥72h
const { isGroupChatMemberRunning } = require('../core/groupchat-running-state.js');
const { compareLatestActivityDesc, latestActivityTime } = require('../core/session-recency.js');
const {
  sessionHasCompletedUnread,
} = require('../core/session-attention-state.js');
const { hasStreamDisconnectIssue } = require('../core/stream-disconnect.js');
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

function createSessionListRenderer(options = {}) {
  const doc = options.document || document;
  const storage = options.localStorage || localStorage;
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
  if (_expandedMeetings.has(meetingId)) _expandedMeetings.delete(meetingId);
  else _expandedMeetings.add(meetingId);
  _persistExpandedMeetings();
  renderSessionList();
}

// --- 按时间分组折叠状态（24-72h / 72h+ 两组，默认折叠，落盘）---
//   侧栏过长治理：24h 内保持现状置顶，更久的会话收进可展开的时间组。
const _expandedTimeGroups = (() => {
  try { const raw = storage.getItem('hubExpandedTimeGroups'); return new Set(raw ? JSON.parse(raw) : []); }
  catch { return new Set(); }
})();
function _persistExpandedTimeGroups() {
  try { storage.setItem('hubExpandedTimeGroups', JSON.stringify([..._expandedTimeGroups])); } catch {}
}
function toggleTimeGroup(key) {
  if (_expandedTimeGroups.has(key)) _expandedTimeGroups.delete(key);
  else _expandedTimeGroups.add(key);
  _persistExpandedTimeGroups();
  renderSessionList();
}
// --- 家族筛选页签（全部 / Claude / Codex / 其他），落盘，重开 Hub 保持上次选择 ---
const _familyFilter = {
  key: (() => {
    try {
      const raw = storage.getItem('hubSessionFamilyFilter');
      return SESSION_FAMILY_KEYS.includes(raw) ? raw : 'all';
    } catch { return 'all'; }
  })(),
};
let _familyTabsBound = false;
function setFamilyFilter(key) {
  const next = SESSION_FAMILY_KEYS.includes(key) ? key : 'all';
  if (next === _familyFilter.key) return;
  _familyFilter.key = next;
  try { storage.setItem('hubSessionFamilyFilter', next); } catch {}
  renderSessionList();
}
// 计数在筛选之前算，所以每个页签上的数字始终是该家族的真实总数，而不是当前
// 视图剩下的条数——否则切走之后就再也看不到别家还有几个会话。
function renderFamilyTabs(counts) {
  const tabsEl = doc.getElementById('session-filter-tabs');
  if (!tabsEl) return;
  tabsEl.innerHTML = SESSION_FAMILY_TABS.map(tab => {
    const selected = tab.key === _familyFilter.key;
    const count = counts[tab.key] || 0;
    return `<button type="button" class="session-filter-tab${selected ? ' selected' : ''}"`
      + ` data-family="${tab.key}" role="tab" aria-selected="${selected ? 'true' : 'false'}"`
      + ` title="${escapeHtml(tab.hint)}">${escapeHtml(tab.label)}`
      + `<span class="sft-count">${count}</span></button>`;
  }).join('');
  if (!_familyTabsBound) {
    // 委托绑定一次：innerHTML 每次重建按钮，挂在按钮上的监听会随之丢失。
    _familyTabsBound = true;
    tabsEl.addEventListener('click', (event) => {
      const btn = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-family]') : null;
      if (btn) setFamilyFilter(btn.dataset.family);
    });
  }
}
function _ensureTimeGroupStyle() {
  if (doc.getElementById('hub-stg-style')) return;
  const st = doc.createElement('style');
  st.id = 'hub-stg-style';
  st.textContent = [
    '.session-time-group-header{display:flex;align-items:center;gap:6px;padding:8px 12px 5px;margin-top:2px;cursor:pointer;user-select:none;font-size:11.5px;font-weight:600;letter-spacing:.02em;color:#8a8a8e;}',
    '.session-time-group-header:hover{color:#0a84ff;}',
    '.session-time-group-header .stg-arrow{display:inline-block;transition:transform .15s;font-size:9px;}',
    '.session-time-group-header.expanded .stg-arrow{transform:rotate(90deg);}',
    '.session-time-group-header .stg-label{flex:1;}',
    '.session-time-group-header .stg-count{background:rgba(128,128,128,.22);border-radius:9px;padding:1px 7px;font-size:10.5px;font-weight:500;}',
  ].join('\n');
  (doc.head || doc.documentElement).appendChild(st);
}

// AI mini logo for sidebar sub-session items. Reuses the .ai-logo + .logo-<kind>
// classes already defined in styles.css for the toolbar dropdown.
//   - 'powershell' 不是 AI kind 但侧边栏需展示 logo，在 ALL_AI_KINDS 之外单独保留。
function _aiLogoHtml(kind) {
  let k = String(kind || '').replace(/-resume$/, '');
  if (k !== 'powershell' && !isAiKind(k)) return '';
  return `<span class="ai-logo logo-${k}" aria-hidden="true"></span>`;
}

// --- 2026-07-19 道雪 · 方案4(ctx 圆环)：15px SVG，圆环弧=ctx 占用，圆心点=会话状态 ---
//   ctxPct 为 null（powershell/群聊父项）时只画空轨道 + 状态圆心；精确 % 进 title tooltip。
const _RING_C = 37.7; // 2πr (r=6)
function _ringHtml(ctxPct, dotCls) {
  const arc = (typeof ctxPct === 'number')
    ? `<circle cx="8" cy="8" r="6" class="sl-ring-arc ${pctClass(ctxPct)}" stroke-dasharray="${(Math.min(100, Math.max(0, ctxPct)) / 100 * _RING_C).toFixed(1)} ${_RING_C}" transform="rotate(-90 8 8)"/>`
    : '';
  return `<svg class="sl-ring" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" class="sl-ring-track"/>${arc}<circle cx="8" cy="8" r="2.2" class="sl-ring-dot ${dotCls}"/></svg>`;
}

// 2026-07-20 道雪：群聊运行中判定 = 任一成员 agent 在运行。
//   行1 状态点/状态词与「运行中」分区共用这一个口径。
// 2026-07-21 道雪 [修状态灯]：运行源 = sub.status==='running'（语义化 running）
//   或 gcWorking（dispatcher watcher 生命周期）——任一成员任一命中即算群聊运行中。
// 2026-08-01 [修群聊假空闲]：AI 思考/输出的静默间隙里 PTY/hook 可能短暂 idle，
//   不能压过 dispatcher 每 1.5 秒送来的 watcher 心跳；但过期 gcWorking 也不能让
//   Ctrl+C 后继续亮灯。统一用“running 或 8 秒内新鲜 watcher”判断。
function _subIsRunning(sub) {
  return isGroupChatMemberRunning(sub);
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

    // 活跃 = 仍有实时 PTY/AI 进程的会话。休眠历史不占进程，不计入；隐藏的群聊子会话
    // 和投研 PTY 仍会占资源，因此必须计入。
    const activeCount = Array.from(sessionMap.values())
      .filter(session => session && session.status !== 'dormant').length;
    const usage = getResourceUsage() || {};
    const cpuPct = Number.isFinite(usage.cpuPct) ? Math.round(usage.cpuPct) : null;
    const memoryPct = Number.isFinite(usage.memoryPct) ? Math.round(usage.memoryPct) : null;
    const metricClass = value => value != null && value >= 85 ? ' strip-resource-high' : '';
    const proxy = typeof getProxyInfo === 'function' ? getProxyInfo() : null;
    const proxyShort = _shortProxy(proxy && proxy.proxy);
    const egress = proxy && proxy.egress;
    const foreign = egress && egress.foreign;
    const domestic = egress && egress.domestic;
    const alert = egress && egress.alert;

    const routeValue = (route, loadingText) => {
      if (!egress) return loadingText;
      if (!route || !route.ok) return escapeHtml(route && route.error || '检测失败');
      return `${escapeHtml(route.locationLabel || '未知地区')} <i>·</i> ${escapeHtml(route.ip || '--')}`;
    };
    const foreignAlertClass = alert ? ` strip-route-${alert.severity === 'critical' ? 'critical' : 'warning'}` : '';
    const domesticAlertClass = egress && (!domestic || !domestic.ok) ? ' strip-route-warning' : '';
    const foreignBadge = alert
      ? `<span class="strip-route-badge">${alert.severity === 'critical' ? '⛔ VPN' : (alert.type === 'vpn_probe_retrying' ? '↻ 复核' : '⚠ 变更')}</span>`
      : '';
    const ackAttr = alert && alert.acknowledgeable ? ' data-egress-ack="true"' : '';
    const foreignTitle = [
      'Claude / Codex 订阅、Gemini：强制经 VPN 代理',
      proxyShort ? `本地代理：${proxyShort}` : '本地代理：未配置',
      foreign && foreign.ok ? `实测公网 IPv4：${foreign.ip} (${foreign.locationLabel || '未知地区'})` : `状态：${foreign && foreign.error || '检测中'}`,
      alert ? `${alert.title || '节点异常'}：${alert.message || ''}` : '',
      alert && alert.acknowledgeable ? '点击此行确认当前节点' : '',
    ].filter(Boolean).join('\n');
    const domesticTitle = [
      'Kimi / DeepSeek：清空 HTTP(S)_PROXY 后直连',
      domestic && domestic.ok ? `实测公网 IPv4：${domestic.ip} (${domestic.locationLabel || '未知地区'})` : `状态：${domestic && domestic.error || '检测中'}`,
    ].join('\n');

    stripEl.innerHTML =
      `<div class="strip-route-row strip-route-foreign${foreignAlertClass}" title="${escapeHtml(foreignTitle)}"${ackAttr}>` +
        `<span class="strip-route-main strip-proxy"><b class="strip-route-label">国外</b><span class="strip-route-value">${routeValue(foreign, '检测中…')}</span></span>` +
        (foreignBadge || `<span class="strip-compact-metric strip-active"><b>${activeCount}</b> 活跃</span>`) +
      '</div>' +
      `<div class="strip-route-row strip-route-domestic${domesticAlertClass}" title="${escapeHtml(domesticTitle)}">` +
        `<span class="strip-route-main"><b class="strip-route-label">国产</b><span class="strip-route-value">${routeValue(domestic, '检测中…')}</span></span>` +
        `<span class="strip-compact-metric strip-resource${metricClass(cpuPct)}${metricClass(memoryPct)}">CPU <b>${cpuPct == null ? '--' : cpuPct + '%'}</b> · M <b>${memoryPct == null ? '--' : memoryPct + '%'}</b></span>` +
      '</div>';
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
      if (intent.type === 'toggle-meeting') {
        toggleMeetingExpand(intent.id);
        return true;
      }
      const action = intent.type === 'meeting'
        ? selectMeeting(intent.id, { forceScrollBottom: true })
        : selectSession(intent.id, { forceScrollBottom: true });
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

// --- Session list rendering ---
// Sort: pinned sessions first, then ordinary/group sessions by latest AI reply.
// Tree shape: meeting entries optionally expand to show their child sub-sessions.
// Top-level regular sessions (no meetingId) sit alongside meetings in the same sort order.
  function renderSessionList() {
    const renderStartedAt = nowMs();
    const sessionMap = getSessions();
    const regularSessions = Array.from(sessionMap.values())
    .filter(s => !s.meetingId && s.kind !== 'chuxin-run' && !s.hiddenFromSidebar && s.purpose !== 'chuxin-research');

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
    _isMeeting: true,
    _meeting: m,
  }));

  const all = regularSessions.concat(meetingItems);

  const sorted = all.sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return compareLatestActivityDesc(a, b);
  });

  // Hide any leftover legacy background PTY sessions from the removed room path.
  const everything = sorted.filter(s => !s.title || !s.title.startsWith('[Team] '));

  const familyCounts = { all: everything.length, claude: 0, codex: 0, other: 0 };
  for (const s of everything) {
    for (const family of sessionFamilies(s, sessionMap)) {
      familyCounts[family] = (familyCounts[family] || 0) + 1;
    }
  }
  renderFamilyTabs(familyCounts);
  const visible = _familyFilter.key === 'all'
    ? everything
    : everything.filter(s => sessionFamilies(s, sessionMap).has(_familyFilter.key));

  // Preserve scroll position across rebuilds — without this, any re-render
  // (every status-event, silence-timer, or session-updated) snaps the list
  // back to the top, which feels like the sidebar is "fighting" the user.
  const savedScrollTop = sessionListEl.scrollTop;
  // Build the entire status reclassification off-DOM, then commit once. A
  // running -> needs-input transition used to clear and repopulate the live
  // sidebar one node at a time, forcing repeated style/layout work and making
  // the window look frozen exactly when categories jumped.
  const fragment = typeof doc.createDocumentFragment === 'function'
    ? doc.createDocumentFragment()
    : null;
  const renderTarget = fragment || sessionListEl;
  if (!fragment) sessionListEl.innerHTML = '';
  _ensureTimeGroupStyle();

  // 单条渲染（会话/会议），供「置顶 recent + 时间组」复用。
  function appendItem(s) {
    if (s._isMeeting) {
      const isActive = getActiveMeetingId() === s.id;
      const isGroupChat = !!s._meeting.groupChat;
      // 2026-07-20 道雪：群聊不再提供展开按钮（行2 mini-jump 已覆盖子会话跳转）；
      //   老式 🎯 meeting 保留展开。canExpand 同时决定箭头渲染与子行挂载。
      const canExpand = !isGroupChat;
      const isExpanded = canExpand && _expandedMeetings.has(s.id);
      const div = doc.createElement('div');
      // 2026-07-19 道雪 · 方案C：群聊两行卡（行1 状态+标题+时间，行2 成员 mini-jump），
      //   不再渲染 badge pill（等你/休眠进 sl-state，已选数进行2 末尾）。
      const isDormantMeeting = s.status === 'dormant';
      const hasUnread = !isDormantMeeting && !isActive && (s.unreadAnsweredSize > 0);
      // 2026-07-20 道雪：群聊运行中 = 任一成员 agent 在运行（成员 running 已语义化）
      const meetingRuntime = _meetingRuntimeAggregate(s._meeting, sessionMap);
      const anySubRunning = meetingRuntime.running;
      const anySubWaiting = meetingRuntime.waiting;
      const anySubFailed = meetingRuntime.failed;
      const anySubDisconnected = meetingRuntime.disconnected;
      div.className = 'session-item slim meeting' + (isGroupChat ? ' gc' : '')
        + (isActive ? ' selected' : '')
        + (isExpanded ? ' expanded' : '') + (isDormantMeeting ? ' dormant' : '')
        + (hasUnread ? ' need-unread' : '');
      div.dataset.meetingId = s.id;
      const SLOT_LABELS_M = ['一号位', '二号位', '三号位'];
      const miniSids = isGroupChat ? (s._meeting.subSessions || []) : (s._meeting.subSessions || []).slice(0, 3);
      const memberTotal = (s._meeting.subSessions || []).length;
      const memberSelected = isGroupChat
        ? (Array.isArray(s._meeting.participants) ? s._meeting.participants.length : memberTotal)
        : memberTotal;
      // 群聊子会话默认折叠，若只在普通 session 行画告警，Claude/DeepSeek 成员的
      // memory link 错误在最常用的群聊视图里仍然不可见。父行聚合显示，mini-jump
      // tooltip 再指出具体成员。
      const meetingWarning = miniSids.map((subId, idx) => {
        const sub = sessionMap.get(subId);
        const warning = _sessionWarningText(sub);
        if (!warning) return '';
        return `${(sub && (sub.title || sub.kind)) || `AI ${idx + 1}`}：${warning}`;
      }).filter(Boolean).join('；');
      const miniJumpsHtml = miniSids.map((subId, idx) => {
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
      let dotCls = 'idle';
      if (isDormantMeeting) dotCls = 'dorm';
      else if (anySubWaiting) dotCls = 'wait';
      else if (anySubDisconnected) dotCls = 'error';
      else if (anySubRunning) dotCls = 'run';
      else if (anySubFailed) dotCls = 'error';
      else if (hasUnread) dotCls = 'unread';
      let stateHtml = '<span></span>';
      if (isDormantMeeting) stateHtml = '<span class="sl-state dorm" title="休眠中，点击唤醒">休眠</span>';
      else if (anySubWaiting) stateHtml = '<span class="sl-state wait">等你</span>';
      else if (anySubDisconnected) stateHtml = '<span class="sl-state error">断连</span>';
      else if (anySubRunning) stateHtml = '<span class="sl-state run">运行中</span>';
      else if (anySubFailed) stateHtml = '<span class="sl-state error">异常</span>';
      else if (hasUnread) {
        stateHtml = `<span class="sl-state unread" title="本轮已有 ${s.unreadAnsweredSize} 个 AI 答完，尚未查看">已答 ${s.unreadAnsweredSize}</span>`;
      }
      div.innerHTML = `
        <div class="sl-line1${canExpand ? ' with-arrow' : ''}">
          ${canExpand ? `<span class="expand-arrow" data-action="toggle-expand" title="${isExpanded ? '折叠' : '展开'}">▶</span>` : ''}
          ${_ringHtml(null, dotCls)}
          <span class="sl-title" title="${escapeHtml([s.title, meetingWarning].filter(Boolean).join(' · '))}">${s.pinned ? '<span class="sl-pin">📌</span>' : ''}${meetingWarning ? `<span class="sl-pin" title="${escapeHtml(meetingWarning)}">⚠</span>` : ''}${isGroupChat ? '💬' : '🎯'} ${escapeHtml(s.title)}</span>
          ${stateHtml}
          <span class="sl-time">${formatTime(latestActivityTime(s))}</span>
        </div>
        <div class="session-mini-jumps">${miniJumpsHtml}<span class="sl-members-hint">${memberSelected}/${memberTotal} 已选</span></div>
      `;
      div.addEventListener('contextmenu', (e) => { e.preventDefault(); openContextMenu(s.id, e.clientX, e.clientY); });
      renderTarget.appendChild(div);

      // Render child sub-sessions if expanded (clicking goes straight to shell view).
      if (isExpanded) {
        for (const subId of s._meeting.subSessions) {
          const sub = sessionMap.get(subId);
          if (!sub) continue;
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
          renderTarget.appendChild(childDiv);
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
    let dotCls = 'idle';
    if (isResumePending) dotCls = 'start';
    else if (showWaiting) dotCls = 'wait';
    else if (isDisconnected) dotCls = 'error';
    else if (showUnread) dotCls = 'unread';
    else if (isDormant) dotCls = 'dorm';
    else if (runtimeTruth.state === RUNTIME_FAILED) dotCls = 'error';
    else if (runtimeTruth.state === RUNTIME_STARTING) dotCls = 'start';
    else if (runtimeTruth.state === RUNTIME_RUNNING) dotCls = 'run';
    else if (runtimeTruth.state === RUNTIME_UNKNOWN) dotCls = 'unknown';
    div.className = 'session-item slim' + (isActive ? ' selected' : '')
      + (showWaiting ? ' need-wait' : '') + (showUnread ? ' need-unread' : '') + dormantCls
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
    div.innerHTML = `
      ${_ringHtml(ctxPct, dotCls)}
      <span class="sl-title" title="${escapeHtml(titleTip)}">${s.pinned ? '<span class="sl-pin" title="Pinned">📌</span>' : ''}${anyWarning ? `<span class="sl-pin" title="${escapeHtml(anyWarning)}">⚠</span>` : ''}${escapeHtml(s.title)}${showUnread ? `<span class="sl-un">● ${unreadCount}</span>` : ''}</span>
      <span class="sl-model">${escapeHtml(modelTxt)}</span>
      <span class="sl-time${isDisconnected ? ' disconnected-time' : (isDormant ? ' dormant-time' : '')}">${isResumePending ? '唤醒中…' : `${isDisconnected ? '断连 · ' : (isDormant ? '休眠 · ' : '')}${formatTime(latestActivityTime(s))}`}</span>
    `;
    div.addEventListener('contextmenu', (e) => { e.preventDefault(); openContextMenu(s.id, e.clientX, e.clientY); });
    renderTarget.appendChild(div);
  }

  // 分区语义严格拆开：真正需要输入 → 运行中 → 普通完成未读 → 最近。
  //   分类语义（与状态来源逐项核对过）：
  //     等你响应 = 非 active 且 CLI 明确在等待用户输入
  //     运行中   = RuntimeTruth starting/running（原生事件 + PTY 强校验 + 兜底）
  //     完成未读 = 普通回答完成、群聊成员答完或历史 unreadCount>0
  //     最近     = 24h 内其余（含 active、休眠、空闲）
  const { recent, mid, old } = partitionSessionsByAge(visible, Date.now());
  const activeSid = getActiveSessionId();
  const activeMid = getActiveMeetingId();
  const isActiveItem = (s) => s._isMeeting ? s.id === activeMid : s.id === activeSid;
  function needsRespond(s) {
    if (isActiveItem(s)) return false;
    if (s._isMeeting) return _meetingRuntimeAggregate(s._meeting, sessionMap).waiting;
    return getSessionRuntimeTruth(s).state === RUNTIME_WAITING;
  }
  function isCompletedUnread(s) {
    if (isActiveItem(s)) return false;
    if (s._isMeeting) return (s.unreadAnsweredSize || 0) > 0;
    return sessionHasCompletedUnread(s);
  }
  const respond = [], running = [], failed = [], completed = [], rest = [];
  for (const s of recent) {
    if (needsRespond(s)) respond.push(s);
    else if (s._isMeeting ? _meetingAnySubRunning(s._meeting, sessionMap) : sessionRuntimeIsActive(s)) running.push(s);
    else if (s._isMeeting
      ? _meetingRuntimeAggregate(s._meeting, sessionMap).failed
      : (getSessionRuntimeTruth(s).state === RUNTIME_FAILED || hasStreamDisconnectIssue(s))) failed.push(s);
    else if (isCompletedUnread(s)) completed.push(s);
    else rest.push(s);
  }
  function appendSecHeader(label, count, cls) {
    const h = doc.createElement('div');
    h.className = 'session-sec-header' + (cls ? ' ' + cls : '');
    h.innerHTML = `<span>${escapeHtml(label)}</span><span class="sec-count">${count}</span>`;
    renderTarget.appendChild(h);
  }
  if (respond.length) { appendSecHeader('⚠ 等你响应', respond.length, 'sec-respond'); for (const s of respond) appendItem(s); }
  if (running.length) { appendSecHeader('运行中', running.length); for (const s of running) appendItem(s); }
  if (failed.length) { appendSecHeader('⚠ 运行异常', failed.length, 'sec-respond'); for (const s of failed) appendItem(s); }
  if (completed.length) { appendSecHeader('✓ 已完成未读', completed.length, 'sec-completed'); for (const s of completed) appendItem(s); }
  if (rest.length) {
    if (respond.length || running.length || completed.length) appendSecHeader('最近', rest.length);
    for (const s of rest) appendItem(s);
  }
  function appendTimeGroup(key, label, items) {
    if (!items.length) return;
    // active 所在组自动展开，避免当前会话被折叠藏起；其余按落盘状态（默认折叠）。
    const expanded = _expandedTimeGroups.has(key) || items.some(isActiveItem);
    const header = doc.createElement('div');
    header.className = 'session-time-group-header' + (expanded ? ' expanded' : '');
    header.dataset.timeGroup = key;
    header.innerHTML = `<span class="stg-arrow">▶</span><span class="stg-label">${escapeHtml(label)}</span><span class="stg-count">${items.length}</span>`;
    header.addEventListener('click', () => toggleTimeGroup(key));
    renderTarget.appendChild(header);
    if (expanded) for (const s of items) appendItem(s);
  }
  appendTimeGroup('mid', '3 天内', mid);
  appendTimeGroup('old', '更早', old);

  // 筛掉一个空视图时说清楚是筛选的结果，否则看起来像会话丢了。
  if (!visible.length && everything.length) {
    const hint = doc.createElement('div');
    hint.className = 'session-filter-empty';
    const label = (SESSION_FAMILY_TABS.find(t => t.key === _familyFilter.key) || {}).label || '';
    hint.textContent = `没有 ${label} 会话（共 ${everything.length} 个，点「全部」查看）`;
    renderTarget.appendChild(hint);
  }

  if (fragment) {
    if (typeof sessionListEl.replaceChildren === 'function') sessionListEl.replaceChildren(fragment);
    else {
      sessionListEl.innerHTML = '';
      sessionListEl.appendChild(fragment);
    }
  }

  renderSidebarStrip(sessionMap);

  if (afterRender) afterRender();

  sessionListEl.scrollTop = savedScrollTop;
  const elapsed = Math.max(0, nowMs() - renderStartedAt);
  renderStats.renders += 1;
  renderStats.lastMs = elapsed;
  renderStats.maxMs = Math.max(renderStats.maxMs, elapsed);
  if (elapsed >= 50) renderStats.slowRenders += 1;
}

// --- Session card hover light-tracking + click ripple (event delegation) ---
sessionListEl.addEventListener('mousemove', (e) => {
  const item = e.target.closest('.session-item');
  if (!item) return;
  const rect = item.getBoundingClientRect();
  item.style.setProperty('--mx', ((e.clientX - rect.left) / rect.width * 100) + '%');
  item.style.setProperty('--my', ((e.clientY - rect.top) / rect.height * 100) + '%');
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
    renderSidebarStrip,
    setFamilyFilter,
    getFamilyFilter: () => _familyFilter.key,
    getRenderStats: () => ({ ...renderStats }),
  };
}

module.exports = {
  createSessionListRenderer,
  compareLatestActivityDesc,
  partitionSessionsByAge,
  latestActivityTime,
  familyOfKind,
  sessionFamilies,
  SESSION_FAMILY_TABS,
};
