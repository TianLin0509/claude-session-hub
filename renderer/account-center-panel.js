'use strict';
const { companyCards, attentionCount } = require('./account-center-view');
const { toolAccountsHtml } = require('./tool-accounts-view');
function createAccountCenterPanel({ document, ipcRenderer, escapeHtml: esc, configModal, closeOtherPanels = () => {} }) {
  const page = document.getElementById('account-page'), body = page.querySelector('.ac-content');
  let state = null, signature = '', view = 'list', error = '', notice = '', busy = '', timer, previousFocus, epoch = 0, request = 0;
  let toolGroups = null;
  let toolAccounts = null, toolAccountsError = '', toolAccountsFlight = null;
  const toolChoices = {};
  const checking = () => state?.progress?.status === 'running';
  async function call(action, args) {
    const r = await ipcRenderer.invoke('hub-accounts:' + action, args);
    if (!r?.ok) throw Error(r?.error || '账号服务未响应');
    return r.data;
  }
  function renderStatus() {
    const el = page.querySelector('.ac-status'), text = error || notice;
    el.textContent = text; el.hidden = !text; el.classList.toggle('error', !!error);
    for (const b of page.querySelectorAll('[data-ac="check"],[data-ac="open"],[data-ac="login"],[data-ac="add"],[data-ac="preferred"],[data-ac="authorize"],[data-ac="tools"],[data-ac="tools-connect"],[data-ac="external"]')) b.disabled = !!busy || checking() || state?.setupProgress?.status === 'running';
    const b = page.querySelector('.ac-head-actions [data-ac="check"]');
    b.textContent = checking() ? '正在检查…' : '检查全部登录';
  }
  function timeText(value) {
    if (!value) return '';
    return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + ' 检查';
  }
  function cardHtml(card) {
    const rows = card.accounts.map(a => `<div class="ac-account" data-identity="${a.identity}">
      <div class="ac-account-title"><span>${esc(a.label)}</span>${a.preferred ? '<span class="ac-default">默认打开</span>' : `<button class="ac-text-btn" data-ac="preferred" data-site="${card.site}" data-identity="${a.identity}">设为默认</button>`}</div>
      <div class="ac-account-email" title="${esc(a.account)}">${esc(a.account)}</div>
      ${a.accountStale ? '<small class="ac-time">上次识别的账号</small>' : ''}
      <div class="ac-account-bottom"><span class="ac-state ${a.tone}">${esc(a.status)}</span><button class="ac-text-btn" data-ac="${a.tone === 'warn' && !a.restricted ? 'login' : 'open'}" data-site="${card.site}" data-identity="${a.identity}" aria-label="打开 ${esc(card.product)} ${esc(a.label)}">${a.restricted ? '打开确认' : a.tone === 'warn' ? '去登录' : '打开'} ↗</button></div>
      ${a.checkedAt ? `<small class="ac-time">${esc(timeText(a.checkedAt))}</small>` : ''}
      ${a.error ? `<small class="ac-item-error">${esc(a.error)}</small>` : ''}</div>`).join('');
    const cli = card.clis.length ? `<details class="ac-cli" data-details="${card.site}"><summary>命令行授权 <span>${card.clis.length}</span></summary><p>CLI 凭据由原工具保管，网页登录与授权分别确认。</p>${card.clis.map(c => `<div class="ac-cli-row"><span>${esc(c.text)}${c.account ? '<small>' + esc(c.account) + '</small>' : ''}</span><button class="ac-text-btn" data-ac="authorize" data-id="${esc(c.id)}">授权</button></div>`).join('')}</details>` : '';
    return `<article class="ac-company" data-site="${card.site}" style="--ac-company-color:${card.color}"><header><span class="ac-company-mark">${card.mark}</span><div><h2>${esc(card.company)}</h2><span>${esc(card.product)}</span></div><kbd title="仅在账号页生效">Alt+${card.shortcut}</kbd></header>
      <div class="ac-accounts">${rows}</div>
      ${card.accounts.length < 2 ? `<button class="ac-add" data-ac="add" data-site="${card.site}" data-identity="alt">＋ 添加第二个账号</button>` : ''}
      <button class="ac-launch" data-ac="open" data-site="${card.site}">打开 ${esc(card.product)} <span>↗</span></button>${cli}</article>`;
  }
  function progressHtml() {
    const p = state?.progress;
    if (!p) return '';
    const card = companyCards(state).find(c => c.site === p.current?.site);
    const current = card ? card.company + ' / ' + (p.current.identity === 'main' ? '账号 1' : '账号 2') : '';
    const unknown = p.items.filter(i => i.state === 'unknown').length;
    const signedOut = p.items.filter(i => i.state === 'signed_out').length;
    const restricted = p.items.filter(i => i.reason === 'headless_challenge').length;
    const challenges = p.items.filter(i => i.state === 'needs_attention' && i.reason !== 'headless_challenge').length;
    const summary = [unknown ? unknown + ' 项暂未确认（不代表退出登录）' : '', restricted ? restricted + ' 项后台检查受网站验证限制' : '', signedOut ? signedOut + ' 项需要登录' : '', challenges ? challenges + ' 项需要验证' : ''].filter(Boolean).join('；') || '结果已保留';
    return `<section class="ac-progress" data-check-id="${esc(p.id)}" aria-label="登录检查进度"><div class="ac-progress-heading"><strong>${p.status === 'running' ? '后台检查' : esc(p.stage)} <span>${p.done} / ${p.total}</span></strong>${p.status === 'running' ? '<button class="ac-text-btn" data-ac="cancel">取消检查</button>' : ''}</div>
    <progress value="${p.done}" max="${p.total}" aria-label="已检查账号数"></progress><div class="ac-progress-copy"><span>${esc(current ? current + ' · ' + p.stage : p.error || summary)}</span><small>串行检查 · 无头运行 · 不打扰当前窗口</small></div>
    ${p.warnings?.length ? '<p class="ac-item-error">' + esc(p.warnings.join('；')) + '</p>' : ''}</section>`;
  }
  function toolsHtml() {
    const progress = state?.setupProgress;
    const status = progress ? `<p class="ac-tool-help" role="status">${esc(progress.error || progress.stage)}</p>` : '';
    if (!toolGroups) return `<button class="ac-btn" data-ac="tools">统一接入专属 Chrome</button>${status}`;
    const options = (state.identities || []).map(i => ({ id: i.id, label: (i.id === 'main' ? '账号 1' : '账号 2') + ' · ' + (i.account || '身份待确认') }));
    return `<div class="ac-tool-setup"><p>为工具选择它原来使用的 ChatGPT 账号。接入会等待工具空闲，保留任务、历史和旧登录资料。</p>${toolGroups.map(g => `<label><span>${esc(g.name)}${g.labels?.length ? ' · ' + esc(g.labels.join(' / ')) : ''}<small>${g.lanes} 个工作页面</small></span><select data-tool-choice="${esc(g.id)}"><option value="">请选择对应账号</option>${options.map(o => `<option value="${o.id}" ${toolChoices[g.id] === o.id ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`).join('')}<button class="ac-btn" data-ac="tools-connect" ${progress?.status === 'running' ? 'disabled' : ''}>保存并接入</button>${status}</div>`;
  }
  function render() {
    if (page.hidden) return;
    position();
    const n = state ? attentionCount(state) : 0, count = document.getElementById('accounts-attention');
    if (count) { count.textContent = n; count.hidden = !n; }
    document.getElementById('account-editor').hidden = view !== 'config'; body.hidden = view === 'config';
    page.querySelector('[data-ac="back"]').hidden = view !== 'config';
    if (view === 'config') return renderStatus();
    if (!state) { body.innerHTML = '<p class="ac-empty">正在读取账号…</p>'; return renderStatus(); }
    const expanded = [...body.querySelectorAll('details[open]')].map(d => d.dataset.details);
    const chromeText = state.chrome.loginOpen ? '网页窗口正在使用 · 沿用现有登录' : state.chrome.running && !checking() ? '网页工具正在使用' : '沿用现有登录 · 按需启动';
    body.innerHTML = `<div class="ac-browser-bar"><span class="ac-browser-icon">▣</span><div><strong>AI Hub 专属 Chrome</strong><span class="ac-chrome">${chromeText}</span></div><small>所有 AI 网页的统一入口</small></div>
    ${progressHtml()}<div class="ac-section-heading"><h2>AI 公司与账号</h2><span>选账号，直接打开网页 <span class="ac-key-hint">· Alt + 1–7</span></span></div>
    <div class="ac-companies">${companyCards(state).map(cardHtml).join('')}</div>
    <section class="ac-tools"><div><h2>网页工具连接</h2><p>登录资料统一保留在专属 Chrome，各工具使用自己的任务页面。</p></div><div class="ac-tool-list"><span>网页圆桌 <b>共用专属 Chrome</b></span>${(state.tools || []).map(t => `<span>${esc(t.name)} <b class="${t.state === 'connected' ? '' : 'warn'}">${t.state === 'connected' ? '已接入' : t.state === 'changed' ? '接入配置已变化' : '待接入'}</b></span>`).join('')}</div><p class="ac-tool-help">待接入的工具需完成浏览器绑定，避免在另一份浏览器里重复登录。</p></section>
    ${toolsHtml()}<section class="ac-tool-account-section">${toolAccountsHtml(toolAccounts, esc, toolAccountsError)}</section><p class="ac-evidence">“有登录记录”与“上次已登录”来自本机记录；本次官网确认后才显示“已登录”。快捷键仅在此页生效。</p>`;
    for (const d of body.querySelectorAll('details')) d.open = expanded.includes(d.dataset.details);
    renderStatus();
  }
  function apply(next) {
    const sig = JSON.stringify(next);
    if (sig === signature) return renderStatus();
    const top = body.scrollTop, focus = page.contains(document.activeElement) ? { ...document.activeElement.dataset } : null;
    state = next; signature = sig; render();
    if (focus && Object.keys(focus).length) [...page.querySelectorAll('button')].find(b => Object.entries(focus).every(([k, v]) => b.dataset[k] === v))?.focus({ preventScroll: true });
    body.scrollTop = top;
  }
  function renderTools() {
    const top = body.scrollTop, focus = page.contains(document.activeElement) ? { ...document.activeElement.dataset } : null;
    render();
    if (focus && Object.keys(focus).length) [...page.querySelectorAll('button,select')].find(b => Object.entries(focus).every(([k, v]) => b.dataset[k] === v))?.focus({ preventScroll: true });
    body.scrollTop = top;
  }
  function position() {
    const rail = document.getElementById('scene-rail')?.getBoundingClientRect();
    if (rail) { page.style.left = rail.right + 'px'; page.style.top = rail.top + 'px'; }
  }
  function schedule() {
    clearTimeout(timer);
    if (!page.hidden && view === 'list') timer = setTimeout(() => void refresh(), checking() || state?.setupProgress?.status === 'running' ? 500 : 15000);
  }
  async function refresh() {
    const ticket = epoch, seq = ++request;
    try { const next = await call('state'); if (ticket === epoch && seq === request && !page.hidden) {
      const newlyConnected = next.setupProgress?.status === 'complete' && state?.setupProgress?.status !== 'complete';
      apply(next); if (newlyConnected) void refreshToolAccounts();
    } }
    catch (e) { if (ticket === epoch && !page.hidden) { error = e.message; renderStatus(); } }
    finally { schedule(); }
  }
  async function refreshToolAccounts(force = false) {
    if (toolAccountsFlight) return toolAccountsFlight;
    const ticket = epoch;
    toolAccountsError = '';
    toolAccountsFlight = call('tool-accounts', { refresh: force }).then(data => {
      if (ticket === epoch && !page.hidden) { toolAccounts = data; renderTools(); }
    }).catch(e => { if (ticket === epoch && !page.hidden) { toolAccountsError = e.message; renderTools(); } })
      .finally(() => { toolAccountsFlight = null; if (ticket !== epoch && !page.hidden) void refreshToolAccounts(); });
    return toolAccountsFlight;
  }
  async function action(name, args) {
    if (busy) return;
    busy = name; error = ''; notice = ''; renderStatus();
    if (name === 'external') { notice = args.action === 'check' ? '正在联系 GitHub 检查授权…' : '正在打开官方入口…'; renderStatus(); }
    const ticket = epoch; ++request;
    try {
      const result = await call(name, args);
      if (ticket !== epoch) return;
      if (name === 'tools') { toolGroups = result.groups; if (!toolGroups.length) notice = '未发现需要接入的生图或中转工具'; render(); }
      else if (name === 'tools-connect') { state.setupProgress = result; render(); }
      else if (name === 'external') { notice = result.message; await refreshToolAccounts(); }
      else if (name === 'open' || name === 'login') { notice = result.message; await refresh(); }
      else apply(result);
    } catch (e) { if (ticket === epoch) error = e.message; }
    finally { busy = ''; if (ticket === epoch) renderStatus(); schedule(); }
  }
  async function authorize(id) {
    if (busy || checking()) return;
    busy = 'authorize'; error = ''; notice = ''; renderStatus();
    const ticket = epoch;
    try {
      const nativeId = id.startsWith('codex:') ? id.replace('codex:', 'codex-') : ({ gemini: 'gemini-cli' }[id] || id);
      const r = await ipcRenderer.invoke('accounts:login', { id: nativeId });
      if (!r?.ok) throw Error(r?.error || '授权入口未打开');
      if (ticket === epoch) notice = r.data?.message || '已打开官方授权入口';
    } catch (e) { if (ticket === epoch) error = e.message; }
    finally { busy = ''; if (ticket === epoch) renderStatus(); }
  }
  async function configure(provider = 'codex') {
    try { await configModal.openAccountConfig(provider); if (!page.hidden) { view = 'config'; render(); } }
    catch (e) { error = e.message; renderStatus(); }
  }
  function close() {
    if (page.hidden) return;
    page.hidden = true; epoch++; clearTimeout(timer);
    document.body.classList.remove('accounts-open');
    document.getElementById('btn-rail-accounts')?.setAttribute('aria-expanded', 'false');
    if (previousFocus?.isConnected) previousFocus.focus();
  }
  async function open(provider) {
    closeOtherPanels(); configModal.close();
    epoch++; clearTimeout(timer); previousFocus = document.activeElement;
    page.hidden = false; document.body.classList.add('accounts-open');
    document.getElementById('btn-rail-accounts')?.setAttribute('aria-expanded', 'true');
    view = 'list'; error = ''; notice = ''; render(); await refresh();
    void refreshToolAccounts();
    if (provider && !page.hidden) await configure(provider);
  }
  page.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    const a = b.dataset.ac, args = { site: b.dataset.site, identity: b.dataset.identity };
    if (a === 'close') close();
    else if (a === 'back') { view = 'list'; render(); void refresh(); }
    else if (a === 'check') void action('check-start', args);
    else if (a === 'cancel') void action('check-cancel');
    else if (a === 'open') void action('open', args);
    else if (a === 'login') void action('login', args);
    else if (a === 'add' || a === 'preferred') void action('preference', { ...args, add: a === 'add' });
    else if (a === 'authorize') void authorize(b.dataset.id);
    else if (a === 'config') void configure(b.dataset.id);
    else if (a === 'tools') void action('tools');
    else if (a === 'external') void action('external', { service: b.dataset.service, action: b.dataset.operation });
    else if (a === 'tool-accounts-refresh') void refreshToolAccounts(true);
    else if (a === 'tools-connect') {
      const choices = Object.fromEntries(Object.entries(toolChoices).filter(([, value]) => value));
      if (!Object.keys(choices).length) { error = '请先选择工具对应的 ChatGPT 账号'; renderStatus(); }
      else void action('tools-connect', { choices });
    }
  });
  page.addEventListener('change', e => { if (e.target.dataset.toolChoice) toolChoices[e.target.dataset.toolChoice] = e.target.value; });
  document.addEventListener('click', e => {
    if (e.target.closest('#btn-rail-accounts')) { if (page.hidden) void open(); else close(); }
    else if (e.target.closest('#scene-rail button') && !page.hidden) close();
    if (e.target.closest('#btn-config-accounts')) void open();
  });
  document.addEventListener('keydown', e => {
    if (page.hidden || view !== 'list' || e.isComposing || e.repeat) return;
    if (e.key === 'Escape' && !page.querySelector('dialog[open]')) { e.preventDefault(); close(); return; }
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || checking() || busy || e.target.closest('input,textarea,select,[contenteditable="true"]')) return;
    const n = Number(e.key), card = state && companyCards(state)[n - 1];
    if (card && n >= 1 && n <= 7) { e.preventDefault(); void action('open', { site: card.site }); }
  });
  document.addEventListener('hub-account-config-saved', () => { notice = '接入配置已保存。'; void refresh(); });
  window.addEventListener('resize', position);
  return { open, close, refresh };
}
module.exports = { createAccountCenterPanel };
