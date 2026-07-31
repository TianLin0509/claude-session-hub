'use strict';

// Editable serial-workflow configuration. Templates are optional prefills only.
// Persisted shape (v2):
// { schemaVersion:2, enabled, templateId, steps:[[memberId...]], stepConfigs:[{name,prompt}], loop:{...} }
(function () {

const BASIC_TEMPLATES = [
  { id: 't1', name: '逐个接力', desc: '每个 AI 各占一步，按成员顺序串行执行' },
  { id: 't2', name: '并行 → 汇总', desc: '第一步全员并行，第二步由一人收口' },
  { id: 't3', name: '保持当前 · 自定义', desc: '不套模板，继续自由调整步骤、成员和 prompt' },
];
const MAX_STEPS = 8;

let _modalEl = null;
let _state = null;
let _onSave = null;
let _escListener = null;

function _api() { return window.WorkflowTemplates || null; }
function _escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// *-resume 复用基础 kind 的 svg（assets 里没有 *-resume.svg）
function _aiLogo(kind) { return `assets/ai-logos/${_escapeHtml(String(kind || 'claude').replace(/-resume$/, ''))}.svg`; }
function _memberTitle(memberId) {
  const m = (_state.members || []).find(x => x.memberId === memberId);
  return m ? (m.title || m.memberId) : memberId;
}
function _normalizeStepConfigs() {
  const api = _api();
  if (api && typeof api.normalizeStepConfigs === 'function') {
    _state.stepConfigs = api.normalizeStepConfigs(_state.steps || [], _state.stepConfigs || []);
  } else {
    _state.stepConfigs = (_state.steps || []).map((_s, i) => {
      const old = (_state.stepConfigs || [])[i] || {};
      return { name: String(old.name || ''), prompt: String(old.prompt || '') };
    });
  }
}
function _markCustom(updateCards) {
  _state.templateId = null;
  if (updateCards && _modalEl) {
    _modalEl.querySelectorAll('.wf-tpl-card.selected').forEach(el => el.classList.remove('selected'));
  }
}

function _applyBasicTemplate(tplId) {
  const members = _state.members || [];
  if (tplId === 't1') {
    _state.steps = members.map(m => [m.memberId]);
    if (_state.steps.length === 0) _state.steps = [[]];
    _state.stepConfigs = _state.steps.map((_s, i) => ({ name: `接力 ${i + 1}`, prompt: '' }));
    _state.loop = { enabled: false, policyVersion: 2, maxRounds: 3, consecutivePass: 1, polish: false };
  } else if (tplId === 't2') {
    if (members.length === 0) {
      _state.steps = [[]];
      _state.stepConfigs = [{ name: '并行回答', prompt: '' }];
    } else {
      const all = members.map(m => m.memberId);
      _state.steps = members.length === 1 ? [all] : [all, [members[0].memberId]];
      _state.stepConfigs = members.length === 1
        ? [{ name: '回答', prompt: '' }]
        : [
            { name: '并行回答', prompt: '独立分析总目标，给出结论、依据和风险；不要迎合其他 AI。' },
            { name: '汇总收口', prompt: '综合前序意见，明确共识、分歧和取舍，输出唯一结论与下一步。' },
          ];
    }
    _state.loop = { enabled: false, policyVersion: 2, maxRounds: 3, consecutivePass: 1, polish: false };
  } else {
    if (!_state.steps || !_state.steps.length) _state.steps = [[]];
    _normalizeStepConfigs();
    _state.loop.enabled = false;
  }
  _state.enabled = true;
  _state.templateId = tplId;
}

function _applySemanticTemplate(templateId) {
  const api = _api();
  const built = api && typeof api.createTemplateConfig === 'function'
    ? api.createTemplateConfig(templateId, _state.members || [])
    : null;
  if (!built) {
    const tpl = api && typeof api.getTemplateMeta === 'function'
      ? api.getTemplateMeta(templateId)
      : (api && Array.isArray(api.TEMPLATES) ? api.TEMPLATES.find(t => t.id === templateId) : null);
    alert(`模板至少需要 ${(tpl && tpl.minMembers) || 2} 个 AI 成员`);
    return false;
  }
  _state.enabled = true;
  _state.templateId = templateId;
  _state.steps = built.steps.map(s => [...s]);
  _state.stepConfigs = built.stepConfigs.map(s => ({ name: s.name || '', prompt: s.prompt || '' }));
  _state.loop = Object.assign({ enabled: false, policyVersion: 2, maxRounds: 3, consecutivePass: 1, polish: false }, built.loop || {});
  return true;
}

function _setStepCount(n) {
  _syncStepInputs();
  const steps = _state.steps || [];
  n = Math.max(1, Math.min(MAX_STEPS, n));
  while (steps.length < n) steps.push([]);
  while (steps.length > n) steps.pop();
  _state.steps = steps;
  _normalizeStepConfigs();
  _markCustom(false);
}

function _toggleMember(stepIdx, memberId) {
  const step = _state.steps[stepIdx];
  if (!step) return;
  const i = step.indexOf(memberId);
  if (i >= 0) step.splice(i, 1); else step.push(memberId);
  _markCustom(false);
}

function _syncLoopInputs() {
  if (!_state.loop) _state.loop = { enabled: false, policyVersion: 2, maxRounds: 3, consecutivePass: 1, polish: false };
  const rounds = _modalEl && _modalEl.querySelector('#wf-loop-rounds');
  if (rounds && rounds.value) _state.loop.maxRounds = Math.max(1, Math.min(10, parseInt(rounds.value, 10) || 3));
  _state.loop.policyVersion = 2;
  _state.loop.consecutivePass = 1;
  _state.loop.polish = false;
}

function _syncStepInputs() {
  if (!_modalEl || !_state) return;
  _normalizeStepConfigs();
  _modalEl.querySelectorAll('[data-wf-step-name]').forEach(input => {
    const i = parseInt(input.getAttribute('data-wf-step-name'), 10);
    if (_state.stepConfigs[i]) _state.stepConfigs[i].name = input.value;
  });
  _modalEl.querySelectorAll('[data-wf-step-prompt]').forEach(input => {
    const i = parseInt(input.getAttribute('data-wf-step-prompt'), 10);
    if (_state.stepConfigs[i]) _state.stepConfigs[i].prompt = input.value;
  });
}

function _previewHtml() {
  const steps = _state.steps || [];
  if (!steps.length) return '<span class="wf-empty">还没有步骤</span>';
  return steps.map((step, i) => {
    const name = ((_state.stepConfigs || [])[i] || {}).name;
    const label = name ? `<b>${_escapeHtml(name)}</b> · ` : '';
    if (!step.length) return `<span class="wf-empty">${label}(未选 AI)</span>`;
    return label + step.map(mid => _escapeHtml(_memberTitle(mid))).join('<span class="wf-plus">+</span>');
  }).join('<span class="wf-arrow">→</span>');
}

function _semanticTemplatesHtml() {
  const api = _api();
  if (!api || !Array.isArray(api.TEMPLATES)) return '';
  return api.TEMPLATES.map(t => {
    const disabled = (_state.members || []).length < (t.minMembers || 1);
    return `<button type="button" class="wf-tpl-card wf-semantic-card${_state.templateId === t.id ? ' selected' : ''}${disabled ? ' disabled' : ''}" data-wf="semantic-tpl" data-stpl="${_escapeHtml(t.id)}" ${disabled ? 'disabled' : ''}>
      <div class="wf-tpl-name">${t.recommended ? '<span class="wf-recommended">推荐</span>' : ''}${_escapeHtml(t.name)}</div>
      <div class="wf-tpl-desc">${_escapeHtml(t.desc)}${disabled ? ` · 至少 ${t.minMembers} 个 AI` : ''}</div>
    </button>`;
  }).join('');
}

function _taskPresetsHtml() {
  const api = _api();
  if (!api || !Array.isArray(api.TASK_PRESETS)) return '';
  return api.TASK_PRESETS.map(t => {
    const disabled = (_state.members || []).length < (t.minMembers || 1);
    return `<button type="button" class="wf-preset-btn${_state.templateId === t.id ? ' selected' : ''}${disabled ? ' disabled' : ''}" data-wf="task-preset" data-task-preset="${_escapeHtml(t.id)}" title="${_escapeHtml(t.desc)}" ${disabled ? 'disabled' : ''}>
      ${_escapeHtml(t.name)}${t.recommended ? '<span>推荐</span>' : ''}
    </button>`;
  }).join('');
}

function _bodyHtml() {
  _normalizeStepConfigs();
  const s = _state;
  const basicCards = BASIC_TEMPLATES.map(t =>
    `<button type="button" class="wf-tpl-card${s.templateId === t.id ? ' selected' : ''}" data-wf="tpl" data-tpl="${t.id}">
       <div class="wf-tpl-name">${_escapeHtml(t.name)}</div>
       <div class="wf-tpl-desc">${_escapeHtml(t.desc)}</div>
     </button>`).join('');
  const loopOn = !!(s.loop && s.loop.enabled);
  const stepRows = (s.steps || []).map((step, idx) => {
    const chips = (s.members || []).map(m => {
      const sel = step.includes(m.memberId);
      return `<button type="button" class="wf-member-chip${sel ? ' selected' : ''}" data-wf="chip" data-step="${idx}" data-member="${_escapeHtml(m.memberId)}">
                <img src="${_aiLogo(m.kind)}" alt="">${_escapeHtml(m.title || m.memberId)}
              </button>`;
    }).join('');
    const roleTag = loopOn
      ? `<span class="wf-role-tag ${idx === 0 ? 'builder' : 'reviewer'}">${idx === 0 ? '执行' : '评审'}</span>`
      : '<span class="wf-role-tag serial">串行</span>';
    const cfg = (s.stepConfigs || [])[idx] || {};
    return `<div class="wf-step-row">
              <span class="wf-step-index">${idx + 1}</span>
              <div class="wf-step-main">
                <div class="wf-step-members">${roleTag}<div class="wf-member-chips">${chips || '<span class="wf-empty">群里暂无可选 AI</span>'}</div></div>
                <div class="wf-step-fields">
                  <input type="text" maxlength="40" class="wf-step-name" data-wf-step-name="${idx}" value="${_escapeHtml(cfg.name || '')}" placeholder="步骤名称（可选）">
                  <textarea rows="2" maxlength="1200" class="wf-step-prompt" data-wf-step-prompt="${idx}" placeholder="本步骤职责 / prompt（留空则沿用原问题）">${_escapeHtml(cfg.prompt || '')}</textarea>
                </div>
              </div>
            </div>`;
  }).join('');
  const stepCount = (s.steps || []).length;
  const loopShapeOk = stepCount === 2 && (s.steps[0] || []).length === 1 && (s.steps[1] || []).length >= 1;

  return `
    <div class="wf-toggle-row">
      <div class="wf-toggle-text">
        <div class="wf-toggle-title">启用串行工作流</div>
        <div class="wf-toggle-sub">步骤之间依次执行；同一步选多个 AI 时并行。模板只是可选起点，所有内容始终可编辑。</div>
      </div>
      <button type="button" class="wf-switch${s.enabled ? ' on' : ''}" data-wf="toggle" aria-label="启用开关"></button>
    </div>
    <div class="wf-config-area${s.enabled ? '' : ' disabled'}">
      <div class="wf-section-label">任务预设</div>
      <div class="wf-template-help">选择常用任务后，Hub 会自动填充成员顺序、步骤职责和验收方式。只影响当前群聊，保存前仍可逐项修改。</div>
      <div class="wf-preset-buttons">${_taskPresetsHtml()}</div>
      <div class="wf-section-label">高级流程模板（可选）</div>
      <div class="wf-template-help">点击后只会填充下方步骤。你仍可修改 AI、步骤数、名称和 prompt；手动修改后自动转为“自定义”。</div>
      <div class="wf-templates wf-semantic-templates">${_semanticTemplatesHtml()}</div>
      <div class="wf-section-label">基础结构 / 自定义</div>
      <div class="wf-templates wf-basic-templates">${basicCards}</div>
      <div class="wf-section-head">
        <div class="wf-section-label">自定义步骤</div>
        <div class="wf-stepcount">
          <button type="button" class="wf-stepper-btn" data-wf="step-dec"${stepCount <= 1 ? ' disabled' : ''}>−</button>
          <span class="wf-stepcount-val">${stepCount}</span>
          <button type="button" class="wf-stepper-btn" data-wf="step-inc"${stepCount >= MAX_STEPS ? ' disabled' : ''}>＋</button>
        </div>
      </div>
      <div class="wf-steps">${stepRows}</div>
      <div class="wf-preview"><span class="wf-preview-label">流程预览</span>${_previewHtml()}</div>
      <div class="wf-loop-card${loopOn ? ' active' : ''}">
        <div class="wf-loop-head">
          <label><input type="checkbox" data-wf="loop-toggle" ${loopOn ? 'checked' : ''}> <b>评审闭环</b></label>
          <span>最多 <input id="wf-loop-rounds" type="number" min="1" max="10" value="${(s.loop && s.loop.maxRounds) || 3}"> 次</span>
        </div>
        <div class="wf-loop-help">仅在 FAIL 时回修：第 1 步必须是 1 个执行 AI，第 2 步是 1–2 个并行评审 AI；PASS 立即结束，不再自动生成“打磨建议池”。</div>
        ${loopOn && !loopShapeOk ? '<div class="wf-validation">启用闭环时请保留 2 步：第 1 步选 1 个执行 AI，第 2 步至少选 1 个评审 AI。</div>' : ''}
      </div>
    </div>`;
}

function _ensureModal() {
  if (_modalEl && document.body.contains(_modalEl)) return _modalEl;
  _modalEl = document.createElement('div');
  _modalEl.id = 'workflow-config-modal';
  _modalEl.className = 'mcm-overlay';
  _modalEl.style.display = 'none';
  _modalEl.innerHTML = `
    <div class="mcm-dialog wf-dialog" role="dialog" aria-labelledby="wf-title-text">
      <div class="mcm-header">
        <span class="mcm-title" id="wf-title-text">串行工作流</span>
        <button class="mcm-close" aria-label="关闭">×</button>
      </div>
      <div class="mcm-body" id="wf-body"></div>
      <div class="mcm-footer">
        <button class="mcm-cancel">取消</button>
        <button class="mcm-primary wf-save">保存</button>
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

function _bindEvents() {
  _modalEl.addEventListener('click', (e) => {
    if (e.target === _modalEl) { closeWorkflowConfigModal(); return; }
    if (e.target.closest('.mcm-close') || e.target.closest('.mcm-cancel')) { closeWorkflowConfigModal(); return; }
    if (e.target.closest('.wf-save')) { _save(); return; }
    const node = e.target.closest('[data-wf]');
    if (!node || node.disabled) return;
    const action = node.getAttribute('data-wf');
    if (action === 'toggle') { _syncStepInputs(); _state.enabled = !_state.enabled; _renderBody(); }
    else if (action === 'tpl') { _syncStepInputs(); _applyBasicTemplate(node.getAttribute('data-tpl')); _renderBody(); }
    else if (action === 'task-preset') { _syncStepInputs(); if (_applySemanticTemplate(node.getAttribute('data-task-preset'))) _renderBody(); }
    else if (action === 'semantic-tpl') { _syncStepInputs(); if (_applySemanticTemplate(node.getAttribute('data-stpl'))) _renderBody(); }
    else if (action === 'step-inc') { _setStepCount((_state.steps || []).length + 1); _renderBody(); }
    else if (action === 'step-dec') { _setStepCount((_state.steps || []).length - 1); _renderBody(); }
    else if (action === 'chip') {
      _syncStepInputs();
      _toggleMember(parseInt(node.getAttribute('data-step'), 10), node.getAttribute('data-member'));
      _renderBody();
    }
    else if (action === 'loop-toggle') {
      _syncStepInputs(); _syncLoopInputs();
      _state.loop.enabled = !_state.loop.enabled;
      _markCustom(false);
      _renderBody();
    }
  });
  _modalEl.addEventListener('input', (e) => {
    if (e.target.matches('[data-wf-step-name], [data-wf-step-prompt]')) {
      _syncStepInputs();
      _markCustom(true);
    } else if (e.target.matches('#wf-loop-rounds')) {
      _syncLoopInputs();
      _markCustom(true);
    }
  });
}

function _save() {
  _syncStepInputs();
  _syncLoopInputs();
  const pairs = (_state.steps || []).map((step, i) => ({
    step: Array.isArray(step) ? [...step] : [],
    cfg: Object.assign({ name: '', prompt: '' }, (_state.stepConfigs || [])[i] || {}),
  })).filter(pair => pair.step.length > 0);
  const steps = pairs.map(pair => pair.step);
  const stepConfigs = pairs.map(pair => ({ name: String(pair.cfg.name || ''), prompt: String(pair.cfg.prompt || '') }));
  const loopOn = !!(_state.loop && _state.loop.enabled);
  if (loopOn && !(steps.length === 2 && steps[0].length === 1 && steps[1].length >= 1)) {
    alert('评审闭环需要恰好 2 步：第 1 步选择 1 个执行 AI，第 2 步选择至少 1 个评审 AI。');
    return;
  }
  const config = {
    schemaVersion: 2,
    enabled: (!!_state.enabled || loopOn) && steps.length > 0,
    templateId: _state.templateId || null,
    steps,
    stepConfigs,
    loop: {
      enabled: loopOn,
      policyVersion: 2,
      maxRounds: (_state.loop && _state.loop.maxRounds) || 3,
      consecutivePass: 1,
      polish: false,
    },
  };
  if (typeof _onSave === 'function') _onSave(config);
  closeWorkflowConfigModal();
}

function _migrateLegacyLoopState(state) {
  if (!state.loop || !state.loop.enabled || !Array.isArray(state.steps) || state.steps.length <= 2) return;
  const reviewers = Array.from(new Set([].concat(...state.steps.slice(1)).filter(Boolean)));
  state.steps = [(state.steps[0] || []).slice(0, 1), reviewers];
  state.stepConfigs = [
    state.stepConfigs[0] || { name: '实现或修复', prompt: '' },
    state.stepConfigs[1] || { name: '并行验收', prompt: '' },
  ];
  state.templateId = null;
}

function openWorkflowConfigModal({ members = [], config = null, onSave = null } = {}) {
  _ensureModal();
  _onSave = onSave;
  const cfg = (config && typeof config === 'object') ? config : null;
  _state = {
    enabled: cfg ? !!cfg.enabled : false,
    templateId: (cfg && cfg.templateId) ? cfg.templateId : null,
    steps: (cfg && Array.isArray(cfg.steps) && cfg.steps.length)
      ? cfg.steps.map(step => Array.isArray(step) ? [...step] : [])
      : null,
    stepConfigs: (cfg && Array.isArray(cfg.stepConfigs))
      ? cfg.stepConfigs.map(item => ({ name: String(item && item.name || ''), prompt: String(item && item.prompt || '') }))
      : [],
    loop: (cfg && cfg.loop && typeof cfg.loop === 'object')
      ? { enabled: !!cfg.loop.enabled, policyVersion: 2, maxRounds: Math.min(10, cfg.loop.maxRounds || 3), consecutivePass: 1, polish: false }
      : { enabled: false, policyVersion: 2, maxRounds: 3, consecutivePass: 1, polish: false },
    members: (members || []).map(m => ({ memberId: m.memberId, kind: m.kind, title: m.title })),
  };
  if (!_state.steps) {
    const initialEnabled = _state.enabled;
    _applyBasicTemplate('t1');
    _state.enabled = initialEnabled;
  }
  _normalizeStepConfigs();
  _migrateLegacyLoopState(_state);
  _renderBody();
  _modalEl.style.display = 'flex';
  if (_escListener) document.removeEventListener('keydown', _escListener);
  _escListener = (e) => { if (e.key === 'Escape' && _modalEl.style.display !== 'none') closeWorkflowConfigModal(); };
  document.addEventListener('keydown', _escListener);
}

function closeWorkflowConfigModal() {
  if (_modalEl) _modalEl.style.display = 'none';
  if (_escListener) { document.removeEventListener('keydown', _escListener); _escListener = null; }
}

window.openWorkflowConfigModal = openWorkflowConfigModal;
window.closeWorkflowConfigModal = closeWorkflowConfigModal;
})();
