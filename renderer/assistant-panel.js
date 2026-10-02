'use strict';

// An entry into the ordinary session surface. No composer, transcript reader,
// model controls or terminal writer is owned by the assistant navigation.
function createAssistantPanel({ document, ipcRenderer, getSession, getActiveSessionId,
  openSession, closeOtherPanels = () => {}, showMessage }) {
  const nav = document.getElementById('btn-assistant');
  let epoch = 0, opening = null, overview = null, sequence = 0, switching = false;
  const setClass = (element, name, value) => { if (element.classList.contains(name) !== value) element.classList.toggle(name, value); };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const isOpen = () => document.body.classList.contains('assistant-session-active')
    && getSession(getActiveSessionId())?.purpose === 'hub-assistant';
  async function call(channel, args) {
    const result = await ipcRenderer.invoke(channel, args);
    if (!result || result.ok === false) throw new Error(result?.error || '助理暂未连接');
    return result;
  }
  function badge() {
    nav.classList.toggle('assistant-has-unread', !!overview?.unreadCount);
    nav.title = overview?.unreadCount ? `助理 · ${overview.unreadCount} 条关注任务新回复` : '助理 · 进展与下一步';
  }
  function paintNotices() {
    const host = document.querySelector('.assistant-notifications');
    if (!host) return;
    host.querySelector('summary').textContent = overview?.unreadCount ? `新回复 ${overview.unreadCount}` : '关注回复';
    host.querySelector('.assistant-notice-list').innerHTML = (overview?.notifications || []).map(n =>
      `<article><strong>${esc(n.title)}</strong><p>${esc(n.text)}</p><small>${esc(n.source?.ref)}</small>${n.readAt ? '' : `<button type="button" data-assistant-read="${esc(n.id)}">标为已读</button>`}</article>`).join('') || '<p>明确说“有新回复时提醒我”，助理会关注对应任务。</p>';
  }
  async function refresh() {
    const ticket = ++sequence;
    try {
      const result = await call('assistant:get-overview');
      if (ticket !== sequence) return;
      overview = result; badge(); paintNotices();
    } catch (error) { if (isOpen()) showMessage?.(`助理动态暂未同步：${error.message}`); }
  }
  function syncSession(session) {
    const active = session?.purpose === 'hub-assistant';
    setClass(document.body, 'assistant-session-active', active);
    setClass(document.getElementById('terminal-panel'), 'assistant-session', active);
    setClass(nav, 'active', active);
    if (active) nav.setAttribute('aria-current', 'page'); else nav.removeAttribute('aria-current');
    const tools = document.getElementById('toolbar-actions');
    let picker = tools?.querySelector('.assistant-backend');
    if (active && tools && !picker) {
      picker = document.createElement('select'); picker.className = 'assistant-backend';
      picker.setAttribute('aria-label', '助理 AI 后端');
      picker.title = '切换助理后端；各自历史分别保留，共用工作档案和交接记录';
      picker.innerHTML = '<option value="codex">Codex</option><option value="claude">Claude</option>';
      picker.addEventListener('change', () => { void switchBackend(picker.value); });
      tools.prepend(picker);
    }
    if (picker && active) { picker.value = session.kind; picker.disabled = switching; }
    if (!active || !tools || tools.querySelector('.assistant-notifications')) return;
    const notices = document.createElement('details'); notices.className = 'assistant-notifications';
    notices.innerHTML = '<summary>关注回复</summary><div class="assistant-notice-list"></div>';
    notices.addEventListener('toggle', () => { if (notices.open) void refresh(); });
    notices.addEventListener('click', event => {
      const read = event.target.closest('[data-assistant-read]');
      if (read) void call('assistant:mark-notification-read', {id:read.dataset.assistantRead}).then(refresh).catch(error => showMessage?.(error.message));
    });
    const dossier = document.createElement('button'); dossier.type = 'button'; dossier.className = 'btn-zoom assistant-workbench';
    dossier.textContent = '工作档案'; dossier.title = '打开助理的 Markdown 工作档案';
    dossier.addEventListener('click', () => { void call('assistant:open-workbench').catch(error => showMessage?.(error.message)); });
    tools.prepend(notices, dossier); paintNotices();
  }
  function close() {
    epoch++;
    setClass(document.body, 'assistant-session-active', false);
    setClass(document.getElementById('terminal-panel'), 'assistant-session', false);
    setClass(nav, 'active', false); nav.removeAttribute('aria-current');
  }
  async function switchBackend(kind) {
    if (opening || switching) return;
    const ticket = ++epoch;
    switching = true;
    const picker = document.querySelector('.assistant-backend');
    if (picker) { picker.disabled = true; picker.setAttribute('aria-busy','true'); }
    const label = nav.querySelector('.btn-label'); label.textContent = '切换中…';
    try {
      const result = await call('assistant:switch-backend', {kind});
      if (ticket !== epoch) return;
      closeOtherPanels(); await openSession(result.sessionId, result.session); await refresh();
    } catch (error) { showMessage?.(`助理后端未切换：${error.message}`); }
    finally {
      switching = false; label.textContent = '助理';
      if (picker) picker.removeAttribute('aria-busy');
      syncSession(getSession(getActiveSessionId()));
    }
  }
  async function open() {
    if (switching) return;
    if (opening) return opening;
    const ticket = ++epoch;
    nav.disabled = true; nav.setAttribute('aria-busy', 'true');
    const label = nav.querySelector('.btn-label'); label.textContent = '连接中…';
    opening = (async () => {
      try {
        const result = await call('assistant:ensure-session');
        if (ticket !== epoch) return;
        closeOtherPanels();
        await openSession(result.sessionId, result.session);
        void refresh();
      } catch (error) { if (ticket === epoch) showMessage?.(`助理尚未打开：${error.message}`); }
      finally { nav.disabled = false; nav.removeAttribute('aria-busy'); label.textContent = '助理'; opening = null; }
    })();
    return opening;
  }
  nav.addEventListener('click', () => { void open(); });
  document.addEventListener('click', event => { if (event.target.closest('#scene-rail button:not(#btn-assistant)')) close(); });
  ipcRenderer.on('assistant:notification', (_event, notice) => {
    nav.classList.add('assistant-has-unread'); nav.title = '助理 · 关注任务有新回复';
    if (notice?.text) showMessage?.(`${notice.title || '关注任务'}有新回复，可在助理的“关注回复”查看。`);
    if (isOpen()) void refresh();
  });
  return { open, close, refresh, syncSession, isOpen, switchBackend };
}
module.exports = { createAssistantPanel };
