'use strict';
// The account page: two actions — 登录 (a window in the Hub Chrome) and 检查登录 — over the
// identities of that one browser. 接入配置 stays for API keys, which are not logins.
const { identityCards, unplacedClis, attentionCount } = require('./account-center-view');
function createAccountCenterPanel({ document, ipcRenderer, escapeHtml: esc, configModal, closeOtherPanels = () => {} }) {
  const page = document.getElementById('account-page'), body = page.querySelector('.ac-content');
  let state = null, signature = '', view = 'list', error = '', notice = '', busy = '', timer, previousFocus, epoch = 0;
  async function call(action, args) {
    const r = await ipcRenderer.invoke('hub-accounts:' + action, args);
    if (!r?.ok) throw Error(r?.error || '账号服务未响应');
    return r.data;
  }
  function renderStatus() {
    const status = page.querySelector('.ac-status'), text = error || notice || (busy === 'check' ? '正在检查登录…' : '');
    if (status.textContent !== text) status.textContent = text;
    status.classList.toggle('error', !!error);
    status.hidden = !text;
    const check = page.querySelector('[data-ac="check"]');
    if (check) check.disabled = busy === 'check';
  }
  const chip = (c, identity, kind) => {
    const clickable = kind === 'site' && c.action;
    return clickable
      ? `<button class="ac-chip ${c.tone}" data-ac="login" data-identity="${esc(identity)}" data-site="${esc(c.key)}" title="在 Hub 浏览器打开登录">${esc(c.text)}</button>`
      : `<span class="ac-chip ${c.tone}"${c.title ? ` title="${esc(c.title)}"` : ''}>${esc(c.text)}</span>`;
  };
  function cardHtml(card) {
    return `<article class="ac-id ${card.attention ? 'attention' : ''}" data-identity="${esc(card.id)}">
    <header class="ac-id-head"><span class="ac-id-badge">${esc(card.label)}</span>
    <div class="ac-id-title"><strong>${esc(card.account || '尚未确认 ChatGPT 账号')}</strong><small>Hub 浏览器身份「${esc(card.label)}」</small></div>
    <button class="ac-btn ${card.attention ? 'primary' : ''}" data-ac="login" data-identity="${esc(card.id)}">登录</button></header>
    <div class="ac-id-row"><span class="ac-id-k">网页</span><div class="ac-chips">${card.sites.map(s => chip(s, card.id, 'site')).join('')}</div></div>
    ${card.clis.length ? `<div class="ac-id-row"><span class="ac-id-k">命令行</span><div class="ac-chips">${card.clis.map(c => chip(c, card.id, 'cli')).join('')}</div></div>` : ''}
    </article>`;
  }
  function render() {
    if (page.hidden) return;
    position();
    const count = document.getElementById('accounts-attention');
    const n = state ? attentionCount(state) : 0;
    if (count) { count.textContent = n; count.hidden = !n; count.title = `${n} 处需要登录`; }
    const editor = document.getElementById('account-editor');
    editor.hidden = view !== 'config'; body.hidden = view === 'config';
    page.querySelector('[data-ac="back"]').hidden = view !== 'config';
    renderStatus();
    if (view === 'config') return;
    if (!state) { body.innerHTML = '<p class="ac-empty">正在读取…</p>'; return; }
    const unplaced = unplacedClis(state);
    const chromeLine = state.chrome.loginOpen ? '登录窗口开着 —— 登好后关掉它，这里会自动更新'
      : state.chrome.running ? '运行中' : '未运行（点「登录」会打开它；检查登录不会启动它）';
    body.innerHTML = `<p class="ac-chrome">Hub 浏览器 · ${chromeLine}</p>
    <div class="ac-ids">${identityCards(state).map(cardHtml).join('')}</div>
    ${unplaced.length ? `<section class="ac-unplaced"><span class="ac-id-k">命令行</span><div class="ac-chips">${unplaced.map(c => chip(c, '', 'cli')).join('')}</div><small>点一次「检查登录」后，会按 ChatGPT 账号归到对应身份下。</small></section>` : ''}`;
  }
  function apply(next) {
    const sig = JSON.stringify(next);
    if (sig === signature) return renderStatus();
    const top = body.scrollTop, focus = page.contains(document.activeElement) ? { ...document.activeElement.dataset } : null;
    state = next; signature = sig; render();
    if (focus && Object.keys(focus).length) {
      [...page.querySelectorAll('button')].find(b => Object.entries(focus).every(([k, v]) => b.dataset[k] === v))?.focus({ preventScroll: true });
    }
    body.scrollTop = top;
  }
  function position() {
    const rail = document.getElementById('scene-rail')?.getBoundingClientRect();
    if (rail) { page.style.left = rail.right + 'px'; page.style.top = rail.top + 'px'; }
  }
  async function refresh() {
    const ticket = epoch;
    try { const next = await call('state'); if (ticket === epoch && !page.hidden) { error = ''; apply(next); } }
    catch (e) { if (ticket === epoch && !page.hidden) { error = e.message; renderStatus(); } }
  }
  async function check() {
    if (busy) return;
    busy = 'check'; error = ''; notice = ''; renderStatus();
    const ticket = epoch;
    try { const next = await call('check'); if (ticket === epoch) { notice = '已检查。'; apply(next); } }
    catch (e) { if (ticket === epoch) error = e.message; }
    finally { busy = ''; if (ticket === epoch) renderStatus(); }
  }
  async function login(identity, site) {
    error = ''; notice = ''; renderStatus();
    const ticket = epoch;
    try {
      await call('login', { identity, ...(site ? { site } : {}) });
      if (ticket === epoch) notice = '已打开 Hub 浏览器的登录窗口（普通模式，Google 才允许登录）。登好后关掉那个窗口，这里会自动更新。';
      await refresh();
    } catch (e) { if (ticket === epoch) error = e.message; }
    finally { if (ticket === epoch) renderStatus(); }
  }
  async function configure(provider = 'codex') {
    try { await configModal.openAccountConfig(provider); if (!page.hidden) { view = 'config'; render(); } }
    catch (e) { error = e.message; renderStatus(); }
  }
  function close() {
    if (page.hidden) return;
    page.hidden = true; epoch++; clearInterval(timer);
    document.body.classList.remove('accounts-open');
    document.getElementById('btn-rail-accounts')?.setAttribute('aria-expanded', 'false');
    if (previousFocus?.isConnected) previousFocus.focus();
  }
  async function open(provider) {
    closeOtherPanels(); configModal.close();
    epoch++; clearInterval(timer); previousFocus = document.activeElement;
    page.hidden = false; document.body.classList.add('accounts-open');
    document.getElementById('btn-rail-accounts')?.setAttribute('aria-expanded', 'true');
    view = 'list'; error = ''; notice = ''; render();
    await refresh();
    // Reading cookies is cheap and never starts anything, so a finished login simply appears.
    timer = setInterval(() => { if (!page.hidden && view === 'list' && !busy) void refresh(); }, 5000);
    if (provider) await configure(provider);
  }
  page.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const action = b.dataset.ac; if (!action) return;
    if (action === 'close') close();
    else if (action === 'back') { view = 'list'; render(); }
    else if (action === 'check') void check();
    else if (action === 'login') void login(b.dataset.identity, b.dataset.site);
    else if (action === 'config') void configure(b.dataset.id);
  });
  document.addEventListener('click', e => {
    if (e.target.closest('#btn-rail-accounts')) { if (page.hidden) void open(); else close(); }
    else if (e.target.closest('#scene-rail button') && !page.hidden) close();
    if (e.target.closest('#btn-config-accounts')) void open();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !page.hidden && !page.querySelector('dialog[open]')) { e.preventDefault(); close(); } });
  document.addEventListener('hub-account-config-saved', () => { notice = '接入配置已保存。'; void refresh(); });
  window.addEventListener('resize', position);
  return { open, close, refresh };
}
module.exports = { createAccountCenterPanel };
