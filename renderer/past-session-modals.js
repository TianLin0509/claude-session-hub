function highlightMatch(text, query, escapeHtml) {
  if (!query) return escapeHtml(text);
  const ql = query.toLowerCase();
  const tl = text.toLowerCase();
  const out = [];
  let i = 0;
  while (i < text.length) {
    const hit = tl.indexOf(ql, i);
    if (hit < 0) { out.push(escapeHtml(text.slice(i))); break; }
    out.push(escapeHtml(text.slice(i, hit)));
    out.push('<mark>' + escapeHtml(text.slice(hit, hit + query.length)) + '</mark>');
    i = hit + query.length;
  }
  return out.join('');
}

function normalizeTranscriptPath(value) {
  return String(value || '').replace(/\//g, '\\').toLowerCase();
}

function findReusableClaudeSession(sessionValues, native = {}) {
  const ccSessionId = String(native.sessionId || '').trim();
  const transcriptPath = normalizeTranscriptPath(native.path);
  const matches = [...(sessionValues || [])].filter((session) => {
    if (!session || !['claude', 'claude-resume'].includes(session.kind)) return false;
    if (ccSessionId && session.ccSessionId === ccSessionId) return true;
    return transcriptPath
      && normalizeTranscriptPath(session.transcriptPath) === transcriptPath;
  });
  matches.sort((a, b) => {
    const aLive = a.status !== 'dormant' ? 1 : 0;
    const bLive = b.status !== 'dormant' ? 1 : 0;
    if (aLive !== bLive) return bLive - aLive;
    return Number(b.lastMessageTime || b.updatedAt || 0) - Number(a.lastMessageTime || a.updatedAt || 0);
  });
  return matches[0] || null;
}

function nativeTranscriptSessionKey(session) {
  if (!session || session.meetingId) return null;
  const kind = String(session.kind || '').replace(/-resume$/, '');
  if ((kind === 'claude' || kind === 'deepseek') && session.ccSessionId) {
    return `${kind}:cc:${session.ccSessionId}`;
  }
  if (kind === 'codex' && session.codexSid) return `codex:${session.codexSid}`;
  if (kind === 'kimi' && session.kimiSid) return `kimi:${session.kimiSid}`;
  return null;
}

function collapseDormantNativeDuplicates(sessionMap) {
  if (!sessionMap || typeof sessionMap.values !== 'function') return [];
  const groups = new Map();
  for (const session of sessionMap.values()) {
    const key = nativeTranscriptSessionKey(session);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(session);
  }

  const removed = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const live = group.filter(session => session.status !== 'dormant');
    // Never collapse two live PTYs.  They may have been deliberately opened in
    // parallel; only dormant shells are safe to consolidate as sidebar state.
    if (live.length > 1) continue;
    const ranked = [...group].sort((a, b) => {
      const aLive = a.status !== 'dormant' ? 1 : 0;
      const bLive = b.status !== 'dormant' ? 1 : 0;
      if (aLive !== bLive) return bLive - aLive;
      return Number(b.lastMessageTime || b.updatedAt || 0) - Number(a.lastMessageTime || a.updatedAt || 0);
    });
    const keep = ranked[0];
    for (const duplicate of ranked.slice(1)) {
      if (duplicate.status !== 'dormant') continue;
      keep.pinned = !!(keep.pinned || duplicate.pinned);
      keep.unreadCount = Math.max(Number(keep.unreadCount || 0), Number(duplicate.unreadCount || 0));
      keep.createdAt = Math.min(
        Number(keep.createdAt || keep.lastMessageTime || Date.now()),
        Number(duplicate.createdAt || duplicate.lastMessageTime || Date.now()),
      );
      if (!keep.cwd && duplicate.cwd) keep.cwd = duplicate.cwd;
      if (!keep.transcriptPath && duplicate.transcriptPath) keep.transcriptPath = duplicate.transcriptPath;
      if (!keep.userRenamed && duplicate.userRenamed) {
        keep.title = duplicate.title;
        keep.userRenamed = true;
        keep.autoTitleGenerated = false;
      }
      sessionMap.delete(duplicate.id);
      removed.push({ removedId: duplicate.id, keptId: keep.id });
    }
  }
  return removed;
}

function createPastSessionModals({ document, ipcRenderer, escapeHtml, getSessions, selectSession }) {
  const resumeModalEl = document.getElementById('resume-modal');
  const resumeListEl = document.getElementById('resume-list');
  const resumeFilterEl = document.getElementById('resume-filter');
  const searchModalEl = document.getElementById('search-modal');
  const searchQueryEl = document.getElementById('search-query');
  const searchResultsEl = document.getElementById('search-results');

  let resumeItems = [];
  let searchDebounce = null;
  let searchSeq = 0;

  function renderResumeList(items) {
    if (!items || items.length === 0) {
      resumeListEl.innerHTML = '<div class="modal-empty">No past sessions found.</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const it of items) {
      const existing = findReusableClaudeSession(
        typeof getSessions === 'function' ? getSessions().values() : [],
        it,
      );
      const row = document.createElement('div');
      row.className = 'modal-row';
      const mtimeStr = it.mtime ? new Date(it.mtime).toLocaleString('zh-CN', { hour12: false }) : '';
      const preview = it.firstUserMessage || '(no user prompt captured)';
      const modelShort = (it.model || '').replace(/^claude-/, '').replace(/-\d+$/, '');
      row.innerHTML = `
        <div class="modal-row-main">
          <span class="modal-row-preview">${escapeHtml(preview)}</span>
        </div>
        <div class="modal-row-meta">
          <span class="modal-meta-time">${escapeHtml(mtimeStr)}</span>
          ${it.turnCount ? `<span class="modal-meta-chip">${it.turnCount}T</span>` : ''}
          ${modelShort ? `<span class="modal-meta-chip">${escapeHtml(modelShort)}</span>` : ''}
          ${existing ? '<span class="modal-meta-chip">Hub 已有</span>' : ''}
          ${it.cwd ? `<span class="modal-meta-cwd" title="${escapeHtml(it.cwd)}">${escapeHtml(it.cwd)}</span>` : ''}
        </div>
      `;
      row.addEventListener('click', async () => {
        closeResumeModal();
        const reusable = findReusableClaudeSession(
          typeof getSessions === 'function' ? getSessions().values() : [],
          it,
        );
        if (reusable && typeof selectSession === 'function') {
          await selectSession(reusable.id, { forceScrollBottom: true });
          return;
        }
        await ipcRenderer.invoke('create-session', {
          kind: 'claude-resume',
          opts: { resumeCCSessionId: it.sessionId, resumeTranscriptPath: it.path || undefined, cwd: it.cwd || undefined },
        });
      });
      frag.appendChild(row);
    }
    resumeListEl.innerHTML = '';
    resumeListEl.appendChild(frag);
  }

  function openResumeModal() {
    resumeModalEl.style.display = 'flex';
    resumeFilterEl.value = '';
    resumeListEl.innerHTML = '<div class="modal-empty">Scanning…</div>';
    requestAnimationFrame(() => resumeFilterEl.focus());
    ipcRenderer.invoke('list-past-sessions', { limit: 50 }).then((items) => {
      resumeItems = items || [];
      renderResumeList(resumeItems);
    }).catch(() => {
      resumeListEl.innerHTML = '<div class="modal-empty">Scan failed.</div>';
    });
  }

  function closeResumeModal() {
    resumeModalEl.style.display = 'none';
  }

  function openSearchModal() {
    searchModalEl.style.display = 'flex';
    searchQueryEl.value = '';
    searchResultsEl.innerHTML = '<div class="modal-empty">Type ≥ 2 chars to search.</div>';
    requestAnimationFrame(() => searchQueryEl.focus());
  }

  function closeSearchModal() {
    searchModalEl.style.display = 'none';
  }

  function renderSearchHits(hits, query, truncated) {
    if (!hits.length) {
      searchResultsEl.innerHTML = '<div class="modal-empty">No matches.</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const h of hits) {
      const existing = findReusableClaudeSession(
        typeof getSessions === 'function' ? getSessions().values() : [],
        h,
      );
      const row = document.createElement('div');
      row.className = 'modal-row';
      const when = new Date(h.mtime).toLocaleString('zh-CN', { hour12: false });
      row.innerHTML = `
        <div class="modal-row-main">
          <span class="modal-row-preview">${highlightMatch(h.snippet, query, escapeHtml)}</span>
        </div>
        <div class="modal-row-meta">
          <span class="modal-meta-time">${escapeHtml(when)}</span>
          <span class="modal-meta-chip">${h.role || '?'}</span>
          <span class="modal-meta-chip">line ${h.lineNo}</span>
          ${existing ? '<span class="modal-meta-chip">Hub 已有</span>' : ''}
        </div>
      `;
      row.title = 'Click to resume this session';
      row.addEventListener('click', async () => {
        closeSearchModal();
        const reusable = findReusableClaudeSession(
          typeof getSessions === 'function' ? getSessions().values() : [],
          h,
        );
        if (reusable && typeof selectSession === 'function') {
          await selectSession(reusable.id, { forceScrollBottom: true });
          return;
        }
        await ipcRenderer.invoke('create-session', {
          kind: 'claude-resume',
          opts: { resumeCCSessionId: h.sessionId, resumeTranscriptPath: h.path || undefined },
        });
      });
      frag.appendChild(row);
    }
    searchResultsEl.innerHTML = '';
    if (truncated) {
      const note = document.createElement('div');
      note.className = 'modal-empty';
      note.style.padding = '8px 14px';
      note.style.textAlign = 'left';
      note.textContent = `Showing first ${hits.length} matches (scan truncated — refine query for more).`;
      searchResultsEl.appendChild(note);
    }
    searchResultsEl.appendChild(frag);
  }

  resumeFilterEl.addEventListener('input', () => {
    const q = resumeFilterEl.value.trim().toLowerCase();
    if (!q) { renderResumeList(resumeItems); return; }
    const filtered = resumeItems.filter(it => {
      const hay = ((it.firstUserMessage || '') + ' ' + (it.cwd || '') + ' ' + (it.model || '')).toLowerCase();
      return hay.includes(q);
    });
    renderResumeList(filtered);
  });

  document.getElementById('resume-modal-close').addEventListener('click', closeResumeModal);
  resumeModalEl.addEventListener('click', (e) => {
    if (e.target === resumeModalEl) closeResumeModal();
  });

  searchQueryEl.addEventListener('input', () => {
    const q = searchQueryEl.value.trim();
    if (q.length < 2) {
      searchResultsEl.innerHTML = '<div class="modal-empty">Type ≥ 2 chars to search.</div>';
      return;
    }
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(async () => {
      const seq = ++searchSeq;
      searchResultsEl.innerHTML = '<div class="modal-empty">Searching…</div>';
      const res = await ipcRenderer.invoke('search-past-sessions', { query: q, limit: 50 });
      if (seq !== searchSeq) return;
      renderSearchHits(res.hits || [], q, !!res.truncated);
    }, 300);
  });

  document.getElementById('search-modal-close').addEventListener('click', closeSearchModal);
  searchModalEl.addEventListener('click', (e) => {
    if (e.target === searchModalEl) closeSearchModal();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
      e.preventDefault(); openSearchModal();
      return;
    }
    if (e.key === 'Escape') {
      if (resumeModalEl.style.display === 'flex') {
        e.preventDefault(); closeResumeModal();
      }
      if (searchModalEl.style.display === 'flex') {
        e.preventDefault(); closeSearchModal();
      }
    }
  });

  return {
    openResumeModal,
    openSearchModal,
    closeResumeModal,
    closeSearchModal,
  };
}

module.exports = {
  createPastSessionModals,
  highlightMatch,
  findReusableClaudeSession,
  nativeTranscriptSessionKey,
  collapseDormantNativeDuplicates,
};
