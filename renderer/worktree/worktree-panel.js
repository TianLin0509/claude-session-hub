'use strict';
(() => {
  const { ipcRenderer, shell } = require('electron');
  const path = require('path');

  const PANEL_OPEN_KEY_PREFIX = 'wt-panel-open-';
  const REFRESH_INTERVAL_MS = 30000;
  const STATUS_DEBOUNCE_MS = 500;

  const panel = document.getElementById('worktree-panel');
  const refreshBtn = document.getElementById('wt-refresh-btn');
  const closeBtn = document.getElementById('wt-close-btn');
  const errorEl = document.getElementById('wt-error');

  let currentSessionId = null;
  let pollTimer = null;
  let debounceTimer = null;

  function isOpen(sessionId) {
    return localStorage.getItem(PANEL_OPEN_KEY_PREFIX + sessionId) === 'true';
  }
  function setOpen(sessionId, open) {
    localStorage.setItem(PANEL_OPEN_KEY_PREFIX + sessionId, String(open));
  }

  async function refresh({ force = false } = {}) {
    if (!currentSessionId) return;
    const requestSessionId = currentSessionId;  // snapshot
    const cur = document.getElementById('wt-current');
    if (cur) cur.classList.add('wt-loading');
    let res;
    try {
      res = await ipcRenderer.invoke('worktree:probe', {
        activeSessionId: requestSessionId, force,
      });
    } catch (e) {
      if (currentSessionId !== requestSessionId) return;  // session changed during await
      showError(`IPC 异常: ${e.message}`, true);
      return;
    } finally {
      if (cur) cur.classList.remove('wt-loading');
    }
    if (currentSessionId !== requestSessionId) return;  // stale response, drop
    if (!res.ok) {
      if (/timeout/i.test(res.error)) showError(`git 响应超时`, true);
      else if (/not.*git/i.test(res.error)) showError(`目录不在 git 仓库内`, false);
      else showError(`加载失败: ${res.error}`, true);
      return;
    }
    errorEl.style.display = 'none';
    render(res.data);
  }

  function showError(msg, retryable) {
    errorEl.style.display = '';
    errorEl.innerHTML = `${escapeHtml(msg)}${retryable ? ` <button class="wt-retry">重试</button>` : ''}`;
    const retry = errorEl.querySelector('.wt-retry');
    if (retry) retry.addEventListener('click', () => refresh({ force: true }));
  }

  function render(data) {
    const { active, peers, worktreeList, conflict } = data;
    document.querySelector('.wt-status-dot').dataset.status = conflict.color;
    document.getElementById('wt-repo-name').textContent =
      active && active.repoRoot ? path.basename(active.repoRoot) : (active && active.cwd ? active.cwd : '—');
    document.getElementById('wt-session-count').textContent =
      `${peers.length + (active ? 1 : 0)} sessions`;

    renderHealth(conflict, peers, active);
    renderTopology(worktreeList, peers, active);
    renderCurrent(active);
    renderPeers(peers, conflict);
  }

  function renderHealth(conflict, peers, active) {
    const root = document.getElementById('wt-health');
    const reds = conflict.color === 'red' ? 1 : 0;
    const yellows = conflict.color === 'yellow' ? 1 : 0;
    const greens = peers.length + 1 - reds - yellows;
    const dirtyTotal = (active?.dirty?.length || 0) +
      peers.reduce((acc, p) => acc + (p.dirty?.length || 0), 0);
    root.innerHTML = `
      <div class="wt-health-bar">
        ${reds ? `<div class="seg seg-red" style="flex:${reds}"></div>` : ''}
        ${yellows ? `<div class="seg seg-yellow" style="flex:${yellows}"></div>` : ''}
        ${greens > 0 ? `<div class="seg seg-green" style="flex:${greens}"></div>` : ''}
      </div>
      <div class="wt-pills">
        ${conflict.color === 'red' ? `<span class="wt-pill wt-pill-red">⚠ 撞车</span>` : ''}
        ${dirtyTotal > 0 ? `<span class="wt-pill wt-pill-yellow">${dirtyTotal} 未提交</span>` : ''}
        <span class="wt-pill wt-pill-green">${peers.length + 1} sessions</span>
      </div>
    `;
  }

  function renderTopology(worktreeList, peers, active) {
    const root = document.getElementById('wt-topology');
    if (!worktreeList || worktreeList.length === 0) { root.innerHTML = ''; return; }
    const sessionByCwd = new Map();
    [active, ...peers].filter(s => s && s.cwd).forEach(s => {
      const k = s.cwd;
      if (!sessionByCwd.has(k)) sessionByCwd.set(k, []);
      sessionByCwd.get(k).push(s);
    });
    const rows = worktreeList.map(wt => {
      const sessions = sessionByCwd.get(wt.cwd) || [];
      const hasConflict = sessions.length > 1;
      return `
        <div class="wt-tp-row" data-conflict="${hasConflict ? 'red' : 'green'}">
          <span class="wt-tp-branch">⎇ ${escapeHtml(wt.branch || 'detached')}</span>
          → <span class="wt-tp-cwd">${escapeHtml(wt.cwd)}</span>
          <div class="wt-tp-sessions">↳ ${sessions.map(s => escapeHtml(s.sessionLabel || s.sessionId)).join(' · ') || '(无 active)'}</div>
        </div>
      `;
    }).join('');
    root.innerHTML = `<div class="wt-section-label">工作树拓扑</div>${rows}`;
  }

  function renderCurrent(active) {
    const root = document.getElementById('wt-current');
    if (!active || !active.isRepo) {
      root.innerHTML = `
        <div class="wt-section-label">当前</div>
        <div class="wt-cwd-row">
          <span class="wt-cwd" data-cwd="${escapeHtml(active?.cwd || '')}">${escapeHtml(active?.cwd || '—')}</span>
          <button class="wt-open-explorer" data-cwd="${escapeHtml(active?.cwd || '')}" title="资源管理器">↗</button>
        </div>
        <div style="color: var(--text-muted); font-size: 10.5px;">📁 非 git 目录</div>
      `;
      return;
    }
    const filesHtml = (active.dirty || []).map(d => `
      <div class="wt-file" data-status="${escapeHtml(d.status)}" data-path="${escapeHtml(d.path)}">
        <span class="wt-stat-letter">${escapeHtml(d.status)}</span>
        <span class="wt-fname">${escapeHtml(d.path)}</span>
      </div>
    `).join('');
    root.innerHTML = `
      <div class="wt-section-label">当前 · ${escapeHtml(active.sessionLabel || active.sessionId || '')}</div>
      <div class="wt-cwd-row">
        <span class="wt-cwd" data-cwd="${escapeHtml(active.cwd)}" title="点击复制">${escapeHtml(active.cwd)}</span>
        <button class="wt-open-explorer" data-cwd="${escapeHtml(active.cwd)}" title="资源管理器">↗</button>
      </div>
      <div class="wt-meta">
        <span class="wt-pill wt-pill-yellow">⎇ ${escapeHtml(active.branch || '?')}</span>
        ${active.ahead || active.behind ? `<span class="wt-pill wt-pill-green">↑${active.ahead} ↓${active.behind}</span>` : ''}
        ${active.dirty?.length ? `<span class="wt-pill wt-pill-yellow">${active.dirty.length} 未提交</span>` : ''}
      </div>
      ${active.lastCommit ? `
        <div class="wt-commit-graph">
          <div class="wt-commit">● <span class="wt-commit-old">${escapeHtml(active.lastCommit.hash)}</span> ${escapeHtml(active.lastCommit.subject)} <span class="wt-commit-line">${escapeHtml(active.lastCommit.when)}</span></div>
        </div>
      ` : ''}
      <div class="wt-files">${filesHtml}</div>
    `;
  }

  function renderPeers(peers, conflict) {
    const root = document.getElementById('wt-peers');
    if (peers.length === 0) {
      root.innerHTML = `<div class="wt-section-label">同仓库 peer · 0 个</div>`;
      return;
    }
    const cards = peers.map(p => {
      const reasons = (conflict.reasons || []).filter(r => r.includes(p.sessionId || p.cwd));
      const cardColor = reasons.length > 0 ? (/同 cwd|改同文件/.test(reasons[0]) ? 'red' : 'yellow') : 'green';
      const cwdShort = p.cwd?.replace(/^.*[\\/]/, '…/') || '';
      return `
        <div class="wt-peer-card" data-conflict="${cardColor}" data-session-id="${escapeHtml(p.sessionId || '')}">
          <div class="wt-peer-head">
            <span class="wt-status-dot" data-status="${cardColor}"></span>
            <strong>${escapeHtml(p.sessionLabel || p.sessionId || '')}</strong>
          </div>
          <div class="wt-peer-meta">
            ${escapeHtml(cwdShort)} · ⎇ ${escapeHtml(p.branch || '?')}${p.dirty?.length ? ` · ${p.dirty.length} 未提交` : ' · 干净'}
          </div>
          ${reasons.length ? `<div class="wt-peer-reason">⚠ ${escapeHtml(reasons[0])}</div>` : ''}
        </div>
      `;
    }).join('');
    root.innerHTML = `<div class="wt-section-label">同仓库 peer · ${peers.length} 个</div>${cards}`;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ─── Click delegation ───
  panel.addEventListener('click', async (e) => {
    const explorerBtn = e.target.closest('.wt-open-explorer');
    if (explorerBtn) {
      const cwd = explorerBtn.dataset.cwd;
      if (cwd) await ipcRenderer.invoke('worktree:open-explorer', { cwd });
      return;
    }
    const cwdEl = e.target.closest('.wt-cwd');
    if (cwdEl) {
      try { await navigator.clipboard.writeText(cwdEl.dataset.cwd); } catch (_) {}
      return;
    }
    const peerCard = e.target.closest('.wt-peer-card');
    if (peerCard) {
      const sid = peerCard.dataset.sessionId;
      if (sid && typeof window.selectSession === 'function') window.selectSession(sid);
      return;
    }
    const fileRow = e.target.closest('.wt-file');
    if (fileRow) {
      const filePath = fileRow.dataset.path;
      if (filePath && typeof window.openWorktreeDiffPreview === 'function') {
        window.openWorktreeDiffPreview(filePath);
      }
      return;
    }
  });

  refreshBtn.addEventListener('click', () => refresh({ force: true }));
  closeBtn.addEventListener('click', () => {
    panel.style.display = 'none';
    setOpen(currentSessionId, false);
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  });

  // ─── Public API for renderer.js to call ───
  window.worktreePanel = {
    onSessionChange(sessionId) {
      currentSessionId = sessionId;
      if (sessionId && isOpen(sessionId)) {
        panel.style.display = '';
        refresh({ force: false });
        if (!pollTimer) pollTimer = setInterval(() => refresh(), REFRESH_INTERVAL_MS);
      } else {
        panel.style.display = 'none';
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      }
    },
    toggle() {
      if (!currentSessionId) return;
      const next = panel.style.display === 'none';
      panel.style.display = next ? '' : 'none';
      setOpen(currentSessionId, next);
      if (next) {
        refresh({ force: false });
        if (!pollTimer) pollTimer = setInterval(() => refresh(), REFRESH_INTERVAL_MS);
      } else {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      }
    },
    notifyStatusEvent() {
      // debounced refresh on statusline tick
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => refresh({ force: false }), STATUS_DEBOUNCE_MS);
    },
  };

  // ─── Window focus → refresh ───
  window.addEventListener('focus', () => {
    if (panel.style.display !== 'none') refresh({ force: false });
  });
})();
