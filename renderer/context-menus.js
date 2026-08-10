'use strict';

const { supportsRecoverableSession } = require('../core/session-capabilities.js');

function supportsRecoverableSessionKind(session) {
  return !!(session && session.purpose !== 'chuxin-research' && supportsRecoverableSession(session));
}

function createSessionContextMenuController({
  document,
  window,
  contextMenuEl,
  sessions,
  meetings,
  ipcRenderer,
  getActiveSessionId,
  setActiveSessionId,
  getActiveMeetingId,
  setActiveMeetingId,
  closeMeetingPanel,
  emptyStateEl,
  renderSessionList,
  schedulePersist,
  notify,
  wakeDormantSession,
  requestAnimationFrameFn = requestAnimationFrame,
}) {
  let contextMenuSessionId = null;
  const showNotice = typeof notify === 'function'
    ? notify
    : (message) => {
      if (window && typeof window.alert === 'function') window.alert(message);
    };

  function open(sessionId, x, y) {
    contextMenuSessionId = sessionId;
    contextMenuEl.style.display = 'block';
    contextMenuEl.style.left = `${x}px`;
    contextMenuEl.style.top = `${y}px`;
    requestAnimationFrameFn(() => {
      const rect = contextMenuEl.getBoundingClientRect();
      if (rect.right > window.innerWidth) contextMenuEl.style.left = `${x - rect.width}px`;
      if (rect.bottom > window.innerHeight) contextMenuEl.style.top = `${y - rect.height}px`;
    });
    const pinBtn = contextMenuEl.querySelector('[data-action="pin"]');
    const restartBtn = contextMenuEl.querySelector('[data-action="restart"]');
    const closeBtn = contextMenuEl.querySelector('[data-action="close"]');
    const deleteBtn = contextMenuEl.querySelector('[data-action="delete"]');
    if (pinBtn) pinBtn.style.display = '';
    const session = sessions.get(sessionId);
    const meeting = meetings[sessionId];
    if (restartBtn) {
      const restartAllowed = !!(session && session.purpose !== 'chuxin-research');
      restartBtn.style.display = restartAllowed ? '' : 'none';
      if (restartAllowed) {
        restartBtn.textContent = session.status === 'dormant'
          ? '唤醒会话'
          : (supportsRecoverableSessionKind(session) ? '重启并继续当前会话' : '重启终端');
      }
    }
    if (closeBtn) {
      closeBtn.style.display = meeting || (session && session.status !== 'dormant') ? '' : 'none';
      closeBtn.textContent = meeting
        ? '永久关闭会议室'
        : (supportsRecoverableSessionKind(session) ? '关闭并休眠' : '关闭');
      if (closeBtn.classList && typeof closeBtn.classList.toggle === 'function') {
        closeBtn.classList.toggle('danger', !!meeting);
      }
    }
    if (deleteBtn) deleteBtn.style.display = session ? '' : 'none';
    if (pinBtn) {
      const target = session || meeting;
      pinBtn.textContent = target && target.pinned ? 'Unpin' : 'Pin to top';
    }
  }

  function close() {
    contextMenuEl.style.display = 'none';
    contextMenuSessionId = null;
  }

  function init() {
    document.addEventListener('mousedown', (e) => {
      if (contextMenuEl.style.display === 'block' && !contextMenuEl.contains(e.target)) {
        close();
      }
    });

    for (const btn of contextMenuEl.querySelectorAll('.context-menu-item')) {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        const sid = contextMenuSessionId;
        close();
        if (!sid) return;

        const session = sessions.get(sid);
        const meeting = meetings[sid];

        if (action === 'close' && meeting) {
          await ipcRenderer.invoke('close-meeting', sid);
          delete meetings[sid];
          if (getActiveMeetingId() === sid) {
            setActiveMeetingId(null);
            closeMeetingPanel();
            if (emptyStateEl) emptyStateEl.style.display = '';
          }
          renderSessionList();
          schedulePersist();
          return;
        }

        if (action === 'pin' && meeting) {
          meeting.pinned = !meeting.pinned;
          ipcRenderer.send('update-meeting', { meetingId: sid, fields: { pinned: !!meeting.pinned } });
          renderSessionList();
          schedulePersist();
          return;
        }

        if (!session) return;

        if (action === 'pin') {
          session.pinned = !session.pinned;
          renderSessionList();
          schedulePersist();
        } else if (action === 'restart') {
          if (session.status === 'dormant') {
            if (typeof wakeDormantSession !== 'function') {
              showNotice('休眠会话唤醒服务尚未就绪');
              return;
            }
            try {
              const resumed = await wakeDormantSession(sid);
              if (!resumed) showNotice('会话唤醒失败，请稍后重试。');
            } catch (error) {
              showNotice(`会话唤醒失败：${error && error.message ? error.message : String(error)}`);
            }
            return;
          }
          try {
            const result = await ipcRenderer.invoke('restart-session', sid);
            if (result && result.ok === false) {
              showNotice(result.message || '会话重启失败，请稍后重试。');
            }
          } catch (error) {
            showNotice(`会话重启失败：${error && error.message ? error.message : String(error)}`);
          }
        } else if (action === 'close') {
          if (session.status === 'dormant') return;
          // 用户主动关闭就是休眠：即便本轮仍在运行，也允许中断 PTY 并保留恢复入口。
          // 自动休眠仍由主进程的 active watcher/loop 保护，不受这里影响。
          const result = await ipcRenderer.invoke('close-session', sid);
          if (!result || !result.ok) {
            showNotice((result && result.message) || '关闭休眠失败，请稍后重试。');
          }
        } else if (action === 'delete') {
          const confirmed = !window || typeof window.confirm !== 'function'
            ? true
            : window.confirm(`永久删除“${session.title || '此会话'}”？\n\n这会终止当前进程并移除 Hub 卡片，之后不能从该卡片唤醒。`);
          if (!confirmed) return;
          if (session.status === 'dormant') {
            sessions.delete(sid);
            if (getActiveSessionId() === sid) setActiveSessionId(null);
            renderSessionList();
            schedulePersist();
          } else {
            const result = await ipcRenderer.invoke('delete-session', sid);
            if (!result || !result.ok) {
              showNotice((result && result.message) || '永久删除失败，请稍后重试。');
            }
          }
        }
      });
    }
  }

  return { init, open, close };
}

function createTerminalContextMenuController({
  document,
  window,
  termCtxMenuEl,
  openPreviewPanel,
  requestAnimationFrameFn = requestAnimationFrame,
}) {
  let termCtxMenuSelection = null;

  function open(selection, x, y) {
    termCtxMenuSelection = selection;
    termCtxMenuEl.style.display = 'block';
    termCtxMenuEl.style.left = `${x}px`;
    termCtxMenuEl.style.top = `${y}px`;
    requestAnimationFrameFn(() => {
      const rect = termCtxMenuEl.getBoundingClientRect();
      if (rect.right > window.innerWidth) termCtxMenuEl.style.left = `${x - rect.width}px`;
      if (rect.bottom > window.innerHeight) termCtxMenuEl.style.top = `${y - rect.height}px`;
    });
  }

  function close() {
    termCtxMenuEl.style.display = 'none';
    termCtxMenuSelection = null;
  }

  function init() {
    document.addEventListener('mousedown', (e) => {
      if (termCtxMenuEl.style.display === 'block' && !termCtxMenuEl.contains(e.target)) {
        close();
      }
    });

    const previewBtn = termCtxMenuEl.querySelector('[data-action="preview"]');
    if (previewBtn) {
      previewBtn.addEventListener('click', () => {
        const sel = termCtxMenuSelection;
        close();
        if (sel) openPreviewPanel(sel.trim());
      });
    }
  }

  return { init, open, close };
}

module.exports = {
  createSessionContextMenuController,
  createTerminalContextMenuController,
  supportsRecoverableSessionKind,
};
