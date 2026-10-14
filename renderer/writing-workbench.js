'use strict';
/**
 * 写作 Tab · 文章工作台（2026-10-01 田哥要求：写作在 Tab 里完成，群聊退到后台）。
 *
 * 一篇文章一个写作群。这里把群聊读成（主进程 writing:article-view，见 core/writing/workbench.js）：
 *   文章头    标题、中心思想、进度（说想法 → 初稿 → 你点评 → 改稿 → 定稿）
 *   问题卡    每位 AI 的问题放在自己的文章下面，带推荐答案，回答后发进群
 *   文章区    每位 AI 一个标签页（2026-10-03 田哥要求），排版好的 Markdown 文章 + 写给田哥的话分开放；
 *             版本可切；出错、在写、有新稿都标在标签上；有定稿时「定稿」排第一个；宽屏可切「并排对比」
 *   点评篮    在稿里划线点评、写总评，攒好一次发出：「各自改一版」或「请某位汇总定稿」
 *   田哥手写  标签栏最后一页（2026-10-15 田哥要求：AI 出素材，最后自己汇总一稿）。左边 Markdown 编辑、右边实时预览，
 *             停笔即存进文章目录的 手写稿.md；AI 稿里选中一段可「摘到手写稿」，整篇可「放进手写稿」
 * 田哥在这里说的话，都通过群聊自己的发送入口（meeting-append-user-turn + groupchat:turn）发进群，
 * 与群聊输入框走同一条派发链路；不经过群聊界面层，不会动到正打开的那个群。
 */

const STEPS = [['idea', '说想法'], ['draft', '初稿'], ['review', '你点评'], ['revise', '改稿'], ['final', '定稿']];
const STATUS_LABEL = { working: '正在写…', error: '出错', stopped: '已停止', dormant: '休眠中' };
const KIND_LABEL = { claude: 'Claude', codex: 'Codex', deepseek: 'DeepSeek', gemini: 'Antigravity', kimi: 'Kimi' };
const POLL_MS = 3000;
const NARROW_PX = 980;

function createWorkbench(ctx) {
  const { h, call, toast, guarded, paper, renderMarkdown, ipcRenderer, openMeeting, onChanged } = ctx;
  let composer = null;
  const S = {
    dir: null, view: null, sigs: {}, answers: {}, versionOf: {}, tab: null, seen: {}, hadFinal: false,
    compare: (() => { try { return localStorage.getItem('writing-compare') === '1'; } catch { return false; } })(),
    colSigs: [], sending: false, timer: null, visible: false, root: null, resize: null, narrow: false,
    hand: freshHand(null),
  };

  /* ─────────── 田哥手写：文章目录里的 手写稿.md ─────────── */

  // base：上次从文件读到或存进去的内容，存盘时用它判断文件有没有在别处被改过
  function freshHand(dir) { return { dir, text: '', base: '', loaded: false, loading: null, state: 'idle', savedAt: 0, disk: '', timer: null, els: null }; }
  const hanCount = (t) => (String(t || '').match(/[一-鿿]/g) || []).length;

  function loadHand(dir = S.dir) {
    if (!dir) return Promise.resolve();
    if (S.hand.dir !== dir) S.hand = freshHand(dir);
    const hd = S.hand;
    if (hd.loaded) return Promise.resolve();
    if (!hd.loading) {
      hd.loading = call('writing:handdraft-read', { dir }).then((r) => {
        if (S.hand !== hd) return;
        hd.text = hd.base = r.text || '';
        hd.loaded = true;
        // 正打开手写页才整块重画；否则只换标签栏上的字数，不打断正在读的稿
        if (S.view && S.root) renderArticles(S.tab === HAND_KEY);
      }).catch((e) => { hd.loading = null; toast(`手写稿没读出来：${e.message || e}`, true); });
    }
    return hd.loading;
  }

  function saveHandSoon() {
    const hd = S.hand;
    clearTimeout(hd.timer);
    hd.state = 'dirty';
    paintHandStatus();
    hd.timer = setTimeout(() => saveHand(), 700);
  }

  // force：冲突时田哥选「用这里的版本」，不再比对文件
  async function saveHand(force) {
    const hd = S.hand;
    clearTimeout(hd.timer); hd.timer = null;
    if (!hd.dir || !hd.loaded || hd.state === 'conflict' && !force) return;
    if (hd.text === hd.base && !force) { if (hd.state === 'dirty') { hd.state = 'saved'; paintHandStatus(); } return; }
    const text = hd.text;
    hd.state = 'saving'; paintHandStatus();
    try {
      const r = await call('writing:handdraft-save', { dir: hd.dir, text, base: force ? null : hd.base });
      if (r.conflict) { hd.state = 'conflict'; hd.disk = r.text || ''; }
      else { hd.base = text; hd.savedAt = r.savedAt || Date.now(); hd.state = hd.text === text ? 'saved' : 'dirty'; }
    } catch (e) {
      hd.state = 'error';
      toast(`手写稿没存上：${e.message || e}`, true);
    }
    if (S.hand !== hd) return; // 存的是刚切走的那篇，界面已经换了
    if (hd.state === 'dirty') saveHandSoon(); else paintHandStatus();
  }

  function flushHand() { if (S.hand.timer || S.hand.state === 'dirty') saveHand(); }
  window.addEventListener('beforeunload', flushHand);

  // 从 AI 的稿摘过来：接在手写稿末尾，空一行隔开
  async function addToHand(text, from) {
    const piece = String(text || '').trim();
    if (!piece) return;
    await loadHand();
    const hd = S.hand;
    if (!hd.loaded) return;
    hd.text = hd.text.trim() ? `${hd.text.replace(/\s+$/, '')}\n\n${piece}\n` : `${piece}\n`;
    if (hd.els) { hd.els.input.value = hd.text; paintHandPreview(); }
    saveHandSoon();
    renderArticles();
    toast(`已把${from ? ` ${from} 的` : ''}内容放进手写稿末尾`);
  }

  function handStatusText() {
    const hd = S.hand;
    if (!hd.loaded) return '读取中…';
    const n = `${hanCount(hd.text)} 字`;
    if (hd.state === 'saving' || hd.state === 'dirty') return `${n} · 正在保存…`;
    if (hd.state === 'error') return `${n} · 没存上，继续输入会再试`;
    if (hd.state === 'conflict') return `${n} · 文件在别处被改过，先选用哪一版`;
    if (hd.savedAt) { const d = new Date(hd.savedAt); return `${n} · 已自动保存 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; }
    return `${n} · 停笔自动保存`;
  }

  function paintHandStatus() {
    const els = S.hand.els;
    if (!els) return;
    els.status.textContent = handStatusText();
    els.status.classList.toggle('bad', S.hand.state === 'error' || S.hand.state === 'conflict');
    const tabSub = S.root && S.root.querySelector(`.wb-tab[data-key="${HAND_KEY}"] .wb-tab-sub`);
    if (tabSub) tabSub.textContent = handTabSub();
    els.conflict.hidden = S.hand.state !== 'conflict';
  }

  let previewTimer = null;
  function paintHandPreview() {
    const els = S.hand.els;
    if (!els) return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      if (S.hand.els !== els) return;
      if (S.hand.text.trim()) renderMarkdown(els.preview, S.hand.text);
      else els.preview.replaceChildren(h('div', { class: 'wb-hand-empty', text: '预览会出现在这里' }));
    }, 120);
  }

  function handTabSub() { return S.hand.loaded ? (S.hand.text.trim() ? `${hanCount(S.hand.text)} 字` : '还没写') : ''; }

  function renderHandPanel() {
    const hd = S.hand;
    if (!hd.loaded) { loadHand(); return h('div', { class: 'wb-panel wb-hand', 'data-col': HAND_KEY }, h('div', { class: 'wb-empty-col' }, h('span', { class: 'wb-spin' }), h('span', { text: '读取手写稿…' }))); }
    const input = h('textarea', { class: 'wb-hand-input', spellcheck: 'false', 'aria-label': '田哥手写 · Markdown',
      placeholder: '在这里汇总你自己的一稿。\n\n· 在各位 AI 的稿里选中一段，点「摘到手写稿」；整篇用稿子上方的「放进手写稿」\n· 也可以直接粘贴、自己写\n· Markdown：# 标题、## 小标题、**加粗**、> 引用、- 列表\n\n停笔自动保存到文章目录的 手写稿.md' });
    input.value = hd.text;
    // 发点评等操作会整块重画文章区：正在手写的话，光标和滚动位置接着用
    const prev = hd.els && document.activeElement === hd.els.input
      ? { start: hd.els.input.selectionStart, end: hd.els.input.selectionEnd, top: hd.els.input.scrollTop } : null;
    if (prev) setTimeout(() => { input.focus(); input.setSelectionRange(prev.start, prev.end); input.scrollTop = prev.top; }, 0);
    const preview = h('div', { class: 'wr-paper wb-hand-preview' });
    const status = h('span', { class: 'wb-hand-status wr-muted' });
    const conflict = h('div', { class: 'wb-errbar wb-hand-conflict', hidden: true },
      h('span', { text: '手写稿.md 在别处被改过（比如用别的编辑器打开改了），和这里的内容不一样。' }),
      h('button', { class: 'wr-btn small', text: '用文件里的版本', onclick: () => { hd.text = hd.base = hd.disk; input.value = hd.text; hd.state = 'saved'; paintHandPreview(); paintHandStatus(); } }),
      h('button', { class: 'wr-btn small', text: '用这里的版本覆盖文件', onclick: () => saveHand(true) }));
    input.addEventListener('input', () => { hd.text = input.value; paintHandPreview(); saveHandSoon(); });
    input.addEventListener('blur', flushHand);
    // 左边滚到哪，右边按比例跟到哪
    input.addEventListener('scroll', () => {
      const max = input.scrollHeight - input.clientHeight;
      if (max > 0) preview.scrollTop = (input.scrollTop / max) * (preview.scrollHeight - preview.clientHeight);
    });
    const split = h('div', { class: 'wb-hand-split' + (S.narrow ? ' stacked' : '') },
      h('div', { class: 'wb-hand-pane' }, h('div', { class: 'wb-hand-label', text: 'Markdown' }), input),
      h('div', { class: 'wb-hand-pane' }, h('div', { class: 'wb-hand-label', text: '预览' }), preview));
    hd.els = { input, preview, status, conflict, split };
    const panel = h('div', { class: 'wb-panel wb-hand', 'data-col': HAND_KEY },
      h('div', { class: 'wb-panel-bar wb-hand-bar' },
        h('b', { text: '田哥手写' }), status,
        h('span', { class: 'wr-spacer' }),
        h('button', { class: 'wr-btn small', text: '复制', title: '复制手写稿的 Markdown', onclick: () => guarded(async () => { await navigator.clipboard.writeText(hd.text); toast('手写稿已复制'); }) })),
      conflict, split);
    paintHandStatus();
    paintHandPreview();
    setTimeout(fitHand, 0);
    return panel;
  }

  // 编辑区一直铺到底部点评框的上沿：点评框是贴底浮着的，按固定高度会被它盖住下半截
  function fitHand() {
    const els = S.hand.els;
    if (!els || !els.split.isConnected) return;
    const main = S.root.closest('.wr-studio-main') || S.root.parentElement;
    const basket = section('basket');
    const mr = main.getBoundingClientRect();
    const top = els.split.getBoundingClientRect().top - mr.top + main.scrollTop;
    const room = main.clientHeight - top - (basket ? basket.offsetHeight : 0) - 16;
    const px = `${Math.max(S.narrow ? 560 : 380, Math.floor(room))}px`;
    if (els.split.style.height !== px) els.split.style.height = px;
  }
  window.addEventListener('resize', () => fitHand());

  /* ─────────── 点评篮：按文章存在本机，切走再回来还在 ─────────── */

  const basketKey = (dir = S.dir) => `writing-basket:${dir}`;
  function basket(dir) { try { return JSON.parse(localStorage.getItem(basketKey(dir)) || '{"items":[],"free":""}'); } catch { return { items: [], free: '' }; } }
  function saveBasket(b, dir) { try { localStorage.setItem(basketKey(dir), JSON.stringify(b)); } catch { /* 存不下就只留在内存 */ } }

  /* ─────────── 发进群聊 ─────────── */

  function sessionOf(sid) { try { return typeof sessions !== 'undefined' ? sessions.get(sid) : null; } catch { return null; } }
  function meetingOf(id) { try { return typeof meetings !== 'undefined' ? meetings[id] : null; } catch { return null; } }

  // 返回 Promise：派发被拒（不是 AI 写完）时 reject。AI 写稿要几分钟，不等它写完。
  async function sendToGroup(text, { recipientSids, meeting } = {}) {
    const v = S.view;
    const meetingId = (meeting && meeting.id) || (v && v.meetingId);
    const m = meeting || meetingOf(meetingId);
    if (!meetingId || !m) throw new Error('这篇的写作群聊找不到了（可能已删除）');
    const targets = recipientSids && recipientSids.length ? recipientSids : (m.subSessions || []);
    for (const sid of targets) {
      const s = sessionOf(sid);
      if (s && s.status === 'dormant' && typeof window.resumeDormantSession === 'function') {
        const ok = await window.resumeDormantSession(sid);
        if (!ok) throw new Error(`${s.title || '成员'} 唤醒失败，没有发出`);
      }
    }
    try { await ipcRenderer.invoke('meeting-append-user-turn', { meetingId, text }); } catch { /* 时间线记录失败不影响派发 */ }
    const clientMessageId = `writing-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const turn = ipcRenderer.invoke('groupchat:turn', { meetingId, userInput: text, recipientSids: recipientSids && recipientSids.length ? recipientSids : undefined, clientMessageId });
    // groupchat:turn 在整轮结束时才返回；被拒通常立刻返回。等一小会儿：被拒就报错，否则当作已发出。
    const early = await Promise.race([turn.then((r) => ({ r })), new Promise((res) => setTimeout(() => res(null), 2500))]);
    if (early && early.r && early.r.status !== 'completed') throw new Error(`没有发出：${early.r.reason || early.r.status || '未知原因'}`);
    const FAILED = ['absent', 'errored', 'send_exception', 'error', 'failed'];
    const results = early && early.r && Array.isArray(early.r.results) ? early.r.results : [];
    if (results.length && results.every((x) => FAILED.includes(x && x.status))) {
      throw new Error(`没有发出：${results.map((x) => `${x.label || '成员'}${x.reason ? `（${x.reason}）` : ''}`).join('、')} 都没收到`);
    }
    turn.then((r) => { if (r && r.status !== 'completed' && r.status !== 'error') return; if (r && r.status === 'error') toast(`这一轮没有跑完：${r.reason || '未知原因'}`, true); }).catch(() => {});
    setTimeout(refresh, 600);
  }

  let armedAt = 0;
  async function sendWith(label, text, opts, onSent) {
    if (S.sending) return;
    const v = S.view;
    const busy = v && (v.columns || []).filter((c) => c.status === 'working').map((c) => c.name);
    if (busy && busy.length && Date.now() - armedAt > 6000) {
      armedAt = Date.now();
      toast(`${busy.join('、')} 还在写，现在发出会打断它们这一轮。确实要发，6 秒内再点一次`, true);
      return;
    }
    armedAt = 0;
    S.sending = true;
    renderBasket(true);
    try {
      const dir = S.dir;
      await sendToGroup(text, opts);
      if (onSent) onSent(dir);
      toast(`${label}，AI 正在写`);
    } catch (e) {
      toast(e.message || String(e), true);
    } finally {
      S.sending = false;
      renderBasket(true);
      renderQuestions(true);
    }
  }

  /* ─────────── 文案：Tab 替田哥说的话 ─────────── */

  function commentLines(b) {
    const lines = b.items.map((it) => (it.quote ? `- ${it.name} 的稿，「${it.quote}」：${it.comment}` : `- ${it.name} 的稿（总评）：${it.comment}`));
    if (b.free.trim()) lines.push(`- ${b.free.trim()}`);
    return lines;
  }

  function sendComments() {
    const b = basket();
    const lines = commentLines(b);
    if (!lines.length) { toast('先划线点评或写几句意见', true); return; }
    const text = ['我的点评：', ...lines, '', '请各自按点评改一版，交完整的新版本（文章放在两行文章标记之间）。'].join('\n');
    const recipientSids = Array.isArray(b.recipients)
      ? b.recipients.filter(sid => S.view.columns.some(col => col.sid === sid)) : undefined;
    if (recipientSids && !recipientSids.length) { toast('请至少选择一位接收成员', true); return; }
    sendWith('点评已发出', text, { recipientSids }, (dir) => saveBasket({ items: [], free: '', recipients: b.recipients }, dir));
  }

  function sendFinalize(col) {
    const b = basket();
    const lines = commentLines(b);
    const text = [`请 ${col.name} 汇总定稿：读完群里所有稿和我的全部点评，取各稿之长改定，用定稿标记交稿。其他人这一轮不用写。`,
      ...(lines.length ? ['', '定稿前再看这几条点评：', ...lines] : [])].join('\n');
    sendWith(`已请 ${col.name} 汇总定稿`, text, { recipientSids: [col.sid] }, (dir) => saveBasket({ items: [], free: '' }, dir));
  }

  function sendAnswers(qs) {
    const lines = qs.map((q, i) => `${i + 1}. ${q.q}\n   → ${(S.answers[q.key] ?? q.recommend ?? '').trim() || '按你的推荐来'}`);
    const text = ['回答你们的问题：', ...lines, '', '请按这些回答修改，交完整的新版本（文章放在两行文章标记之间）。'].join('\n');
    sendWith('回答已发出', text, {}, () => { for (const q of qs) delete S.answers[q.key]; });
  }

  async function retry(col) {
    const v = S.view;
    if (!v || !col.sid) return;
    await guarded(async () => {
      const s = sessionOf(col.sid);
      if (s && s.status === 'dormant' && typeof window.resumeDormantSession === 'function') await window.resumeDormantSession(col.sid);
      // Codex 长文本通道出过错后要重开会话才能再收长消息（core/codex-editor-input.js）
      else if (/重开/.test(col.error || '')) {
        const r = await ipcRenderer.invoke('restart-session', col.sid);
        if (r && r.ok === false) throw new Error(r.message || '会话重开失败');
      }
      toast(`正在让 ${col.name} 重写这一轮`);
      ipcRenderer.invoke('groupchat-resend-participant', { meetingId: v.meetingId, sid: col.sid, turnNum: col.turn || undefined })
        .then((r) => { if (r && !r.ok) toast(`${col.name} 重试没成功：${r.detail || r.reason || '未知原因'}`, true); refresh(); })
        .catch((e) => toast(`${col.name} 重试没成功：${e.message || e}`, true));
      setTimeout(refresh, 800);
    });
  }

  /* ─────────── 划线点评 ─────────── */

  let pop = null;
  function closePop() { if (pop) { pop.remove(); pop = null; } }

  function askComment({ x, y, col, quote }) {
    closePop();
    const ta = h('textarea', { class: 'wb-pop-input', rows: '3', placeholder: quote ? '对这段的意见，比如：开头再狠一点' : `对 ${col.name} 这份稿的总体意见` });
    const add = () => {
      const comment = ta.value.trim();
      if (!comment) { ta.focus(); return; }
      const b = basket();
      b.items.push({ sid: col.sid, name: col.name, quote: quote ? quote.slice(0, 160) : '', comment });
      saveBasket(b);
      closePop();
      window.getSelection()?.removeAllRanges();
      renderBasket(true);
    };
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); add(); } if (e.key === 'Escape') closePop(); });
    pop = h('div', { class: 'wb-pop', 'data-col': col.sid || col.name, style: { left: `${Math.max(8, Math.min(x, window.innerWidth - 340))}px`, top: `${Math.max(8, Math.min(y, window.innerHeight - 190))}px` } },
      quote ? h('div', { class: 'wb-pop-quote', text: `「${quote.length > 80 ? quote.slice(0, 80) + '…' : quote}」` }) : h('div', { class: 'wb-pop-quote', text: `${col.name} · 总评` }),
      ta,
      h('div', { class: 'wb-row' },
        h('button', { class: 'wr-btn small primary', text: '放进点评篮（Ctrl+Enter）', onclick: add }),
        h('button', { class: 'wr-btn small', text: '取消', onclick: closePop })));
    document.body.appendChild(pop);
    setTimeout(() => ta.focus(), 0);
  }

  let selBtn = null;
  function hideSelBtn() { if (selBtn) { selBtn.remove(); selBtn = null; } }
  function onPaperMouseUp(e, col) {
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? sel.toString().replace(/\s+/g, ' ').trim() : '';
      hideSelBtn();
      if (!text || text.length < 2 || !sel.rangeCount) return;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      // 摘录保留段落：选区里的换行原样带走，只把行内多余空白收掉
      const raw = sel.toString().split(/\n{2,}/).map((p) => p.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n\n');
      selBtn = h('div', { class: 'wb-sel-btns', 'data-col': col.sid || col.name, style: { left: `${Math.min(rect.right, window.innerWidth - 220)}px`, top: `${Math.max(8, rect.top - 34)}px` } },
        col.sid ? h('button', { class: 'wb-sel-btn', text: '点评这段', onmousedown: (ev) => ev.preventDefault(),
          onclick: () => { hideSelBtn(); askComment({ x: rect.left, y: rect.bottom + 8, col, quote: text }); } }) : null,
        h('button', { class: 'wb-sel-btn alt', text: '摘到手写稿', title: '接在「田哥手写」末尾', onmousedown: (ev) => ev.preventDefault(),
          onclick: () => { hideSelBtn(); window.getSelection()?.removeAllRanges(); addToHand(raw, col.name); } }));
      document.body.appendChild(selBtn);
    }, 0);
  }
  document.addEventListener('mousedown', (e) => {
    if (selBtn && !selBtn.contains(e.target)) hideSelBtn();
    if (pop && !pop.contains(e.target)) closePop();
  });

  /* ─────────── 渲染：分区，各自只在内容变了时重画（不打断划线、不丢滚动） ─────────── */

  let pointerDownIn = null;
  document.addEventListener('mousedown', (e) => { pointerDownIn = e.target && e.target.closest ? e.target.closest('.wb-col, .wb-panel') : null; }, true);
  document.addEventListener('mouseup', () => { setTimeout(() => { pointerDownIn = null; }, 0); }, true);
  function busyIn(node) {
    if (node.contains(document.activeElement) && document.activeElement.matches('input, textarea, [contenteditable="true"]')) return true;
    if (pointerDownIn === node || pop || selBtn) return pointerDownIn === node || (pop && pop.dataset.col === node.dataset.col) || (selBtn && selBtn.dataset.col === node.dataset.col);
    const sel = window.getSelection();
    return !!(sel && !sel.isCollapsed && sel.rangeCount && node.contains(sel.getRangeAt(0).commonAncestorContainer));
  }

  function section(name) { return S.root && S.root.querySelector(`[data-wb="${name}"]`); }
  // 原生 replaceChildren 会把 null 当成文字 "null" 塞进去，条件块统一过滤掉
  function put(el, ...nodes) { el.replaceChildren(...nodes.flat().filter((n) => n != null && n !== false)); }
  function changed(name, value) {
    const sig = JSON.stringify(value);
    if (S.sigs[name] === sig) return false;
    S.sigs[name] = sig;
    return true;
  }

  function renderHead() {
    const v = S.view;
    const el = section('head');
    if (!el || !changed('head', [v.title, v.steps, v.idea, v.meetingId, v.running])) return;
    const firstOpen = STEPS.findIndex(([k]) => !v.steps[k]);
    put(el,
      h('div', { class: 'wb-titlebar' },
        h('h2', { class: 'wb-title', text: v.title || '新文章' }),
        h('details', { class: 'wb-progress' }, h('summary', { text: `进度 · ${STEPS[firstOpen]?.[1] || '已定稿'}` }),
          h('div', { class: 'wb-steps' }, ...STEPS.map(([k, label], i) => h('span', { class: 'wb-step' + (v.steps[k] ? ' done' : i === firstOpen ? ' now' : ''), text: label })))),
        h('span', { class: 'wb-actions' },
          h('button', { class: 'wr-btn small', text: '在群聊里看过程', title: '群聊是这篇文章的后台：完整过程、排查问题时看', onclick: () => openMeeting(v.meetingId) }),
          h('button', { class: 'wr-btn small', text: '文件夹', onclick: () => call('writing:article-open-dir', { dir: v.dir }) }))),
      v.idea ? h('details', { class: 'wb-idea' }, h('summary', { text: '写作想法', title: v.idea }), h('div', { class: 'wb-idea-full', text: v.idea })) : null);
  }

  const ideaKey = (dir) => `writing-idea:${dir}`;
  function renderIdeaBox(el) {
    const v = S.view;
    el.hidden = false;
    const ta = h('textarea', { class: 'wr-input wb-free', rows: '4', placeholder: '这篇想写什么？' });
    try { ta.value = localStorage.getItem(ideaKey(v.dir)) || ''; } catch { /* 没存过 */ }
    ta.addEventListener('input', () => { try { localStorage.setItem(ideaKey(v.dir), ta.value); } catch { /* 存不下 */ } });
    put(el,
      h('div', { class: 'wb-q-head' }, h('b', { text: '中心思想还没发出去' }), h('span', { class: 'wr-muted', text: '写作群建好了，但第一条消息没送到。改好后点发出' })),
      ta,
      h('div', { class: 'wb-row' }, h('button', { class: 'wr-btn primary', disabled: S.sending, text: S.sending ? '正在发…' : '发给大家', onclick: () => {
        const text = ta.value.trim();
        if (!text) { ta.focus(); return; }
        sendWith('中心思想已发出', `${text}\n\n（写作 Tab：请按写作群规则交稿，文章放在两行文章标记之间。）`, {}, (dir) => { try { localStorage.removeItem(ideaKey(dir)); } catch { /* 无 */ } });
      } })));
  }

  function renderQuestions(force) {
    const v = S.view;
    const el = section('questions');
    if (!el) return;
    if (!v.idea && v.meetingId && !(v.columns || []).some((c) => c.items.length || c.status === 'working')) {
      if (force || changed('questions', ['idea-box', S.sending])) renderIdeaBox(el);
      return;
    }
    el.replaceChildren(); el.hidden = true;
    if (force) renderArticles(true);
  }

  function questionsOf(col) {
    return (S.view.questions || []).filter(q => q.sid ? q.sid === col.sid : q.from === col.name);
  }

  function memberQuestions(col) {
    const qs = questionsOf(col);
    if (!qs.length) return null;
    return h('section', { class: 'wb-questions wb-member-questions', 'data-member': keyOf(col), 'aria-label': `${col.name} 的问题` },
      h('div', { class: 'wb-q-head' }, h('b', { text: `${col.name} 想问你 · ${qs.length}` }), h('span', { class: 'wr-muted', text: '稿里已按推荐答案先写，不回答也行' })),
      ...qs.map((q) => {
        const input = h('input', { class: 'wr-input wb-q-input', value: S.answers[q.key] ?? q.recommend ?? '', placeholder: '你的回答', oninput: (e) => { S.answers[q.key] = e.target.value; } });
        return h('div', { class: 'wb-q' }, h('div', { class: 'wb-q-text' }, h('span', { class: 'wr-muted', text: `${q.from}：` }), q.q), input);
      }),
      h('div', { class: 'wb-row' },
        h('button', { class: 'wr-btn primary', disabled: S.sending, text: S.sending ? '正在发…' : '把回答发给大家', onclick: () => sendAnswers(qs) }),
        h('span', { class: 'wr-muted', text: '推荐答案已填好，可以直接发，也可以改' })));
  }

  /* ─────────── 文章区：每位 AI 一个标签页，有定稿时「定稿」排第一；宽屏可切「并排对比」 ─────────── */

  const FINAL_KEY = '__final';
  const HAND_KEY = '__hand';
  const keyOf = (c) => c.sid || c.name;

  function itemLabel(it) {
    if (it.kind === 'final') return '定稿';
    if (it.kind === 'draft') return `v${it.version}`;
    if (it.kind === 'file') return '文件';
    return '回复';
  }
  const kindWord = (it) => ({ reply: '回复', file: '文件', final: '定稿' }[it.kind] || '稿');

  function currentItem(col) {
    const items = col.items || [];
    const idx = Math.min(S.versionOf[keyOf(col)] ?? items.length - 1, items.length - 1);
    return { items, idx, it: items[idx] };
  }

  // 标签上的小字：在写 / 出错 / 最新一版的版本与字数
  function tabSub(col) {
    const { items } = currentItem(col);
    const last = items[items.length - 1];
    if (col.status === 'working') return items.length ? '正在改…' : '正在写…';
    if (col.status === 'error') return '出错';
    if (col.status === 'stopped') return '已停止';
    if (!last) return col.status === 'dormant' ? '休眠中' : '还没交稿';
    return `${itemLabel(last)} · ${last.chars} 字`;
  }

  function tabList(v) {
    const tabs = [];
    if (v.final) tabs.push({ key: FINAL_KEY, label: '定稿', sub: `${v.final.from ? `${v.final.from} 汇总 · ` : ''}${v.final.chars} 字`, status: 'final', count: 1 });
    for (const c of v.columns || []) tabs.push({ key: keyOf(c), label: c.name, sub: tabSub(c), status: c.status, count: (c.items || []).length, col: c });
    tabs.push({ key: HAND_KEY, label: '田哥手写', sub: handTabSub(), status: 'hand', count: 0 });
    return tabs;
  }

  // 默认打开：定稿 > 第一份已交的稿 > 第一位。定稿第一次出现时自动跳过去
  function pickTab(tabs, v) {
    if (v.final && !S.hadFinal) { S.hadFinal = true; S.tab = FINAL_KEY; }
    if (!v.final) S.hadFinal = false;
    if (S.tab && tabs.some((t) => t.key === S.tab)) return S.tab;
    const first = tabs.find((t) => t.key === FINAL_KEY) || tabs.find((t) => t.count) || tabs.find((t) => t.key !== HAND_KEY) || tabs[0];
    S.tab = first ? first.key : null;
    return S.tab;
  }

  function copyBtn(text, label) {
    return h('button', { class: 'wr-btn small', text: '复制', title: '复制这份稿的 Markdown', onclick: () => guarded(async () => { await navigator.clipboard.writeText(text); toast(`${label}已复制`); }) });
  }

  // AI 写给田哥的话和问题跟在正文后面，首屏优先留给文章。
  function asideOf(it) {
    return [
      it.note ? (() => {
        const long = it.note.length > 120 || it.note.split(/\n/).filter(Boolean).length > 2;
        const box = h('div', { class: 'wb-aside' + (long ? ' clamp' : ''), title: long ? '点一下展开 / 收起' : '' },
          h('div', { class: 'wb-aside-label', text: '写给你的话' }), h('div', { class: 'wb-aside-text', text: it.note }));
        if (long) box.addEventListener('click', () => { if (!String(window.getSelection() || '')) box.classList.toggle('open'); });
        return box;
      })() : null,
      it.hint ? h('div', { class: 'wb-hint', text: it.hint }) : null,
      it.kind === 'reply' ? h('div', { class: 'wb-hint warn', text: '这条回答里没有找到文章，原样显示' }) : null,
    ];
  }

  function errBarOf(col, hasItem) {
    if (!(col.status === 'error' || col.status === 'stopped') || !col.sid) return null;
    const stale = col.turn && S.view && col.turn < S.view.latestTurn;
    return h('div', { class: 'wb-errbar' },
      h('span', { text: stale ? `第 ${col.turn} 轮${col.status === 'error' ? '出错' : '被停止'}了；下次发点评或回答时会一起收到` : col.error || (col.status === 'error' ? '这一轮出错了' : '这一轮被停止了') }),
      stale ? null : h('button', { class: 'wr-btn small', text: hasItem ? '重试这一轮' : '重试', onclick: () => retry(col) }),
      h('button', { class: 'wr-btn small', text: '在群聊里看', onclick: () => openMeeting(S.view.meetingId) }));
  }

  function emptyOf(col) {
    if (col.status === 'error' || col.status === 'stopped') return h('div', { class: 'wb-empty-col bad' }, h('b', { text: col.status === 'error' ? '这一轮没有拿到稿' : '这一轮被停止了' }), col.error ? h('div', { class: 'wr-muted', text: col.error }) : null);
    if (col.status === 'working') return h('div', { class: 'wb-empty-col' }, h('span', { class: 'wb-spin' }), h('span', { text: `${col.name} 正在写，写完会出现在这里` }));
    return h('div', { class: 'wb-empty-col' }, h('span', { class: 'wr-muted', text: col.status === 'dormant' ? '成员休眠中，下次发消息时自动唤醒' : '还没有交稿' }));
  }

  function versionPills(col, items, idx, rerender) {
    if (items.length < 2) return null;
    return h('span', { class: 'wb-vers' }, ...items.map((x, i) => h('button', { class: 'wb-ver' + (i === idx ? ' on' : ''), text: itemLabel(x), title: x.title || '', onclick: () => { S.versionOf[keyOf(col)] = i; rerender(); } })));
  }

  function articlePaper(col, it) {
    const p = paper(it.text);
    p.addEventListener('mouseup', (e) => onPaperMouseUp(e, col));
    return p;
  }

  function toHandBtn(text, from) {
    return h('button', { class: 'wr-btn small', text: '放进手写稿', title: '把这份稿的 Markdown 整篇接到「田哥手写」末尾', onclick: () => addToHand(text, from) });
  }

  // 标签页模式下的一位 AI：工具条（版本、字数、状态、总评、复制）+ 写给你的话 + 排版好的文章
  function renderPanel(col) {
    const { items, idx, it } = currentItem(col);
    const key = keyOf(col);
    const status = it && STATUS_LABEL[col.status] ? h('span', { class: `wb-status ${col.status}`, text: col.status === 'working' ? '正在改…' : STATUS_LABEL[col.status] }) : null;
    const bar = h('div', { class: 'wb-panel-bar' },
      versionPills(col, items, idx, () => renderArticles(true)),
      it ? h('span', { class: 'wr-muted', text: it.kind === 'draft' ? `${it.chars} 字` : `${kindWord(it)} · ${it.chars} 字` }) : null,
      status,
      h('span', { class: 'wr-spacer' }),
      it && col.sid ? h('button', { class: 'wr-btn small', text: '总评', title: '对这份稿写一句总体意见，放进点评篮', onclick: (e) => askComment({ x: e.clientX - 160, y: e.clientY + 12, col }) }) : null,
      it && it.kind !== 'reply' ? toHandBtn(it.text, col.name) : null,
      it && it.kind !== 'reply' ? copyBtn(it.text, `${col.name} 的稿`) : null);
    const body = it
      ? [errBarOf(col, true), articlePaper(col, it), memberQuestions(col), ...asideOf(it)]
      : [errBarOf(col, false), emptyOf(col), memberQuestions(col)];
    return h('div', { class: `wb-panel ${col.status}`, 'data-col': key }, bar, h('div', { class: 'wb-panel-body' }, ...body.flat().filter(Boolean)));
  }

  function renderFinalPanel() {
    const v = S.view;
    const f = v.final;
    const voice = v.voice && v.voice.status ? h('span', { class: 'wb-hint', text: ctx.voiceLabel(v.voice), title: [v.voice.summary, v.voice.error].filter(Boolean).join('\n') })
      : h('span', { class: 'wb-hint', text: '定稿停笔两分钟后，AI 自动据此优化文风' });
    return h('div', { class: 'wb-panel wb-final', 'data-col': FINAL_KEY },
      h('div', { class: 'wb-panel-bar' },
        h('b', { text: '定稿' }), h('span', { class: 'wr-muted', text: `${f.from ? `${f.from} 汇总 · ` : ''}${f.chars} 字` }),
        voice, h('span', { class: 'wr-spacer' }), toHandBtn(f.text, '定稿'), copyBtn(f.text, '定稿')),
      h('div', { class: 'wb-panel-body' }, articlePaper({ name: '定稿' }, f), ...asideOf({ note: f.note }).filter(Boolean)));
  }

  // 并排对比模式下的一栏（宽屏、两位以上时可选）
  function renderColumn(col) {
    const { items, idx, it } = currentItem(col);
    const status = STATUS_LABEL[col.status] ? h('span', { class: `wb-status ${col.status}`, text: col.status === 'working' && items.length ? '正在改…' : STATUS_LABEL[col.status] }) : null;
    const head = h('div', { class: 'wb-col-head' },
      h('b', { text: col.name }),
      it ? h('span', { class: 'wr-muted', text: `${kindWord(it)} · ${it.chars} 字` }) : null,
      status,
      h('span', { class: 'wr-spacer' }),
      versionPills(col, items, idx, () => renderArticles(true)),
      it && col.sid ? h('button', { class: 'wr-btn small', text: '总评', title: '对这份稿写一句总体意见，放进点评篮', onclick: (e) => askComment({ x: e.clientX - 160, y: e.clientY + 12, col }) }) : null);
    const body = it ? [errBarOf(col, true), articlePaper(col, it), memberQuestions(col), ...asideOf(it)] : [errBarOf(col, false), emptyOf(col), memberQuestions(col)];
    return h('div', { class: `wb-col ${col.status}`, 'data-col': keyOf(col) }, head, h('div', { class: 'wb-col-body' }, ...body.flat().filter(Boolean)));
  }

  // 布局（标签、选中、模式）变了才整体重画；否则只换内容变了的那一块，正在划的线、滚到的位置都不动
  function renderArticles(force) {
    const v = S.view;
    const el = section('drafts');
    if (!el) return;
    const cols = v.columns || [];
    if (!cols.length && !v.final) { el.replaceChildren(h('div', { class: 'wr-empty', text: '写作群还没有成员。' })); S.sigs.articles = null; return; }
    const tabs = tabList(v);
    const canCompare = !S.narrow && cols.length > 1;
    const compare = canCompare && S.compare;
    const cur = compare ? null : pickTab(tabs, v);
    if (cur) S.seen[cur] = (tabs.find((t) => t.key === cur) || {}).count || 0;
    for (const t of tabs) if (S.seen[t.key] == null) S.seen[t.key] = t.count; // 打开文章时已有的稿不算「新」
    const shown = compare ? cols : cols.filter((c) => keyOf(c) === cur);
    // 出错栏的「重试」按钮要看这一轮过没过去，所以最新轮次也算进出错栏的签名
    const sigOf = (c) => JSON.stringify([c, questionsOf(c), S.sending, S.versionOf[keyOf(c)] ?? null, c.status === 'error' || c.status === 'stopped' ? v.latestTurn : 0]);
    // 手写页只在读完文件时重画一次；之后输入、保存状态都就地更新，轮询不碰编辑器
    const contentSig = compare ? cols.map(sigOf) : cur === FINAL_KEY ? [JSON.stringify([v.final, v.voice])]
      : cur === HAND_KEY ? [JSON.stringify(['hand', S.hand.dir, S.hand.loaded, S.narrow])] : shown.map(sigOf);
    const panelOf = () => (cur === FINAL_KEY ? renderFinalPanel() : cur === HAND_KEY ? renderHandPanel() : renderPanel(shown[0]));
    if (cur !== HAND_KEY && S.hand.els) { flushHand(); S.hand.els = null; }
    // 别的 AI 交稿 / 状态变化只换标签栏，不动正在读的那份稿（划线、滚动都保留）
    const layout = JSON.stringify([compare, cur, canCompare, compare ? cols.map(keyOf) : 0]);
    const barSig = JSON.stringify(tabs.map((t) => [t.key, t.label, t.sub, t.status, t.count > (S.seen[t.key] || 0)]));

    const host0 = el.querySelector('.wb-articles-body');
    if (!force && host0 && layout === S.sigs.articles) {
      if (barSig !== S.sigs.articlesBar) { S.sigs.articlesBar = barSig; el.querySelector('.wb-tabbar').replaceWith(tabBar(tabs, cur, compare, canCompare, cols)); }
      const blocks = [...host0.querySelectorAll('[data-col]')];
      contentSig.forEach((sig, i) => {
        const node = blocks[i];
        if (!node || S.colSigs[i] === sig || busyIn(node)) return; // 正在划选 / 写点评：下一轮再换
        S.colSigs[i] = sig;
        node.replaceWith(compare ? renderColumn(cols[i]) : panelOf());
      });
      return;
    }
    S.sigs.articles = layout;
    S.sigs.articlesBar = barSig;
    S.colSigs = contentSig.slice();
    const body = compare
      ? h('div', { class: 'wb-articles-body wb-cols', style: { gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))` } }, ...cols.map(renderColumn))
      : h('div', { class: 'wb-articles-body' + (cur === HAND_KEY ? ' wide' : '') }, panelOf());
    el.replaceChildren(tabBar(tabs, cur, compare, canCompare, cols), body);
  }

  function tabBar(tabs, cur, compare, canCompare, cols) {
    const tabBtns = compare
      ? [h('span', { class: 'wb-compare-title', text: `并排对比 · ${cols.length} 位` })]
      : tabs.map((t) => h('button', {
        class: `wb-tab ${t.status || ''}` + (t.key === cur ? ' on' : ''),
        'data-key': t.key,
        title: t.key === FINAL_KEY ? '汇总改定的定稿' : t.key === HAND_KEY ? '自己汇总一稿：左边写 Markdown，右边看排版' : `${t.label} 的稿`,
        onclick: () => { S.tab = t.key; renderArticles(true); },
      },
      h('span', { class: 'wb-tab-dot' }),
      h('span', { class: 'wb-tab-name', text: t.label }),
      h('span', { class: 'wb-tab-sub', text: t.sub }),
      t.key !== cur && t.count > (S.seen[t.key] || 0) ? h('span', { class: 'wb-tab-new', text: '新' }) : null));
    return h('div', { class: 'wb-tabbar' },
      ...tabBtns,
      h('span', { class: 'wr-spacer' }),
      canCompare ? h('button', { class: 'wr-btn small' + (compare ? ' on' : ''), text: compare ? '回到标签页' : '并排对比', title: '几份稿左右并排，方便对照', onclick: () => { S.compare = !compare; try { localStorage.setItem('writing-compare', S.compare ? '1' : ''); } catch { /* 记不住就算了 */ } renderArticles(true); } }) : null);
  }

  function renderBasket(force) {
    const v = S.view;
    const el = section('basket');
    if (!el || !v) return;
    const b = basket();
    const cols = (v.columns || []).filter((c) => c.sid);
    // 自由意见框不进签名：田哥正在打字时，轮询不能把输入框换掉
    const sig = [b.items, b.recipients, S.sending, cols.map((c) => [c.sid, c.name])];
    if (!force && !changed('basket', sig)) return;
    if (force) S.sigs.basket = JSON.stringify(sig);
    composer?.dispose(); composer = null;
    const inputHost = h('div');
    const pick = h('select', { class: 'wr-select', title: '选一位 AI 汇总定稿' }, ...cols.map((c) => h('option', { value: c.sid, text: c.name })));
    const lastDone = cols.filter((c) => c.items.length).pop();
    if (lastDone) pick.value = lastDone.sid;
    put(el,
      b.items.length ? h('div', { class: 'wb-basket-head' }, h('b', { text: '待发点评' }), h('span', { class: 'wr-muted', text: `${b.items.length} 条，和下面的话一起发出` })) : null,
      b.items.length ? h('div', { class: 'wb-chips' }, ...b.items.map((it, i) => h('div', { class: 'wb-chip' },
        h('span', { class: 'wr-muted', text: it.quote ? `${it.name} ·「${it.quote.length > 40 ? it.quote.slice(0, 40) + '…' : it.quote}」` : `${it.name} · 总评` }),
        h('span', { text: it.comment }),
        h('button', { class: 'wb-x', text: '×', title: '删掉这条', onclick: () => { const nb = basket(); nb.items.splice(i, 1); saveBasket(nb); renderBasket(true); } })))) : null,
      h('div', { class: 'writing-recipient-row' }, h('span', { class: 'wr-muted', text: '发给' }), ...cols.map(col => {
        const selected = !Array.isArray(b.recipients) || b.recipients.includes(col.sid);
        return h('button', { type: 'button', class: 'composer-chip writing-recipient' + (selected ? ' selected' : ''), 'aria-pressed': String(selected), disabled: S.sending,
          text: col.name, onclick: () => {
            const nb = basket(), ids = new Set(nb.recipients || cols.map(c => c.sid));
            if (ids.has(col.sid)) ids.delete(col.sid); else ids.add(col.sid);
            nb.recipients = [...ids]; saveBasket(nb); renderBasket(true);
          } });
      }), h('span', { class: 'wr-spacer' }),
        cols.length ? h('span', { class: 'wb-row tight wb-finalize' }, h('span', { class: 'wr-muted', text: '请' }), pick,
          h('button', { class: 'wr-btn primary', disabled: S.sending, text: '汇总定稿', onclick: () => { const col = cols.find((c) => c.sid === pick.value); if (col) sendFinalize(col); } })) : null), inputHost);
    const dir = S.dir;
    composer = require('./writing-composer').mountWritingComposer({ host: inputHost, h, ipcRenderer,
      value: b.free || '', placeholder: '写点评，也可以在稿里选中一段，点「点评这段」…',
      label: S.sending ? '正在发…' : '发出点评', disabled: S.sending,
      allowEmpty: () => !!basket(dir).items.length,
      canSend: () => !Array.isArray(basket(dir).recipients) || basket(dir).recipients.length > 0,
      target: { id: `writing:${dir}`, project: dir, meetingId: v.meetingId },
      referenceSession: typeof referenceSessionIntoInput === 'function' ? referenceSessionIntoInput : null,
      onInput: text => { const nb = basket(dir); nb.free = text; saveBasket(nb, dir); }, onSend: sendComments,
    });
    composer.input.classList.add('wb-free');
  }

  function render() {
    if (!S.root || !S.view) return;
    renderHead(); renderQuestions(); renderArticles(); renderBasket();
  }

  /* ─────────── 数据：选中文章时每 3 秒读一次 ─────────── */

  async function refresh() {
    if (!S.dir || !S.visible) return;
    const dir = S.dir;
    let r;
    try { r = await call('writing:article-view', { dir }); } catch (e) { if (S.dir === dir) once(e.message || String(e)); return; }
    if (S.dir !== dir || !S.root) return;
    if (r.view.writeError) once(r.view.writeError); else lastError = '';
    const prevSig = S.view && JSON.stringify([S.view.title, S.view.steps, S.view.final ? 1 : 0, S.view.columns.map((c) => c.items.length)]);
    S.view = r.view;
    render();
    const nextSig = JSON.stringify([S.view.title, S.view.steps, S.view.final ? 1 : 0, S.view.columns.map((c) => c.items.length)]);
    if (prevSig && prevSig !== nextSig && onChanged) onChanged();
  }

  // 3 秒一轮的轮询：同一个错误只弹一次，好了再出错才再弹
  let lastError = '';
  function once(msg) { if (msg !== lastError) { lastError = msg; toast(msg, true); } }

  function syncTimer() {
    const need = S.visible && S.dir;
    if (need && !S.timer) S.timer = setInterval(refresh, POLL_MS);
    else if (!need && S.timer) { clearInterval(S.timer); S.timer = null; }
  }

  function mount(container, dir) {
    composer?.dispose(); composer = null;
    if (S.resize) { S.resize.disconnect(); S.resize = null; }
    if (S.dir !== dir) { flushHand(); S.hand = freshHand(dir); S.view = null; S.versionOf = {}; S.tab = null; S.seen = {}; S.hadFinal = false; }
    S.hand.els = null;
    S.dir = dir;
    S.sigs = {};
    S.root = h('div', { class: 'wb' },
      h('div', { 'data-wb': 'head', class: 'wb-head' }),
      h('div', { 'data-wb': 'questions', class: 'wb-questions', hidden: true }),
      h('div', { 'data-wb': 'drafts', class: 'wb-drafts' }),
      h('div', { 'data-wb': 'basket', class: 'wb-basket' }));
    container.replaceChildren(S.root);
    if (!S.view) S.root.querySelector('[data-wb="head"]').appendChild(h('div', { class: 'wr-muted', text: '读取这篇文章…' }));
    else render();
    S.resize = new ResizeObserver(() => {
      const narrow = S.root && S.root.clientWidth > 0 && S.root.clientWidth < NARROW_PX;
      if (narrow !== S.narrow) { S.narrow = narrow; if (S.view) renderArticles(true); }
      fitHand();
    });
    S.resize.observe(S.root);
    S.resize.observe(S.root.querySelector('[data-wb="basket"]')); // 点评框长高（攒了几条点评）时，手写区跟着让位
    syncTimer();
    refresh();
    loadHand(dir);
  }

  function setVisible(v) {
    S.visible = v;
    if (!v) { hideSelBtn(); closePop(); flushHand(); }
    syncTimer();
    if (v) refresh();
  }

  return { mount, setVisible, refresh, sendToGroup, current: () => S.dir, _state: S };
}

const kindLabel = (kind) => KIND_LABEL[String(kind || '').replace(/-.*$/, '')] || kind;

module.exports = { createWorkbench, kindLabel };
