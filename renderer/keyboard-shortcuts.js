function createKeyboardShortcuts({
  document,
  ipcRenderer,
  clipboard,
  sessions,
  terminalCache,
  getActiveSessionId,
  getCurrentFontSize,
  selectSession,
  escapeToHome,
  toggleSidebar,
  openTerminalSearch,
  setFontSize,
}) {
  function getSortedVisibleSessionIds() {
    return Array.from(sessions.values())
      .sort((a, b) => {
        if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
        return b.lastMessageTime - a.lastMessageTime || b.createdAt - a.createdAt;
      })
      .map(s => s.id);
  }

  function cycleSession(direction) {
    const ids = getSortedVisibleSessionIds();
    if (ids.length === 0) return;
    const activeSessionId = getActiveSessionId();
    const i = Math.max(0, ids.indexOf(activeSessionId));
    const next = (i + direction + ids.length) % ids.length;
    selectSession(ids[next]);
  }

  function jumpToSessionByIndex(idx) {
    const ids = getSortedVisibleSessionIds();
    if (idx < 0 || idx >= ids.length) return;
    selectSession(ids[idx]);
  }

  function handleKeydown(e) {
    if (!(e.ctrlKey || e.metaKey)) return;

    if (!e.shiftKey && e.altKey && e.key === 'Home') {
      e.preventDefault();
      escapeToHome();
      return;
    }

    if (!e.shiftKey && !e.altKey && (e.key === 'n' || e.key === 'N')) {
      e.preventDefault();
      ipcRenderer.invoke('create-session', 'claude');
      return;
    }

    if (!e.shiftKey && !e.altKey && (e.key === 'w' || e.key === 'W')) {
      e.preventDefault();
      const activeSessionId = getActiveSessionId();
      if (activeSessionId) ipcRenderer.invoke('close-session', activeSessionId);
      return;
    }

    if (!e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'B')) {
      e.preventDefault();
      toggleSidebar();
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      cycleSession(e.shiftKey ? -1 : 1);
      return;
    }

    if (!e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      jumpToSessionByIndex(parseInt(e.key, 10) - 1);
      return;
    }

    if (!e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      if (getActiveSessionId()) openTerminalSearch();
      return;
    }

    if (e.shiftKey && !e.altKey && (e.key === 'c' || e.key === 'C' || e.code === 'KeyC')) {
      const cached = terminalCache.get(getActiveSessionId());
      const sel = cached && cached.terminal.getSelection();
      if (sel) {
        e.preventDefault();
        clipboard.writeText(sel);
      }
      return;
    }

    if (!e.shiftKey && !e.altKey && e.key === 'End') {
      e.preventDefault();
      const c = terminalCache.get(getActiveSessionId());
      if (c) c.terminal.scrollToBottom();
      return;
    }

    if (!e.shiftKey && !e.altKey && e.key === 'Home') {
      e.preventDefault();
      const c = terminalCache.get(getActiveSessionId());
      if (c) c.terminal.scrollToTop();
      return;
    }

    if (!e.shiftKey && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      if (e.defaultPrevented) return;
      const c = terminalCache.get(getActiveSessionId());
      if (!c || !c._minimap) return;
      const moved = e.key === 'ArrowUp' ? c._minimap.navPrev() : c._minimap.navNext();
      if (moved) e.preventDefault();
      return;
    }

    if (!e.shiftKey && !e.altKey && (e.key === '=' || e.key === '+')) {
      e.preventDefault(); setFontSize(getCurrentFontSize() + 1); return;
    }
    if (!e.shiftKey && !e.altKey && e.key === '-') {
      e.preventDefault(); setFontSize(getCurrentFontSize() - 1); return;
    }
    if (!e.shiftKey && !e.altKey && e.key === '0') {
      e.preventDefault(); setFontSize(16);
    }
  }

  function init() {
    document.addEventListener('keydown', handleKeydown, true);
  }

  return {
    init,
    getSortedVisibleSessionIds,
    cycleSession,
    jumpToSessionByIndex,
    handleKeydown,
  };
}

module.exports = { createKeyboardShortcuts };
