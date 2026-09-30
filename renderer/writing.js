'use strict';
/**
 * 写作 Tab（writing-panel）—— 与 study-panel / chuxin-panel 平级的主区视图，入口在左侧「账号」下方。
 *
 * 三个子页，首尾相接：
 *   作品库  存：旧作 592 篇 + 写作台新作；读、搜、挑范文、摘句
 *   写作台  写：访谈 → 起草（多模型干净上下文）→ 盲选 → 审阅批注 → 定稿（内置 Markdown 编辑器）→ 回流
 *   文风    学：tiange-voice 的画像、十条写法、范文、改动比例；由田哥确认或纠正
 *
 * 数据都在主进程 main/ipc/writing-handlers.js；本文件只负责界面。
 */
(function () {
  const { ipcRenderer } = require('electron');

  const HUB_VERSION = (() => { try { return require('../package.json').version; } catch { return ''; } })();
  const STAGES = ['interview', 'draft', 'blind', 'review', 'final', 'reflow'];
  const STAGE_LABEL = { interview: '访谈', draft: '起草', blind: '盲选', review: '审阅', final: '定稿', reflow: '回流' };
  const GROUPS = ['开场', '推进', '类比', '算账', '把自己放进去', '点破', '收束'];
  const SIGN_OPTIONS = [['direct', '直接能用'], ['edit', '改改能用'], ['no', '不能用']];

  const S = {
    opened: false,
    view: 'library',
    lib: { filters: { sources: [], years: [], topics: [], lengths: [], exemplarOnly: false, query: '', sort: 'date' }, data: null, currentId: null, article: null, limit: 150 },
    voice: { data: null, group: '开场', open: {}, editing: null },
    studio: { seriesList: [], series: null, pieces: [], dir: null, piece: null, viewStage: null, providers: null, progress: {}, quotes: [], stitch: false, stitchSel: {}, twoPick: [], finalDirty: false },
  };

  let root = null;
  let tickTimer = null;

  /* ─────────────── 工具 ─────────────── */

  function h(tag, props, ...children) {
    const n = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k === 'html') n.innerHTML = v;
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
    // 同时有多条提示时依次往上排，不叠在一起
    const stacked = document.querySelectorAll('.wr-toast').length;
    t.style.bottom = `${24 + stacked * 52}px`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), bad ? 6000 : 2600);
  }

  // Element.append(null) 会把 null 当文字插进页面，统一过滤掉空项
  function add(parent, ...items) {
    parent.append(...items.flat().filter((x) => x != null && x !== false));
    return parent;
  }

  async function guarded(fn) {
    try { return await fn(); } catch (e) { toast(e.message || String(e), true); return undefined; }
  }

  let _marked = null; let _purify = null; let _math = null;
  function renderMarkdown(el, text) {
    try {
      if (!_marked) _marked = require('marked').marked;
      if (!_purify) _purify = require('dompurify');
      if (!_math) _math = require('./markdown-math-guard');
      const guard = _math.guardMarkdownMath(String(text || ''));
      const html = _marked.parse(guard.text, { breaks: false, gfm: true });
      el.innerHTML = _math.restoreMarkdownMath(_purify.sanitize(html), guard);
      if (typeof window.renderMathInElement === 'function') {
        window.renderMathInElement(el, {
          delimiters: [{ left: '$$', right: '$$', display: true }, { left: '\\[', right: '\\]', display: true }, { left: '\\(', right: '\\)', display: false }, { left: '$', right: '$', display: false }],
          ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option'],
          throwOnError: false, strict: 'ignore', trust: false,
        });
      }
    } catch (e) {
      el.textContent = String(text || '');
    }
    return el;
  }

  function paper(text, cls) { return renderMarkdown(h('div', { class: 'wr-paper' + (cls ? ' ' + cls : '') }), text); }

  function cjk(text) { const m = String(text || '').match(/[一-鿿]/g); return m ? m.length : 0; }

  function modal(title, body, actions) {
    const mask = h('div', { class: 'wr-modal-mask' });
    const close = () => mask.remove();
    const box = h('div', { class: 'wr-modal' }, h('h3', { text: title }), body,
      h('div', { class: 'wr-actions' }, ...actions.map((a) => h('button', {
        class: 'wr-btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : ''), text: a.label,
        onclick: async () => { const keep = a.onClick ? await a.onClick() : false; if (keep !== true) close(); },
      }))));
    mask.appendChild(box);
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
    document.body.appendChild(mask);
    const first = box.querySelector('input, textarea, select');
    if (first) first.focus();
    return close;
  }

  // 选区浮动条：在注册过的容器里选中文字，就出现对应按钮
  const selbar = h('div', { class: 'wr-selbar' });
  let selActions = null;
  document.addEventListener('mouseup', (e) => {
    if (selbar.contains(e.target)) return;
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : '';
      const zone = e.target && e.target.closest ? e.target.closest('[data-wr-select]') : null;
      if (!text || !zone || !zone.__wrSelect) { selbar.classList.remove('show'); return; }
      selActions = { text, actions: zone.__wrSelect };
      selbar.replaceChildren(...zone.__wrSelect.map((a) => h('button', {
        class: 'wr-btn small', text: a.label,
        onclick: () => { selbar.classList.remove('show'); a.fn(selActions.text); window.getSelection().removeAllRanges(); },
      })));
      const r = sel.getRangeAt(0).getBoundingClientRect();
      selbar.style.left = Math.max(8, r.left) + 'px';
      selbar.style.top = Math.max(8, r.top - 40) + 'px';
      selbar.classList.add('show');
    }, 0);
  });
  function selectable(el, actions) { el.setAttribute('data-wr-select', ''); el.__wrSelect = actions; return el; }

  /* ─────────────── 骨架 ─────────────── */

  function buildSkeleton() {
    if (root && root.__built) return;
    root = document.getElementById('writing-panel');
    if (!root) return;
    root.__built = true;
    const tabs = [['library', '作品库'], ['studio', '写作台'], ['voice', '文风']];
    root.appendChild(h('div', { class: 'wr-head' },
      h('h1', { text: '写作' }),
      h('div', { class: 'wr-tabs' }, ...tabs.map(([key, label]) => h('button', {
        class: 'wr-tab', 'data-view': key, text: label, onclick: () => switchView(key),
      }))),
      h('div', { class: 'wr-spacer' }),
      h('div', { class: 'wr-version', text: `AI Hub v${HUB_VERSION} · 写作 Tab` })));
    root.appendChild(h('div', { class: 'wr-body' },
      h('div', { class: 'wr-view wr-lib', id: 'wr-view-library' }),
      h('div', { class: 'wr-view wr-studio', id: 'wr-view-studio' }),
      h('div', { class: 'wr-view wr-voice', id: 'wr-view-voice' })));
    document.body.appendChild(selbar);
  }

  function switchView(view) {
    S.view = view;
    root.querySelectorAll('.wr-tab').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    root.querySelectorAll('.wr-view').forEach((v) => v.classList.toggle('active', v.id === `wr-view-${view}`));
    if (view === 'library') loadLibrary();
    if (view === 'voice') loadVoice();
    if (view === 'studio') loadStudio();
  }

  /* ─────────────── 作品库 ─────────────── */

  async function loadLibrary() {
    await guarded(async () => {
      const r = await call('writing:library-list', S.lib.filters);
      S.lib.data = r;
      renderLibrary();
      if (S.lib.currentId) openArticle(S.lib.currentId, true);
    });
  }

  function toggleIn(arr, v) { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); else arr.push(v); }

  function renderLibrary() {
    const view = document.getElementById('wr-view-library');
    const d = S.lib.data;
    if (!d) return;
    const st = d.stats;
    const f = S.lib.filters;
    const years = Object.keys(st.byYear).filter((y) => y !== '未知').sort();
    const maxYear = Math.max(1, ...years.map((y) => st.byYear[y]));

    const stats = h('div', { class: 'wr-stats' },
      h('div', { class: 'wr-total' }, '共 ', h('b', { text: st.total }), ' 篇 · 约 ', h('b', { text: (st.cjk / 10000).toFixed(1) }), ' 万字', st.yearRange ? ` · ${st.yearRange}` : ''),
      h('div', { class: 'wr-src' }, ...Object.entries(st.bySource).map(([k, v]) => h('div', { class: 'wr-card' }, k, h('b', { text: v }))),
        h('div', { class: 'wr-card' }, '范文出处', h('b', { text: st.exemplarCount }))),
      h('div', { class: 'wr-years', title: '点柱子按年份筛选，再点取消' }, ...years.map((y) => h('div', {
        class: 'wr-year' + (f.years.includes(y) ? ' on' : ''),
        onclick: () => { toggleIn(f.years, y); loadLibrary(); },
      }, h('div', { class: 'bar', style: { height: Math.max(3, Math.round((st.byYear[y] / maxYear) * 40)) + 'px' }, title: `${y}：${st.byYear[y]} 篇` }), y.slice(2)))),
      h('button', { class: 'wr-btn small', text: '重建索引', title: '重新扫描文章目录（新作、手动放入的文章会被收进来）', onclick: () => guarded(async () => { await call('writing:library-rebuild'); await loadLibrary(); toast('索引已重建'); }) }));

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
        h('div', { class: 't' }, it.exemplar ? h('span', { class: 'star', text: '★', title: '有段落是范文' }) : null, it.title),
        h('div', { class: 'm', text: [it.date || '日期未知', it.source, `${it.cjk} 字`, it.status !== '已发' ? it.status : '', it.source === 'CSDN' && !it.original ? '非原创' : ''].filter(Boolean).join(' · ') }),
        h('div', { class: 'x', text: it.hit || it.excerpt }),
        h('div', { class: 'tags' }, ...it.topics.map((t) => h('span', { class: 'wr-pill', text: t })))));
    }
    if (d.items.length > S.lib.limit) list.appendChild(h('button', { class: 'wr-btn', text: `再显示 150 篇（还有 ${d.items.length - S.lib.limit} 篇）`, onclick: () => { S.lib.limit += 150; renderLibrary(); } }));
    if (!d.items.length) list.appendChild(h('div', { class: 'wr-empty', text: '没有符合条件的文章' }));

    const listcol = h('div', { class: 'wr-listcol' }, h('div', { class: 'wr-listbar' }, search, sort), h('div', { class: 'wr-muted', text: `筛出 ${d.total} 篇` }), list);
    const reader = h('div', { class: 'wr-reader', id: 'wr-reader' }, h('div', { class: 'wr-empty', text: '点左边的一篇文章在这里阅读。读到好段落，选中它就能设为范文或摘句。' }));
    view.replaceChildren(stats, h('div', { class: 'wr-lib-main' }, filters, listcol, reader));
    const active = document.activeElement;
    if (f.query && active !== search) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
  }

  async function openArticle(id, keepScroll) {
    S.lib.currentId = id;
    const r = await guarded(() => call('writing:library-article', { id }));
    if (!r) return;
    const a = r.article;
    S.lib.article = a;
    document.querySelectorAll('#wr-view-library .wr-item').forEach((n, i) => n.classList.toggle('on', (S.lib.data.items[i] || {}).id === id));
    const reader = document.getElementById('wr-reader');
    if (!reader) return;
    const sourceLabel = `${a.source} ${a.stem}`;
    const body = selectable(paper(a.body || '（这篇还没有正文）'), [
      { label: '设为范文', fn: (text) => exemplarModal(text, sourceLabel) },
      { label: '摘句', fn: (text) => guarded(async () => { await call('writing:quote-add', { text, source: sourceLabel, articleId: a.id }); toast('已存进摘句本，写作台起草时可以勾选带上'); }) },
    ]);
    reader.replaceChildren(
      h('div', { class: 'wr-reader-head' },
        h('h2', {}, a.exemplar ? h('span', { class: 'star', style: { color: '#e3b341' }, text: '★ ' }) : null, a.title),
        h('span', { class: 'wr-muted', text: [a.date, a.source, `${a.cjk} 字`, a.type].filter(Boolean).join(' · ') }),
        ...a.topics.map((t) => h('span', { class: 'wr-pill', text: t })),
        h('button', { class: 'wr-btn small', text: '改题材', onclick: () => topicModal(a) }),
        a.url ? h('button', { class: 'wr-btn small', text: '打开原文', onclick: () => require('electron').shell.openExternal(a.url) }) : null,
        h('span', { class: 'wr-muted', text: '选中一段文字 → 设为范文 / 摘句' })),
      body);
    if (!keepScroll) body.scrollTop = 0;
  }

  function topicModal(a) {
    const input = h('input', { class: 'wr-input', style: { width: '100%' }, value: a.topics.join('，') });
    modal('改题材', h('div', {}, h('div', { class: 'wr-muted', text: '用逗号分隔，最多 4 个。改过的题材重建索引也不会丢。' }), input), [
      { label: '取消' },
      { label: '保存', primary: true, onClick: () => guarded(async () => {
        const topics = input.value.split(/[，,、\s]+/).map((s) => s.trim()).filter(Boolean);
        await call('writing:library-set-topics', { id: a.id, topics });
        await loadLibrary();
      }) },
    ]);
  }

  function exemplarModal(text, source) {
    const group = h('select', { class: 'wr-select' }, ...GROUPS.map((g) => h('option', { value: g, text: g })));
    const why = h('input', { class: 'wr-input', style: { flex: 1 }, placeholder: '一句话：这段好在哪里（可以留空）' });
    modal('设为范文候选', h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
      h('div', { class: 'wr-quote-preview', text }),
      h('div', { class: 'wr-row' }, '分组', group, why),
      h('div', { class: 'wr-muted', text: `出处：${source}。候选先进「文风」页的候选区，你确认转正后才写进范文库。` })), [
      { label: '取消' },
      { label: '加入候选', primary: true, onClick: () => guarded(async () => {
        await call('writing:voice-candidate-add', { group: group.value, text, source, why: why.value });
        toast('已加入范文候选，到「文风」页转正');
      }) },
    ]);
  }

  /* ─────────────── 文风 ─────────────── */

  async function loadVoice() {
    await guarded(async () => {
      const r = await call('writing:voice-get');
      S.voice.data = r.voice;
      if (S.view === 'voice') renderVoice();
    });
  }

  function ratioChart(points) {
    const W = 300; const H = 140; const pad = 26;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('class', 'wr-chart');
    const mk = (tag, attrs) => { const n = document.createElementNS(svgNS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
    for (const v of [0, 30, 60]) {
      const y = H - pad - (v / 60) * (H - 2 * pad);
      svg.appendChild(mk('line', { x1: pad, x2: W - 8, y1: y, y2: y, stroke: 'currentColor', 'stroke-opacity': '.15' }));
      const t = mk('text', { x: 2, y: y + 4, 'font-size': '10', fill: 'currentColor', 'fill-opacity': '.6' }); t.textContent = `${v}%`; svg.appendChild(t);
    }
    const valid = points.filter((p) => typeof p.ratio === 'number');
    const step = valid.length > 1 ? (W - pad - 16) / (valid.length - 1) : 0;
    const xy = valid.map((p, i) => [pad + 6 + i * step, H - pad - (Math.min(p.ratio, 60) / 60) * (H - 2 * pad)]);
    if (xy.length > 1) svg.appendChild(mk('polyline', { points: xy.map((p) => p.join(',')).join(' '), fill: 'none', stroke: 'var(--brand)', 'stroke-width': '2' }));
    xy.forEach(([x, y], i) => {
      const c = mk('circle', { cx: x, cy: y, r: 4, fill: 'var(--brand)' });
      const title = document.createElementNS(svgNS, 'title'); title.textContent = `${valid[i].title}：改动 ${valid[i].ratio}%`; c.appendChild(title);
      svg.appendChild(c);
    });
    return svg;
  }

  function renderVoice() {
    const view = document.getElementById('wr-view-voice');
    const v = S.voice.data;
    if (!v) return;

    const rules = v.rules.map((r) => {
      const open = !!S.voice.open[r.n];
      const editing = S.voice.editing === r.n;
      const head = h('div', { class: 'wr-rule-head', onclick: () => { S.voice.open[r.n] = !open; renderVoice(); } },
        h('span', { class: 'n', text: r.n }), h('span', { class: 't', text: r.title }),
        h('span', { class: 'wr-pill ' + (r.status === 'confirmed' ? 'ok' : 'warn'), text: r.status === 'confirmed' ? '已确认' : '待确认' }));
      if (!open) return h('div', { class: 'wr-rule' }, head);
      const bodyText = r.raw.replace(/^\d+\.\s*/, '');
      if (editing) {
        const ta = h('textarea', { class: 'wr-textarea', rows: 5, value: bodyText });
        ta.value = bodyText;
        return h('div', { class: 'wr-rule' }, head, h('div', { class: 'wr-rule-body' }, ta, h('div', { class: 'wr-actions' },
          h('button', { class: 'wr-btn small primary', text: '保存改写', onclick: () => guarded(async () => { await call('writing:voice-rule', { n: r.n, action: 'rewrite', text: ta.value }); S.voice.editing = null; await loadVoice(); toast('已改写并写回 SKILL.md（改前已备份）'); }) }),
          h('button', { class: 'wr-btn small', text: '取消', onclick: () => { S.voice.editing = null; renderVoice(); } }))));
      }
      return h('div', { class: 'wr-rule' }, head, h('div', { class: 'wr-rule-body' }, renderMarkdown(h('div'), r.text), h('div', { class: 'wr-actions' },
        r.status !== 'confirmed' ? h('button', { class: 'wr-btn small primary', text: '确认', onclick: () => guarded(async () => { await call('writing:voice-rule', { n: r.n, action: 'confirm' }); await loadVoice(); }) }) : null,
        h('button', { class: 'wr-btn small', text: '改写', onclick: () => { S.voice.editing = r.n; renderVoice(); } }),
        h('button', { class: 'wr-btn small danger', text: '划掉', onclick: () => modal(`划掉第 ${r.n} 条「${r.title}」？`, h('div', { class: 'wr-muted', text: '会从 SKILL.md 删除这一条，后面的顺延编号。改前自动备份，可以用「回退上一步」恢复。' }), [
          { label: '取消' },
          { label: '划掉', danger: true, onClick: () => guarded(async () => { await call('writing:voice-rule', { n: r.n, action: 'strike' }); await loadVoice(); }) },
        ]) }))));
    });
    const confirmed = v.rules.filter((r) => r.status === 'confirmed').length;
    const left = h('div', { class: 'wr-card' },
      h('div', { class: 'wr-section-title' }, '画像与写法', h('span', { class: 'wr-muted', text: `已确认 ${confirmed} / ${v.rules.length}` }), h('span', { style: { flex: 1 } }),
        v.hasBackup ? h('button', { class: 'wr-btn small', text: '回退上一步', title: '把最近一次写回的 skill 文件恢复到改动前', onclick: () => guarded(async () => { const r = await call('writing:voice-undo'); toast(`已回退 ${r.file}`); await loadVoice(); }) }) : null),
      h('div', { class: 'wr-portrait', text: v.portrait || '（SKILL.md 里没有找到一句话画像）' }),
      ...rules);

    const groupKeys = Array.from(new Set([...v.groups.map((g) => g.key), ...v.candidates.map((c) => c.group)]));
    if (!groupKeys.includes(S.voice.group)) S.voice.group = groupKeys[0] || '开场';
    const g = v.groups.find((x) => x.key === S.voice.group) || { items: [], desc: '' };
    const cands = v.candidates.filter((c) => c.group === S.voice.group);
    const middle = h('div', { class: 'wr-card' },
      h('div', { class: 'wr-section-title' }, '范文库', v.candidates.length ? h('span', { class: 'wr-pill warn', text: `候选 ${v.candidates.length} 段待转正` }) : null),
      h('div', { class: 'wr-gtabs' }, ...groupKeys.map((k) => {
        const n = (v.groups.find((x) => x.key === k) || { items: [] }).items.length;
        const c = v.candidates.filter((x) => x.group === k).length;
        return h('button', { class: 'wr-gtab' + (k === S.voice.group ? ' on' : ''), text: `${k} ${n}${c ? ` +${c}` : ''}`, onclick: () => { S.voice.group = k; renderVoice(); } });
      })),
      g.desc ? h('div', { class: 'wr-muted', style: { marginBottom: '8px' }, text: g.desc }) : null,
      g.items.length > 5 ? h('div', { class: 'wr-pill warn', style: { marginBottom: '8px' }, text: `这一组已有 ${g.items.length} 段，超过 5 段时 AI 反而学不准，建议精简` }) : null,
      ...cands.map((c) => h('div', { class: 'wr-cand' },
        h('div', { class: 'wr-muted', text: `候选 · ${c.source}${c.why ? ` · ${c.why}` : ''}` }),
        paper(c.text),
        h('div', { class: 'wr-row', style: { display: 'flex', gap: '6px', marginTop: '6px' } },
          h('button', { class: 'wr-btn small primary', text: '转正', onclick: () => guarded(async () => { await call('writing:voice-candidate', { id: c.id, action: 'promote' }); await loadVoice(); toast('已写进 exemplars.md'); }) }),
          h('button', { class: 'wr-btn small', text: '放弃', onclick: () => guarded(async () => { await call('writing:voice-candidate', { id: c.id, action: 'dismiss' }); await loadVoice(); }) })))),
      ...g.items.map((it) => h('div', { class: 'wr-ex' }, paper(it.text), h('div', { class: 'src', text: it.source }))),
      !g.items.length && !cands.length ? h('div', { class: 'wr-empty', text: '这一组还没有范文。去作品库里选中好段落，点「设为范文」。' }) : null);

    const ratios = v.editRatios || [];
    const last3 = ratios.slice(-3).map((r) => r.ratio).filter((x) => typeof x === 'number');
    const plateau = last3.length === 3 && last3[2] >= last3[1] && last3[1] >= last3[0];
    const learnedList = (items) => items.length ? h('ul', { class: 'wr-learned' }, ...items.map((t) => h('li', { text: t }))) : h('div', { class: 'wr-muted', text: '（暂无）' });
    const right = h('div', { class: 'wr-card' },
      h('div', { class: 'wr-section-title', text: '改动比例' }),
      ratios.length ? ratioChart(ratios) : h('div', { class: 'wr-empty', text: '还没有定稿。每篇在写作台定稿后，这里多一个点：你改了 AI 稿的多少。' }),
      plateau ? h('div', { class: 'wr-pill warn', style: { whiteSpace: 'normal', margin: '6px 0' }, text: '连续三篇改动比例没有下降：提示词加范文可能到顶了，可以考虑用你的定稿微调模型。' }) : null,
      h('div', { class: 'wr-muted', style: { margin: '4px 0 14px' }, text: '连续三篇不再下降时，这里会提示考虑微调。' }),
      h('div', { class: 'wr-section-title', text: '从改稿学到的 · 已确认' }), learnedList(v.learned.confirmed),
      h('div', { class: 'wr-section-title', style: { marginTop: '12px' }, text: '从改稿学到的 · 观察中' }), learnedList(v.learned.observing),
      h('div', { class: 'wr-muted', style: { marginTop: '12px' }, text: `文件：${v.dir}` }));

    view.replaceChildren(left, middle, right);
  }

  /* ─────────────── 写作台 ─────────────── */

  async function loadStudio() {
    await guarded(async () => {
      if (!S.voice.data) { try { S.voice.data = (await call('writing:voice-get')).voice; } catch { /* 侧栏缺文风不致命 */ } }
      if (!S.studio.providers) {
        const r = await call('writing:providers');
        S.studio.providers = r.providers;
      }
      const s = await call('writing:series-list');
      S.studio.seriesList = s.series;
      if (!S.studio.series || !s.series.includes(S.studio.series)) S.studio.series = s.series[0];
      const p = await call('writing:piece-list', { series: S.studio.series });
      S.studio.pieces = p.pieces;
      if (S.studio.dir && !p.pieces.some((x) => x.dir === S.studio.dir)) S.studio.dir = null;
      if (!S.studio.dir && p.pieces[0]) S.studio.dir = p.pieces[0].dir;
      await reloadPiece();
    });
  }

  async function reloadPiece() {
    if (!S.studio.dir) { S.studio.piece = null; renderStudio(); return; }
    const r = await call('writing:piece-get', { dir: S.studio.dir });
    S.studio.piece = r.piece;
    S.studio.running = r.running || [];
    // 篇目下拉里的阶段名跟着刷新，不停在创建时的「访谈」
    const listed = S.studio.pieces.find((x) => x.dir === S.studio.dir);
    if (listed) { listed.stage = r.piece.meta.stage; listed.title = r.piece.meta.title; }
    if (!S.studio.viewStage || S.studio.viewStageFor !== S.studio.dir) { S.studio.viewStage = r.piece.meta.stage; S.studio.viewStageFor = S.studio.dir; }
    renderStudio();
  }

  function savePiece(patch) { return call('writing:piece-save', { dir: S.studio.dir, patch }); }

  function newPieceModal() {
    const title = h('input', { class: 'wr-input', style: { width: '100%' }, placeholder: '文章标题，比如：分身不是分集' });
    const series = h('select', { class: 'wr-select' }, ...S.studio.seriesList.map((x) => h('option', { value: x, text: x, selected: x === S.studio.series })), h('option', { value: '__new', text: '＋ 新系列…' }));
    const newSeries = h('input', { class: 'wr-input', placeholder: '新系列名', style: { display: 'none' } });
    series.addEventListener('change', () => { newSeries.style.display = series.value === '__new' ? '' : 'none'; });
    modal('新文章', h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, title, h('div', { class: 'wr-row' }, '系列', series, newSeries)), [
      { label: '取消' },
      { label: '创建', primary: true, onClick: () => guarded(async () => {
        const s = series.value === '__new' ? newSeries.value.trim() : series.value;
        const r = await call('writing:piece-create', { series: s, title: title.value });
        S.studio.series = r.meta.series; S.studio.dir = r.dir; S.studio.viewStage = 'interview'; S.studio.viewStageFor = r.dir;
        await loadStudio();
      }) },
    ]);
  }

  function renderStudio() {
    const view = document.getElementById('wr-view-studio');
    if (!view) return;
    const st = S.studio;
    const bar = h('div', { class: 'wr-studio-bar' },
      '系列', h('select', { class: 'wr-select', onchange: (e) => { st.series = e.target.value; st.dir = null; loadStudio(); } },
        ...st.seriesList.map((x) => h('option', { value: x, text: x, selected: x === st.series }))),
      '篇目', h('select', { class: 'wr-select', style: { minWidth: '220px' }, onchange: (e) => { st.dir = e.target.value; reloadPiece().catch((err) => toast(err.message, true)); } },
        ...(st.pieces.length ? st.pieces.map((p) => h('option', { value: p.dir, text: `${p.title} · ${STAGE_LABEL[p.stage] || p.stage}`, selected: p.dir === st.dir })) : [h('option', { text: '（这个系列还没有文章）' })])),
      h('button', { class: 'wr-btn primary', text: '＋ 新文章', onclick: newPieceModal }),
      st.dir ? h('button', { class: 'wr-btn small', text: '打开文件夹', onclick: () => call('writing:open-path', { dir: st.dir }) }) : null);
    if (!st.piece) {
      view.replaceChildren(bar, h('div', { class: 'wr-empty' }, '先新建一篇文章。流程：访谈 → 起草 → 盲选 → 审阅 → 定稿 → 回流。'));
      return;
    }
    const meta = st.piece.meta;
    const reached = STAGES.indexOf(meta.stage);
    const steps = h('div', { class: 'wr-steps' }, ...STAGES.map((s, i) => h('div', {
      class: 'wr-step' + (i < reached ? ' done' : '') + (i === reached ? ' cur' : '') + (s === st.viewStage ? ' view' : ''),
      onclick: () => { if (i > reached) { toast('先完成前面的步骤'); return; } st.viewStage = s; renderStudio(); },
    }, h('span', { class: 'dot', text: i < reached ? '✓' : String(i + 1) }), STAGE_LABEL[s], i < STAGES.length - 1 ? h('span', { class: 'line' }) : null)));
    const stage = h('div', { class: 'wr-stage' });
    const renderers = { interview: stageInterview, draft: stageDraft, blind: stageBlind, review: stageReview, final: stageFinal, reflow: stageReflow };
    (renderers[st.viewStage] || stageInterview)(stage, meta);
    view.replaceChildren(bar, steps, h('div', { class: 'wr-studio-main' }, stage, sidePanel()));
    syncTicker();
  }

  function sidePanel() {
    const v = S.voice.data;
    if (!v) return h('div', { class: 'wr-side wr-card' }, h('div', { class: 'wr-muted', text: '文风未加载' }));
    const ex = [];
    for (const g of v.groups) { if (g.items[0] && ex.length < 2 && ['开场', '收束'].includes(g.key)) ex.push({ g: g.key, it: g.items[0] }); }
    return h('div', { class: 'wr-side wr-card' },
      h('div', { class: 'wr-section-title', text: '田哥文风' }),
      h('div', { style: { fontWeight: 600, color: 'var(--fg-strong)', lineHeight: 1.6 }, text: v.portrait }),
      h('ol', {}, ...v.rules.map((r) => h('li', { text: r.title }))),
      ...ex.map(({ g, it }) => h('div', { style: { marginTop: '8px' } }, h('div', { class: 'wr-muted', text: `范文 · ${g}` }), paper(it.text))));
  }

  /* ── ① 访谈 ── */
  function stageInterview(box, meta) {
    const b = { ...meta.brief };
    const field = (key, label, multiline, placeholder) => {
      const input = multiline
        ? h('textarea', { class: 'wr-textarea', rows: key === 'notes' ? 8 : 2, placeholder })
        : h('input', { class: 'wr-input', placeholder });
      input.value = b[key] || '';
      input.addEventListener('input', () => { b[key] = input.value; });
      return [h('label', { text: label }), input];
    };
    const qa = (meta.qa || []).map((x) => ({ ...x }));
    const qaBox = h('div', { class: 'wr-qa' });
    const drawQa = () => qaBox.replaceChildren(...(qa.length ? qa.map((x, i) => {
      const ta = h('textarea', { class: 'wr-textarea', rows: 3, placeholder: '你的回答，口语化也行' });
      ta.value = x.a || '';
      ta.addEventListener('input', () => { qa[i].a = ta.value; });
      return h('div', {}, h('div', { class: 'q', text: `问：${x.q}` }), ta);
    }) : [h('div', { class: 'wr-muted', text: '可以让 AI 先问你几个问题，把只有你才有的经历、判断和例子挖出来。' })]));
    drawQa();
    const pickedQuotes = new Set((meta.quotes || []).map((q) => q.id));
    const quoteBox = h('div', { class: 'wr-qa' });
    call('writing:quotes-list').then((r) => {
      S.studio.quotes = r.quotes;
      quoteBox.replaceChildren(...(r.quotes.length ? r.quotes.slice(0, 30).map((q) => h('label', { style: { display: 'flex', gap: '8px', fontSize: '12.5px' } },
        h('input', { type: 'checkbox', checked: pickedQuotes.has(q.id), onchange: (e) => { if (e.target.checked) pickedQuotes.add(q.id); else pickedQuotes.delete(q.id); } }),
        h('span', {}, q.text, h('span', { class: 'wr-muted', text: ` —— ${q.source}` })))) : [h('div', { class: 'wr-muted', text: '摘句本是空的。在作品库里选中句子点「摘句」。' })]));
    }).catch(() => {});
    const save = async (next) => {
      const quotes = (S.studio.quotes || []).filter((q) => pickedQuotes.has(q.id));
      const patch = { brief: b, qa, quotes };
      if (next && meta.stage === 'interview') patch.stage = 'draft';
      await savePiece(patch);
      if (next) S.studio.viewStage = 'draft';
      await reloadPiece();
      toast(next ? '已保存，去起草' : '已保存');
    };
    add(box, 
      h('div', { class: 'wr-card' }, h('div', { class: 'wr-section-title', text: 'Brief' }), h('div', { class: 'wr-form' },
        ...field('reader', '读者是谁', false, '比如：懂 AI、不懂无线的算法专家'),
        ...field('question', '要回答的主问题', true, '这一节要让读者想通哪件事'),
        ...field('thesis', '一句话核心判断', true, '你的结论，一句话'),
        ...field('section', '这次写哪一节', false, '留空表示整篇'),
        ...field('length', '目标字数', false, '1500-2500'),
        ...field('notes', '要点与素材', true, '想到什么写什么：经历、例子、数字、论文、你不同意的说法'))),
      h('div', { class: 'wr-card' }, h('div', { class: 'wr-section-title' }, '访谈', h('button', { class: 'wr-btn small', text: '让 AI 提几个问题', onclick: (e) => guarded(async () => {
        e.target.disabled = true; e.target.textContent = '正在想问题…';
        await savePiece({ brief: b, qa });
        const r = await call('writing:interview-questions', { dir: S.studio.dir });
        qa.splice(0, qa.length, ...r.qa); drawQa();
        e.target.disabled = false; e.target.textContent = '再问几个';
      }) })), qaBox),
      h('div', { class: 'wr-card' }, h('div', { class: 'wr-section-title', text: '带上摘句（可选）' }), quoteBox),
      h('div', { class: 'wr-row', style: { display: 'flex', gap: '8px' } },
        h('button', { class: 'wr-btn', text: '保存', onclick: () => guarded(() => save(false)) }),
        h('button', { class: 'wr-btn primary', text: '保存并去起草 →', onclick: () => guarded(() => save(true)) })));
  }

  /* ── ② 起草 ── */
  function currentRound(meta) { return (meta.blind && meta.blind.round) || (meta.drafts || []).reduce((m, d) => Math.max(m, d.round || 0), 0); }

  function stageDraft(box, meta) {
    const st = S.studio;
    const round = currentRound(meta);
    const mine = (meta.drafts || []).filter((d) => d.round === round).sort((a, b) => a.label.localeCompare(b.label));
    const running = mine.some((d) => d.status === 'running');
    const chosen = new Set(st.providers.filter((p) => p.available && ['claude', 'codex', 'deepseek'].includes(p.id)).map((p) => p.id));
    const providers = h('div', { class: 'wr-providers' }, ...st.providers.map((p) => h('label', { style: p.available ? {} : { opacity: .55 } },
      h('input', { type: 'checkbox', disabled: !p.available || running, checked: p.available && chosen.has(p.id), onchange: (e) => { if (e.target.checked) chosen.add(p.id); else chosen.delete(p.id); } }),
      h('b', { text: p.label }), p.model ? h('span', { class: 'wr-muted', text: `${p.model}${p.effort ? ` · ${p.effort}` : ''}` }) : null,
      !p.available ? h('span', { class: 'wr-muted', text: `（${p.reason}）` }) : null)));
    const cards = mine.map((d) => {
      const prog = st.progress[d.id];
      let status;
      if (d.status === 'running') {
        const sec = Math.round((Date.now() - new Date(d.startedAt)) / 1000);
        status = h('span', { class: 'wr-pill brand', 'data-started': d.startedAt, 'data-id': d.id, text: `写作中 · ${sec} 秒${prog && prog.chars ? ` · 已写约 ${prog.chars} 字` : ''}` });
      } else if (d.status === 'done') status = h('span', { class: 'wr-pill ok', text: `完成 · ${cjk(d.text)} 字` });
      else status = h('span', { class: 'wr-pill bad', text: '失败' });
      return h('div', { class: 'wr-card' }, h('div', { class: 'wr-draft-head' }, h('b', { text: `稿 ${d.label}` }), status),
        d.status === 'failed' ? h('div', { class: 'wr-muted', style: { marginTop: '6px', whiteSpace: 'pre-wrap' }, text: d.error || '' }) : null);
    });
    add(box, 
      h('div', { class: 'wr-card' },
        h('div', { class: 'wr-section-title', text: '选择起草的模型' }), providers,
        h('div', { class: 'wr-muted', style: { margin: '10px 0' }, text: '每份稿随机分到一种切入方式：从场景起笔、从问题起笔、从反直觉起笔。起草时只带起草指南、你的文风和范文，不带工程规则和工具；盲选时看不到是哪家写的。Codex 只用订阅登录。' }),
        h('div', { class: 'wr-row', style: { display: 'flex', gap: '8px' } },
          h('button', { class: 'wr-btn primary', disabled: running, text: mine.length ? '重新起草一轮' : '开始起草', onclick: () => guarded(async () => {
            if (!chosen.size) { toast('至少选一个模型', true); return; }
            await call('writing:draft-start', { dir: st.dir, providers: Array.from(chosen) });
            await reloadPiece();
          }) }),
          running ? h('button', { class: 'wr-btn danger', text: '取消', onclick: () => guarded(async () => { await call('writing:draft-cancel', { dir: st.dir }); }) }) : null,
          !running && mine.some((d) => d.status === 'done') ? h('button', { class: 'wr-btn', text: '去盲选 →', onclick: () => { st.viewStage = 'blind'; renderStudio(); } }) : null)),
      mine.length ? h('div', { class: 'wr-drafts three' }, ...cards) : h('div', { class: 'wr-muted', text: '还没有草稿。' }));
  }

  function syncTicker() {
    const needs = S.opened && S.view === 'studio' && S.studio.viewStage === 'draft' && S.studio.piece && S.studio.piece.meta.drafts.some((d) => d.status === 'running');
    if (needs && !tickTimer) {
      tickTimer = setInterval(() => {
        document.querySelectorAll('#wr-view-studio [data-started]').forEach((el) => {
          const sec = Math.round((Date.now() - new Date(el.dataset.started)) / 1000);
          const prog = S.studio.progress[el.dataset.id];
          el.textContent = `写作中 · ${sec} 秒${prog && prog.chars ? ` · 已写约 ${prog.chars} 字` : ''}`;
        });
      }, 1000);
    } else if (!needs && tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  /* ── ③ 盲选 ── */
  function winnerOf(meta) {
    const b = meta.blind || {};
    if (b.winner === 'stitched') return { id: 'stitched', label: '拼接稿', text: b.stitched || '' };
    const d = (meta.drafts || []).find((x) => x.id === b.winner);
    return d ? { id: d.id, label: `稿 ${d.label}`, text: d.text, provider: d.provider } : null;
  }

  function stageBlind(box, meta) {
    const st = S.studio;
    const round = currentRound(meta);
    const drafts = (meta.drafts || []).filter((d) => d.round === round && d.status === 'done').sort((a, b) => a.label.localeCompare(b.label));
    const blind = JSON.parse(JSON.stringify(meta.blind || {}));
    blind.scores = blind.scores || {}; blind.marks = blind.marks || {}; blind.picks = blind.picks || {};
    if (!drafts.length) { add(box, h('div', { class: 'wr-empty', text: '这一轮还没有完成的草稿。' })); return; }
    const persist = async (rerender = true) => { await savePiece({ blind }); st.piece.meta.blind = blind; if (rerender) renderStudio(); };
    const layout = blind.layout || 'three';
    if (layout === 'two' && st.twoPick.length !== 2) st.twoPick = drafts.slice(0, 2).map((d) => d.id);
    const shown = layout === 'two' ? drafts.filter((d) => st.twoPick.includes(d.id)) : drafts;

    const toolbar = h('div', { class: 'wr-toolbar' },
      h('button', { class: 'wr-btn small' + (layout === 'three' ? ' primary' : ''), text: '全部并排', onclick: () => { blind.layout = 'three'; persist(); } }),
      h('button', { class: 'wr-btn small' + (layout === 'two' ? ' primary' : ''), text: '两份对比', onclick: () => { blind.layout = 'two'; persist(); } }),
      layout === 'two' ? [0, 1].map((slot) => h('select', { class: 'wr-select', onchange: (e) => { st.twoPick[slot] = e.target.value; renderStudio(); } },
        ...drafts.map((d) => h('option', { value: d.id, text: `稿 ${d.label}`, selected: st.twoPick[slot] === d.id })))) : null,
      h('button', { class: 'wr-btn small' + (st.stitch ? ' primary' : ''), text: st.stitch ? '退出拼接' : '拼接模式', title: '从几份稿里各勾几段，拼成一份', onclick: () => { st.stitch = !st.stitch; renderStudio(); } }),
      h('span', { style: { flex: 1 } }),
      blind.winner ? h('span', { class: 'wr-pill ok', text: `已选：${(winnerOf({ ...meta, blind }) || {}).label || ''}` }) : h('span', { class: 'wr-muted', text: '读完后给每份打分，选一份（或拼一份）' }),
      h('button', { class: 'wr-btn small', disabled: !blind.winner, text: blind.revealed ? '已揭晓' : '揭晓作者', onclick: () => { blind.revealed = true; persist(); } }),
      h('button', { class: 'wr-btn primary', disabled: !blind.winner, text: '下一步：审阅 →', onclick: () => guarded(async () => {
        await savePiece({ blind, stage: STAGES.indexOf(meta.stage) < STAGES.indexOf('review') ? 'review' : meta.stage });
        st.viewStage = 'review'; await reloadPiece();
      }) }));

    const cards = shown.map((d) => {
      const isWinner = blind.winner === d.id;
      const paras = String(d.text || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
      const sel = st.stitchSel[d.id] || (st.stitchSel[d.id] = new Set());
      const body = st.stitch
        ? h('div', { class: 'wr-paper' }, ...paras.map((p, i) => h('div', { class: 'wr-para-pick' },
          h('input', { type: 'checkbox', checked: sel.has(i), onchange: (e) => { if (e.target.checked) sel.add(i); else sel.delete(i); } }),
          renderMarkdown(h('div', { style: { flex: 1 } }), p))))
        : selectable(paper(d.text), [
          { label: '好句', fn: (text) => { (blind.marks[d.id] = blind.marks[d.id] || []).push({ type: 'good', text }); persist(); } },
          { label: '坏句', fn: (text) => { (blind.marks[d.id] = blind.marks[d.id] || []).push({ type: 'bad', text }); persist(); } },
        ]);
      const score = blind.scores[d.id] || 0;
      const marks = blind.marks[d.id] || [];
      return h('div', { class: 'wr-draft' + (isWinner ? ' winner' : '') },
        h('div', { class: 'wr-draft-head' }, h('b', { text: `稿 ${d.label}` }), h('span', { class: 'wr-muted', text: `${cjk(d.text)} 字` }), isWinner ? h('span', { class: 'wr-pill ok', text: '已选' }) : null),
        blind.revealed ? h('div', { class: 'wr-reveal', text: `${d.provider} · ${d.model || ''} · ${d.angle ? d.angle.label : ''}${d.inputTokens ? ` · 输入 ${d.inputTokens} token` : ''}${d.clean && d.clean.tools != null ? ` · 工具 ${d.clean.tools} / MCP ${d.clean.mcp} / skill ${d.clean.skills}` : ''}${d.clean && d.clean.auth ? ` · 订阅登录（${d.clean.profile}）` : ''}` }) : null,
        body,
        h('div', { class: 'wr-draft-foot' },
          h('div', { class: 'wr-row', style: { display: 'flex', gap: '8px', alignItems: 'center' } }, '评分', h('div', { class: 'wr-stars' }, ...[1, 2, 3, 4, 5].map((n) => h('button', { class: n <= score ? 'on' : '', text: '★', onclick: () => { blind.scores[d.id] = n; persist(); } })))),
          h('div', { class: 'wr-row', style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } }, '能署我的名吗', ...SIGN_OPTIONS.map(([k, label]) => h('label', {},
            h('input', { type: 'radio', name: `sign-${d.id}`, checked: blind.picks[d.id] === k, onchange: () => { blind.picks[d.id] = k; persist(false); } }), label))),
          marks.length ? h('ul', { class: 'wr-marks' }, ...marks.map((m, i) => h('li', { class: m.type }, `${m.type === 'good' ? '好句' : '坏句'}：${m.text} `,
            h('button', { class: 'wr-btn small', text: '删', onclick: () => { marks.splice(i, 1); persist(); } })))) : h('div', { class: 'wr-muted', text: '选中正文里的句子，标成好句或坏句' }),
          h('button', { class: 'wr-btn' + (isWinner ? '' : ' primary'), text: isWinner ? '已选这份' : '选这份', onclick: () => { blind.winner = d.id; blind.stitched = null; persist(); } })));
    });

    const stitchBar = st.stitch ? h('div', { class: 'wr-card' }, h('div', { class: 'wr-muted', text: '勾选想要的段落，按「稿 A、稿 B、稿 C」的顺序、各自段落的先后拼起来。接缝处定稿时再顺一顺。' }),
      h('button', { class: 'wr-btn primary', style: { marginTop: '8px' }, text: '用勾选的段落拼成一份', onclick: () => {
        const parts = [];
        for (const d of drafts) {
          const paras = String(d.text || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
          const sel = st.stitchSel[d.id] || new Set();
          for (const i of Array.from(sel).sort((a, b) => a - b)) parts.push(paras[i]);
        }
        if (!parts.length) { toast('还没有勾选段落', true); return; }
        blind.stitched = parts.join('\n\n'); blind.winner = 'stitched'; st.stitch = false; persist();
      } })) : null;
    const stitched = blind.stitched ? h('div', { class: 'wr-draft winner' }, h('div', { class: 'wr-draft-head' }, h('b', { text: '拼接稿' }), blind.winner === 'stitched' ? h('span', { class: 'wr-pill ok', text: '已选' }) : null), paper(blind.stitched)) : null;
    add(box, toolbar, stitchBar, h('div', { class: 'wr-drafts ' + (layout === 'two' ? 'two' : 'three') }, ...cards), stitched);
  }

  /* ── ④ 审阅 ── */
  function stageReview(box, meta) {
    const st = S.studio;
    const win = winnerOf(meta);
    if (!win) { add(box, h('div', { class: 'wr-empty', text: '先在盲选里选出一份。' })); return; }
    const review = JSON.parse(JSON.stringify(meta.review || { items: [] }));
    const avail = st.providers.filter((p) => p.available && ['claude', 'codex', 'deepseek'].includes(p.id));
    const pick = h('select', { class: 'wr-select' }, h('option', { value: '', text: '自动（换一家，不用胜出稿的作者）' }), ...avail.map((p) => h('option', { value: p.id, text: p.label })));
    const running = review.status === 'running';
    const items = (review.items || []).map((it, i) => h('div', { class: 'wr-ritem' + (it.status === 'adopted' ? ' adopted' : it.status === 'ignored' ? ' ignored' : '') },
      h('div', {}, h('span', { class: 'wr-pill ' + (it.level === '必改' ? 'bad' : it.level === '建议' ? 'warn' : ''), text: it.level || '批注' }), ' ', h('span', { class: 'wr-pill', text: it.category || '' }), ' ', h('span', { class: 'a', text: `「${it.anchor || ''}」` })),
      h('div', {}, h('b', { text: '问题：' }), it.problem || ''),
      it.basis ? h('div', {}, h('b', { text: '依据：' }), it.basis) : null,
      it.suggestion ? h('div', {}, h('b', { text: '建议：' }), it.suggestion) : null,
      h('div', { style: { display: 'flex', gap: '6px', marginTop: '4px' } },
        h('button', { class: 'wr-btn small' + (it.status === 'adopted' ? ' primary' : ''), text: '采纳', onclick: () => guarded(async () => { review.items[i].status = 'adopted'; await savePiece({ review }); await reloadPiece(); }) }),
        h('button', { class: 'wr-btn small', text: '忽略', onclick: () => guarded(async () => { review.items[i].status = 'ignored'; await savePiece({ review }); await reloadPiece(); }) }))));
    add(box, 
      h('div', { class: 'wr-toolbar' }, '审阅模型', pick,
        h('button', { class: 'wr-btn primary', disabled: running, text: running ? '审阅中…' : (review.items && review.items.length ? '重新审阅' : '开始审阅'), onclick: () => guarded(async () => { await call('writing:review-start', { dir: st.dir, provider: pick.value || undefined }); await reloadPiece(); }) }),
        review.provider ? h('span', { class: 'wr-muted', text: `审阅：${review.provider}${review.status === 'failed' ? ' · 失败' : ''}` }) : null,
        h('span', { style: { flex: 1 } }),
        h('button', { class: 'wr-btn primary', text: '下一步：定稿 →', onclick: () => guarded(async () => {
          if (STAGES.indexOf(meta.stage) < STAGES.indexOf('final')) await savePiece({ stage: 'final' });
          st.viewStage = 'final'; await reloadPiece();
        }) })),
      review.error ? h('div', { class: 'wr-pill bad', style: { whiteSpace: 'normal' }, text: review.error }) : null,
      h('div', { class: 'wr-review' },
        h('div', {}, h('div', { class: 'wr-section-title', text: `胜出稿（${win.label}）` }), paper(win.text)),
        h('div', {}, h('div', { class: 'wr-section-title', text: '批注' }), ...(items.length ? items : [h('div', { class: 'wr-muted', text: running ? '审阅模型正在读稿，通常一两分钟…' : '审阅只出批注，不改正文。你逐条采纳或忽略，采纳的会列进定稿的待办。' })]))));
  }

  /* ── ⑤ 定稿：内置 Markdown 编辑器 ── */
  function stageFinal(box, meta) {
    const st = S.studio;
    const ta = h('textarea', { spellcheck: 'false' });
    const preview = h('div', { class: 'wr-paper' });
    const count = h('span', { class: 'wr-muted' });
    const saved = h('span', { class: 'wr-muted' });
    let timer = null;
    const refresh = () => { renderMarkdown(preview, ta.value); count.textContent = `${cjk(ta.value)} 字`; };
    ta.addEventListener('input', () => { st.finalDirty = true; saved.textContent = '未保存'; clearTimeout(timer); timer = setTimeout(refresh, 250); });
    const save = async () => { await call('writing:final-save', { dir: st.dir, text: ta.value }); st.finalDirty = false; saved.textContent = `已保存 ${new Date().toLocaleTimeString()}`; };
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); guarded(save); }
      if (e.key === 'Tab') { e.preventDefault(); insert('  ', ''); }
    });
    function insert(before, after, placeholder = '') {
      const s = ta.selectionStart; const e = ta.selectionEnd;
      const sel = ta.value.slice(s, e) || placeholder;
      ta.setRangeText(before + sel + after, s, e, 'end');
      if (!ta.value.slice(s, e)) ta.setSelectionRange(s + before.length, s + before.length + sel.length);
      ta.focus(); ta.dispatchEvent(new Event('input'));
    }
    function linePrefix(prefix) {
      const s = ta.selectionStart; const lineStart = ta.value.lastIndexOf('\n', s - 1) + 1;
      ta.setRangeText(prefix, lineStart, lineStart, 'end'); ta.focus(); ta.dispatchEvent(new Event('input'));
    }
    const adopted = ((meta.review || {}).items || []).filter((x) => x.status === 'adopted');
    const toolbar = h('div', { class: 'wr-toolbar' },
      h('button', { class: 'wr-btn small', text: '粗体', onclick: () => insert('**', '**', '粗体') }),
      h('button', { class: 'wr-btn small', text: '小标题', onclick: () => linePrefix('## ') }),
      h('button', { class: 'wr-btn small', text: '引用', onclick: () => linePrefix('> ') }),
      h('button', { class: 'wr-btn small', text: '列表', onclick: () => linePrefix('- ') }),
      h('button', { class: 'wr-btn small', text: '行内公式', onclick: () => insert('$', '$', 'x') }),
      h('button', { class: 'wr-btn small', text: '公式块', onclick: () => insert('\n$$\n', '\n$$\n', 'x') }),
      h('button', { class: 'wr-btn small', text: '链接', onclick: () => insert('[', '](https://)', '文字') }),
      count, saved, h('span', { style: { flex: 1 } }),
      h('button', { class: 'wr-btn', text: '保存（Ctrl+S）', onclick: () => guarded(save) }),
      h('button', { class: 'wr-btn', text: '用外部编辑器打开', onclick: () => guarded(async () => { await save(); await call('writing:open-path', { dir: st.dir, rel: 'final.md' }); toast('在外部改完保存后，回来点「从文件重新载入」'); }) }),
      h('button', { class: 'wr-btn', text: '从文件重新载入', onclick: () => guarded(async () => { const r = await call('writing:final-load', { dir: st.dir }); ta.value = r.text; refresh(); st.finalDirty = false; saved.textContent = '已载入'; }) }),
      h('button', { class: 'wr-btn primary', text: '定稿并回流 →', onclick: () => guarded(async () => {
        await save();
        const r = await call('writing:finalize', { dir: st.dir });
        toast(`已定稿。这篇你改了 AI 稿的 ${r.ratio == null ? '?' : r.ratio}%`);
        st.viewStage = 'reflow'; S.voice.data = null; await reloadPiece(); loadVoice();
      }) }));
    add(box, 
      h('div', { class: 'wr-muted', text: '开头、情绪转折、判断句、结尾这四处，最好亲手改成你会说的样子。改完点「定稿并回流」，改动会进入文风页。' }),
      adopted.length ? h('div', { class: 'wr-card' }, h('div', { class: 'wr-section-title', text: `采纳的批注（${adopted.length}）` }),
        h('ul', { class: 'wr-learned' }, ...adopted.map((x) => h('li', { text: `「${x.anchor || ''}」 ${x.problem}${x.suggestion ? ` → ${x.suggestion}` : ''}` })))) : null,
      toolbar,
      h('div', { class: 'wr-editor' }, ta, preview));
    guarded(async () => {
      const r = await call('writing:final-load', { dir: st.dir });
      ta.value = r.text; refresh();
      saved.textContent = r.fromWinner ? '从胜出稿开始改（尚未保存）' : '已载入上次保存的定稿';
    });
  }

  /* ── ⑥ 回流 ── */
  function stageReflow(box, meta) {
    const st = S.studio;
    const ratio = meta.reflow && meta.reflow.ratio;
    const diffBox = h('div', { class: 'wr-paper' }, '加载改动对比…');
    add(box, 
      h('div', { class: 'wr-card' },
        h('div', { class: 'wr-section-title', text: '这篇你改了 AI 稿的' }),
        h('div', { class: 'wr-ratio', text: ratio == null ? '—' : `${ratio}%` }),
        h('div', { class: 'wr-muted', text: '这个数已经记进「文风」页的改动比例曲线。定稿也已收进作品库（来源：新作）。下面是逐处改动，可以拿来归纳“我总是这样改”，同一类改动在不同文章里出现两三次，就值得写进文风规则。' }),
        h('div', { class: 'wr-toolbar', style: { marginTop: '10px' } },
          h('button', { class: 'wr-btn', text: '去文风页', onclick: () => switchView('voice') }),
          h('button', { class: 'wr-btn', text: '在作品库里看这篇', onclick: () => { S.lib.filters.query = meta.title; switchView('library'); } }),
          h('button', { class: 'wr-btn', text: '回到定稿继续改', onclick: () => { st.viewStage = 'final'; renderStudio(); } }))),
      diffBox);
    call('writing:piece-file', { dir: st.dir, rel: 'diff.md' }).then((r) => renderMarkdown(diffBox, r.text || '（还没有改动对比）')).catch((e) => { diffBox.textContent = e.message; });
  }

  /* ─────────────── 事件与显隐 ─────────────── */

  ipcRenderer.on('writing-event', (_e, p) => {
    if (!p || !S.opened) return;
    if (p.type === 'draft-progress') { S.studio.progress[p.id] = { chars: p.chars, events: p.events }; return; }
    if (p.type === 'piece-updated' && p.dir === S.studio.dir && S.view === 'studio') {
      if (S.studio.viewStage === 'final' && S.studio.finalDirty) return; // 正在改定稿，不打断
      reloadPiece().catch(() => {});
    }
  });

  function setPanelVisible(visible) {
    buildSkeleton();
    if (!root) return;
    S.opened = visible;
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
    } else {
      selbar.classList.remove('show');
      syncTicker();
    }
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
