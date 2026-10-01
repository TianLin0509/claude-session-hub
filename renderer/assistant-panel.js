'use strict';
const { createAssistantConversation } = require('./assistant-conversation');

function createAssistantPanel({ document, ipcRenderer, openSession, attachSession, getSession, renderMarkdown, mountTerminal, closeOtherPanels = () => {} }) {
  const page = document.getElementById('assistant-page'), nav = document.getElementById('btn-assistant');
  const body = page.querySelector('.assistant-content'), status = page.querySelector('.assistant-status');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const questions = { progress:'请用白话汇报最近三小时最重要的变化，以及现在需要我处理什么。附上可核对的来源。', attention:'当前有哪些事情需要我决定、确认或补充？请依据实际工作记录回答。', next:'根据最近的工作进展，建议我接下来优先处理什么，并说明依据。' };
  let overview = null, epoch = 0, sequence = 0, busy = false, previousFocus = null, previousNavigation = [], poll = null, terminal = null, creating = null;
  body.innerHTML = `<div class="assistant-chat-layout"><main class="assistant-chat-main"><header class="assistant-hero"><img src="assets/assistant/penguin.png" alt="戴红围巾的企鹅助理" width="116" height="116"><div><span class="assistant-eyebrow">你的 AI Hub 工作伙伴</span><h1>助理</h1><p>田哥，想先聊聊哪件事？</p><span class="assistant-hero-note">帮你梳理信息、跟进任务，把注意力留给重要的决定。</span></div></header><div class="assistant-chat-tools"><span class="assistant-connection">沿用当前 Codex 账号与模型</span><div><button type="button" data-assistant-action="enable">启用助理</button><button type="button" data-assistant-action="original">原会话 ↗</button><button type="button" data-assistant-action="refresh" aria-label="刷新助理记录">↻</button></div></div><div class="assistant-messages" role="log" aria-label="与助理的对话"><div class="assistant-chat-empty">告诉我你想了解什么，或把下一件事交给我。<br><span>首次发送时会连接 Codex，创建你的专属助理会话。</span></div></div><details class="assistant-cli"><summary>查看原生终端</summary><div class="assistant-cli-host"></div></details><div class="assistant-quick-questions"><button type="button" data-assistant-action="ask" data-question="progress">最近有什么变化？</button><button type="button" data-assistant-action="ask" data-question="attention">现在需要我做什么？</button><button type="button" data-assistant-action="ask" data-question="next">接下来先做什么？</button></div><div class="assistant-compose"><label class="sr-only" for="assistant-input">给助理发消息</label><textarea id="assistant-input" rows="2" placeholder="输入你想了解或交代的事…"></textarea><div class="assistant-compose-footer"><span>Enter 发送 · Shift + Enter 换行</span><div><span class="assistant-model-label">Codex</span><button type="button" data-assistant-send aria-label="发送给助理" disabled>↑</button></div></div></div><p class="assistant-delivery" role="status" aria-live="polite">消息与回答保留在同一个 Codex 会话中。</p></main><aside class="assistant-right-rail" aria-label="工作动态与关注任务"><section><div class="assistant-section-title"><h2>最近的变化</h2><span class="assistant-unread-count"></span></div><div class="assistant-changes"></div></section><section><h2>需要你处理</h2><div class="assistant-attention"></div></section><section><h2>关注的任务</h2><p class="assistant-rail-hint">有新回复时在这里提醒，不会自动继续执行。</p><div class="assistant-follow-controls"><select aria-label="选择要关注的会话"><option value="">选择一个会话</option></select><button type="button" data-assistant-action="follow">关注</button></div><div class="assistant-followed"></div></section><p class="assistant-coverage"></p></aside></div>`;
  const conversation = createAssistantConversation({ document, ipcRenderer, host:body, getSession,
    ensureSession, renderMarkdown, onChanged:() => void refresh() });
  const railToggle = document.createElement('button'); railToggle.type = 'button'; railToggle.className = 'assistant-rail-toggle'; railToggle.dataset.assistantAction = 'rail'; railToggle.textContent = '工作动态'; railToggle.setAttribute('aria-expanded','false'); page.querySelector('.assistant-toolbar').append(railToggle);
  body.querySelector('.assistant-right-rail').insertAdjacentHTML('beforeend','<section class="assistant-workbench" hidden><h2>工作档案</h2><p></p><button type="button" data-assistant-action="workbench">打开 Markdown 档案 ↗</button></section>');
  const cli = body.querySelector('.assistant-cli');
  function message(text, error = false) { status.textContent = text; status.hidden = !text; status.classList.toggle('assistant-error', error); }
  function position() { const rail = document.getElementById('scene-rail')?.getBoundingClientRect(); if (rail) { page.style.left = rail.right + 'px'; page.style.top = rail.top + 'px'; } }
  async function call(channel, args) {
    const result = await ipcRenderer.invoke(channel, args);
    if (!result || result.ok === false) throw new Error(result?.error || '助理服务暂未就绪');
    return result;
  }
  function controls() { page.setAttribute('aria-busy', String(busy)); body.querySelectorAll('[data-assistant-action]').forEach(b => b.disabled = busy); }
  async function ensureSession() {
    if (creating) return creating;
    creating = (async () => {
      const ticket = epoch; busy = true; controls(); message('正在连接你的助理…');
      try {
        const result = await call('assistant:ensure-session');
        if (!result.sessionId) throw new Error('尚未取得会话编号');
        attachSession(result.sessionId, result.session);
        overview = { ...overview, sessionId:result.sessionId, available:true };
        conversation.setSession(result.sessionId);
        if (ticket === epoch && !page.hidden) { renderSidebar(); message(''); }
        return result;
      } finally { busy = false; creating = null; controls(); }
    })();
    return creating;
  }
  function renderSidebar() {
    if (!overview) return;
    const title = body.querySelector('[data-assistant-action="enable"]');
    title.hidden = !!overview.sessionId;
    body.querySelector('[data-assistant-action="original"]').hidden = !overview.sessionId;
    body.querySelector('.assistant-connection').textContent = overview.sessionId ? '同一个助理会话 · 回答来自原生记录' : '沿用当前 Codex 账号与模型，首次发送后连接';
    const notifications = overview.notifications || [], changes = overview.recentChanges || notifications;
    body.querySelector('.assistant-unread-count').textContent = overview.unreadCount ? `${overview.unreadCount} 条新回复` : '';
    body.querySelector('.assistant-changes').innerHTML = changes.length ? changes.slice(0,12).map(n => `<article class="assistant-evidence-card${n.readAt ? '' : ' is-unread'}"><div class="assistant-evidence-title"><strong>${esc(n.title || '任务新回复')}</strong><time>${esc(n.createdAt ? new Date(n.createdAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}) : '')}</time></div><p>${esc(n.text || '')}</p><div class="assistant-evidence-links"><button type="button" data-assistant-action="session" data-session-id="${esc(n.sessionId)}" data-notification-id="${esc(n.id)}">查看原会话 ↗</button>${n.readAt ? '' : `<button type="button" data-assistant-action="read" data-notification-id="${esc(n.id)}">已读</button>`}</div><small>${esc(n.source?.ref || '原生回答记录')}</small></article>`).join('') : '<p class="assistant-rail-empty">还没有关注任务的新回复。可以在下方关注一个会话，或直接问我最近的进展。</p>';
    const attention = Array.isArray(overview.needsAttention) ? overview.needsAttention : [];
    body.querySelector('.assistant-attention').innerHTML = attention.length ? attention.map(item => `<article class="assistant-evidence-card"><p>${esc(typeof item === 'string' ? item : item.text || item.summary || item.title)}</p></article>`).join('') : '<p class="assistant-rail-empty">目前没有已整理的待办。问一句“现在需要我做什么”，我会结合记录帮你判断。</p>';
    const tasks = overview.followedTasks || [];
    body.querySelector('.assistant-followed').innerHTML = tasks.length ? tasks.map(t => `<div class="assistant-followed-row"><button type="button" data-assistant-action="session" data-session-id="${esc(t.sessionId)}">${esc(t.title || t.sessionId)}<span>${esc(t.lastError || (t.state === 'paused-closed' ? '已关闭，恢复后继续关注' : t.state === 'waiting-binding' ? '等待原生会话绑定' : '有新回复时提醒'))}</span></button><button type="button" data-assistant-action="unfollow" data-session-id="${esc(t.sessionId)}" aria-label="取消关注 ${esc(t.title || '')}">×</button></div>`).join('') : '<p class="assistant-rail-empty">尚未关注任务</p>';
    const context = overview.contextCoverage;
    body.querySelector('.assistant-coverage').textContent = context ? `上轮准备 ${context.sources || 0} 段资料，${context.snapshotRead ? '助理已请求读取' : '等待按需读取'}${context.truncated ? '；覆盖有截取' : ''}。提醒引用的是新回复原文，不等于任务成果已验收。` : '此处只展示有来源的记录。会话没有回复，不代表工作已经完成。';
    const dossier = body.querySelector('.assistant-workbench'); dossier.hidden = !context?.workbenchPath;
    dossier.querySelector('p').textContent = context?.workbenchPath ? `版本 ${String(context.workbenchRevision || '').slice(0,10)} · ${context.activeSessions ?? 0} 个已打开会话${context.allActiveSessionsIncluded ? '全部纳入' : '，覆盖待核对'}\n资料时间：${new Date(context.asOf).toLocaleString('zh-CN')}` : '';
    dossier.querySelector('p').title = context?.workbenchRevision || '';
    nav.title = overview.unreadCount ? `助理 · ${overview.unreadCount} 条关注任务新回复` : '助理 · 进展与下一步';
    nav.classList.toggle('assistant-has-unread', !!overview.unreadCount);
    controls();
  }
  async function refresh() {
    if (page.hidden) return;
    const ticket = epoch, current = ++sequence;
    try {
      const result = await call('assistant:get-overview');
      if (ticket !== epoch || current !== sequence || page.hidden) return;
      overview = result;
      if (result.sessionId) conversation.setSession(result.sessionId);
      renderSidebar(); message('');
      const sessions = result.watchableSessions || await ipcRenderer.invoke('get-sessions');
      if (ticket !== epoch || current !== sequence || page.hidden) return;
      const select = body.querySelector('.assistant-follow-controls select'), chosen = select.value;
      select.innerHTML = '<option value="">选择一个会话</option>' + (sessions || []).filter(s => s.id !== result.sessionId && !s.meetingId && !s.hiddenFromSidebar).map(s => `<option value="${esc(s.id)}">${esc(s.title || s.name || s.id)}</option>`).join('');
      select.value = chosen;
    } catch (error) { if (ticket === epoch && current === sequence && !page.hidden) message(`记录暂未同步：${error.message}。点击刷新可重试。`, true); }
  }
  async function action(button) {
    const kind = button.dataset.assistantAction;
    if (kind === 'ask') return conversation.appendDraft(questions[button.dataset.question] || '');
    if (kind === 'rail') { page.classList.toggle('assistant-show-rail'); railToggle.setAttribute('aria-expanded',String(page.classList.contains('assistant-show-rail'))); return; }
    try {
      if (kind === 'refresh') { await refresh(); await conversation.refresh(); }
      else if (kind === 'workbench') await call('assistant:open-workbench');
      else if (kind === 'enable') await ensureSession();
      else if (kind === 'original' || kind === 'session') {
        const id = kind === 'original' ? overview?.sessionId : button.dataset.sessionId;
        if (!id) return;
        if (button.dataset.notificationId) await call('assistant:mark-notification-read', { id:button.dataset.notificationId });
        close(); await openSession(id, getSession(id));
      } else if (kind === 'follow') {
        const id = body.querySelector('.assistant-follow-controls select').value;
        if (!id) { message('先选择一个要关注的会话。'); return; }
        await call('assistant:follow-task', { sessionId:id }); await refresh();
      } else if (kind === 'unfollow') { await call('assistant:unfollow-task', { sessionId:button.dataset.sessionId }); await refresh(); }
      else if (kind === 'read') { await call('assistant:mark-notification-read', { id:button.dataset.notificationId }); await refresh(); }
    } catch (error) { message(`操作尚未完成：${error.message}`, true); }
  }
  function close(restoreNavigation = true) {
    if (page.hidden) return;
    epoch++; page.hidden = true; clearInterval(poll); poll = null; conversation.setVisible(false);
    terminal?.dispose?.(); terminal = null; cli.open = false;
    document.body.classList.remove('assistant-open'); nav.setAttribute('aria-expanded','false'); nav.removeAttribute('aria-current');
    if (restoreNavigation) for (const saved of previousNavigation) { saved.button.classList.toggle('active',saved.active); if (saved.current) saved.button.setAttribute('aria-current',saved.current); }
    previousNavigation = [];
  }
  function open() {
    closeOtherPanels(); previousFocus = document.activeElement; epoch++;
    previousNavigation = [...document.querySelectorAll('#scene-rail .btn-shell-nav')].filter(b => b !== nav).map(button => ({button,active:button.classList.contains('active'),current:button.getAttribute('aria-current')}));
    for (const {button} of previousNavigation) { button.classList.remove('active'); button.removeAttribute('aria-current'); }
    page.hidden = false; document.body.classList.add('assistant-open'); nav.setAttribute('aria-expanded','true'); nav.setAttribute('aria-current','page');
    position(); conversation.setVisible(true); void refresh();
    clearInterval(poll); poll = setInterval(() => { void refresh(); void conversation.refresh(); }, 2500);
  }
  cli.addEventListener('toggle', async () => {
    if (!cli.open) { terminal?.dispose?.(); terminal = null; return; }
    const ticket = epoch;
    try { const result = await ensureSession(); if (!page.hidden && cli.open && ticket === epoch && !terminal) terminal = mountTerminal(result.sessionId, body.querySelector('.assistant-cli-host')); }
    catch (error) { message('终端暂未打开：' + error.message,true); cli.open = false; }
  });
  page.addEventListener('click', event => { const button = event.target.closest('button'); if (!button || button.disabled) return; if (button.dataset.assistantClose !== undefined) { close(); previousFocus?.focus?.(); } else if (button.dataset.assistantAction) void action(button); });
  document.addEventListener('click', event => { if (event.target.closest('#btn-assistant')) { if (page.hidden) open(); else close(); } else if (event.target.closest('#scene-rail button')) close(false); });
  document.addEventListener('keydown', event => { if (!page.hidden && event.key === 'Escape') { close(); previousFocus?.focus?.(); } });
  ipcRenderer.on('assistant:notification', () => { if (!page.hidden) void refresh(); else { nav.classList.add('assistant-has-unread'); nav.title = '助理 · 关注任务有新回复'; } });
  const observer = new document.defaultView.ResizeObserver(position), rail = document.getElementById('scene-rail'); if (rail) observer.observe(rail);
  return { open, close, refresh, isOpen:() => !page.hidden };
}
module.exports = { createAssistantPanel };
