'use strict';
// 无线页里的「公司联动」（2026-10-15，家里一端）：配对、公司是否在线、家里的 Agent 向公司提过的问题和回执。
// 问答本身由 Agent 通过「问公司」工具或 company-ask 命令发起，这里只看进度、管配对和挂载范围。
function createCompanyLinkSection({ document, ipcRenderer, openSession, showMessage }) {
  let root = null, data = null;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clock = at => at ? new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
  const call = async (channel, payload) => { const r = await ipcRenderer.invoke(channel, payload); if (r && r.ok === false) throw new Error(r.error || '操作未完成'); return r; };
  const ROUND = { sent: ['已发出', 'wait'], received: ['公司已收到', 'wait'], running: ['公司在处理', 'run'], replied: ['已回执', 'ok'], error: ['公司报错', 'bad'] };
  const CONSULT = { queued: ['排队', 'wait'], running: ['家里在作答', 'run'], replied: ['已回复公司', 'ok'], failed: ['没答上', 'bad'], cancelled: ['已作废', 'mute'] };
  const AGENT = { claude: 'Claude', codex: 'Codex' };

  function head() {
    const st = data.link.state, net = data.net || {};
    if (st === 'none') return `<div class="wp-row"><span class="k">状态</span><span class="v">还没和公司 Hub 配对。配对后，Hub 新开的会话里的 Agent 可以请公司电脑上的 CodeAgent 办事：查 AirView / L2 代码、查公司电脑上的文件与环境（不改动公司电脑，回执不含源码）。</span><span class="r"><button type="button" class="wp-btn primary" data-cl="create">生成配对码</button></span></div>`;
    if (st === 'pending') return `<div class="wp-row"><span class="k">配对码</span><span class="v">把下面整段发到公司电脑，在公司 Hub「设置菜单 → AI特战队专用功能」里粘贴。公司确认后这段就作废了。<textarea class="cl-code" readonly rows="4">${esc(data.link.pairingCode || '')}</textarea></span>
      <span class="r cl-col"><button type="button" class="wp-btn primary" data-cl="send">发到公司收件箱</button><button type="button" class="wp-btn" data-cl="copy">复制</button><button type="button" class="wp-link" data-cl="unpair">取消</button></span></div>
      <div class="wp-row"><span class="k">等待</span><span class="v">${net.lastError ? `<span class="bad">通道连不上：${esc(net.lastError.message)}</span>` : `等公司 Hub 粘贴配对码……${data.polling ? `（每 ${esc(data.polling.intervalSeconds)} 秒检查）` : ''}`}</span><span class="r"><button type="button" class="wp-link" data-cl="check">立即检查</button></span></div>`;
    const peer = data.peer || {};
    return `<div class="wp-row"><span class="k">状态</span><span class="v">已接通 · 公司 Hub ${esc(peer.companyLastSeen || '')}${net.lastError ? ` · <span class="bad">上次连通道失败：${esc(net.lastError.message)}</span>` : ''}${data.link.outbox ? ` · 待发 ${data.link.outbox} 条` : ''}</span><span class="r"><button type="button" class="wp-link" data-cl="check">立即检查</button><button type="button" class="wp-link" data-cl="unpair">解除配对</button></span></div>
      ${data.polling ? `<div class="wp-row"><span class="k">检查频率</span><span class="v">${data.polling.active ? '联动中' : '空闲中'} · 本机每 ${esc(data.polling.intervalSeconds)} 秒检查回执</span><span class="r"></span></div>` : ''}
      ${hubRow()}
      <div class="wp-row"><span class="k">挂给谁</span><span class="v"><select data-cl="attach"><option value="wireless"${data.settings.attach === 'wireless' ? ' selected' : ''}>SuperRAN 相关会话（无线助理开的、目录在 SuperRAN 下的）</option><option value="all"${data.settings.attach === 'all' ? ' selected' : ''}>所有 Codex / Claude 会话</option></select></span><span class="r">新开的会话生效；其余会话可用 company-ask 命令</span></div>`;
  }
  // 公司 Hub 的版本与远程更新（2026-10-17）：和会话里的 company_hub_update 工具同一个动作，进度以通知送达。
  function hubRow() {
    const h = data.companyHub || {}, last = (h.recent || [])[0];
    const ver = h.version ? 'v' + esc(h.version) : '版本未知（公司 Hub 升到 2.1.8 后会自动报）';
    return `<div class="wp-row cl-hub"><span class="k">公司 Hub</span><span class="v">${ver} · 上次在线 ${esc((data.peer || {}).companyLastSeen || '')}${last && last.phase !== 'online' ? ` · 最近：${esc(last.note)}（${clock(last.at)}）` : ''}${h.pending?.length ? ' · 指令执行中' : ''}</span>
      <span class="r"><button type="button" class="wp-btn" data-cl="hub-update">让公司 Hub 更新</button><button type="button" class="wp-link" data-cl="hub-status">查状态</button></span></div>`;
  }
  function threads() {
    const list = (data.threads || []).slice(0, 30);
    if (!list.length) return data.link.state === 'paired' ? '<p class="wp-empty">还没有向公司提过问题。</p>' : '';
    return list.map(t => {
      const last = t.rounds[t.rounds.length - 1] || {};
      const [label, tone] = ROUND[last.status] || [last.status, 'mute'];
      const undelivered = t.rounds.some(r => (r.reply || r.error) && !r.delivered);
      const rounds = t.rounds.map(r => `<div class="cl-round"><b>第 ${r.round} 轮</b> <span class="wp-meta">问于 ${clock(r.sentAt)}${r.replyAt ? ' · 回执 ' + clock(r.replyAt) : ''}${r.meta?.model ? ' · ' + esc(r.meta.model) : ''}${r.meta?.elapsedSec ? ' · 用时 ' + Math.round(r.meta.elapsedSec / 60) + ' 分钟' : ''}${r.deliveryError ? ' · <span class="bad">' + esc(r.deliveryError) + '</span>' : ''}</span>
        <pre>${esc(r.question)}</pre>${r.reply ? `<pre class="ans">${esc(r.reply)}</pre>` : ''}${r.error ? `<p class="wp-note warn">${esc(r.error)}</p>` : ''}</div>`).join('');
      return `<article class="wp-item"><div class="wp-item-head"><span class="wp-pill ${tone}">${label}</span><strong>${esc(t.id)} · ${esc(t.title)}</strong>${undelivered ? '<span class="wp-tag">等会话停下再送</span>' : ''}</div>
        <div class="wp-meta">来自会话「${esc(t.session?.title || t.sessionTitle || t.sessionId)}」 · ${t.rounds.length} 轮 · 发起 ${clock(t.createdAt)}</div>
        <details class="cl-details"><summary>看问答</summary>${rounds}</details>
        <div class="wp-actions"><button type="button" class="wp-link" data-cl="open:${esc(t.sessionId)}">${t.session?.open ? '打开提问的会话' : '找回提问的会话'}</button></div></article>`;
    }).join('');
  }
  // 公司 CodeAgent 用 ask_home 发来的求助（2026-10-15）：家里开 Claude 会话作答，不行换 Codex。
  function consults() {
    const list = (data.consults || []).slice(0, 30);
    if (!list.length) return '';
    return '<h3 class="cl-sub">公司来的求助</h3>' + list.map(t => {
      const [label, tone] = CONSULT[t.state] || [t.state, 'mute'];
      const rounds = t.rounds.map(r => `<div class="cl-round"><b>第 ${r.round} 轮</b> <span class="wp-meta">收于 ${clock(r.receivedAt)}${r.agent ? ' · ' + AGENT[r.agent] : ''}${r.fallbackReason ? '（Claude ' + esc(r.fallbackReason) + '）' : ''}${r.companyAsks?.length ? ' · 回公司查证据 ' + esc(r.companyAsks.join('、')) : ''}${r.replyAt ? ' · 回复 ' + clock(r.replyAt) : ''}${r.meta?.elapsedSec ? ' · 用时 ' + Math.round(r.meta.elapsedSec / 60) + ' 分钟' : ''}</span>
        <pre>${esc(r.question)}</pre>${r.reply ? `<pre class="ans">${esc(r.reply)}</pre>` : ''}${r.error ? `<p class="wp-note warn">${esc(r.error)}</p>` : ''}</div>`).join('');
      return `<article class="wp-item"><div class="wp-item-head"><span class="wp-pill ${tone}">${label}</span><strong>${esc(t.id)} · ${esc(t.title)}</strong>${t.agent ? `<span class="wp-tag">${AGENT[t.agent] || esc(t.agent)}</span>` : ''}</div>
        <div class="wp-meta">${t.from?.title ? '来自公司会话「' + esc(t.from.title) + '」 · ' : ''}${t.rounds.length} 轮 · 收到 ${clock(t.createdAt)}</div>
        <details class="cl-details"><summary>看问答</summary>${rounds}</details>
        ${t.sessionId ? `<div class="wp-actions"><button type="button" class="wp-link" data-cl="open:${esc(t.sessionId)}">${t.session?.open ? '打开作答的会话' : '找回作答的会话'}</button></div>` : ''}</article>`;
    }).join('');
  }
  function render() {
    if (!root || !data) return;
    root.querySelector('.cl-head').innerHTML = head();
    root.querySelector('.wp-list').innerHTML = threads() + consults();
  }
  async function load() {
    if (!root) return;
    try { data = await call('bridge:status'); root.hidden = data.role !== 'home'; render(); }
    catch { root.hidden = true; }
  }
  async function action(name, el) {
    const [verb, arg] = name.split(/:(.*)/s);
    if (verb === 'open') {
      try { await call('bridge:open-session', { sessionId: arg }); await openSession(arg); }
      catch (error) { showMessage?.('打开会话失败：' + error.message); }
      return;
    }
    if (verb === 'copy') { const box = root.querySelector('.cl-code'); box.select(); document.execCommand('copy'); showMessage?.('配对码已复制'); return; }
    if (verb === 'attach') return;
    el.disabled = true;
    try {
      if (verb === 'create') { await call('bridge:create-pairing'); }
      else if (verb === 'send') { await call('bridge:send-pairing'); showMessage?.('配对码已发到公司收件箱：到公司电脑打开收件箱网页复制'); }
      else if (verb === 'check') { await call('bridge:check-now'); }
      else if (verb === 'hub-update') {
        if (!window.confirm('让公司 Hub 更新到发行源上的最新版本？它会等手上的任务答完（最长 30 分钟）再重启，失败自动回滚。')) return;
        await call('bridge:hub-admin', { op: 'update' }); showMessage?.('已发出更新指令：进度会以通知送达');
      }
      else if (verb === 'hub-status') { await call('bridge:hub-admin', { op: 'status' }); showMessage?.('已请公司 Hub 回报状态'); }
      else if (verb === 'unpair') { if (!window.confirm(data.link.state === 'paired' ? '解除和公司 Hub 的配对？之后要重新生成配对码。' : '取消这次配对？')) return; await call('bridge:unpair'); }
      await load();
    } catch (error) { showMessage?.(error.message); }
    finally { if (el.isConnected) el.disabled = false; }
  }
  function mount(container) {
    root = document.createElement('section');
    root.className = 'wp-section cl-section'; root.hidden = true;
    root.innerHTML = '<h2>公司联动</h2><p class="wp-hint">家里的 Agent 需要核对公司代码时，向公司 Hub 的 CodeAgent 提问；回执到了自动发回提问的会话。公司 CodeAgent 遇到难题也会用 ask_home 向家里求助，家里开 Claude 会话作答（不行换 Codex），回复自动发回公司。</p><div class="wp-strip cl-head"></div><div class="wp-list"></div>';
    container.append(root);
    root.addEventListener('click', e => { const b = e.target.closest('[data-cl]'); if (b && b.tagName !== 'SELECT') void action(b.dataset.cl, b); });
    root.addEventListener('change', e => { if (e.target.dataset.cl === 'attach') void call('bridge:set-settings', { attach: e.target.value }).then(load).catch(err => showMessage?.(err.message)); });
    ipcRenderer.on('bridge:changed', () => { if (root.isConnected && !root.closest('[hidden]:not(.cl-section)')) void load(); });
    ipcRenderer.on('bridge:notification', (_e, n) => { if (n?.text) showMessage?.(n.title + '：' + n.text); });
  }
  return { mount, load };
}
module.exports = { createCompanyLinkSection };
