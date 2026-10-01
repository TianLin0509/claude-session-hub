'use strict';
const { displayTurns } = require('../core/conversation-display');
const { assistantContextDisplay } = require('../core/assistant-context-display');
const { beginPromptDelivery, applyPromptReceipt } = require('./prompt-delivery-state');

// A view of the ordinary assistant session: no model runner or transcript copy.
function createAssistantConversation({ document, ipcRenderer, host, getSession, ensureSession, renderMarkdown, onState, onChanged }) {
  const storage = document.defaultView.localStorage, draftKey = 'hub.assistant.chat-draft';
  const feed = host.querySelector('.assistant-messages'), input = host.querySelector('.assistant-compose textarea');
  const sendButton = host.querySelector('[data-assistant-send]'), feedback = host.querySelector('.assistant-delivery');
  let sessionId = null, submitting = false, delivery = null, pending = null, readSequence = 0, visible = false, timer = null, rendered = '', draftVersion = 0;
  try { input.value = storage.getItem(draftKey) || ''; } catch {}
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const persist = () => { try { storage.setItem(draftKey, input.value); } catch {} };
  function state(text, error = false) { feedback.textContent = text; feedback.classList.toggle('is-error', error); onState?.(text); }
  function controls() {
    const s = getSession(sessionId), working = s && require('../core/session-runtime-truth').sessionRuntimeIsActive(s);
    sendButton.disabled = submitting || working || !input.value.trim();
    sendButton.setAttribute('aria-label', submitting ? '正在发送' : working ? '助理正在处理上一条消息' : '发送给助理');
    sendButton.textContent = submitting ? '…' : '↑';
    host.querySelector('.assistant-model-label').textContent = s?.currentModel?.displayName || s?.currentModel?.id || 'Codex';
  }
  function bubble(turn, local = false) {
    const user = turn.role === 'user', projection = user ? assistantContextDisplay(turn.text, 'hub-assistant') : null;
    const text = projection?.userText ?? turn.text ?? '';
    const stamp = turn.ts ? new Date(turn.ts).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' }) : '';
    return `<article class="assistant-message ${user ? 'is-user' : 'is-assistant'}${turn.phase === 'commentary' ? ' is-progress' : ''}" data-message-id="${esc(turn.id)}"><div class="assistant-avatar">${user ? '田' : '<img src="assets/assistant/penguin.png" alt="企鹅助理">'}</div><div class="assistant-message-main"><div class="assistant-bubble">${user ? `<div class="assistant-user-text">${esc(text)}</div>` : renderMarkdown(text)}${projection ? `<details class="assistant-turn-context"><summary>本轮请求与资料目录</summary><pre>${esc(projection.rawText)}</pre></details>` : ''}</div><div class="assistant-message-time">${local ? '正在等待原生记录 · ' : turn.phase === 'commentary' ? '进展 · ' : ''}${esc(stamp)}</div></div></article>`;
  }
  async function refresh() {
    controls(); if (!visible || !sessionId) return;
    const sequence = ++readSequence, id = sessionId, s = getSession(id);
    try {
      const result = await ipcRenderer.invoke('parse-session-transcript', { hubSessionId:id, kind:s?.kind || 'codex', ccSessionId:s?.codexSid, transcriptPath:s?.transcriptPath, opts:{ limit:80, fromTail:true } });
      if (!visible || sequence !== readSequence || id !== sessionId) return;
      if (result?.error && !(result.turns?.length)) throw new Error(result.error);
      const turns = displayTurns(result?.turns || []).filter(t => ['user','assistant'].includes(t.role) && t.text && t.phase !== 'activity');
      if (pending && turns.some(t => t.role === 'user' && (assistantContextDisplay(t.text, 'hub-assistant')?.userText ?? t.text) === pending.text && (!t.ts || t.ts >= pending.ts - 2000))) pending = null;
      const html = turns.map(t => bubble(t)).join('') + (pending ? bubble(pending, true) : '');
      if (html !== rendered) {
        const stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 100;
        rendered = html; feed.innerHTML = html || '<div class="assistant-chat-empty">告诉我你想了解什么，或把下一件事交给我。<br><span>回答会保留在同一个助理会话里。</span></div>';
        if (stick || pending) feed.scrollTop = feed.scrollHeight;
      }
      if (delivery?.status === 'confirmed' && !submitting) state(require('../core/session-runtime-truth').sessionRuntimeIsActive(s) ? '助理正在处理，可以随时查看原生终端。' : '已同步原生会话记录');
    } catch (error) { if (sequence === readSequence && visible) state(`记录暂未同步：${error.message}。可刷新或查看原会话。`, true); }
    controls();
  }
  function receipt(event) {
    if (event?.sessionId !== sessionId || !applyPromptReceipt(delivery, event)) return;
    if (delivery.status === 'confirmed') state('消息已送达，正在等待助理回答…');
    else if (delivery.status === 'content-mismatch') state('原生收到的正文与提交内容有差异，请先查看原会话核对。', true);
    else if (delivery.status === 'unconfirmed') state('正在核对消息是否送达，请勿重复发送。');
    else if (delivery.status === 'failed') state('发送未确认，请先查看原会话。', true);
    void refresh();
  }
  async function send() {
    if (sendButton.disabled || submitting) return;
    const text = input.value.trim(), revision = draftVersion;
    if (!text) return;
    submitting = true; controls(); state('正在连接助理…');
    try {
      const ensured = await ensureSession(); sessionId = ensured.sessionId;
      const requestId = require('node:crypto').randomUUID(); delivery = beginPromptDelivery(requestId);
      pending = { id:'pending-' + requestId, role:'user', text, ts:Date.now() };
      state('正在发送…'); void refresh();
      const result = await ipcRenderer.invoke('session:send-prompt', { sessionId, text, clientSubmissionId:requestId, memoryIndex:false, assistantPage:true });
      if (result?.notSent || result?.ok === false && !result?.unconfirmed) { pending = null; throw new Error(result.message || result.error || '消息尚未发送'); }
      if (revision === draftVersion && input.value.trim() === text) { input.value = ''; draftVersion++; persist(); }
      if (result?.receipt) receipt(result.receipt);
      else state('请求已交给原生会话，正在等待记录…');
      onChanged?.();
    } catch (error) { state(`发送尚未完成：${error.message}。草稿已保留。`, true); }
    finally { submitting = false; controls(); void refresh(); }
  }
  input.addEventListener('input', () => { draftVersion++; persist(); controls(); });
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(); } });
  sendButton.addEventListener('click', () => void send());
  ipcRenderer.on('session:prompt-receipt', (_event, value) => receipt(value));
  for (const channel of ['turn-complete-event','session-updated','session-meta-updated','native-agent-item']) ipcRenderer.on(channel, (_event, value) => {
    if ((value?.sessionId || value?.hubSessionId || value?.session?.id || value?.id) === sessionId && visible) { clearTimeout(timer); timer = setTimeout(() => void refresh(), 180); }
  });
  return {
    setSession(id) { const changed = sessionId !== id; if (changed) { sessionId = id; readSequence++; rendered = ''; } controls(); if (changed) void refresh(); },
    setVisible(value) { visible = value; if (!value) { readSequence++; clearTimeout(timer); } else void refresh(); },
    refresh, send,
    appendDraft(text) { input.value = input.value ? input.value + '\n\n' + text : text; draftVersion++; persist(); controls(); input.focus(); },
    get sessionId() { return sessionId; },
  };
}
module.exports = { createAssistantConversation };
