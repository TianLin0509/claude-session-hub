'use strict';

function createAccountUsageController({
  document,
  ipcRenderer,
  sessions,
  escapeHtml,
  setIntervalFn = setInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  nowFn = Date.now,
  isMemoOpen = () => false,
}) {
  if (!document) throw new Error('document is required');
  if (!ipcRenderer) throw new Error('ipcRenderer is required');
  if (!sessions) throw new Error('sessions is required');
  if (typeof escapeHtml !== 'function') throw new Error('escapeHtml is required');

  const accountUsage = { usage5h: null, usage7d: null };
  const agentUsage = { gemini: null, codex: null, kimi: null, deepseek: null };
  const agentUsageLastSeen = { gemini: 0, codex: 0, kimi: 0, deepseek: 0 };
  let _claudeUsageLastSeen = 0;
  const usageRefreshState = { inFlight: false, error: null, lastManualAt: 0, providerResults: null };
  let _refreshStatusTimer = null;

  const BURN_HISTORY_MS = 15 * 60 * 1000;
  const globalUsageSamples = []; // [{t, pct, totalUsedTokens}]
  const DEFAULT_TOKENS_PER_PCT = 2_000_000; // fallback baseline if we have no delta
  
  function pruneSamples(arr, now) {
    const cutoff = now - BURN_HISTORY_MS;
    while (arr.length && arr[0].t < cutoff) arr.shift();
  }
  
  function aggregateUsedTokens(now) {
    let total = 0;
    for (const s of sessions.values()) {
      // Use each session's most recent contextUsed as a proxy. Not perfect —
      // but good enough to attribute ratably.
      if (typeof s.contextUsed === 'number') total += s.contextUsed;
    }
    return total;
  }
  
  function estimateTokensPerPct() {
    // Find two global samples far enough apart with a positive pct delta.
    for (let i = globalUsageSamples.length - 1; i >= 1; i--) {
      const a = globalUsageSamples[i];
      for (let j = i - 1; j >= 0; j--) {
        const b = globalUsageSamples[j];
        if (a.t - b.t < 60 * 1000) continue; // need ≥1 min spread
        const dp = a.pct - b.pct;
        const dt = a.totalUsedTokens - b.totalUsedTokens;
        if (dp > 0.3 && dt > 0) return dt / dp;
      }
    }
    return DEFAULT_TOKENS_PER_PCT;
  }
  
  function sessionBurnRate(session) {
    const samples = session._tokenSamples;
    if (!samples || samples.length < 2) return null;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const dt = last.t - first.t;
    if (dt < 60 * 1000) return null;
    const dTokens = last.used - first.used;
    if (dTokens <= 0) return null;
    const tokensPerMin = dTokens / (dt / 60000);
    const tokensPerPct = estimateTokensPerPct();
    const pctPerHour = (tokensPerMin * 60) / tokensPerPct;
    return { tokensPerMin, pctPerHour };
  }

  function recordStatusUsage(payload) {
    if (!payload) return;
    if (payload.usage5h || payload.usage7d) _claudeUsageLastSeen = payload.observedAt || nowFn();
    if (payload.usage5h) {
      accountUsage.usage5h = payload.usage5h;
      const now = nowFn();
      globalUsageSamples.push({ t: now, pct: payload.usage5h.pct, totalUsedTokens: aggregateUsedTokens(now) });
      pruneSamples(globalUsageSamples, now);
    }
    if (payload.usage7d) accountUsage.usage7d = payload.usage7d;
    render();
  }

  function recordSessionContextSample(session, contextUsed) {
    if (!session || typeof contextUsed !== 'number') return;
    if (!session._tokenSamples) session._tokenSamples = [];
    session._tokenSamples.push({ t: nowFn(), used: contextUsed });
    pruneSamples(session._tokenSamples, nowFn());
  }

  function recordAgentUsage(totals) {
    if (totals && totals.gemini && (totals.gemini.usage5h || totals.gemini.usage7d)) {
      agentUsage.gemini = totals.gemini;
      agentUsageLastSeen.gemini = totals.gemini.observedAt || totals.gemini._ts || nowFn();
    }
    if (Object.prototype.hasOwnProperty.call(totals || {}, 'codex')) {
      agentUsage.codex = totals.codex;
      agentUsageLastSeen.codex = (totals.codex && (totals.codex.observedAt || totals.codex._ts)) || nowFn();
    }
    if (Object.prototype.hasOwnProperty.call(totals || {}, 'kimi')) {
      agentUsage.kimi = totals.kimi;
      agentUsageLastSeen.kimi = (totals.kimi && (totals.kimi.observedAt || totals.kimi._ts)) || nowFn();
    }
    if (Object.prototype.hasOwnProperty.call(totals || {}, 'deepseek')) {
      agentUsage.deepseek = totals.deepseek;
      agentUsageLastSeen.deepseek = (totals.deepseek && (totals.deepseek.observedAt || totals.deepseek._ts)) || nowFn();
    }
    render();
  }

  function applyUsageCache(cached) {
    if (!cached) cached = {};
    if (cached.claude && cached.claude.usage5h) {
      accountUsage.usage5h = cached.claude.usage5h;
      accountUsage.usage7d = cached.claude.usage7d;
      _claudeUsageLastSeen = cached.claude.observedAt || cached.claude.ts || _claudeUsageLastSeen;
    }
    if (cached.gemini) agentUsage.gemini = cached.gemini;
    if (cached.gemini) agentUsageLastSeen.gemini = cached.gemini.observedAt || cached.gemini.ts || agentUsageLastSeen.gemini;
    if (cached.codex) agentUsage.codex = cached.codex;
    if (cached.codex) agentUsageLastSeen.codex = cached.codex.observedAt || cached.codex.ts || agentUsageLastSeen.codex;
    if (cached.kimi) agentUsage.kimi = cached.kimi;
    if (cached.kimi) agentUsageLastSeen.kimi = cached.kimi.observedAt || cached.kimi.ts || agentUsageLastSeen.kimi;
    if (cached.deepseek) agentUsage.deepseek = cached.deepseek;
    if (cached.deepseek) agentUsageLastSeen.deepseek = cached.deepseek.observedAt || cached.deepseek.ts || agentUsageLastSeen.deepseek;
    render();
  }

  function formatResetIn(resetsAt) {
    if (!resetsAt) return '';
    const ms = new Date(resetsAt).getTime() - nowFn();
    if (isNaN(ms) || ms <= 0) return '';
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h < 24) return `${h}h${m ? ' ' + m + 'm' : ''}`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }

  function formatAge(ts) {
    if (!ts) return '未刷新';
    const ms = Math.max(0, nowFn() - ts);
    const sec = Math.floor(ms / 1000);
    if (sec < 45) return '刚刚';
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  }

  function usageFreshnessClass(ts) {
    if (!ts) return 'unknown';
    return nowFn() - ts > 2 * 60 * 1000 ? 'stale' : 'fresh';
  }

  function refreshUsageNow() {
    if (usageRefreshState.inFlight) return Promise.resolve(null);
    usageRefreshState.inFlight = true;
    usageRefreshState.error = null;
    render();
    return Promise.resolve(ipcRenderer.invoke('refresh-usage-now'))
      .then((result) => {
        usageRefreshState.providerResults = result && result.providerResults || null;
        const codexResult = usageRefreshState.providerResults && usageRefreshState.providerResults.codex;
        if (codexResult && (!codexResult.ok || codexResult.degraded)) {
          usageRefreshState.error = `Codex: ${codexResult.error || '实时接口不可用，已降级到本地快照'}`;
        }
        usageRefreshState.lastManualAt = (result && result.refreshedAt) || nowFn();
        if (_refreshStatusTimer !== null) clearTimeoutFn(_refreshStatusTimer);
        _refreshStatusTimer = setTimeoutFn(() => {
          _refreshStatusTimer = null;
          render();
        }, Math.max(1, usageRefreshState.lastManualAt + 60_001 - nowFn()));
        if (result && result.cache) applyUsageCache(result.cache);
        if (result && result.agentData) recordAgentUsage(result.agentData);
        return result;
      })
      .catch((err) => {
        usageRefreshState.error = err && err.message ? err.message : '刷新失败';
        throw err;
      })
      .finally(() => {
        usageRefreshState.inFlight = false;
        render();
      });
  }
  
  function render() {
    // 2026-07-19 道雪 · 方案C：用量面板从侧栏迁移为顶部全局 ticker。
    // 每个官方返回的窗口都显示「用量% + 重置时间」。某些 Codex Pro
    // 账户当前只返回 7d bucket；5h 保留占位但不能拿 7d 数据冒充。
    const el = document.getElementById('quota-ticker');
    if (!el) return;
    el.style.display = 'flex';
  
    const pctCls = (pct) => pct >= 85 ? 'danger' : pct >= 70 ? 'warn' : 'ok';
  
    const renderWindow = (fallbackLabel, usage) => {
      const label = usage && usage.label ? usage.label : fallbackLabel;
      const resetTxt = usage && usage.resetsAt ? formatResetIn(usage.resetsAt) : '';
      const pct = usage && typeof usage.pct === 'number' ? Math.round(usage.pct) : null;
      const cls = pct == null ? 'dim' : pctCls(pct);
      const resetTitle = resetTxt ? `距离 ${label} 配额刷新还有 ${resetTxt}` : `${label} 重置时间未知`;
      // 重置时间未知时不再占位显示「↻—」：一行里少一半噪声。
      const reset = resetTxt ? `<em title="${escapeHtml(resetTitle)}">↻${escapeHtml(resetTxt)}</em>` : '';
      return `<span class="qt-win ${cls}" title="${escapeHtml(resetTitle)}"><i>${escapeHtml(label)}</i>`
        + `<b>${pct == null ? '—' : `${pct}%`}</b>${reset}</span>`;
    };

    const renderSeg = (name, u5h, u7d, meta = {}) => {
      const title = meta.profileLabel ? `${name} · ${meta.profileLabel}` : name;
      const visibleName = meta.profileLabel ? `${name}·${meta.profileLabel}` : name;
      const age = formatAge(meta.lastSeen || 0);
      const source = meta.source ? ` · ${meta.source}` : '';
      const accountLabel = meta.accountEmail || '';
      const refreshError = meta.refreshError ? ` · 刷新异常: ${meta.refreshError}` : '';
      const tip = `${title} · 数据更新于 ${age}前${source}${accountLabel ? ` · ${accountLabel}` : ''}${refreshError}`;
      return `<span class="qt-seg" data-provider="${escapeHtml(name.toLowerCase())}" title="${escapeHtml(tip)}"><span class="qt-name">${escapeHtml(visibleName)}</span>${renderWindow('5h', u5h)}${renderWindow('7d', u7d)}</span>`;
    };

    // 2026-08-27：ticker 只留三样——Claude 用量、Codex 用量、DeepSeek 余额。
    // Kimi 段撤掉（数据仍在采，工作台的「四模型用量」里看得到），顶栏是每天都要瞄的
    // 一行，塞四家反而没有一样看得清。
    const renderBalance = (name, balance, meta = {}) => {
      const has = balance && Number.isFinite(Number(balance.totalBalance));
      const age = formatAge(meta.lastSeen || 0);
      if (!has) {
        return `<span class="qt-seg qt-balance" data-provider="deepseek" title="${escapeHtml(name)} 余额未获取 · 数据更新于 ${escapeHtml(age)}前">`
          + `<span class="qt-name">${escapeHtml(name)}</span><span class="qt-win dim"><b>—</b></span></span>`;
      }
      const total = Number(balance.totalBalance);
      const currency = String(balance.currency || 'CNY').toUpperCase();
      const symbol = currency === 'CNY' ? '¥' : `${currency} `;
      const available = balance.available !== false;
      const cls = !available || total < 10 ? 'danger' : total < 30 ? 'warn' : 'ok';
      const tip = `${name} 余额 ${symbol}${total.toFixed(2)}`
        + `${available ? '' : ' · 当前不可用'} · 数据更新于 ${age}前`;
      return `<span class="qt-seg qt-balance" data-provider="deepseek" title="${escapeHtml(tip)}">`
        + `<span class="qt-name">${escapeHtml(name)}</span>`
        + `<span class="qt-win ${cls}"><i>余额</i><b>${escapeHtml(symbol + total.toFixed(2))}</b></span></span>`;
    };

    const c = agentUsage.codex || {};
    const d = agentUsage.deepseek || {};
    const refreshTitle = usageRefreshState.error
      ? `刷新账户用量 · 上次失败: ${usageRefreshState.error}`
      : '刷新 Claude、Codex 用量与 DeepSeek 余额';
    // freshness 取顶栏在显示的三家里最旧的（保守）：任一过期则整灯变橙。
    const lastSeens = [_claudeUsageLastSeen, agentUsageLastSeen.codex, agentUsageLastSeen.deepseek].filter(Boolean);
    const oldest = lastSeens.length ? Math.min(...lastSeens) : 0;
    const freshCls = usageFreshnessClass(oldest);
    const ageTxt = lastSeens.length ? formatAge(oldest) : '未刷新';
    el.innerHTML =
      `<span class="qt-cap">用量</span>` +
      renderSeg('Claude', accountUsage.usage5h, accountUsage.usage7d, {
        lastSeen: _claudeUsageLastSeen,
        source: 'statusline',
      }) +
      `<span class="qt-div"></span>` +
      renderSeg('Codex', c.usage5h, c.usage7d, {
        ...c,
        lastSeen: agentUsageLastSeen.codex,
        refreshError: usageRefreshState.providerResults && usageRefreshState.providerResults.codex
          && usageRefreshState.providerResults.codex.error,
      }) +
      `<span class="qt-div"></span>` +
      renderBalance('DeepSeek', d.balance || d, { lastSeen: agentUsageLastSeen.deepseek }) +
      `<span class="qt-right"><span class="qt-fresh ${freshCls}" title="数据更新于 ${escapeHtml(ageTxt)}前（取三家最旧）"></span><span class="qt-age">${escapeHtml(ageTxt)}</span>` +
      `<button class="qt-memory btn-memo-toggle${isMemoOpen() ? ' active' : ''}" data-action="open-memo" title="打开备忘录" aria-label="打开备忘录">备忘录</button>` +
      `<button class="qt-refresh${usageRefreshState.inFlight ? ' loading' : ''}" data-action="refresh-usage" title="${escapeHtml(refreshTitle)}" aria-label="刷新账户用量">${usageRefreshState.inFlight ? '刷新中' : '⟳ 刷新'}</button></span>`;
  
    el.querySelectorAll('[data-action="refresh-usage"]').forEach(refreshBtn => {
      refreshBtn.addEventListener('click', (event) => {
        event.preventDefault();
        refreshUsageNow().catch(() => {});
      });
    });

  }
  
  setIntervalFn(render, 60000);
  
  function pctClass(pct) {
    if (pct >= 85) return 'danger';
    if (pct >= 70) return 'warn';
    return 'ok';
  }

  function getSnapshot() {
    return {
      claude: {
        usage5h: accountUsage.usage5h,
        usage7d: accountUsage.usage7d,
        lastSeen: _claudeUsageLastSeen,
      },
      codex: agentUsage.codex ? { ...agentUsage.codex, lastSeen: agentUsageLastSeen.codex } : null,
      gemini: agentUsage.gemini ? { ...agentUsage.gemini, lastSeen: agentUsageLastSeen.gemini } : null,
      kimi: agentUsage.kimi ? { ...agentUsage.kimi, lastSeen: agentUsageLastSeen.kimi } : null,
      deepseek: agentUsage.deepseek ? { ...agentUsage.deepseek, lastSeen: agentUsageLastSeen.deepseek } : null,
      refresh: {
        inFlight: usageRefreshState.inFlight,
        error: usageRefreshState.error,
        lastManualAt: usageRefreshState.lastManualAt,
      },
    };
  }

  return {
    render,
    getSnapshot,
    sessionBurnRate,
    pctClass,
    recordSessionContextSample,
    recordStatusUsage,
    recordAgentUsage,
    applyUsageCache,
    refreshUsageNow,
  };
}

module.exports = { createAccountUsageController };
