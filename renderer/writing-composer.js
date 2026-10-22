'use strict';
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

// 成员卡与「新建 AI 群聊」同一套：样式用 meeting-create-modal.css 的 .mcm-*，模型、思考强度、速度
// 都按 WorkspaceController.resolveSessionTuning 算（2026-10-13 田哥：写作 Tab 的成员区和默认配置参考群聊，保持一致）。
// 新建入口里 DeepSeek 默认使用 DSH（deepseek-acp）；旧 Codex / Claude Code 接入
// 只留给历史会话恢复，本机存过的旧 DeepSeek 成员在这里换过来。
// 2026-10-22 田哥要求：写作成员与建群弹窗用同一份清单，群里能加的 AI 写作台都能加（包括 Antigravity）。
const deepseekProfile = require('../core/deepseek-claude-profile');
const LEGACY_DEEPSEEK_KINDS = new Set(['deepseek', 'deepseek-claude']);
const WRITING_MEMBER_KINDS = GROUP_MEMBER_KINDS.filter(kind => !LEGACY_DEEPSEEK_KINDS.has(kind));
const MEMBER_FIELDS = ['model', 'effort', 'codexSpeedTier', 'fastMode', 'deepseekRoute'];

function normalizeWritingMember(member = {}) {
  const requested = LEGACY_DEEPSEEK_KINDS.has(member.kind) ? 'deepseek-acp' : member.kind;
  const kind = WRITING_MEMBER_KINDS.includes(requested) ? requested : 'claude';
  const next = { kind };
  // 换了运行时（旧 DeepSeek → DSH），旧的模型名与调参不能带过去。
  if (kind === member.kind) for (const key of MEMBER_FIELDS) if (member[key] !== undefined && member[key] !== '') next[key] = member[key];
  return next;
}

function deepseekRouteOf(member, wc = window.WorkspaceController) {
  return deepseekProfile.normalizeRoute(member.deepseekRoute) || wc?.deepseekRouteState?.().route || deepseekProfile.DEFAULT_ROUTE;
}

function aiLogo(kind) {
  return `assets/ai-logos/${String(kind).startsWith('deepseek') ? 'deepseek' : kind}.svg`;
}

// 建写作群时送给 create-meeting 的成员：与建群弹窗同一套调参；选中的 DeepSeek 接入缺 Key 时直接拦下，不静默换线。
function writingMemberSlots(members, wc = window.WorkspaceController) {
  return members.map((raw, i) => {
    const member = normalizeWritingMember(raw);
    const route = member.kind === 'deepseek-claude' ? deepseekRouteOf(member, wc) : null;
    if (route) {
      const st = wc.deepseekRouteStatus?.(route) || { available: true };
      if (!st.available) throw new Error(`成员 ${i + 1}：${deepseekProfile.ROUTES[route].label}不可用：${st.reason}；请改选另一种接入方式`);
    }
    return { index: i, kind: member.kind, ...wc.buildSessionTuningOpts(member.kind, member.model, member), ...(route ? { deepseekRoute: route } : {}) };
  });
}

function mountWritingMembers({ host, h, members: input, onChange, disabled = false }) {
  const wc = window.WorkspaceController;
  const members = input.map(normalizeWritingMember);
  const save = () => onChange(members.map(m => ({ ...m })));
  const field = (name, control, cls) => h('label', { class: cls }, h('span', { class: 'mcm-slot-field-name', text: name }), control);
  const select = (cls, label, entries, value) => {
    const el = h('select', { class: cls, 'aria-label': label, disabled },
      ...entries.map(([id, text, off]) => h('option', { value: id, text, disabled: off })));
    el.value = value;
    return el;
  };
  const nextKind = () => {
    const present = new Set(members.map(m => m.kind));
    return WRITING_MEMBER_KINDS.find(kind => !present.has(kind)) || WRITING_MEMBER_KINDS[members.length % WRITING_MEMBER_KINDS.length];
  };
  const card = (member, i) => {
    const tuning = wc.resolveSessionTuning(member.kind, member.model, member);
    const name = KIND_LABELS[member.kind] || member.kind;
    const kind = select('writing-member-kind', `成员 ${i + 1} AI`,
      [...new Set([...WRITING_MEMBER_KINDS, member.kind])].map(k => [k, KIND_LABELS[k] || k]), member.kind);
    kind.onchange = () => { members[i] = normalizeWritingMember({ kind: kind.value }); save(); draw(); };
    const model = select('writing-member-model', `成员 ${i + 1} 模型`, tuning.modelOptions.map(o => [o.id, o.label || o.id]), tuning.model);
    // Codex 的思考强度与 Fast 跟模型目录走，换模型后重算这一张卡。
    model.onchange = () => { member.model = model.value; delete member.effort; delete member.codexSpeedTier; save(); draw(); };
    const fields = [field('AI', kind)];
    if (member.kind === 'deepseek-claude') {
      const current = deepseekRouteOf(member, wc);
      const status = id => wc.deepseekRouteStatus?.(id) || { available: true, reason: '' };
      const route = select('writing-member-route', `成员 ${i + 1} DeepSeek 接入`, deepseekProfile.ROUTE_IDS.map(id => {
        const st = status(id);
        return [id, deepseekProfile.ROUTES[id].label + (st.available ? (id === deepseekProfile.DEFAULT_ROUTE ? ' · 默认' : '') : ' · 不可用'), !st.available];
      }), current);
      route.onchange = () => { member.deepseekRoute = route.value; void wc.saveDeepseekRoute?.(route.value); save(); draw(); };
      fields.push(field('DeepSeek 接入', route));
      const st = status(current);
      if (!st.available) fields.push(h('small', { class: 'mcm-deepseek-route-note', role: 'status', text: `${deepseekProfile.ROUTES[current].label}不可用：${st.reason}` }));
    }
    fields.push(field('模型', model));
    if (tuning.showEffort && tuning.effortOptions.length) {
      const effort = select('writing-member-effort', `成员 ${i + 1} 思考强度`, tuning.effortOptions, tuning.effort);
      effort.onchange = () => { member.effort = effort.value; save(); };
      fields.push(field('思考强度', effort, 'mcm-tuning-field'));
    }
    if (tuning.showFast) {
      const fast = h('input', { type: 'checkbox', class: 'mcm-fast-checkbox writing-member-fast', 'aria-label': `成员 ${i + 1} Claude Fast`, disabled });
      fast.checked = !!tuning.fastMode;
      fast.onchange = () => { member.fastMode = fast.checked; save(); };
      fields.push(field('快速模式', h('span', { class: 'mcm-check' }, fast, ' 启用 Claude Fast'), 'mcm-tuning-field mcm-fast-field'));
    }
    if (tuning.showCodexTier) {
      const tier = select('writing-member-speed', `成员 ${i + 1} 速度通道`, tuning.codexTierOptions, tuning.codexSpeedTier);
      tier.onchange = () => { member.codexSpeedTier = tier.value; save(); };
      fields.push(field('速度通道', tier, 'mcm-tuning-field'));
    }
    return h('div', { class: 'mcm-slot mcm-group-member writing-member-row', 'data-kind': member.kind },
      members.length > 1 ? h('button', { type: 'button', class: 'mcm-remove-member writing-member-remove', text: '×', title: '移除此成员',
        'aria-label': `移除成员 ${i + 1}`, disabled, onclick: () => { members.splice(i, 1); save(); draw(); } }) : null,
      h('div', { class: 'mcm-slot-head' }, h('img', { class: 'mcm-avatar', src: aiLogo(member.kind), alt: name }),
        h('div', null, h('div', { class: 'mcm-slot-label', text: `成员 ${i + 1}` }), h('strong', { text: name }))),
      h('div', { class: 'mcm-slot-fields' }, ...fields));
  };
  const draw = () => {
    const add = nextKind();
    host.replaceChildren(
      h('div', { class: 'mcm-member-caption' }, h('strong', { text: '一起写' }),
        h('span', { text: '每位先独立起草，下一轮互相读稿再改。可继续加人，同一种 AI 也能多开。' })),
      h('div', { class: 'mcm-slots writing-member-cards' }, ...members.map(card)),
      h('button', { type: 'button', class: 'mcm-add-member writing-member-add', text: `+ 添加 ${KIND_LABELS[add] || add}`, disabled,
        onclick: () => { members.push(normalizeWritingMember({ kind: add })); save(); draw(); } }));
  };
  draw();
  // 本机存过的旧 DeepSeek 成员换到新接入后立即存回，建群时送出去的就是屏幕上看到的。
  if (JSON.stringify(members) !== JSON.stringify(input)) save();
  return { redraw: () => { if (host.isConnected) draw(); } };
}
module.exports = { mountWritingComposer, mountWritingMembers, normalizeWritingMember, writingMemberSlots, WRITING_MEMBER_KINDS };
