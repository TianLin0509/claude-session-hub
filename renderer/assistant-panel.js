'use strict';

// Navigation and a read-only overview. Answers and input stay in the ordinary session.
function createAssistantPanel({ document, ipcRenderer, openSession, closeOtherPanels = () => {} }) {
  const page = document.getElementById('assistant-page');
  const nav = document.getElementById('btn-assistant');
  const body = page.querySelector('.assistant-content');
  const status = page.querySelector('.assistant-status');
  let overview = null, epoch = 0, readSequence = 0, busy = false, previousFocus = null, previousNavigation = [];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const lines = value => Array.isArray(value) ? value : value ? [value] : [];
  const sentence = value => typeof value === 'string' ? value : value?.text || value?.summary || value?.title || '';

  function position() {
    const rail = document.getElementById('scene-rail')?.getBoundingClientRect();
    if (rail) { page.style.left = `${rail.right}px`; page.style.top = `${rail.top}px`; }
  }
  function message(text, error = false) {
    status.textContent = text; status.hidden = !text;
    status.classList.toggle('assistant-error', error);
  }
  function controls() {
    page.setAttribute('aria-busy', String(busy));
    page.querySelectorAll('[data-assistant-action]').forEach(button => { button.disabled = busy; });
  }
  function render() {
    if (!overview) return;
    const summary = lines(overview.summary).filter(sentence);
    const attention = lines(overview.needsAttention).filter(sentence);
    const date = overview.updatedAt ? new Date(overview.updatedAt) : null;
    const stamp = date && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN') : '尚无更新时间';
    const context = overview.contextCoverage;
    const coverage = (typeof overview.coverage === 'string' ? overview.coverage : overview.coverage?.description)
      || (context ? `上轮准备 ${Number(context.sources) || 0} 段资料${context.snapshotRead ? '，助理已请求读取' : '，等待助理按需读取'}${context.truncated ? '；部分内容待查' : '；未覆盖全部历史'}` : '');
    body.innerHTML = `<div class="assistant-hero"><div><span class="assistant-eyebrow">你的 AI Hub 助理</span><h1>先看结果，再决定下一步。</h1><p>我帮你梳理进展、找到原会话，把接下来的事交代清楚。</p><button type="button" class="assistant-primary" data-assistant-action="open">${overview.sessionId ? '继续与助理对话' : '启用 Codex 助理'}</button><p class="assistant-small">${overview.sessionId ? '回到同一个会话，沿用平时的输入框与回答。' : '沿用当前 Codex 账号与模型，连接 Hub 助理工具；点击后才创建。'}</p></div><img src="assets/assistant/penguin.png" alt="戴红围巾的企鹅助理" width="190" height="190"></div>
      <div class="assistant-section-title"><h2>工作近况</h2><button type="button" data-assistant-action="refresh">刷新记录</button></div>
      <p class="assistant-meta">记录更新：${esc(stamp)}${coverage ? ' · ' + esc(coverage) : ' · 仅展示已收集的记录，完整进展可向助理追问'}</p>
      <div class="assistant-grid"><section class="assistant-card"><h3>最近的变化</h3>${summary.length ? `<ul>${summary.map(item => `<li>${esc(sentence(item))}</li>`).join('')}</ul>` : '<p class="assistant-empty">进展简报在助理会话中回答。可以让助理查最近三小时的变化。</p>'}</section><section class="assistant-card"><h3>需要你处理</h3>${attention.length ? `<ul>${attention.map(item => `<li>${esc(sentence(item))}</li>`).join('')}</ul>` : '<p class="assistant-empty">请助理结合工作记录列出需要你决定的事项；此处尚未提取待办清单。</p>'}</section></div>
      <section class="assistant-prompts"><h2>直接问助理</h2><p>点击会把问题填入普通会话输入框，由你发送。</p><div class="assistant-question-grid"><button type="button" data-assistant-action="ask" data-question="progress"><strong>最近有什么进展？</strong><span>最近三小时，哪些结果真正往前推进了？</span></button><button type="button" data-assistant-action="ask" data-question="attention"><strong>现在需要我做什么？</strong><span>只列需要我决定、确认或补充的事情。</span></button><button type="button" data-assistant-action="ask" data-question="next"><strong>接下来先做什么？</strong><span>结合已有工作，给出下一步建议与依据。</span></button></div></section><p class="assistant-footnote">助理沿用 Codex 普通会话；原始回答与终端仍可查看。界面为首版基础布局，视觉方案待你选择。</p>`;
    controls();
  }
  async function call(channel, args) {
    let result;
    try { result = await ipcRenderer.invoke(channel, args); }
    catch (error) {
      if (/No handler registered/.test(error.message)) throw new Error('当前实例的助理服务尚未接入');
      throw error;
    }
    if (!result || result.ok === false) throw new Error(result?.error || '助理服务未就绪');
    return result;
  }
  async function refresh() {
    const ticket = epoch;
    const sequence = ++readSequence;
    message('正在读取工作记录…');
    try {
      const result = await call('assistant:get-overview');
      if (ticket !== epoch || sequence !== readSequence || page.hidden) return;
      overview = result; render(); message('');
    } catch (error) {
      if (ticket !== epoch || sequence !== readSequence || page.hidden) return;
      message(`暂时无法读取助理记录：${error.message}。可点击刷新重试。`, true);
      if (!overview) { overview = {}; render(); }
    }
  }
  async function action(kind, question) {
    if (busy) return;
    if (kind === 'refresh') return refresh();
    busy = true; controls();
    const ticket = epoch;
    message('正在打开助理会话…');
    try {
      const questions = {
        progress: '请汇报最近三小时 AI Hub 中真正推进了哪些结果，哪些还没完成。用白话简短说明，并标明依据与信息范围。',
        attention: '请查一下当前哪些事情需要我决定、确认或补充。先说我现在需要做什么，没有确切证据的不要当成待办。',
        next: '根据最近的工作进展，建议我接下来优先处理什么。说清结果、阻碍和需要我做的事，附上可核对的来源。',
      };
      const result = await call('assistant:ensure-session');
      if (!result.sessionId) throw new Error('服务没有返回助理会话标识');
      // A late response must not navigate away from a different page chosen by the user.
      if (ticket !== epoch || page.hidden) return;
      await openSession(result.sessionId, result.session, kind === 'ask' ? questions[question] : '');
      close();
    } catch (error) {
      if (ticket === epoch && !page.hidden) message(`操作尚未完成：${error.message}`, true);
    } finally { busy = false; controls(); }
  }
  function close(restoreNavigation = true) {
    if (page.hidden) return;
    epoch++; page.hidden = true; document.body.classList.remove('assistant-open');
    nav.setAttribute('aria-expanded', 'false'); nav.removeAttribute('aria-current');
    if (restoreNavigation) for (const saved of previousNavigation) {
      saved.button.classList.toggle('active', saved.active);
      if (saved.current) saved.button.setAttribute('aria-current', saved.current);
    }
    previousNavigation = [];
  }
  function open() {
    closeOtherPanels(); previousFocus = document.activeElement; epoch++;
    previousNavigation = [...document.querySelectorAll('#scene-rail .btn-shell-nav')].filter(button => button !== nav).map(button => ({ button, active: button.classList.contains('active'), current: button.getAttribute('aria-current') }));
    for (const { button } of previousNavigation) { button.classList.remove('active'); button.removeAttribute('aria-current'); }
    page.hidden = false; document.body.classList.add('assistant-open');
    nav.setAttribute('aria-expanded', 'true'); nav.setAttribute('aria-current', 'page');
    position(); render(); void refresh();
  }
  page.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.dataset.assistantClose !== undefined) { close(); previousFocus?.focus?.(); }
    else if (button.dataset.assistantAction) void action(button.dataset.assistantAction, button.dataset.question);
  });
  document.addEventListener('click', event => {
    if (event.target.closest('#btn-assistant')) { if (page.hidden) open(); else close(); }
    else if (event.target.closest('#scene-rail button')) close(false);
  });
  document.addEventListener('keydown', event => { if (!page.hidden && event.key === 'Escape') { close(); previousFocus?.focus?.(); } });
  const observer = new document.defaultView.ResizeObserver(position);
  const rail = document.getElementById('scene-rail'); if (rail) observer.observe(rail);
  return { open, close, refresh };
}

module.exports = { createAssistantPanel };
