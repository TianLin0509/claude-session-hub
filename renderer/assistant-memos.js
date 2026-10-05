'use strict';
// 助理页「备忘」视图（2026-10-05 田哥：备忘是助理 Tab 的核心功能）。
// 备忘由助理在对话里写入；这里给田哥看和点：一行一个摘要标题，点开是当时原话、记录时间与来源。
// 分组 今天 / 即将 / 随时 / 以后，已完成默认收起；编号与手机、晚间清单一致，可以对助理说「第 2 条推到周五」。
// 圆圈 = 办完了；展开后可推迟到明天 / 下周一 / 以后，或「不做了」。数据与规则在 core/hub-assistant/memos.js。
const TZ = 'Asia/Shanghai';
function createMemoView({ document, ipcRenderer, showMessage = () => {}, onCount = () => {} }) {
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const stamp = at => new Date(at).toLocaleString('zh-CN', { timeZone: TZ, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  // 北京时间的「明天 9 点」「下周一 9 点」，写成 memos 能解析的「YYYY-MM-DD HH:MM」。
  const bjDate = (offsetDays, hour = 9) => { const d = new Date(Date.now() + 8 * 3600000 + offsetDays * 86400000); return d.toISOString().slice(0, 10) + ' ' + String(hour).padStart(2, '0') + ':00'; };
  const nextMonday = () => { const wd = new Date(Date.now() + 8 * 3600000).getUTCDay(); return bjDate(((8 - wd) % 7) || 7); };
  let data = { open: [], closed: [], groups: {} }, expanded = null, showClosed = false;
  const el = document.createElement('div'); el.className = 'ap-memos'; el.hidden = true; el.setAttribute('aria-label', '备忘清单');
  const call = async (channel, payload) => { const r = await ipcRenderer.invoke(channel, payload); if (r && r.ok === false) throw new Error(r.error || '操作未完成'); return r; };

  function row(m) {
    const closed = m.status !== 'open', open = expanded === m.id;
    const right = closed ? (m.status === 'dropped' ? '不做了' : '已完成') : m.dueLabel ? (m.group === 'today' && m.due < Date.now() - 60000 ? '原定 ' + m.dueLabel : m.dueLabel) : m.later ? '以后' : stamp(m.createdAt) + ' 记';
    let html = `<li class="ap-memo${closed ? ' closed' : ''}${open ? ' open' : ''}" data-memo="${esc(m.id)}">
      <button type="button" class="ap-memo-check" data-memo-act="${closed ? 'reopen' : 'done'}" aria-label="${closed ? '恢复为待办' : '办完了'}：${esc(m.title)}">${closed ? '✓' : ''}</button>
      <button type="button" class="ap-memo-main" data-memo-toggle="${esc(m.id)}" aria-expanded="${open}">
        ${m.no ? `<span class="ap-memo-no">${m.no}</span>` : ''}<span class="ap-memo-title">${m.kind === 'idea' ? '💡 ' : ''}${esc(m.title)}</span><span class="ap-memo-when">${esc(right)}</span>
      </button>`;
    if (open) {
      html += `<div class="ap-memo-detail"><blockquote>${esc(m.raw || '（没有记录原话）')}</blockquote>
        <p class="ap-memo-meta">记录于 ${esc(stamp(m.createdAt))}${m.source ? ' · ' + esc(m.source) : ''}${m.snoozes ? ' · 推迟过 ' + m.snoozes + ' 次' : ''}</p>
        <div class="ap-memo-acts">${closed ? `<button type="button" data-memo-act="reopen">恢复为待办</button>`
          : `<button type="button" class="primary" data-memo-act="done">办完了</button><button type="button" data-memo-act="snooze" data-until="${bjDate(1)}">推到明天</button><button type="button" data-memo-act="snooze" data-until="${nextMonday()}">推到下周一</button><button type="button" data-memo-act="snooze" data-until="later">以后再说</button><button type="button" class="quiet" data-memo-act="drop">不做了</button>`}</div></div>`;
    }
    return html + '</li>';
  }
  function render() {
    const groups = Object.entries(data.groups || {});
    let html = '<div class="ap-memo-wrap">';
    if (!data.open.length) html += `<div class="ap-memo-empty"><h2>备忘清单是空的</h2><p>对助理说「记一下……」，突发的事、碎片灵感都会记在这里。<br>说了时间的到点提醒；每晚 9 点把清单发你一次。</p></div>`;
    for (const [key, label] of groups) {
      const rows = data.open.filter(m => m.group === key); if (!rows.length) continue;
      html += `<section class="ap-memo-group"><h3>${esc(label)} <span>${rows.length}</span></h3><ul>${rows.map(row).join('')}</ul></section>`;
    }
    if (data.closed.length) html += `<section class="ap-memo-group done"><h3><button type="button" data-memo-closed aria-expanded="${showClosed}">${showClosed ? '▾' : '▸'} 最近完成 <span>${data.closed.length}</span></button></h3>${showClosed ? `<ul>${data.closed.map(row).join('')}</ul>` : ''}</section>`;
    el.innerHTML = html + '</div>';
  }
  async function refresh() {
    try { data = await call('assistant:memos'); } catch (error) { showMessage('备忘读取失败：' + error.message); return; }
    if (expanded && ![...data.open, ...data.closed].some(m => m.id === expanded)) expanded = null;
    onCount(data.open.length); if (!el.hidden) render();
  }
  el.addEventListener('click', async event => {
    const closedToggle = event.target.closest('[data-memo-closed]'); if (closedToggle) { showClosed = !showClosed; render(); return; }
    const toggle = event.target.closest('[data-memo-toggle]'); if (toggle) { expanded = expanded === toggle.dataset.memoToggle ? null : toggle.dataset.memoToggle; render(); return; }
    const act = event.target.closest('[data-memo-act]'); if (!act) return;
    const id = act.closest('[data-memo]')?.dataset.memo; if (!id) return;
    act.disabled = true;
    try {
      await call('assistant:memo-action', { ref: id, action: act.dataset.memoAct, ...(act.dataset.until ? { until: act.dataset.until } : {}) });
      if (act.dataset.memoAct !== 'reopen') expanded = null;
      await refresh();
    } catch (error) { act.disabled = false; showMessage('没改成：' + error.message); }
  });
  ipcRenderer.on('assistant:memos-changed', () => { void refresh(); });
  return { el, refresh, show() { el.hidden = false; render(); void refresh(); }, hide() { el.hidden = true; }, count: () => data.open.length };
}
module.exports = { createMemoView };
