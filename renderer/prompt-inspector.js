'use strict';
// 卡片上的「🔍 查看完整 Prompt」面板。
//
// 展示的是「以这个会话的 cwd 起会话时，CLI 会注入哪些本地来源」——CLAUDE.md 链、
// AGENTS.md 链、记忆桶状态、以及它们各自的字节数。所有判定逻辑在主进程的
// core/prompt-inspect.js 里（有单测），这里只负责画。
//
// 刻意不展示内置系统提示词与工具定义的正文：那两块由 CLI 自己拼装、用户改不了，
// 而用户要判断的是"我写的规则和记忆有没有进去"。

(function () {
  const win = typeof window !== 'undefined' ? window : globalThis;
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const fmtBytes = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

  const SOURCE_LABEL = {
    'user-global': '全局',
    'project': '项目',
    'local': '私有未入库',
  };

  const MEM_STATE = {
    LINKED: ['ok', '已链到规范库'],
    PRIVATE_REAL: ['warn', '独立记忆'],
    EMPTY_REAL: ['bad', '空目录·永久不共享'],
    NOBUCKET: ['warn', '尚无记忆桶'],
  };

  function renderChecks(health) {
    if (!health || !health.length) return '';
    const items = health.map(c => `
      <div class="pi-chk ${esc(c.level)}">
        <b>${esc(c.title)}</b>
        <span>${esc(c.detail)}</span>
      </div>`).join('');
    return `<div class="pi-sec"><h5>注入体检</h5><div class="pi-checks">${items}</div></div>`;
  }

  function renderBudget(d) {
    const rule = d.totals.ruleBytes || 0;
    const mem = d.totals.memoryIndexBytes || 0;
    const total = rule + mem || 1;
    const pRule = Math.round(rule / total * 100);
    const pMem = 100 - pRule;
    return `<div class="pi-sec">
      <h5>你可控部分的体量</h5>
      <div class="pi-bar">
        <i style="width:${pRule}%;background:var(--accent-blue)"></i>
        <i style="width:${pMem}%;background:var(--ui-purple-2)"></i>
      </div>
      <div class="pi-legend">
        <span><i class="pi-sq" style="background:var(--accent-blue)"></i>规则文件 ${fmtBytes(rule)}</span>
        <span><i class="pi-sq" style="background:var(--ui-purple-2)"></i>记忆索引 ${fmtBytes(mem)}</span>
        <span>合计 ≈ ${d.totals.approxRuleTokens + Math.round(mem / 3.2)} tokens（粗估）</span>
      </div>
    </div>`;
  }

  function renderImports(imports) {
    if (!imports || !imports.length) return '';
    return imports.map(im => {
      const tag = im.absolute
        ? '<span class="pi-tag bad">绝对路径·不展开</span>'
        : (im.exists ? '<span class="pi-tag ok">已展开</span>' : '<span class="pi-tag bad">目标不存在</span>');
      return `<div class="pi-row" style="margin-left:14px">
        <span class="pi-tag">@import</span>${tag}
        <span class="pi-path">${esc(im.spec)}</span>
        <span class="pi-sz">${im.exists ? fmtBytes(im.bytes) : '—'}</span>
      </div>`;
    }).join('');
  }

  function renderClaudeGroup(d) {
    const entries = d.claude.entries || [];
    const total = entries.reduce((s, e) => s + e.bytes, 0);
    const rows = entries.map(e => `
      <div class="pi-item">
        <div class="pi-row">
          <span class="pi-tag">${esc(SOURCE_LABEL[e.source] || e.source)}</span>
          <span class="pi-path">${esc(e.path)}</span>
          <span class="pi-sz">${fmtBytes(e.bytes)}</span>
        </div>
        ${renderImports(e.imports)}
      </div>`).join('') || '<div class="pi-item"><span class="pi-path">（无）</span></div>';

    const orphans = (d.orphanAgents || []).map(o => `
      <div class="pi-item">
        <div class="pi-row">
          <span class="pi-tag bad">读不到</span>
          <span class="pi-path">${esc(o.path)}</span>
          <span class="pi-sz">${fmtBytes(o.bytes)}</span>
        </div>
      </div>`).join('');

    return `<details class="pi-grp" open>
      <summary><span class="pi-gname">CLAUDE.md 链</span>
        <span class="pi-gmeta">${entries.length} 份 · ${fmtBytes(total)}</span></summary>
      <div class="pi-gbody">
        <div class="pi-why">从 cwd 一路向上收集到盘符根，<b>不受 git 边界限制</b>；顺序从外到内，越靠内越晚出现、实际优先级越高。</div>
        ${rows}
        ${orphans ? `<div class="pi-why">下面这些 AGENTS.md 就在路径上，但 Claude 从不自动读。想让它生效，在同目录放一个 CLAUDE.md 写一行 <code>@AGENTS.md</code>。</div>${orphans}` : ''}
      </div>
    </details>`;
  }

  function renderCodexGroup(d) {
    const cx = d.codex || { entries: [] };
    const entries = cx.entries || [];
    const total = entries.reduce((s, e) => s + e.bytes, 0);
    const rows = entries.map(e => `
      <div class="pi-item">
        <div class="pi-row">
          <span class="pi-tag">${esc(SOURCE_LABEL[e.source] || e.source)}</span>
          <span class="pi-path">${esc(e.path)}</span>
          <span class="pi-sz">${fmtBytes(e.bytes)}</span>
        </div>
      </div>`).join('') || '<div class="pi-item"><span class="pi-path">（无）</span></div>';

    return `<details class="pi-grp" open>
      <summary><span class="pi-gname">AGENTS.md 链</span>
        <span class="pi-gmeta">${entries.length} 份 · ${fmtBytes(total)}</span></summary>
      <div class="pi-gbody">
        <div class="pi-why">Codex 从 project root 向下收集到 cwd，<b>不越过 root</b>。当前 root =
          <code>${esc(cx.projectRoot || '未找到')}</code>，markers = <code>[${esc((cx.markers || []).join(', '))}]</code>
          ${cx.markersConfigured ? '（已在 config.toml 配置）' : '（默认值）'}。</div>
        ${rows}
      </div>
    </details>`;
  }

  function renderMemoryGroup(d) {
    const m = d.memory;
    const [lvl, label] = MEM_STATE[m.state] || ['warn', m.state];
    return `<details class="pi-grp" open>
      <summary><span class="pi-gname">记忆</span>
        <span class="pi-gmeta">${m.files} 条 · 索引 ${fmtBytes(m.indexBytes)}</span></summary>
      <div class="pi-gbody">
        <div class="pi-why">记忆桶按 <b>cwd 的真实路径</b>分，不按会话分。同一个 cwd 的所有会话共享一个桶；换目录就换桶。<b>只有索引 MEMORY.md 进 prompt</b>，正文按需读取。</div>
        <div class="pi-item">
          <div class="pi-row"><span class="pi-tag ${lvl}">${esc(label)}</span>
            <span class="pi-path">${esc(m.memoryDir)}</span>
            <span class="pi-sz">${m.files} 条</span></div>
        </div>
        <div class="pi-item">
          <div class="pi-row"><span class="pi-tag">桶名</span><span class="pi-path">${esc(m.slug)}</span></div>
        </div>
        ${m.linkTarget ? `<div class="pi-item"><div class="pi-row"><span class="pi-tag ok">指向</span>
          <span class="pi-path">${esc(m.linkTarget)}</span></div></div>` : ''}
        ${m.state === 'NOBUCKET' || m.state === 'EMPTY_REAL'
          ? `<div class="pi-why">规范库在 <span class="pi-path">${esc(m.canonicalDir)}</span>。要共享它，先删掉这个空目录，再让 Hub 重新建 junction。</div>` : ''}
      </div>
    </details>`;
  }

  function renderCwdGroup(d) {
    const c = d.claude || {};
    return `<details class="pi-grp">
      <summary><span class="pi-gname">工作目录解析</span>
        <span class="pi-gmeta">${c.junctionResolved ? 'junction 已解析' : '直连'}</span></summary>
      <div class="pi-gbody">
        <div class="pi-item"><div class="pi-row"><span class="pi-tag">会话 cwd</span>
          <span class="pi-path">${esc(d.cwd)}</span></div></div>
        <div class="pi-item"><div class="pi-row"><span class="pi-tag ${c.junctionResolved ? 'warn' : 'ok'}">真实路径</span>
          <span class="pi-path">${esc(c.realCwd || d.cwd)}</span></div></div>
        ${c.junctionResolved ? `<div class="pi-why">Claude 会按<b>真实路径</b>算记忆桶，Codex 按<b>字面路径</b>——同一个项目从两条路径打开，Codex 会分裂成两套记忆。</div>` : ''}
      </div>
    </details>`;
  }

  function renderInspection(d) {
    const isCodex = d.kind === 'codex';
    return `
      <div class="pi-head">
        <span class="pi-title">这个 cwd 会注入什么</span>
        <span class="pi-sub">${esc(d.kind)} · <code>${esc(d.cwd)}</code></span>
      </div>
      ${renderChecks(d.health)}
      ${renderBudget(d)}
      <div class="pi-sec">
        <h5>逐项来源</h5>
        ${isCodex ? renderCodexGroup(d) : renderClaudeGroup(d)}
        ${renderMemoryGroup(d)}
        ${renderCwdGroup(d)}
      </div>
      <div class="pi-foot">内置系统提示词与工具定义由 CLI 自己拼装、无法通过配置改动，故不在此展开。</div>`;
  }

  // 面板挂在卡片的 .turn-content 末尾；再次点击收起。
  async function togglePromptInspector(cardEl, sessionId) {
    if (!cardEl) return;
    const host = cardEl.querySelector('.turn-content') || cardEl;
    const existing = host.querySelector(':scope > .pi-panel');
    if (existing) { existing.remove(); return; }

    const panel = document.createElement('div');
    panel.className = 'pi-panel';
    panel.innerHTML = '<div class="pi-loading">正在还原注入内容…</div>';
    host.appendChild(panel);

    try {
      const ipc = win.ipcRenderer || (typeof require === 'function' ? require('electron').ipcRenderer : null);
      if (!ipc) throw new Error('ipcRenderer 不可用');
      const res = await ipc.invoke('prompt-inspect', { sessionId });
      if (!res || !res.ok) {
        panel.innerHTML = `<div class="pi-err">还原失败：${esc((res && res.error) || '未知错误')}</div>`;
        return;
      }
      panel.innerHTML = renderInspection(res.data);
    } catch (err) {
      panel.innerHTML = `<div class="pi-err">还原失败：${esc(err && err.message ? err.message : err)}</div>`;
    }
  }

  win.togglePromptInspector = togglePromptInspector;
  win._renderPromptInspection = renderInspection; // 供测试/调试直接喂数据
})();
