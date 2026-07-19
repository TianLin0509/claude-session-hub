'use strict';

// 串行工作流配置弹窗：所有修改即时回调并持久化，不存在“保存草稿”状态。
// stepPrompts 与 steps 同下标；每项是 { [memberId]: extraPrompt }，只注入对应步骤/AI。
(function () {

const PLAN_PROMPT = '你负责先提出方案。先澄清目标与约束，输出可执行方案、关键步骤、风险与验收标准；本步骤以方案设计为主，不抢跑执行。';
const EXECUTE_PROMPT = '你负责基于前序 Claude 方案进行批判性优化并执行落地。先指出缺口与改进，再在当前工作区实现，运行测试/验证，交付改动与证据；不要只复述方案。';
const TEMPLATES = [
  { id: 't1', name: 'T1 逐个接力', desc: '每个 AI 各占一步，按顺序依次串行回答' },
  { id: 't2', name: 'T2 并行 → 汇总', desc: '第 1 步全员并行，第 2 步指定一人收口' },
  { id: 't4', name: 'T4 Claude 方案 → Codex 落地', desc: 'Claude 先设计方案，Codex 批判优化、执行并验证' },
  { id: 't3', name: 'T3 自定义', desc: '自己定步数，每步任意勾选参与的 AI' },
];
const MAX_STEPS = 8;

let _modalEl = null;
let _state = null;
let _onSave = null;
let _escListener = null;
let _promptEditor = null;

function _escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function _aiLogo(kind) { return `assets/ai-logos/${_escapeHtml(kind || 'claude')}.svg`; }
function _memberTitle(memberId) {
  const m = (_state.members || []).find(x => x.memberId === memberId);
  return m ? (m.title || m.memberId) : memberId;
}
function _memberById(memberId) {
  return (_state.members || []).find(x => x.memberId === memberId) || null;
}
function _ensureStepPromptSlot(stepIdx) {
  if (!Array.isArray(_state.stepPrompts)) _state.stepPrompts = [];
  while (_state.stepPrompts.length <= stepIdx) _state.stepPrompts.push({});
  if (!_state.stepPrompts[stepIdx] || typeof _state.stepPrompts[stepIdx] !== 'object') {
    _state.stepPrompts[stepIdx] = {};
  }
  return _state.stepPrompts[stepIdx];
}
function _setStepPrompt(stepIdx, memberId, value) {
  const slot = _ensureStepPromptSlot(stepIdx);
  const next = String(value || '');
  if (next.trim()) slot[memberId] = next;
  else delete slot[memberId];
}

function _findRoleMember(role) {
  const members = _state.members || [];
  const re = role === 'claude' ? /claude/i : /(codex|gpt)/i;
  return members.find(m => re.test(`${m.kind || ''} ${m.title || ''}`)) || null;
}

function _applyTemplate(tplId) {
  const members = _state.members || [];
  if (tplId === 't1') {
    _state.steps = members.map(m => [m.memberId]);
    if (_state.steps.length === 0) _state.steps = [[]];
    _state.stepPrompts = _state.steps.map(() => ({}));
  } else if (tplId === 't2') {
    if (members.length === 0) _state.steps = [[]];
    else {
      const all = members.map(m => m.memberId);
      _state.steps = members.length === 1 ? [all] : [all, [members[0].memberId]];
    }
    _state.stepPrompts = _state.steps.map(() => ({}));
  } else if (tplId === 't4') {
    const claude = _findRoleMember('claude') || members[0] || null;
    const codex = _findRoleMember('codex') || members.find(m => !claude || m.memberId !== claude.memberId) || claude;
    _state.steps = [[claude && claude.memberId].filter(Boolean), [codex && codex.memberId].filter(Boolean)];
    _state.stepPrompts = [
      claude ? { [claude.memberId]: PLAN_PROMPT } : {},
      codex ? { [codex.memberId]: EXECUTE_PROMPT } : {},
    ];
  } else {
    if (!_state.steps || _state.steps.length === 0) _state.steps = [[]];
    while ((_state.stepPrompts || []).length < _state.steps.length) _state.stepPrompts.push({});
  }
  _state.templateId = tplId;
  _promptEditor = null;
}

function _applyLoopTemplate(id) {
  const ids = (_state.members || []).map(m => m.memberId);
  if (!_state.loop) _state.loop = { enabled: true, maxRounds: 8, consecutivePass: 1, polish: true };
  _state.loop.enabled = true;
  _state.enabled = true;
  if (id === 'L1') {
    _state.steps = ids.length >= 2 ? [[ids[0]], [ids[1]]] : [ids.slice(0, 1), []];
  } else if (id === 'L2') {
    _state.steps = ids.length >= 3 ? [[ids[0]], [ids[1]], [ids[2]]]
      : (ids.length === 2 ? [[ids[0]], [ids[1]]] : [ids.slice(0, 1), []]);
  } else if (!_state.steps || !_state.steps.length) {
    _state.steps = [[]];
  }
  _state.stepPrompts = _state.steps.map((_, i) => (_state.stepPrompts && _state.stepPrompts[i]) || {});
  _state.loopTemplateId = id;
  _state.templateId = null;
  _promptEditor = null;
}

function _setStepCount(n) {
  const steps = _state.steps || [];
  n = Math.max(1, Math.min(MAX_STEPS, n));
  while (steps.length < n) steps.push([]);
  while (steps.length > n) steps.pop();
  _state.steps = steps;
  if (!Array.isArray(_state.stepPrompts)) _state.stepPrompts = [];
  while (_state.stepPrompts.length < n) _state.stepPrompts.push({});
  while (_state.stepPrompts.length > n) _state.stepPrompts.pop();
  _state.templateId = null;
  _promptEditor = null;
}

function _toggleMember(stepIdx, memberId) {
  const step = _state.steps[stepIdx];
  if (!step) return;
  const i = step.indexOf(memberId);
  if (i >= 0) step.splice(i, 1); else step.push(memberId);
  _state.templateId = null;
}

function _syncLoopInputs() {
  if (!_state.loop) _state.loop = { enabled: false, maxRounds: 8, consecutivePass: 1, polish: true };
  const rounds = _modalEl && _modalEl.querySelector('#wf-loop-rounds');
  const green = _modalEl && _modalEl.querySelector('#wf-loop-green');
  if (rounds && rounds.value) _state.loop.maxRounds = Math.max(1, Math.min(30, parseInt(rounds.value, 10) || 8));
  if (green && green.value) _state.loop.consecutivePass = Math.max(1, Math.min(3, parseInt(green.value, 10) || 1));
}

function _serializeConfig() {
  _syncLoopInputs();
  const steps = (_state.steps || []).map(step => Array.isArray(step) ? [...step] : []);
  const hasMember = steps.some(step => step.length > 0);
  const stepPrompts = steps.map((_, idx) => ({ ...((_state.stepPrompts && _state.stepPrompts[idx]) || {}) }));
  const loopOn = !!(_state.loop && _state.loop.enabled) && hasMember;
  return {
    enabled: (!!_state.enabled || loopOn) && hasMember,
    templateId: _state.templateId || null,
    steps,
    stepPrompts,
    loop: {
      enabled: loopOn,
      maxRounds: (_state.loop && _state.loop.maxRounds) || 8,
      consecutivePass: (_state.loop && _state.loop.consecutivePass) || 1,
      polish: !(_state.loop && _state.loop.polish === false),
    },
  };
}

function _markApplied() {
  const status = _modalEl && _modalEl.querySelector('.wf-autosave-state');
  if (!status) return;
  status.textContent = '已自动生效';
  status.classList.add('is-saved');
  setTimeout(() => status.classList.remove('is-saved'), 500);
}

function _emitChange() {
  if (!_state) return;
  const config = _serializeConfig();
  if (typeof _onSave === 'function') _onSave(config);
  _markApplied();
}

function _previewHtml() {
  const steps = _state.steps || [];
  if (!steps.length) return '<span class="wf-empty">还没有步骤</span>';
  return steps.map(step => {
    if (!step.length) return '<span class="wf-empty">(未选)</span>';
    return step.map(mid => _escapeHtml(_memberTitle(mid))).join('<span class="wf-plus">+</span>');
  }).join('<span class="wf-arrow">→</span>');
}

function _promptEditorHtml(stepIdx) {
  if (!_promptEditor || _promptEditor.stepIdx !== stepIdx) return '';
  const memberId = _promptEditor.memberId;
  const member = _memberById(memberId);
  const prompt = ((_state.stepPrompts || [])[stepIdx] || {})[memberId] || '';
  return `<div class="wf-prompt-editor" data-step="${stepIdx}" data-member="${_escapeHtml(memberId)}">
    <div class="wf-prompt-editor-head">
      <strong>步骤 ${stepIdx + 1} · ${_escapeHtml((member && member.title) || memberId)} 的追加 prompt</strong>
      <button type="button" data-wf="prompt-close" aria-label="收起追加 prompt">×</button>
    </div>
    <textarea data-wf="prompt-input" data-step="${stepIdx}" data-member="${_escapeHtml(memberId)}"
      placeholder="只会追加给这个步骤里的这位 AI，不会显示成用户消息。">${_escapeHtml(prompt)}</textarea>
    <div class="wf-prompt-suggestions">
      <span>建议模板</span>
      <button type="button" data-wf="prompt-suggest" data-prompt-role="plan">Claude 方案设计</button>
      <button type="button" data-wf="prompt-suggest" data-prompt-role="execute">Codex 优化执行</button>
      <button type="button" data-wf="prompt-clear">清空</button>
    </div>
  </div>`;
}

function _bodyHtml() {
  const s = _state;
  const tplCards = TEMPLATES.map(t =>
    `<button type="button" class="wf-tpl-card${s.templateId === t.id ? ' selected' : ''}" data-wf="tpl" data-tpl="${t.id}">
       <span class="wf-tpl-name">${_escapeHtml(t.name)}</span>
       <span class="wf-tpl-desc">${_escapeHtml(t.desc)}</span>
     </button>`).join('');

  const loopOn = !!(s.loop && s.loop.enabled);
  const stepRows = (s.steps || []).map((step, idx) => {
    const chips = (s.members || []).map(m => {
      const selected = step.includes(m.memberId);
      const hasPrompt = !!((((s.stepPrompts || [])[idx] || {})[m.memberId] || '').trim());
      return `<span class="wf-member-control${hasPrompt ? ' has-prompt' : ''}">
        <button type="button" class="wf-member-chip${selected ? ' selected' : ''}" data-wf="chip" data-step="${idx}" data-member="${_escapeHtml(m.memberId)}"
          title="左键切换参与；右键自定义本步骤 prompt">
          <img src="${_aiLogo(m.kind)}" alt="">${_escapeHtml(m.title || m.memberId)}${hasPrompt ? '<span class="wf-prompt-dot">P</span>' : ''}
        </button>
        <button type="button" class="wf-prompt-trigger" data-wf="prompt" data-step="${idx}" data-member="${_escapeHtml(m.memberId)}"
          title="自定义本步骤 prompt" aria-label="自定义 ${_escapeHtml(m.title || m.memberId)} 的追加 prompt">⋯</button>
      </span>`;
    }).join('');
    const roleTag = loopOn
      ? `<span class="wf-role-tag ${idx === 0 ? 'is-builder' : 'is-reviewer'}">${idx === 0 ? '开发' : '评审'}</span>`
      : '';
    return `<div class="wf-step-block">
      <div class="wf-step-row">
        <span class="wf-step-index">${idx + 1}</span>${roleTag}
        <div class="wf-member-chips">${chips || '<span class="wf-empty">群里暂无可选 AI</span>'}</div>
      </div>
      ${_promptEditorHtml(idx)}
    </div>`;
  }).join('');
  const stepCount = (s.steps || []).length;

  return `<div class="wf-toggle-row">
    <div class="wf-toggle-text">
      <div class="wf-toggle-title">启用串行工作流</div>
      <div class="wf-toggle-sub">每步依次执行；同一步的多个 AI 并行。所有改动都会立即生效。</div>
    </div>
    <button type="button" class="wf-switch${s.enabled ? ' on' : ''}" data-wf="toggle" aria-label="启用开关"></button>
  </div>
  <div class="wf-config-area${s.enabled ? '' : ' disabled'}">
    <div class="wf-section-label">预设模板</div>
    <div class="wf-templates">${tplCards}</div>
    <div class="wf-section-label">步骤数</div>
    <div class="wf-stepcount">
      <button type="button" class="wf-stepper-btn" data-wf="step-dec"${stepCount <= 1 ? ' disabled' : ''}>−</button>
      <span class="wf-stepcount-val">${stepCount}</span>
      <button type="button" class="wf-stepper-btn" data-wf="step-inc"${stepCount >= MAX_STEPS ? ' disabled' : ''}>＋</button>
    </div>
    <div class="wf-section-label">每步参与的 AI · 右键或点 ⋯ 设置该 AI 的追加 prompt</div>
    <div class="wf-steps">${stepRows}</div>
    <div class="wf-preview"><span class="wf-preview-label">流程预览</span>${_previewHtml()}</div>
    <div class="wf-section-label wf-loop-title">循环模式 · 评审不过自动重来</div>
    <div class="wf-loop-row">
      <label><input type="checkbox" data-wf="loop-toggle" ${(s.loop && s.loop.enabled) ? 'checked' : ''}> 启用循环</label>
      <span>最多 <input id="wf-loop-rounds" type="number" min="1" max="30" value="${(s.loop && s.loop.maxRounds) || 8}"> 轮</span>
      <span>连续 <input id="wf-loop-green" type="number" min="1" max="3" value="${(s.loop && s.loop.consecutivePass) || 1}"> 轮绿即达标</span>
    </div>
    <div class="wf-loop-hint">循环模式：第 1 步是开发者；第 2 步起是评审者。</div>
    ${(s.loop && s.loop.enabled) ? `<div class="wf-loop-templates">
      <span>一键预设</span>
      <button type="button" class="wf-loop-template${s.loopTemplateId === 'L1' ? ' selected' : ''}" data-wf="loop-tpl" data-ltpl="L1">L1 开发+1评审</button>
      <button type="button" class="wf-loop-template${s.loopTemplateId === 'L2' ? ' selected' : ''}" data-wf="loop-tpl" data-ltpl="L2">L2 开发+2评审</button>
      <button type="button" class="wf-loop-template${s.loopTemplateId === 'L3' ? ' selected' : ''}" data-wf="loop-tpl" data-ltpl="L3">L3 自定义</button>
    </div>` : ''}
  </div>`;
}

function _ensureModal() {
  if (_modalEl && document.body.contains(_modalEl)) return _modalEl;
  _modalEl = document.createElement('div');
  _modalEl.id = 'workflow-config-modal';
  _modalEl.className = 'mcm-overlay';
  _modalEl.style.display = 'none';
  _modalEl.innerHTML = `<div class="mcm-dialog" role="dialog" aria-labelledby="wf-title-text" style="width:620px">
    <div class="mcm-header">
      <span class="mcm-title" id="wf-title-text">串行工作流</span>
      <button class="mcm-close" aria-label="关闭">×</button>
    </div>
    <div class="mcm-body" id="wf-body"></div>
    <div class="mcm-footer wf-footer">
      <span class="wf-autosave-state">改动自动生效</span>
      <button class="mcm-primary wf-done">完成</button>
    </div>
  </div>`;
  document.body.appendChild(_modalEl);
  _bindEvents();
  return _modalEl;
}

function _renderBody() {
  const body = _modalEl.querySelector('#wf-body');
  if (body) body.innerHTML = _bodyHtml();
}

function _openPrompt(stepIdx, memberId) {
  _promptEditor = { stepIdx, memberId };
  _ensureStepPromptSlot(stepIdx);
  _renderBody();
  const focus = () => {
    const textarea = _modalEl && _modalEl.querySelector(`textarea[data-wf="prompt-input"][data-step="${stepIdx}"][data-member="${memberId}"]`);
    if (textarea) { textarea.focus(); textarea.setSelectionRange(textarea.value.length, textarea.value.length); }
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focus); else setTimeout(focus, 0);
}

function _bindEvents() {
  _modalEl.addEventListener('click', (e) => {
    if (e.target === _modalEl || e.target.closest('.mcm-close') || e.target.closest('.wf-done')) {
      closeWorkflowConfigModal(); return;
    }
    const node = e.target.closest('[data-wf]');
    if (!node) return;
    const action = node.getAttribute('data-wf');
    if (action === 'toggle') { _state.enabled = !_state.enabled; _renderBody(); _emitChange(); }
    else if (action === 'tpl') { _applyTemplate(node.getAttribute('data-tpl')); _renderBody(); _emitChange(); }
    else if (action === 'step-inc') { _setStepCount((_state.steps || []).length + 1); _renderBody(); _emitChange(); }
    else if (action === 'step-dec') { _setStepCount((_state.steps || []).length - 1); _renderBody(); _emitChange(); }
    else if (action === 'chip') {
      _toggleMember(parseInt(node.getAttribute('data-step'), 10), node.getAttribute('data-member'));
      _renderBody(); _emitChange();
    } else if (action === 'prompt') {
      _openPrompt(parseInt(node.getAttribute('data-step'), 10), node.getAttribute('data-member'));
    } else if (action === 'prompt-close') {
      _promptEditor = null; _renderBody();
    } else if (action === 'prompt-suggest' && _promptEditor) {
      const role = node.getAttribute('data-prompt-role');
      _setStepPrompt(_promptEditor.stepIdx, _promptEditor.memberId, role === 'plan' ? PLAN_PROMPT : EXECUTE_PROMPT);
      _renderBody(); _emitChange();
    } else if (action === 'prompt-clear' && _promptEditor) {
      _setStepPrompt(_promptEditor.stepIdx, _promptEditor.memberId, '');
      _renderBody(); _emitChange();
    } else if (action === 'loop-toggle') {
      _syncLoopInputs(); _state.loop.enabled = !_state.loop.enabled; _renderBody(); _emitChange();
    } else if (action === 'loop-tpl') {
      _syncLoopInputs(); _applyLoopTemplate(node.getAttribute('data-ltpl')); _renderBody(); _emitChange();
    }
  });

  _modalEl.addEventListener('contextmenu', (e) => {
    const chip = e.target.closest('.wf-member-chip[data-step][data-member]');
    if (!chip) return;
    e.preventDefault();
    _openPrompt(parseInt(chip.getAttribute('data-step'), 10), chip.getAttribute('data-member'));
  });

  _modalEl.addEventListener('input', (e) => {
    const textarea = e.target.closest && e.target.closest('textarea[data-wf="prompt-input"]');
    if (textarea) {
      _setStepPrompt(parseInt(textarea.getAttribute('data-step'), 10), textarea.getAttribute('data-member'), textarea.value);
      _emitChange();
      return;
    }
    if (e.target && (e.target.id === 'wf-loop-rounds' || e.target.id === 'wf-loop-green')) {
      _syncLoopInputs(); _emitChange();
    }
  });
}

function openWorkflowConfigModal({ members = [], config = null, onSave = null } = {}) {
  _ensureModal();
  _onSave = onSave;
  _promptEditor = null;
  const cfg = (config && typeof config === 'object') ? config : null;
  _state = {
    enabled: cfg ? !!cfg.enabled : false,
    templateId: (cfg && cfg.templateId) ? cfg.templateId : null,
    steps: (cfg && Array.isArray(cfg.steps) && cfg.steps.length)
      ? cfg.steps.map(step => Array.isArray(step) ? [...step] : [])
      : null,
    stepPrompts: (cfg && Array.isArray(cfg.stepPrompts))
      ? cfg.stepPrompts.map(item => (item && typeof item === 'object') ? { ...item } : {})
      : [],
    loop: (cfg && cfg.loop && typeof cfg.loop === 'object')
      ? { enabled: !!cfg.loop.enabled, maxRounds: cfg.loop.maxRounds || 8, consecutivePass: cfg.loop.consecutivePass || 1, polish: cfg.loop.polish !== false }
      : { enabled: false, maxRounds: 8, consecutivePass: 1, polish: true },
    loopTemplateId: cfg && cfg.loopTemplateId ? cfg.loopTemplateId : null,
    members: (members || []).map(m => ({ memberId: m.memberId, kind: m.kind, title: m.title })),
  };
  if (!_state.steps) _applyTemplate('t1');
  while (_state.stepPrompts.length < _state.steps.length) _state.stepPrompts.push({});
  _renderBody();
  _modalEl.style.display = 'flex';
  const status = _modalEl.querySelector('.wf-autosave-state');
  if (status) status.textContent = '改动自动生效';
  if (_escListener) document.removeEventListener('keydown', _escListener);
  _escListener = (e) => { if (e.key === 'Escape' && _modalEl.style.display !== 'none') closeWorkflowConfigModal(); };
  document.addEventListener('keydown', _escListener);
}

function closeWorkflowConfigModal() {
  if (_modalEl) _modalEl.style.display = 'none';
  _promptEditor = null;
  if (_escListener) { document.removeEventListener('keydown', _escListener); _escListener = null; }
}

window.openWorkflowConfigModal = openWorkflowConfigModal;
window.closeWorkflowConfigModal = closeWorkflowConfigModal;
})();
