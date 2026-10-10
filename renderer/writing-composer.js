'use strict';
const { modelOptionsFor } = require('../core/model-options');
const { KIND_LABELS, GROUP_MEMBER_KINDS } = require('../core/ai-kinds');
const paste = require('./composer-paste-chips');

function mountWritingComposer({ host, h, ipcRenderer, value = '', placeholder, label = '发送',
  target, onInput, onSend, referenceSession, disabled = false, canSend = () => true, allowEmpty = () => false }) {
  const document = host.ownerDocument;
  const input = h('div', { class: 'writing-input floating-input-box', contenteditable: 'true',
    role: 'textbox', 'aria-multiline': 'true', 'aria-label': placeholder, 'data-placeholder': placeholder });
  const rail = h('div', { class: 'writing-input-rail' });
  const status = h('div', { class: 'writing-input-status', role: 'status' });
  const send = h('button', { type: 'button', class: 'wr-btn primary floating-input-send', text: label });
  const body = h('div', { class: 'writing-composer composer' }, input, rail, status);
  host.append(body);
  const read = () => paste.expandPasteMarkers(input.innerText || '');
  const write = text => { paste.renderComposerValue(input, text, { document }); input.dispatchEvent(new Event('input', { bubbles: true })); };
  const changed = () => { onInput?.(read()); send.disabled = disabled || !canSend() || (!read().trim() && !allowEmpty()); };
  input.addEventListener('input', changed);
  const active = () => input.isConnected && input.getClientRects().length > 0 && input.isContentEditable;
  const append = text => write([read(), text].filter(Boolean).join('\n'));
  const filePath = file => require('electron').webUtils.getPathForFile(file) || file.path || '';
  const addFiles = files => {
    if (disabled) return;
    const paths = Array.from(files || []).map(filePath).filter(Boolean);
    if (paths.length) append(paths.map(p => `"${p}"`).join('\n'));
  };
  const files = h('input', { type: 'file', multiple: true, hidden: true });
  files.addEventListener('change', () => { addFiles(files.files); files.value = ''; });
  rail.append(h('button', { type: 'button', class: 'composer-chip', text: '附件', onclick: () => files.click() }), files);
  if (referenceSession) rail.append(h('button', { type: 'button', class: 'composer-chip', text: '引用会话', onclick: e => {
    void referenceSession(null, input, e.currentTarget, { isCurrent: active, saveDraft: changed, excludeMeetingId: target.meetingId || '' });
  } }));
  const expand = h('button', { type: 'button', class: 'composer-chip', text: '展开编辑', onclick: () => {
    const expanded = body.classList.toggle('writing-expanded'); expand.textContent = expanded ? '收起编辑' : '展开编辑'; input.focus();
  } });
  rail.append(expand, h('span', { class: 'wr-spacer' }), h('span', { class: 'writing-input-hint', text: 'Enter 发送' }), send);
  send.addEventListener('click', () => { if (!send.disabled) void onSend(read()); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault(); send.click();
    }
  });
  if (typeof attachContenteditablePasteImage === 'function') attachContenteditablePasteImage(input, { collapseLongText: true });
  else input.addEventListener('paste', event => {
    const text = event.clipboardData?.getData('text/plain');
    if (text) {
      event.preventDefault();
      if (paste.shouldCollapsePaste(text)) paste.insertPasteChip(input, text, { document, window: document.defaultView });
      else document.execCommand('insertText', false, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  body.addEventListener('dragover', e => { if (Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault(); });
  body.addEventListener('drop', e => { if (e.dataTransfer?.files.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } });
  paste.attachPasteChipBehaviors(input, { document, window: document.defaultView });
  const voice = require('./voice-input').attachVoiceInput({ input, rail, getStatusHost: () => status,
    getTarget: () => target, isActive: t => t?.id === target.id && active() });
  const polish = require('./prompt-polish').attachPromptPolish({ input, rail, before: send, ipcRenderer,
    getTarget: () => target, isActive: id => id === target.id && active(), writeText: write });
  require('./composer-collapse').mountComposerCollapse({ document, host: body, before: send, input });
  write(value);
  const setDisabled = state => {
    disabled = state; input.contentEditable = String(!state);
    body.querySelectorAll('button').forEach(button => { button.disabled = state; }); changed();
  };
  setDisabled(disabled);
  return { input, rail, body, send, read, write, setDisabled, dispose() { voice.dispose(); polish.dispose(); } };
}

function mountWritingMembers({ host, h, members, onChange, disabled = false }) {
  const kinds = GROUP_MEMBER_KINDS;
  const modelOptions = (kind, selected) => {
    const options = modelOptionsFor(kind);
    if (selected && !options.some(o => o.id === selected)) options.unshift({ id: selected, label: selected });
    return [h('option', { value: '', text: '默认模型' }), ...options.map(o => h('option', { value: o.id, text: o.label }))];
  };
  const save = () => onChange(members.map(m => ({ ...m })));
  const draw = () => {
    host.replaceChildren(h('div', { class: 'writing-members-head' }, h('span', { text: '一起写' }),
      h('button', { type: 'button', class: 'composer-chip', text: '＋ 成员', disabled, onclick: () => {
        members.push({ kind: 'codex' }); save(); draw();
      } })));
    members.forEach((member, i) => {
      const kind = h('select', { class: 'wr-select writing-member-kind', 'aria-label': `成员 ${i + 1} AI`, disabled },
        ...[...new Set([...kinds, member.kind])].map(k => h('option', { value: k, text: KIND_LABELS[k] || k })));
      kind.value = member.kind;
      const model = h('select', { class: 'wr-select writing-member-model', 'aria-label': `成员 ${i + 1} 模型`, disabled }, ...modelOptions(member.kind, member.model));
      model.value = member.model || '';
      const effort = h('select', { class: 'wr-select writing-member-effort', 'aria-label': `成员 ${i + 1} 推理`, disabled },
        h('option', { value: '', text: '默认推理' }));
      const resolved = window.WorkspaceController?.resolveSessionTuning(member.kind, member.model || undefined, member);
      const tuning = window.WorkspaceController?.codexModelTuning(resolved?.model || member.model);
      const levels = member.kind === 'codex' ? tuning?.efforts || ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] : [];
      for (const level of levels) { const id = typeof level === 'string' ? level : level.effort; if (id) effort.append(h('option', { value: id, text: id })); }
      effort.value = member.effort || ''; effort.hidden = !levels.length;
      const claudeFast = member.kind === 'claude' && require('../core/session-speed').claudeSupportsFast(resolved?.model || member.model);
      const speed = h('select', { class: 'wr-select writing-member-speed', 'aria-label': `成员 ${i + 1} 速度`, disabled },
        h('option', { value: '', text: '默认速度' }), h('option', { value: 'standard', text: '标准' }),
        h('option', { value: 'fast', text: '快速 · 更多用量', disabled: !claudeFast && !tuning?.supportsFast }));
      speed.hidden = member.kind !== 'codex' && !claudeFast;
      speed.value = member.kind === 'codex' ? member.codexSpeedTier || '' : typeof member.fastMode === 'boolean' ? member.fastMode ? 'fast' : 'standard' : '';
      kind.onchange = () => { Object.keys(member).forEach(k => delete member[k]); member.kind = kind.value; save(); draw(); };
      model.onchange = () => { member.model = model.value; delete member.effort; delete member.codexSpeedTier; delete member.fastMode; save(); draw(); };
      effort.onchange = () => { member.effort = effort.value; save(); };
      speed.onchange = () => {
        if (member.kind === 'codex') { if (speed.value) member.codexSpeedTier = speed.value; else delete member.codexSpeedTier; }
        else if (speed.value) member.fastMode = speed.value === 'fast'; else delete member.fastMode;
        save();
      };
      host.append(h('div', { class: 'writing-member-row' }, kind, model, effort, speed,
        h('button', { type: 'button', class: 'composer-chip writing-member-remove', text: '×', 'aria-label': `移除成员 ${i + 1}`, disabled,
          onclick: () => { members.splice(i, 1); save(); draw(); } })));
    });
  };
  draw();
}
module.exports = { mountWritingComposer, mountWritingMembers };
