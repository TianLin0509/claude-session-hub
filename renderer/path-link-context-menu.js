'use strict';

// Right-click context menu for <a class="rt-file-link"> elements.
// 5 actions: copy-abs-path / copy-file / sync-company / show-in-folder / open-external.
// URL links show only copy + open-external; file-only items hidden via [data-file-only].

function createPathLinkContextMenuController({
  document,
  window,
  menuEl,
  clipboard,
  shell,
  ipcRenderer,
  normalizeLocalPathForOpen,
  getSessionCwd,
  getActiveSessionId,
  pushToChatgpt,
  requestAnimationFrameFn = requestAnimationFrame,
}) {
  let currentTarget = null;
  let syncToastEl = null;
  let syncToastTimer = null;

  function showSyncStatus(message, state = 'working') {
    if (!document.body || typeof document.createElement !== 'function') return;
    if (!syncToastEl) {
      syncToastEl = document.createElement('div');
      syncToastEl.id = 'path-link-sync-status';
      syncToastEl.setAttribute('role', 'status');
      syncToastEl.setAttribute('aria-live', 'polite');
      Object.assign(syncToastEl.style, {
        position: 'fixed',
        right: '24px',
        bottom: '24px',
        zIndex: '12000',
        maxWidth: '420px',
        padding: '12px 16px',
        borderRadius: '12px',
        color: '#fff',
        fontSize: '13px',
        lineHeight: '1.55',
        whiteSpace: 'pre-line',
        boxShadow: '0 10px 32px rgba(0,0,0,.28)',
        transition: 'opacity .18s ease, transform .18s ease',
      });
      document.body.appendChild(syncToastEl);
    }
    if (syncToastTimer) {
      window.clearTimeout(syncToastTimer);
      syncToastTimer = null;
    }
    syncToastEl.textContent = message;
    syncToastEl.dataset.state = state;
    syncToastEl.style.background = state === 'error' ? '#9f2d2d' : (state === 'success' ? '#0f766e' : '#273b37');
    syncToastEl.style.opacity = '1';
    syncToastEl.style.transform = 'translateY(0)';
    if (state !== 'working') {
      syncToastTimer = window.setTimeout(() => {
        syncToastEl.style.opacity = '0';
        syncToastEl.style.transform = 'translateY(8px)';
      }, state === 'error' ? 7000 : 5000);
    }
  }

  function resolveTarget(rawPath) {
    if (!rawPath) return null;
    const trimmed = String(rawPath).trim();
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed)) {
      return { absPath: trimmed, isUrl: true };
    }
    // If already an absolute Windows path or POSIX absolute, no cwd needed.
    const cwd = getSessionCwd(getActiveSessionId());
    const full = normalizeLocalPathForOpen(trimmed, cwd, false);
    if (!full) return null;
    return { absPath: full, isUrl: false };
  }

  function open(rawPath, x, y) {
    const t = resolveTarget(rawPath);
    if (!t) return false;
    currentTarget = t;

    for (const el of menuEl.querySelectorAll('[data-file-only]')) {
      el.style.display = t.isUrl ? 'none' : '';
    }
    const copyBtn = menuEl.querySelector('[data-action="copy-abs-path"]');
    if (copyBtn) {
      copyBtn.textContent = t.isUrl
        ? (copyBtn.dataset.labelUrl || '复制 URL')
        : (copyBtn.dataset.labelFile || '复制绝对路径');
    }

    menuEl.style.display = 'block';
    menuEl.style.left = `${x}px`;
    menuEl.style.top = `${y}px`;
    requestAnimationFrameFn(() => {
      const rect = menuEl.getBoundingClientRect();
      if (rect.right > window.innerWidth) menuEl.style.left = `${x - rect.width}px`;
      if (rect.bottom > window.innerHeight) menuEl.style.top = `${y - rect.height}px`;
    });
    return true;
  }

  function close() {
    menuEl.style.display = 'none';
    currentTarget = null;
  }

  async function runAction(action, target = currentTarget) {
    const t = target;
    if (!t) return;
    try {
      if (action === 'copy-abs-path') {
        clipboard.writeText(t.absPath);
      } else if (action === 'copy-file') {
        if (t.isUrl) return;
        const r = await ipcRenderer.invoke('clipboard-copy-file', t.absPath);
        if (r && r.error) console.warn('[path-link-ctx] copy-file failed:', r.error);
      } else if (action === 'show-in-folder') {
        if (t.isUrl) return;
        const r = await ipcRenderer.invoke('show-in-folder', t.absPath);
        if (r && r.error) console.warn('[path-link-ctx] show-in-folder failed:', r.error);
      } else if (action === 'sync-company') {
        if (t.isUrl) return;
        const displayName = t.absPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || t.absPath;
        showSyncStatus(`正在同步到公司…\n${displayName}`, 'working');
        const r = await ipcRenderer.invoke('sync-path-to-company', t.absPath);
        if (!r || r.error || r.success !== true) {
          const message = r && r.error ? r.error : '同步失败，请稍后重试。';
          showSyncStatus(`同步失败\n${message}`, 'error');
          console.warn('[path-link-ctx] sync-company failed:', message);
          return;
        }
        showSyncStatus(`已同步到公司收件箱\n${r.filename || displayName}`, 'success');
      } else if (action === 'sync-chatgpt') {
        const displayName = t.isUrl ? t.absPath : (t.absPath.split(/[\\/]/).pop() || t.absPath);
        let text = t.absPath;
        if (!t.isUrl) {
          const read = await ipcRenderer.invoke('read-file', t.absPath);
          if (!read || read.error || typeof read.content !== 'string') {
            showSyncStatus(`同步失败\n仅支持可读取的文本文件`, 'error');
            return;
          }
          text = read.content;
        }
        if (typeof pushToChatgpt !== 'function') {
          showSyncStatus('同步失败\nChatGPT 中转未初始化', 'error');
          return;
        }
        const result = await pushToChatgpt(text, displayName);
        if (!result || result.ok !== true) return;
      } else if (action === 'open-external') {
        if (t.isUrl) {
          const r = await ipcRenderer.invoke('open-external-url', t.absPath);
          if (r && r.success === false) console.warn('[path-link-ctx] open-external-url failed for', t.absPath);
        } else {
          const err = await ipcRenderer.invoke('open-path', t.absPath);
          if (err) console.warn('[path-link-ctx] open-path returned:', err);
        }
      }
    } catch (e) {
      if (action === 'sync-company' || action === 'sync-chatgpt') {
        showSyncStatus(`同步失败\n${e && e.message ? e.message : '同步程序异常。'}`, 'error');
      }
      console.warn('[path-link-ctx] action failed:', action, e && e.message);
    }
  }

  function init() {
    document.addEventListener('contextmenu', (e) => {
      if (!e.target || !e.target.closest) return;
      let rawPath = null;
      // Priority 1: explicit rt-file-link anchor (path-link.js wrapped)
      const rtLink = e.target.closest('a.rt-file-link');
      if (rtLink) {
        rawPath = rtLink.dataset.path;
      } else {
        // Priority 2: fallback for marked-rendered URL anchors (autolink produces
        // <a href="https://..."> without rt-file-link class). Skip preview-body
        // so preview's own link navigation logic still applies.
        const httpLink = e.target.closest('a[href]');
        if (httpLink && !httpLink.closest('#preview-body')) {
          const href = httpLink.getAttribute('href') || '';
          if (/^https?:\/\//i.test(href)) rawPath = href;
        }
      }
      if (!rawPath) return;
      const opened = open(rawPath, e.clientX, e.clientY);
      if (opened) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);

    document.addEventListener('mousedown', (e) => {
      if (menuEl.style.display === 'block' && !menuEl.contains(e.target)) {
        close();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && menuEl.style.display === 'block') {
        close();
      }
    });

    for (const btn of menuEl.querySelectorAll('.context-menu-item')) {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        const t = currentTarget;
        close();
        if (t) await runAction(action, t);
      });
    }
  }

  return { init, open, close, runAction };
}

module.exports = { createPathLinkContextMenuController };
