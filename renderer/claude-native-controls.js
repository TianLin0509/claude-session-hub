'use strict';

function createClaudeNativeControls({ sessionId, ipcRenderer, onHistory, onRestoreDraft }) {
  const element = document.createElement('section');
  element.className = 'claude-native-controls codex-native-controls';
  element.hidden = true;
  element.setAttribute('aria-label', '原生会话操作');
  // Only for what needs the user: the same contract as the Codex panel, which
  // stays hidden unless there is an approval, a recovery step or an error.
  // Runtime status belongs to the composer and is not repeated here.
  const notice = document.createElement('div');
  notice.className = 'claude-native-notice';
  // Plan mode is a session-wide setting, so it gets the same banner and
  // "切回默认模式" button as the Codex panel instead of a bare /plan off.
  // Built and mounted only while plan mode is on: a hidden button here would
  // still be the panel's first button and swallow clicks meant for a form.
  let modeBox = null, modeReset = null;
  function mountModeBox(runtime) {
    if (!modeBox) {
      modeBox = document.createElement('div'); modeBox.className = 'codex-native-mode';
      const text = document.createElement('span'); text.textContent = '计划模式 · 只讨论不改文件；后续消息沿用此模式。';
      const modeError = document.createElement('div'); modeError.className = 'codex-native-error';
      modeReset = document.createElement('button'); modeReset.type = 'button'; modeReset.textContent = '切回默认模式';
      modeReset.addEventListener('click', async () => {
        modeReset.disabled = true; modeError.textContent = '';
        try {
          const result = await ipcRenderer.invoke('claude-native:set-permission-mode', { sessionId, mode: 'default' });
          if (!result?.ok) throw new Error(result?.error || '引擎未确认');
        } catch (failure) { modeError.textContent = failure.message; modeReset.disabled = false; }
      });
      modeBox.append(text, modeReset, modeError);
    }
    if (!modeBox.isConnected) element.insertBefore(modeBox, requests);
    modeReset.disabled = viewer || runtime.connection !== 'connected'
      || !['idle', 'completed', 'failed', 'interrupted'].includes(runtime.state);
  }
  const requests = document.createElement('div');
  const recovery = document.createElement('div');
  const error = document.createElement('div'); error.className = 'claude-native-error';
  error.style.color = '#e88'; error.setAttribute('role', 'alert');
  let displayedActionError = null;
  element.append(notice, requests, recovery, error);
  const refreshVisibility = () => {
    element.hidden = !(notice.textContent || modeBox?.isConnected || requests.childElementCount
      || recovery.childElementCount || error.textContent);
  };
  let signature = '';
  let viewer = false;
  const forms = new Map();
  const pendingForms = new WeakSet();
  let recoveryKey = '';
  let recoveryVersion = { epoch: 0, revision: -1 };
  const recoverySignature = runtime => JSON.stringify([runtime.epoch, runtime.state === 'unknown', runtime.connection, runtime.recoveryReady,viewer]);
  async function inspectRecovery(button, reconnect = false) {
    button.disabled = true; error.textContent = '';
    try {
      const result = await ipcRenderer.invoke('claude-native:' + (reconnect ? 'reconnect' : 'inspect-recovery'), { sessionId });
      if (!result?.ok) throw new Error(result?.error || '核对失败');
      recoveryKey = recoverySignature(result.runtime);
      recoveryVersion = { epoch: result.runtime.epoch, revision: result.runtime.revision };
      recovery.replaceChildren();
      const history = document.createElement('button'); history.textContent = '查看历史';
      history.addEventListener('click', () => Promise.resolve(onHistory?.()).catch(e => { error.textContent = e.message; }));
      recovery.append(history);
      for (const record of result.records) {
        const row = document.createElement('details');
        const title = document.createElement('summary');
        title.textContent = record.nativeActivity ? '待核对后台活动 ' + record.userMessageId
          : '待核对消息 ' + record.userMessageId + (record.accepted ? '（曾确认收到）' : '（未确认收到）');
        const original = document.createElement('pre'); original.textContent = record.text;
        original.style.cssText = 'max-height:160px;overflow:auto;white-space:pre-wrap';
        const resolve = document.createElement('button');
        resolve.className = 'claude-reconcile'; resolve.textContent = '我已核对，继续会话（不重发）';
        resolve.disabled = viewer || !result.runtime.recoveryReady;
        resolve.addEventListener('click', async () => {
          if(viewer)return;
          resolve.disabled = true;
          try {
            const response = await ipcRenderer.invoke('claude-native:reconcile', { sessionId,
              identity: { ...record, text: undefined, content: undefined, resolution: 'do-not-replay' } });
            if (!response?.ok) throw new Error(response?.error || '核对未保存');
            row.remove();
          } catch (e) { error.textContent = e.message; resolve.disabled = viewer; }
        });
        const restore = document.createElement('button'); restore.textContent = '复制原文为新草稿';
        restore.className = 'claude-recovery-copy';
        restore.addEventListener('click', () => {
          try { onRestoreDraft?.(record); } catch (e) { error.textContent = e.message; }
        });
        row.append(title, original, resolve);
        if (!record.nativeActivity) row.append(restore);
        recovery.append(row);
      }
    } catch (failure) { error.textContent = failure.message; button.disabled = false; }
    refreshVisibility();
  }
  async function act(request, decision, button) {
    if(viewer)return;
    const form = button.closest('form');
    if (pendingForms.has(form)) return;
    pendingForms.add(form);
    form.querySelectorAll('button,input,textarea,select').forEach(control => { control.disabled = true; });
    error.textContent = '';
    try {
      const result = await ipcRenderer.invoke('claude-native:respond', { sessionId, requestId: request.id,
        epoch: request.epoch, submissionId: request.submissionId, decision });
      if (!result?.ok) throw new Error(result?.error || '操作未确认');
    } catch (failure) {
      error.textContent = failure.message; pendingForms.delete(form);
      form.querySelectorAll('button,input,textarea,select').forEach(control => { control.disabled = viewer; });
    }
    refreshVisibility();
  }
  function update(session) {
    if (session?.runtimeBackend !== 'claude-stream-json') { element.hidden = true; return; }
    const runtime = session.nativeRuntime || {};
    viewer = require('../core/session-observer-policy').isSessionViewer(session);
    notice.textContent = runtime.configurationChange?.status === 'unknown' ? '设置结果待核对：等待 Claude 回执，或重连后重新确认设置。'
      : runtime.configurationChange ? '正在更新设置，等待 Claude 确认'
      : runtime.cancellation?.status === 'unknown' ? '停止结果待核对：继续等待 Claude 的结束回执，当前不会发送新任务。'
      : runtime.cancellation?.status === 'pending' ? '正在停止，等待 Claude 确认'
      : runtime.connection === 'unstarted' ? '尚未开始，收到消息后启动。' : '';
    if (runtime.permissionMode === 'plan') mountModeBox(runtime);
    else if (modeBox?.isConnected) modeBox.remove();
    const actionError = session.nativeActionError || null;
    if (actionError !== displayedActionError) {
      if (actionError) error.textContent = actionError;
      else if (error.textContent === displayedActionError) error.textContent = '';
      displayedActionError = actionError;
    }
    const nextRecoveryKey = recoverySignature(runtime);
    const currentRecovery = runtime.epoch > recoveryVersion.epoch
      || (runtime.epoch === recoveryVersion.epoch && runtime.revision >= recoveryVersion.revision);
    if (currentRecovery && nextRecoveryKey !== recoveryKey) {
      recoveryVersion = { epoch: runtime.epoch, revision: runtime.revision };
      recoveryKey = nextRecoveryKey; recovery.replaceChildren();
      if (runtime.state === 'unknown' || runtime.connection === 'disconnected') {
        const reconnect = document.createElement('button');
        reconnect.className = 'claude-reconnect';
        reconnect.textContent = runtime.recoveryReady ? '核对待确认消息' : '重连并核对（不重发）';
        reconnect.disabled = viewer && !runtime.recoveryReady;
        reconnect.addEventListener('click', () => inspectRecovery(reconnect, !runtime.recoveryReady));
        recovery.append(reconnect);
      }
    }
    const activeRequests = runtime.cancellation?.status === 'pending' ? [] : runtime.requests || [];
    const next = JSON.stringify([runtime.epoch, viewer, activeRequests.map(item => [item.id,item.submissionId])]);
    if (next === signature) { refreshVisibility(); return; }
    signature = next;
    const children = [];
    for (const request of activeRequests) {
      const key = JSON.stringify([runtime.epoch, request.id, request.submissionId]);
      if (forms.has(key)) { children.push(forms.get(key)); continue; }
      const box = document.createElement('form'); box.dataset.requestId = request.id;
      box.className = 'codex-native-request';
      box.dataset.epoch = String(runtime.epoch);
      const title = document.createElement('strong');
      title.textContent = request.method === 'claude/requestUserInput' ? 'Claude 需要你回答' : '工具审批：' + request.params.toolName;
      box.append(title);
      const inputs = [];
      if (request.method === 'claude/requestUserInput') {
        for (const question of request.params.questions || []) {
          const label = document.createElement('label'); label.style.display = 'block';
          label.textContent = question.question;
          const input = document.createElement(question.isSecret ? 'input' : 'textarea'); input.required = true;
          if (question.isSecret) input.type = 'password';
          input.rows = 2; input.setAttribute('aria-label', question.question);
          input.disabled = viewer;
          label.append(input); box.append(label); inputs.push([question.question, input]);
          for (const option of question.options || []) {
            const choose = document.createElement('button'); choose.type = 'button';
            choose.textContent = option.label; choose.title = option.description || '';
            choose.addEventListener('click', () => {
              if (viewer || pendingForms.has(box)) return;
              if (question.multiSelect) {
                const values = input.value ? input.value.split(', ') : [];
                input.value = values.includes(option.label) ? values.filter(value=>value!==option.label).join(', ')
                  : [...values, option.label].join(', ');
              } else input.value = option.label;
              input.focus();
            });
            box.append(choose);
          }
        }
      } else {
        const detail = document.createElement('pre');
        detail.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:18vh;overflow:auto';
        detail.textContent = JSON.stringify(request.raw.input, null, 2); box.append(detail);
      }
      const allow = document.createElement('button'); allow.type = 'submit';
      allow.textContent = inputs.length ? '提交回答' : '允许本次';
      const deny = document.createElement('button'); deny.type = 'button'; deny.textContent = '拒绝';
      allow.disabled = viewer; deny.disabled = viewer;
      const actions = document.createElement('div'); actions.className = 'codex-native-actions';
      actions.append(allow, deny); box.append(actions);
      box.addEventListener('submit', event => {
        event.preventDefault();
        if (!box.reportValidity()) return;
        act(request, { behavior: 'allow', updatedInput: inputs.length
          ? { ...request.raw.input, answers: Object.fromEntries(inputs.map(([question, input]) => [question, input.value])) }
          : request.raw.input }, allow);
      });
      deny.addEventListener('click', () => act(request, { behavior: 'deny' }, deny));
      forms.set(key, box); children.push(box);
    }
    const focused = document.activeElement;
    const keep = new Set(children);
    for (const [key, form] of forms) if (!keep.has(form)) forms.delete(key);
    children.forEach((child,index) => {
      if (requests.children[index] !== child) requests.insertBefore(child,requests.children[index] || null);
      child.querySelectorAll('button,input,textarea,select').forEach(control => {
        control.disabled = viewer || pendingForms.has(child);
      });
    });
    while (requests.children.length > children.length) requests.lastElementChild.remove();
    if (focused && requests.contains(focused) && document.activeElement !== focused) focused.focus();
    refreshVisibility();
  }
  return { element, update };
}

module.exports = { createClaudeNativeControls };
