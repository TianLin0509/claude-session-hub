'use strict';

function createClaudeNativeControls({ sessionId, ipcRenderer, onHistory, onRestoreDraft }) {
  const element = document.createElement('div');
  element.className = 'claude-native-controls';
  element.hidden = true;
  element.style.cssText = 'max-height:42vh;overflow:auto;padding:8px 12px;border-top:1px solid var(--border-color,#444);font-size:13px;white-space:pre-wrap';
  const status = document.createElement('div');
  const requests = document.createElement('div');
  const recovery = document.createElement('div');
  const error = document.createElement('div'); error.style.color = '#e88'; error.setAttribute('role', 'alert');
  let displayedActionError = null;
  element.append(status, requests, recovery, error);
  let signature = '';
  let recoveryKey = '';
  let recoveryVersion = { epoch: 0, revision: -1 };
  const recoverySignature = runtime => JSON.stringify([runtime.epoch, runtime.state === 'unknown', runtime.connection, runtime.recoveryReady]);
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
        resolve.disabled = !result.runtime.recoveryReady;
        resolve.addEventListener('click', async () => {
          resolve.disabled = true;
          try {
            const response = await ipcRenderer.invoke('claude-native:reconcile', { sessionId,
              identity: { ...record, text: undefined, content: undefined, resolution: 'do-not-replay' } });
            if (!response?.ok) throw new Error(response?.error || '核对未保存');
            row.remove();
          } catch (e) { error.textContent = e.message; resolve.disabled = false; }
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
  }
  async function act(request, decision, button) {
    button.disabled = true; error.textContent = '';
    try {
      const result = await ipcRenderer.invoke('claude-native:respond', { sessionId, requestId: request.id,
        epoch: request.epoch, submissionId: request.submissionId, decision });
      if (!result?.ok) throw new Error(result?.error || '操作未确认');
    } catch (failure) { error.textContent = failure.message; button.disabled = false; }
  }
  function update(session) {
    element.hidden = session?.runtimeBackend !== 'claude-stream-json';
    if (element.hidden) return;
    const runtime = session.nativeRuntime || {};
    const labels = { idle: '就绪', starting: '已收到，等待执行', running: '执行中', waiting: '等待你的回复', completed: '已完成',
      interrupted: '已停止', failed: '执行失败', unknown: '待核对' };
    status.textContent = 'Claude · ' + (labels[runtime.state] || '正在连接')
      + (runtime.queued?.length ? ` · ${runtime.queued.length} 条排队中` : '')
      + (runtime.backgroundTasks?.length ? ` · ${runtime.backgroundTasks.length} 个后台任务` : '')
      + (runtime.reason ? '\n' + runtime.reason : '');
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
        reconnect.addEventListener('click', () => inspectRecovery(reconnect, !runtime.recoveryReady));
        recovery.append(reconnect);
      }
    }
    const next = JSON.stringify([runtime.epoch, (runtime.requests || []).map(item => item.id)]);
    if (next === signature) return;
    signature = next; requests.replaceChildren();
    for (const request of runtime.requests || []) {
      const box = document.createElement('form'); box.dataset.requestId = request.id;
      const title = document.createElement('strong');
      title.textContent = request.method === 'claude/requestUserInput' ? 'Claude 需要你回答' : '工具审批：' + request.params.toolName;
      box.append(title);
      const inputs = [];
      if (request.method === 'claude/requestUserInput') {
        for (const question of request.params.questions || []) {
          const label = document.createElement('label'); label.style.display = 'block';
          label.textContent = question.question;
          if (question.options?.length) {
            const choices = document.createElement('div');
            choices.textContent = question.options.map(item => item.label + (item.description ? '：' + item.description : '')).join('\n');
            label.append(choices);
          }
          const input = document.createElement('input'); input.required = true; input.type = 'text';
          input.style.cssText = 'display:block;width:95%;margin:6px 0;padding:6px';
          label.append(input); box.append(label); inputs.push([question.question, input]);
        }
      } else {
        const detail = document.createElement('pre');
        detail.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:18vh;overflow:auto';
        detail.textContent = JSON.stringify(request.raw.input, null, 2); box.append(detail);
      }
      const allow = document.createElement('button'); allow.type = 'submit';
      allow.textContent = inputs.length ? '提交回答' : '允许本次';
      const deny = document.createElement('button'); deny.type = 'button'; deny.textContent = '拒绝';
      box.append(allow, deny);
      box.addEventListener('submit', event => {
        event.preventDefault();
        act(request, { behavior: 'allow', updatedInput: inputs.length
          ? { ...request.raw.input, answers: Object.fromEntries(inputs.map(([question, input]) => [question, input.value])) }
          : request.raw.input }, allow);
      });
      deny.addEventListener('click', () => act(request, { behavior: 'deny' }, deny));
      requests.append(box);
    }
  }
  return { element, update };
}

module.exports = { createClaudeNativeControls };
