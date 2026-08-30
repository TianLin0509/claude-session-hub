'use strict';

function createChatgptBridgeController(options = {}) {
  const document = options.document;
  const window = options.window;
  const ipcRenderer = options.ipcRenderer;
  const getActiveSessionId = options.getActiveSessionId || (() => null);
  const getLatestAssistantText = options.getLatestAssistantText || (() => '');
  let pullButton = null;
  let pushButton = null;
  let toast = null;
  let toastTimer = null;

  function showStatus(message, state = 'working') {
    if (!document || !document.body) return;
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'chatgpt-bridge-status';
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      Object.assign(toast.style, {
        position: 'fixed',
        right: '24px',
        bottom: '24px',
        zIndex: '12000',
        maxWidth: '440px',
        padding: '12px 16px',
        borderRadius: '12px',
        color: '#fff',
        fontSize: '13px',
        lineHeight: '1.55',
        whiteSpace: 'pre-line',
        boxShadow: '0 10px 32px rgba(0,0,0,.28)',
        transition: 'opacity .18s ease, transform .18s ease',
      });
      document.body.appendChild(toast);
    }
    if (toastTimer) {
      window.clearTimeout(toastTimer);
      toastTimer = null;
    }
    toast.textContent = message;
    toast.dataset.state = state;
    toast.style.background = state === 'error' ? '#9f2d2d' : (state === 'success' ? '#0f766e' : '#273b37');
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
    if (state !== 'working') {
      toastTimer = window.setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(8px)';
      }, state === 'error' ? 7000 : 5000);
    }
  }

  async function pullAndSend() {
    const sessionId = getActiveSessionId();
    if (!sessionId) {
      const result = { ok: false, error: '请先打开一个单聊会话。', code: 'session_not_found' };
      showStatus(result.error, 'error');
      return result;
    }
    if (pullButton) pullButton.disabled = true;
    showStatus('正在从公司 ChatGPT 拉取…', 'working');
    try {
      const result = await ipcRenderer.invoke('chatgpt-bridge:pull-and-send', { sessionId });
      if (!result || result.ok !== true) {
        const error = result && result.error ? result.error : '拉取失败。';
        showStatus(`拉取失败\n${error}`, 'error');
        return result || { ok: false, error };
      }
      if (result.new !== true) {
        showStatus('公司中转站暂无新内容', 'success');
        return result;
      }
      showStatus(
        `已拉取并发送给当前 AI${result.count ? `\n${result.count} 条内容` : ''}${result.warning ? `\n${result.warning}` : ''}`,
        result.warning ? 'error' : 'success',
      );
      return result;
    } catch (error) {
      const result = { ok: false, error: error && error.message ? error.message : String(error) };
      showStatus(`拉取失败\n${result.error}`, 'error');
      return result;
    } finally {
      if (pullButton) pullButton.disabled = false;
    }
  }

  async function pullForInput(applyContent) {
    showStatus('正在从公司 ChatGPT 拉取到输入框…', 'working');
    try {
      const result = await ipcRenderer.invoke('chatgpt-bridge:pull-for-input');
      if (!result || result.ok !== true) {
        const error = result && result.error ? result.error : '拉取失败。';
        showStatus(`拉取失败\n${error}`, 'error');
        return result || { ok: false, error };
      }
      if (result.new !== true || typeof result.content !== 'string' || !result.content.trim()) {
        showStatus('公司中转站暂无新内容', 'success');
        return { ...result, inserted: false, acknowledged: false };
      }
      if (typeof applyContent !== 'function') {
        const error = '输入框尚未准备好。';
        showStatus(`拉取失败\n${error}`, 'error');
        return { ok: false, error, code: 'input_not_ready' };
      }
      const applied = await applyContent(result.content, result);
      if (applied === false) {
        const error = '内容未能写入输入框。';
        showStatus(`拉取失败\n${error}`, 'error');
        return { ok: false, error, code: 'input_insert_failed' };
      }
      const messageIds = Array.from(new Set([
        ...(Array.isArray(result.message_ids) ? result.message_ids : []),
        ...(result.items || []).map(item => item && item.message_id),
      ].filter(value => typeof value === 'string' && value)));
      const ack = messageIds.length
        ? await ipcRenderer.invoke('chatgpt-bridge:ack', { messageIds })
        : { ok: true };
      const acknowledged = !!(ack && ack.ok === true);
      const fileHint = result.file_count ? `\n${result.file_count} 个文件已下载为绝对路径` : '';
      const warning = acknowledged ? '' : '\n游标确认失败，下次拉取可能重复';
      showStatus(`已拉取到输入框${fileHint}${warning}`, acknowledged ? 'success' : 'error');
      return { ...result, inserted: true, acknowledged, warning: warning.trim() || null };
    } catch (error) {
      const result = { ok: false, error: error && error.message ? error.message : String(error) };
      showStatus(`拉取失败\n${result.error}`, 'error');
      return result;
    }
  }

  async function pushText(text, label = '当前内容') {
    const value = String(text || '');
    if (!value.trim()) {
      const result = { ok: false, error: '没有可同步的文字。', code: 'empty_content' };
      showStatus(result.error, 'error');
      return result;
    }
    showStatus(`正在同步到公司 ChatGPT…\n${label}`, 'working');
    try {
      const result = await ipcRenderer.invoke('chatgpt-bridge:push', { text: value });
      if (!result || result.ok !== true) {
        const error = result && result.error ? result.error : '同步失败。';
        showStatus(`同步失败\n${error}`, 'error');
        return result || { ok: false, error };
      }
      showStatus(`已同步到公司 ChatGPT\n${label}`, 'success');
      return result;
    } catch (error) {
      const result = { ok: false, error: error && error.message ? error.message : String(error) };
      showStatus(`同步失败\n${result.error}`, 'error');
      return result;
    }
  }

  async function pushLatest() {
    if (pushButton) pushButton.disabled = true;
    try {
      const latest = await Promise.resolve(getLatestAssistantText());
      return await pushText(latest, '最近一条 AI 回答');
    } finally {
      if (pushButton) pushButton.disabled = false;
    }
  }

  function init() {
    pullButton = document && document.getElementById('chatgpt-bridge-pull');
    pushButton = document && document.getElementById('chatgpt-bridge-push');
    if (pullButton) pullButton.addEventListener('click', pullAndSend);
    if (pushButton) pushButton.addEventListener('click', pushLatest);
    return true;
  }

  return { init, pullAndSend, pullForInput, pushLatest, pushText, showStatus };
}

module.exports = { createChatgptBridgeController };
