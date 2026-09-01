'use strict';
const { formatBeijingDateTime } = require('../core/beijing-time.js');
// renderer/memory-panel.js
//
// 记忆系统面板：从用量 ticker 的「记忆」按钮打开。
// 四个页签：总览（各 CLI 记忆/规则文件现状）、梦境记录（沉淀行为可回溯）、
// 当前会话（本 session 实际读到的规则链与 memory 桶）、设置（consolidation 段）。
// 文件预览复用现有 read-file / show-in-folder IPC，本面板不新增文件读取通道。

function createMemoryPanel({ document, ipcRenderer, escapeHtml, getActiveSessionInfo }) {
  if (!document) throw new Error('document is required');
  if (!ipcRenderer) throw new Error('ipcRenderer is required');
  if (typeof escapeHtml !== 'function') throw new Error('escapeHtml is required');

  let overlay = null;
  let activeTab = 'overview';
  let lastOverview = null;

  const fmtSize = (n) => {
    if (typeof n !== 'number') return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  };
  const fmtTime = (ms) => {
    return ms ? formatBeijingDateTime(ms, { seconds: false }) : '';
  };

  // ---------- DOM 骨架 ----------

  function buildOverlay() {
    overlay = document.createElement('div');
    overlay.className = 'mp-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML = `
      <div class="mp-modal">
        <div class="mp-header">
          <span class="mp-title">记忆系统</span>
          <div class="mp-tabs">
            <button class="mp-tab" data-tab="overview">总览</button>
            <button class="mp-tab" data-tab="dream">整理记录</button>
            <button class="mp-tab" data-tab="session">当前会话</button>
            <button class="mp-tab" data-tab="settings">设置</button>
          </div>
          <button class="mp-close" title="关闭 (Esc)">✕</button>
        </div>
        <div class="mp-body">
          <div class="mp-list" id="mp-list"></div>
          <div class="mp-preview" id="mp-preview">
            <div class="mp-preview-path" id="mp-preview-path"></div>
            <div class="mp-preview-actions">
              <button class="mp-btn" id="mp-show-in-folder" style="display:none">打开所在文件夹</button>
            </div>
            <pre class="mp-preview-content" id="mp-preview-content"></pre>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector('.mp-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelectorAll('.mp-tab').forEach(btn => {
      btn.addEventListener('click', () => { setTab(btn.dataset.tab); });
    });
    overlay.querySelector('#mp-show-in-folder').addEventListener('click', () => {
      const p = overlay.querySelector('#mp-preview-path').dataset.path;
      if (p) ipcRenderer.invoke('show-in-folder', p);
    });
  }

  // 这两个监听必须在工厂调用时就挂上，不能等 buildOverlay——
  // 用量 ticker 每次 render 都重建 innerHTML，「记忆」按钮的监听只能走文档级委托；
  // 若放进 buildOverlay 则首次 open 前委托不存在，按钮永远是死的（2026-08-01 E2E 实测）。
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay && overlay.style.display !== 'none') close();
  });
  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('[data-action="open-memory"]')) open();
  });

  function setTab(tab) {
    activeTab = tab;
    overlay.querySelectorAll('.mp-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    clearPreview();
    renderTab();
  }

  function clearPreview() {
    overlay.querySelector('#mp-preview-path').textContent = '';
    overlay.querySelector('#mp-preview-path').dataset.path = '';
    overlay.querySelector('#mp-preview-content').textContent = '';
    overlay.querySelector('#mp-show-in-folder').style.display = 'none';
  }

  async function previewFile(p) {
    const pathEl = overlay.querySelector('#mp-preview-path');
    const contentEl = overlay.querySelector('#mp-preview-content');
    pathEl.textContent = p;
    pathEl.dataset.path = p;
    pathEl.title = p;
    contentEl.textContent = '读取中…';
    const result = await ipcRenderer.invoke('read-file', p);
    if (result && result.error) {
      contentEl.textContent = `无法读取：${result.error}`;
      overlay.querySelector('#mp-show-in-folder').style.display = 'none';
      return;
    }
    const content = result.content || '';
    contentEl.textContent = content.length > 200000 ? content.slice(0, 200000) + '\n…（截断）' : content;
    overlay.querySelector('#mp-show-in-folder').style.display = '';
  }

  function fileRow({ label, path, exists, size, mtime, badge, badgeCls }) {
    const cls = exists === false ? 'mp-file missing' : 'mp-file';
    const meta = exists ? `${fmtSize(size)} · ${fmtTime(mtime)}` : '不存在';
    const b = badge ? `<span class="mp-badge ${badgeCls || ''}">${escapeHtml(badge)}</span>` : '';
    return `<div class="${cls}" data-path="${escapeHtml(path || '')}">
      <div class="mp-file-main">
        <span class="mp-file-label">${escapeHtml(label)}</span>${b}
        <span class="mp-file-path" title="${escapeHtml(path || '')}">${escapeHtml(path || '')}</span>
      </div>
      <span class="mp-file-meta">${escapeHtml(meta)}</span>
    </div>`;
  }

  function bindFileRows() {
    overlay.querySelectorAll('.mp-file[data-path]').forEach(row => {
      row.addEventListener('click', () => {
        overlay.querySelectorAll('.mp-file').forEach(r => r.classList.remove('active'));
        row.classList.add('active');
        previewFile(row.dataset.path);
      });
    });
  }

  // 目录行：点击二级展开/收起子文件列表。目录本身不进预览——read-file IPC 只收
  // 白名单扩展名的文件，点目录只会得到 unsupported extension（2026-08-01 用户实测）。
  function dirRow({ label, path: dirPath, badge, badgeCls, children, extraHtml }) {
    const id = `mp-dir-${Math.random().toString(36).slice(2, 9)}`;
    return `<div class="mp-dir">
      <div class="mp-file mp-dir-head" data-dir-toggle="${id}">
        <div class="mp-file-main">
          <span class="mp-caret">▸</span>
          <span class="mp-file-label">${escapeHtml(label)}</span>${badge ? `<span class="mp-badge ${badgeCls || ''}">${escapeHtml(badge)}</span>` : ''}
          <span class="mp-file-path" title="${escapeHtml(dirPath || '')}">${escapeHtml(dirPath || '')}</span>
        </div>
        ${extraHtml || ''}
      </div>
      <div class="mp-children" id="${id}" style="display:none">${children || '<div class="mp-more">（空）</div>'}</div>
    </div>`;
  }

  function bindDirRows() {
    overlay.querySelectorAll('[data-dir-toggle]').forEach(head => {
      head.addEventListener('click', (e) => {
        if (e.target.closest('.mp-merge-btn')) return; // 「并入规范库」按钮不触发展开
        const box = overlay.querySelector(`#${CSS.escape(head.dataset.dirToggle)}`);
        if (!box) return;
        const open = box.style.display !== 'none';
        box.style.display = open ? 'none' : '';
        const caret = head.querySelector('.mp-caret');
        if (caret) caret.textContent = open ? '▸' : '▾';
      });
    });
  }

  // ---------- 总览 ----------

  async function renderOverview() {
    // 守卫必须放在任何 DOM 写入之前：「并入」成功后的 1.5s 自动重渲染是定时器触发，
    // 此时用户可能已切走页签；先写「巡检中…」再判断就就已经把别的页签冲掉了。
    if (activeTab !== 'overview') return;
    const list = overlay.querySelector('#mp-list');
    list.innerHTML = '<div class="mp-empty">巡检中…</div>';
    lastOverview = await ipcRenderer.invoke('memory:get-overview');
    const o = lastOverview;
    if (activeTab !== 'overview') return; // await 期间又切走了
    if (!o) { list.innerHTML = '<div class="mp-empty">巡检失败</div>'; return; }

    const sections = [];
    sections.push(`<div class="mp-section"><div class="mp-sec-title">用户级规则（四家 CLI 各自读取，不互相冒充）</div>${
      o.userGlobalFiles.map(f => fileRow({
        label: f.label, path: f.path, exists: f.exists, size: f.size, mtime: f.mtime,
        badge: f.hasDreamSection ? '梦境区' : '', badgeCls: 'dream',
      })).join('')}</div>`);

    // 平铺模式下工作根就是新会话 cwd；CLI 在启动时读取规则链，已打开的会话
    // 不会实时重建启动 prompt，不能再写「改完立即生效」。
    const workspaceSecTitle = o.flatRoot
      ? `工作根规则（${escapeHtml(o.workspaceRoot || '')} · 新启动会话共享；已打开会话需重开）`
      : '工作区规则（seed 源 · 改动自动播种到未来临时工作区）';
    sections.push(`<div class="mp-section"><div class="mp-sec-title">${workspaceSecTitle}</div>${
      o.workspaceFiles.map(f => fileRow({
        label: f.label, path: f.path, exists: f.exists, size: f.size, mtime: f.mtime,
        badge: f.hasDreamSection ? '梦境区' : '', badgeCls: 'dream',
      })).join('')}</div>`);

    const cm = o.claudeMemory;
    const memBadge = cm.islandCount ? `<span class="mp-badge warn">${cm.islandCount} 个孤岛</span>` : `<span class="mp-badge ok">${cm.linkedCount} 桶已链接</span>`;
    // 标题必须用真实总数：列表被 listMdFiles 截到最近 50 个，照 files.length 写
    // 会把 206 篇说成 50 篇。
    const canonicalTotal = typeof cm.canonical.totalFiles === 'number'
      ? cm.canonical.totalFiles
      : cm.canonical.files.length;
    const canonicalChildren = cm.canonical.files.map(f =>
      fileRow({ label: f.name, path: f.path, exists: true, size: f.size, mtime: f.mtime })).join('')
      + (canonicalTotal > cm.canonical.files.length
        ? `<div class="mp-more">… 共 ${canonicalTotal} 个，仅列最近修改的 ${cm.canonical.files.length} 个</div>`
        : '');
    sections.push(`<div class="mp-section">
      <div class="mp-sec-title">Claude memory 规范库 ${memBadge}</div>
      ${dirRow({ label: `规范库（${canonicalTotal} 个文件）`, path: cm.canonical.path, children: canonicalChildren })}
    </div>`);

    const codexMemory = o.codexMemory || {};
    const codexBadge = codexMemory.useMemories
      ? '<span class="mp-badge ok">已启用</span>'
      : '<span class="mp-badge dim">未启用</span>';
    const codexChildren = (codexMemory.files || []).map(f =>
      fileRow({ label: f.name, path: f.path, exists: true, size: f.size, mtime: f.mtime })).join('');
    sections.push(`<div class="mp-section">
      <div class="mp-sec-title">Codex local memories（独立于 Claude）${codexBadge}</div>
      ${dirRow({
        label: `~/.codex/memories（主文件 ${codexMemory.totalFiles || 0} · rollout summaries ${codexMemory.rolloutSummaryCount || 0}）`,
        path: codexMemory.path,
        children: codexChildren || '<div class="mp-more">当前没有可展示的 Markdown memory 文件。</div>',
      })}
      <div class="mp-kv">Codex memory 在会话空闲后后台生成，不保证回答结束立刻写入；必达规则仍应放 AGENTS.md。</div>
    </div>`);

    const islands = cm.buckets.filter(b => b.status === 'island');
    if (islands.length) {
      sections.push(`<div class="mp-section"><div class="mp-sec-title">memory 孤岛桶（真实目录，未被共享）</div>${
        islands.map(b => dirRow({
          label: `${b.bucket}（${b.fileCount} 文件 · ${b.root}）`,
          path: b.path,
          badge: '孤岛',
          badgeCls: 'warn',
          extraHtml: `<button class="mp-btn mp-merge-btn" data-root="${escapeHtml(b.root)}" data-slug="${escapeHtml(b.bucket)}" title="机械并入规范库并换 junction（不是 LLM 蒸馏；原名冲突自动另存，原目录留底）">并入规范库</button>`,
          children: (b.files || []).map(f => fileRow({ label: f.name, path: f.path, exists: true, size: f.size, mtime: f.mtime })).join('')
            + (b.fileCount > (b.files || []).length ? `<div class="mp-more">… 共 ${b.fileCount} 个，仅列前 ${(b.files || []).length} 个</div>` : ''),
        })).join('')}</div>`);
    }

    // seed 副本区：平铺模式下不再产生新副本（cwd 就是根，规则被直接读取）。
    // 但存量副本仍可能有「被改过、还没并回根规则」的知识，那是真要处理的，
    // 所以只在确实还有存量时才显示；一份都没有时整区隐藏，避免留一块永远
    // 空着的面板让人以为功能坏了。
    const sc = o.seedCopies;
    const hasSeedCopies = sc && Array.isArray(sc.copies) && sc.copies.length > 0;
    if (hasSeedCopies) {
      const seedTitle = o.flatRoot
        ? 'seed 副本（存量临时工作区的 AGENTS.md · 平铺后不再新增）'
        : 'seed 副本（临时工作区的 AGENTS.md）';
      sections.push(`<div class="mp-section">
        <div class="mp-sec-title">${seedTitle}${sc.modifiedCount ? `<span class="mp-badge warn">${sc.modifiedCount} 份被改过</span>` : '<span class="mp-badge ok">全部与源同步</span>'}</div>
        ${sc.copies.filter(c => c.status === 'modified').slice(0, 10).map(c =>
          fileRow({ label: c.cwd.split(/[\\/]/).pop(), path: c.path, exists: true, size: 0, mtime: 0, badge: '已修改', badgeCls: 'warn' })).join('') || '<div class="mp-more">没有被本地修改的副本。</div>'}
      </div>`);
    }

    const c = o.consolidation;
    const lastRun = c.state && c.state.summary;
    const coverage = c.coverage || {};
    sections.push(`<div class="mp-section"><div class="mp-sec-title">Seed / memory 孤岛整理器</div>
      <div class="mp-kv">状态：${c.config.enabled ? '启用' : '停用'} · ${escapeHtml(c.config.provider)} / ${escapeHtml(c.config.model || '默认')} · 每天 ${escapeHtml(c.config.schedule)} · autoApply=${c.config.autoApply ? '开' : '关'}</div>
      <div class="mp-kv">上次运行：${c.state.lastRunAt ? escapeHtml(fmtTime(Date.parse(c.state.lastRunAt))) : '从未'}${lastRun ? ` · 候选 ${lastRun.candidates} · 落盘 ${lastRun.applied || 0} · staging ${lastRun.staged || 0}（${escapeHtml(lastRun.note || '')}）` : ''}</div>
      <div class="mp-kv">changelog 共 ${c.changelogCount} 条${c.staging && c.staging.exists ? ` · staging 待升级 ${fmtSize(c.staging.size)}` : ''}</div>
      <div class="mp-kv">覆盖边界：${escapeHtml(coverage.label || 'seed / memory 孤岛')}；<b>不采集普通 Session transcript、工具结果、commit 或用户纠正</b>。</div>
    </div>`);

    list.innerHTML = sections.join('');
    bindFileRows();
    bindDirRows();
    overlay.querySelectorAll('.mp-merge-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        btn.disabled = true;
        btn.textContent = '并入中…';
        const r = await ipcRenderer.invoke('memory:merge-island', { root: btn.dataset.root, slug: btn.dataset.slug });
        if (r && !r.error) {
          btn.textContent = `已并入 ${r.merged.length} 条${r.conflicts.length ? `（冲突另存 ${r.conflicts.length}）` : ''}`;
          setTimeout(() => renderOverview(), 1500);
        } else {
          btn.textContent = `失败：${(r && r.error) || '未知错误'}`;
          btn.disabled = false;
        }
      });
    });
  }

  // ---------- 梦境记录 ----------

  function describeEntry(e) {
    const time = e.ts ? fmtTime(Date.parse(e.ts)) : '';
    switch (e.phase) {
      case 'collect':
        return `<div class="mp-log"><span class="mp-log-time">${escapeHtml(time)}</span><span class="mp-badge">采集</span> 候选 ${e.candidates ? e.candidates.length : 0} 个${e.overflow ? `（${e.overflow} 个溢出下轮）` : ''}</div>`;
      case 'distill':
        return `<div class="mp-log"><span class="mp-log-time">${escapeHtml(time)}</span><span class="mp-badge">蒸馏</span> ${escapeHtml(e.candidate || '')} → ${e.entries ? e.entries.length : 0} 条</div>`;
      case 'apply': {
        const claims = (e.claims || []).map(c => `<div class="mp-log-claim">${escapeHtml(c)}</div>`).join('');
        const ev = (e.evidence || []).map(x => `<div class="mp-log-ev">证据：${escapeHtml(x.evidence || '')}</div>`).join('');
        return `<div class="mp-log"><span class="mp-log-time">${escapeHtml(time)}</span><span class="mp-badge ok">落盘</span> [${escapeHtml(e.layer || '')}] ${escapeHtml(e.file || '')}${e.snapshot ? ' · 已快照' : ''}${claims}${ev}</div>`;
      }
      case 'staging':
        return `<div class="mp-log"><span class="mp-log-time">${escapeHtml(time)}</span><span class="mp-badge warn">staging</span> ${e.count || 0} 条待升级</div>`;
      case 'error':
        return `<div class="mp-log"><span class="mp-log-time">${escapeHtml(time)}</span><span class="mp-badge err">错误</span> ${escapeHtml(e.candidate || '')}：${escapeHtml(e.error || '')}</div>`;
      case 'done': {
        const s = e.summary || {};
        return `<div class="mp-log"><span class="mp-log-time">${escapeHtml(time)}</span><span class="mp-badge">完成</span> 候选 ${s.candidates || 0} · 落盘 ${s.applied || 0} · staging ${s.staged || 0}（${escapeHtml(s.note || '')}）</div>`;
      }
      default:
        return `<div class="mp-log"><span class="mp-log-time">${escapeHtml(time)}</span>${escapeHtml(e.phase || '')}</div>`;
    }
  }

  async function renderDream() {
    const list = overlay.querySelector('#mp-list');
    list.innerHTML = `
      <div class="mp-section">
        <div class="mp-sec-title">Seed / memory 孤岛整理记录（可回溯）<button class="mp-btn mp-run-now" id="mp-run-now">立即整理一轮</button></div>
        <div class="mp-kv">这里只整理被修改的 seed AGENTS.md 与 Claude memory 孤岛；普通 Session 尚未进入自动蒸馏。</div>
        <div id="mp-run-result"></div>
        <div id="mp-log-list"><div class="mp-empty">读取中…</div></div>
      </div>`;
    overlay.querySelector('#mp-run-now').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      btn.textContent = '运行中…';
      const resultEl = overlay.querySelector('#mp-run-result');
      resultEl.innerHTML = '';
      try {
        const r = await ipcRenderer.invoke('consolidation:run-now');
        if (r && r.success) {
          const s = r.summary;
          resultEl.innerHTML = `<div class="mp-run-ok">完成：候选 ${s.candidates} · 落盘 ${s.applied || 0} · staging ${s.staged || 0} · 跳过 ${s.skipped || 0}（${escapeHtml(s.note || '')}）</div>`;
        } else {
          resultEl.innerHTML = `<div class="mp-run-err">失败：${escapeHtml((r && r.error) || '未知错误')}</div>`;
        }
      } finally {
        btn.disabled = false;
        btn.textContent = '立即整理一轮';
        const entries = await ipcRenderer.invoke('memory:get-changelog', 200);
        overlay.querySelector('#mp-log-list').innerHTML = entries.map(describeEntry).join('') || '<div class="mp-empty">暂无记录</div>';
      }
    });
    const entries = await ipcRenderer.invoke('memory:get-changelog', 200);
    if (activeTab !== 'dream') return; // await 期间用户切页签，不写旧内容
    overlay.querySelector('#mp-log-list').innerHTML = entries.map(describeEntry).join('') || '<div class="mp-empty">暂无记录——今晚 03:40 或点上方按钮跑第一轮。</div>';
  }

  // ---------- 当前会话 ----------

  async function renderSession() {
    const list = overlay.querySelector('#mp-list');
    const info = typeof getActiveSessionInfo === 'function' ? getActiveSessionInfo() : null;
    if (!info || !info.cwd) {
      list.innerHTML = '<div class="mp-empty">当前没有已建立 cwd 的活动会话（新会话发出第一条消息后才有 cwd）。</div>';
      return;
    }
    list.innerHTML = '<div class="mp-empty">巡检中…</div>';
    const data = await ipcRenderer.invoke('memory:get-session-files', {
      cwd: info.cwd,
      kind: info.kind,
      runtimeKind: info.runtimeKind,
      codexSessionsRoot: info.codexSessionsRoot,
      codexProfile: info.codexProfile,
      meetingId: info.meetingId,
    });
    if (activeTab !== 'session') return; // await 期间用户切页签，不写旧内容
    const seedBadge = (s) => {
      if (s === 'synced') return '<span class="mp-badge ok">与源同步</span>';
      if (s === 'modified') return '<span class="mp-badge warn">本地已修改·待梦境沉淀</span>';
      if (s === 'own') return '<span class="mp-badge">项目自有</span>';
      return '<span class="mp-badge dim">无文件</span>';
    };
    const memLabel = {
      linked: '已链接规范库', island: '孤岛（未共享）', 'empty-dir': '空目录', missing: '未创建',
      enabled: '已启用', present: '目录存在但未启用', disabled: '未启用',
    };
    const memCls = {
      linked: 'ok', island: 'warn', 'empty-dir': 'dim', missing: 'dim',
      enabled: 'ok', present: 'warn', disabled: 'dim',
    };
    const seedFile = data.files.find(f => f.seedStatus);
    list.innerHTML = `
      <div class="mp-section"><div class="mp-sec-title">${escapeHtml(info.title || info.kind || '当前会话')}</div>
        <div class="mp-kv" title="${escapeHtml(data.cwd)}">cwd：${escapeHtml(data.cwd)} · runtime：${escapeHtml(data.runtimeKind || data.kind || '')}</div></div>
      <div class="mp-section"><div class="mp-sec-title">实际规则文件链</div>
        <div class="mp-kv">${escapeHtml(data.ruleNote || '')}</div>
        ${data.files.map(f => fileRow({
          label: f.label, path: f.path, exists: f.exists, size: f.size, mtime: f.mtime,
          badge: f.seedStatus ? undefined : (f.hasDreamSection ? '梦境区' : ''),
          badgeCls: 'dream',
        })).join('') || '<div class="mp-more">该 provider 没有可核验的规则文件。</div>'}
        ${seedFile ? `<div class="mp-kv">本目录 AGENTS.md 状态：${seedBadge(seedFile.seedStatus)}</div>` : ''}
      </div>
      <div class="mp-section"><div class="mp-sec-title">Provider memory</div>
        <div class="mp-kv">${escapeHtml(data.memoryNote || '')}</div>
        ${data.memory.map(m => `<div class="mp-kv">${escapeHtml(m.label || m.root || '')} <span class="mp-badge ${memCls[m.status] || ''}">${memLabel[m.status] || m.status}</span> <span class="mp-file-path" title="${escapeHtml(m.path)}">${escapeHtml(m.path)}</span>${typeof m.totalFiles === 'number' ? ` · 主文件 ${m.totalFiles}` : ''}${typeof m.rolloutSummaryCount === 'number' ? ` · summaries ${m.rolloutSummaryCount}` : ''}</div>`).join('') || '<div class="mp-more">无 Hub 可核验的 provider memory store。</div>'}
        ${(data.memoryFiles || []).map(f => fileRow({ label: f.label, path: f.path, exists: f.exists, size: f.size, mtime: f.mtime })).join('')}
      </div>`;
    bindFileRows();
  }

  // ---------- 设置 ----------

  async function renderSettings() {
    const list = overlay.querySelector('#mp-list');
    const cfg = await ipcRenderer.invoke('consolidation:get-config');
    if (activeTab !== 'settings') return; // await 期间用户切页签，不写旧内容
    const providerOptions = [
      ['deepseek-api', 'DeepSeek API（推荐 · 约 ¥2/月）'],
      ['claude-cli', 'Claude CLI（走订阅）'],
      ['codex-cli', 'Codex CLI（走订阅）'],
      ['kimi-cli', 'Kimi CLI（走订阅）'],
      ['gemini-cli', 'Gemini CLI（走订阅）'],
    ].map(([v, label]) => `<option value="${v}"${cfg.provider === v ? ' selected' : ''}>${label}</option>`).join('');
    list.innerHTML = `
      <div class="mp-section">
        <div class="mp-sec-title">Seed / memory 孤岛整理设置（写入 config.json 的 consolidation 段）</div>
        <label class="mp-field"><input type="checkbox" id="mp-cfg-enabled"${cfg.enabled ? ' checked' : ''}> 启用每日 seed / 孤岛整理</label>
        <label class="mp-field"><input type="checkbox" id="mp-cfg-autoapply"${cfg.autoApply ? ' checked' : ''}> 自动落盘（关则全部进 staging 待人工）</label>
        <label class="mp-field">每日运行时间 <input type="text" id="mp-cfg-schedule" value="${escapeHtml(cfg.schedule)}" placeholder="03:40" size="6"></label>
        <div class="mp-kv">Hub 本地时间到点触发；当时没开机则在下次启动后约 30 秒补跑。</div>
        <label class="mp-field">LLM 通道 <select id="mp-cfg-provider">${providerOptions}</select></label>
        <label class="mp-field">模型 <input type="text" id="mp-cfg-model" value="${escapeHtml(cfg.model || '')}" placeholder="deepseek-chat" size="24"></label>
        <label class="mp-field">每轮候选上限 <input type="number" id="mp-cfg-maxc" value="${cfg.maxCandidatesPerRun}" min="1" max="50" style="width:64px"></label>
        <div class="mp-kv"><b>覆盖边界：不读取普通 Session transcript。</b>候选 = 本轮发现的知识源（被改过的 seed 副本 + Claude memory 孤岛桶），每个候选一次 LLM 调用。
          上限控制单轮 token 开销与噪声；超出的候选原样留到下一轮，不会丢。
          同一候选内容没变化时第二轮起自动跳过（增量去重），日常开销趋近于零。</div>
        <div class="mp-kv">DeepSeek API Key 沿用 Hub 已有配置（设置 → DeepSeek）；订阅通道走各 CLI 本机登录态。</div>
        <div class="mp-field"><button class="mp-btn primary" id="mp-cfg-save">保存设置</button><span id="mp-cfg-msg"></span></div>
      </div>`;
    overlay.querySelector('#mp-cfg-save').addEventListener('click', async () => {
      const patch = {
        enabled: overlay.querySelector('#mp-cfg-enabled').checked,
        autoApply: overlay.querySelector('#mp-cfg-autoapply').checked,
        schedule: overlay.querySelector('#mp-cfg-schedule').value.trim(),
        provider: overlay.querySelector('#mp-cfg-provider').value,
        model: overlay.querySelector('#mp-cfg-model').value.trim(),
        maxCandidatesPerRun: parseInt(overlay.querySelector('#mp-cfg-maxc').value, 10),
      };
      const r = await ipcRenderer.invoke('consolidation:save-config', patch);
      overlay.querySelector('#mp-cfg-msg').textContent = r && r.success ? ' 已保存' : ` 保存失败：${(r && r.error) || ''}`;
    });
  }

  function renderTab() {
    if (activeTab === 'overview') renderOverview();
    else if (activeTab === 'dream') renderDream();
    else if (activeTab === 'session') renderSession();
    else if (activeTab === 'settings') renderSettings();
  }

  function open() {
    if (!overlay) buildOverlay();
    overlay.style.display = 'flex';
    setTab(activeTab);
  }

  function close() {
    if (overlay) overlay.style.display = 'none';
  }

  return { open, close, isOpen: () => overlay && overlay.style.display !== 'none' };
}

module.exports = { createMemoryPanel };
