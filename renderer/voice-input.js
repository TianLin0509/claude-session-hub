'use strict';
const { ipcRenderer } = require('electron');
const { randomUUID } = require('crypto');
let activeRecording = null;

function button(label, className = '') {
  const el = document.createElement('button'); el.type = 'button'; el.textContent = label;
  el.className = `voice-button ${className}`; return el;
}
function cleanError(error) { return String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
function selectedRange(input) {
  const selection = window.getSelection();
  if (selection?.rangeCount && input.contains(selection.getRangeAt(0).commonAncestorContainer)) return selection.getRangeAt(0).cloneRange();
  const range = document.createRange(); range.selectNodeContents(input); range.collapse(false); return range;
}
async function showSettings(target) {
  if (document.querySelector('.voice-settings')) return;
  const overlay = document.createElement('div'); overlay.className = 'voice-settings';
  const dialog = document.createElement('section'); dialog.className = 'voice-settings-dialog';
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', '语音输入设置');
  const heading = document.createElement('h3'); heading.textContent = '语音输入设置';
  const note = document.createElement('p'); note.textContent = '录音发送至阿里云百炼，按语音服务计费。识别文字实时写入输入框，由你检查并发送。';
  dialog.append(heading, note);
  const field = (label, tag = 'input') => {
    const wrap = document.createElement('label'); wrap.textContent = label;
    const el = document.createElement(tag); wrap.append(el); dialog.append(wrap); return el;
  };
  const key = field('百炼 API Key（留空保留现有密钥）'); key.type = 'password'; key.autocomplete = 'off';
  const region = field('API Key 所属地域', 'select');
  for (const [value, label] of [['beijing', '北京'], ['singapore', '新加坡']]) { const option = document.createElement('option'); option.value = value; option.textContent = label; region.append(option); }
  const workspace = field('Workspace ID（可选）');
  const terms = field('当前项目术语（每行一个，最多 80 个）', 'textarea'); terms.rows = 4; terms.placeholder = 'Codex\nElectron\nSINR\nSRS';
  const context = field('当前项目领域说明（可选，最多 400 字）', 'textarea'); context.rows = 2; context.placeholder = '例如：普通话夹英文的无线通信技术讨论。';
  const model = document.createElement('p'); model.className = 'voice-settings-note'; dialog.append(model);
  const status = document.createElement('p'); status.setAttribute('role', 'status'); dialog.append(status);
  const actions = document.createElement('div'); actions.className = 'voice-actions';
  const save = button('保存'); const clear = button('清除已保存密钥'); const close = button('关闭'); actions.append(save, clear, close); dialog.append(actions);
  overlay.append(dialog); document.body.append(overlay);
  let clearKey = false;
  clear.onclick = () => { clearKey = true; key.value = ''; status.textContent = '保存后清除本机密钥；环境变量提供的密钥不受影响。'; };
  const dismiss = () => { key.value = ''; overlay.remove(); };
  close.onclick = dismiss;
  overlay.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.stopPropagation(); dismiss(); }
    if (event.key === 'Tab') {
      const fields = [...dialog.querySelectorAll('input,select,textarea,button')].filter(el => !el.disabled);
      const first = fields[0], last = fields[fields.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  save.disabled = true;
  try {
    const config = await ipcRenderer.invoke('voice:config', target.project);
    if (!overlay.isConnected) return;
    region.value = config.region; workspace.value = config.workspace; terms.value = config.profile.terms; context.value = config.profile.context;
    model.textContent = `识别模型：${config.model} · 术语所属：${target.project || '通用项目'}`;
    status.textContent = config.keySet ? (config.envKey ? '正在使用环境变量中的密钥。' : '已保存密钥（系统加密）。') : '尚未配置密钥。';
    save.disabled = false; key.focus();
  } catch (error) { status.textContent = cleanError(error); }
  save.onclick = async () => {
    save.disabled = true;
    try {
      await ipcRenderer.invoke('voice:save-config', { project: target.project, region: region.value, workspace: workspace.value, apiKey: key.value, clearKey, profile: { terms: terms.value, context: context.value } });
      dismiss();
    } catch (error) { status.textContent = cleanError(error); save.disabled = false; }
  };
}

function attachVoiceInput({ input, rail, getStatusHost, getTarget, isActive }) {
  const mic = button('', 'voice-mic');
  const micIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>';
  mic.innerHTML = micIcon; mic.title = '点击开始语音输入'; mic.setAttribute('aria-label', '开始语音输入');
  mic.title = '点击开始语音输入 · 右键打开语音设置';
  rail.classList.add('voice-enabled');
  rail.insertBefore(mic, rail.querySelector('.floating-input-send, #mr-workflow-btn'));
  const status = document.createElement('span'); status.className = 'voice-status'; status.setAttribute('role', 'status');
  let recording = null, disposed = false, writing = false, statusTimer, statusHost;
  const setStatus = (message, expires = false) => {
    clearTimeout(statusTimer);
    const host = getStatusHost();
    if (statusHost !== host) statusHost?.classList.remove('voice-status-active');
    statusHost = host;
    if (host && status.parentElement !== host) host.append(status);
    status.textContent = message; status.title = message;
    status.hidden = !message;
    host?.classList.toggle('voice-status-active', !!message);
    if (expires) statusTimer = setTimeout(() => setStatus(''), 3000);
  };
  const sameTarget = r => isActive(r.target) && getTarget()?.id === r.target.id && input.isConnected && input.isContentEditable;
  const releaseAudio = async r => {
    if (r.timer) clearInterval(r.timer);
    r.stream?.getTracks().forEach(track => track.stop());
    r.source?.disconnect(); r.node?.disconnect();
    if (r.context && r.context.state !== 'closed') await r.context.close();
  };
  function finishUI(r) {
    r.ended = true;
    if (activeRecording === r) activeRecording = null;
    mic.innerHTML = micIcon; mic.disabled = false; mic.setAttribute('aria-label', '开始语音输入'); mic.setAttribute('aria-pressed', 'false');
    void releaseAudio(r).catch(error => setStatus(`麦克风关闭失败：${cleanError(error)}`));
  }
  async function cancelRecording() {
    const r = recording;
    recording = null; setStatus('');
    if (r && !r.ended) {
      finishUI(r);
      try { await ipcRenderer.invoke('voice:cancel', r.id); } catch (error) { setStatus(cleanError(error)); return; }
    }
  }
  function fail(r, message) {
    if (recording !== r || r.ended) return;
    finishUI(r);
    setStatus(`${message}。已识别文字保留在输入框。`);
    void ipcRenderer.invoke('voice:cancel', r.id).catch(error => setStatus(`取消识别失败：${cleanError(error)}`));
  }
  async function stop(r) {
    if (!r || r.ended || r.stopping) return;
    r.stopping = true; mic.disabled = true; setStatus('正在完成转写…');
    try {
      if (r.node) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('录音尾段读取超时')), 2500);
          r.flushed = () => { clearTimeout(timer); resolve(); };
          r.node.port.postMessage('flush');
        });
      }
      await releaseAudio(r);
      await r.queue;
      if (!r.ended) await ipcRenderer.invoke('voice:stop', r.id);
    } catch (error) { fail(r, cleanError(error)); }
  }
  async function start() {
    if (activeRecording) { setStatus('已有录音正在进行，请先停止。'); return; }
    const target = getTarget();
    if (!target?.id || !isActive(target) || !input.isContentEditable) { setStatus('请先选择一个可编辑的会话。'); return; }
    const r = { id: randomUUID(), target, range: selectedRange(input), html: input.innerHTML, queue: Promise.resolve(), queuedBytes: 0, ended: false };
    recording = r; activeRecording = r; mic.disabled = true;
    setStatus('正在准备麦克风…');
    try {
      const config = await ipcRenderer.invoke('voice:config', target.project);
      if (r.ended) return;
      if (!config.keySet) { finishUI(r); setStatus('请先在语音设置中填写百炼 API Key。'); await showSettings(target); return; }
      r.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      if (r.ended || !sameTarget(r)) { await releaseAudio(r); if (!r.ended) fail(r, '会话已切换，请回原会话重新录音'); return; }
      r.context = new AudioContext(); await r.context.resume();
      await r.context.audioWorklet.addModule(new URL('voice-pcm-worklet.js', window.location.href).href);
      if (r.ended) { await releaseAudio(r); return; }
      setStatus('正在连接百炼语音服务…');
      await ipcRenderer.invoke('voice:start', { id: r.id, project: target.project, sampleRate: r.context.sampleRate });
      if (r.ended) { await ipcRenderer.invoke('voice:cancel', r.id); return; }
      r.source = r.context.createMediaStreamSource(r.stream);
      r.node = new AudioWorkletNode(r.context, 'hub-voice-pcm', { channelCount: 1, channelCountMode: 'explicit', numberOfInputs: 1, numberOfOutputs: 1 });
      r.node.port.onmessage = ({ data }) => {
        if (data.flushed) { r.flushed?.(); return; }
        if (r.ended || !data.pcm) return;
        if (data.peak > .01) r.lastSound = Date.now();
        r.queuedBytes += data.pcm.byteLength;
        if (r.queuedBytes > r.context.sampleRate * 4) { fail(r, '网络发送积压，请分段重试'); return; }
        r.queue = r.queue.then(async () => {
          if (!r.ended) await ipcRenderer.invoke('voice:audio', { id: r.id, data: new Uint8Array(data.pcm) });
          r.queuedBytes -= data.pcm.byteLength;
        }).catch(error => fail(r, cleanError(error)));
      };
      r.node.onprocessorerror = () => fail(r, '麦克风音频处理失败');
      r.source.connect(r.node); r.node.connect(r.context.destination);
      for (const track of r.stream.getTracks()) track.addEventListener('ended', () => { if (!r.stopping) fail(r, '麦克风已断开'); });
      r.started = Date.now(); r.lastSound = r.started;
      mic.disabled = false; mic.textContent = '停止'; mic.setAttribute('aria-label', '停止语音输入'); mic.setAttribute('aria-pressed', 'true');
      r.timer = setInterval(() => {
        const seconds = Math.floor((Date.now() - r.started) / 1000);
        if (!sameTarget(r)) { void cancelRecording(); return; }
        if (seconds >= 295) { void stop(r); return; }
        setStatus(`录音 ${seconds}s · ${Date.now() - r.lastSound > 5000 ? '未检测到声音，请检查麦克风' : '说完点击停止'} · 最长 5 分钟`);
      }, 250);
      setStatus('正在录音 · 说完点击停止');
    } catch (error) {
      const message = { NotAllowedError: '麦克风权限被拒绝，请在系统隐私设置中允许访问', NotFoundError: '未找到麦克风', NotReadableError: '麦克风被占用或无法读取' }[error.name] || cleanError(error);
      fail(r, message);
    }
  }
  // Only replace the text node owned by this recording. Existing text/attachments
  // keep their DOM identity, and partial hypotheses replace rather than append.
  function updateDraft(r, text) {
    if (!sameTarget(r)) { void cancelRecording(); return false; }
    if (input.innerHTML !== r.html) { onEdit(); return false; }
    if (!text && !r.textNode) return true;
    if (r.textNode && r.textNode.data === text) return true;
    writing = true;
    try {
      if (!r.textNode) {
        r.range.deleteContents(); r.textNode = document.createTextNode(''); r.range.insertNode(r.textNode);
      }
      const selection = window.getSelection();
      const follow = document.activeElement === input && (!selection?.rangeCount || selection.isCollapsed
        && (selection.anchorNode === r.textNode && selection.anchorOffset === r.textNode.length || !r.wrote));
      const anchor = selection?.anchorNode === r.textNode ? selection.anchorOffset : null;
      const focus = selection?.focusNode === r.textNode ? selection.focusOffset : null;
      r.textNode.data = text;
      if (follow) selection.setPosition(r.textNode, text.length);
      else if (anchor !== null && focus !== null) selection.setBaseAndExtent(r.textNode, Math.min(anchor, text.length), r.textNode, Math.min(focus, text.length));
      r.wrote = true; r.html = input.innerHTML;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } finally { writing = false; }
    return true;
  }
  function onEdit() {
    if (writing) return;
    if (recording && !recording.ended) {
      void cancelRecording();
      setStatus('已停止录音，可继续编辑。', true);
    } else setStatus('');
  }
  function onSubmit(event) {
    if (!recording || recording.ended) return;
    if (event.type === 'keydown' && (event.key !== 'Enter' || event.shiftKey || event.isComposing)) return;
    if (event.type === 'click' && !event.target.closest('.floating-input-send, #mr-send-btn, #mr-workflow-btn')) return;
    void cancelRecording();
  }
  function onEvent(_event, result) {
    const r = recording;
    if (!r || r.id !== result.id || r.ended || disposed) return;
    if (result.type === 'error') { fail(r, result.message); return; }
    if (!updateDraft(r, result.text || '')) return;
    if (result.type !== 'done') return;
    finishUI(r);
    if (!result.text) { setStatus('未识别到文字，请检查麦克风后重试。'); return; }
    setStatus('语音输入完成', true);
  }
  ipcRenderer.on('voice:event', onEvent);
  mic.onclick = () => { if (recording && !recording.ended) void stop(recording); else void start(); };
  mic.addEventListener('mousedown', event => event.preventDefault());
  input.addEventListener('beforeinput', onEdit);
  input.addEventListener('input', onEdit);
  input.addEventListener('compositionstart', onEdit);
  input.addEventListener('keydown', onSubmit, true);
  rail.addEventListener('click', onSubmit, true);
  mic.addEventListener('contextmenu', event => { event.preventDefault(); if (activeRecording) setStatus('请先停止录音。'); else void showSettings(getTarget() || { project: '' }); });
  return { dispose() {
    disposed = true; void cancelRecording(); clearTimeout(statusTimer);
    ipcRenderer.removeListener('voice:event', onEvent);
    input.removeEventListener('beforeinput', onEdit); input.removeEventListener('input', onEdit);
    input.removeEventListener('compositionstart', onEdit); input.removeEventListener('keydown', onSubmit, true);
    rail.removeEventListener('click', onSubmit, true);
    mic.remove(); status.remove(); statusHost?.classList.remove('voice-status-active');
  } };
}
module.exports = { attachVoiceInput };
