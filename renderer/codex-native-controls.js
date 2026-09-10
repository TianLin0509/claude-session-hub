'use strict';

const { BACKEND } = require('../core/codex-native-runtime.js');

// Each form is bound to one server request and transport epoch. A state repaint
// never replaces typed answers, and a second click cannot reply twice.
function createCodexNativeControls({ sessionId, invoke, document: doc = document, openExternal }) {
  const element = doc.createElement('section');
  element.className = 'codex-native-controls';
  element.hidden = true;
  element.setAttribute('aria-label', 'Codex 操作');
  let signature = '';
  const forms = new Map();
  const node = (tag, text, className) => {
    const el = doc.createElement(tag);
    if (text != null) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  const action = async (payload, form, error) => {
    const buttons = [...form.querySelectorAll('button')];
    buttons.forEach(b => { b.disabled = true; });
    error.textContent = '';
    try {
      const result = await invoke('codex:native-action', { sessionId, ...payload });
      if (!result || !result.ok) throw new Error(result && result.message || 'Codex 未确认操作');
      if (payload.action === 'reply') error.textContent = '回答已送达，等待 Codex 确认';
    } catch (err) {
      error.textContent = err.message;
      buttons.forEach(b => { b.disabled = false; });
    }
  };
  function renderRequest(request, epoch) {
    const form = node('form', null, 'codex-native-request');
    form.dataset.requestId = String(request.id);
    form.dataset.epoch = String(epoch);
    const p = request.params || {};
    const error = node('div', '', 'codex-native-error');
    error.setAttribute('role', 'status');
    const controls = node('div', null, 'codex-native-actions');
    const reply = result => action({ action:'reply', requestId:request.id, epoch, result }, form, error);
    const button = (label, run) => {
      const b = node('button', label);
      b.type = 'button';
      b.addEventListener('click', run);
      controls.append(b);
    };
    if (request.method === 'item/tool/requestUserInput') {
      form.append(node('strong', p.isBlocking === false ? 'Codex 有一个问题，可在执行期间回答' : 'Codex 需要你的回答'));
      const fields = [];
      for (const q of p.questions || []) {
        const label = node('label', q.question || q.header || q.id);
        const input = node(q.isSecret ? 'input' : 'textarea');
        if (q.isSecret) input.type = 'password';
        input.name = q.id;
        input.setAttribute('aria-label', q.question || q.id);
        input.required = true;
        input.rows = 2;
        label.append(input);
        form.append(label);
        for (const option of q.options || []) {
          const choose = node('button', option.label);
          choose.type = 'button';
          choose.title = option.description || '';
          choose.addEventListener('click', () => { input.value = option.label; input.focus(); });
          form.append(choose);
        }
        fields.push([q.id,input]);
      }
      form.addEventListener('submit', event => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        reply({ answers:Object.fromEntries(fields.map(([id,input])=>[id,{answers:[input.value]}])) });
      });
      const send = node('button','提交回答');
      send.type = 'submit';
      controls.append(send);
    } else if (request.method === 'mcpServer/elicitation/request') {
      form.append(node('strong', 'MCP 需要确认'), node('p', p.message || ''));
      if (p.url && /^https?:\/\//i.test(p.url)) {
        button('打开验证页面', () => openExternal && openExternal(p.url));
      }
      let input;
      if (p.requestedSchema) {
        const details = node('details');
        details.append(node('summary','查看所需字段'),node('pre',JSON.stringify(p.requestedSchema,null,2)));
        input = node('textarea');
        input.setAttribute('aria-label','MCP 回答 JSON');
        input.placeholder = '按所需字段填写 JSON 对象';
        input.rows = 4;
        form.append(details,input);
      }
      button('确认', () => {
        let content = null;
        try {
          if (input) {
            content = JSON.parse(input.value);
            if (!content || Array.isArray(content) || typeof content !== 'object') throw new Error('请填写 JSON 对象');
          }
          reply({action:'accept',content});
        } catch(err) { error.textContent = err.message; }
      });
      button('拒绝', () => reply({action:'decline',content:null}));
      button('取消', () => reply({action:'cancel',content:null}));
    } else {
      form.append(node('strong', 'Codex 请求授权'));
      form.append(node('p', p.reason || '请查看具体操作后决定'));
      const operation = p.operation || {};
      const command = p.command || operation.command;
      if (command) form.append(node('pre', Array.isArray(command) ? command.join(' ') : command));
      if (p.cwd || operation.cwd) form.append(node('p', '工作目录：' + (p.cwd || operation.cwd)));
      for (const change of operation.changes || []) {
        form.append(node('strong', change.path), node('pre', change.diff || '文件内容未随请求提供'));
      }
      if (request.method === 'item/permissions/requestApproval') {
        form.append(node('pre', JSON.stringify(p.permissions || {}, null, 2)));
        form.append(node('p', '授权仅用于当前轮次。'));
      }
      const details = node('details');
      details.append(node('summary','查看完整请求'),node('pre',JSON.stringify(p,null,2)));
      form.append(details);
      button('允许本次', () => reply({decision:'accept'}));
      button('拒绝', () => reply({decision:'decline'}));
    }
    form.append(controls,error);
    return form;
  }
  function update(session) {
    if (!session || session.runtimeBackend !== BACKEND) {
      element.hidden = true;
      return;
    }
    const runtime = session.nativeRuntime;
    const requests = runtime && runtime.connection === 'connected' ? runtime.requests || [] : [];
    const choices = session.nativeThreadChoices || [];
    const next = JSON.stringify([runtime && runtime.epoch,requests,choices,session.nativeActionError,runtime?.configurationError,runtime?.submission?.status,runtime?.state,runtime?.connection,runtime?.collaborationMode]);
    if (signature === next) return;
    signature = next;
    // Reuse the actual form nodes. Resolving another request must preserve
    // focus, secret answers, draft text and a reply already in flight.
    const keep = new Set(requests.map(r => JSON.stringify([runtime.epoch,r.id])));
    for (const key of forms.keys()) if (!keep.has(key)) forms.delete(key);
    const children = [];
    if (runtime?.collaborationMode === 'plan') {
      const modeBox = node('div', null, 'codex-native-mode');
      modeBox.append(node('span', '计划模式 · 讨论与只读调查；后续消息沿用此模式。'));
      const error = node('div', '', 'codex-native-error');
      const reset = node('button', '切回默认模式'); reset.type = 'button';
      reset.disabled = runtime.connection !== 'connected' || !['idle', 'completed', 'failed', 'interrupted'].includes(runtime.state);
      reset.addEventListener('click', () => action({action:'collaboration-mode',mode:'default',epoch:runtime.epoch}, modeBox, error));
      modeBox.append(reset, error); children.push(modeBox);
    }
    if(runtime?.configurationError)children.push(node('p',runtime.configurationError,'codex-native-error'));
    if (runtime?.submission?.status === 'unknown') {
      const box=node('div',null,'codex-native-request');
      const error=node('div','','codex-native-error');
      box.append(node('p','上一条消息提交结果不明。核对原生记录前不会重发，也不会提交下一条。'));
      const check=node('button','核对原生记录');check.type='button';
      check.addEventListener('click',()=>action({action:'reconnect'},box,error));box.append(check);
      if (runtime.connection==='connected' && ['idle','completed','interrupted','failed'].includes(runtime.state)) {
        const reviewed=node('button','我已核对，允许发送新消息');reviewed.type='button';
        reviewed.addEventListener('click',()=>action({action:'review-submission',submissionId:runtime.submission.id,epoch:runtime.epoch},box,error));
        box.append(reviewed);
      }
      box.append(error);children.push(box);
    }
    if (session.nativeActionError) {
      children.push(node('p',session.nativeActionError,'codex-native-error'));
    }
    if (choices.length) {
      children.push(node('strong','选择要恢复的 Codex 会话'));
      const list = node('div',null,'codex-native-thread-list');
      const error = node('div','','codex-native-error');
      for (const thread of choices) {
        const b = node('button',(thread.name || thread.preview || thread.id) + ' · ' + (thread.cwd || ''));
        b.type = 'button';
        b.dataset.threadId = thread.id;
        b.addEventListener('click',()=>action({action:'choose-thread',threadId:thread.id},list,error));
        list.append(b);
      }
      children.push(list,error);
    }
    for (const request of requests) {
      const key = JSON.stringify([runtime.epoch,request.id]);
      if (!forms.has(key)) forms.set(key,renderRequest(request,runtime.epoch));
      children.push(forms.get(key));
    }
    const focused = doc.activeElement;
    // insertBefore keeps existing nodes attached, unlike replaceChildren.
    children.forEach((child,index) => {
      if (element.children[index] !== child) element.insertBefore(child,element.children[index] || null);
    });
    while (element.children.length > children.length) element.lastElementChild.remove();
    if (focused && element.contains(focused) && doc.activeElement !== focused) focused.focus();
    element.hidden = element.childElementCount === 0;
  }
  return { element, update };
}
module.exports = { createCodexNativeControls };
