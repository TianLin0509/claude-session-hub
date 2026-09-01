'use strict';
/**
 * 学习面板（study-panel）—— Hub 第四主区视图，与 terminal-panel /
 * meeting-room-panel / chuxin-panel 平级。
 *
 * 布局按用户选定的 Mock B：左侧当日学习卡，右侧两个常驻 Agent 可切换。
 *
 * 右侧的两个 Agent 是**真实的 Hub Session**（Claude 主笔 / Codex 审阅兼插画），
 * 不是这里造的假对话框：状态、输出都读真会话，提问经 study:ask 走 sendToPty
 * 硬化路径（它才处理了 Codex 非 ASCII prompt 落文件、paste 与 Enter 分两次写
 * 这两个历史坑）。"打开完整 PTY" 直接把主区切到那个会话。
 */
(function () {
  const { ipcRenderer } = require('electron');

  const ROLE_TITLE = { author: 'Claude · 主笔', reviewer: 'Codex · 审阅与插画' };
  const STAGE_LABEL = { draft: '初稿', review: '审阅配图', finalize: '定稿' };
  const OUTPUT_TAIL = 6000;   // 右栏只回显尾部，整段 PTY 缓冲可能几百 KB

  let root = null;
  let refreshTimer = null;
  const state = {
    opened: false,
    activeRole: 'author',
    lessons: [],
    currentLessonPath: '',
    lastState: null,
  };

  /* ─────────────── 骨架 ─────────────── */

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function buildSkeleton() {
    root = document.getElementById('study-panel');
    if (!root || root.dataset.built === '1') return;
    root.dataset.built = '1';
    root.innerHTML = '';

    // 顶部
    const head = el('div', 'study-head');
    const titleWrap = el('div');
    titleWrap.appendChild(el('div', 'st-title', '学习'));
    const sub = el('div', 'st-sub', '');
    sub.id = 'study-sub';
    titleWrap.appendChild(sub);
    head.appendChild(titleWrap);

    const sel = el('select', 'study-select');
    sel.id = 'study-lesson-select';
    sel.addEventListener('change', () => openLesson(sel.value));
    head.appendChild(sel);

    const stages = el('div', 'study-stages');
    stages.id = 'study-stages';
    head.appendChild(stages);

    head.appendChild(el('div', 'st-spacer'));

    const status = el('span', 'study-pill', '—');
    status.id = 'study-status';
    head.appendChild(status);

    const runBtn = el('button', 'study-btn primary', '立即生成');
    runBtn.id = 'study-run';
    runBtn.addEventListener('click', runNow);
    head.appendChild(runBtn);

    root.appendChild(head);

    // 主体
    const body = el('div', 'study-body');

    const lessonCol = el('div', 'study-lesson');
    lessonCol.id = 'study-lesson-col';
    body.appendChild(lessonCol);

    const agents = el('div', 'study-agents');
    const tabs = el('div', 'study-tabs');
    for (const role of ['author', 'reviewer']) {
      const t = el('div', 'study-tab' + (role === state.activeRole ? ' on' : ''));
      t.dataset.role = role;
      const dot = el('span', 'dot');
      t.appendChild(dot);
      t.appendChild(document.createTextNode(ROLE_TITLE[role]));
      t.addEventListener('click', () => setActiveRole(role));
      tabs.appendChild(t);
    }
    agents.appendChild(tabs);

    const meta = el('div', 'study-agent-meta');
    meta.id = 'study-agent-meta';
    agents.appendChild(meta);

    const out = el('div', 'study-output');
    out.id = 'study-output';
    agents.appendChild(out);

    const ask = el('div', 'study-ask');
    const ta = el('textarea');
    ta.id = 'study-ask-input';
    ta.placeholder = '问点什么…（Ctrl+Enter 发送）';
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendAsk(); }
    });
    ask.appendChild(ta);
    const row = el('div', 'row');
    const hint = el('div', 'grow', '');
    hint.id = 'study-ask-hint';
    row.appendChild(hint);
    const ptyBtn = el('button', 'study-btn', '打开完整 PTY');
    ptyBtn.id = 'study-open-pty';
    ptyBtn.addEventListener('click', openPty);
    row.appendChild(ptyBtn);
    const sendBtn = el('button', 'study-btn primary', '发送');
    sendBtn.id = 'study-send';
    sendBtn.addEventListener('click', sendAsk);
    row.appendChild(sendBtn);
    ask.appendChild(row);
    agents.appendChild(ask);

    body.appendChild(agents);
    root.appendChild(body);
  }

  /* ─────────────── 数据 ─────────────── */

  async function refresh() {
    if (!state.opened) return;
    let s;
    try { s = await ipcRenderer.invoke('study:state'); }
    catch (e) { setStatus('bad', '读取状态失败'); return; }
    if (!s || !s.ok) { setStatus('bad', '状态不可用'); return; }
    state.lastState = s;
    renderHead(s);
    renderLessonList(s);
    renderAgent(s);
  }

  function setStatus(kind, text) {
    const n = document.getElementById('study-status');
    if (!n) return;
    n.className = 'study-pill' + (kind ? ' ' + kind : '');
    n.textContent = text;
  }

  function renderHead(s) {
    const sub = document.getElementById('study-sub');
    if (sub) {
      const done = s.lessons.length;
      sub.textContent = `${s.todayDate} · 已出 ${done} 课` + (s.nextLessonId ? ` · 下一课 ${s.nextLessonId}` : ' · 全部完成');
    }

    const run = s.runs && s.runs.find((r) => r.date === s.todayDate);
    if (s.running && s.currentRun) {
      setStatus('run', `生成中 · ${STAGE_LABEL[s.currentRun.stage] || s.currentRun.stage}`);
    } else if (run && run.status === 'done') setStatus('ok', '今日已完成');
    else if (run && run.status === 'failed') setStatus('bad', '生成失败');
    else setStatus('', s.schedule.enabled ? `待生成 · ${String(s.schedule.hour).padStart(2, '0')}:${String(s.schedule.minute).padStart(2, '0')} 自动` : '自动生成已关');

    const stagesEl = document.getElementById('study-stages');
    if (stagesEl) {
      stagesEl.innerHTML = '';
      const stages = (run && run.stages) || {};
      for (const key of ['draft', 'review', 'finalize']) {
        const st = stages[key];
        const chip = el('span', 'study-stage' + (st ? ' ' + st.status : ''), STAGE_LABEL[key]);
        if (st && st.error) chip.title = st.error;
        stagesEl.appendChild(chip);
      }
    }

    const runBtn = document.getElementById('study-run');
    if (runBtn) {
      runBtn.disabled = !!s.running || !s.nextLessonId;
      runBtn.textContent = s.running ? '生成中…' : '立即生成';
    }
  }

  function renderLessonList(s) {
    state.lessons = s.lessons || [];
    const sel = document.getElementById('study-lesson-select');
    if (!sel) return;
    const prev = state.currentLessonPath || (state.lessons[0] && state.lessons[0].path) || '';
    sel.innerHTML = '';
    if (!state.lessons.length) {
      const o = el('option', null, '（还没有学习卡）');
      o.value = '';
      sel.appendChild(o);
      showEmpty(s);
      return;
    }
    for (const L of state.lessons) {
      const o = el('option', null, `${L.lessonId} · ${L.date}`);
      o.value = L.path;
      sel.appendChild(o);
    }
    const target = state.lessons.some((L) => L.path === prev) ? prev : state.lessons[0].path;
    sel.value = target;
    if (target !== state.currentLessonPath) openLesson(target);
  }

  function showEmpty(s) {
    const col = document.getElementById('study-lesson-col');
    if (!col) return;
    col.innerHTML = '';
    const box = el('div', 'study-empty');
    box.appendChild(el('div', 'big', '还没有生成过学习卡'));
    box.appendChild(el('div', null, s && s.nextLessonId
      ? `下一课是 ${s.nextLessonId}。点右上角「立即生成」，或等 ${String(s.schedule.hour).padStart(2, '0')}:${String(s.schedule.minute).padStart(2, '0')} 自动生成。`
      : '课表已全部完成。'));
    box.appendChild(el('div', null, '生成分三棒：Claude 写初稿 → Codex 审阅并配图 → Claude 定稿。'));
    col.appendChild(box);
    state.currentLessonPath = '';
  }

  async function openLesson(p) {
    if (!p) return;
    const col = document.getElementById('study-lesson-col');
    if (!col) return;
    let res;
    try { res = await ipcRenderer.invoke('study:read-lesson', { path: p }); }
    catch (e) { res = { ok: false, message: e && e.message }; }
    col.innerHTML = '';
    if (!res || !res.ok) {
      const box = el('div', 'study-empty');
      box.appendChild(el('div', 'big', '打不开这张学习卡'));
      box.appendChild(el('div', null, (res && (res.message || res.error)) || '未知原因'));
      col.appendChild(box);
      return;
    }
    // 课程是自包含文档（内联 CSS/SVG + base64 图，零网络请求），
    // 用 srcdoc 隔离渲染，避免和面板样式互相污染。
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-same-origin allow-scripts');
    frame.srcdoc = res.html;
    col.appendChild(frame);
    state.currentLessonPath = p;
  }

  /* ─────────────── 右栏 Agent ─────────────── */

  function setActiveRole(role) {
    state.activeRole = role;
    document.querySelectorAll('#study-panel .study-tab').forEach((t) => {
      t.classList.toggle('on', t.dataset.role === role);
    });
    if (state.lastState) renderAgent(state.lastState);
  }

  function activeAgent(s) {
    return (s.agents || []).find((a) => a.role === state.activeRole) || null;
  }

  async function renderAgent(s) {
    // tab 上的状态点
    document.querySelectorAll('#study-panel .study-tab').forEach((t) => {
      const a = (s.agents || []).find((x) => x.role === t.dataset.role);
      const dot = t.querySelector('.dot');
      if (!dot) return;
      const busy = s.running && s.currentRun && busyRoleOf(s) === t.dataset.role;
      dot.className = 'dot' + (busy ? ' busy' : (a && a.alive ? ' alive' : ''));
      t.title = a ? `${a.label} · ${a.status}` : '';
    });

    const a = activeAgent(s);
    const meta = document.getElementById('study-agent-meta');
    if (meta) {
      meta.innerHTML = '';
      if (!a) { meta.appendChild(el('span', null, '—')); }
      else {
        const statusText = a.alive ? '在线' : (a.sessionId ? '休眠（提问会自动唤醒）' : '未创建（提问会自动创建）');
        meta.appendChild(el('b', null, a.label));
        meta.appendChild(el('span', null, statusText));
        if (a.sessionId) meta.appendChild(el('span', null, `#${String(a.sessionId).slice(0, 8)}`));
      }
    }

    const busy = s.running && busyRoleOf(s) === state.activeRole;
    const hint = document.getElementById('study-ask-hint');
    if (hint) {
      hint.textContent = busy
        ? `正在跑「${STAGE_LABEL[s.currentRun.stage] || s.currentRun.stage}」，这一棒结束后再提问`
        : 'Ctrl+Enter 发送';
    }
    const sendBtn = document.getElementById('study-send');
    if (sendBtn) sendBtn.disabled = !!busy;

    renderOutput(a);
  }

  function busyRoleOf(s) {
    if (!s.running || !s.currentRun || !s.currentRun.stage) return '';
    return s.currentRun.stage === 'review' ? 'reviewer' : 'author';
  }

  async function renderOutput(agent) {
    const out = document.getElementById('study-output');
    if (!out) return;
    if (!agent || !agent.sessionId) {
      out.innerHTML = '';
      out.appendChild(el('div', 'hint', '这个 Agent 还没有会话。发一条提问会自动创建，或等第一次自动生成时创建。'));
      return;
    }
    // 走 study:agent-output（主进程读 ringBuffer 并去 ANSI）。
    // 不用 get-session-buffer-snapshot：那条路径在没挂终端时返回空串，
    // 表现为输出区永远空白——2026-09-01 实测确认，同一会话 raw 有 12292 字符、snapshot 是 0。
    let buf = '';
    try {
      const res = await ipcRenderer.invoke('study:agent-output', { role: state.activeRole });
      buf = (res && res.ok && res.text) || '';
    } catch { buf = ''; }
    if (!buf.trim()) {
      out.innerHTML = '';
      out.appendChild(el('div', 'hint', '会话还没有输出（可能处于休眠）。'));
      return;
    }
    const nearBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    out.textContent = buf.length > OUTPUT_TAIL ? buf.slice(-OUTPUT_TAIL) : buf;
    if (nearBottom) out.scrollTop = out.scrollHeight;
  }

  async function sendAsk() {
    const ta = document.getElementById('study-ask-input');
    if (!ta) return;
    const text = ta.value.trim();
    if (!text) return;
    const btn = document.getElementById('study-send');
    if (btn) { btn.disabled = true; btn.textContent = '发送中…'; }
    let r;
    try { r = await ipcRenderer.invoke('study:ask', { role: state.activeRole, text }); }
    catch (e) { r = { ok: false, message: e && e.message }; }
    if (btn) { btn.disabled = false; btn.textContent = '发送'; }
    const hint = document.getElementById('study-ask-hint');
    if (r && r.ok) {
      ta.value = '';
      if (hint) hint.textContent = '已发送，等待回复…';
      setTimeout(refresh, 1200);
    } else if (hint) {
      hint.textContent = (r && (r.message || r.error)) || '发送失败';
    }
  }

  async function openPty() {
    const s = state.lastState;
    const a = s && activeAgent(s);
    if (!a) return;
    let sessionId = a.sessionId;
    if (!sessionId) {
      try {
        const r = await ipcRenderer.invoke('study:ensure-session', { role: state.activeRole });
        if (r && r.ok) sessionId = r.sessionId;
      } catch { /* 下面统一处理 */ }
    }
    if (!sessionId) return;
    // 交给 renderer.js 的会话选择逻辑，它会把主区切回终端并隐藏本面板
    if (typeof window.selectSession === 'function') window.selectSession(sessionId);
    else if (typeof window.__hubSelectSession === 'function') window.__hubSelectSession(sessionId);
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
      // 与投研面板互斥：主区同一时刻只显示一个视图
      if (window.__chuxinHide) window.__chuxinHide();
      if (tp) tp.style.display = 'none';
      if (mrp) mrp.style.display = 'none';
      refresh();
      if (!refreshTimer) refreshTimer = setInterval(refresh, 4000);
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

  // 编排器推的事件：立刻刷新，不等 4 秒轮询
  ipcRenderer.on('study-event', () => { if (state.opened) refresh(); });

  function init() { buildSkeleton(); bindEntry(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
