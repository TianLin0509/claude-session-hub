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

function createPastSessionModals({ document, ipcRenderer, escapeHtml }) {
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
          ${it.cwd ? `<span class="modal-meta-cwd" title="${escapeHtml(it.cwd)}">${escapeHtml(it.cwd)}</span>` : ''}
        </div>
      `;
      row.addEventListener('click', async () => {
        closeResumeModal();
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
        </div>
      `;
      row.title = 'Click to resume this session';
      row.addEventListener('click', async () => {
        closeSearchModal();
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

module.exports = { createPastSessionModals, highlightMatch };
