'use strict';

function createAccountUsageController({ document, window, ipcRenderer, sessions, escapeHtml, openConfigModal, setIntervalFn = setInterval, setTimeoutFn = setTimeout }) {
  if (!document) throw new Error('document is required');
  if (!ipcRenderer) throw new Error('ipcRenderer is required');
  if (!sessions) throw new Error('sessions is required');
  if (typeof escapeHtml !== 'function') throw new Error('escapeHtml is required');
  if (typeof openConfigModal !== 'function') throw new Error('openConfigModal is required');

  const accountUsage = { usage5h: null, usage7d: null };
  const agentUsage = { gemini: null, codex: null };
  const agentUsageLastSeen = { gemini: 0, codex: 0 };
  let _claudeUsageLastSeen = 0;

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
    if (payload.usage5h) {
      accountUsage.usage5h = payload.usage5h;
      _claudeUsageLastSeen = Date.now();
      const now = Date.now();
      globalUsageSamples.push({ t: now, pct: payload.usage5h.pct, totalUsedTokens: aggregateUsedTokens(now) });
      pruneSamples(globalUsageSamples, now);
    }
    if (payload.usage7d) accountUsage.usage7d = payload.usage7d;
    render();
  }

  function recordSessionContextSample(session, contextUsed) {
    if (!session || typeof contextUsed !== 'number') return;
    if (!session._tokenSamples) session._tokenSamples = [];
    session._tokenSamples.push({ t: Date.now(), used: contextUsed });
    pruneSamples(session._tokenSamples, Date.now());
  }

  function recordAgentUsage(totals) {
    if (totals && totals.gemini && (totals.gemini.usage5h || totals.gemini.usage7d)) {
      agentUsage.gemini = totals.gemini;
      agentUsageLastSeen.gemini = totals.gemini._ts || Date.now();
    }
    if (Object.prototype.hasOwnProperty.call(totals || {}, 'codex')) {
      agentUsage.codex = totals.codex;
      agentUsageLastSeen.codex = (totals.codex && totals.codex._ts) || Date.now();
    }
    render();
  }

  function applyUsageCache(cached) {
    if (!cached) cached = {};
    if (cached.claude && cached.claude.usage5h) {
      accountUsage.usage5h = cached.claude.usage5h;
      accountUsage.usage7d = cached.claude.usage7d;
      if (cached.claude.ts) _claudeUsageLastSeen = cached.claude.ts;
    }
    if (cached.gemini) agentUsage.gemini = cached.gemini;
    if (cached.gemini && cached.gemini.ts) agentUsageLastSeen.gemini = cached.gemini.ts;
    if (cached.codex) agentUsage.codex = cached.codex;
    if (cached.codex && cached.codex.ts) agentUsageLastSeen.codex = cached.codex.ts;
    if (cached.packy) packyAccountData = cached.packy;
    render();
  }

  function formatResetIn(resetsAt) {
    if (!resetsAt) return '';
    const ms = new Date(resetsAt).getTime() - Date.now();
    if (isNaN(ms) || ms <= 0) return '';
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h < 24) return `${h}h${m ? ' ' + m + 'm' : ''}`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }
  
  // PackyAPI 账户数据(余额 / 今日消耗 / 累计消耗) - main 后台 5min 拉取后通过 IPC 推送
  let packyAccountData = null;
  
  function render() {
    const el = document.getElementById('account-usage');
    if (!el) return;
    el.style.display = 'block';
  
    const pctCls = (pct) => pct >= 85 ? 'danger' : pct >= 70 ? 'warn' : 'ok';
  
    const renderBar = (label, u) => {
      const resetTxt = u && u.resetsAt ? formatResetIn(u.resetsAt) : '';
      const resetHtml = resetTxt
        ? `<span class="acc-bar-reset" title="距离 ${label} 配额刷新还有 ${resetTxt}">${resetTxt}</span>`
        : `<span class="acc-bar-reset"></span>`;
      if (!u || u.pct === null || u.pct === undefined) {
        return `<div class="acc-bar-line"><span class="acc-bar-label">${label}</span><div class="acc-bar-track"><div class="acc-bar-fill dim" style="width:0%"></div></div><span class="acc-bar-pct dim">—</span>${resetHtml}</div>`;
      }
      const pct = Math.round(u.pct);
      const cls = pctCls(pct);
      const w = Math.max(2, pct);
      return `<div class="acc-bar-line"><span class="acc-bar-label">${label}</span><div class="acc-bar-track"><div class="acc-bar-fill ${cls}" style="width:${w}%"></div></div><span class="acc-bar-pct ${cls}">${pct}%</span>${resetHtml}</div>`;
    };
  
    const logoSrc = (badgeClass) => {
      if (badgeClass === 'cl') return 'assets/ai-logos/claude.svg';
      if (badgeClass === 'cx') return 'assets/ai-logos/codex.svg';
      return '';
    };
    const renderUsageRow = (badgeClass, name, u5h, u7d, meta = {}) => {
      const src = logoSrc(badgeClass);
      const logoHtml = src
        ? `<img class="acc-ai-logo" src="${src}" alt="${escapeHtml(name)}" title="${escapeHtml(name)}">`
        : `<span class="acc-ai-letters">${badgeClass.toUpperCase()}</span>`;
      const title = meta.profileLabel ? `${name} · ${meta.profileLabel}` : name;
      return `
        <div class="acc-usage-row" title="${escapeHtml(title)}">
          <span class="acc-ai-badge ${badgeClass}">${logoHtml}</span>
          <div class="acc-bars">
            ${renderBar('5h', u5h)}
            ${renderBar('7d', u7d)}
          </div>
        </div>
      `;
    };
  
    const renderPackyRow = (data) => {
      if (!data || !data.enabled) {
        return `<div class="acc-packy-row no-cookie clickable" data-action="open-packy-settings" title="点击打开设置 → 填 PackyAPI cookie 启用余额监控">
          <span class="acc-packy-icon">$</span>
          <div class="acc-packy-text">
            <div class="acc-packy-balance-line"><span class="acc-packy-balance">未接入</span></div>
            <div class="acc-packy-spend-line">点击此处填 cookie</div>
          </div>
        </div>`;
      }
      const fmt = (n) => '$' + (typeof n === 'number' ? n.toFixed(2) : '—');
      if (data.error && (data.balanceUsd === null || data.balanceUsd === undefined)) {
        return `<div class="acc-packy-row error clickable" data-action="open-packy-settings" title="${escapeHtml(data.error)} · 点击打开设置重填 cookie">
          <span class="acc-packy-icon">!</span>
          <div class="acc-packy-text">
            <div class="acc-packy-balance-line"><span class="acc-packy-balance">cookie 失效</span></div>
            <div class="acc-packy-spend-line">今日 ${fmt(data.todayUsd)} · 点击重填</div>
          </div>
        </div>`;
      }
      const balance = (data.balanceUsd !== null && data.balanceUsd !== undefined) ? fmt(data.balanceUsd) : '—';
      const total = (data.usedUsd !== null && data.usedUsd !== undefined) ? fmt(data.usedUsd) : '—';
      // 注:packyapi 的 /v1/dashboard/billing/usage 端点不响应 date 参数,
      // 无法做"今日 vs 累计"的区分。只显示累计消耗,避免数据相同造成误导。
      return `<div class="acc-packy-row" title="PackyAPI · ${escapeHtml(data.displayName || '账户')}">
        <span class="acc-packy-icon">¥</span>
        <div class="acc-packy-text">
          <div class="acc-packy-balance-line">
            <span class="acc-packy-balance">${balance}</span>
            <span class="acc-packy-balance-label">余额</span>
          </div>
          <div class="acc-packy-spend-line">
            <span>累计消耗 <span class="acc-packy-spend-today">${total}</span></span>
          </div>
        </div>
        <button class="acc-packy-topup" data-action="packy-topup">充值</button>
      </div>`;
    };
  
    const c = agentUsage.codex || {};
    el.innerHTML =
      renderUsageRow('cl', 'Claude', accountUsage.usage5h, accountUsage.usage7d) +
      renderUsageRow('cx', 'Codex', c.usage5h, c.usage7d, c) +
      renderPackyRow(packyAccountData);
  
    // 充值按钮 — 打开 packyapi console
    const topupBtn = el.querySelector('[data-action="packy-topup"]');
    if (topupBtn) {
      topupBtn.addEventListener('click', () => {
        ipcRenderer.invoke('open-external-url', 'https://www.packyapi.com/console').catch(() => {
          window.open('https://www.packyapi.com/console', '_blank');
        });
      });
    }
    // 未接入 / cookie 失效 整行可点击 → 打开设置并定位到 cookie 输入框
    el.querySelectorAll('[data-action="open-packy-settings"]').forEach(row => {
      row.addEventListener('click', async () => {
        try {
          await openConfigModal();
          const cookieEl = document.getElementById('cfg-packy-cookie');
          if (cookieEl) {
            cookieEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            setTimeoutFn(() => cookieEl.focus(), 200);
          }
        } catch {}
      });
    });
  }
  
  ipcRenderer.on('packy-account-updated', (_e, data) => {
    packyAccountData = data;
    render();
  });
  
  setIntervalFn(render, 60000);
  
  function pctClass(pct) {
    if (pct >= 85) return 'danger';
    if (pct >= 70) return 'warn';
    return 'ok';
  }

  return {
    render,
    sessionBurnRate,
    pctClass,
    recordSessionContextSample,
    recordStatusUsage,
    recordAgentUsage,
    applyUsageCache,
  };
}

module.exports = { createAccountUsageController };
