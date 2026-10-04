'use strict';
// 助理 Tab 的「对话记录」：手机发来的消息与回复（快答 + 助理会话），右侧抽屉，按天分组，可筛选，实时追加。
// 快答走 API、不进任何 CLI 会话，这里是它在电脑上唯一的查看入口。
function createDialogDrawer({ document, ipcRenderer }) {
  let drawer = null, entries = [], filter = 'all';
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // 与 Hub 其他界面一致，一律按北京时间显示（电脑系统时区可能不同）。
  const TZ = 'Asia/Shanghai';
  const time = at => new Date(at).toLocaleTimeString('zh-CN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
  const ymd = at => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date(at)).map(x => [x.type, +x.value])); return p; };
  const day = at => {
    const d = ymd(at), t = ymd(Date.now());
    const diff = Math.round((Date.UTC(t.year, t.month - 1, t.day) - Date.UTC(d.year, d.month - 1, d.day)) / 86400000);
    return diff === 0 ? '今天' : diff === 1 ? '昨天' : `${d.month}月${d.day}日`;
  };
  const seconds = ms => ms == null ? '' : ms < 10000 ? (ms / 1000).toFixed(1) + ' 秒' : Math.round(ms / 1000) + ' 秒';
  // 同一条手机消息（同 id）的回复决定它属于「快答」还是「助理会话」。
  const laneOf = () => { const map = new Map(); for (const e of entries) if (e.role === 'assistant') map.set(e.id, e.lane); return map; };
  function render() {
    if (!drawer) return;
    const list = drawer.querySelector('.dialog-list'), atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    const lanes = laneOf(), now = Date.now();
    const shown = entries.filter(e => filter === 'all' || (lanes.get(e.id) || '') === filter);
    for (const b of drawer.querySelectorAll('[data-dialog-filter]')) b.classList.toggle('active', b.dataset.dialogFilter === filter);
    if (!shown.length) { list.innerHTML = `<p class="dialog-empty">${filter === 'all' ? '还没有手机对话。用手机发一条消息试试。' : '这一类还没有对话。'}</p>`; return; }
    let lastDay = '', html = '';
    for (const e of shown) {
      const d = day(e.at); if (d !== lastDay) { html += `<div class="dialog-day">${esc(d)}</div>`; lastDay = d; }
      if (e.role === 'user') {
        const waiting = !lanes.has(e.id) && !entries.some(x => x.id === e.id && x.role === 'system') && now - e.at < 600000;
        html += `<div class="dialog-row user"><div class="dialog-bubble">${esc(e.text)}</div><div class="dialog-meta">${e.input === 'voice' ? '语音' + (e.durationMs ? ' ' + Math.round(e.durationMs / 1000) + '″' : '') : '文字'} · ${time(e.at)}${waiting ? ' · 等待回复…' : ''}</div></div>`;
      } else if (e.role === 'assistant') {
        const tag = e.lane === 'fast' ? `快答 · ${esc(e.by || '')}` : `助理会话 · ${esc(e.by || '')}`;
        html += `<div class="dialog-row reply ${e.lane === 'fast' ? 'fast' : 'session'}"><div class="dialog-tag">${tag}${e.ms != null ? ' · ' + seconds(e.ms) : ''}</div><div class="dialog-bubble">${esc(e.text)}</div><div class="dialog-meta">${time(e.at)}</div></div>`;
      } else html += `<div class="dialog-row system">${esc(e.text)} · ${time(e.at)}</div>`;
    }
    list.innerHTML = html;
    if (atBottom || !list.dataset.painted) { list.scrollTop = list.scrollHeight; list.dataset.painted = '1'; }
  }
  async function open() {
    if (drawer) { close(); return; }
    drawer = document.createElement('aside'); drawer.className = 'assistant-dialog-drawer'; drawer.setAttribute('aria-label', '对话记录');
    drawer.innerHTML = `<header><div><h2>对话记录</h2><p>手机发来的消息与回复。快答走 API、不进助理会话，在这里留档。</p></div><button type="button" class="dialog-close" aria-label="关闭">×</button></header>
      <nav class="dialog-filters"><button type="button" data-dialog-filter="all">全部</button><button type="button" data-dialog-filter="fast">快答</button><button type="button" data-dialog-filter="assistant">助理会话</button></nav>
      <div class="dialog-list"><p class="dialog-empty">正在读取…</p></div>`;
    drawer.addEventListener('click', e => {
      if (e.target.closest('.dialog-close')) { close(); return; }
      const f = e.target.closest('[data-dialog-filter]'); if (f) { filter = f.dataset.dialogFilter; delete drawer.querySelector('.dialog-list').dataset.painted; render(); }
    });
    document.body.append(drawer);
    const r = await ipcRenderer.invoke('assistant:dialog-log', { limit: 300 });
    entries = r?.ok ? r.entries : []; render();
  }
  function close() { drawer?.remove(); drawer = null; }
  ipcRenderer.on('assistant:dialog', (_event, entry) => { if (!drawer || !entry) return; entries.push(entry); render(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && drawer) close(); });
  return { open, close, isOpen: () => !!drawer };
}
module.exports = { createDialogDrawer };
