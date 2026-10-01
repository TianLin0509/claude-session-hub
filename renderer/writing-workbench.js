'use strict';
/**
 * 写作 Tab · 文章工作台（2026-10-01 田哥要求：写作在 Tab 里完成，群聊退到后台）。
 *
 * 一篇文章一个写作群。这里把群聊读成（主进程 writing:article-view，见 core/writing/workbench.js）：
 *   文章头    标题、中心思想、进度（说想法 → 初稿 → 你点评 → 改稿 → 定稿）
 *   问题卡    AI 想问田哥的问题，带推荐答案，回答后一次发进群
 *   稿件栏    每位 AI 一栏，排版好的 Markdown；版本可切；出错、在写都看得见，出错可就地重试
 *   点评篮    在稿里划线点评、写总评，攒好一次发出：「各自改一版」或「请某位汇总定稿」
 *   定稿      定稿出来后置顶大幅阅读
 * 田哥在这里说的话，都通过群聊自己的发送入口（meeting-append-user-turn + groupchat:turn）发进群，
 * 与群聊输入框走同一条派发链路；不经过群聊界面层，不会动到正打开的那个群。
 */

const STEPS = [['idea', '说想法'], ['draft', '初稿'], ['review', '你点评'], ['revise', '改稿'], ['final', '定稿']];
const STATUS_LABEL = { working: '正在写…', error: '出错', stopped: '已停止', dormant: '休眠中' };
const KIND_LABEL = { claude: 'Claude', codex: 'Codex', deepseek: 'DeepSeek', gemini: 'Gemini', kimi: 'Kimi' };
const POLL_MS = 3000;
const NARROW_PX = 980;

function createWorkbench(ctx) {
  const { h, call, toast, guarded, paper, ipcRenderer, openMeeting, onChanged } = ctx;
  const S = {
    dir: null, view: null, sigs: {}, answers: {}, versionOf: {}, focusSid: null, narrowSid: null,
    draftsOpen: null, colSigs: {}, sending: false, timer: null, visible: false, root: null, resize: null, narrow: false,
  };

  /* ─────────── 点评篮：按文章存在本机，切走再回来还在 ─────────── */

  const basketKey = () => `writing-basket:${S.dir}`;
  function basket() { try { return JSON.parse(localStorage.getItem(basketKey()) || '{"items":[],"free":""}'); } catch { return { items: [], free: '' }; } }
  function saveBasket(b) { try { localStorage.setItem(basketKey(), JSON.stringify(b)); } catch { /* 存不下就只留在内存 */ } }

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
    const turn = ipcRenderer.invoke('groupchat:turn', { meetingId, userInput: text, heroIdBySid: {}, recipientSids: recipientSids && recipientSids.length ? recipientSids : undefined, clientMessageId });
    // groupchat:turn 在整轮结束时才返回；被拒通常立刻返回。等一小会儿：被拒就报错，否则当作已发出。
    const early = await Promise.race([turn.then((r) => ({ r })), new Promise((res) => setTimeout(() => res(null), 2500))]);
    if (early && early.r && early.r.status !== 'completed') throw new Error(`没有发出：${early.r.reason || early.r.status || '未知原因'}`);
    turn.then((r) => { if (r && r.status !== 'completed' && r.status !== 'error') return; if (r && r.status === 'error') toast(`这一轮没有跑完：${r.reason || '未知原因'}`, true); }).catch(() => {});
    setTimeout(refresh, 600);
  }

  async function sendWith(label, text, opts, onSent) {
    if (S.sending) return;
    S.sending = true;
    renderBasket(true);
    try {
      await sendToGroup(text, opts);
      if (onSent) onSent();
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
    const text = ['我的点评：', ...lines, '', '请各自按点评改一版，交完整的新版本（回答末尾附交稿卡）。'].join('\n');
    sendWith('点评已发出', text, {}, () => saveBasket({ items: [], free: '' }));
  }

  function sendFinalize(col) {
    const b = basket();
    const lines = commentLines(b);
    const text = [`请 ${col.name} 汇总定稿：读完群里所有稿和我的全部点评，取各稿之长改定，交定稿卡。其他人这一轮不用写。`,
      ...(lines.length ? ['', '定稿前再看这几条点评：', ...lines] : [])].join('\n');
    sendWith(`已请 ${col.name} 汇总定稿`, text, { recipientSids: [col.sid] }, () => saveBasket({ items: [], free: '' }));
  }

  function sendAnswers(qs) {
    const lines = qs.map((q, i) => `${i + 1}. ${q.q}\n   → ${(S.answers[q.key] ?? q.recommend ?? '').trim() || '按你的推荐来'}`);
    const text = ['回答你们的问题：', ...lines, '', '请按这些回答修改，交完整的新版本（回答末尾附交稿卡）。'].join('\n');
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
      selBtn = h('button', { class: 'wb-sel-btn', 'data-col': col.sid || col.name, text: '点评这段', style: { left: `${Math.min(rect.right, window.innerWidth - 110)}px`, top: `${Math.max(8, rect.top - 34)}px` },
        onmousedown: (ev) => ev.preventDefault(),
        onclick: () => { hideSelBtn(); askComment({ x: rect.left, y: rect.bottom + 8, col, quote: text }); } });
      document.body.appendChild(selBtn);
    }, 0);
  }
  document.addEventListener('mousedown', (e) => {
    if (selBtn && e.target !== selBtn) hideSelBtn();
    if (pop && !pop.contains(e.target)) closePop();
  });

  /* ─────────── 渲染：分区，各自只在内容变了时重画（不打断划线、不丢滚动） ─────────── */

  let pointerDownIn = null;
  document.addEventListener('mousedown', (e) => { pointerDownIn = e.target && e.target.closest ? e.target.closest('.wb-col') : null; }, true);
  document.addEventListener('mouseup', () => { setTimeout(() => { pointerDownIn = null; }, 0); }, true);
  function busyIn(node) {
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
        h('div', { class: 'wb-steps' }, ...STEPS.map(([k, label], i) => h('span', { class: 'wb-step' + (v.steps[k] ? ' done' : i === firstOpen ? ' now' : ''), text: label }))),
        h('span', { class: 'wr-spacer' }),
        h('button', { class: 'wr-btn small', text: '在群聊里看过程', title: '群聊是这篇文章的后台：完整过程、排查问题时看', onclick: () => openMeeting(v.meetingId) }),
        h('button', { class: 'wr-btn small', text: '文件夹', onclick: () => call('writing:article-open-dir', { dir: v.dir }) })),
      v.idea ? h('details', { class: 'wb-idea' }, h('summary', { text: `${/^中心思想[:：]/.test(v.idea) ? '' : '中心思想：'}${v.idea.length > 90 ? v.idea.slice(0, 90) + '…' : v.idea}` }), h('div', { class: 'wb-idea-full', text: v.idea })) : null);
  }

  function renderQuestions(force) {
    const v = S.view;
    const el = section('questions');
    if (!el) return;
    if (!force && !changed('questions', [v.questions, S.sending])) return;
    if (force) S.sigs.questions = JSON.stringify([v.questions, S.sending]);
    const qs = v.questions || [];
    if (!qs.length) { el.replaceChildren(); el.hidden = true; return; }
    el.hidden = false;
    const from = [...new Set(qs.map((q) => q.from))].join('、');
    put(el,
      h('div', { class: 'wb-q-head' }, h('b', { text: `AI 想先问你 ${qs.length} 件事` }), h('span', { class: 'wr-muted', text: `来自 ${from} · 稿里已按推荐答案先写了，不回答也行` })),
      ...qs.map((q) => {
        const input = h('input', { class: 'wr-input wb-q-input', value: S.answers[q.key] ?? q.recommend ?? '', placeholder: '你的回答', oninput: (e) => { S.answers[q.key] = e.target.value; } });
        return h('div', { class: 'wb-q' }, h('div', { class: 'wb-q-text' }, h('span', { class: 'wr-muted', text: `${q.from}：` }), q.q), input);
      }),
      h('div', { class: 'wb-row' },
        h('button', { class: 'wr-btn primary', disabled: S.sending, text: S.sending ? '正在发…' : '把回答发给大家', onclick: () => sendAnswers(qs) }),
        h('span', { class: 'wr-muted', text: '推荐答案已填好，可以直接发，也可以改' })));
  }

  function renderFinal() {
    const v = S.view;
    const el = section('final');
    if (!el || !changed('final', [v.final, v.voice])) return;
    if (!v.final) { el.replaceChildren(); el.hidden = true; return; }
    el.hidden = false;
    const f = v.final;
    const voice = v.voice && v.voice.status ? h('span', { class: 'wr-pill', text: ctx.voiceLabel(v.voice), title: [v.voice.summary, v.voice.error].filter(Boolean).join('\n') })
      : h('span', { class: 'wr-pill', text: '定稿停笔两分钟后，AI 自动据此优化文风' });
    put(el,
      h('div', { class: 'wb-final-head' },
        h('b', { text: '定稿' }), f.from ? h('span', { class: 'wr-muted', text: `${f.from} 汇总 · ${f.chars} 字` }) : h('span', { class: 'wr-muted', text: `${f.chars} 字` }),
        voice, h('span', { class: 'wr-spacer' }),
        h('button', { class: 'wr-btn small', text: '复制 Markdown', onclick: () => guarded(async () => { await navigator.clipboard.writeText(f.text); toast('定稿已复制'); }) })),
      f.note ? h('div', { class: 'wb-note', text: f.note }) : null,
      paper(f.text));
  }

  function itemLabel(it) {
    if (it.kind === 'final') return '定稿';
    if (it.kind === 'draft') return `v${it.version}`;
    if (it.kind === 'file') return '文件';
    return '回复';
  }

  function renderColumn(col) {
    const items = col.items || [];
    const key = col.sid || col.name;
    const idx = Math.min(S.versionOf[key] ?? items.length - 1, items.length - 1);
    const it = items[idx];
    const status = STATUS_LABEL[col.status] ? h('span', { class: `wb-status ${col.status}`, text: col.status === 'working' && items.length ? '正在改…' : STATUS_LABEL[col.status] }) : null;
    const head = h('div', { class: 'wb-col-head' },
      h('b', { text: col.name }),
      it ? h('span', { class: 'wr-muted', text: `${it.kind === 'reply' ? '回复' : it.kind === 'file' ? '文件' : it.kind === 'final' ? '定稿' : '稿'} · ${it.chars} 字` }) : null,
      status,
      h('span', { class: 'wr-spacer' }),
      items.length > 1 ? h('span', { class: 'wb-vers' }, ...items.map((x, i) => h('button', { class: 'wb-ver' + (i === idx ? ' on' : ''), text: itemLabel(x), title: x.title || '', onclick: () => { S.versionOf[key] = i; renderColumns(); } }))) : null,
      it && col.sid ? h('button', { class: 'wr-btn small', text: '总评', title: '对这份稿写一句总体意见，放进点评篮', onclick: (e) => askComment({ x: e.clientX - 160, y: e.clientY + 12, col }) }) : null,
      S.narrow ? null : h('button', { class: 'wr-btn small', text: S.focusSid === key ? '还原并排' : '放大', onclick: () => { S.focusSid = S.focusSid === key ? null : key; renderColumns(); } }));
    let body;
    if (it) {
      const p = paper(it.text);
      p.addEventListener('mouseup', (e) => { if (col.sid) onPaperMouseUp(e, col); });
      body = [
        it.note ? h('div', { class: 'wb-note', text: it.note }) : null,
        it.kind === 'reply' ? h('div', { class: 'wb-note warn', text: '这条回答没有按写作格式交稿，原样显示' }) : null,
        p,
      ];
    } else if (col.status === 'error' || col.status === 'stopped') {
      body = [h('div', { class: 'wb-empty-col bad' }, h('b', { text: col.status === 'error' ? '这一轮没有拿到稿' : '这一轮被停止了' }), col.error ? h('div', { class: 'wr-muted', text: col.error }) : null)];
    } else if (col.status === 'working') {
      body = [h('div', { class: 'wb-empty-col' }, h('span', { class: 'wb-spin' }), h('span', { text: '正在写，稿子写完会出现在这里' }))];
    } else {
      body = [h('div', { class: 'wb-empty-col' }, h('span', { class: 'wr-muted', text: col.status === 'dormant' ? '成员休眠中，下次发消息时自动唤醒' : '还没有交稿' }))];
    }
    const errBar = (col.status === 'error' || col.status === 'stopped') && col.sid
      ? h('div', { class: 'wb-errbar' }, h('span', { text: col.error || (col.status === 'error' ? '这一轮出错了' : '这一轮被停止了') }), h('button', { class: 'wr-btn small', text: '重试', onclick: () => retry(col) }), h('button', { class: 'wr-btn small', text: '在群聊里看', onclick: () => openMeeting(S.view.meetingId) }))
      : null;
    return h('div', { class: `wb-col ${col.status}`, 'data-col': key }, head, it ? errBar : null, h('div', { class: 'wb-col-body' }, ...(it ? body : [errBar, ...body])));
  }

  // 稿件栏：栏位布局（成员、放大、窄屏、有无定稿）变了才整体重画；否则只换内容变了的那一栏，
  // 别的栏里正在划的线、滚到的位置都不动
  function renderColumns(force) {
    const v = S.view;
    const el = section('drafts');
    if (!el) return;
    const cols = v.columns || [];
    const keyOf = (c) => c.sid || c.name;
    const colSig = (c) => JSON.stringify([c, S.versionOf[keyOf(c)] ?? null, S.focusSid === keyOf(c)]);
    const layout = JSON.stringify([cols.map(keyOf), S.focusSid, S.narrow, S.narrowSid, !!v.final, S.narrow ? cols.map((c) => [c.name, c.status]) : 0]);
    const grid0 = el.querySelector('.wb-cols');
    if (!force && grid0 && layout === S.sigs.draftsLayout) {
      for (const c of cols) {
        const node = grid0.querySelector(`[data-col="${CSS.escape(keyOf(c))}"]`);
        if (!node) continue;
        const sig = colSig(c);
        if (S.colSigs[keyOf(c)] === sig || busyIn(node)) continue; // 正在划选 / 写点评：下一轮再换
        S.colSigs[keyOf(c)] = sig;
        node.replaceWith(renderColumn(c));
      }
      const sum = el.querySelector('.wb-drafts-fold > summary');
      if (sum) sum.textContent = `各家的稿（${cols.reduce((n, c) => n + c.items.length, 0)} 份）`;
      return;
    }
    S.sigs.draftsLayout = layout;
    S.colSigs = {};
    if (!cols.length) { el.replaceChildren(h('div', { class: 'wr-empty', text: '写作群还没有成员。' })); return; }
    let shown = cols;
    let tabs = null;
    if (S.narrow) {
      const cur = cols.find((c) => keyOf(c) === S.narrowSid) || cols[0];
      S.narrowSid = keyOf(cur);
      shown = [cur];
      tabs = h('div', { class: 'wb-tabs' }, ...cols.map((c) => h('button', { class: 'wb-tab' + (keyOf(c) === S.narrowSid ? ' on' : ''), text: `${c.name}${STATUS_LABEL[c.status] ? ` · ${STATUS_LABEL[c.status]}` : ''}`, onclick: () => { S.narrowSid = keyOf(c); renderColumns(true); } })));
    } else if (S.focusSid) {
      shown = cols.filter((c) => keyOf(c) === S.focusSid);
      if (!shown.length) { S.focusSid = null; shown = cols; }
    }
    for (const c of shown) S.colSigs[keyOf(c)] = colSig(c);
    const grid = h('div', { class: 'wb-cols', style: { gridTemplateColumns: `repeat(${shown.length}, minmax(0, 1fr))` } }, ...shown.map(renderColumn));
    const count = cols.reduce((n, c) => n + c.items.length, 0);
    if (v.final) {
      // 有定稿后，各家的稿收起来放在定稿下面；展开状态记住
      const det = h('details', { class: 'wb-drafts-fold' }, h('summary', { text: `各家的稿（${count} 份）` }), tabs, grid);
      if (S.draftsOpen) det.open = true;
      det.addEventListener('toggle', () => { S.draftsOpen = det.open; });
      el.replaceChildren(det);
    } else {
      el.replaceChildren(...[tabs, grid].filter(Boolean));
    }
  }

  function renderBasket(force) {
    const v = S.view;
    const el = section('basket');
    if (!el || !v) return;
    const b = basket();
    const cols = (v.columns || []).filter((c) => c.sid);
    // 自由意见框不进签名：田哥正在打字时，轮询不能把输入框换掉
    const sig = [b.items, S.sending, cols.map((c) => [c.sid, c.name, c.items.length])];
    if (!force && !changed('basket', sig)) return;
    if (force) S.sigs.basket = JSON.stringify(sig);
    const free = h('textarea', { class: 'wr-input wb-free', rows: '2', placeholder: '再说点什么……（总体意见、想补充的例子、语气上的要求）', oninput: (e) => { const nb = basket(); nb.free = e.target.value; saveBasket(nb); } });
    free.value = b.free || '';
    const pick = h('select', { class: 'wr-select', title: '选一位 AI 汇总定稿' }, ...cols.map((c) => h('option', { value: c.sid, text: c.name })));
    const lastDone = cols.filter((c) => c.items.length).pop();
    if (lastDone) pick.value = lastDone.sid;
    put(el,
      h('div', { class: 'wb-basket-head' }, h('b', { text: '我的点评' }), h('span', { class: 'wr-muted', text: b.items.length ? `${b.items.length} 条，还没发出` : '在稿里选中一段文字，点「点评这段」；或点每栏的「总评」' })),
      b.items.length ? h('div', { class: 'wb-chips' }, ...b.items.map((it, i) => h('div', { class: 'wb-chip' },
        h('span', { class: 'wr-muted', text: it.quote ? `${it.name} ·「${it.quote.length > 40 ? it.quote.slice(0, 40) + '…' : it.quote}」` : `${it.name} · 总评` }),
        h('span', { text: it.comment }),
        h('button', { class: 'wb-x', text: '×', title: '删掉这条', onclick: () => { const nb = basket(); nb.items.splice(i, 1); saveBasket(nb); renderBasket(true); } })))) : null,
      free,
      h('div', { class: 'wb-row' },
        h('button', { class: 'wr-btn', disabled: S.sending, text: S.sending ? '正在发…' : '发出点评，各自改一版', onclick: sendComments }),
        h('span', { class: 'wr-spacer' }),
        cols.length ? h('span', { class: 'wb-row tight' }, h('span', { class: 'wr-muted', text: '请' }), pick,
          h('button', { class: 'wr-btn primary', disabled: S.sending, text: '汇总定稿', onclick: () => { const col = cols.find((c) => c.sid === pick.value); if (col) sendFinalize(col); } })) : null));
  }

  function render() {
    if (!S.root || !S.view) return;
    renderHead(); renderQuestions(); renderFinal(); renderColumns(); renderBasket();
  }

  /* ─────────── 数据：选中文章时每 3 秒读一次 ─────────── */

  async function refresh() {
    if (!S.dir || !S.visible) return;
    const dir = S.dir;
    let r;
    try { r = await call('writing:article-view', { dir }); } catch (e) { if (S.dir === dir) toast(e.message || String(e), true); return; }
    if (S.dir !== dir || !S.root) return;
    const prevSig = S.view && JSON.stringify([S.view.title, S.view.steps, S.view.final ? 1 : 0, S.view.columns.map((c) => c.items.length)]);
    S.view = r.view;
    render();
    const nextSig = JSON.stringify([S.view.title, S.view.steps, S.view.final ? 1 : 0, S.view.columns.map((c) => c.items.length)]);
    if (prevSig && prevSig !== nextSig && onChanged) onChanged();
  }

  function syncTimer() {
    const need = S.visible && S.dir;
    if (need && !S.timer) S.timer = setInterval(refresh, POLL_MS);
    else if (!need && S.timer) { clearInterval(S.timer); S.timer = null; }
  }

  function mount(container, dir) {
    if (S.resize) { S.resize.disconnect(); S.resize = null; }
    if (S.dir !== dir) { S.view = null; S.versionOf = {}; S.focusSid = null; S.narrowSid = null; S.draftsOpen = null; }
    S.dir = dir;
    S.sigs = {};
    S.root = h('div', { class: 'wb' },
      h('div', { 'data-wb': 'head', class: 'wb-head' }),
      h('div', { 'data-wb': 'questions', class: 'wb-questions', hidden: true }),
      h('div', { 'data-wb': 'final', class: 'wb-final', hidden: true }),
      h('div', { 'data-wb': 'drafts', class: 'wb-drafts' }),
      h('div', { 'data-wb': 'basket', class: 'wb-basket' }));
    container.replaceChildren(S.root);
    if (!S.view) S.root.querySelector('[data-wb="head"]').appendChild(h('div', { class: 'wr-muted', text: '读取这篇文章…' }));
    else render();
    S.resize = new ResizeObserver(() => {
      const narrow = S.root && S.root.clientWidth > 0 && S.root.clientWidth < NARROW_PX;
      if (narrow !== S.narrow) { S.narrow = narrow; if (S.view) renderColumns(true); }
    });
    S.resize.observe(S.root);
    syncTimer();
    refresh();
  }

  function setVisible(v) {
    S.visible = v;
    if (!v) { hideSelBtn(); closePop(); }
    syncTimer();
    if (v) refresh();
  }

  return { mount, setVisible, refresh, sendToGroup, current: () => S.dir, _state: S };
}

const kindLabel = (kind) => KIND_LABEL[String(kind || '').replace(/-.*$/, '')] || kind;

module.exports = { createWorkbench, kindLabel };
