'use strict';
/**
 * 写作 Tab（writing-panel）—— 与 study-panel / chuxin-panel 平级的主区视图，入口在左侧「账号」下方。
 *
 * 2026-09-30 田哥体验后改版：少让人动手，多自动化，但让人看得见做了什么。
 *   作品库  只读：旧作 592 篇 + 写作台定稿的新作
 *   写作台  「新文章」= 一个写作场景的 AI 群聊（后台）。2026-10-01 起写作在这里完成：左边文章列表，
 *           右边文章工作台（renderer/writing-workbench.js）——各家稿件分标签页、回答问题、划线点评、点名定稿
 *   文风    直接展示文风 skill 源文件（带行号，可直接改）+ AI 每次写完自动优化的记录
 *
 * 数据都在主进程 main/ipc/writing-handlers.js；群聊本身复用 Hub 的 meeting-room。
 */
(function () {
  const { ipcRenderer } = require('electron');

  const HUB_VERSION = (() => { try { return require('../package.json').version; } catch { return ''; } })();
  const VOICE_FILES = [['SKILL.md', '写法（SKILL.md）'], ['exemplars.md', '范文（exemplars.md）'], ['learned-from-edits.md', '改稿规则（learned-from-edits.md）']];
  const VOICE_STATUS = { queued: '排队等 AI 优化文风', running: 'AI 正在读这次的写作过程，优化文风…', done: '文风已根据这篇更新', rejected: 'AI 的修改没通过检查，未写回', failed: '文风优化失败', skipped: '还没有定稿' };

  const S = {
    opened: false,
    view: 'studio',
    lib: { filters: { sources: [], years: [], topics: [], lengths: [], exemplarOnly: false, query: '', sort: 'date' }, data: null, currentId: null, limit: 150, rebuiltAt: 0 },
    voice: { file: 'SKILL.md', data: null, editing: false },
    studio: { articles: [], creating: false, current: null, composing: false, draft: '' },
  };

  let root = null;
  let pollTimer = null;

  /* ─────────────── 工具 ─────────────── */

  function h(tag, props, ...children) {
    const n = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
        else n.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return n;
  }

  async function call(channel, args) {
    const r = await ipcRenderer.invoke(channel, args || {});
    if (!r || !r.ok) throw new Error((r && r.message) || '调用失败');
    return r;
  }

  function toast(msg, bad) {
    const t = h('div', { class: 'wr-toast' + (bad ? ' bad' : ''), text: msg });
    t.style.bottom = `${24 + document.querySelectorAll('.wr-toast').length * 52}px`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), bad ? 6000 : 2600);
  }

  async function guarded(fn) {
    try { return await fn(); } catch (e) { toast(e.message || String(e), true); return undefined; }
  }

  let _marked = null; let _purify = null; let _math = null;
  function mdLibs() {
    if (!_marked) _marked = require('marked').marked;
    if (!_purify) _purify = require('dompurify');
    if (!_math) _math = require('./markdown-math-guard');
  }
  function renderMath(el) {
    if (typeof window.renderMathInElement === 'function') {
      window.renderMathInElement(el, {
        delimiters: [{ left: '$$', right: '$$', display: true }, { left: '\\[', right: '\\]', display: true }, { left: '\\(', right: '\\)', display: false }, { left: '$', right: '$', display: false }],
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option'],
        throwOnError: false, strict: 'ignore', trust: false,
      });
    }
  }
  function renderMarkdown(el, text) {
    try {
      mdLibs();
      const guard = _math.guardMarkdownMath(String(text || ''));
      el.innerHTML = _math.restoreMarkdownMath(_purify.sanitize(_marked.parse(guard.text, { breaks: false, gfm: true })), guard);
      renderMath(el);
    } catch { el.textContent = String(text || ''); }
    return el;
  }
  function renderInline(el, text) {
    try { mdLibs(); el.innerHTML = _purify.sanitize(_marked.parseInline(String(text || ''))); renderMath(el); } catch { el.textContent = String(text || ''); }
    return el;
  }
  function paper(text) { return renderMarkdown(h('div', { class: 'wr-paper' }), text); }

  function when(iso) {
    if (!iso) return '';
    try { return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)); } catch { return ''; }
  }

  /* ─────────────── 骨架 ─────────────── */

  function buildSkeleton() {
    if (root && root.__built) return;
    root = document.getElementById('writing-panel');
    if (!root) return;
    root.__built = true;
    const tabs = [['studio', '写作台'], ['library', '作品库'], ['voice', '文风']];
    root.appendChild(h('div', { class: 'wr-head' },
      h('h1', { text: '写作' }),
      h('div', { class: 'wr-tabs' }, ...tabs.map(([key, label]) => h('button', { class: 'wr-tab', 'data-view': key, text: label, onclick: () => switchView(key) }))),
      h('div', { class: 'wr-spacer' }),
      h('div', { class: 'wr-version', text: `AI Hub v${HUB_VERSION} · 写作 Tab` })));
    root.appendChild(h('div', { class: 'wr-body' },
      h('div', { class: 'wr-view wr-studio', id: 'wr-view-studio' }),
      h('div', { class: 'wr-view wr-lib', id: 'wr-view-library' }),
      h('div', { class: 'wr-view wr-voice', id: 'wr-view-voice' })));
  }

  function switchView(view) {
    S.view = view;
    root.querySelectorAll('.wr-tab').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    root.querySelectorAll('.wr-view').forEach((v) => v.classList.toggle('active', v.id === `wr-view-${view}`));
    if (view === 'library') loadLibrary(true);
    if (view === 'voice') loadVoice();
    if (view === 'studio') loadStudio();
    syncPolling();
  }

  /* ─────────────── 写作台 ─────────────── */

  async function loadStudio() {
    await guarded(async () => {
      const r = await call('writing:article-list');
      // 8 秒一轮的轮询：列表没变就不重画（右侧工作台自己 3 秒刷新，互不打扰）
      const sig = JSON.stringify([r.articles, r.articles.map((a) => meetingExists(a.meetingId))]);
      S.studio.articles = r.articles;
      if (!S.studio.current && !S.studio.composing && r.articles.length) S.studio.current = r.articles[0].dir;
      if (!S.studio.current && !r.articles.length) S.studio.composing = true;
      if (sig === S.studio.sig && document.querySelector('#wr-view-studio .wr-articles')) return;
      S.studio.sig = sig;
      renderStudio();
    });
  }

  function meetingExists(id) {
    try { return !!(id && typeof meetings !== 'undefined' && meetings[id]); } catch { return false; }
  }

  function openMeeting(id) {
    const fn = typeof selectMeeting === 'function' ? selectMeeting : window.selectMeeting;
    if (!meetingExists(id) || typeof fn !== 'function') { toast('这篇的写作群聊找不到了（可能已删除）', true); return; }
    fn(id);
  }

  function voiceLabel(v) {
    return v.status === 'done' && v.changed === false ? '文风：这篇没有需要改的地方' : VOICE_STATUS[v.status] || v.status;
  }

  // 文章工作台（renderer/writing-workbench.js）：右侧整块
  const { createWorkbench, kindLabel } = require('./writing-workbench.js');
  const workbench = createWorkbench({
    h, call, toast, guarded, paper, ipcRenderer, openMeeting, voiceLabel,
    onChanged: () => { S.studio.sig = null; if (S.opened && S.view === 'studio' && !S.studio.creating) loadStudio(); },
  });

  // 新文章：在 Tab 里写中心思想、勾成员；后台建写作群并替田哥发出第一条消息，不跳到群聊
  async function startArticle(idea, members) {
    if (S.studio.creating) return;
    S.studio.creating = true;
    renderStudio();
    let dir = null;
    try {
      ({ dir } = await call('writing:article-create'));
      const wc = window.WorkspaceController;
      const slots = members.map((m, i) => {
        let tuning = m.model ? { model: m.model } : {};
        try { if (wc && typeof wc.buildSessionTuningOpts === 'function') tuning = wc.buildSessionTuningOpts(m.kind, m.model || '', {}) || tuning; } catch { /* 用默认调参 */ }
        if (m.model) tuning.model = m.model;
        return { index: i, kind: m.kind, ...tuning };
      });
      const meeting = await ipcRenderer.invoke('create-meeting', {
        mode: 'writing',
        scene: 'writing',
        slots,
        title: '',
        groupChat: true,
        groupMode: 'deliberation',
        groupRecentRawN: 5,
        participants: slots.map((_, i) => i),
        workspace: dir,
        workspaceLabel: '写作',
        workspaceDraft: false,
      });
      if (!meeting || !meeting.id) throw new Error('写作群聊没有创建成功');
      await call('writing:article-bind', { dir, meetingId: meeting.id });
      S.studio.current = dir;
      S.studio.composing = false;
      S.studio.draft = '';
      // 万一发送失败，工作台会出补发框，里面预填这段话
      try { localStorage.setItem(`writing-idea:${dir}`, idea); } catch { /* 存不下就只能重写 */ }
      // 写作群规则只在首轮注入一次，模型偶尔会忘了交稿格式（2026-10-01 E2E 里 haiku 就漏过）：Tab 替田哥发话时顺带提醒一句
      await workbench.sendToGroup(`${idea}\n\n（写作 Tab：请按写作群规则交稿，文章放在两行文章标记之间。）`, { meeting });
      try { localStorage.removeItem(`writing-idea:${dir}`); } catch { /* 无 */ }
      toast('写作群已建好，AI 正在写初稿');
    } catch (e) {
      toast(`新文章没有建成：${e.message || e}`, true);
    } finally {
      S.studio.creating = false;
      S.studio.sig = null;
      if (S.opened) loadStudio();
    }
  }

  async function renderComposer(box) {
    let members = [];
    try { members = (await call('writing:article-defaults')).members; } catch { /* 下面按钮会灰掉 */ }
    const picked = new Set(members.map((_, i) => i));
    const ta = h('textarea', { class: 'wr-input wb-compose-text', rows: '8', placeholder: '这篇想写什么？说说中心思想、写给谁、想表达的观点。想到哪写到哪，AI 会补问。' });
    ta.value = S.studio.draft || '';
    const go = h('button', { class: 'wr-btn primary big', text: S.studio.creating ? '正在建写作群…' : '开始写',
      onclick: () => startArticle(ta.value.trim(), members.filter((_, i) => picked.has(i))) });
    const sync = () => { go.disabled = !ta.value.trim() || !picked.size || S.studio.creating; };
    ta.addEventListener('input', () => { S.studio.draft = ta.value; sync(); });
    sync();
    box.replaceChildren(h('div', { class: 'wr-card wb-compose' },
      h('h2', { class: 'wb-title', text: '新文章' }),
      ta,
      h('div', { class: 'wb-row' },
        h('span', { class: 'wr-muted', text: '请这几位一起写：' }),
        ...members.map((m, i) => h('label', { class: 'wb-member' },
          h('input', { type: 'checkbox', checked: true, onchange: (e) => { if (e.target.checked) picked.add(i); else picked.delete(i); sync(); } }),
          `${kindLabel(m.kind)}${m.model ? ` · ${m.model}` : ''}`))),
      h('div', { class: 'wr-muted', text: '点「开始写」后，Hub 在后台建一个写作群，把这段话发给大家。各家的稿会出现在这里，你在这里回答问题、点评、定稿；群聊只在想看过程时打开。' }),
      h('div', { class: 'wb-row' }, go, S.studio.articles.length ? h('button', { class: 'wr-btn', text: '取消', onclick: () => { S.studio.composing = false; S.studio.sig = null; renderStudio(); } }) : null)));
    setTimeout(() => ta.focus(), 0);
  }

  function renderStudio() {
    const view = document.getElementById('wr-view-studio');
    if (!view) return;
    const st = S.studio;
    const list = st.articles.map((a) => {
      const status = a.hasFinal ? h('span', { class: 'wr-pill ok', text: '已定稿' })
        : a.drafts.length ? h('span', { class: 'wr-pill brand', text: `${a.drafts.length} 份稿` })
          : h('span', { class: 'wr-pill', text: '写作中' });
      const v = a.voice;
      return h('div', { class: 'wr-article' + (!st.composing && st.current === a.dir ? ' on' : ''), title: '在右侧打开这篇', onclick: () => { st.current = a.dir; st.composing = false; st.sig = null; renderStudio(); } },
        h('div', { class: 't', text: a.title || '新文章' }),
        h('div', { class: 'm' }, status, h('span', { text: [when(a.createdAt), meetingExists(a.meetingId) ? '' : '群聊已不在'].filter(Boolean).join(' · ') })),
        v && v.status ? h('div', { class: 'v' },
          h('span', { class: `wr-pill ${v.status === 'done' ? 'ok' : ['failed', 'rejected'].includes(v.status) ? 'bad' : 'brand'}`, text: voiceLabel(v), title: [v.summary, v.error].filter(Boolean).join('\n') }),
          ['failed', 'rejected'].includes(v.status) ? h('button', { class: 'wr-btn small', text: '重新优化文风', onclick: (e) => { e.stopPropagation(); guarded(async () => { await call('writing:voice-evolve', { dir: a.dir }); st.sig = null; loadStudio(); }); } }) : null) : null);
    });
    const side = h('aside', { class: 'wr-studio-list' },
      h('button', { class: 'wr-btn primary big wb-new', disabled: st.creating, text: st.creating ? '正在建写作群…' : '＋ 新文章', onclick: () => { st.composing = true; st.sig = null; renderStudio(); } }),
      h('div', { class: 'wr-articles' }, ...(list.length ? list : [h('div', { class: 'wr-empty', text: '还没有文章。' })])));
    // 左边列表每次重画；右边只在换文章（或新建状态变化）时重建，工作台里的滚动、划线、输入都不受列表刷新影响
    let split = view.querySelector(':scope > .wr-studio-split');
    if (!split) { split = h('div', { class: 'wr-studio-split' }, h('aside'), h('section', { class: 'wr-studio-main' })); view.replaceChildren(split); }
    split.firstElementChild.replaceWith(side);
    const main = split.querySelector('.wr-studio-main');
    const mode = st.composing || !st.current ? `compose:${st.creating}` : `article:${st.current}`;
    if (main.dataset.mode === mode && main.firstElementChild) return;
    main.dataset.mode = mode;
    if (st.composing || !st.current) { workbench.setVisible(false); renderComposer(main); }
    else { workbench.mount(main, st.current); workbench.setVisible(S.opened && S.view === 'studio'); }
  }

  /* ─────────────── 作品库（只读） ─────────────── */

  async function loadLibrary(maybeRebuild) {
    await guarded(async () => {
      // 打开作品库时顺手刷新索引（新定稿的文章会被收进来），一分钟内不重复
      if (maybeRebuild && Date.now() - S.lib.rebuiltAt > 60000) { await call('writing:library-rebuild'); S.lib.rebuiltAt = Date.now(); }
      S.lib.data = await call('writing:library-list', S.lib.filters);
      renderLibrary();
      if (S.lib.currentId) openArticle(S.lib.currentId, true);
    });
  }

  function toggleIn(arr, v) { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); else arr.push(v); }

  function renderLibrary() {
    const view = document.getElementById('wr-view-library');
    const d = S.lib.data;
    if (!view || !d) return;
    const st = d.stats;
    const f = S.lib.filters;
    const years = Object.keys(st.byYear).filter((y) => y !== '未知').sort();
    const maxYear = Math.max(1, ...years.map((y) => st.byYear[y]));
    const stats = h('div', { class: 'wr-stats' },
      h('div', { class: 'wr-total' }, '共 ', h('b', { text: st.total }), ' 篇 · 约 ', h('b', { text: (st.cjk / 10000).toFixed(1) }), ' 万字', st.yearRange ? ` · ${st.yearRange}` : ''),
      h('div', { class: 'wr-src' }, ...Object.entries(st.bySource).map(([k, v]) => h('div', { class: 'wr-card' }, k, h('b', { text: v })))),
      h('div', { class: 'wr-years', title: '点柱子按年份筛选，再点取消' }, ...years.map((y) => h('div', {
        class: 'wr-year' + (f.years.includes(y) ? ' on' : ''),
        onclick: () => { toggleIn(f.years, y); loadLibrary(); },
      }, h('div', { class: 'bar', style: { height: Math.max(3, Math.round((st.byYear[y] / maxYear) * 40)) + 'px' }, title: `${y}：${st.byYear[y]} 篇` }), y.slice(2)))));
    const check = (label, arr, value, n) => h('label', {},
      h('input', { type: 'checkbox', checked: arr.includes(value), onchange: () => { toggleIn(arr, value); loadLibrary(); } }),
      label, n != null ? h('span', { class: 'n', text: n }) : null);
    const filters = h('div', { class: 'wr-filters' },
      h('h4', { text: '来源' }), ...Object.entries(st.bySource).map(([k, v]) => check(k, f.sources, k, v)),
      h('h4', { text: '题材' }), ...Object.entries(st.byTopic).sort((a, b) => b[1] - a[1]).map(([k, v]) => check(k, f.topics, k, v)),
      h('h4', { text: '篇幅' }), ...st.lengths.map((l) => check(l.label, f.lengths, l.key, l.count)),
      h('h4', { text: '年份' }), ...years.slice().reverse().map((y) => check(y, f.years, y, st.byYear[y])),
      h('h4', { text: '其他' }),
      h('label', {}, h('input', { type: 'checkbox', checked: f.exemplarOnly, onchange: (e) => { f.exemplarOnly = e.target.checked; loadLibrary(); } }), '只看出过范文的'),
      (f.sources.length || f.years.length || f.topics.length || f.lengths.length || f.exemplarOnly)
        ? h('button', { class: 'wr-btn small', style: { marginTop: '10px' }, text: '清空筛选', onclick: () => { Object.assign(f, { sources: [], years: [], topics: [], lengths: [], exemplarOnly: false }); loadLibrary(); } })
        : null);
    let debounce = null;
    const search = h('input', { class: 'wr-input', type: 'search', placeholder: '搜索标题与正文', value: f.query,
      oninput: (e) => { clearTimeout(debounce); debounce = setTimeout(() => { f.query = e.target.value; S.lib.limit = 150; loadLibrary(); }, 300); } });
    const sort = h('select', { class: 'wr-select', onchange: (e) => { f.sort = e.target.value; loadLibrary(); } },
      h('option', { value: 'date', text: '最新发布', selected: f.sort === 'date' }), h('option', { value: 'length', text: '最长', selected: f.sort === 'length' }));
    const list = h('div', { class: 'wr-list' });
    for (const it of d.items.slice(0, S.lib.limit)) {
      list.appendChild(h('div', { class: 'wr-item' + (it.id === S.lib.currentId ? ' on' : ''), onclick: () => openArticle(it.id) },
        h('div', { class: 't' }, it.exemplar ? h('span', { class: 'star', text: '★', title: '文风 skill 的范文出自这篇' }) : null, it.title),
        h('div', { class: 'm', text: [it.date || '日期未知', it.source, `${it.cjk} 字`, it.source === 'CSDN' && !it.original ? '非原创' : ''].filter(Boolean).join(' · ') }),
        h('div', { class: 'x', text: it.hit || it.excerpt }),
        h('div', { class: 'tags' }, ...it.topics.map((t) => h('span', { class: 'wr-pill', text: t })))));
    }
    if (d.items.length > S.lib.limit) list.appendChild(h('button', { class: 'wr-btn', text: `再显示 150 篇（还有 ${d.items.length - S.lib.limit} 篇）`, onclick: () => { S.lib.limit += 150; renderLibrary(); } }));
    if (!d.items.length) list.appendChild(h('div', { class: 'wr-empty', text: '没有符合条件的文章' }));
    const listcol = h('div', { class: 'wr-listcol' }, h('div', { class: 'wr-listbar' }, search, sort), h('div', { class: 'wr-muted', text: `筛出 ${d.total} 篇` }), list);
    const reader = h('div', { class: 'wr-reader', id: 'wr-reader' }, h('div', { class: 'wr-empty', text: '点左边的一篇文章在这里阅读。' }));
    view.replaceChildren(stats, h('div', { class: 'wr-lib-main' }, filters, listcol, reader));
    if (f.query && document.activeElement !== search) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
  }

  async function openArticle(id, keepScroll) {
    S.lib.currentId = id;
    const r = await guarded(() => call('writing:library-article', { id }));
    if (!r) return;
    const a = r.article;
    document.querySelectorAll('#wr-view-library .wr-item').forEach((n, i) => n.classList.toggle('on', (S.lib.data.items[i] || {}).id === id));
    const reader = document.getElementById('wr-reader');
    if (!reader) return;
    const body = paper(a.body || '（这篇还没有正文）');
    reader.replaceChildren(
      h('div', { class: 'wr-reader-head' },
        h('h2', {}, a.exemplar ? h('span', { style: { color: '#e3b341' }, text: '★ ', title: '文风 skill 的范文出自这篇' }) : null, a.title),
        h('span', { class: 'wr-muted', text: [a.date, a.source, `${a.cjk} 字`, a.type].filter(Boolean).join(' · ') }),
        ...a.topics.map((t) => h('span', { class: 'wr-pill', text: t })),
        a.url ? h('button', { class: 'wr-btn small', text: '打开原文', onclick: () => require('electron').shell.openExternal(a.url) }) : null),
      body);
    if (!keepScroll) body.scrollTop = 0;
  }

  /* ─────────────── 文风：源文件 + 自动优化记录 ─────────────── */

  async function loadVoice() {
    await guarded(async () => {
      S.voice.data = await call('writing:voice-source', { name: S.voice.file });
      renderVoice();
    });
  }

  function ratioChart(points) {
    const W = 300; const H = 120; const pad = 24;
    const svgNS = 'http://www.w3.org/2000/svg';
    const mk = (tag, attrs) => { const n = document.createElementNS(svgNS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
    const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, class: 'wr-chart' });
    for (const v of [0, 30, 60]) {
      const y = H - pad - (v / 60) * (H - 2 * pad);
      svg.appendChild(mk('line', { x1: pad, x2: W - 8, y1: y, y2: y, stroke: 'currentColor', 'stroke-opacity': '.15' }));
      const t = mk('text', { x: 0, y: y + 4, 'font-size': '10', fill: 'currentColor', 'fill-opacity': '.6' }); t.textContent = `${v}%`; svg.appendChild(t);
    }
    const valid = points.filter((p) => typeof p.ratio === 'number');
    const step = valid.length > 1 ? (W - pad - 16) / (valid.length - 1) : 0;
    const xy = valid.map((p, i) => [pad + 6 + i * step, H - pad - (Math.min(p.ratio, 60) / 60) * (H - 2 * pad)]);
    if (xy.length > 1) svg.appendChild(mk('polyline', { points: xy.map((p) => p.join(',')).join(' '), fill: 'none', stroke: 'var(--brand)', 'stroke-width': '2' }));
    xy.forEach(([x, y], i) => { const c = mk('circle', { cx: x, cy: y, r: 4, fill: 'var(--brand)' }); const tt = document.createElementNS(svgNS, 'title'); tt.textContent = `${valid[i].title || valid[i].piece}：定稿相对最接近的稿改了 ${valid[i].ratio}%`; c.appendChild(tt); svg.appendChild(c); });
    return svg;
  }

  // 源文件按行展示：左边行号，右边是这一行的排版效果（每条写法正好一行）
  function numberedLines(text) {
    const box = h('div', { class: 'wr-lines' });
    String(text || '').split('\n').forEach((line, i) => {
      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      const content = h('div', { class: 'lc' + (heading ? ` hd h${heading[1].length}` : '') + (line.trim() ? '' : ' blank') });
      if (heading) renderInline(content, heading[2]);
      else if (line.startsWith('> ')) { content.classList.add('quote'); renderInline(content, line.slice(2)); }
      else renderInline(content, line);
      box.appendChild(h('div', { class: 'wr-line' }, h('span', { class: 'ln', text: i + 1 }), content));
    });
    return box;
  }

  function renderVoice() {
    const view = document.getElementById('wr-view-voice');
    const v = S.voice.data;
    if (!view || !v) return;
    const tabs = h('div', { class: 'wr-gtabs' }, ...VOICE_FILES.map(([name, label]) => h('button', {
      class: 'wr-gtab' + (name === S.voice.file ? ' on' : ''), text: label,
      onclick: () => { if (S.voice.editing) { toast('先保存或取消正在编辑的内容', true); return; } S.voice.file = name; loadVoice(); },
    })));
    let body;
    if (S.voice.editing) {
      const ta = h('textarea', { class: 'wr-voice-editor', spellcheck: 'false' });
      ta.value = v.text;
      const save = () => guarded(async () => {
        const r = await call('writing:voice-source-save', { name: S.voice.file, text: ta.value, base: v.text });
        S.voice.editing = false;
        toast(r.unchanged ? '内容没有变化' : `已保存 ${S.voice.file}（改前已备份，可回退）`);
        await loadVoice();
      });
      ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); } });
      body = h('div', { class: 'wr-voice-edit' },
        h('div', { class: 'wr-row' },
          h('button', { class: 'wr-btn primary', text: '保存（Ctrl+S）', onclick: save }),
          h('button', { class: 'wr-btn', text: '取消', onclick: () => { S.voice.editing = false; renderVoice(); } }),
          h('span', { class: 'wr-muted', text: '直接改源文件。AI 之后自动优化时，不会改掉你手动改过的写法条目。' })),
        ta);
      setTimeout(() => ta.focus(), 0);
    } else {
      body = numberedLines(v.text);
    }
    const main = h('div', { class: 'wr-card wr-voice-main' },
      h('div', { class: 'wr-section-title' }, '文风 skill', tabs, h('span', { style: { flex: 1 } }),
        S.voice.editing ? null : h('button', { class: 'wr-btn small primary', text: '编辑', onclick: () => { S.voice.editing = true; renderVoice(); } }),
        h('button', { class: 'wr-btn small', text: '回退上一步', title: '把最近一次写回的文风文件恢复到改动前', onclick: () => guarded(async () => { const r = await call('writing:voice-undo'); toast(`已回退 ${r.file}`); await loadVoice(); }) }),
        h('button', { class: 'wr-btn small', text: '文件夹', onclick: () => call('writing:voice-open-dir') })),
      h('div', { class: 'wr-muted', style: { marginBottom: '8px' }, text: `${v.dir}\\${S.voice.file} · 写作群里的 AI 按这份文件写；每篇定稿后 AI 会自动小步优化它` }),
      body);
    const ratios = v.editRatios || [];
    const side = h('div', { class: 'wr-card wr-voice-side' },
      h('div', { class: 'wr-section-title', text: '最近的变化' }),
      v.changelog.length ? h('ul', { class: 'wr-changelog' }, ...v.changelog.map((l) => {
        const m = l.match(/^(\d{4}-\d{2}-\d{2})\s+(.*)$/);
        const text = m ? m[2] : l;
        const cls = /^AI /.test(text) ? 'ai' : /田哥手动/.test(text) ? 'me' : '';
        return h('li', { class: cls }, m ? h('span', { class: 'date', text: m[1] }) : null, text);
      })) : h('div', { class: 'wr-muted', text: '还没有记录' }),
      h('div', { class: 'wr-section-title', style: { marginTop: '14px' }, text: '每篇定稿改了 AI 稿多少' }),
      ratios.length ? ratioChart(ratios) : h('div', { class: 'wr-muted', text: '写完第一篇后这里会出现第一个点。数字越来越小，说明 AI 越来越像你。' }));
    view.replaceChildren(main, side);
  }

  /* ─────────────── 事件、轮询与显隐 ─────────────── */

  ipcRenderer.on('writing-event', (_e, p) => {
    if (!p || !S.opened) return;
    if (p.type === 'voice-evolve') {
      if (S.view === 'studio') { S.studio.sig = null; loadStudio(); workbench.refresh(); }
      if (S.view === 'voice' && !S.voice.editing && ['done', 'rejected', 'failed'].includes(p.status)) loadVoice();
    }
  });

  // 写作台列表里的稿件数、定稿是 AI 在群里写出来的文件，打开写作台时每 8 秒刷新一次
  function syncPolling() {
    const need = S.opened && S.view === 'studio';
    workbench.setVisible(need && !S.studio.composing && !!S.studio.current);
    if (need && !pollTimer) pollTimer = setInterval(() => { if (!S.studio.creating) loadStudio(); }, 8000);
    else if (!need && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function setPanelVisible(visible) {
    buildSkeleton();
    if (!root) return;
    S.opened = visible;
    document.body.classList.toggle('writing-open', visible);
    if (visible) window.hubWorkspaces?.close();
    const btn = document.getElementById('btn-writing');
    root.style.display = visible ? 'flex' : 'none';
    if (btn) {
      btn.classList.toggle('active', visible);
      if (visible) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current');
    }
    if (visible) {
      const home = document.getElementById('btn-home');
      if (home) { home.classList.remove('active'); home.removeAttribute('aria-current'); }
      if (window.__chuxinHide) window.__chuxinHide();
      if (window.__studyHide) window.__studyHide();
      if (window.__ranHide) window.__ranHide();
      for (const id of ['terminal-panel', 'meeting-room-panel']) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }
      const accountPage = document.getElementById('account-page');
      if (accountPage && !accountPage.hidden) document.getElementById('btn-rail-accounts')?.click();
      switchView(S.view);
    }
    syncPolling();
  }

  window.__writingHide = function () { if (S.opened) setPanelVisible(false); };
  window.__writingShow = function () { setPanelVisible(true); };

  function init() {
    buildSkeleton();
    document.querySelectorAll('#btn-writing, [data-writing-entry]').forEach((b) => b.addEventListener('click', () => setPanelVisible(true)));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
