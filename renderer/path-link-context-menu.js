'use strict';

// Right-click context menu for <a class="rt-file-link"> elements.
// 4 actions: copy-abs-path / copy-file / show-in-folder / open-external.
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
  requestAnimationFrameFn = requestAnimationFrame,
}) {
  let currentTarget = null;

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

  async function runAction(action) {
    const t = currentTarget;
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
        if (t) {
          currentTarget = t;
          await runAction(action);
          currentTarget = null;
        }
      });
    }
  }

  return { init, open, close };
}

module.exports = { createPathLinkContextMenuController };
