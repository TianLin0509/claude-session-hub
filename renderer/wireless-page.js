'use strict';
// 无线页（左侧「无线」）：首个内容是 SuperRAN 助理——定时查看协作台，已推进、无人接手的提案
// 每个新开一个会话交给 Agent 实现。页面只显示进度与可做的操作，Agent 的过程在各自会话里。
// 写法沿用助理页：盖在主区域上的一层，点左侧其他按钮自动关闭。
function createWirelessPage({ document, window, ipcRenderer, openSession, closeOtherPanels = () => {}, showMessage }) {
  let page = null, data = null, timer = null;
  const TZ = 'Asia/Shanghai';
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clock = at => at ? new Date(at).toLocaleTimeString('zh-CN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
  const when = at => {
    if (!at) return '';
    const d = new Date(at), today = new Date();
    const same = d.toLocaleDateString('zh-CN', { timeZone: TZ }) === today.toLocaleDateString('zh-CN', { timeZone: TZ });
    return same ? clock(at) : d.toLocaleDateString('zh-CN', { timeZone: TZ, month: 'numeric', day: 'numeric' }) + ' ' + clock(at);
  };
  const call = async (channel, payload) => { const r = await ipcRenderer.invoke(channel, payload); if (r && r.ok === false) throw new Error(r.error || '操作未完成'); return r; };
  const EFF = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', ultra: '极限' };
  const STATE = {
    working: ['处理中', 'run'], dispatching: ['正在开会话', 'run'], queued: ['排队中', 'wait'], held: ['待你放行', 'hold'],
    done: ['已交付', 'ok'], released: ['已释放', 'warn'], stalled: ['没跑起来', 'bad'], failed: ['没跑起来', 'bad'],
    skipped: ['不再处理', 'mute'], dismissed: ['你选择不处理', 'mute'],
  };
  const modelLabel = (r) => {
    if (!r) return '';
    const kind = (data?.catalog || []).find(k => k.kind === r.kind);
    const m = kind?.models?.find(x => x.id === r.model);
    return (m?.label || r.model) + ' · ' + (EFF[r.effort] || r.effort || '默认') + (r.kind === 'codex' ? ' · ' + (r.speed === 'fast' ? '快速' : '标准速度') : '');
  };

  function build() {
    if (page) return;
    page = document.createElement('section'); page.className = 'wireless-page'; page.id = 'wireless-page'; page.hidden = true; page.setAttribute('aria-label', '无线');
    page.innerHTML = `<header class="wp-head">
        <div class="wp-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 12v9M9 21h6"/><circle cx="12" cy="10" r="1.6"/><path d="M8.5 6.5a5 5 0 0 0 0 7M15.5 6.5a5 5 0 0 1 0 7M5.6 3.8a9 9 0 0 0 0 12.4M18.4 3.8a9 9 0 0 1 0 12.4"/></svg></div>
        <div class="wp-title"><h1>无线</h1><p>SuperRAN 助理 · 已推进的提案自动交给 Agent 实现，到提交候选 PR 为止</p></div>
        <button type="button" class="wp-switch" data-wp="toggle" role="switch" aria-checked="false">自动接手</button>
        <button type="button" class="wp-btn" data-wp="settings">设置</button>
        <button type="button" class="wp-btn primary" data-wp="check">立即检查</button>
      </header>
      <div class="wp-scroll"><div class="wp-body">
        <section class="wp-strip" aria-label="运行状态"></section>
        <section class="wp-section" data-sec="active"><h2>正在处理</h2><div class="wp-list"></div></section>
        <section class="wp-section" data-sec="held"><h2>待你放行</h2><p class="wp-hint">提案正文里有删除、上传或读凭据这类操作，先停下等你看过。</p><div class="wp-list"></div></section>
        <section class="wp-section" data-sec="queued"><h2>排队</h2><div class="wp-list"></div></section>
        <section class="wp-section" data-sec="recent"><h2>最近结果</h2><div class="wp-list"></div></section>
      </div></div>`;
    document.body.append(page);
    page.addEventListener('click', event => { const b = event.target.closest('[data-wp]'); if (b) void action(b.dataset.wp, b).catch(e => showMessage?.(e.message)); });
  }
  function place() {
    if (!page || page.hidden) return;
    const rail = document.getElementById('scene-rail'), bar = document.getElementById('app-toolbar'), panel = document.getElementById('terminal-panel');
    const left = rail && rail.offsetParent !== null ? rail.getBoundingClientRect().right : 0;
    const top = bar ? bar.getBoundingClientRect().bottom : 0;
    const bottom = panel ? window.innerHeight - panel.getBoundingClientRect().bottom : 0;
    Object.assign(page.style, { left: left + 'px', top: top + 'px', bottom: Math.max(0, bottom) + 'px' });
  }

  function strip() {
    const d = data, s = d.settings, last = d.last || {}, inst = d.install || {};
    const days = inst.kitExpires ? Math.floor((inst.kitExpires - d.now) / 86400000) : null;
    const working = d.jobs.filter(j => ['working', 'dispatching'].includes(j.state)).length;
    const lines = [
      ['协作台', last.error ? `<span class="bad">上次检查 ${clock(last.at)} 失败：${esc(last.error)}</span>` : last.at ? `上次检查 ${clock(last.at)}：${last.total} 份提案，其中 ${last.candidates} 份已推进、待接手` : '还没检查过', d.polling ? '检查中…' : `下次 ${clock(d.nextPollAt)}（每 ${s.pollMinutes} 分钟）`],
      ['接手方式', s.enabled ? `自动：同时最多 ${s.maxParallel} 个，每个提案新开一个会话` : '<span class="warn">自动接手已关：只列出待接手的提案，不派发</span>', `正在处理 ${working}/${s.maxParallel}`],
      ['模型', `主力 ${esc(modelLabel(s.primary))}`, `替补 ${esc(modelLabel(s.fallback))}`],
      ['接入包', inst.ready ? `${esc(inst.user || '')} · ${days == null ? '有效期未知' : days >= 0 ? '还剩 ' + days + ' 天' : '<span class="bad">已过期</span>'}` : '<span class="bad">本机没有接入包：在协作台复制任一提示词交给 Agent 领取一次</span>', inst.root ? '主仓 ' + esc(inst.root) : '<span class="warn">没找到本机 SuperRAN 主安装</span>'],
    ];
    if (!d.owner) lines.push(['提示', '<span class="warn">另一个 Hub 窗口负责定时检查，这里只显示状态</span>', '']);
    return lines.map(([k, a, b]) => `<div class="wp-row"><span class="k">${k}</span><span class="v">${a}</span><span class="r">${b}</span></div>`).join('');
  }
  function item(j) {
    const [label, tone] = STATE[j.state] || [j.state, 'mute'];
    const actions = [];
    if (j.sessionId && j.session) actions.push(`<button type="button" class="wp-link" data-wp="open:${esc(j.sessionId)}">${j.session.open ? '打开会话' : '找回会话'}</button>`);
    if (j.state === 'held') actions.push(`<button type="button" class="wp-btn primary" data-wp="approve:${esc(j.id)}">我看过了，放行</button>`);
    if (['failed', 'stalled', 'released', 'skipped', 'dismissed'].includes(j.state)) actions.push(`<button type="button" class="wp-btn" data-wp="retry:${esc(j.id)}">重来</button>`);
    if (['held', 'queued', 'failed', 'stalled', 'released'].includes(j.state)) actions.push(`<button type="button" class="wp-link" data-wp="dismiss:${esc(j.id)}">不处理</button>`);
    actions.push(`<button type="button" class="wp-link" data-wp="portal">协作台</button>`);
    const live = j.state === 'dispatching' ? '会话启动中' : j.session && j.state === 'working' ? (j.session.busy ? 'Agent 正在干活' : j.session.open ? '会话已停下' : '会话没开着') : '';
    const route = j.kind ? (j.route === 'fallback' ? '替补 ' : '主力 ') + modelLabel({ kind: j.kind, model: j.model, effort: j.effort, speed: j.kind === 'codex' ? data.settings.primary.speed : undefined }) : '';
    const risks = (j.risks || []).map(r => `<li>${esc(r.why)}：<code>${esc(r.sample)}</code></li>`).join('');
    return `<article class="wp-item" data-job="${esc(j.id)}">
      <div class="wp-item-head"><span class="wp-pill ${tone}">${label}</span><strong>${esc(j.title)}</strong>${j.returned ? '<span class="wp-tag">返工</span>' : ''}</div>
      <div class="wp-meta">${esc(j.proposalId)} · 提出人 ${esc(String(j.author || '').replace(/^member:/, ''))}${j.startedAt ? ' · 开始 ' + when(j.startedAt) : ' · 发现 ' + when(j.createdAt)}${j.finishedAt ? ' · 结束 ' + when(j.finishedAt) : ''}${route ? ' · ' + esc(route) : ''}${live ? ' · ' + live : ''}</div>
      ${j.attention ? `<p class="wp-note warn">${esc(j.attention)}</p>` : ''}${j.note ? `<p class="wp-note">${esc(j.note)}</p>` : ''}${risks ? `<ul class="wp-risks">${risks}</ul>` : ''}
      <div class="wp-actions">${actions.join('')}</div></article>`;
  }
  function render() {
    if (!page || !data) return;
    const s = data.settings, jobs = data.jobs;
    const sw = page.querySelector('[data-wp="toggle"]'); sw.setAttribute('aria-checked', String(!!s.enabled)); sw.textContent = s.enabled ? '自动接手：开' : '自动接手：关'; sw.classList.toggle('on', !!s.enabled);
    page.querySelector('[data-wp="check"]').disabled = !!data.polling;
    page.querySelector('.wp-strip').innerHTML = strip();
    const groups = {
      active: jobs.filter(j => ['working', 'dispatching'].includes(j.state)),
      held: jobs.filter(j => j.state === 'held'),
      queued: jobs.filter(j => j.state === 'queued').sort((a, b) => a.createdAt - b.createdAt || (a.order ?? 0) - (b.order ?? 0)),
      recent: jobs.filter(j => !['working', 'dispatching', 'held', 'queued'].includes(j.state)).slice(0, 20),
    };
    const empty = { active: '没有正在处理的提案。', held: '', queued: '没有排队的提案。', recent: '还没有结果。' };
    for (const [key, list] of Object.entries(groups)) {
      const sec = page.querySelector(`[data-sec="${key}"]`);
      sec.hidden = key === 'held' && !list.length;
      sec.querySelector('h2').textContent = { active: `正在处理（${list.length}/${s.maxParallel}）`, held: `待你放行（${list.length}）`, queued: `排队（${list.length}）`, recent: '最近结果' }[key];
      sec.querySelector('.wp-list').innerHTML = list.length ? list.map(item).join('') : `<p class="wp-empty">${empty[key]}</p>`;
    }
  }
  async function load() { data = await call('wireless:status'); render(); }

  async function action(name, button) {
    if (name === 'check') { button.disabled = true; try { data = await call('wireless:check-now'); render(); if (data.last?.error) showMessage?.('检查协作台失败：' + data.last.error); } finally { button.disabled = false; } return; }
    if (name === 'toggle') { await call('wireless:set-settings', { enabled: !data.settings.enabled }); await load(); return; }
    if (name === 'settings') return openSettings();
    if (name === 'portal') { const site = data?.install?.site; if (site) void ipcRenderer.invoke('open-external-url', site); return; }
    const [verb, id] = name.split(/:(.*)/s);
    if (verb === 'open') { close(); await openSession(id); return; }
    if (['approve', 'retry', 'dismiss'].includes(verb)) { button.disabled = true; data = await call('wireless:act', { id, action: verb }); render(); }
  }

  function openSettings() {
    page.querySelector('.wp-settings')?.remove();
    const s = data.settings, cat = data.catalog || [];
    const opts = (list, cur, label = x => x) => list.map(x => `<option value="${esc(typeof x === 'string' ? x : x.id)}"${(typeof x === 'string' ? x : x.id) === cur ? ' selected' : ''}>${esc(label(x))}</option>`).join('');
    const routeForm = (route, title) => `<fieldset data-route="${route}"><legend>${title}</legend>
      <label>后端<select data-f="kind">${opts(cat.map(k => ({ id: k.kind, label: k.label })), s[route].kind, x => x.label)}</select></label>
      <label>模型<select data-f="model"></select></label><label>思考深度<select data-f="effort"></select></label>
      <label data-speed>速度<select data-f="speed"><option value="standard">标准</option><option value="fast">快速</option></select></label></fieldset>`;
    const box = document.createElement('div'); box.className = 'wp-settings'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'SuperRAN 助理设置');
    box.innerHTML = `<h3>SuperRAN 助理设置</h3>${routeForm('primary', '主力')}${routeForm('fallback', '替补（主力开不起来或没接手时用）')}
      <fieldset><legend>节奏</legend><label>同时处理<select data-f="maxParallel">${opts(['1', '2', '3', '4'], String(s.maxParallel), x => x + ' 个')}</select></label>
      <label>检查间隔<select data-f="pollMinutes">${opts(['5', '10', '15', '30', '60'], String(s.pollMinutes), x => x + ' 分钟')}</select></label></fieldset>
      <div class="wp-settings-row"><button type="button" class="wp-btn" data-x="cancel">取消</button><button type="button" class="wp-btn primary" data-x="save">保存</button></div>`;
    page.querySelector('.wp-body').prepend(box);
    for (const fs of box.querySelectorAll('fieldset[data-route]')) {
      const route = fs.dataset.route, sel = f => fs.querySelector(`[data-f="${f}"]`);
      const fill = keep => {
        const k = cat.find(x => x.kind === sel('kind').value) || cat[0];
        const models = k?.models || [];
        const cur = keep && models.some(m => m.id === s[route].model) ? s[route].model : k?.defaultModel || models[0]?.id;
        sel('model').innerHTML = opts(models, cur, m => m.label || m.id);
        const effs = () => (models.find(m => m.id === sel('model').value)?.efforts) || k?.efforts || [];
        const paint = keepE => { const list = effs(); const e = keepE && list.includes(s[route].effort) ? s[route].effort : list.includes('max') ? 'max' : list[0]; sel('effort').innerHTML = opts(list, e, x => EFF[x] || x); sel('effort').closest('label').hidden = !list.length; };
        paint(keep); sel('model').onchange = () => paint(false);
        fs.querySelector('[data-speed]').hidden = sel('kind').value !== 'codex';
        sel('speed').value = s[route].speed === 'fast' ? 'fast' : 'standard';
      };
      fill(true); sel('kind').onchange = () => fill(false);
    }
    box.addEventListener('click', async e => {
      const x = e.target.closest('[data-x]')?.dataset.x; if (!x) return;
      if (x === 'cancel') { box.remove(); return; }
      const route = r => { const fs = box.querySelector(`fieldset[data-route="${r}"]`), v = f => fs.querySelector(`[data-f="${f}"]`).value; return { kind: v('kind'), model: v('model'), effort: v('effort') || undefined, speed: v('speed') }; };
      const btn = e.target; btn.disabled = true;
      try { await call('wireless:set-settings', { primary: route('primary'), fallback: route('fallback'), maxParallel: Number(box.querySelector('[data-f="maxParallel"]').value), pollMinutes: Number(box.querySelector('[data-f="pollMinutes"]').value) }); box.remove(); await load(); }
      catch (error) { btn.disabled = false; showMessage?.('没有保存：' + error.message); }
    });
  }

  const onResize = () => place();
  async function open() {
    build(); closeOtherPanels(); window.__assistantHide?.();
    page.hidden = false; document.body.classList.add('wireless-page-open'); place();
    document.getElementById('btn-wireless')?.classList.add('active');
    document.getElementById('btn-wireless')?.classList.remove('wireless-has-unread');
    window.addEventListener('resize', onResize);
    clearInterval(timer); timer = setInterval(() => { void load().catch(() => {}); }, 30000);
    try { await load(); } catch (error) { showMessage?.('SuperRAN 助理状态读取失败：' + error.message); }
  }
  function close() {
    if (!page || page.hidden) return;
    page.hidden = true; document.body.classList.remove('wireless-page-open');
    document.getElementById('btn-wireless')?.classList.remove('active');
    clearInterval(timer); timer = null; window.removeEventListener('resize', onResize);
  }
  document.addEventListener('click', e => { if (page && !page.hidden && e.target.closest('#scene-rail button:not(#btn-wireless)')) close(); });
  ipcRenderer.on('wireless:changed', () => { if (page && !page.hidden) void load().catch(() => {}); });
  ipcRenderer.on('wireless:notification', (_e, notice) => {
    if (notice?.text) showMessage?.(notice.title + '：' + notice.text);
    if (!page || page.hidden) document.getElementById('btn-wireless')?.classList.add('wireless-has-unread');
  });
  document.getElementById('btn-wireless')?.addEventListener('click', () => { void open(); });
  return { open, close, isOpen: () => !!page && !page.hidden };
}
module.exports = { createWirelessPage };
