/* 开发看板 —— Hub 第五主区视图，与 terminal / mr / chuxin / study 平级互斥。
 *
 * 一个群聊 = 一个任务，所以「看板的一行」就是「一个开发群聊」。
 * 数据全部来自 Hub 自己的会议列表，**不扫任何仓库、不读任何 Agent 写的台账文件**。
 *
 * 为什么这么设计：Agent 会忘记更新台账，但群聊和循环状态是客观存在的。
 * 能推导的绝不申报 —— 推导出来的东西不会撒谎。
 *
 * 文件名和 window.__ranHide 这些内部标识沿用历史命名（8 处调用点引用它们），
 * 面向用户的一切已改成通用说法。见 renderer/dev-progress.js 的数据层。
 */
(function () {
  'use strict';

  const { ipcRenderer } = require('electron');

  const state = { opened: false, loading: false };
  let root = null;
  let listEl = null;
  let statusEl = null;
  let timer = null;

  const TONE_COLOR = {
    ok: 'var(--ok,#34c759)',
    run: 'var(--accent,#0071e3)',
    warn: 'var(--warn,#ff9f0a)',
    bad: 'var(--bad,#ff3b30)',
    idle: 'var(--soft,#8e8e93)',
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function buildSkeleton() {
    if (root) return;
    root = document.getElementById('ran-panel');
    if (!root) return;
    root.style.cssText = 'display:none;flex-direction:column;flex:1;min-width:0;overflow:hidden';
    root.innerHTML = [
      '<div style="display:flex;align-items:center;gap:12px;padding:10px 16px;',
      'border-bottom:1px solid var(--border,#d2d2d7);flex:none">',
      '<b style="font-size:13.5px">开发看板</b>',
      '<span id="devb-status" style="font-size:12px;opacity:.6"></span>',
      '<span style="flex:1"></span>',
      '<button id="devb-refresh" class="btn-small" style="font-size:12px;padding:4px 12px;cursor:pointer">刷新</button>',
      '</div>',
      '<div id="devb-list" style="flex:1;overflow:auto;padding:14px 16px"></div>',
    ].join('');
    listEl = root.querySelector('#devb-list');
    statusEl = root.querySelector('#devb-status');
    const btn = root.querySelector('#devb-refresh');
    if (btn) btn.addEventListener('click', () => refresh());
  }

  function rowHtml(row) {
    const color = TONE_COLOR[row.stage.tone] || TONE_COLOR.idle;
    const roundTxt = row.stage.round > 0
      ? `第 ${row.stage.round} / ${row.stage.maxRounds} 轮` : '';
    const bits = [];
    if (row.workspace) bits.push(esc(row.workspace));
    if (roundTxt) bits.push(roundTxt);
    if (row.idle) bits.push(esc(row.idle));

    // 人话层：Agent 申报的那句话；没有就不占地方，不显示「暂无」这种废话
    const line = row.progress
      ? `<div style="font-size:13px;opacity:.8;margin-top:5px">${esc(row.progress)}</div>` : '';
    const blocked = row.blockers
      ? `<div style="font-size:12.5px;margin-top:4px;color:${TONE_COLOR.warn}">打回：${esc(row.blockers)}</div>` : '';

    return [
      `<div class="devb-row" data-mid="${esc(row.id)}" style="border:1px solid var(--border,#d2d2d7);`,
      `border-left:3px solid ${color};border-radius:10px;padding:12px 15px;margin-bottom:9px;cursor:pointer">`,
      '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">',
      `<b style="font-size:14px">${esc(row.title)}</b>`,
      `<span style="font-size:12px;color:${color};font-weight:600">${esc(row.stage.label)}</span>`,
      `<span style="flex:1"></span>`,
      `<span style="font-size:12px;opacity:.55">${bits.join(' · ')}</span>`,
      '</div>', line, blocked, '</div>',
    ].join('');
  }

  async function refresh() {
    if (!listEl || state.loading) return;
    state.loading = true;
    if (statusEl) statusEl.textContent = '读取中…';
    try {
      const DP = window.DevProgress;
      const meetings = (await ipcRenderer.invoke('get-meetings')) || [];
      const devs = DP ? meetings.filter(DP.isDevMeeting) : [];

      if (!devs.length) {
        listEl.innerHTML = [
          '<div style="opacity:.62;font-size:14px;line-height:2;padding:20px 4px">',
          '还没有开发任务。<br><br>',
          '新建一个群聊，<b>场景选「开发」</b>，工作目录选你要改的项目，',
          '然后直接在输入框打一句人话说要干什么、回车即可 —— 工作流已经默认配好，不用另外配置。<br><br>',
          '<span style="font-size:13px">一个群聊对应一个任务；有多个需求就开多个群聊并行。</span>',
          '</div>',
        ].join('');
      } else {
        // 在跑的排前面，其次是要你处理的，已完成沉底
        const order = { run: 0, bad: 1, warn: 2, idle: 3, ok: 4 };
        const rows = devs.map(m => DP.boardRow(m, []))
          .sort((a, b) => (order[a.stage.tone] ?? 9) - (order[b.stage.tone] ?? 9));
        listEl.innerHTML = rows.map(rowHtml).join('');
        listEl.querySelectorAll('.devb-row').forEach((el) => {
          el.addEventListener('click', () => {
            const id = el.getAttribute('data-mid');
            if (!id) return;
            setPanelVisible(false);
            const sel = window.selectMeeting || (typeof selectMeeting === 'function' ? selectMeeting : null);
            if (sel) sel(id);
          });
        });
      }
      if (statusEl) {
        const running = devs.filter(m => {
          const s = window.DevProgress.deriveStage(m);
          return s.tone === 'run';
        }).length;
        statusEl.textContent = devs.length
          ? `${devs.length} 个任务，${running} 个在跑` : '';
      }
    } catch (e) {
      if (statusEl) statusEl.textContent = '读取失败：' + ((e && e.message) || e);
    } finally {
      state.loading = false;
    }
  }

  function setPanelVisible(visible) {
    buildSkeleton();
    if (!root) return;
    state.opened = visible;

    const tp = document.getElementById('terminal-panel');
    const mrp = document.getElementById('meeting-room-panel');
    const homeButton = document.getElementById('btn-home');
    const navButton = document.getElementById('btn-ran');

    root.style.display = visible ? 'flex' : 'none';
    if (navButton) {
      navButton.classList.toggle('active', visible);
      if (visible) navButton.setAttribute('aria-current', 'page');
      else navButton.removeAttribute('aria-current');
    }
    if (visible) {
      if (homeButton) {
        homeButton.classList.remove('active');
        homeButton.removeAttribute('aria-current');
      }
      if (window.__chuxinHide) window.__chuxinHide();
      if (window.__studyHide) window.__studyHide();
      if (tp) tp.style.display = 'none';
      if (mrp) mrp.style.display = 'none';
      refresh();
      // 任务在后台跑，看板开着的时候自动跟进度
      if (timer) clearInterval(timer);
      timer = setInterval(() => { if (state.opened) refresh(); }, 15000);
    } else if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  window.__ranHide = function () { if (state.opened) setPanelVisible(false); };
  window.__ranShow = function () { setPanelVisible(true); };
  window.__devBoardHide = window.__ranHide;
  window.__devBoardShow = window.__ranShow;

  function bindEntry() {
    document.querySelectorAll('#btn-ran, [data-ran-entry]').forEach((b) => {
      b.addEventListener('click', () => setPanelVisible(true));
    });
  }

  function init() { buildSkeleton(); bindEntry(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
