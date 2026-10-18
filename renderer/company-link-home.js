'use strict';
// 无线页里的「公司联动」（2026-10-15，家里一端）：配对、公司是否在线、家里的 Agent 向公司提过的问题和回执。
// 问答本身由 Agent 通过「问公司」工具或 company-ask 命令发起，这里只看进度、管配对和挂载范围。
function createCompanyLinkSection({ document, ipcRenderer, openSession, showMessage }) {
  let root = null, data = null, images = null;
  // 特战队（2026-10-18）：组长视图的成员列表（打开本页时拉一次）和刚新建的邀请码（只显示这一次）。
  let members = null, membersError = null, freshInvite = null;
  // 「公司电脑状态」（2026-10-18 直查）：弹出卡片，等公司 Hub 直接采集回报。
  const diagCard = require('./company-diag-card').createCompanyDiagCard({ document, ipcRenderer, showMessage });
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clock = at => at ? new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
  const call = async (channel, payload) => { const r = await ipcRenderer.invoke(channel, payload); if (r && r.ok === false) throw new Error(r.error || '操作未完成'); return r; };
  const ROUND = { sent: ['已发出', 'wait'], received: ['公司已收到', 'wait'], running: ['公司在处理', 'run'], replied: ['已回执', 'ok'], error: ['公司报错', 'bad'] };
  const CONSULT = { queued: ['排队', 'wait'], running: ['家里在作答', 'run'], replied: ['已回复公司', 'ok'], failed: ['没答上', 'bad'], cancelled: ['已作废', 'mute'] };
  const AGENT = { claude: 'Claude', codex: 'Codex' };

  // 通道来源：同事用邀请码接入团队入口；还没有邀请码时先粘贴，生成配对码要等有了通道地址。
  function inviteRow() {
    const team = data.team || {};
    if (team.needsInvite) return `<div class="wp-row cl-invite"><span class="k">邀请码</span><span class="v">先粘贴组长发的邀请码（以 AIHUB-TZ-1. 开头），保存后就能生成配对码。邀请码只给你自己用，别转发。<textarea class="cl-code" data-cl-input="invite" rows="3" placeholder="AIHUB-TZ-1.…"></textarea></span><span class="r"><button type="button" class="wp-btn primary" data-cl="invite-save">保存</button></span></div>`;
    if (!team.invite) return '';
    return `<div class="wp-row"><span class="k">通道</span><span class="v">特战队团队入口${team.invite.label ? ' · ' + esc(team.invite.label) : ''} · ${esc(team.invite.host)}${team.skills?.installed?.length ? ` · 已装团队版 skill（${team.skills.installed.length} 处）` : ''}</span><span class="r">${data.link.state === 'none' ? '<button type="button" class="wp-link" data-cl="invite-clear">换邀请码</button>' : ''}</span></div>`;
  }
  function head() {
    const st = data.link.state, net = data.net || {};
    if (st === 'none' && data.team?.needsInvite) return inviteRow();
    if (st === 'none') return inviteRow() + `<div class="wp-row"><span class="k">状态</span><span class="v">还没和公司 Hub 配对。配对后，Hub 新开的会话里的 Agent 可以请公司电脑上的 CodeAgent 办事：查 AirView / L2 代码、查公司电脑上的文件与环境（不改动公司电脑，回执不含源码）。</span><span class="r"><button type="button" class="wp-btn primary" data-cl="create">生成配对码</button></span></div>`;
    if (st === 'pending') return `<div class="wp-row"><span class="k">配对码</span><span class="v">把下面整段发到公司电脑，在公司 Hub「设置菜单 → AI特战队专用功能」里粘贴。公司确认后这段就作废了。<textarea class="cl-code" readonly rows="4">${esc(data.link.pairingCode || '')}</textarea></span>
      <span class="r cl-col">${data.team?.inbox ? '<button type="button" class="wp-btn primary" data-cl="send">发到公司收件箱</button>' : ''}<button type="button" class="wp-btn${data.team?.inbox ? '' : ' primary'}" data-cl="copy">复制</button><button type="button" class="wp-link" data-cl="unpair">取消</button></span></div>
      <div class="wp-row"><span class="k">等待</span><span class="v">${net.lastError ? `<span class="bad">通道连不上：${esc(net.lastError.message)}</span>` : `等公司 Hub 粘贴配对码……${data.polling ? `（每 ${esc(data.polling.intervalSeconds)} 秒检查）` : ''}`}</span><span class="r"><button type="button" class="wp-link" data-cl="check">立即检查</button></span></div>`;
    const peer = data.peer || {};
    return inviteRow() + `<div class="wp-row"><span class="k">状态</span><span class="v">已接通 · 公司 Hub ${esc(peer.companyLastSeen || '')}${net.lastError ? ` · <span class="bad">上次连通道失败：${esc(net.lastError.message)}</span>` : ''}${data.link.outbox ? ` · 待发 ${data.link.outbox} 条` : ''}</span><span class="r"><button type="button" class="wp-link" data-cl="check">立即检查</button><button type="button" class="wp-link" data-cl="unpair">解除配对</button></span></div>
      ${data.polling ? `<div class="wp-row"><span class="k">检查频率</span><span class="v">${data.polling.active ? '联动中' : '空闲中'} · 本机每 ${esc(data.polling.intervalSeconds)} 秒检查回执</span><span class="r"></span></div>` : ''}
      ${hubRow()}
      <div class="wp-row"><span class="k">挂给谁</span><span class="v"><select data-cl="attach"><option value="wireless"${data.settings.attach === 'wireless' ? ' selected' : ''}>SuperRAN 相关会话（无线助理开的、目录在 SuperRAN 下的）</option><option value="all"${data.settings.attach === 'all' ? ' selected' : ''}>所有 Codex / Claude 会话</option></select></span><span class="r">新开的会话生效；其余会话可用 company-ask 命令</span></div>`;
  }
  // 公司 Hub 的版本与远程更新（2026-10-17）：和会话里的 company_hub_update 工具同一个动作，进度以通知送达。
  function hubRow() {
    const h = data.companyHub || {}, last = (h.recent || [])[0];
    const ver = h.version ? 'v' + esc(h.version) : '版本未知（公司 Hub 升到 2.1.8 后会自动报）';
    return `<div class="wp-row cl-hub"><span class="k">公司 Hub</span><span class="v">${ver} · 上次在线 ${esc((data.peer || {}).companyLastSeen || '')}${last && last.phase !== 'online' ? ` · 最近：${esc(last.note)}（${clock(last.at)}）` : ''}${h.pending?.length ? ' · 指令执行中' : ''}</span>
      <span class="r"><button type="button" class="wp-btn" data-cl="diag" title="公司 Hub 直接读取电脑和自身状态后回报：秒级、不经 CodeAgent、不排队">公司电脑状态</button><button type="button" class="wp-btn" data-cl="hub-update">让公司 Hub 更新</button><button type="button" class="wp-link" data-cl="hub-status">查状态</button></span></div>`;
  }
  // 组长视图：新建 / 收回同事的邀请码。服务器只存钥匙的哈希，邀请码只在新建这一刻出现。
  function teamBlock() {
    if (!data.team?.admin) return '';
    const fresh = freshInvite ? `<div class="wp-row"><span class="k">新邀请码</span><span class="v">发给「${esc(freshInvite.label)}」，在他家里 Hub 无线页「公司联动」里粘贴。只显示这一次，关掉本页就看不到了。<textarea class="cl-code" data-cl-input="fresh" readonly rows="3">${esc(freshInvite.invite)}</textarea></span><span class="r cl-col"><button type="button" class="wp-btn primary" data-cl="fresh-copy">复制</button><button type="button" class="wp-link" data-cl="fresh-hide">收起</button></span></div>` : '';
    const rows = membersError ? `<p class="wp-note warn">成员列表读取失败：${esc(membersError)}</p>`
      : !members ? '<p class="wp-empty">读取中……</p>'
      : !members.length ? '<p class="wp-empty">还没有发过邀请码。</p>'
      : members.map(m => `<div class="wp-row cl-member"><span class="k">${esc(m.label || '同事')}</span><span class="v">${m.revoked_at ? `<span class="wp-pill mute">已收回</span> ${clock(Date.parse(m.revoked_at))}` : '<span class="wp-pill ok">在用</span>'} · 发放于 ${clock(Date.parse(m.created_at))}${m.last_seen ? ' · 最近在线 ' + clock(Date.parse(m.last_seen)) : ' · 暂无在线记录'} · 通道 ${esc(m.channels)} 条</span><span class="r">${m.revoked_at ? '' : `<button type="button" class="wp-link" data-cl="revoke:${esc(m.id)}">收回</button>`}</span></div>`).join('');
    return `<h3 class="cl-sub">特战队成员</h3><p class="wp-hint">给同事发邀请码，他们共用这台服务器的团队入口：每人一把钥匙、各自限额，收回后他的通道立即失效，你自己的通道不受影响。</p>
      <div class="wp-strip cl-team"><div class="wp-row"><span class="k">新建</span><span class="v"><input class="cl-label" data-cl-input="label" maxlength="24" placeholder="称呼，例如：同事"></span><span class="r"><button type="button" class="wp-btn primary" data-cl="team-create">生成邀请码</button><button type="button" class="wp-link" data-cl="team-refresh">刷新</button></span></div>${fresh}${rows}</div>`;
  }
  async function loadMembers() {
    if (!data?.team?.admin) return;
    try { members = (await call('bridge:team-members')).members || []; membersError = null; }
    catch (error) { membersError = error.message; }
    render();
  }
  function threads() {
    const list = (data.threads || []).slice(0, 30);
    if (!list.length) return data.link.state === 'paired' ? '<p class="wp-empty">还没有向公司提过问题。</p>' : '';
    return list.map(t => {
      const last = t.rounds[t.rounds.length - 1] || {};
      const [label, tone] = ROUND[last.status] || [last.status, 'mute'];
      const undelivered = t.rounds.some(r => (r.reply || r.error) && !r.delivered);
      const rounds = t.rounds.map(r => `<div class="cl-round"><b>第 ${r.round} 轮</b> <span class="wp-meta">问于 ${clock(r.sentAt)}${r.replyAt ? ' · 回执 ' + clock(r.replyAt) : ''}${r.meta?.model ? ' · ' + esc(r.meta.model) : ''}${r.meta?.elapsedSec ? ' · 用时 ' + Math.round(r.meta.elapsedSec / 60) + ' 分钟' : ''}${r.deliveryError ? ' · <span class="bad">' + esc(r.deliveryError) + '</span>' : ''}${r.deliveryNote ? ' · ' + esc(r.deliveryNote) : ''}</span>
        <pre>${esc(r.question)}</pre>${r.reply ? `<pre class="ans">${esc(r.reply)}</pre>` : ''}${r.error ? `<p class="wp-note warn">${esc(r.error)}</p>` : ''}</div>`).join('');
      return `<article class="wp-item"><div class="wp-item-head"><span class="wp-pill ${tone}">${label}</span><strong>${esc(t.id)} · ${esc(t.title)}</strong>${undelivered ? '<span class="wp-tag">等会话停下再送</span>' : ''}</div>
        <div class="wp-meta">来自会话「${esc(t.session?.title || t.sessionTitle || t.sessionId)}」 · ${t.rounds.length} 轮 · 发起 ${clock(t.createdAt)}${t.model ? ' · 指定模型 ' + esc(t.model) : ''}</div>
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
    // 通道一有动静就会重绘：先记下正在填的邀请码 / 称呼和焦点，重绘后放回去，免得打到一半被清空。
    const typed = {}, focused = document.activeElement?.dataset?.clInput || null;
    root.querySelectorAll('[data-cl-input]:not([readonly])').forEach(el => { typed[el.dataset.clInput] = el.value; });
    root.querySelector('.cl-head').innerHTML = head();
    root.querySelector('.cl-team-root').innerHTML = teamBlock();
    for (const [key, value] of Object.entries(typed)) { const el = root.querySelector(`[data-cl-input="${key}"]`); if (el && !el.readOnly) el.value = value; }
    if (focused) root.querySelector(`[data-cl-input="${focused}"]`)?.focus();
    root.querySelector('.wp-list').innerHTML = threads() + consults();
    images?.update(data);
  }
  async function load() {
    if (!root) return;
    try { data = await call('bridge:status'); root.hidden = data.role !== 'home'; render(); if (data.team?.admin && !members && !membersError) void loadMembers(); }
    catch { root.hidden = true; }
  }
  async function action(name, el) {
    const [verb, arg] = name.split(/:(.*)/s);
    if (verb === 'open') {
      try { await call('bridge:open-session', { sessionId: arg }); await openSession(arg); }
      catch (error) { showMessage?.('打开会话失败：' + error.message); }
      return;
    }
    if (verb === 'copy') { const box = root.querySelector('.cl-head .cl-code'); box.select(); document.execCommand('copy'); showMessage?.('配对码已复制'); return; }
    if (verb === 'fresh-copy') { const box = root.querySelector('[data-cl-input="fresh"]'); box.select(); document.execCommand('copy'); showMessage?.('邀请码已复制'); return; }
    if (verb === 'fresh-hide') { freshInvite = null; render(); return; }
    if (verb === 'diag') { diagCard.open(); return; }
    if (verb === 'attach') return;
    el.disabled = true;
    try {
      if (verb === 'create') { await call('bridge:create-pairing'); }
      else if (verb === 'invite-save') { await call('bridge:set-invite', { code: root.querySelector('[data-cl-input="invite"]').value }); showMessage?.('邀请码已保存：现在可以生成配对码了'); }
      else if (verb === 'invite-clear') { if (!window.confirm('清除现在的邀请码，改贴一个新的？')) return; await call('bridge:clear-invite'); }
      else if (verb === 'team-create') {
        const label = root.querySelector('[data-cl-input="label"]').value.trim() || '同事';
        const r = await call('bridge:team-create', { label });
        freshInvite = { label: r.member?.label || label, invite: r.invite };
        await loadMembers();
      }
      else if (verb === 'team-refresh') { await loadMembers(); }
      else if (verb === 'revoke') {
        const m = (members || []).find(x => x.id === arg);
        if (!window.confirm(`收回「${m?.label || arg}」的邀请码？他的通道会立即失效，要继续用得重新发一个。`)) return;
        await call('bridge:team-revoke', { id: arg }); showMessage?.('已收回'); await loadMembers();
      }
      else if (verb === 'send') { await call('bridge:send-pairing'); showMessage?.('配对码已发到公司收件箱：到公司电脑打开收件箱网页复制'); }
      else if (verb === 'check') { await call('bridge:check-now'); }
      else if (verb === 'hub-update') {
        if (!window.confirm('让公司 Hub 更新到发行源上的最新版本？它会先等手上的任务答完（默认最多 3 分钟，到时先记下、中断，重启后自动接着做）再重启，失败自动回滚。')) return;
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
    root.innerHTML = '<h2>公司联动</h2><p class="wp-hint">家里的 Agent 需要核对公司代码时，向公司 Hub 的 CodeAgent 提问；回执到了自动发回提问的会话。公司 CodeAgent 遇到难题也会用 ask_home 向家里求助，家里开 Claude 会话作答（不行换 Codex），回复自动发回公司。</p><div class="wp-strip cl-head"></div><div class="cl-team-root"></div><div class="wp-list"></div>';
    container.append(root);
    images = require('./bridge-images').createBridgeImages({ document, ipcRenderer, refresh: load });
    root.insertBefore(images.root, root.querySelector('.wp-list'));
    root.addEventListener('click', e => { const b = e.target.closest('[data-cl]'); if (b && b.tagName !== 'SELECT') void action(b.dataset.cl, b); });
    root.addEventListener('change', e => { if (e.target.dataset.cl === 'attach') void call('bridge:set-settings', { attach: e.target.value }).then(load).catch(err => showMessage?.(err.message)); });
    ipcRenderer.on('bridge:changed', () => { if (root.isConnected && !root.closest('[hidden]:not(.cl-section)')) void load(); });
    ipcRenderer.on('bridge:notification', (_e, n) => { if (n?.text) showMessage?.(n.title + '：' + n.text); });
  }
  return { mount, load };
}
module.exports = { createCompanyLinkSection };
