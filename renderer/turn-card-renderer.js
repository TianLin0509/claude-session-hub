function createTurnCardRenderer(options = {}) {
  const doc = options.document || document;
  const win = options.window || window;
  const nav = options.navigator || (win && win.navigator) || {};
  const clipboardApi = nav.clipboard || { writeText: () => Promise.resolve() };
  const cssApi = options.CSS || (win && win.CSS) || {};
  const cssEscape = typeof cssApi.escape === 'function'
    ? (value) => cssApi.escape(String(value))
    : (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  const marked = options.marked;
  const DOMPurify = options.DOMPurify;
  const formatAbsoluteTime = options.formatAbsoluteTime;
  const normalizeMarkdownPathBreaks = options.normalizeMarkdownPathBreaks;
  const escapeHtml = options.escapeHtml;
  const wrapPathLinksInElement = options.wrapPathLinksInElement;
  const getActiveSessionId = typeof options.getActiveSessionId === 'function' ? options.getActiveSessionId : () => null;
  const updateStreamingIndicator = typeof options.updateStreamingIndicator === 'function' ? options.updateStreamingIndicator : null;

// === Spec 1 v0.9.0 · 工具调用块 ===
// _sessionTurns: turnId -> turn object map. Initialized here so rerenderTurn
// works for T5 toggle even before T10 wires real session.turns data.
// T10 will populate this from session.turns[]; for now it's an empty map.
if (!win._sessionTurns) win._sessionTurns = new Map();

// === Spec 3 · UI 方案 E (CardCluster) — 工具簇 ===
// 多 tool 同 turn 合并显示：1 行 cluster summary 默认折叠，展开后是工具列表。
// 每行 tool 显示 [Name] [cmd-from-input]，因 tool_result 在 parser 跳过故无 stdout
// （留待 spec 3+ 关联 tool_use_id ↔ tool_result 后再展开单 tool 详情）。
// 替代了之前每个 tool 单独渲染成大块的方案（信息密度低）。
const _TOOL_CMD_KEYS = ['file_path', 'command', 'pattern', 'path', 'url', 'query'];
function _toolCmdFromInput(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of _TOOL_CMD_KEYS) {
    if (typeof input[k] === 'string' && input[k]) {
      return input[k].split('\n')[0].slice(0, 100);
    }
  }
  return '';
}
// Spec 3 · W9 / Spec 4 · 工具返回预览：渲染单条 tool row。
// 有 result 时用 <details>/<summary>/<pre> 折叠；summary 右侧加 👁 预览按钮 +
// 结果区头部带 toolbar（meta + 复制全文 + [postProcess 动态注入]展开按钮）。
// 完整原文整体塞 <pre>，由 postProcessToolResults 接管：JSON 检测+Prism 高亮，
// >2KB 默认折叠（CSS max-height + 渐变遮罩，点"展开全部"放开）。
// 超大异常防御：>50KB 硬截断（防 MCP 返回 几百 KB 把 DOM 撑爆）。
const _TOOL_RESULT_HARD_LIMIT = 50000;
function _renderToolRow(tc) {
  const name = escapeHtml((tc && tc.name) || '?');
  const cmd = escapeHtml(_toolCmdFromInput(tc && tc.input));
  const head = `<span class="tc-row-name">${name}</span>${cmd ? ` <span class="tc-row-cmd">${cmd}</span>` : ''}`;
  const hasResult = tc && typeof tc.result === 'string' && tc.result.length > 0;
  if (!hasResult) {
    return `<div class="tc-row">${head}</div>`;
  }
  const isErr = tc.isError === true;
  const rawLen = tc.result.length;
  const truncated = rawLen > _TOOL_RESULT_HARD_LIMIT;
  const body = truncated
    ? tc.result.slice(0, _TOOL_RESULT_HARD_LIMIT) + '\n\n…(超长截断，剩余 ' + (rawLen - _TOOL_RESULT_HARD_LIMIT) + ' 字符；点复制可拿到截断后的内容)'
    : tc.result;
  const sizeText = rawLen >= 1024 ? (rawLen / 1024).toFixed(1) + ' KB' : rawLen + ' B';
  const errBadge = isErr ? '<span class="tc-row-errbadge">✗ 错误</span>' : '';
  return `<details class="tc-row tc-row-with-result${isErr ? ' tc-row-err' : ''}" data-tool-result-len="${rawLen}">
    <summary class="tc-row-head">${head}${errBadge}<span class="tc-row-actions"><button class="tc-row-preview-btn" data-action="tc-toggle-preview" type="button" title="预览工具返回">👁 预览</button></span></summary>
    <div class="tc-result-wrap">
      <div class="tc-result-toolbar">
        <span class="tc-result-meta">${sizeText}${truncated ? ' · 已硬截断' : ''}</span>
        <button class="tc-result-copy" data-action="tc-copy-result" type="button" title="复制全文">📋 复制</button>
      </div>
      <pre class="tc-result${isErr ? ' tc-result-err' : ''}" data-result-raw>${escapeHtml(body)}</pre>
    </div>
  </details>`;
}

function renderToolCluster(turnId, toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return '';
  const total = toolCalls.length;
  // Spec 3 · W1：单 tool 时简化 summary 为 `▸ Bash command-snippet`
  // 不再写"1 个工具调用 · X"（D3 数据：5196 个 entry 中 55% 是 1-tool，原措辞冗余且填屏）
  if (total === 1) {
    const tc = toolCalls[0] || {};
    const name = escapeHtml(tc.name || '?');
    const cmd = escapeHtml(_toolCmdFromInput(tc.input));
    return `<details class="tc-cluster tc-cluster-single" data-turn="${escapeHtml(turnId)}">
      <summary class="tc-cluster-head"><span class="tc-row-name">${name}</span>${cmd ? ` <span class="tc-row-cmd">${cmd}</span>` : ''}</summary>
      <div class="tc-cluster-list">${_renderToolRow(tc)}</div>
    </details>`;
  }
  const counts = {};
  for (const tc of toolCalls) {
    const name = (tc && tc.name) || '?';
    counts[name] = (counts[name] || 0) + 1;
  }
  const breakdown = Object.entries(counts)
    .map(([n, c]) => c > 1 ? `${n} × ${c}` : n)
    .join(' + ');
  const items = toolCalls.map(_renderToolRow).join('');
  return `<details class="tc-cluster" data-turn="${escapeHtml(turnId)}">
    <summary class="tc-cluster-head">${total} 个工具调用 · ${escapeHtml(breakdown)}</summary>
    <div class="tc-cluster-list">${items}</div>
  </details>`;
}

function rerenderTurn(turnId) {
  // 重渲染整张 turn 卡片 + 调 postProcessCardCodeBlocks 保留代码块交互
  const card = doc.querySelector(`.turn-card[data-turn-id="${turnId}"]`);
  if (!card || !win._sessionTurns) return;
  const turn = win._sessionTurns.get(turnId);
  if (!turn) return;
  const tmp = doc.createElement('div');
  tmp.innerHTML = renderTurnCard(turn);
  const newCard = tmp.firstElementChild;
  if (newCard) {
    if (typeof postProcessCardCodeBlocks === 'function') {
      postProcessCardCodeBlocks(newCard);
    }
    if (typeof postProcessToolResults === 'function') postProcessToolResults(newCard);
    const bodyEl = newCard.querySelector('.turn-body');
    if (bodyEl && typeof wrapPathLinksInElement === 'function') wrapPathLinksInElement(bodyEl, { sessionId: card.dataset.sessionId });
    card.replaceWith(newCard);
    // Spec 3 长文本折叠：必须在 DOM 内调（replaceWith 之后），否则 scrollHeight=0
    if (typeof postProcessLongTextFold === 'function') postProcessLongTextFold(newCard);
  }
}

// === Spec 1 v0.9.0 · D4 头像 ===
function sanitizeAssetName(name) {
  // 仅允许字母数字+横线下划线,防止路径遍历
  return String(name || '').replace(/[^a-zA-Z0-9_-]/g, '');
}
function aiLogoSrc(kind) {
  // 已有 logos: claude / codex / 等。其它 kind fallback 到字母。
  // Spec 3 · W6 fix：claude-resume / gemini-resume / codex-resume / deepseek-resume / 等
  // 都共享对应 base kind 的 logo（之前 -resume 后缀漏映射 → 字母 fallback "CL"）。
  const known = ['claude','codex','gemini','deepseek','glm','gpt','kimi','qwen'];
  let k = (kind || '').toLowerCase().replace(/-resume$/, '');
  // Claude Web 复用 Claude logo（kind === 'claude-web' / 'claude-web-resume' → 都映射到 claude）
  if (k === 'claude-web') k = 'claude';
  if (k === 'codex-web') k = 'codex';
  if (k === 'codex-app') return 'assets/ai-logos/codex.svg';
  if (known.includes(k)) return `assets/ai-logos/${k}.svg`;
  return null;
}
function aiLetterFallback(kind) {
  const k = (kind || '?').toUpperCase();
  return k.length >= 2 ? k.slice(0, 2) : k + '?';
}

// === Spec 3 · W7 头部 metadata pills ===
// 给卡片头加 4 个信息 pill：🔧 工具数 / ⇡in/⇣out token / 📊 ctx% / ⏱ 耗时（user 卡片仅 📝 字数）
// model context window 用模糊匹配（实际 model id 多变如 "claude-opus-4-7[1m]"），匹配不到默认 200k。
function _modelCtxWindow(model) {
  if (!model) return 200000;
  const m = String(model).toLowerCase();
  if (m.includes('1m') || m.includes('opus-4')) return 1000000;
  if (m.includes('gemini')) return 1000000;
  if (m.includes('sonnet')) return 200000;
  if (m.includes('haiku')) return 200000;
  if (m.includes('gpt')) return 128000;
  return 200000;
}
function _fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}
function _fmtDuration(ms) {
  const s = ms / 1000;
  if (s >= 60) return (s / 60).toFixed(1) + 'min';
  return s.toFixed(1) + 's';
}
function _renderMetaPills(turn) {
  const isUser = turn.role === 'user';
  if (isUser) {
    const n = (turn.text || '').length;
    if (!n) return '';
    return `<span class="turn-meta-pills"><span class="pill">📝 ${n} 字</span></span>`;
  }
  const pills = [];
  const toolN = (turn.toolCalls && turn.toolCalls.length) || 0;
  if (toolN > 0) pills.push(`<span class="pill pill-tool">🔧 ${toolN} 工具</span>`);
  if (turn.usage && (turn.usage.input_tokens || turn.usage.output_tokens)) {
    pills.push(`<span class="pill pill-token">⇡${_fmtTokens(turn.usage.input_tokens||0)} ⇣${_fmtTokens(turn.usage.output_tokens||0)}</span>`);
  }
  if (turn.usage && turn.usage.input_tokens) {
    const win = _modelCtxWindow(turn.model);
    const pct = Math.min(100, Math.round(turn.usage.input_tokens / win * 100));
    pills.push(`<span class="pill pill-ctx">📊 ${pct}% ctx</span>`);
  }
  if (typeof turn.tsEnd === 'number' && typeof turn.ts === 'number' && turn.tsEnd > turn.ts) {
    pills.push(`<span class="pill pill-time">⏱ ${_fmtDuration(turn.tsEnd - turn.ts)}</span>`);
  }
  if (pills.length === 0) return '';
  return `<span class="turn-meta-pills">${pills.join('')}</span>`;
}

// === Spec 1 v0.9.0 · turn 卡片渲染 ===
function renderTurnCard(turn) {
  // turn = { id, role: 'user'|'assistant', text, ts, model?, kind?, slotPokemon?, toolCalls? }
  const isUser = turn.role === 'user';
  const cls = isUser ? 'turn-card user' : 'turn-card';
  const who = isUser ? '你' : (turn.model || turn.kind || 'Claude');
  const ts = turn.ts ? formatAbsoluteTime(turn.ts) : '';

  // 头像分支
  let avatarHtml;
  if (isUser) {
    // Spec 3 · W6：用户头像用皮卡丘（与 AI 群聊 slot 体系视觉一致，复用 .av-poke 黄色背景）
    avatarHtml = `<span class="turn-avatar av-poke"><img src="assets/pokemon/pikachu.png" alt="你"></span>`;
  } else if (turn.slotPokemon) {
    // AI 群聊 slot 体系
    const safe = sanitizeAssetName(turn.slotPokemon);
    if (safe) {
      avatarHtml = `<span class="turn-avatar av-poke"><img src="assets/pokemon/${safe}.png" alt="${escapeHtml(turn.slotPokemon)}"></span>`;
    } else {
      avatarHtml = `<span class="turn-avatar av-letter">${escapeHtml(aiLetterFallback(turn.kind))}</span>`;
    }
  } else {
    const logo = aiLogoSrc(turn.kind);
    avatarHtml = logo
      ? `<span class="turn-avatar av-logo"><img src="${logo}" alt="${escapeHtml(turn.kind || 'AI')}"></span>`
      : `<span class="turn-avatar av-letter">${escapeHtml(aiLetterFallback(turn.kind))}</span>`;
  }

  const rawHtml = marked.parse(normalizeMarkdownPathBreaks(turn.text), { breaks: true, gfm: true });
  const body = DOMPurify.sanitize(rawHtml, { ADD_ATTR: ['target', 'data-lang'] });
  // Spec 3 方案 E：工具簇折叠（之前每 tool 单独大块 → 信息密度极低）
  const toolHtml = renderToolCluster(turn.id || '', turn.toolCalls);

  // === Spec 2 · S8: thinking 字段 (assistant only, default collapsed) ===
  // S1 parser exposes turn.thinking as multi-block joined string (or null).
  // Render as <details> ABOVE main body — chronologically thinking precedes the answer.
  // Only attached for assistant role with non-empty string; user turns never carry thinking.
  let thinkingHtml = '';
  if (!isUser && typeof turn.thinking === 'string' && turn.thinking.length > 0) {
    const thinkingRaw = marked.parse(normalizeMarkdownPathBreaks(turn.thinking), { breaks: true, gfm: true });
    const thinkingBody = DOMPurify.sanitize(thinkingRaw, { ADD_ATTR: ['target', 'data-lang'] });
    // Long thinking (>5KB): summary shows first-200-char preview (HTML-escaped, newlines→space)
    let summaryLabel = '💭 思考过程';
    if (turn.thinking.length > 5120) {
      const previewRaw = turn.thinking.slice(0, 200).replace(/\s+/g, ' ').trim();
      summaryLabel = `💭 思考过程 (前 200 字符: ${escapeHtml(previewRaw)}…)`;
    }
    thinkingHtml = `<details class="turn-thinking">
        <summary class="turn-thinking-summary">${summaryLabel}</summary>
        <div class="turn-thinking-body">${thinkingBody}</div>
      </details>`;
  }

  return `<div class="${cls}" data-turn-id="${escapeHtml(turn.id || '')}">
    ${avatarHtml}
    <div class="turn-content">
      <div class="turn-head">
        <span class="turn-who">${escapeHtml(who)}</span>
        <span class="turn-meta">${escapeHtml(ts)}</span>
        ${_renderMetaPills(turn)}
        <div class="turn-actions">
          <button class="ta-btn" data-action="copy" title="复制">📋</button>
          ${isUser
            ? `<button class="ta-btn" data-action="resend" title="重发">↻</button>
               <button class="ta-btn" data-action="edit-resend" title="编辑重发">✏</button>`
            : `<button class="ta-btn" data-action="regen" title="重新生成">⏪</button>`}
        </div>
      </div>
      ${thinkingHtml}
      <div class="turn-body">${toolHtml}${body}</div>
    </div>
  </div>`;
}
win._renderTurnCard = renderTurnCard;

// === Spec 1 v0.9.0 · 代码块强化 (D2) ===
let _codeFoldThreshold = 30;
const _foldedCodesState = new Map();
const _bodyFoldState = new Map(); // turnId -> true(expanded) / false(folded)
const _turnRenderSigs = new Map(); // turnId -> compact content signature

function postProcessCardCodeBlocks(cardEl) {
  if (!cardEl) return;
  const blocks = cardEl.querySelectorAll('pre > code');
  blocks.forEach((code, idx) => {
    const pre = code.parentElement;
    // marked adds class="language-xx"; pull first language match
    const lang = (code.className.match(/language-(\w+)/) || [, ''])[1];
    // prism highlight (only if language plugin loaded)
    if (lang && win.Prism && win.Prism.languages[lang]) {
      try { code.innerHTML = win.Prism.highlight(code.textContent, win.Prism.languages[lang], lang); }
      catch {}
    }
    // wrap pre in .code-block-wrap, add Copy button + fold toggle if long
    const lines = code.textContent.split('\n').length;
    const turnId = cardEl.dataset.turnId || '';
    const codeKey = `${turnId}:code:${idx}`;
    const expanded = _foldedCodesState.has(codeKey) ? _foldedCodesState.get(codeKey) : (lines <= _codeFoldThreshold);
    const wrap = doc.createElement('div');
    wrap.className = 'code-block-wrap';
    wrap.dataset.codeKey = codeKey;
    wrap.dataset.lang = lang || 'text';
    wrap.dataset.lines = lines;
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    // Copy button
    const copyBtn = doc.createElement('button');
    copyBtn.className = 'code-copy';
    copyBtn.textContent = '📋 Copy';
    copyBtn.dataset.action = 'code-copy';
    wrap.appendChild(copyBtn);
    // Fold toggle (long blocks)
    if (lines > _codeFoldThreshold && !expanded) {
      pre.style.display = 'none';
      const toggle = doc.createElement('div');
      toggle.className = 'code-toggle';
      toggle.dataset.action = 'code-expand';
      toggle.textContent = `▸ 展开 ${_codeFoldThreshold} of ${lines} 行 · ${lang || 'text'}`;
      wrap.appendChild(toggle);
    } else if (lines > _codeFoldThreshold) {
      const toggle = doc.createElement('div');
      toggle.className = 'code-toggle';
      toggle.dataset.action = 'code-collapse';
      toggle.textContent = `▾ 折叠 (${lines} 行)`;
      wrap.appendChild(toggle);
    }
  });
}

// === Spec 3 · 长 markdown 文本默认折叠 ===
// 在卡片插入 DOM 后调用：检测 turn-body scrollHeight 超过阈值 → 加 .body-foldable.folded
// + 插入"展开全文"按钮。必须在 mount 后调（detached 元素 scrollHeight=0）。
const _BODY_FOLD_THRESHOLD_PX = 400;
function postProcessLongTextFold(cardEl) {
  if (!cardEl) return;
  const body = cardEl.querySelector('.turn-body');
  if (!body) return;
  // 已存在折叠按钮（rerender 路径） → 跳过
  if (cardEl.querySelector('.body-fold-toggle')) return;
  if (body.scrollHeight <= _BODY_FOLD_THRESHOLD_PX) return;
  const turnId = cardEl.dataset.turnId || '';
  const expanded = turnId && _bodyFoldState.get(turnId) === true;
  body.classList.add('body-foldable');
  if (!expanded) body.classList.add('folded');
  const btn = doc.createElement('div');
  btn.className = 'body-fold-toggle';
  btn.dataset.action = expanded ? 'body-collapse' : 'body-expand';
  btn.textContent = expanded ? '▴ 折叠' : '▾ 展开全文';
  body.parentElement.insertBefore(btn, body.nextSibling);
}

// 全局 click handler: 长文本展开/折叠
doc.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('[data-action="body-expand"], [data-action="body-collapse"]');
  if (!btn) return;
  const card = btn.closest('.turn-card');
  if (!card) return;
  const body = card.querySelector('.turn-body');
  if (!body) return;
  const turnId = card.dataset.turnId || '';
  if (btn.dataset.action === 'body-expand') {
    if (turnId) _bodyFoldState.set(turnId, true);
    body.classList.remove('folded');
    btn.dataset.action = 'body-collapse';
    btn.textContent = '▴ 折叠';
  } else {
    if (turnId) _bodyFoldState.set(turnId, false);
    body.classList.add('folded');
    btn.dataset.action = 'body-expand';
    btn.textContent = '▾ 展开全文';
  }
});

// === Spec 4 · 工具返回预览 (postProcessToolResults) ===
// _renderToolRow 已经把完整 result 塞进 <pre data-result-raw>。这里做三件事：
//   1) JSON 自动检测：trim 后首字符是 { 或 [ 且 JSON.parse 成功 → 重排 + Prism 高亮
//   2) >2KB 加 is-folded class（CSS 控制 max-height + 渐变），toolbar 注入"展开全部"按钮
//   3) 已处理过的 <pre> 用 data-tc-processed=1 防重入（rerender 路径会重跑）
const _TOOL_RESULT_FOLD_THRESHOLD = 2048;
function postProcessToolResults(cardEl) {
  if (!cardEl) return;
  const pres = cardEl.querySelectorAll('pre.tc-result[data-result-raw]');
  pres.forEach((pre) => {
    if (pre.dataset.tcProcessed === '1') return;
    pre.dataset.tcProcessed = '1';
    const raw = pre.textContent;
    // JSON 检测：避免对纯文本/HTML/log 做无意义解析
    const lead = raw.trimStart()[0];
    if ((lead === '{' || lead === '[') && raw.length < _TOOL_RESULT_HARD_LIMIT) {
      try {
        const parsed = JSON.parse(raw.trim());
        const formatted = JSON.stringify(parsed, null, 2);
        if (win.Prism && win.Prism.languages && win.Prism.languages.json) {
          pre.innerHTML = win.Prism.highlight(formatted, win.Prism.languages.json, 'json');
        } else {
          pre.textContent = formatted;
        }
        pre.classList.add('is-json');
      } catch {
        // 不是合法 JSON（如 mcp 错误回包是 JSON 头但坏掉）→ 保留原文
      }
    }
    // 长内容折叠 — 走 dataset 里 <details> 的真实长度，比 textContent.length 准
    // （Prism 高亮后 innerHTML 多了 span tag，但 textContent 仍是纯文本所以也对，留 dataset 兜底）
    const details = pre.closest('.tc-row-with-result');
    const lenBytes = details ? parseInt(details.dataset.toolResultLen || '0', 10) : raw.length;
    if (lenBytes > _TOOL_RESULT_FOLD_THRESHOLD) {
      pre.classList.add('tc-result-foldable', 'is-folded');
      const toolbar = pre.parentElement && pre.parentElement.querySelector('.tc-result-toolbar');
      if (toolbar && !toolbar.querySelector('.tc-result-expand')) {
        const sizeKb = (lenBytes / 1024).toFixed(1);
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'tc-result-expand';
        btn.dataset.action = 'tc-toggle-fold';
        btn.textContent = `⏷ 展开全部 (${sizeKb} KB)`;
        btn.title = '展开/折叠完整返回';
        toolbar.appendChild(btn);
      }
    }
  });
}

// 全局 click handler: 👁 预览 toggle + 复制全文 + 展开/折叠超长
doc.addEventListener('click', (e) => {
  const t = e.target;
  if (!t || !t.closest) return;

  // [1] 👁 预览按钮：toggle 父 <details>（按钮自身阻止冒泡防止"双重 toggle"）
  const previewBtn = t.closest('[data-action="tc-toggle-preview"]');
  if (previewBtn) {
    e.preventDefault();
    e.stopPropagation();
    const details = previewBtn.closest('details.tc-row-with-result');
    if (details) {
      details.open = !details.open;
      previewBtn.textContent = details.open ? '👁 收起' : '👁 预览';
    }
    return;
  }

  // [2] 📋 复制全文：取 pre.textContent（Prism 高亮后仍是纯文本节点，OK）
  const copyResultBtn = t.closest('[data-action="tc-copy-result"]');
  if (copyResultBtn) {
    e.preventDefault();
    e.stopPropagation();
    const wrap = copyResultBtn.closest('.tc-result-wrap');
    const pre = wrap && wrap.querySelector('pre.tc-result');
    if (pre) {
      Promise.resolve(clipboardApi.writeText(pre.textContent || ''))
        .then(() => {
          copyResultBtn.textContent = '✓ 已复制';
          copyResultBtn.classList.add('copied');
          setTimeout(() => {
            copyResultBtn.textContent = '📋 复制';
            copyResultBtn.classList.remove('copied');
          }, 1500);
        })
        .catch(() => {});
    }
    return;
  }

  // [3] ⏷ 展开/折叠超长 result
  const foldBtn = t.closest('[data-action="tc-toggle-fold"]');
  if (foldBtn) {
    e.preventDefault();
    e.stopPropagation();
    const wrap = foldBtn.closest('.tc-result-wrap');
    const pre = wrap && wrap.querySelector('pre.tc-result');
    const details = foldBtn.closest('.tc-row-with-result');
    if (pre && details) {
      const folded = pre.classList.toggle('is-folded');
      const lenBytes = parseInt(details.dataset.toolResultLen || '0', 10);
      const sizeKb = (lenBytes / 1024).toFixed(1);
      foldBtn.textContent = folded ? `⏷ 展开全部 (${sizeKb} KB)` : '⏶ 折叠';
    }
    return;
  }
});

function mountTurnCard(container, turn) {
  const tmp = doc.createElement('div');
  tmp.innerHTML = renderTurnCard(turn);
  const cardEl = tmp.firstElementChild;
  postProcessCardCodeBlocks(cardEl);
  postProcessToolResults(cardEl);
  // 路径识别 (T7 风险条款: 卡片内 .md / URL 必须可点击触发预览)
  const bodyEl = cardEl.querySelector('.turn-body');
  if (bodyEl && typeof wrapPathLinksInElement === 'function') wrapPathLinksInElement(bodyEl, { sessionId: getActiveSessionId() });
  container.appendChild(cardEl);
  postProcessLongTextFold(cardEl);
  return cardEl;
}
win._mountTurnCard = mountTurnCard;

// === Spec 2 · S4: mountSessionTurnCard ===
// Mount a single Turn (from S1 parseClaudeTranscriptToTurns) as a card into #msg-overlay.
//
// Used by:
//   - S5 loadSessionHistoryToOverlay      — batch mount on session switch
//   - S6 turn-complete-event listener     — append on new assistant turn
//
// Boundary adapters / contract notes:
//   * renderTurnCard (line ~1630) accepts { id, role, text, ts, model?, kind?,
//     slotPokemon?, toolCalls? } and ignores unknown fields. S1 turns may
//     additionally carry { thinking, stopReason, usage } — those are passed
//     through harmlessly until S8 adds thinking rendering inside renderTurnCard.
//   * win._sessionTurns: spec1 stores raw `turn` objects (not wrapped),
//     because rerenderTurn (line ~1593) and getTurnFromCard (line ~1758) both
//     do `_sessionTurns.get(turnId)` and use the result as a turn directly.
//     Wrapping it in `{ sessionId, turn, element }` here would break those
//     button handlers. Instead we keep the Map shape (turnId → turn), and
//     stash sessionId on the DOM via cardEl.dataset.sessionId so future
//     per-session cleanup can find cards by sessionId without changing the
//     Map contract. The `element` is recoverable via
//     `doc.querySelector('.turn-card[data-turn-id="…"]')` (used by
//     rerenderTurn already).
// 2026-05-06 道雪 重做 b54a3b6（原 fix 在 fix/card-overlay-scroll-lock 分支没合上 master）+
// Codex 多方审查补漏：chat UI 标准 scroll-respect-user 模式 — 仅当用户在底部 50px
// 容差内才自动跟随,否则尊重用户向上翻历史的意图。此 helper 守护三处:
//   (1) mountSessionTurnCard 的 opts.autoScroll(turn-complete-event 路径会传 true)
//   (2) _updateStreamingIndicator 创建"还在生成更多回复…"indicator 时
//   (3) loadSessionHistoryToOverlay 末尾的 batch scrollIntoView (Codex 发现):
//       incremental=true throttle 反复触发时不应拍底;incremental=false 切 session
//       时 container 已 innerHTML='' → helper 自然 true → 初次加载行为不退化
function _isCardOverlayAtBottom(el) {
  if (!el) return true;
  return (el.scrollHeight - el.scrollTop - el.clientHeight) < 50;
}

// optimistic user-card：用户在 floating-input 按 Enter 后立即 mount 一张 user 气泡卡。
//   不等 transcript 写盘 + 250ms throttle reload —— 后者经实测 user entry 写盘滞后 1-3s
//   （Claude CLI 等到 LLM call 启动才 append），用户视感 "气泡 5s 才出来"。
//   待真 user turn 从 transcript 解析进来时（mountSessionTurnCard 顶部的 dedup），扫一眼
//   现存 optimistic 卡片，文本匹配的删掉。turn.id 用 'pending-user-' 前缀的临时 id，
//   不进 _sessionTurns Map（不是权威 turn，避免被当作真 turn dedup-replace 链路对象）。
function mountOptimisticUserCard(sessionId, text, kind) {
  const container = doc.getElementById('msg-overlay');
  if (!container) return null;
  // 隐藏 placeholder 而非删除 — 后续 turn-complete-event / applyViewMode
  // 仍需通过 _cardHistoryHydratedSid 判是否需要全量重载，但保留 DOM 节点做 fallback
  const placeholder = container.querySelector('.msg-overlay-placeholder');
  if (placeholder) placeholder.style.display = 'none';

  const optimisticId = 'pending-user-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const turn = { id: optimisticId, role: 'user', text, ts: Date.now(), kind };
  let cardEl;
  try {
    const tmp = doc.createElement('div');
    tmp.innerHTML = renderTurnCard(turn);
    cardEl = tmp.firstElementChild;
  } catch (err) {
    console.warn('[mountOptimisticUserCard] renderTurnCard threw:', err);
    return null;
  }
  if (!cardEl) return null;
  cardEl.dataset.sessionId = String(sessionId || '');
  cardEl.dataset.optimistic = 'true';
  cardEl.dataset.optimisticText = text;

  // 插在 streaming-indicator 之前（与 mountSessionTurnCard 一致），保证位置正确
  // 2026-05-24：必须用 `:scope > .streaming-indicator` 限定为 container 直接子。
  // 否则 W15 v2 把 indicator 迁进 turn-card.turn-head 后，querySelector 递归到嵌套
  // 节点 → insertBefore 撞 ref 非直接子节点抛 NotFoundError → mount 链路被静默吞掉。
  const streamingTail = container.querySelector(':scope > .streaming-indicator');
  if (streamingTail) container.insertBefore(cardEl, streamingTail);
  else container.appendChild(cardEl);

  // 用户主动发了一条消息 → 一定希望看到自己刚发的气泡；不走 _wasAtBottom 守卫
  try {
    cardEl.scrollIntoView({ behavior: 'auto', block: 'end' });
  } catch {
    container.scrollTop = container.scrollHeight;
  }
  return cardEl;
}
win._mountOptimisticUserCard = mountOptimisticUserCard;

function turnRenderSignature(turn) {
  if (!turn) return '';
  const raw = JSON.stringify({
    role: turn.role || '',
    text: turn.text || '',
    thinking: turn.thinking || '',
    stopReason: turn.stopReason || '',
    durationMs: turn.durationMs || null,
    tsEnd: turn.tsEnd || null,
    toolCalls: Array.isArray(turn.toolCalls) ? turn.toolCalls : [],
    usage: turn.usage || null,
  });
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${raw.length}:${hash >>> 0}`;
}

function mountSessionTurnCard(sessionId, turn, opts = {}) {
  // 1. validate inputs
  if (!turn || !turn.id || !turn.role) {
    console.warn('[mountSessionTurnCard] invalid turn (missing id/role):', turn);
    return null;
  }
  // 2. resolve container
  const container = opts.container || doc.getElementById('msg-overlay');
  if (!container) {
    console.warn('[mountSessionTurnCard] container not found (msg-overlay missing)');
    return null;
  }
  // defensive init (spec1 also does this at line ~1545, but be paranoid)
  if (!win._sessionTurns) win._sessionTurns = new Map();

  // optimistic user-card dedup：真 user turn 从 transcript 进来时，扫现存
  //   optimistic 占位卡，文本相同则删掉（让真卡片接替）。trim 比较两端容差。
  if (turn.role === 'user') {
    const sidStr = String(sessionId || '');
    const realText = (turn.text || '').trim();
    if (realText) {
      const opts2 = container.querySelectorAll('.turn-card.user[data-optimistic="true"]');
      opts2.forEach(opt => {
        if (opt.dataset.sessionId !== sidStr) return;
        const optText = (opt.dataset.optimisticText || '').trim();
        if (optText && optText === realText) {
          opt.remove();
        }
      });
    }
  }

  // dedup with in-place replace：同 turnId 已在 DOM 时，不是 skip 而是替换。
  // 原因：W5 后一个 logical turn 包含多个 raw entries，streaming 新 entry 合并进来时
  // turn.id 不变（取首条 entry uuid）但内容已变（toolCalls 多了 / text 长了 / tsEnd 变 /
  // mergedCount 增加）。skip 会让用户看不到新工具调用；replace 让卡片 in-place 更新。
  // 副作用：替换瞬间该卡片如有 hover 操作菜单会闪一下，可接受。
  const existing = container.querySelector(`.turn-card[data-turn-id="${cssEscape(turn.id)}"]`);
  if (existing) {
    const turnForRender2 = (opts.kind && !turn.kind) ? { ...turn, kind: opts.kind } : turn;
    const prevTurn = win._sessionTurns.get(turn.id);
    const prevSig = _turnRenderSigs.get(turn.id) || turnRenderSignature(prevTurn);
    const nextSig = turnRenderSignature(turnForRender2);
    if (prevSig === nextSig) {
      win._sessionTurns.set(turn.id, turnForRender2);
      _turnRenderSigs.set(turn.id, nextSig);
      if (typeof updateStreamingIndicator === 'function') updateStreamingIndicator(sessionId);
      return existing;
    }
    let newCard = null;
    try {
      const tmp2 = doc.createElement('div');
      tmp2.innerHTML = renderTurnCard(turnForRender2);
      newCard = tmp2.firstElementChild;
    } catch (err) {
      console.warn('[mountSessionTurnCard replace] renderTurnCard threw:', err);
      return null;
    }
    if (!newCard) return null;
    newCard.dataset.sessionId = String(sessionId || '');
    existing.replaceWith(newCard);
    if (typeof postProcessCardCodeBlocks === 'function') postProcessCardCodeBlocks(newCard);
    if (typeof postProcessToolResults === 'function') postProcessToolResults(newCard);
    const bodyEl2 = newCard.querySelector('.turn-body');
    if (bodyEl2 && typeof wrapPathLinksInElement === 'function') wrapPathLinksInElement(bodyEl2, { sessionId });
    if (typeof postProcessLongTextFold === 'function') postProcessLongTextFold(newCard);
    win._sessionTurns.set(turn.id, (opts.kind && !turn.kind) ? { ...turn, kind: opts.kind } : turn);
    _turnRenderSigs.set(turn.id, nextSig);
    return newCard;
  }

  // 3. merge kind through to renderTurnCard without mutating caller's turn
  const turnForRender = (opts.kind && !turn.kind) ? { ...turn, kind: opts.kind } : turn;

  // 4. build wrapper element from HTML string
  let cardEl = null;
  try {
    const tmp = doc.createElement('div');
    tmp.innerHTML = renderTurnCard(turnForRender);
    cardEl = tmp.firstElementChild;
  } catch (err) {
    console.warn('[mountSessionTurnCard] renderTurnCard threw:', err);
    return null;
  }
  if (!cardEl) {
    console.warn('[mountSessionTurnCard] renderTurnCard produced empty HTML for turn', turn.id);
    return null;
  }

  // multi-session safety: tag the DOM with sessionId for per-session cleanup
  cardEl.dataset.sessionId = String(sessionId || '');

  // 5. insert into container — Spec 3 W16：streaming indicator 必须在末尾，
  // 所以新卡插在 indicator 之前（如果存在）
  // 2026-05-06 道雪 scroll-respect-user：append 前先记录用户是否在底部,给 step 9 用
  // 2026-05-24：必须用 `:scope > .streaming-indicator` 限定为 container 直接子。
  // W15 v2 (_updateStreamingIndicator) 把 indicator 迁进 turn-card.turn-head 后，
  // 普通 querySelector 会递归命中嵌套节点 → insertBefore 撞 ref 非直接子抛
  // NotFoundError → for 循环中断后续 turn 全丢，外层 .catch 静默吞。
  const _wasAtBottom = _isCardOverlayAtBottom(container);
  const _streamingTail = container.querySelector(':scope > .streaming-indicator');
  if (_streamingTail) {
    container.insertBefore(cardEl, _streamingTail);
  } else {
    container.appendChild(cardEl);
  }

  // 6. post-process code blocks (Prism + Copy + folding)
  if (typeof postProcessCardCodeBlocks === 'function') {
    postProcessCardCodeBlocks(cardEl);
  }
  // 6b. Spec 4 · 工具返回预览（JSON 高亮 + 长内容折叠 + 复制按钮事件）
  if (typeof postProcessToolResults === 'function') {
    postProcessToolResults(cardEl);
  }
  // 7. path link recognition (scoped to .turn-body to avoid touching meta/actions)
  const bodyEl = cardEl.querySelector('.turn-body');
  if (bodyEl && typeof wrapPathLinksInElement === 'function') {
    wrapPathLinksInElement(bodyEl, { sessionId });
  }
  // 7b. Spec 3 · 长文本默认折叠（必须在 DOM 插入后调，否则 scrollHeight=0）
  if (typeof postProcessLongTextFold === 'function') {
    postProcessLongTextFold(cardEl);
  }

  // 8. register in _sessionTurns (turnId → turn) — keep spec1 Map shape
  // Use turnForRender (kind merged) so rerenderTurn won't lose kind on fold/unfold
  win._sessionTurns.set(turn.id, turnForRender);
  _turnRenderSigs.set(turn.id, turnRenderSignature(turnForRender));

  // 9. autoScroll — 2026-05-06 道雪 scroll-respect-user:仅当用户原本在底部时才滚
  //   (向上翻历史时不打断,避免被新 turn 拍回底部)
  if (opts.autoScroll && _wasAtBottom) {
    try {
      cardEl.scrollIntoView({ behavior: 'smooth', block: 'end' });
    } catch {
      // older browsers without smooth-scroll options: fall back to plain scroll
      container.scrollTop = container.scrollHeight;
    }
  }

  // Spec 3 · W16：cardCount 变化 → indicator 文案需切（"正在思考"→"还在生成更多"）
  if (typeof updateStreamingIndicator === 'function') updateStreamingIndicator(sessionId);

  // 10. return cardEl
  return cardEl;
}
win._mountSessionTurnCard = mountSessionTurnCard;


// click handler — code-copy + code-expand/collapse
doc.addEventListener('click', (e) => {
  const copyBtn = e.target.closest('[data-action="code-copy"]');
  if (copyBtn) {
    const code = copyBtn.parentElement.querySelector('pre code');
    if (code) {
      clipboardApi.writeText(code.textContent).then(() => {
        copyBtn.textContent = '✓ Copied';
        setTimeout(() => copyBtn.textContent = '📋 Copy', 1500);
      });
    }
    return;
  }
  const toggleBtn = e.target.closest('[data-action="code-expand"], [data-action="code-collapse"]');
  if (toggleBtn) {
    const wrap = toggleBtn.closest('.code-block-wrap');
    const key = wrap.dataset.codeKey;
    const want = toggleBtn.dataset.action === 'code-expand';
    _foldedCodesState.set(key, want);
    const pre = wrap.querySelector('pre');
    pre.style.display = want ? '' : 'none';
    if (want) {
      toggleBtn.dataset.action = 'code-collapse';
      toggleBtn.textContent = `▾ 折叠 (${wrap.dataset.lines} 行)`;
    } else {
      toggleBtn.dataset.action = 'code-expand';
      toggleBtn.textContent = `▸ 展开 ${_codeFoldThreshold} of ${wrap.dataset.lines} 行 · ${wrap.dataset.lang}`;
    }
  }
});



  function setCodeFoldThreshold(value) {
    if (typeof value === 'number' && !Number.isNaN(value)) _codeFoldThreshold = value;
  }

  function clearTurnRenderSignatures() {
    _turnRenderSigs.clear();
  }

  return {
    renderToolCluster,
    renderTurnCard,
    rerenderTurn,
    postProcessCardCodeBlocks,
    postProcessLongTextFold,
    postProcessToolResults,
    mountTurnCard,
    isCardOverlayAtBottom: _isCardOverlayAtBottom,
    mountOptimisticUserCard,
    turnRenderSignature,
    mountSessionTurnCard,
    setCodeFoldThreshold,
    clearTurnRenderSignatures,
  };
}

module.exports = { createTurnCardRenderer };