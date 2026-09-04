'use strict';
/**
 * 学习面板（study-panel）—— Hub 第四主区视图，与 terminal-panel /
 * meeting-room-panel / chuxin-panel 平级。
 *
 * 2026-09-02 改版：从「材料阅读器 + Agent 对话」改成**学习现状全景仪表盘**。
 *
 * 为什么删掉那两块（都是实测结论，不是精简取舍）：
 *
 *   1) 对话栏做不好。Claude Code / Codex 都是全屏 alt-screen 程序，PTY 环形缓冲里
 *      存的是光标定位指令，剥掉 ANSI 之后是错位重复的碎片——实测面板里显示成了
 *      连续八行「Checking for updates…337.2k tokens」。真会话视图用 xterm 重放
 *      这些指令才正确。两个教练本来就在左侧会话列表里，点开就是完整界面。
 *
 *   2) 阅读器是重复造轮子。学习卡是自包含 HTML，Hub 已有的预览面板
 *      （window.openPreviewPanel）自带查找、大纲、外开、文件监听，比塞进 iframe 强。
 *
 * 所以这里只回答三个问题：今天出了没有 / 我走到哪了 / 有什么等着我做。
 * 材料和教练都只给**跳转入口**，不在这里复刻。
 */
(function () {
  const { ipcRenderer } = require('electron');

  const STAGE_LABEL = { draft: '初稿', review: '审阅配图', finalize: '定稿' };
  const ROLE_TITLE = { author: '主笔 · Claude', reviewer: '审阅与插画 · Codex' };
  const RECENT_LIMIT = 6;

  let root = null;
  let refreshTimer = null;
  const state = { opened: false, last: null };

  /* ─────────────── 工具 ─────────────── */

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function fmtKB(bytes) {
    const kb = Number(bytes || 0) / 1024;
    return kb >= 1024 ? (kb / 1024).toFixed(1) + 'MB' : Math.round(kb) + 'KB';
  }
  function durationText(run) {
    if (!run || !run.startedAt || !run.finishedAt) return '';
    const ms = new Date(run.finishedAt) - new Date(run.startedAt);
    if (!(ms > 0)) return '';
    const min = Math.round(ms / 60000);
    return min >= 60 ? `${Math.floor(min / 60)} 小时 ${min % 60} 分` : `${min} 分钟`;
  }
  function hhmm(iso) {
    if (!iso) return '';
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(iso));
    } catch { return ''; }
  }

  /* ─────────────── 骨架 ─────────────── */

  function buildSkeleton() {
    root = document.getElementById('study-panel');
    if (!root || root.dataset.built === '1') return;
    root.dataset.built = '1';
    root.innerHTML = '';

    const head = el('div', 'study-head');
    const tw = el('div');
    tw.appendChild(el('div', 'st-title', '学习'));
    const sub = el('div', 'st-sub', ''); sub.id = 'study-sub';
    tw.appendChild(sub);
    head.appendChild(tw);
    head.appendChild(el('div', 'st-spacer'));

    const status = el('span', 'study-pill', '—'); status.id = 'study-status';
    head.appendChild(status);

    const openCoach = el('button', 'study-btn', '打开教练会话');
    openCoach.id = 'study-open-coach';
    openCoach.addEventListener('click', () => openAgent('author'));
    head.appendChild(openCoach);

    const runBtn = el('button', 'study-btn primary', '立即生成');
    runBtn.id = 'study-run';
    runBtn.addEventListener('click', runNow);
    head.appendChild(runBtn);
    root.appendChild(head);

    const body = el('div', 'study-body');
    const tiles = el('div', 'study-tiles'); tiles.id = 'study-tiles';
    body.appendChild(tiles);

    const cols = el('div', 'study-cols');
    const left = el('div', 'study-panel-box');
    left.appendChild(el('h5', null, '最近课程'));
    const list = el('div', 'study-lessons'); list.id = 'study-lessons';
    left.appendChild(list);
    cols.appendChild(left);

    const right = el('div');
    const todayBox = el('div', 'study-panel-box'); todayBox.id = 'study-today';
    right.appendChild(todayBox);
    const coachBox = el('div', 'study-panel-box'); coachBox.id = 'study-coaches';
    right.appendChild(coachBox);
    cols.appendChild(right);

    body.appendChild(cols);
    root.appendChild(body);
  }

  /* ─────────────── 渲染 ─────────────── */

  async function refresh() {
    if (!state.opened) return;
    let s;
    try { s = await ipcRenderer.invoke('study:state'); }
    catch { setStatus('bad', '读取状态失败'); return; }
    if (!s || !s.ok) { setStatus('bad', '状态不可用'); return; }
    state.last = s;
    renderHead(s);
    renderTiles(s);
    renderLessons(s);
    renderToday(s);
    renderCoaches(s);
  }

  function setStatus(kind, text) {
    const n = document.getElementById('study-status');
    if (!n) return;
    n.className = 'study-pill' + (kind ? ' ' + kind : '');
    n.textContent = text;
  }

  function todayRun(s) {
    return (s.runs || []).find((r) => r.date === s.todayDate) || null;
  }

  function renderHead(s) {
    const sub = document.getElementById('study-sub');
    if (sub) {
      const done = s.lessons.length;
      const total = s.planTotal || 20;
      sub.textContent = `${s.todayDate} · 已完成 ${done} / ${total}`
        + (s.nextLessonId ? ` · 下一课 ${s.nextLessonId}` : ' · 课表已全部完成');
    }
    const run = todayRun(s);
    if (s.running && s.currentRun) setStatus('run', `生成中 · ${STAGE_LABEL[s.currentRun.stage] || s.currentRun.stage}`);
    else if (run && run.status === 'done') setStatus('ok', '今日已完成');
    else if (run && run.status === 'failed') setStatus('bad', '生成失败');
    else setStatus('', s.schedule.enabled
      ? `待生成 · ${String(s.schedule.hour).padStart(2, '0')}:${String(s.schedule.minute).padStart(2, '0')} 自动`
      : '自动生成已关');

    const btn = document.getElementById('study-run');
    if (btn) {
      btn.disabled = !!s.running || !s.nextLessonId;
      btn.textContent = s.running ? '生成中…' : '立即生成';
    }
  }

  function tile(k, v, unit, d, alert) {
    const t = el('div', 'study-tile' + (alert ? ' alert' : ''));
    t.appendChild(el('div', 'k', k));
    const vv = el('div', 'v');
    vv.appendChild(document.createTextNode(String(v)));
    if (unit) { const sm = el('small', null, ' ' + unit); vv.appendChild(sm); }
    t.appendChild(vv);
    if (d) t.appendChild(el('div', 'd', d));
    return t;
  }

  function renderTiles(s) {
    const box = document.getElementById('study-tiles');
    if (!box) return;
    box.innerHTML = '';
    const total = s.planTotal || 20;
    const done = s.lessons.length;

    const p = tile('课程进度', done, '/ ' + total, '');
    const bar = el('div', 'study-bar');
    const fill = el('i'); fill.className = 'ok';
    fill.style.width = Math.min(100, Math.round(done / Math.max(1, total) * 100)) + '%';
    bar.appendChild(fill); p.appendChild(bar);
    box.appendChild(p);

    // 术语：出题数与掌握数分开显示。没有答题回流时掌握数就是 0，
    // 不把「出过题」冒充成「已掌握」——这是 LEARNER.md 里写死的纪律。
    const t = s.terms || {};
    box.appendChild(tile(
      t.hasData && t.mastered > 0 ? '术语 · 已掌握' : '术语 · 已出题',
      t.hasData && t.mastered > 0 ? t.mastered : (t.asked || 0),
      '/ ' + (t.total || 166),
      t.hasData
        ? (t.mastered > 0 ? `出过题 ${t.asked} 个 · 答错过 ${t.wrong} 个` : `掌握度待答题结果回流`)
        : '尚无 terms-state.json'
    ));

    box.appendChild(tile('待回流答题', s.pendingReports || 0, '份',
      (s.pendingReports || 0) > 0 ? '复制卡片底部结果发给教练' : '已全部回流',
      (s.pendingReports || 0) > 0));

    box.appendChild(tile('审阅意见累计', s.reviewTotal || 0, '条',
      `沉淀 ${s.insightsCount || 0} 条 · 判断 ${s.decisionsCount || 0} 条`));
  }

  function renderLessons(s) {
    const box = document.getElementById('study-lessons');
    if (!box) return;
    box.innerHTML = '';
    if (!s.lessons.length) {
      const e = el('div', 'study-empty-inline');
      e.appendChild(el('div', null, '还没有生成过学习卡。'));
      e.appendChild(el('div', null, s.nextLessonId
        ? `下一课 ${s.nextLessonId}。点右上角「立即生成」，或等自动生成。`
        : '课表已全部完成。'));
      box.appendChild(e);
      return;
    }
    for (const L of s.lessons.slice(0, RECENT_LIMIT)) {
      const row = el('div', 'study-lrow');
      row.appendChild(el('span', 'no', L.lessonId || '—'));
      const ti = el('span', 'ti', L.title || L.file);
      ti.title = L.title || L.file;
      row.appendChild(ti);
      row.appendChild(el('span', 'mt', `${L.date} · 审阅 ${L.reviewCount || 0} · ${fmtKB(L.size)}`));
      const open = el('button', 'study-btn small', '打开');
      open.addEventListener('click', () => openLesson(L.path));
      row.appendChild(open);
      box.appendChild(row);
    }
    if (s.nextLessonId) {
      const row = el('div', 'study-lrow future');
      row.appendChild(el('span', 'no', s.nextLessonId));
      row.appendChild(el('span', 'ti', '待生成'));
      row.appendChild(el('span', 'mt', s.schedule.enabled ? '自动生成' : '自动已关'));
      box.appendChild(row);
    }
  }

  function renderToday(s) {
    const box = document.getElementById('study-today');
    if (!box) return;
    box.innerHTML = '';
    box.appendChild(el('h5', null, '今日运行'));
    const run = todayRun(s);
    if (!run) {
      box.appendChild(el('div', 'study-dim', '今天还没有运行记录。'));
      return;
    }
    const chips = el('div', 'study-stagerow');
    for (const k of ['draft', 'review', 'finalize']) {
      const st = (run.stages || {})[k];
      const c = el('span', 'study-stage' + (st ? ' ' + st.status : ''), STAGE_LABEL[k]);
      if (st && st.error) c.title = st.error;
      chips.appendChild(c);
    }
    box.appendChild(chips);

    const meta = [];
    if (run.startedAt) meta.push(hhmm(run.startedAt) + (run.finishedAt ? ' → ' + hhmm(run.finishedAt) : ''));
    const dur = durationText(run);
    if (dur) meta.push(dur);
    if (run.trigger) meta.push(run.trigger === 'scheduler' ? '自动触发' : '手动触发');
    box.appendChild(el('div', 'study-dim', meta.join(' · ') || '—'));

    if (run.status === 'failed') {
      const bad = [];
      for (const [k, v] of Object.entries(run.stages || {})) {
        if (v && v.status === 'failed' && v.error) bad.push(`${STAGE_LABEL[k] || k}：${v.error}`);
      }
      if (bad.length) {
        const b = el('div', 'study-fail', bad.join('\n'));
        box.appendChild(b);
      }
    }
  }

  function renderCoaches(s) {
    const box = document.getElementById('study-coaches');
    if (!box) return;
    box.innerHTML = '';
    box.appendChild(el('h5', null, '两位教练'));
    const busyRole = s.running && s.currentRun && s.currentRun.stage
      ? (s.currentRun.stage === 'review' ? 'reviewer' : 'author') : '';
    for (const a of s.agents || []) {
      const r = el('div', 'study-ag');
      const dot = el('span', 'dot');
      if (busyRole === a.role) dot.classList.add('busy');
      else if (a.alive) dot.classList.add('alive');
      r.appendChild(dot);
      r.appendChild(el('span', 'nm', ROLE_TITLE[a.role] || a.label));
      const st = busyRole === a.role ? '工作中'
        : a.alive ? '在线' : (a.sessionId ? '休眠' : '未创建');
      r.appendChild(el('span', 'stt', st));
      const go = el('button', 'study-btn small ghost', '打开 →');
      go.addEventListener('click', () => openAgent(a.role));
      r.appendChild(go);
      box.appendChild(r);
    }
    box.appendChild(el('div', 'study-dim', '休眠的会话在提问或到点生成时会自动唤醒。'));
  }

  /* ─────────────── 动作 ─────────────── */

  // 材料一律交给 Hub 已有的预览面板：它自带查找、大纲、外开与文件监听，
  // 比在这里塞一个 iframe 强，也避免两套阅读体验分叉。
  function openLesson(p) {
    if (!p) return;
    if (typeof window.openPreviewPanel === 'function') {
      window.openPreviewPanel(p, { preview: true });
      setPanelVisible(false);
    }
  }

  async function openAgent(role) {
    let sid = '';
    const a = (state.last && (state.last.agents || []).find((x) => x.role === role)) || null;
    if (a && a.sessionId) sid = a.sessionId;
    if (!sid) {
      try {
        const r = await ipcRenderer.invoke('study:ensure-session', { role });
        if (r && r.ok) sid = r.sessionId;
      } catch { /* 下面统一兜底 */ }
    }
    if (!sid) return;
    if (typeof window.selectSession === 'function') window.selectSession(sid);
    else setPanelVisible(false);
  }

  async function runNow() {
    const btn = document.getElementById('study-run');
    if (btn) { btn.disabled = true; btn.textContent = '启动中…'; }
    let r;
    try { r = await ipcRenderer.invoke('study:run-now', {}); }
    catch (e) { r = { ok: false, message: e && e.message }; }
    if (!r || !r.ok) {
      setStatus('bad', (r && (r.message || r.error)) || '启动失败');
      if (btn) { btn.disabled = false; btn.textContent = '立即生成'; }
      return;
    }
    refresh();
  }

  /* ─────────────── 显隐 ─────────────── */

  function setPanelVisible(visible) {
    buildSkeleton();
    state.opened = visible;
    const tp = document.getElementById('terminal-panel');
    const mrp = document.getElementById('meeting-room-panel');
    const homeButton = document.getElementById('btn-home');
    const studyButton = document.getElementById('btn-study');
    if (root) root.style.display = visible ? 'grid' : 'none';
    if (studyButton) {
      studyButton.classList.toggle('active', visible);
      if (visible) studyButton.setAttribute('aria-current', 'page');
      else studyButton.removeAttribute('aria-current');
    }
    if (visible) {
      if (homeButton) { homeButton.classList.remove('active'); homeButton.removeAttribute('aria-current'); }
      if (window.__chuxinHide) window.__chuxinHide();
      if (window.__ranHide) window.__ranHide();
      if (tp) tp.style.display = 'none';
      if (mrp) mrp.style.display = 'none';
      refresh();
      if (!refreshTimer) refreshTimer = setInterval(refresh, 5000);
    } else if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  window.__studyHide = function () { if (state.opened) setPanelVisible(false); };
  window.__studyShow = function () { setPanelVisible(true); };

  function bindEntry() {
    document.querySelectorAll('#btn-study, [data-study-entry]').forEach((b) => {
      b.addEventListener('click', () => setPanelVisible(true));
    });
  }

  ipcRenderer.on('study-event', () => { if (state.opened) refresh(); });

  function init() { buildSkeleton(); bindEntry(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
