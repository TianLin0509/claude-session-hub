'use strict';

function createWorkbenchOperationsController(options = {}) {
  const doc = options.document || document;
  const ipcRenderer = options.ipcRenderer;
  const getWorkspaceHints = typeof options.getWorkspaceHints === 'function' ? options.getWorkspaceHints : () => [];
  const onOpenPath = typeof options.onOpenPath === 'function' ? options.onOpenPath : async () => {};
  const onOpenSession = typeof options.onOpenSession === 'function' ? options.onOpenSession : () => {};
  const escapeHtml = typeof options.escapeHtml === 'function'
    ? options.escapeHtml
    : value => String(value || '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
  const confirmAction = typeof options.confirmAction === 'function'
    ? options.confirmAction
    : message => window.confirm(message);
  const root = doc.getElementById('operations-review-modal');
  const state = {
    snapshot: null,
    refreshing: false,
    refreshPromise: null,
    forceRefreshPromise: null,
    activeRepoId: '',
    activeFilePath: '',
    view: 'review',
    lastFocus: null,
    lastRestore: null,
    restorePending: false,
    diffSequence: 0,
    provenanceSequence: 0,
    timelineSequence: 0,
  };

  function el(id) { return doc.getElementById(id); }
  function activeRepo() {
    return state.snapshot && Array.isArray(state.snapshot.repos)
      ? state.snapshot.repos.find(repo => repo.id === state.activeRepoId) || null
      : null;
  }
  function activeFile() {
    const repo = activeRepo();
    return repo && Array.isArray(repo.files)
      ? repo.files.find(file => file.path === state.activeFilePath) || null
      : null;
  }
  function setLive(message) {
    if (el('ops-live')) el('ops-live').textContent = message || '本地证据账本';
  }
  function runSafely(promise) {
    Promise.resolve(promise).catch(error => setLive(errorCopy(error && error.message)));
  }
  function errorCopy(code) {
    const map = {
      invalid_repo_root: '工作区已变化，请刷新后重试',
      invalid_file_path: '文件已移动或不在该 Git 工作区内',
      stale_hunk: '代码块已变化，请重新打开后再审阅',
      review_state_corrupt: '本地审阅账本损坏，已停止写入以防覆盖；请先备份并修复账本',
      review_state_unreadable: '本地审阅账本暂时无法读取，已停止写入',
      review_state_busy: '另一个 Hub 正在更新审阅账本，请稍后重试',
      checkpoint_missing: 'Checkpoint 记录已不存在，请刷新列表',
      checkpoint_corrupt: 'Checkpoint 记录损坏，已停止恢复以防创建错误工作区',
      checkpoint_unreadable: 'Checkpoint 记录暂时无法读取，请稍后重试',
      restore_destination_exists: '恢复目录已存在，为避免覆盖已中止',
      unsafe_restore_destination: '恢复目录不安全，已中止',
    };
    return map[code] || '操作失败；当前代码未被修改';
  }
  function formatBytes(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return '—';
    if (number < 1024) return `${number} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let current = number / 1024;
    let index = 0;
    while (current >= 1024 && index < units.length - 1) { current /= 1024; index += 1; }
    return `${current >= 10 ? current.toFixed(0) : current.toFixed(1)} ${units[index]}`;
  }
  function relativeTime(timestamp) {
    const diff = Math.max(0, Date.now() - Number(timestamp || 0));
    if (!timestamp || diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    return `${Math.floor(diff / 86_400_000)} 天前`;
  }
  function riskLabel(level) {
    return level === 'high' ? '高风险' : level === 'medium' ? '需确认' : '低风险';
  }
  function trustLabel(level) {
    return level === 'verified' ? '已验证关联' : level === 'inferred' ? '推断关联' : '缺少因果证据';
  }
  function trustMarkup(level, confidence) {
    const suffix = Number.isFinite(Number(confidence)) && Number(confidence) > 0 ? ` · ${Math.round(confidence)}%` : '';
    return `<span class="ops-trust ${escapeHtml(level || 'missing')}">${escapeHtml(trustLabel(level))}${suffix}</span>`;
  }

  function renderNavigation() {
    const repos = state.snapshot && Array.isArray(state.snapshot.repos) ? state.snapshot.repos : [];
    const scanErrors = state.snapshot && Array.isArray(state.snapshot.scanErrors) ? state.snapshot.scanErrors : [];
    if (el('ops-repo-count')) el('ops-repo-count').textContent = String(repos.length);
    const repoList = el('ops-repo-list');
    if (repoList) {
      const repoMarkup = repos.length ? repos.map((repo, index) => `<button type="button" class="ops-repo-item ${repo.id === state.activeRepoId ? 'active' : ''}" data-ops-action="select-repo" data-repo-index="${index}">`
        + `<span><strong>${escapeHtml(repo.name)}</strong><small>${escapeHtml(repo.branch)} · ${Number(repo.totalFileCount || repo.files.length)} 文件${repo.truncated ? ' · 显示前 300' : ''}</small></span>`
        + `<em class="${escapeHtml(repo.risk)}">${escapeHtml(riskLabel(repo.risk))}</em></button>`).join('')
        : (!scanErrors.length ? '<div class="ops-empty compact"><strong>没有待审改动</strong><span>最近 Session 所在的 Git 工作区目前是干净的。</span></div>' : '');
      const errorMarkup = scanErrors.map(item => `<div class="ops-scan-error"><strong>${escapeHtml(item.name || 'Git 工作区')}</strong><span>${item.error === 'git_scan_timeout' ? '扫描超时' : '扫描失败'}，没有把它当成干净工作区</span></div>`).join('');
      repoList.innerHTML = repoMarkup + errorMarkup;
    }
    const repo = activeRepo();
    const files = repo && Array.isArray(repo.files) ? repo.files : [];
    if (el('ops-file-count')) el('ops-file-count').textContent = String(files.length);
    const fileList = el('ops-file-list');
    if (fileList) {
      fileList.innerHTML = files.length ? files.map((file, index) => `<button type="button" class="ops-file-item ${file.path === state.activeFilePath ? 'active' : ''}" data-ops-action="select-file" data-file-index="${index}">`
        + `<span><strong>${escapeHtml(file.path.split('/').pop())}</strong><small>${escapeHtml(file.path)}</small></span>`
        + `<em class="${escapeHtml(file.risk)}">+${Math.max(0, file.additions || 0)} / −${Math.max(0, file.deletions || 0)}</em></button>`).join('')
        : '<div class="ops-empty compact"><span>选择左侧工作区查看文件</span></div>';
    }
  }

  function renderFileProof(file, repo) {
    const target = el('ops-proof-panel');
    if (!target || !file || !repo) return;
    const reasons = Array.isArray(file.riskReasons) ? file.riskReasons : [];
    const session = file.session;
    target.innerHTML = `<section class="ops-proof-section"><header><h4>风险解释</h4><span class="ops-risk-pill ${escapeHtml(file.risk)}">${escapeHtml(riskLabel(file.risk))}</span></header>`
      + `<ul>${reasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join('')}</ul></section>`
      + `<section class="ops-proof-section"><header><h4>验证证据</h4><span class="ops-trust missing">未记录测试结果</span></header>`
      + `<p>${repo.testFiles > 0 ? `本次改动包含 ${repo.testFiles} 个测试文件，但 AI HUB 没有证据证明测试已执行或通过。` : '当前改动中未发现测试文件；这不等于没有外部验证。'}</p></section>`
      + `<section class="ops-proof-section"><header><h4>Session 归属线索</h4>${trustMarkup(session ? 'inferred' : 'missing', session ? 55 : 0)}</header>`
      + (session ? `<p>文件修改时间与 Session「${escapeHtml(session.title || session.sessionId)}」接近；仅作线索，不能证明因果。</p><button type="button" class="ops-button subtle" data-ops-action="open-session" data-session-id="${escapeHtml(session.sessionId || '')}">打开候选 Session</button>` : '<p>没有足够的 Session 线索。创建 Checkpoint 后可从现在开始补齐证据链。</p>')
      + `</section><section class="ops-proof-section"><h4>文件信息</h4><p>${escapeHtml(file.status)} · ${formatBytes(file.size)} · ${file.modifiedAt ? relativeTime(file.modifiedAt) : '时间未知'}</p></section>`;
  }

  function reviewButton(decision, current, hunkId) {
    const labels = { accepted: '接受', rejected: '拒绝', pending: '待定' };
    return `<button type="button" class="ops-review-action ${decision}${current === decision ? ' active' : ''}" data-ops-action="review-decision" data-hunk-id="${escapeHtml(hunkId)}" data-decision="${decision}">${labels[decision]}</button>`;
  }

  function renderDiff(detail) {
    const file = activeFile();
    const repo = activeRepo();
    const center = el('ops-center-content');
    if (!center || !file || !repo) return;
    if (el('ops-center-title')) el('ops-center-title').textContent = file.path;
    if (el('ops-center-meta')) el('ops-center-meta').textContent = `${repo.name} · ${file.status} · +${file.additions || 0} / −${file.deletions || 0}`;
    const trust = el('ops-center-trust');
    if (trust) { trust.textContent = riskLabel(file.risk); trust.className = `ops-trust ${file.risk === 'low' ? 'verified' : file.risk === 'medium' ? 'inferred' : 'missing'}`; }
    if (!detail || detail.ok === false) {
      center.innerHTML = `<div class="ops-empty"><strong>Diff 读取失败</strong><span>${escapeHtml(errorCopy(detail && detail.error))}</span></div>`;
      return;
    }
    if (!detail.hunks.length) {
      center.innerHTML = '<div class="ops-empty"><strong>没有可显示的逐行 Diff</strong><span>文件可能已恢复、被移动，或仅包含 Git 元数据变化。</span></div>';
      renderFileProof(file, repo);
      return;
    }
    center.innerHTML = `<div class="ops-diff-notice">点击当前文件中的代码行可追问“为什么这样写”；删除行没有当前版本 blame，保持不可点。</div>`
      + detail.hunks.map((hunk, hunkIndex) => {
        const current = hunk.review && hunk.review.decision || 'pending';
        const comment = hunk.review && hunk.review.comment || '';
        return `<article class="ops-hunk ${escapeHtml(current)}" data-hunk-index="${hunkIndex}"><header><span><b>${escapeHtml(hunk.layer)}</b>${escapeHtml(hunk.header)}</span><div>${reviewButton('accepted', current, hunk.id)}${reviewButton('rejected', current, hunk.id)}${reviewButton('pending', current, hunk.id)}</div></header>`
          + `<div class="ops-code">${hunk.lines.length ? hunk.lines.map(line => {
            const canBlame = line.kind !== 'del' && line.newLine != null && Number.isFinite(Number(line.newLine));
            return `<button type="button" class="ops-code-line ${escapeHtml(line.kind)}" ${canBlame ? `data-ops-action="line-provenance" data-line="${line.newLine}"` : 'disabled'} title="${canBlame ? '为什么这样写？' : '删除行不在当前文件中'}"><span>${line.oldLine || ''}</span><span>${line.newLine || ''}</span><code>${escapeHtml(line.text)}</code></button>`;
          }).join('') : '<div class="ops-binary">二进制内容无法逐行展示</div>'}</div>`
          + `<div class="ops-hunk-comment"><textarea data-ops-comment="${escapeHtml(hunk.id)}" rows="2" placeholder="记录审阅理由；与 hunk 一起落入本地证据账本">${escapeHtml(comment)}</textarea><button type="button" class="ops-button subtle" data-ops-action="save-comment" data-hunk-id="${escapeHtml(hunk.id)}" data-decision="${escapeHtml(current)}">保存评论</button></div></article>`;
      }).join('');
    renderFileProof(file, repo);
  }

  async function loadDiff() {
    const repo = activeRepo();
    const file = activeFile();
    if (!repo || !file) {
      const center = el('ops-center-content');
      if (center) center.innerHTML = '<div class="ops-empty"><strong>没有待审文件</strong><span>工作区干净时不会生成空审阅任务。</span></div>';
      return;
    }
    const sequence = ++state.diffSequence;
    const repoId = repo.id;
    const filePath = file.path;
    setLive('正在读取 Git diff…');
    const detail = await ipcRenderer.invoke('workbench:get-diff', { repoRoot: repo.root, filePath: file.path });
    if (sequence !== state.diffSequence || state.view !== 'review'
        || state.activeRepoId !== repoId || state.activeFilePath !== filePath) return;
    renderDiff(detail);
    setLive(detail && detail.ok === false ? errorCopy(detail.error) : 'Diff 已从当前工作树读取');
  }

  function renderProvenance(result) {
    const target = el('ops-proof-panel');
    if (!target) return;
    if (!result || result.ok === false) {
      target.innerHTML = `<div class="ops-empty"><strong>无法读取行级溯源</strong><span>${escapeHtml(errorCopy(result && result.error))}</span></div>`;
      return;
    }
    const commit = result.commit;
    const checkpoint = result.checkpoint;
    const sessions = Array.isArray(result.sessions) ? result.sessions : [];
    const decisions = result.reviewDecisions && typeof result.reviewDecisions === 'object'
      ? Object.values(result.reviewDecisions)
      : [];
    target.innerHTML = `<section class="ops-proof-section emphasis"><header><h4>为什么是这一行？</h4>${trustMarkup(result.trust, result.confidence)}</header><p>${escapeHtml(result.reason)}</p></section>`
      + `<section class="ops-proof-section"><h4>Git 事实</h4>`
      + (commit ? `<div class="ops-proof-card"><span>${escapeHtml(commit.shortHash)} · ${new Date(commit.timestamp).toLocaleString('zh-CN')}</span><strong>${escapeHtml(commit.subject || '无提交说明')}</strong><small>${escapeHtml(commit.author)}</small></div>` : '<p>该行尚未提交。</p>') + '</section>'
      + `<section class="ops-proof-section"><header><h4>Checkpoint</h4>${result.contentTrust === 'verified' ? '<span class="ops-trust verified">内容已验证</span>' : ''}</header>${checkpoint ? `<div class="ops-proof-card"><span>${escapeHtml(checkpoint.id)}</span><strong>${escapeHtml(checkpoint.label)}</strong><small>${checkpoint.files.length} 个变更文件</small></div>` : '<p>没有内容完全一致的 AI HUB Checkpoint。</p>'}</section>`
      + (decisions.length ? `<section class="ops-proof-section"><h4>该文件的审阅决策</h4>${decisions.slice(0, 8).map(item => `<div class="ops-proof-card"><span>${item.decision === 'accepted' ? '接受' : item.decision === 'rejected' ? '拒绝' : '待定'} · ${item.updatedAt ? relativeTime(item.updatedAt) : '时间未知'}</span><strong>${escapeHtml(item.comment || '未填写理由')}</strong></div>`).join('')}</section>` : '')
      + `<section class="ops-proof-section"><h4>原始 Session</h4>${sessions.length ? sessions.map(session => `<button type="button" class="ops-session-link" data-ops-action="open-session" data-session-id="${escapeHtml(session.sessionId || '')}"><strong>${escapeHtml(session.title || session.sessionId || 'Session')}</strong><small>${escapeHtml(session.kind || '')} · ${session.lastMessageTime ? relativeTime(session.lastMessageTime) : '时间未知'}</small></button>`).join('') : '<p>缺少可打开的 Session 证据。</p>'}</section>`;
  }

  async function loadLineProvenance(line) {
    const repo = activeRepo();
    const file = activeFile();
    if (!repo || !file) return;
    const sequence = ++state.provenanceSequence;
    const repoId = repo.id;
    const filePath = file.path;
    setLive(`正在追溯 ${file.path}:${line}…`);
    const result = await ipcRenderer.invoke('workbench:get-line-provenance', {
      repoRoot: repo.root,
      filePath: file.path,
      line,
      sessions: getWorkspaceHints(),
    });
    if (sequence !== state.provenanceSequence || state.view !== 'review'
        || state.activeRepoId !== repoId || state.activeFilePath !== filePath) return;
    renderProvenance(result);
    setLive(result && result.ok === false ? errorCopy(result.error) : trustLabel(result.trust));
  }

  function renderTimeline(result) {
    const center = el('ops-center-content');
    const repo = activeRepo();
    if (!center || !repo) return;
    if (el('ops-center-title')) el('ops-center-title').textContent = `${repo.name} · 因果时间线`;
    if (el('ops-center-meta')) el('ops-center-meta').textContent = 'Git 事实、Checkpoint 和 Session 线索按时间排列';
    if (!result || result.ok === false) {
      center.innerHTML = `<div class="ops-empty"><strong>时间线读取失败</strong><span>${escapeHtml(errorCopy(result && result.error))}</span></div>`;
      return;
    }
    center.innerHTML = `<div class="ops-timeline">${result.events.map(event => {
      if (event.type === 'commit') return `<article class="ops-event commit"><i></i><div><span>Git commit · 已验证</span><strong>${escapeHtml(event.commit.subject || event.commit.shortHash)}</strong><p>${escapeHtml(event.commit.shortHash)} · ${escapeHtml(event.commit.author)} · ${relativeTime(event.timestamp)}</p></div></article>`;
      if (event.type === 'checkpoint') {
        const decisionCount = event.checkpoint.reviewDecisions ? Object.keys(event.checkpoint.reviewDecisions).length : 0;
        return `<article class="ops-event checkpoint"><i></i><div><span>AI HUB Checkpoint · 内容已验证</span><strong>${escapeHtml(event.checkpoint.label)}</strong><p>${event.checkpoint.files.length} 文件 · ${decisionCount} 条审阅决策 · ${escapeHtml(event.checkpoint.id)} · ${relativeTime(event.timestamp)}</p></div></article>`;
      }
      return `<article class="ops-event session"><i></i><div><span>Session · 推断线索</span><strong>${escapeHtml(event.session.title || event.session.sessionId)}</strong><p>${escapeHtml(event.session.kind || '')} · ${relativeTime(event.timestamp)} · 尚未证明与 commit 的因果</p></div></article>`;
    }).join('')}</div>`;
    const proof = el('ops-proof-panel');
    if (proof) proof.innerHTML = '<section class="ops-proof-section emphasis"><h4>时间线口径</h4><p>Git commit 与 AI HUB 自己创建的 Checkpoint 是已验证事实；旧 Session 只有工作区和时间接近时标为“推断”，不会包装成确定因果。</p></section><section class="ops-proof-section"><h4>如何补齐</h4><p>在审阅前创建 Checkpoint。之后若正式 commit 的 tree 与 Checkpoint 完全一致，行级面板会升级为 100% 已验证关联。</p></section>';
  }

  async function loadTimeline() {
    const repo = activeRepo();
    if (!repo) return;
    const sequence = ++state.timelineSequence;
    const repoId = repo.id;
    setLive('正在整理因果时间线…');
    const result = await ipcRenderer.invoke('workbench:get-timeline', {
      repoRoot: repo.root,
      sessions: getWorkspaceHints(),
      limit: 24,
    });
    if (sequence !== state.timelineSequence || state.view !== 'timeline' || state.activeRepoId !== repoId) return;
    renderTimeline(result);
    setLive(result && result.ok === false ? errorCopy(result.error) : '时间线已按证据等级整理');
  }

  function renderCheckpoints() {
    const center = el('ops-center-content');
    const repo = activeRepo();
    if (!center || !repo) return;
    const checkpoints = (state.snapshot && Array.isArray(state.snapshot.checkpoints) ? state.snapshot.checkpoints : [])
      .filter(item => String(item.repoRoot || '').toLowerCase() === String(repo.root || '').toLowerCase());
    if (el('ops-center-title')) el('ops-center-title').textContent = `${repo.name} · Checkpoint 回放`;
    if (el('ops-center-meta')) el('ops-center-meta').textContent = '恢复永远创建新 branch/worktree，不覆盖当前工作区';
    center.innerHTML = checkpoints.length ? `<div class="ops-checkpoints">${checkpoints.map((checkpoint, index) => `<article class="ops-checkpoint-card"><div><span>${escapeHtml(checkpoint.id)} · ${relativeTime(checkpoint.createdAt)}</span><strong>${escapeHtml(checkpoint.label)}</strong><p>${checkpoint.files.length} 个变更文件 · ${checkpoint.reviewDecisions ? Object.keys(checkpoint.reviewDecisions).length : 0} 条审阅决策 · 基于 ${escapeHtml(String(checkpoint.baseHead || '').slice(0, 8) || '空仓库')}</p></div><button type="button" class="ops-button restore" data-ops-action="restore-checkpoint" data-checkpoint-index="${index}">创建恢复分支</button></article>`).join('')}</div>`
      : '<div class="ops-empty"><strong>还没有 Checkpoint</strong><span>点击右上角“创建安全 Checkpoint”，AI HUB 会用独立 Git index 捕获当前工作树。</span></div>';
    center.dataset.checkpoints = JSON.stringify(checkpoints.map(item => item.id));
    const proof = el('ops-proof-panel');
    if (proof) proof.innerHTML = `<section class="ops-proof-section emphasis"><h4>安全恢复边界</h4><p>不会运行 <code>git reset</code>，也不会切换当前分支。恢复动作只执行 <code>git worktree add -b</code>。</p></section>`
      + (state.lastRestore ? `<section class="ops-proof-section"><h4>最近恢复</h4><div class="ops-proof-card"><strong>${escapeHtml(state.lastRestore.branch)}</strong><small>${escapeHtml(state.lastRestore.destination)}</small></div><button type="button" class="ops-button subtle" data-ops-action="open-restore">打开目录</button></section>` : '');
  }

  async function loadCurrentView() {
    state.diffSequence += 1;
    state.provenanceSequence += 1;
    state.timelineSequence += 1;
    doc.querySelectorAll('[data-ops-view]').forEach(button => {
      const active = button.dataset.opsView === state.view;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    if (state.view === 'timeline') await loadTimeline();
    else if (state.view === 'checkpoints') renderCheckpoints();
    else await loadDiff();
  }

  async function selectRepo(repoId) {
    state.activeRepoId = repoId;
    const repo = activeRepo();
    state.activeFilePath = repo && repo.files.length ? repo.files[0].path : '';
    renderNavigation();
    await loadCurrentView();
  }

  function refresh(force = false) {
    if (state.refreshPromise) {
      if (!force) return state.refreshPromise;
      if (!state.forceRefreshPromise) {
        state.forceRefreshPromise = state.refreshPromise
          .then(() => refresh(true))
          .finally(() => { state.forceRefreshPromise = null; });
      }
      return state.forceRefreshPromise;
    }
    state.refreshing = true;
    setLive('正在扫描最近工作区…');
    state.refreshPromise = (async () => {
      try {
        const result = await ipcRenderer.invoke('workbench:get-overview', {
          workspaces: getWorkspaceHints(),
          force,
        });
        if (!result || result.ok === false) throw new Error(result && result.error || 'operation_failed');
        state.snapshot = result;
        const repos = result.repos || [];
        if (!repos.some(repo => repo.id === state.activeRepoId)) state.activeRepoId = repos[0] && repos[0].id || '';
        const repo = activeRepo();
        if (!repo || !repo.files.some(file => file.path === state.activeFilePath)) state.activeFilePath = repo && repo.files[0] && repo.files[0].path || '';
        renderNavigation();
        if (root && !root.classList.contains('hidden')) await loadCurrentView();
        const scanErrors = Number(result.summary && result.summary.scanErrors || 0);
        setLive(scanErrors
          ? `已发现 ${result.summary.files} 个变更文件；${scanErrors} 个工作区扫描失败`
          : `已发现 ${result.summary.files} 个最近变更文件`);
        return result;
      } catch (error) {
        setLive(errorCopy(error && error.message));
        return state.snapshot;
      }
    })().finally(() => {
      state.refreshing = false;
      state.refreshPromise = null;
    });
    return state.refreshPromise;
  }

  async function open(repoId = '') {
    if (!root) return;
    state.lastFocus = doc.activeElement;
    root.classList.remove('hidden');
    setTimeout(() => el('ops-close')?.focus(), 0);
    if (!state.snapshot) await refresh(true);
    if (repoId && state.snapshot && state.snapshot.repos.some(repo => repo.id === repoId)) await selectRepo(repoId);
    else {
      renderNavigation();
      await loadCurrentView();
    }
  }

  function close() {
    if (!root) return;
    root.classList.add('hidden');
    try { state.lastFocus?.focus(); } catch {}
  }

  async function createCheckpoint() {
    const repo = activeRepo();
    if (!repo) { setLive('请先选择一个有改动的工作区'); return; }
    if (!confirmAction(`为“${repo.name}”创建 Checkpoint？\n\n会捕获当前工作树（含未跟踪文件），写入本地 Git object 与 refs/ai-hub/checkpoints；不会改动真实 Git index、当前分支或文件。`)) return;
    const button = el('ops-create-checkpoint');
    if (button) button.disabled = true;
    setLive('正在用独立 Git index 创建 Checkpoint…');
    try {
      const result = await ipcRenderer.invoke('workbench:create-checkpoint', {
        repoRoot: repo.root,
        label: `审阅前 · ${repo.name} · ${new Date().toLocaleString('zh-CN')}`,
        sessions: getWorkspaceHints(),
      });
      if (!result || result.ok === false) throw new Error(result && result.error || 'operation_failed');
      await refresh(true);
      state.view = 'checkpoints';
      renderNavigation();
      renderCheckpoints();
      setLive(`Checkpoint ${result.checkpoint.id} 已保存`);
    } catch (error) {
      setLive(errorCopy(error && error.message));
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function restoreCheckpoint(index) {
    if (state.restorePending) return;
    const repo = activeRepo();
    if (!repo) return;
    const checkpoints = (state.snapshot.checkpoints || []).filter(item => String(item.repoRoot || '').toLowerCase() === String(repo.root).toLowerCase());
    const checkpoint = checkpoints[index];
    if (!checkpoint) return;
    if (!confirmAction(`从 ${checkpoint.id} 创建新的恢复 branch/worktree？\n\n当前分支与工作区不会被切换或覆盖。`)) return;
    state.restorePending = true;
    setLive('正在创建独立恢复 worktree…');
    try {
      const result = await ipcRenderer.invoke('workbench:restore-checkpoint', { checkpointId: checkpoint.id });
      if (!result || result.ok === false) { setLive(errorCopy(result && result.error)); return; }
      state.lastRestore = result;
      renderCheckpoints();
      setLive(`已创建 ${result.branch}`);
    } catch (error) {
      setLive(errorCopy(error && error.message));
    } finally {
      state.restorePending = false;
    }
  }

  async function saveDecision(button, decisionOverride) {
    const repo = activeRepo();
    const file = activeFile();
    if (!repo || !file) return;
    const hunkId = button.dataset.hunkId;
    const article = button.closest('.ops-hunk');
    const textarea = article && article.querySelector(`[data-ops-comment="${hunkId}"]`);
    const decision = decisionOverride || button.dataset.decision || 'pending';
    const controls = article ? [...article.querySelectorAll('button, textarea')] : [button];
    controls.forEach(control => { control.disabled = true; });
    try {
      const result = await ipcRenderer.invoke('workbench:set-review-decision', {
        repoRoot: repo.root,
        filePath: file.path,
        hunkId,
        decision,
        comment: textarea && textarea.value || '',
      });
      if (!result || result.ok === false) { setLive(errorCopy(result && result.error)); await loadDiff(); return; }
      setLive(decision === 'accepted' ? '已记录接受；Git index 未改变' : decision === 'rejected' ? '已记录拒绝；代码未被丢弃' : '已更新审阅记录');
      await loadDiff();
    } catch (error) {
      setLive(errorCopy(error && error.message));
    } finally {
      controls.forEach(control => { if (control.isConnected) control.disabled = false; });
    }
  }

  async function handleAction(button) {
    const action = button.dataset.opsAction;
    if (action === 'select-repo') {
      const repo = state.snapshot.repos[Number(button.dataset.repoIndex)];
      if (repo) await selectRepo(repo.id);
    } else if (action === 'select-file') {
      const repo = activeRepo();
      const file = repo && repo.files[Number(button.dataset.fileIndex)];
      if (file) { state.activeFilePath = file.path; renderNavigation(); await loadCurrentView(); }
    } else if (action === 'review-decision') await saveDecision(button);
    else if (action === 'save-comment') await saveDecision(button, button.dataset.decision || 'pending');
    else if (action === 'line-provenance') await loadLineProvenance(Number(button.dataset.line));
    else if (action === 'open-session' && button.dataset.sessionId) { close(); onOpenSession(button.dataset.sessionId); }
    else if (action === 'restore-checkpoint') await restoreCheckpoint(Number(button.dataset.checkpointIndex));
    else if (action === 'open-restore' && state.lastRestore) await onOpenPath(state.lastRestore.destination);
  }

  if (root) {
    root.addEventListener('click', event => {
      if (event.target === root) { close(); return; }
      const viewButton = event.target.closest('[data-ops-view]');
      if (viewButton) {
        state.view = viewButton.dataset.opsView;
        runSafely(loadCurrentView());
        return;
      }
      const actionButton = event.target.closest('[data-ops-action]');
      if (actionButton) runSafely(handleAction(actionButton));
    });
    el('ops-close')?.addEventListener('click', close);
    el('ops-create-checkpoint')?.addEventListener('click', () => runSafely(createCheckpoint()));
    doc.addEventListener('keydown', event => {
      if (root.classList.contains('hidden')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation?.();
        close();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...root.querySelectorAll('button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex="0"]')]
        .filter(node => node.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!root.contains?.(doc.activeElement)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
    });
  }

  return {
    close,
    getSnapshot: () => state.snapshot,
    isOpen: () => !!(root && !root.classList.contains('hidden')),
    open,
    refresh,
  };
}

module.exports = { createWorkbenchOperationsController };
