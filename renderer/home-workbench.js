'use strict';

const path = require('path');
const { isGroupChatMemberRunning } = require('../core/groupchat-running-state.js');
const { supportsForkSession } = require('../core/session-capabilities.js');
const {
  sessionHasCompletedUnread,
  sessionNeedsUserInput,
} = require('../core/session-attention-state.js');
const { collectPathCandidates } = require('./path-candidates.js');

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const LONG_TASK_MS = 10 * 60 * 1000;
const STALLED_TASK_MS = 15 * 60 * 1000;
const STALE_OUTPUT_MS = 5 * 60 * 1000;
const CONTEXT_WARNING_PCT = 70;
const CONTEXT_CRITICAL_PCT = 90;
const MAX_INSIGHT_ITEMS = 6;
const MAX_ARTIFACT_ITEMS = 6;

const PROVIDER_LABELS = {
  claude: 'CLAUDE',
  codex: 'CODEX',
  gemini: 'GEMINI',
  deepseek: 'DEEPSEEK',
  kimi: 'KIMI',
  powershell: 'SHELL',
  group: '群聊',
};

function finiteNumber(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function baseKind(kind) {
  const value = String(kind || '').replace(/-(?:resume|api)$/i, '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(PROVIDER_LABELS, value) ? value : 'group';
}

function numberFromUnreadAnswered(value) {
  if (value instanceof Set) return value.size;
  if (Array.isArray(value)) return value.length;
  if (Number.isFinite(value)) return Math.max(0, Number(value));
  return 0;
}

function itemTime(item) {
  return Number(item.lastMessageTime || item.updatedAt || item.createdAt || 0);
}

function runStartedAtOf(session) {
  return finiteNumber(session && (session.runStartedAt || session.cardWorkingSince)) || 0;
}

function makeSessionItem(session, now = Date.now()) {
  const unreadCount = Math.max(0, Number(session.unreadCount || 0));
  const kind = baseKind(session.kind);
  const running = session.status === 'running' || isGroupChatMemberRunning(session);
  const runStartedAt = running ? runStartedAtOf(session) : 0;
  const lastActivityAt = Math.max(itemTime(session), finiteNumber(session._lastOutputTs) || 0);
  const elapsedMs = running && runStartedAt > 0 ? Math.max(0, now - runStartedAt) : null;
  const contextPct = finiteNumber(session.contextPct);
  return {
    id: String(session.id || session.hubId || ''),
    type: 'session',
    title: String(session.title || PROVIDER_LABELS[kind] || 'Session'),
    kind,
    providerLabel: PROVIDER_LABELS[kind] || 'AI',
    preview: String(session.waitingText || session.replyReadyText || session.lastOutputPreview || session.workspaceLabel || session.cwd || ''),
    cwd: typeof session.cwd === 'string' ? session.cwd : '',
    lastMessageTime: itemTime(session),
    lastActivityAt,
    lastCompletedAt: finiteNumber(session.lastCompletedAt) || 0,
    lastRunDurationMs: finiteNumber(session.lastRunDurationMs),
    runStartedAt,
    elapsedMs,
    longRunning: elapsedMs != null && elapsedMs >= LONG_TASK_MS,
    status: session.status || 'idle',
    errorText: String(session.lastError || session.error || session.spawnError || ''),
    running,
    waiting: sessionNeedsUserInput(session),
    completedUnread: sessionHasCompletedUnread(session),
    unreadCount,
    contextPct,
    supportsFork: supportsForkSession(session),
    dormant: session.status === 'dormant',
  };
}

function makeMeetingItem(meeting, sessionMap, now = Date.now()) {
  const childIds = Array.isArray(meeting.subSessions) ? meeting.subSessions : [];
  const activeChildren = childIds
    .map(id => sessionMap.get(id))
    .filter(child => child && child.status !== 'dormant');
  const running = meeting.status === 'running'
    || activeChildren.some(child => isGroupChatMemberRunning(child));
  const answered = numberFromUnreadAnswered(meeting.unreadAnswered);
  const unreadCount = Math.max(answered, Number(meeting.unreadCount || 0));
  const runStarts = activeChildren
    .filter(child => isGroupChatMemberRunning(child))
    .map(runStartedAtOf)
    .filter(Boolean);
  const runStartedAt = finiteNumber(meeting.runStartedAt)
    || (runStarts.length ? Math.min(...runStarts) : 0);
  const elapsedMs = running && runStartedAt > 0 ? Math.max(0, now - runStartedAt) : null;
  return {
    id: String(meeting.id || ''),
    type: 'meeting',
    title: String(meeting.title || 'AI 群聊'),
    kind: 'group',
    providerLabel: '群聊',
    preview: String(meeting.lastOutputPreview || `${childIds.length} 位 AI 成员`),
    lastMessageTime: itemTime(meeting),
    lastActivityAt: Math.max(itemTime(meeting), ...activeChildren.map(itemTime), 0),
    lastCompletedAt: finiteNumber(meeting.lastCompletedAt) || 0,
    lastRunDurationMs: finiteNumber(meeting.lastRunDurationMs),
    runStartedAt,
    elapsedMs,
    longRunning: elapsedMs != null && elapsedMs >= LONG_TASK_MS,
    status: meeting.status || 'idle',
    errorText: String(meeting.lastError || meeting.error || ''),
    running,
    waiting: false,
    completedUnread: unreadCount > 0,
    unreadCount,
    contextPct: null,
    supportsFork: false,
    dormant: meeting.status === 'dormant',
  };
}

function buildNightWindow(now = Date.now()) {
  const current = new Date(now);
  const hour = current.getHours();
  const start = new Date(current);
  const end = new Date(current);
  let label;

  if (hour >= 20) {
    start.setHours(20, 0, 0, 0);
    label = '今晚 20:00 至现在';
  } else {
    start.setDate(start.getDate() - 1);
    start.setHours(20, 0, 0, 0);
    if (hour < 8) {
      label = '昨晚 20:00 至现在';
    } else {
      end.setHours(8, 0, 0, 0);
      label = '昨晚 20:00 至今早 08:00';
    }
  }

  return {
    start: start.getTime(),
    end: hour >= 20 || hour < 8 ? now : end.getTime(),
    label,
  };
}

function buildNightSummary(items, now = Date.now()) {
  const window = buildNightWindow(now);
  const inWindow = timestamp => timestamp >= window.start && timestamp <= window.end;
  const failedStatus = item => /^(?:error|failed|crashed|exited)$/i.test(item.status);
  const completedItems = items
    // A completed session may already have been auto-suspended by morning.
    // Dormancy is a resource state, not evidence that its overnight result
    // should disappear from the digest.
    .filter(item => !item.running && !item.waiting && !failedStatus(item))
    .map(item => ({
      ...item,
      completionAt: item.lastCompletedAt || (item.completedUnread ? item.lastMessageTime : 0),
    }))
    .filter(item => item.completionAt > 0 && inWindow(item.completionAt))
    .sort((a, b) => b.completionAt - a.completionAt);
  const failedItems = items.filter(item => failedStatus(item) && inWindow(item.lastMessageTime));
  const waitingItems = items.filter(item => item.waiting && inWindow(item.lastMessageTime));
  return {
    ...window,
    completed: completedItems.length,
    failed: failedItems.length,
    waiting: waitingItems.length,
    totalDurationMs: completedItems.reduce((total, item) => total + Math.max(0, item.lastRunDurationMs || 0), 0),
    items: completedItems.slice(0, 4),
  };
}

function deriveRecentArtifacts(sessionMap, options = {}) {
  const now = finiteNumber(options.now) || Date.now();
  const pathExists = typeof options.pathExists === 'function' ? options.pathExists : () => true;
  const candidates = [];
  const sessions = Array.from(sessionMap.values())
    // Keep recent outputs visible after automatic session suspension.
    .filter(session => session && session.purpose !== 'chuxin-research')
    .sort((a, b) => itemTime(b) - itemTime(a))
    .slice(0, 30);

  for (const session of sessions) {
    const sessionId = String(session.id || session.hubId || '');
    const kind = baseKind(session.kind);
    const stored = Array.isArray(session.recentArtifacts) ? session.recentArtifacts : [];
    for (const artifact of stored.slice(-8)) {
      if (!artifact || typeof artifact.path !== 'string') continue;
      candidates.push({
        path: artifact.path,
        timestamp: finiteNumber(artifact.timestamp || artifact.ts) || itemTime(session) || now,
        sessionId,
        sessionTitle: String(session.title || PROVIDER_LABELS[kind] || 'Session'),
        kind,
      });
    }

    // Backward-compatible seed for sessions created before recentArtifacts was
    // persisted. Only inspect short sidebar previews; never scan transcripts.
    const preview = String(session.replyReadyText || session.lastOutputPreview || '');
    for (const match of collectPathCandidates(preview, session.cwd || null, { includeDirectories: false })) {
      if (match.isUrl) continue;
      candidates.push({
        path: match.openPath,
        timestamp: finiteNumber(session.lastCompletedAt) || itemTime(session) || now,
        sessionId,
        sessionTitle: String(session.title || PROVIDER_LABELS[kind] || 'Session'),
        kind,
      });
    }
  }

  const seen = new Set();
  return candidates
    .sort((a, b) => b.timestamp - a.timestamp)
    // Runtime defers existence validation to the asynchronous open action.
    // Tests may inject pathExists, but Home never statSyncs a stale network
    // path during render (a previous source of visible UI stalls).
    .slice(0, 24)
    .filter(artifact => {
      if (!artifact.path || !path.extname(artifact.path)) return false;
      let key;
      try { key = path.resolve(artifact.path).toLowerCase(); } catch { key = artifact.path.toLowerCase(); }
      if (seen.has(key) || !pathExists(artifact.path)) return false;
      seen.add(key);
      artifact.name = path.basename(artifact.path);
      return true;
    })
    .slice(0, MAX_ARTIFACT_ITEMS);
}

function buildExceptions(items, options = {}) {
  const now = finiteNumber(options.now) || Date.now();
  const resourceUsage = options.resourceUsage || {};
  const hubConfig = options.hubConfig || {};
  const usageSnapshot = options.usageSnapshot || {};
  const refreshError = String(options.refreshError || '');
  const exceptions = [];
  const seen = new Set();
  const add = (entry) => {
    if (!entry || !entry.id || seen.has(entry.id)) return;
    seen.add(entry.id);
    exceptions.push(entry);
  };

  for (const item of items) {
    if (item.dormant) continue;
    if (/^(?:error|failed|crashed|exited)$/i.test(item.status) || item.errorText) {
      add({
        id: `session-error:${item.id}`,
        severity: 'critical',
        title: `${item.title} 执行异常`,
        detail: item.errorText || `状态：${item.status}`,
        type: item.type,
        targetId: item.id,
        timestamp: item.lastMessageTime,
      });
      continue;
    }
    if (item.running && item.elapsedMs >= STALLED_TASK_MS
        && now - item.lastActivityAt >= STALE_OUTPUT_MS) {
      add({
        id: `session-stalled:${item.id}`,
        severity: 'warning',
        title: `${item.title} 可能卡住`,
        detail: `已运行 ${formatDurationShort(item.elapsedMs)}，${formatDurationShort(now - item.lastActivityAt)}没有新输出`,
        type: item.type,
        targetId: item.id,
        timestamp: item.lastActivityAt,
      });
    }
    if (item.contextPct != null && item.contextPct >= CONTEXT_CRITICAL_PCT) {
      add({
        id: `session-context:${item.id}`,
        severity: 'warning',
        title: `${item.title} 上下文临界`,
        detail: `已使用 ${Math.round(item.contextPct)}%，建议复制近 3 轮后开分支`,
        type: item.type,
        targetId: item.id,
        timestamp: item.lastMessageTime,
      });
    }
  }

  const egressAlert = hubConfig.egress && hubConfig.egress.alert;
  if (egressAlert) {
    add({
      id: `system-egress:${egressAlert.type || 'alert'}`,
      severity: egressAlert.severity === 'critical' ? 'critical' : 'warning',
      title: egressAlert.title || '网络出口异常',
      detail: egressAlert.message || '请检查当前代理出口',
      type: 'system',
      action: 'refresh',
      timestamp: finiteNumber(hubConfig.egress.checkedAt) || now,
    });
  }

  const cpu = finiteNumber(resourceUsage.cpuPct);
  const memory = finiteNumber(resourceUsage.memoryPct);
  if ((cpu != null && cpu >= 90) || (memory != null && memory >= 90)) {
    add({
      id: 'system-resource-pressure',
      severity: 'warning',
      title: '本机负载过高',
      detail: `CPU ${cpu == null ? '--' : `${Math.round(cpu)}%`} · 内存 ${memory == null ? '--' : `${Math.round(memory)}%`}`,
      type: 'system',
      action: 'refresh',
      timestamp: now,
    });
  }

  for (const provider of ['claude', 'codex', 'kimi']) {
    const pct = finiteNumber(usageSnapshot[provider] && usageSnapshot[provider].usage5h && usageSnapshot[provider].usage5h.pct);
    if (pct != null && pct >= 95) {
      add({
        id: `quota:${provider}`,
        severity: 'warning',
        title: `${PROVIDER_LABELS[provider]} 5h 配额接近耗尽`,
        detail: `当前已使用 ${Math.round(pct)}%`,
        type: 'system',
        action: 'refresh',
        timestamp: now,
      });
    }
  }

  const deepseek = usageSnapshot.deepseek;
  const deepseekBalance = finiteNumber(deepseek && deepseek.totalBalance);
  if (hubConfig.deepseekApiKeySet === true && deepseek && deepseek.available === false) {
    add({
      id: 'quota:deepseek-unavailable',
      severity: 'critical',
      title: 'DEEPSEEK API 余额不可用',
      detail: '官方余额接口返回账号不可用',
      type: 'system',
      action: 'refresh',
      timestamp: finiteNumber(deepseek.observedAt) || now,
    });
  } else if (deepseekBalance != null && deepseekBalance < 10) {
    add({
      id: 'quota:deepseek-low',
      severity: 'warning',
      title: 'DEEPSEEK 余额偏低',
      detail: `当前余额 ¥${deepseekBalance.toFixed(2)}`,
      type: 'system',
      action: 'refresh',
      timestamp: finiteNumber(deepseek.observedAt) || now,
    });
  }

  const lastDelivery = hubConfig.notificationHealth && hubConfig.notificationHealth.lastDelivery;
  const deliveryAt = finiteNumber(lastDelivery && lastDelivery.timestamp);
  if (lastDelivery && lastDelivery.status === 'failed' && deliveryAt && now - deliveryAt <= RECENT_WINDOW_MS) {
    add({
      id: 'notification:last-failed',
      severity: 'warning',
      title: '微信通知最近发送失败',
      detail: `错误：${lastDelivery.errorCode || 'unknown_error'} · 可点击刷新后重试任务`,
      type: 'system',
      action: 'refresh',
      timestamp: deliveryAt,
    });
  }

  if (refreshError) {
    add({
      id: 'system:refresh-failed',
      severity: 'warning',
      title: '工作台部分状态刷新失败',
      detail: refreshError,
      type: 'system',
      action: 'refresh',
      timestamp: now,
    });
  }

  const severityRank = { critical: 0, warning: 1, info: 2 };
  return exceptions
    .sort((a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9) || b.timestamp - a.timestamp)
    .slice(0, MAX_INSIGHT_ITEMS);
}

function buildHomeSnapshot(options = {}) {
  const sessionMap = options.sessions instanceof Map ? options.sessions : new Map();
  const meetings = options.meetings && typeof options.meetings === 'object' ? options.meetings : {};
  const now = Number(options.now || Date.now());

  const regularItems = Array.from(sessionMap.values())
    .filter(session => session
      && !session.meetingId
      && !session.hiddenFromSidebar
      && session.kind !== 'chuxin-run'
      && session.purpose !== 'chuxin-research')
    .map(session => makeSessionItem(session, now));
  const meetingItems = Object.values(meetings)
    .filter(Boolean)
    .map(meeting => makeMeetingItem(meeting, sessionMap, now));
  const items = regularItems.concat(meetingItems)
    .filter(item => item.id)
    .sort((a, b) => b.lastMessageTime - a.lastMessageTime);

  const waiting = items.filter(item => item.waiting && !item.dormant);
  const running = items.filter(item => item.running && !item.waiting && !item.dormant);
  const delivered = items.filter((item) => {
    if (item.waiting || item.running || item.dormant) return false;
    return item.completedUnread || (item.lastMessageTime > 0 && now - item.lastMessageTime <= RECENT_WINDOW_MS);
  });
  const contextRisk = regularItems
    .filter(item => !item.dormant && item.contextPct != null && item.contextPct >= CONTEXT_WARNING_PCT)
    .sort((a, b) => b.contextPct - a.contextPct || b.lastMessageTime - a.lastMessageTime)
    .slice(0, MAX_INSIGHT_ITEMS);

  const allSessions = Array.from(sessionMap.values()).filter(Boolean);
  const providerActive = { claude: 0, codex: 0, gemini: 0, deepseek: 0, kimi: 0, powershell: 0 };
  for (const session of allSessions) {
    if (session.status === 'dormant') continue;
    const kind = baseKind(session.kind);
    if (Object.prototype.hasOwnProperty.call(providerActive, kind)) providerActive[kind] += 1;
  }

  const exceptions = buildExceptions(items, {
    now,
    resourceUsage: options.resourceUsage,
    hubConfig: options.hubConfig,
    usageSnapshot: options.usageSnapshot,
    refreshError: options.refreshError,
  });
  const artifacts = deriveRecentArtifacts(sessionMap, {
    now,
    pathExists: options.pathExists,
  });
  const night = buildNightSummary(items, now);

  return {
    generatedAt: now,
    items,
    lanes: { waiting, running, delivered },
    contextRisk,
    exceptions,
    artifacts,
    night,
    metrics: {
      active: allSessions.filter(session => session.status !== 'dormant').length,
      waiting: waiting.length,
      unread: items.filter(item => item.unreadCount > 0).length,
      dormant: items.filter(item => item.dormant).length,
    },
    providerActive,
  };
}

function formatDurationShort(ms) {
  const totalMinutes = Math.max(0, Math.round((Number(ms) || 0) / 60_000));
  if (totalMinutes < 1) return '不到 1 分钟';
  if (totalMinutes < 60) return `${totalMinutes} 分钟`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours} 小时${minutes ? ` ${minutes} 分钟` : ''}`;
}

function createHomeWorkbench(options = {}) {
  const doc = options.document || document;
  const getSessions = typeof options.getSessions === 'function' ? options.getSessions : () => new Map();
  const getMeetings = typeof options.getMeetings === 'function' ? options.getMeetings : () => ({});
  const getResourceUsage = typeof options.getResourceUsage === 'function' ? options.getResourceUsage : () => null;
  const getHubConfig = typeof options.getHubConfig === 'function' ? options.getHubConfig : () => null;
  const getUsageSnapshot = typeof options.getUsageSnapshot === 'function' ? options.getUsageSnapshot : () => null;
  const getOperationsSnapshot = typeof options.getOperationsSnapshot === 'function' ? options.getOperationsSnapshot : () => null;
  const getTerminalCacheSize = typeof options.getTerminalCacheSize === 'function' ? options.getTerminalCacheSize : () => 0;
  const loadWorkspaces = typeof options.loadWorkspaces === 'function' ? options.loadWorkspaces : async () => null;
  const loadOperations = typeof options.loadOperations === 'function' ? options.loadOperations : async () => null;
  const selectSession = typeof options.selectSession === 'function' ? options.selectSession : () => {};
  const selectMeeting = typeof options.selectMeeting === 'function' ? options.selectMeeting : () => {};
  const onCopyRecentTurns = typeof options.onCopyRecentTurns === 'function' ? options.onCopyRecentTurns : async () => null;
  const onForkSession = typeof options.onForkSession === 'function' ? options.onForkSession : async () => null;
  const onOpenArtifact = typeof options.onOpenArtifact === 'function' ? options.onOpenArtifact : async () => null;
  const onLaunchWorkspace = typeof options.onLaunchWorkspace === 'function' ? options.onLaunchWorkspace : () => null;
  const onOpenReview = typeof options.onOpenReview === 'function' ? options.onOpenReview : () => null;
  const onOpenServerSettings = typeof options.onOpenServerSettings === 'function' ? options.onOpenServerSettings : () => null;
  const onRefresh = typeof options.onRefresh === 'function' ? options.onRefresh : async () => {};
  const escapeHtml = typeof options.escapeHtml === 'function'
    ? options.escapeHtml
    : value => String(value || '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
  const nowFn = typeof options.nowFn === 'function' ? options.nowFn : Date.now;
  const setIntervalFn = typeof options.setIntervalFn === 'function' ? options.setIntervalFn : setInterval;
  const pathExists = typeof options.pathExists === 'function' ? options.pathExists : () => true;
  const root = doc.getElementById('empty-state');
  const state = {
    refreshing: false,
    lastRefreshAt: nowFn(),
    refreshError: '',
    snapshot: null,
    workspaceListing: null,
    workspaceItems: [],
    htmlCache: new Map(),
  };

  function el(id) {
    return doc.getElementById(id);
  }

  function setText(id, value) {
    const target = el(id);
    if (target) target.textContent = String(value == null ? '' : value);
  }

  function setHtml(id, html) {
    const target = el(id);
    if (!target || state.htmlCache.get(id) === html) return target;
    target.innerHTML = html;
    state.htmlCache.set(id, html);
    return target;
  }

  function relativeTime(timestamp, now = nowFn()) {
    if (!timestamp) return '刚刚';
    const diff = Math.max(0, now - Number(timestamp));
    if (diff < 60_000) return '刚刚';
    if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))} 小时前`;
    return `${Math.floor(diff / (24 * 60 * 60_000))} 天前`;
  }

  function shortText(value, limit = 92) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  }

  function formatResetIn(resetsAt) {
    if (!resetsAt) return '';
    const ms = new Date(resetsAt).getTime() - nowFn();
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const mins = Math.max(1, Math.round(ms / 60_000));
    if (mins < 60) return `${mins}m 后重置`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h${mins % 60 ? ` ${mins % 60}m` : ''} 后重置`;
    return `${Math.floor(hours / 24)}d${hours % 24 ? ` ${hours % 24}h` : ''} 后重置`;
  }

  function usageUpdatedLabel(usage) {
    const observedAt = finiteNumber(usage && (usage.observedAt || usage.lastSeen || usage._ts));
    return observedAt ? `更新于 ${relativeTime(observedAt)}` : '尚未刷新';
  }

  function usageWindowMarkup(label, usageWindow) {
    const pctValue = finiteNumber(usageWindow && usageWindow.pct);
    const pct = pctValue == null ? null : Math.round(pctValue);
    const width = pct == null ? 0 : Math.max(0, Math.min(100, pct));
    const level = pct == null ? 'unknown' : pct >= 85 ? 'danger' : pct >= 70 ? 'warn' : 'ok';
    const resetText = usageWindow ? formatResetIn(usageWindow.resetsAt) : '';
    const refreshText = resetText ? resetText.replace(/后重置$/, '后刷新') : '刷新时间未知';
    const resetAt = usageWindow && usageWindow.resetsAt ? new Date(usageWindow.resetsAt) : null;
    const resetTitle = resetAt && Number.isFinite(resetAt.getTime())
      ? `配额刷新时间：${resetAt.toLocaleString('zh-CN')}`
      : '配额刷新时间未知';
    return `<div class="home-usage-window ${level}" title="${escapeHtml(resetTitle)}">`
      + `<div class="home-usage-window-head"><span>${escapeHtml(label)}</span><strong>${pct == null ? '—' : `${pct}%`}</strong></div>`
      + `<div class="home-quota-track"><span class="${level}" style="width:${width}%"></span></div>`
      + `<small class="home-usage-reset">${escapeHtml(refreshText)}</small></div>`;
  }

  function providerUsageRow(name, kind, usage, activeCount) {
    const updated = usageUpdatedLabel(usage);
    return `<div class="home-provider-row">`
      + `<div class="home-provider-line"><span><i class="home-provider-dot ${kind}"></i><strong>${escapeHtml(name)}</strong></span><em data-usage-updated="true">${activeCount || 0} 活跃 · ${escapeHtml(updated)}</em></div>`
      + `<div class="home-usage-windows">${usageWindowMarkup('5h', usage && usage.usage5h)}${usageWindowMarkup('7d', usage && usage.usage7d)}</div>`
      + '</div>';
  }

  function moneyLabel(currency, value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return '—';
    const symbol = String(currency || '').toUpperCase() === 'CNY' ? '¥' : `${String(currency || '').toUpperCase()} `;
    return `${symbol}${amount.toFixed(2)}`;
  }

  function providerBalanceRow(name, kind, balance, activeCount, configured) {
    const updated = usageUpdatedLabel(balance);
    const hasBalance = balance && Number.isFinite(Number(balance.totalBalance));
    if (!hasBalance) {
      const status = configured ? `${activeCount || 0} 活跃 · 待刷新` : '未配置 API Key';
      return `<div class="home-provider-row balance">`
        + `<div class="home-provider-line"><span><i class="home-provider-dot ${kind}"></i><strong>${escapeHtml(name)}</strong></span><em>${escapeHtml(status)}</em></div>`
        + `<div class="home-provider-refresh"><span>官方余额接口 · 每 5 分钟轮询</span><span data-usage-updated="true">${escapeHtml(updated)}</span></div>`
        + '</div>';
    }
    const currency = balance.currency || 'CNY';
    const total = moneyLabel(currency, balance.totalBalance);
    const toppedUp = moneyLabel(currency, balance.toppedUpBalance);
    const granted = moneyLabel(currency, balance.grantedBalance);
    const available = balance.available !== false;
    const totalNumber = Number(balance.totalBalance);
    const level = !available || totalNumber < 10 ? 'danger' : totalNumber < 30 ? 'warn' : 'ok';
    return `<div class="home-provider-row balance">`
      + `<div class="home-provider-line"><span><i class="home-provider-dot ${kind}"></i><strong>${escapeHtml(name)}</strong></span><em class="${level}">余额 ${escapeHtml(total)} · ${available ? '可用' : '不可用'}</em></div>`
      + `<div class="home-provider-detail">充值 ${escapeHtml(toppedUp)} · 赠金 ${escapeHtml(granted)}</div>`
      + `<div class="home-provider-refresh"><span>官方余额接口 · 每 5 分钟轮询</span><span data-usage-updated="true">${escapeHtml(updated)}</span></div>`
      + '</div>';
  }

  function renderProviderHealth(snapshot, usage) {
    const target = el('home-provider-health');
    if (!target) return;
    const config = getHubConfig() || {};
    setHtml('home-provider-health', [
      providerUsageRow('Claude', 'claude', usage.claude, snapshot.providerActive.claude),
      providerUsageRow('Codex', 'codex', usage.codex, snapshot.providerActive.codex),
      providerUsageRow('Kimi', 'kimi', usage.kimi, snapshot.providerActive.kimi),
      providerBalanceRow('DeepSeek API', 'deepseek', usage.deepseek, snapshot.providerActive.deepseek, config.deepseekApiKeySet === true),
    ].join(''));
  }

  function renderExceptions(snapshot) {
    const target = el('home-exception-list');
    if (!target) return;
    setText('home-exception-count', snapshot.exceptions.length);
    if (!snapshot.exceptions.length) {
      setHtml('home-exception-list', '<div class="home-operational-empty ok">没有失败、卡住或系统告警</div>');
      return;
    }
    setHtml('home-exception-list', snapshot.exceptions.map((item) => {
      const targetAttrs = item.targetId
        ? ` data-home-type="${escapeHtml(item.type)}" data-home-id="${escapeHtml(item.targetId)}"`
        : '';
      const action = item.action === 'refresh'
        ? '<button type="button" class="home-mini-action" data-home-action="refresh">刷新</button>'
        : '';
      return `<div class="home-insight-row exception ${escapeHtml(item.severity)}">`
        + `<button type="button" class="home-insight-open"${targetAttrs}${item.targetId ? '' : ' tabindex="-1"'}>`
        + `<span class="home-severity-dot ${escapeHtml(item.severity)}" aria-hidden="true"></span>`
        + `<span><strong>${escapeHtml(shortText(item.title, 58))}</strong><small>${escapeHtml(shortText(item.detail, 88))}</small></span></button>${action}</div>`;
    }).join(''));
  }

  function renderContextRisk(snapshot) {
    const target = el('home-context-risk');
    if (!target) return;
    setText('home-context-count', snapshot.contextRisk.length);
    if (!snapshot.contextRisk.length) {
      setHtml('home-context-risk', '<div class="home-operational-empty ok">暂无超过 70% 的上下文</div>');
      return;
    }
    setHtml('home-context-risk', snapshot.contextRisk.map((item) => {
      const pct = Math.round(item.contextPct);
      const level = pct >= CONTEXT_CRITICAL_PCT ? 'danger' : 'warn';
      const fork = item.supportsFork
        ? `<button type="button" class="home-mini-action" data-home-action="fork-session" data-session-id="${escapeHtml(item.id)}">开分支</button>`
        : '';
      return `<div class="home-insight-row context ${level}">`
        + `<button type="button" class="home-insight-open" data-home-type="session" data-home-id="${escapeHtml(item.id)}">`
        + `<span class="home-context-ring ${level}" style="--context-pct:${Math.max(0, Math.min(100, pct))}">${pct}%</span>`
        + `<span><strong>${escapeHtml(shortText(item.title, 52))}</strong><small>${escapeHtml(item.providerLabel)} · ${relativeTime(item.lastMessageTime)}</small></span></button>`
        + `<span class="home-inline-actions"><button type="button" class="home-mini-action" data-home-action="copy-turns" data-session-id="${escapeHtml(item.id)}">复制 3 轮</button>${fork}</span></div>`;
    }).join(''));
  }

  function renderArtifacts(snapshot) {
    const target = el('home-artifact-list');
    if (!target) return;
    const operations = getOperationsSnapshot() || {};
    const gitFiles = Array.isArray(operations.recentFiles) ? operations.recentFiles.map(file => ({
      path: file.absolutePath || path.join(file.repoRoot || '', file.path || ''),
      name: path.basename(file.path || file.absolutePath || ''),
      timestamp: file.modifiedAt || operations.checkedAt || nowFn(),
      sessionTitle: `${file.repoName || 'Git'} · ${file.status || '变更'}`,
      source: 'git',
      risk: file.risk || 'low',
    })) : [];
    const seen = new Set();
    const files = snapshot.artifacts.map(artifact => ({ ...artifact, source: 'artifact' })).concat(gitFiles)
      .filter(file => {
        const key = String(file.path || '').toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
      .slice(0, 10);
    setText('home-artifact-count', files.length);
    if (!files.length) {
      setHtml('home-artifact-list', '<div class="home-operational-empty">最近 Session 的 Git 变更与 Agent 产物会自动汇总到这里</div>');
      return;
    }
    setHtml('home-artifact-list', files.map((artifact) => `<button type="button" class="home-artifact-item" data-home-action="open-artifact" data-artifact-path="${escapeHtml(artifact.path)}" title="${escapeHtml(artifact.path)}">`
      + '<span class="home-artifact-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 3h11l5 5v13H4z"/><path d="M15 3v5h5"/></svg></span>'
      + `<span><strong>${escapeHtml(shortText(artifact.name, 42))}<i class="home-file-source ${escapeHtml(artifact.source)}">${artifact.source === 'git' ? 'Git 变更' : 'Agent 产物'}</i></strong><small>${escapeHtml(shortText(artifact.sessionTitle, 42))} · ${relativeTime(artifact.timestamp)}</small><em>${escapeHtml(shortText(artifact.path, 74))}</em></span>`
      + '<svg class="home-artifact-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button>').join(''));
  }

  function renderReviewInbox() {
    const operations = getOperationsSnapshot() || {};
    const summary = operations.summary || {};
    const repos = Array.isArray(operations.repos) ? operations.repos : [];
    const scanErrors = Array.isArray(operations.scanErrors) ? operations.scanErrors : [];
    setText('home-review-repos', summary.repos || 0);
    setText('home-review-high', summary.highRisk || 0);
    setText('home-review-medium', summary.mediumRisk || 0);
    setText('home-review-files', summary.files || 0);
    const target = el('home-review-list');
    if (!target) return;
    if (!operations.checkedAt) {
      setHtml('home-review-list', '<div class="home-operational-empty">正在检查最近 Session 所在的 Git 工作区…</div>');
      return;
    }
    if (!repos.length && !scanErrors.length) {
      setHtml('home-review-list', '<div class="home-operational-empty ok">最近工作区没有未提交改动</div>');
      return;
    }
    const repoMarkup = repos.slice(0, 4).map(repo => {
      const keyFiles = repo.files.slice(0, 3).map(file => path.basename(file.path)).join(' · ');
      const evidence = repo.testFiles > 0 ? `含 ${repo.testFiles} 个测试文件，执行结果未知` : '未发现测试文件证据';
      const fileCount = Number(repo.totalFileCount || repo.files.length);
      return `<article class="home-review-item ${escapeHtml(repo.risk)}"><div><span class="home-review-risk ${escapeHtml(repo.risk)}">${repo.risk === 'high' ? '高风险' : repo.risk === 'medium' ? '需确认' : '低风险'}</span><strong>${escapeHtml(repo.name)}</strong><small>${escapeHtml(repo.branch)} · ${fileCount} 文件${repo.truncated ? '（先显示 300）' : ''} · +${repo.additions} / −${repo.deletions}</small><p>${escapeHtml(shortText(keyFiles, 76))}</p><em>${escapeHtml(evidence)}</em></div><button type="button" data-home-action="open-review" data-repo-id="${escapeHtml(repo.id)}">${repo.risk === 'high' ? '深度审阅' : '查看 Diff'}</button></article>`;
    }).join('');
    const errorMarkup = scanErrors.slice(0, 2).map(item => `<article class="home-review-item high scan-error"><div><span class="home-review-risk high">扫描失败</span><strong>${escapeHtml(item.name || 'Git 工作区')}</strong><small>${item.error === 'git_scan_timeout' ? 'Git 命令超时' : 'Git 状态读取失败'}</small><p>该工作区没有被误判为“干净”，请刷新或在终端检查 Git 状态。</p></div><button type="button" data-home-action="refresh">重试</button></article>`).join('');
    setHtml('home-review-list', repoMarkup + errorMarkup);
  }

  function renderNightSummary(snapshot) {
    setText('home-night-window', snapshot.night.label);
    setText('home-night-completed', snapshot.night.completed);
    setText('home-night-failed', snapshot.night.failed);
    setText('home-night-waiting', snapshot.night.waiting);
    setText('home-night-duration', snapshot.night.totalDurationMs > 0 ? formatDurationShort(snapshot.night.totalDurationMs) : '—');
    const target = el('home-night-list');
    if (!target) return;
    if (!snapshot.night.items.length) {
      setHtml('home-night-list', '<div class="home-operational-empty">这个夜间窗口暂无完成任务</div>');
      return;
    }
    setHtml('home-night-list', snapshot.night.items.map(item => `<button type="button" class="home-night-item" data-home-type="${item.type}" data-home-id="${escapeHtml(item.id)}">`
      + `<span class="home-provider ${item.kind}">${escapeHtml(item.providerLabel)}</span><strong>${escapeHtml(shortText(item.title, 42))}</strong><small>${relativeTime(item.lastCompletedAt || item.lastMessageTime)}</small></button>`).join(''));
  }

  function workspaceKey(value) {
    return String(value || '').replace(/[\\/]+$/, '').toLowerCase();
  }

  function renderQuickLaunch() {
    const target = el('home-workspace-launch');
    if (!target) return;
    const listing = state.workspaceListing || {};
    const recommended = Array.isArray(listing.recommended) ? listing.recommended : [];
    const recent = Array.isArray(listing.items) ? listing.items : [];
    const seen = new Set();
    state.workspaceItems = recommended.concat(recent)
      .filter(item => {
        if (!item || !item.path || item.legacy || item.tier === 'root') return false;
        const key = workspaceKey(item.path);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 6);
    if (!state.workspaceItems.length) {
      setHtml('home-workspace-launch', '<div class="home-operational-empty">刷新后显示 AI、Wireless、投研与最近项目</div>');
      return;
    }
    setHtml('home-workspace-launch', state.workspaceItems.map((item, index) => {
      const initial = String(item.label || path.basename(item.path) || 'P').trim().slice(0, 1).toUpperCase();
      const tag = item.recommended ? '常用' : item.pinned ? '置顶' : '最近';
      return `<button type="button" class="home-workspace-item" data-home-action="launch-workspace" data-workspace-index="${index}" title="在 ${escapeHtml(item.path)} 新建 Claude 会话">`
        + `<span class="home-workspace-initial">${escapeHtml(initial)}</span><span><strong>${escapeHtml(item.label || path.basename(item.path))}</strong><small>${escapeHtml(shortText(item.path, 52))}</small></span><em>${tag}</em></button>`;
    }).join(''));
  }

  function shortProxy(raw) {
    const value = String(raw || '').trim();
    if (!value) return '直连';
    try {
      const parsed = new URL(value.includes('://') ? value : `http://${value}`);
      return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    } catch {
      return value.replace(/^[a-z0-9+.-]+:\/\//i, '').replace(/^[^@/]*@/, '').split('/')[0] || '已配置';
    }
  }

  function setSyncValue(id, value, level = 'ok') {
    const target = el(id);
    if (!target) return;
    target.textContent = value;
    target.className = `home-sync-value ${level}`;
  }

  function setResourceMetric(name, value) {
    const number = value != null && value !== '' && Number.isFinite(Number(value))
      ? Math.max(0, Math.min(100, Math.round(Number(value))))
      : null;
    setText(`home-system-${name}`, number == null ? '--' : `${number}%`);
    const bar = el(`home-system-${name}-bar`);
    if (bar) {
      bar.style.width = `${number == null ? 0 : number}%`;
      bar.className = number != null && number >= 90 ? 'danger' : number != null && number >= 75 ? 'warn' : '';
    }
    return number;
  }

  function formatBytes(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let current = number;
    let index = 0;
    while (current >= 1024 && index < units.length - 1) { current /= 1024; index += 1; }
    return `${current >= 10 || index === 0 ? current.toFixed(0) : current.toFixed(1)} ${units[index]}`;
  }

  function renderSystemAndServer() {
    const resources = getResourceUsage() || {};
    const operations = getOperationsSnapshot() || {};
    const cpu = setResourceMetric('cpu', resources.cpuPct);
    const memory = setResourceMetric('memory', resources.memoryPct);
    const gpu = setResourceMetric('gpu', resources.gpu && resources.gpu.usagePct);
    const disk = setResourceMetric('disk', resources.disk && resources.disk.usagePct);
    const gpuCell = el('home-system-gpu')?.closest('.home-system-cell');
    if (gpuCell) {
      const gpuInfo = resources.gpu;
      gpuCell.title = gpuInfo
        ? `${gpuInfo.name || 'GPU'} · 显存 ${formatBytes(gpuInfo.memoryUsedBytes)} / ${formatBytes(gpuInfo.memoryTotalBytes)}${gpuInfo.temperatureC != null ? ` · ${gpuInfo.temperatureC}°C` : ''}`
        : '未检测到可读取利用率的 GPU';
    }
    const systemCard = el('home-system-title')?.closest('.home-system-card');
    if (systemCard) systemCard.classList.toggle('pressure', [cpu, memory, gpu, disk].some(value => value != null && value >= 90));

    const remote = operations.remote || {};
    const serverBar = el('home-server-storage-bar');
    setText('home-server-label', remote.label || '阿里云服务器');
    const dot = el('home-server-dot');
    const server = el('home-server-status');
    if (!remote.configured) {
      setText('home-server-latency', '未配置');
      setText('home-server-storage-label', '保存健康检查 URL 后显示在线与存储');
      setText('home-server-storage-value', '--');
      setText('home-server-metrics', '远端指标等待配置');
      if (serverBar) { serverBar.style.width = '0%'; serverBar.className = ''; }
      if (dot) dot.className = 'home-status-dot dim';
      if (server) server.className = 'home-server-status unconfigured';
    } else if (!remote.online) {
      setText('home-server-latency', '离线');
      setText('home-server-storage-label', `连接失败 · ${shortText(remote.error || 'unreachable', 42)}`);
      setText('home-server-storage-value', '--');
      setText('home-server-metrics', `最后检查 ${new Date(remote.checkedAt || nowFn()).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
      if (serverBar) { serverBar.style.width = '0%'; serverBar.className = ''; }
      if (dot) dot.className = 'home-status-dot danger';
      if (server) server.className = 'home-server-status offline';
    } else {
      setText('home-server-latency', `在线 · ${Math.round(remote.latencyMs || 0)}ms`);
      if (dot) dot.className = 'home-status-dot ok';
      if (server) server.className = 'home-server-status online';
      const storage = remote.storage;
      setText('home-server-storage-label', storage ? `${storage.mount || '/'} 存储` : '在线 · 指标端点未返回存储');
      setText('home-server-storage-value', storage && storage.usagePct != null
        ? `${storage.usagePct}% · ${formatBytes(storage.usedBytes)} / ${formatBytes(storage.totalBytes)}`
        : '--');
      const remoteCpu = remote.cpuPct != null && Number.isFinite(Number(remote.cpuPct)) ? `${Math.round(Number(remote.cpuPct))}%` : '--';
      const remoteMemory = remote.memoryPct != null && Number.isFinite(Number(remote.memoryPct)) ? `${Math.round(Number(remote.memoryPct))}%` : '--';
      setText('home-server-metrics', `远端 CPU ${remoteCpu} · 内存 ${remoteMemory}`);
      if (serverBar) {
        const pct = storage && Number.isFinite(Number(storage.usagePct)) ? Number(storage.usagePct) : 0;
        serverBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
        serverBar.className = pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : '';
      }
    }
  }

  function renderSyncHealth(snapshot) {
    const config = getHubConfig() || {};
    const resources = getResourceUsage() || {};
    const configured = config.serverchanSendKeySet === true;
    setSyncValue('home-sync-notification', configured ? '已配置 · 按会话开启' : '未配置', configured ? 'ok' : 'warn');
    setSyncValue('home-sync-proxy', shortProxy(config.proxy), config.proxy ? 'ok' : 'dim');

    const terminalCount = Math.max(0, Number(getTerminalCacheSize() || 0));
    setSyncValue('home-sync-terminals', `${terminalCount} 个终端保留`, terminalCount > 0 ? 'ok' : 'dim');

    const cpu = Number.isFinite(resources.cpuPct) ? Math.round(resources.cpuPct) : null;
    const memory = Number.isFinite(resources.memoryPct) ? Math.round(resources.memoryPct) : null;
    const resourceLevel = (cpu != null && cpu >= 85) || (memory != null && memory >= 85) ? 'warn' : 'ok';

    const healthLabel = el('home-health-label');
    const healthDot = el('home-health-dot');
    const remote = getOperationsSnapshot() && getOperationsSnapshot().remote;
    const operationsScanErrors = Number(getOperationsSnapshot() && getOperationsSnapshot().summary && getOperationsSnapshot().summary.scanErrors || 0);
    const pressureHigh = resourceLevel === 'warn';
    const serverOffline = remote && remote.configured && !remote.online;
    const hasExceptions = snapshot.exceptions.length > 0;
    if (healthLabel) {
      healthLabel.textContent = state.refreshError
        ? '部分状态刷新失败'
        : hasExceptions
          ? `${snapshot.exceptions.length} 项需要关注`
          : operationsScanErrors > 0
            ? `${operationsScanErrors} 个 Git 工作区扫描失败`
          : serverOffline
            ? `${remote.label || '服务器'}离线`
          : pressureHigh
            ? '系统负载偏高'
            : '当前 HUB 状态正常';
    }
    if (healthDot) healthDot.className = `home-status-dot ${state.refreshError || hasExceptions || operationsScanErrors || pressureHigh || serverOffline ? 'warn' : 'ok'}`;
  }

  function isVisible() {
    return !!(root && root.isConnected !== false && (!root.style || root.style.display !== 'none'));
  }

  function render(options = {}) {
    if (!root) return null;
    if (!options.force && !isVisible()) return state.snapshot;
    const notificationSlot = el('home-notification-slot');
    const notificationToggle = el('completion-notification-toggle');
    if (isVisible() && notificationSlot && notificationToggle && notificationToggle.parentElement !== notificationSlot) {
      notificationSlot.appendChild(notificationToggle);
    }
    const usage = getUsageSnapshot() || {};
    const snapshot = buildHomeSnapshot({
      sessions: getSessions(),
      meetings: getMeetings(),
      now: nowFn(),
      resourceUsage: getResourceUsage(),
      hubConfig: getHubConfig(),
      usageSnapshot: usage,
      refreshError: state.refreshError,
      pathExists,
    });
    state.snapshot = snapshot;

    setText('home-metric-active', snapshot.metrics.active);
    setText('home-metric-waiting', snapshot.metrics.waiting);
    setText('home-metric-unread', snapshot.metrics.unread);
    setText('home-metric-dormant', snapshot.metrics.dormant);
    setText('home-last-sync', `更新于 ${new Date(state.lastRefreshAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);

    const refreshButton = el('home-refresh');
    if (refreshButton) {
      refreshButton.disabled = state.refreshing;
      refreshButton.classList.toggle('loading', state.refreshing);
      const label = refreshButton.querySelector('span');
      if (label) label.textContent = state.refreshing ? '刷新中' : '刷新';
    }

    renderReviewInbox();
    renderExceptions(snapshot);
    renderContextRisk(snapshot);
    renderArtifacts(snapshot);
    renderQuickLaunch();
    renderProviderHealth(snapshot, usage);
    renderNightSummary(snapshot);
    renderSystemAndServer();
    renderSyncHealth(snapshot);
    root.dataset.homeReady = 'true';
    return snapshot;
  }

  async function loadWorkspaceListing() {
    try {
      state.workspaceListing = await loadWorkspaces();
      if (isVisible()) render();
      return state.workspaceListing;
    } catch (error) {
      state.workspaceListing = null;
      return null;
    }
  }

  async function refresh() {
    if (state.refreshing) return false;
    state.refreshing = true;
    state.refreshError = '';
    render();
    try {
      await Promise.all([onRefresh(), loadWorkspaceListing(), loadOperations(true)]);
      state.lastRefreshAt = nowFn();
      return true;
    } catch (error) {
      state.refreshError = error && error.message ? error.message : '刷新失败';
      state.lastRefreshAt = nowFn();
      return false;
    } finally {
      state.refreshing = false;
      render();
    }
  }

  function activateFlowItem(target) {
    const item = target && target.closest ? target.closest('[data-home-type][data-home-id]') : null;
    if (!item) return false;
    if (item.dataset.homeType === 'meeting') selectMeeting(item.dataset.homeId, { forceScrollBottom: true });
    else selectSession(item.dataset.homeId, { forceScrollBottom: true });
    return true;
  }

  async function runAction(button) {
    const action = button && button.dataset && button.dataset.homeAction;
    if (!action) return false;
    const original = button.textContent;
    try {
      if (action === 'refresh') {
        await refresh();
      } else if (action === 'copy-turns') {
        button.disabled = true;
        const result = await onCopyRecentTurns(button.dataset.sessionId, 3);
        button.textContent = result && result.copiedRounds ? `已复制 ${result.copiedRounds} 轮` : '暂无完整轮次';
      } else if (action === 'fork-session') {
        button.disabled = true;
        await onForkSession(button.dataset.sessionId);
        button.textContent = '已发起';
      } else if (action === 'open-artifact') {
        await onOpenArtifact(button.dataset.artifactPath);
      } else if (action === 'launch-workspace') {
        const item = state.workspaceItems[Number(button.dataset.workspaceIndex)];
        if (item) onLaunchWorkspace(item);
      } else if (action === 'open-review') {
        await onOpenReview(button.dataset.repoId || '');
      } else if (action === 'open-server-settings') {
        await onOpenServerSettings();
      }
    } catch {
      button.textContent = '操作失败';
    } finally {
      if (action === 'copy-turns' || action === 'fork-session') {
        setTimeout(() => {
          if (!button.isConnected) return;
          button.disabled = false;
          button.textContent = original;
        }, 1800);
      }
    }
    return true;
  }

  if (root) {
    root.addEventListener('click', (event) => {
      const actionButton = event.target && event.target.closest ? event.target.closest('[data-home-action]') : null;
      if (actionButton) {
        event.preventDefault();
        event.stopPropagation();
        void runAction(actionButton);
        return;
      }
      if (activateFlowItem(event.target)) return;
      const refreshButton = event.target && event.target.closest ? event.target.closest('#home-refresh') : null;
      if (refreshButton) void refresh();
    });
    root.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (activateFlowItem(event.target)) event.preventDefault();
    });
  }

  void loadWorkspaceListing();
  void loadOperations(false).then(() => { if (isVisible()) render(); }).catch(() => {});
  setIntervalFn(() => {
    if (isVisible()) {
      void loadOperations(false).then(() => render()).catch(() => render());
    }
  }, 30_000);

  return {
    render,
    refresh,
    isVisible,
    getSnapshot: () => state.snapshot,
  };
}

module.exports = {
  CONTEXT_CRITICAL_PCT,
  CONTEXT_WARNING_PCT,
  LONG_TASK_MS,
  RECENT_WINDOW_MS,
  baseKind,
  buildHomeSnapshot,
  buildNightSummary,
  buildNightWindow,
  createHomeWorkbench,
  deriveRecentArtifacts,
  formatDurationShort,
};
