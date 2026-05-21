'use strict';

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
  requestAnimationFrameFn = requestAnimationFrame,
}) {
  let contextMenuSessionId = null;

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
    if (pinBtn) pinBtn.style.display = '';
    const session = sessions.get(sessionId);
    const meeting = meetings[sessionId];
    if (restartBtn) restartBtn.style.display = session ? '' : 'none';
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
          await ipcRenderer.invoke('restart-session', sid);
        } else if (action === 'close') {
          if (session.status === 'dormant') {
            sessions.delete(sid);
            if (getActiveSessionId() === sid) setActiveSessionId(null);
            renderSessionList();
            schedulePersist();
          } else {
            await ipcRenderer.invoke('close-session', sid);
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

module.exports = { createSessionContextMenuController, createTerminalContextMenuController };
