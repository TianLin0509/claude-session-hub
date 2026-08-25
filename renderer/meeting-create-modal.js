'use strict';

(function () {
const { ipcRenderer } = require('electron');
const { KIND_LABELS } = require('../core/ai-kinds.js');
const { MODEL_OPTIONS_BY_KIND, DEFAULT_MODEL_BY_KIND } = require('../core/model-options.js');

const MODELS_BY_KIND = Object.fromEntries(
  Object.entries(MODEL_OPTIONS_BY_KIND).map(([kind, opts]) => [kind, opts.map(o => o.id)])
);

const DEFAULT_SLOTS = [
  { kind: 'claude', model: DEFAULT_MODEL_BY_KIND.claude },
  { kind: 'codex', model: DEFAULT_MODEL_BY_KIND.codex },
  { kind: 'deepseek', model: DEFAULT_MODEL_BY_KIND.deepseek },
];
const DEFAULT_GROUP_MEMBERS = DEFAULT_SLOTS.map(x => ({ ...x }));
const SLOT_NAMES = ['一号位', '二号位', '三号位'];
const GROUP_TEMPLATES = [
  {
    id: 'general',
    label: '通用会诊',
    desc: '澄清、方案、风险三路并行',
    scene: 'general',
    placeholder: '例如：帮我拆解这个问题，给出可执行方案',
    slots: [
      { kind: 'claude', model: DEFAULT_MODEL_BY_KIND.claude },
      { kind: 'codex', model: DEFAULT_MODEL_BY_KIND.codex },
      { kind: 'deepseek', model: DEFAULT_MODEL_BY_KIND.deepseek },
    ],
  },
  {
    id: 'review',
    label: '代码/方案评审',
    desc: '实现者、审查者、反例攻击',
    scene: 'dev',
    placeholder: '例如：审查这段实现的风险和遗漏',
    slots: [
      { kind: 'codex', model: DEFAULT_MODEL_BY_KIND.codex },
      { kind: 'claude', model: DEFAULT_MODEL_BY_KIND.claude },
      { kind: 'deepseek', model: DEFAULT_MODEL_BY_KIND.deepseek },
    ],
  },
  {
    id: 'research',
    label: '投研圆桌',
    desc: '基本面、资金面、反方风控',
    scene: 'research',
    placeholder: '例如：分析这只股票后续走势和操作计划',
    slots: [
      { kind: 'deepseek', model: DEFAULT_MODEL_BY_KIND.deepseek },
      { kind: 'claude', model: DEFAULT_MODEL_BY_KIND.claude },
      { kind: 'codex', model: DEFAULT_MODEL_BY_KIND.codex },
    ],
  },
  {
    id: 'decision',
    label: '决策交接',
    desc: '结论、取舍、下一步动作',
    scene: 'general',
    placeholder: '例如：把多方案讨论收敛成决策建议',
    slots: [
      { kind: 'claude', model: DEFAULT_MODEL_BY_KIND.claude },
      { kind: 'deepseek', model: DEFAULT_MODEL_BY_KIND.deepseek },
      { kind: 'codex', model: DEFAULT_MODEL_BY_KIND.codex },
    ],
  },
];

let _modalEl = null;
let _currentMode = 'general';
let _isGroupChat = true;
let _groupSlots = DEFAULT_GROUP_MEMBERS.map(x => ({ ...x }));
let _escListener = null;
let _meetingWorkspace = null;
let _meetingWorkspaceMode = 'scratch';
let _creating = false;

function _paintWorkspace(workspace) {
  if (workspace) _meetingWorkspace = workspace;
  if (!_modalEl) return;
  const path = _modalEl.querySelector('#mcm-workspace-path');
  if (path) {
    path.textContent = _meetingWorkspaceMode === 'existing' && _meetingWorkspace
      ? `${window.WorkspaceController.workspaceTierLabel(_meetingWorkspace.tier)} · ${window.WorkspaceController.compactPath(_meetingWorkspace.path, 58)}`
      : '尚未选择';
    path.title = _meetingWorkspaceMode === 'existing' && _meetingWorkspace ? _meetingWorkspace.path : '';
  }
  const existingRow = _modalEl.querySelector('#mcm-workspace-existing');
  if (existingRow) existingRow.hidden = _meetingWorkspaceMode !== 'existing';
  _modalEl.querySelectorAll('[data-mcm-workspace-mode]').forEach(button => {
    const selected = button.getAttribute('data-mcm-workspace-mode') === _meetingWorkspaceMode;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-checked', selected ? 'true' : 'false');
  });
}

async function _syncWorkspace() {
  if (_meetingWorkspaceMode === 'scratch') {
    _meetingWorkspace = await window.WorkspaceController.createScratch('未命名群聊');
  } else if (!_meetingWorkspace || !_meetingWorkspace.path) {
    _meetingWorkspace = await window.WorkspaceController.pickWorkspace();
  }
  if (!_meetingWorkspace || !_meetingWorkspace.path) throw new Error('请选择群聊 workspace');
  _paintWorkspace(_meetingWorkspace);
  return _meetingWorkspace;
}

async function _chooseMeetingExistingWorkspace() {
  const workspace = await window.WorkspaceController.pickWorkspace();
  if (workspace && workspace.path) {
    _meetingWorkspaceMode = 'existing';
    _meetingWorkspace = workspace;
    _paintWorkspace(workspace);
  }
  return workspace;
}

function _escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _aiLogo(kind) {
  // *-resume 复用基础 kind 的 svg（assets 里没有 *-resume.svg）
  return `assets/ai-logos/${String(kind).replace(/-resume$/, '')}.svg`;
}

function _modelOptions(kind, selected) {
  const opts = MODEL_OPTIONS_BY_KIND[kind] || [];
  return opts.map((option, i) =>
    `<option value="${_escapeHtml(option.id)}"${option.id === selected || (!selected && i === 0) ? ' selected' : ''}>${_escapeHtml(option.label || option.id)}</option>`
  ).join('');
}

function _selectOptions(entries, selected) {
  return (entries || []).map(([value, label]) =>
    `<option value="${_escapeHtml(value)}"${value === selected ? ' selected' : ''}>${_escapeHtml(label)}</option>`
  ).join('');
}

function _normalizeSlotSpec(spec = {}) {
  const kind = MODELS_BY_KIND[spec.kind] ? spec.kind : 'claude';
  const tuning = window.WorkspaceController.resolveSessionTuning(kind, spec.model, spec);
  return {
    kind,
    model: tuning.model,
    effort: tuning.effort,
    mcpProfile: tuning.mcpProfile,
    fastMode: tuning.fastMode,
    codexSpeedTier: tuning.codexSpeedTier,
    contextMax: tuning.contextMax,
  };
}

function _cloneSlots(slots) {
  return (slots || DEFAULT_GROUP_MEMBERS).map(x => _normalizeSlotSpec(x));
}

function _renderTemplateButtons(activeId = 'general') {
  return GROUP_TEMPLATES.map(tpl => `
    <button type="button" class="mcm-template${tpl.id === activeId ? ' selected' : ''}" data-mcm-template="${_escapeHtml(tpl.id)}">
      <span class="mcm-template-title">${_escapeHtml(tpl.label)}</span>
      <span class="mcm-template-desc">${_escapeHtml(tpl.desc)}</span>
    </button>
  `).join('');
}

function _applyTemplate(templateId, opts = {}) {
  const tpl = GROUP_TEMPLATES.find(t => t.id === templateId) || GROUP_TEMPLATES[0];
  _currentMode = tpl.scene || 'general';
  _groupSlots = _cloneSlots(tpl.slots);
  _renderSlots();
  const titleInput = _modalEl && _modalEl.querySelector('#mcm-title-input');
  if (titleInput) {
    if (opts.clearTitle) titleInput.value = '';
    titleInput.placeholder = tpl.placeholder || '留空则自动编号：AI 群聊 #N';
  }
  const sceneRadio = _modalEl && _modalEl.querySelector(`input[name="mcm-scene"][value="${_currentMode}"]`);
  if (sceneRadio) sceneRadio.checked = true;
  if (_modalEl) {
    _modalEl.querySelectorAll('[data-mcm-template]').forEach(btn => {
      btn.classList.toggle('selected', btn.getAttribute('data-mcm-template') === tpl.id);
    });
  }
}

function _slotHtml(i, spec, isGroup) {
  const def = _normalizeSlotSpec(spec || DEFAULT_SLOTS[i] || DEFAULT_SLOTS[0]);
  const tuning = window.WorkspaceController.resolveSessionTuning(def.kind, def.model, def);
  const aiOptions = Object.keys(MODELS_BY_KIND).map(k =>
    `<option value="${_escapeHtml(k)}"${k === def.kind ? ' selected' : ''}>${_escapeHtml(KIND_LABELS[k] || k)}</option>`
  ).join('');
  const avatarSrc = _aiLogo(def.kind);
  const avatarAlt = KIND_LABELS[def.kind] || def.kind;
  const label = isGroup ? `成员 ${i + 1}` : `Slot ${i + 1} · ${SLOT_NAMES[i]}`;
  const removeBtn = isGroup && i >= 1
    ? `<button type="button" class="mcm-remove-member" data-remove-member="${i}" title="移除此成员">×</button>`
    : '';
  const effortField = tuning.showEffort ? `
      <label class="mcm-tuning-field">思考强度
        <select class="mcm-effort-select">${_selectOptions(tuning.effortOptions, tuning.effort)}</select>
      </label>` : '';
  const mcpField = tuning.showMcp ? `
      <label class="mcm-tuning-field">MCP 加载
        <select class="mcm-mcp-select">${_selectOptions(tuning.mcpOptions, tuning.mcpProfile)}</select>
      </label>` : '';
  const fastField = tuning.showFast ? `
      <label class="mcm-tuning-field mcm-fast-field">
        <span>快速模式</span>
        <span class="mcm-check"><input class="mcm-fast-checkbox" type="checkbox"${tuning.fastMode ? ' checked' : ''}> 启用 Claude Fast</span>
      </label>` : '';
  const codexTierField = tuning.showCodexTier ? `
      <label class="mcm-tuning-field">速度通道
        <select class="mcm-codex-tier-select">${_selectOptions(tuning.codexTierOptions, tuning.codexSpeedTier)}</select>
      </label>` : '';
  return `
    <div class="mcm-slot${isGroup ? ' mcm-group-member' : ''}" data-slot="${i}" data-kind="${_escapeHtml(def.kind)}">
      ${removeBtn}
      <div class="mcm-slot-head">
        <img class="mcm-avatar" src="${_escapeHtml(avatarSrc)}" alt="${_escapeHtml(avatarAlt)}">
        <div><div class="mcm-slot-label">${_escapeHtml(label)}</div><strong>${_escapeHtml(avatarAlt)}</strong></div>
      </div>
      <div class="mcm-slot-fields">
        <label>AI <select class="mcm-ai-select">${aiOptions}</select></label>
        <label>模型 <select class="mcm-model-select">${_modelOptions(def.kind, def.model)}</select></label>
        ${effortField}
        ${mcpField}
        ${fastField}
        ${codexTierField}
      </div>
    </div>
  `;
}

function _readSlotSpec(el, i, { strict = true } = {}) {
  const aiSelect = el && el.querySelector('.mcm-ai-select');
  const modelSelect = el && el.querySelector('.mcm-model-select');
  if (!aiSelect || !aiSelect.value) {
    if (strict) throw new Error(`成员 ${i + 1} 未选择 AI`);
    return _groupSlots[i] ? _normalizeSlotSpec(_groupSlots[i]) : null;
  }
  const spec = {
    kind: aiSelect.value,
    model: modelSelect ? modelSelect.value : '',
  };
  const effort = el.querySelector('.mcm-effort-select');
  const mcp = el.querySelector('.mcm-mcp-select');
  const fast = el.querySelector('.mcm-fast-checkbox');
  const codexTier = el.querySelector('.mcm-codex-tier-select');
  if (effort) spec.effort = effort.value;
  if (mcp) spec.mcpProfile = mcp.value;
  if (fast) spec.fastMode = !!fast.checked;
  if (codexTier) spec.codexSpeedTier = codexTier.value;
  return _normalizeSlotSpec(spec);
}

function _syncGroupSlotsFromDom({ strict = false } = {}) {
  if (!_modalEl || !_isGroupChat) return;
  _groupSlots = Array.from(_modalEl.querySelectorAll('.mcm-slot'))
    .map((el, i) => _readSlotSpec(el, i, { strict }))
    .filter(Boolean);
}

function _renderSlots() {
  if (!_modalEl) return;
  const wrap = _modalEl.querySelector('.mcm-slots');
  if (!wrap) return;
  const specs = _isGroupChat ? _groupSlots : DEFAULT_SLOTS;
  wrap.innerHTML = specs.map((spec, i) => _slotHtml(i, spec, _isGroupChat)).join('');
  wrap.querySelectorAll('.mcm-slot').forEach(slotEl => {
    slotEl.querySelector('.mcm-ai-select').addEventListener('change', () => {
      const i = Number(slotEl.getAttribute('data-slot'));
      const kind = slotEl.querySelector('.mcm-ai-select').value;
      _groupSlots[i] = _normalizeSlotSpec({ kind, model: DEFAULT_MODEL_BY_KIND[kind] });
      _renderSlots();
    });
    slotEl.querySelector('.mcm-model-select').addEventListener('change', () => {
      _syncGroupSlotsFromDom();
      // Codex 的 effort / Fast 选项跟模型目录走，切模型后要重新生成这一张卡。
      _renderSlots();
    });
    slotEl.querySelectorAll('.mcm-effort-select, .mcm-mcp-select, .mcm-fast-checkbox, .mcm-codex-tier-select')
      .forEach(control => control.addEventListener('change', () => _syncGroupSlotsFromDom()));
  });
  wrap.querySelectorAll('[data-remove-member]').forEach(btn => {
    btn.addEventListener('click', () => {
      _syncGroupSlotsFromDom();
      const idx = parseInt(btn.getAttribute('data-remove-member'), 10);
      if (Number.isInteger(idx) && idx >= 0 && idx < _groupSlots.length) {
        _groupSlots.splice(idx, 1);
        _renderSlots();
      }
    });
  });
}

function _ensureModal() {
  if (_modalEl && document.body.contains(_modalEl)) return _modalEl;
  _modalEl = document.createElement('div');
  _modalEl.id = 'meeting-create-modal';
  _modalEl.className = 'mcm-overlay';
  _modalEl.style.display = 'none';
  _modalEl.innerHTML = `
    <div class="mcm-dialog" role="dialog" aria-labelledby="mcm-title-text">
      <div class="mcm-header">
        <span class="mcm-title" id="mcm-title-text">新建<span id="mcm-mode-label">AI 群聊</span></span>
        <button class="mcm-close" aria-label="关闭">×</button>
      </div>
      <div class="mcm-body">
        <div class="mcm-name-row">
          <label class="mcm-name-label" for="mcm-title-input">房名（可选）</label>
          <input id="mcm-title-input" class="mcm-title-input" type="text" maxlength="40"
                 placeholder="留空则自动编号：AI 群聊 #N" autocomplete="off">
        </div>
        <div class="mcm-workspace-block">
          <span class="mcm-workspace-caption">Workspace</span>
          <div class="mcm-workspace-choices" role="radiogroup" aria-label="选择群聊 workspace 方式">
            <button type="button" class="mcm-workspace-choice selected" data-mcm-workspace-mode="scratch" role="radio" aria-checked="true"><strong>完全新开</strong><small>创建独立临时目录，首问后自动命名</small></button>
            <button type="button" class="mcm-workspace-choice" data-mcm-workspace-mode="existing" role="radio" aria-checked="false"><strong>选择已有路径</strong><small>可选项目、领域或外部目录；组织根不可用</small></button>
          </div>
          <div class="mcm-workspace-existing" id="mcm-workspace-existing" hidden><code id="mcm-workspace-path">尚未选择</code><button type="button" class="mcm-workspace-button" id="mcm-workspace-button">选择文件夹…</button></div>
        </div>
        <div class="mcm-template-grid" id="mcm-template-grid">
          ${_renderTemplateButtons('general')}
        </div>
        <div class="mcm-member-caption">
          <strong>成员配置</strong>
          <span>每位成员独立选择模型、思考强度、速度与 MCP；Codex 选 None 时不会注入群聊或投研 MCP，1M 为启动请求并受 CLI 模型目录上限约束。</span>
        </div>
        <div class="mcm-slots"></div>
        <button type="button" class="mcm-add-member" id="mcm-add-member">+ 添加成员</button>
        <div class="mcm-scene">
          场景:
          <label><input type="radio" name="mcm-scene" value="general" checked> 通用</label>
          <label><input type="radio" name="mcm-scene" value="research"> 投研</label>
          <label><input type="radio" name="mcm-scene" value="dev"> 开发</label>
        </div>
        <div class="mcm-scene-hint" id="mcm-scene-hint" style="display:none; font-size:12px; color:#888; margin-top:6px; line-height:1.6;"></div>
      </div>
      <div class="mcm-footer">
        <button class="mcm-cancel">取消</button>
        <button type="button" class="mcm-create mcm-primary">创建群聊</button>
      </div>
    </div>
  `;
  document.body.appendChild(_modalEl);
  _bindEvents();
  return _modalEl;
}

function _bindEvents() {
  _modalEl.querySelector('.mcm-close').addEventListener('click', closeMeetingCreateModal);
  _modalEl.querySelector('.mcm-cancel').addEventListener('click', closeMeetingCreateModal);
  _modalEl.querySelector('.mcm-create').addEventListener('click', (event) => {
    event.preventDefault();
    void _onCreate();
  });
  _modalEl.querySelector('#mcm-template-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mcm-template]');
    if (!btn) return;
    _applyTemplate(btn.getAttribute('data-mcm-template'));
  });
  _modalEl.querySelector('#mcm-add-member').addEventListener('click', () => {
    _syncGroupSlotsFromDom();
    _groupSlots.push(_normalizeSlotSpec(DEFAULT_GROUP_MEMBERS[_groupSlots.length % DEFAULT_GROUP_MEMBERS.length]));
    _renderSlots();
  });
  _modalEl.querySelectorAll('[data-mcm-workspace-mode]').forEach(button => {
    button.addEventListener('click', () => {
      _meetingWorkspaceMode = button.getAttribute('data-mcm-workspace-mode') === 'existing' ? 'existing' : 'scratch';
      _paintWorkspace();
      if (_meetingWorkspaceMode === 'existing' && !_meetingWorkspace) {
        void _chooseMeetingExistingWorkspace().catch(err => _showError(`选择目录失败：${err && err.message ? err.message : String(err)}`));
      }
    });
  });
  _modalEl.querySelector('#mcm-workspace-button').addEventListener('click', () => {
    void _chooseMeetingExistingWorkspace().catch(err => _showError(`选择目录失败：${err && err.message ? err.message : String(err)}`));
  });
  _modalEl.querySelectorAll('input[name="mcm-scene"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const hint = _modalEl.querySelector('#mcm-scene-hint');
      if (radio.checked && hint) {
        hint.style.display = 'none';
      }
    });
  });
  _modalEl.addEventListener('click', (e) => {
    if (e.target === _modalEl) closeMeetingCreateModal();
  });
}

async function _onCreate() {
  if (_creating) return;
  const createBtn = _modalEl && _modalEl.querySelector('.mcm-create');
  if (!createBtn) return;
  _creating = true;
  createBtn.disabled = true;
  createBtn.setAttribute('aria-busy', 'true');
  createBtn.textContent = '正在准备 workspace...';
  _clearError();
  try {
    // 即使用户在模型目录异步返回前立刻点创建，也要先用真实目录重新归一化。
    // 否则 gpt-5.5 可能把 fallback 里的 max 带进 CLI（该模型真实只支持到 xhigh）。
    await window.WorkspaceController.loadCodexTuningCatalog();
    _syncGroupSlotsFromDom({ strict: true });
    _renderSlots();
    // 读取 DOM 也必须在 try 内。历史状态或第三方样式脚本一旦留下残缺 slot / 未选
    // scene，旧代码会在 invoke 之前同步 throw，界面上就像按钮完全没反应。
    const slots = Array.from(_modalEl.querySelectorAll('.mcm-slot')).map((el, i) => {
      const spec = _readSlotSpec(el, i, { strict: true });
      return {
        index: i,
        kind: spec.kind,
        ...window.WorkspaceController.buildSessionTuningOpts(spec.kind, spec.model, spec),
      };
    });
    if (!slots.length) throw new Error('请至少保留一个群聊成员');
    const sceneInput = _modalEl.querySelector('input[name="mcm-scene"]:checked');
    const scene = sceneInput ? sceneInput.value : 'general';
    // createMeeting 的 scene 实际取自 mode（过 MEETING_MODES 白名单），scene 字段只是透传
    const mode = (scene === 'research' || scene === 'dev') ? scene : 'general';
    const titleInput = _modalEl.querySelector('#mcm-title-input');
    const title = titleInput ? titleInput.value.trim() : '';

    const workspace = await _syncWorkspace();
    createBtn.textContent = '正在创建成员会话...';
    const meeting = await ipcRenderer.invoke('create-meeting', {
      mode,
      scene,
      slots,
      title,
      groupChat: _isGroupChat,
      groupMode: _isGroupChat ? 'deliberation' : null,
      groupRecentRawN: 5,
      participants: _isGroupChat ? slots.map((_, i) => i) : null,
      workspace: workspace.path,
      workspaceLabel: workspace.label,
      workspaceDraft: !!workspace.draft,
    });
    if (!meeting || !meeting.id) throw new Error('create-meeting returned empty meeting');
    closeMeetingCreateModal();
    if (typeof selectMeeting === 'function') selectMeeting(meeting.id);
    else if (typeof window.selectMeeting === 'function') window.selectMeeting(meeting.id);
  } catch (e) {
    console.error('[meeting-create-modal] create failed:', e);
    _showError((e && e.message) ? e.message : String(e));
    _creating = false;
    createBtn.disabled = false;
    createBtn.removeAttribute('aria-busy');
    createBtn.textContent = '创建群聊';
  }
}

function _showError(text) {
  let bar = _modalEl.querySelector('.mcm-error');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'mcm-error';
    const footer = _modalEl.querySelector('.mcm-footer');
    if (footer) footer.before(bar);
  }
  bar.textContent = `创建失败：${text}`;
}

function _clearError() {
  const bar = _modalEl && _modalEl.querySelector('.mcm-error');
  if (bar) bar.remove();
}

function openMeetingCreateModal(mode = 'general', options = {}) {
  if (mode === 'group') {
    _isGroupChat = true;
  } else {
    _isGroupChat = true;
  }
  const requestedTemplate = GROUP_TEMPLATES.some(template => template.id === options.templateId)
    ? options.templateId
    : 'general';
  _currentMode = 'general';
  _ensureModal();
  _clearError();
  _applyTemplate(requestedTemplate, { clearTitle: true });
  _meetingWorkspaceMode = 'scratch';
  _meetingWorkspace = null;
  _paintWorkspace();

  const modeLabel = _modalEl.querySelector('#mcm-mode-label');
  modeLabel.textContent = 'AI 群聊';

  const titleInput = _modalEl.querySelector('#mcm-title-input');
  if (titleInput) titleInput.value = '';
  const addBtn = _modalEl.querySelector('#mcm-add-member');
  if (addBtn) addBtn.style.display = 'inline-flex';
  const createBtn = _modalEl.querySelector('.mcm-create');
  _creating = false;
  createBtn.disabled = false;
  createBtn.removeAttribute('aria-busy');
  createBtn.textContent = '创建群聊';
  _modalEl.style.display = 'flex';
  // 单会话与群聊共用 codex-cli 的模型目录。目录异步返回后保留用户已选值重绘，
  // 让 gpt-5.6 的 ultra / Fast 与旧模型的较短枚举始终准确。
  void window.WorkspaceController.loadCodexTuningCatalog().then(() => {
    if (!_modalEl || _modalEl.style.display === 'none') return;
    _syncGroupSlotsFromDom();
    _renderSlots();
  });
  if (_escListener) document.removeEventListener('keydown', _escListener);
  _escListener = (e) => {
    if (e.key === 'Escape' && _modalEl.style.display !== 'none') closeMeetingCreateModal();
  };
  document.addEventListener('keydown', _escListener);
}

function closeMeetingCreateModal() {
  if (_modalEl) _modalEl.style.display = 'none';
  if (_escListener) {
    document.removeEventListener('keydown', _escListener);
    _escListener = null;
  }
}

window.openMeetingCreateModal = openMeetingCreateModal;
window.closeMeetingCreateModal = closeMeetingCreateModal;
})();
