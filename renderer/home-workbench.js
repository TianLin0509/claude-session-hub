'use strict';

const { isGroupChatMemberRunning } = require('../core/groupchat-running-state.js');
const {
  sessionHasCompletedUnread,
  sessionNeedsUserInput,
} = require('../core/session-attention-state.js');

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_LANE_ITEMS = 5;

const PROVIDER_LABELS = {
  claude: 'CLAUDE',
  codex: 'CODEX',
  gemini: 'GEMINI',
  deepseek: 'DEEPSEEK',
  kimi: 'KIMI',
  powershell: 'SHELL',
  group: '群聊',
};

function baseKind(kind) {
  const value = String(kind || '').replace(/-resume$/i, '').toLowerCase();
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

function makeSessionItem(session) {
  const unreadCount = Math.max(0, Number(session.unreadCount || 0));
  const kind = baseKind(session.kind);
  return {
    id: String(session.id || ''),
    type: 'session',
    title: String(session.title || PROVIDER_LABELS[kind] || 'Session'),
    kind,
    providerLabel: PROVIDER_LABELS[kind] || 'AI',
    preview: String(session.waitingText || session.replyReadyText || session.lastOutputPreview || session.workspaceLabel || session.cwd || ''),
    lastMessageTime: itemTime(session),
    status: session.status || 'idle',
    running: session.status === 'running' || isGroupChatMemberRunning(session),
    waiting: sessionNeedsUserInput(session),
    completedUnread: sessionHasCompletedUnread(session),
    unreadCount,
    dormant: session.status === 'dormant',
  };
}

function makeMeetingItem(meeting, sessionMap) {
  const childIds = Array.isArray(meeting.subSessions) ? meeting.subSessions : [];
  const running = meeting.status === 'running' || childIds.some((id) => {
    const child = sessionMap.get(id);
    return child && child.status !== 'dormant' && isGroupChatMemberRunning(child);
  });
  const answered = numberFromUnreadAnswered(meeting.unreadAnswered);
  const unreadCount = Math.max(answered, Number(meeting.unreadCount || 0));
  return {
    id: String(meeting.id || ''),
    type: 'meeting',
    title: String(meeting.title || 'AI 群聊'),
    kind: 'group',
    providerLabel: '群聊',
    preview: String(meeting.lastOutputPreview || `${childIds.length} 位 AI 成员`),
    lastMessageTime: itemTime(meeting),
    status: meeting.status || 'idle',
    running,
    waiting: false,
    completedUnread: unreadCount > 0,
    unreadCount,
    dormant: meeting.status === 'dormant',
  };
}

function buildHomeSnapshot(options = {}) {
  const sessionMap = options.sessions instanceof Map ? options.sessions : new Map();
  const meetings = options.meetings && typeof options.meetings === 'object' ? options.meetings : {};
  const now = Number(options.now || Date.now());

  const regularItems = Array.from(sessionMap.values())
    .filter((session) => session
      && !session.meetingId
      && !session.hiddenFromSidebar
      && session.kind !== 'chuxin-run'
      && session.purpose !== 'chuxin-research')
    .map(makeSessionItem);
  const meetingItems = Object.values(meetings)
    .filter(Boolean)
    .map((meeting) => makeMeetingItem(meeting, sessionMap));
  const items = regularItems.concat(meetingItems)
    .filter((item) => item.id)
    .sort((a, b) => b.lastMessageTime - a.lastMessageTime);

  const waiting = items.filter((item) => item.waiting && !item.dormant);
  const running = items.filter((item) => item.running && !item.waiting && !item.dormant);
  const delivered = items.filter((item) => {
    if (item.waiting || item.running || item.dormant) return false;
    return item.completedUnread || (item.lastMessageTime > 0 && now - item.lastMessageTime <= RECENT_WINDOW_MS);
  });

  const allSessions = Array.from(sessionMap.values()).filter(Boolean);
  const providerActive = { claude: 0, codex: 0, gemini: 0, deepseek: 0, kimi: 0, powershell: 0 };
  for (const session of allSessions) {
    if (session.status === 'dormant') continue;
    const kind = baseKind(session.kind);
    if (Object.prototype.hasOwnProperty.call(providerActive, kind)) providerActive[kind] += 1;
  }

  return {
    generatedAt: now,
    items,
    lanes: {
      waiting,
      running,
      delivered,
    },
    metrics: {
      active: allSessions.filter((session) => session.status !== 'dormant').length,
      waiting: waiting.length,
      unread: items.filter((item) => item.unreadCount > 0).length,
      dormant: items.filter((item) => item.dormant).length,
    },
    providerActive,
  };
}

function createHomeWorkbench(options = {}) {
  const doc = options.document || document;
  const getSessions = typeof options.getSessions === 'function' ? options.getSessions : () => new Map();
  const getMeetings = typeof options.getMeetings === 'function' ? options.getMeetings : () => ({});
  const getResourceUsage = typeof options.getResourceUsage === 'function' ? options.getResourceUsage : () => null;
  const getHubConfig = typeof options.getHubConfig === 'function' ? options.getHubConfig : () => null;
  const getUsageSnapshot = typeof options.getUsageSnapshot === 'function' ? options.getUsageSnapshot : () => null;
  const getTerminalCacheSize = typeof options.getTerminalCacheSize === 'function' ? options.getTerminalCacheSize : () => 0;
  const selectSession = typeof options.selectSession === 'function' ? options.selectSession : () => {};
  const selectMeeting = typeof options.selectMeeting === 'function' ? options.selectMeeting : () => {};
  const onRefresh = typeof options.onRefresh === 'function' ? options.onRefresh : async () => {};
  const escapeHtml = typeof options.escapeHtml === 'function'
    ? options.escapeHtml
    : (value) => String(value || '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
  const nowFn = typeof options.nowFn === 'function' ? options.nowFn : Date.now;
  const setIntervalFn = typeof options.setIntervalFn === 'function' ? options.setIntervalFn : setInterval;

  const root = doc.getElementById('empty-state');
  const state = {
    refreshing: false,
    lastRefreshAt: nowFn(),
    refreshError: '',
    snapshot: null,
  };

  function el(id) {
    return doc.getElementById(id);
  }

  function setText(id, value) {
    const target = el(id);
    if (target) target.textContent = String(value == null ? '' : value);
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

  function defaultPreview(item, lane) {
    if (item.preview) return shortText(item.preview);
    if (lane === 'waiting') return 'Agent 正在等待你的确认或输入';
    if (lane === 'running') return 'Agent 正在执行当前任务';
    if (item.unreadCount > 0) return '有新的完成结果尚未查看';
    return '最近完成或活动过的 Session';
  }

  function renderLane(id, items, lane) {
    const target = el(id);
    if (!target) return;
    if (!items.length) {
      const copy = lane === 'waiting'
        ? '目前没有需要你响应的任务'
        : lane === 'running'
          ? '目前没有正在运行的任务'
          : '最近 24 小时暂无完成记录';
      target.innerHTML = `<div class="home-lane-empty"><span>${escapeHtml(copy)}</span></div>`;
      return;
    }

    const visible = items.slice(0, MAX_LANE_ITEMS);
    const cards = visible.map((item) => {
      const unread = item.unreadCount > 0
        ? `<span class="home-flow-unread">${item.unreadCount > 99 ? '99+' : item.unreadCount}</span>`
        : '';
      const progress = lane === 'running'
        ? '<span class="home-flow-progress" aria-hidden="true"><i></i></span>'
        : '';
      return `<button type="button" class="home-flow-item ${lane}" data-home-type="${item.type}" data-home-id="${escapeHtml(item.id)}" aria-label="打开 ${escapeHtml(item.title)}">`
        + `<span class="home-flow-title-row"><strong>${escapeHtml(shortText(item.title, 52))}</strong>${unread}</span>`
        + `<span class="home-flow-desc">${escapeHtml(defaultPreview(item, lane))}</span>`
        + progress
        + `<span class="home-flow-meta"><span class="home-provider ${item.kind}">${escapeHtml(item.providerLabel)}</span><span>${escapeHtml(relativeTime(item.lastMessageTime))}</span></span>`
        + '</button>';
    }).join('');
    const overflow = items.length > visible.length
      ? `<div class="home-lane-more">还有 ${items.length - visible.length} 项，可在左侧列表查看</div>`
      : '';
    target.innerHTML = cards + overflow;
  }

  function formatResetIn(resetsAt) {
    if (!resetsAt) return '';
    const ms = new Date(resetsAt).getTime() - nowFn();
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const mins = Math.max(1, Math.round(ms / 60_000));
    if (mins < 60) return `${mins}m 后重置`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h${mins % 60 ? ` ${mins % 60}m` : ''} 后重置`;
    return `${Math.floor(hours / 24)}d ${hours % 24}h 后重置`;
  }

  function providerUsageRow(name, kind, usage, activeCount) {
    const window5h = usage && usage.usage5h;
    const pct = window5h && Number.isFinite(window5h.pct) ? Math.round(window5h.pct) : null;
    const reset = window5h ? formatResetIn(window5h.resetsAt) : '';
    const status = pct == null
      ? `${activeCount || 0} 活跃 · 待刷新`
      : `5h ${pct}%${reset ? ` · ${reset}` : ''}`;
    const width = pct == null ? 0 : Math.max(0, Math.min(100, pct));
    const level = pct == null ? 'unknown' : pct >= 85 ? 'danger' : pct >= 70 ? 'warn' : 'ok';
    return `<div class="home-provider-row">`
      + `<div class="home-provider-line"><span><i class="home-provider-dot ${kind}"></i><strong>${escapeHtml(name)}</strong></span><em>${escapeHtml(status)}</em></div>`
      + `<div class="home-quota-track"><span class="${level}" style="width:${width}%"></span></div>`
      + '</div>';
  }

  function moneyLabel(currency, value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return '—';
    const symbol = String(currency || '').toUpperCase() === 'CNY' ? '¥' : `${String(currency || '').toUpperCase()} `;
    return `${symbol}${amount.toFixed(2)}`;
  }

  function providerBalanceRow(name, kind, balance, activeCount, configured) {
    const hasBalance = balance && Number.isFinite(Number(balance.totalBalance));
    if (!hasBalance) {
      const status = configured ? `${activeCount || 0} 活跃 · 待刷新` : '未配置 API Key';
      return `<div class="home-provider-row balance">`
        + `<div class="home-provider-line"><span><i class="home-provider-dot ${kind}"></i><strong>${escapeHtml(name)}</strong></span><em>${escapeHtml(status)}</em></div>`
        + '<div class="home-provider-detail dim">官方余额接口 · 每 5 分钟刷新</div>'
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
      + `<div class="home-provider-detail">充值 ${escapeHtml(toppedUp)} · 赠金 ${escapeHtml(granted)} · 5 分钟刷新</div>`
      + '</div>';
  }

  function renderProviderHealth(snapshot) {
    const target = el('home-provider-health');
    if (!target) return;
    const usage = getUsageSnapshot() || {};
    const config = getHubConfig() || {};
    target.innerHTML = [
      providerUsageRow('Claude', 'claude', usage.claude, snapshot.providerActive.claude),
      providerUsageRow('Codex', 'codex', usage.codex, snapshot.providerActive.codex),
      providerUsageRow('Kimi', 'kimi', usage.kimi, snapshot.providerActive.kimi),
      providerBalanceRow('DeepSeek API', 'deepseek', usage.deepseek, snapshot.providerActive.deepseek, config.deepseekApiKeySet === true),
    ].join('');
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

  function renderSyncHealth(snapshot) {
    const config = getHubConfig() || {};
    const resources = getResourceUsage() || {};
    const configured = config.serverchanSendKeySet === true;
    const enabled = config.notificationEnabled === true;
    setSyncValue('home-sync-notification', !configured ? '未配置' : enabled ? '开启' : '已配置 · 关闭', configured && enabled ? 'ok' : 'warn');
    setSyncValue('home-sync-proxy', shortProxy(config.proxy), config.proxy ? 'ok' : 'dim');

    const terminalCount = Math.max(0, Number(getTerminalCacheSize() || 0));
    setSyncValue('home-sync-terminals', `${terminalCount} 个终端保留`, terminalCount > 0 ? 'ok' : 'dim');

    const cpu = Number.isFinite(resources.cpuPct) ? Math.round(resources.cpuPct) : null;
    const memory = Number.isFinite(resources.memoryPct) ? Math.round(resources.memoryPct) : null;
    const resourceText = cpu == null && memory == null ? '同步中' : `CPU ${cpu == null ? '--' : `${cpu}%`} · 内存 ${memory == null ? '--' : `${memory}%`}`;
    const resourceLevel = (cpu != null && cpu >= 85) || (memory != null && memory >= 85) ? 'warn' : 'ok';
    setSyncValue('home-sync-resources', resourceText, resourceLevel);

    const healthLabel = el('home-health-label');
    const healthDot = el('home-health-dot');
    const pressureHigh = resourceLevel === 'warn';
    if (healthLabel) {
      healthLabel.textContent = state.refreshError
        ? '部分状态刷新失败'
        : pressureHigh
          ? '系统负载偏高'
          : '当前 HUB 状态正常';
    }
    if (healthDot) healthDot.className = `home-status-dot ${state.refreshError || pressureHigh ? 'warn' : 'ok'}`;
  }

  function isVisible() {
    return !!(root
      && root.isConnected !== false
      && (!root.style || root.style.display !== 'none'));
  }

  function render(options = {}) {
    if (!root) return null;
    if (!options.force && !isVisible()) return state.snapshot;
    const notificationSlot = el('home-notification-slot');
    const notificationToggle = el('completion-notification-toggle');
    if (isVisible()
        && notificationSlot && notificationToggle && notificationToggle.parentElement !== notificationSlot) {
      notificationSlot.appendChild(notificationToggle);
    }
    const snapshot = buildHomeSnapshot({
      sessions: getSessions(),
      meetings: getMeetings(),
      now: nowFn(),
    });
    state.snapshot = snapshot;

    setText('home-metric-active', snapshot.metrics.active);
    setText('home-metric-waiting', snapshot.metrics.waiting);
    setText('home-metric-unread', snapshot.metrics.unread);
    setText('home-metric-dormant', snapshot.metrics.dormant);
    setText('home-waiting-count', snapshot.lanes.waiting.length);
    setText('home-running-count', snapshot.lanes.running.length);
    setText('home-delivered-count', snapshot.lanes.delivered.length);
    setText('home-last-sync', `更新于 ${new Date(state.lastRefreshAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);

    const refreshButton = el('home-refresh');
    if (refreshButton) {
      refreshButton.disabled = state.refreshing;
      refreshButton.classList.toggle('loading', state.refreshing);
      const label = refreshButton.querySelector('span');
      if (label) label.textContent = state.refreshing ? '刷新中' : '刷新';
    }

    renderLane('home-lane-waiting', snapshot.lanes.waiting, 'waiting');
    renderLane('home-lane-running', snapshot.lanes.running, 'running');
    renderLane('home-lane-delivered', snapshot.lanes.delivered, 'delivered');
    renderProviderHealth(snapshot);
    renderSyncHealth(snapshot);
    root.dataset.homeReady = 'true';
    return snapshot;
  }

  async function refresh() {
    if (state.refreshing) return false;
    state.refreshing = true;
    state.refreshError = '';
    render();
    try {
      await onRefresh();
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

  if (root) {
    root.addEventListener('click', (event) => {
      const refreshButton = event.target && event.target.closest ? event.target.closest('#home-refresh') : null;
      if (refreshButton) {
        void refresh();
        return;
      }
      activateFlowItem(event.target);
    });
    root.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (activateFlowItem(event.target)) event.preventDefault();
    });
  }

  setIntervalFn(() => {
    if (isVisible()) render();
  }, 30_000);

  return {
    render,
    refresh,
    isVisible,
    getSnapshot: () => state.snapshot,
  };
}

module.exports = {
  MAX_LANE_ITEMS,
  RECENT_WINDOW_MS,
  baseKind,
  buildHomeSnapshot,
  createHomeWorkbench,
};
