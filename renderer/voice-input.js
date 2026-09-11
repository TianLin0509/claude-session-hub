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
function insertText(input, text, range) {
  if (!range || !input.contains(range.commonAncestorContainer)) range = selectedRange(input);
  range.deleteContents();
  const node = document.createTextNode(text); range.insertNode(node); range.setStartAfter(node); range.collapse(true);
  input.focus(); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function showSettings(target) {
  if (document.querySelector('.voice-settings')) return;
  const overlay = document.createElement('div'); overlay.className = 'voice-settings';
  const dialog = document.createElement('section'); dialog.className = 'voice-settings-dialog';
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', '语音输入设置');
  const heading = document.createElement('h3'); heading.textContent = '语音输入设置';
  const note = document.createElement('p'); note.textContent = '录音发送至阿里云百炼，按语音服务计费。停止后只写入草稿，由你检查并发送。';
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

function attachVoiceInput({ input, rail, panelHost, getTarget, isActive }) {
  const mic = button('语音', 'voice-mic'); mic.title = '点击开始语音输入'; mic.setAttribute('aria-label', '开始语音输入');
  const settings = button('语音设置', 'voice-settings-button'); settings.title = '配置识别服务和项目术语';
  rail.classList.add('voice-enabled');
  rail.insertBefore(mic, rail.querySelector('.floating-input-send, #mr-workflow-btn'));
  const panel = document.createElement('div'); panel.className = 'voice-panel'; panel.hidden = true;
  const status = document.createElement('span'); status.className = 'voice-status'; status.setAttribute('role', 'status');
  const meter = document.createElement('meter'); meter.min = 0; meter.max = 1; meter.value = 0; meter.setAttribute('aria-label', '麦克风输入音量');
  const preview = document.createElement('div'); preview.className = 'voice-preview';
  const actions = document.createElement('div'); actions.className = 'voice-actions';
  const cancel = button('取消'); const keep = button('插入草稿'); keep.hidden = true;
  actions.append(cancel, keep, settings); panel.append(status, meter, preview, actions); panelHost.append(panel);
  let recording = null, disposed = false;
  const setStatus = message => { panel.hidden = false; status.textContent = message; };
  const sameTarget = r => isActive(r.target) && getTarget()?.id === r.target.id && input.isConnected && input.isContentEditable;
  const releaseAudio = async r => {
    if (r.timer) clearInterval(r.timer);
    r.stream?.getTracks().forEach(track => track.stop());
    r.source?.disconnect(); r.node?.disconnect();
    if (r.context && r.context.state !== 'closed') await r.context.close();
    meter.value = 0;
  };
  function finishUI(r) {
    r.ended = true;
    if (activeRecording === r) activeRecording = null;
    mic.textContent = '语音'; mic.disabled = false; mic.setAttribute('aria-label', '开始语音输入'); mic.setAttribute('aria-pressed', 'false');
    void releaseAudio(r).catch(error => setStatus(`麦克风关闭失败：${cleanError(error)}`));
  }
  async function cancelRecording() {
    const r = recording;
    if (r && !r.ended) {
      finishUI(r);
      try { await ipcRenderer.invoke('voice:cancel', r.id); } catch (error) { setStatus(cleanError(error)); return; }
    }
    recording = null; preview.textContent = ''; panel.hidden = true;
  }
  function fail(r, message) {
    if (recording !== r || r.ended) return;
    finishUI(r); keep.hidden = !preview.textContent;
    setStatus(`${message}。已有输入未改动；临时文字请检查后插入。`);
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
    if (activeRecording) { setStatus('已有录音正在进行，请先停止或取消。'); return; }
    if (recording && preview.textContent && !panel.hidden) { setStatus('请先插入或取消上次识别文字。'); return; }
    const target = getTarget();
    if (!target?.id || !isActive(target) || !input.isContentEditable) { setStatus('请先选择一个可编辑的会话。'); return; }
    const r = { id: randomUUID(), target, range: selectedRange(input), html: input.innerHTML, queue: Promise.resolve(), queuedBytes: 0, ended: false };
    recording = r; activeRecording = r; keep.hidden = true; preview.textContent = ''; mic.disabled = true;
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
        meter.value = data.peak;
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
        if (!sameTarget(r) || seconds >= 295) { void stop(r); return; }
        setStatus(`录音 ${seconds}s · ${Date.now() - r.lastSound > 5000 ? '未检测到声音，请检查麦克风' : '说完点击停止'} · 最长 5 分钟`);
      }, 250);
      setStatus('正在录音 · 说完点击停止');
    } catch (error) {
      const message = { NotAllowedError: '麦克风权限被拒绝，请在系统隐私设置中允许访问', NotFoundError: '未找到麦克风', NotReadableError: '麦克风被占用或无法读取' }[error.name] || cleanError(error);
      fail(r, message);
    }
  }
  function onEvent(_event, result) {
    const r = recording;
    if (!r || r.id !== result.id || r.ended || disposed) return;
    preview.textContent = result.text || '';
    if (result.type === 'error') { fail(r, result.message); return; }
    if (result.type !== 'done') return;
    finishUI(r);
    if (!result.text) { setStatus('未识别到文字，请检查麦克风后重试。'); return; }
    if (sameTarget(r) && input.innerHTML === r.html) {
      insertText(input, result.text, r.range); preview.textContent = ''; keep.hidden = true;
      setStatus('已写入草稿，请检查术语和数字后发送。');
    } else {
      keep.hidden = false; setStatus('草稿或会话已改变。请回到原会话，检查文字后点击插入草稿。');
    }
  }
  ipcRenderer.on('voice:event', onEvent);
  mic.onclick = () => { if (recording && !recording.ended) void stop(recording); else void start(); };
  mic.addEventListener('mousedown', event => event.preventDefault());
  cancel.onclick = () => void cancelRecording();
  keep.onclick = () => {
    if (!recording || !sameTarget(recording)) { setStatus('请回到开始录音的原会话再插入。'); return; }
    insertText(input, preview.textContent, selectedRange(input)); preview.textContent = ''; keep.hidden = true;
    setStatus('已写入草稿，请检查后发送。');
  };
  settings.onclick = () => { if (activeRecording) setStatus('请先停止或取消录音。'); else void showSettings(getTarget() || { project: '' }); };
  // Right-click also opens settings without adding a second toolbar icon.
  mic.addEventListener('contextmenu', event => { event.preventDefault(); settings.click(); });
  return { dispose() { disposed = true; void cancelRecording(); ipcRenderer.removeListener('voice:event', onEvent); mic.remove(); panel.remove(); } };
}
module.exports = { attachVoiceInput, insertText };
