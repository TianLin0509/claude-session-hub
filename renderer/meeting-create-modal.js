'use strict';

(function () {
const { ipcRenderer } = require('electron');
const { checkDevWorkspace } = require('./dev-workspace-guard.js');
const { KIND_LABELS } = require('../core/ai-kinds.js');
const { MODEL_OPTIONS_BY_KIND, DEFAULT_MODEL_BY_KIND, modelOptionsFor } = require('../core/model-options.js');

const MODEL_KINDS = new Set(Object.keys(MODEL_OPTIONS_BY_KIND));

const DEFAULT_SLOTS = [
  { kind: 'claude', model: DEFAULT_MODEL_BY_KIND.claude },
  { kind: 'codex', model: DEFAULT_MODEL_BY_KIND.codex },
  { kind: 'deepseek', model: DEFAULT_MODEL_BY_KIND.deepseek },
];
const GROUP_MEMBER_KINDS = ['claude', 'codex', 'deepseek'];
// Claude + Codex are the durable default pair. DeepSeek is an explicit third
// member rather than a cost/latency-bearing default in every room.
const DEFAULT_GROUP_MEMBERS = DEFAULT_SLOTS.slice(0, 2).map(x => ({ ...x }));
const SLOT_NAMES = ['一号位', '二号位', '三号位'];
// 场景是这一页唯一的任务分类维度。
// 2026-09-05：原来在成员配置上方还有一排四张任务模板卡，每张卡实际只做两件事 ——
// 选一个场景 + 换一句房名 placeholder，和这里的三个场景完全重叠。两处并存必然出现
// 「模板卡选了投研，底下场景还停在通用」这种自相矛盾状态，故删卡、只留场景。
const SCENES = [
  { id: 'general',  label: '通用', placeholder: '例如：帮我拆解这个问题，给出可执行方案' },
  { id: 'research', label: '投研', placeholder: '例如：分析这只股票后续走势和操作计划' },
  { id: 'dev',      label: '开发', placeholder: '例如：实现这个需求，并让另一位独立审查' },
];

let _modalEl = null;
let _currentMode = 'general';
let _isGroupChat = true;
let _groupSlots = DEFAULT_GROUP_MEMBERS.map(x => ({ ...x }));
let _escListener = null;
let _meetingWorkspace = null;
// 群聊与单会话同一个默认档：工作根（2026-08-31 平铺决策）。
// 群聊尤其需要——180 场会议 100% 共用 cwd，本来就是「多个 AI 同一个目录」的场景。
let _meetingWorkspaceMode = 'default';
let _creating = false;
let _presentation = { embedded: false, onCreated: null };

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
  } else if (_meetingWorkspaceMode === 'default') {
    _meetingWorkspace = await window.WorkspaceController.createDefaultWorkspace('未命名群聊');
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
  const opts = modelOptionsFor(kind);
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
  const kind = MODEL_KINDS.has(spec.kind) ? spec.kind : 'claude';
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

function _renderSceneChoices(activeId = 'general') {
  return SCENES.map(scene => `
    <label class="mcm-scene-choice${scene.id === activeId ? ' selected' : ''}" data-mcm-scene="${_escapeHtml(scene.id)}">
      <input type="radio" name="mcm-scene" value="${_escapeHtml(scene.id)}"${scene.id === activeId ? ' checked' : ''}>
      ${_escapeHtml(scene.label)}
    </label>
  `).join('');
}

// 只改场景，不动成员名单。删掉模板卡之后成员起手一律是「Claude 工作位 + Codex 合并位」，
// 换场景不该把用户已经调好的模型/档位冲掉。
function _applyScene(sceneId, opts = {}) {
  const scene = SCENES.find(s => s.id === sceneId) || SCENES[0];
  _currentMode = scene.id;
  if (opts.resetSlots) {
    _groupSlots = _cloneSlots(DEFAULT_GROUP_MEMBERS);
    _renderSlots();
  }
  const titleInput = _modalEl && _modalEl.querySelector('#mcm-title-input');
  if (titleInput) {
    if (opts.clearTitle) titleInput.value = '';
    titleInput.placeholder = scene.placeholder || '留空则自动编号：AI 群聊 #N';
  }
  if (!_modalEl) return;
  const sceneRadio = _modalEl.querySelector(`input[name="mcm-scene"][value="${_currentMode}"]`);
  if (sceneRadio) sceneRadio.checked = true;
  _modalEl.querySelectorAll('.mcm-scene-choice').forEach(el => {
    const input = el.querySelector('input[name="mcm-scene"]');
    el.classList.toggle('selected', !!input && input.value === _currentMode);
  });
}

function _slotHtml(i, spec, isGroup) {
  const def = _normalizeSlotSpec(spec || DEFAULT_SLOTS[i] || DEFAULT_SLOTS[0]);
  const tuning = window.WorkspaceController.resolveSessionTuning(def.kind, def.model, def);
  const providerKinds = isGroup ? GROUP_MEMBER_KINDS : Array.from(MODEL_KINDS);
  const aiOptions = providerKinds.map(k =>
    `<option value="${_escapeHtml(k)}"${k === def.kind ? ' selected' : ''}>${_escapeHtml(KIND_LABELS[k] || k)}</option>`
  ).join('');
  const avatarSrc = _aiLogo(def.kind);
  const avatarAlt = KIND_LABELS[def.kind] || def.kind;
  const label = isGroup ? `成员 ${i + 1}` : `Slot ${i + 1} · ${SLOT_NAMES[i]}`;
  const removeBtn = isGroup && i >= 1
    ? `<button type="button" class="mcm-remove-member" data-remove-member="${i}" title="移除此成员">×</button>`
    : '';
  const effortField = tuning.showEffort ? `
      <label class="mcm-tuning-field"><span class="mcm-slot-field-name">思考强度</span>
        <select class="mcm-effort-select">${_selectOptions(tuning.effortOptions, tuning.effort)}</select>
      </label>` : '';
  const mcpField = tuning.showMcp ? `
      <label class="mcm-tuning-field"><span class="mcm-slot-field-name">MCP 加载</span>
        <select class="mcm-mcp-select">${_selectOptions(tuning.mcpOptions, tuning.mcpProfile)}</select>
      </label>` : '';
  const fastField = tuning.showFast ? `
      <label class="mcm-tuning-field mcm-fast-field">
        <span class="mcm-slot-field-name">快速模式</span>
        <span class="mcm-check"><input class="mcm-fast-checkbox" type="checkbox"${tuning.fastMode ? ' checked' : ''}> 启用 Claude Fast</span>
      </label>` : '';
  const codexTierField = tuning.showCodexTier ? `
      <label class="mcm-tuning-field"><span class="mcm-slot-field-name">速度通道</span>
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
        <label><span class="mcm-slot-field-name">AI</span><select class="mcm-ai-select">${aiOptions}</select></label>
        <label><span class="mcm-slot-field-name">模型</span><select class="mcm-model-select">${_modelOptions(def.kind, def.model)}</select></label>
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

// 「+ 添加成员」下一个默认落哪种 AI：先补齐还没出场的（Claude+Codex 两人时给 DeepSeek），
//   补齐后按顺序轮换。同一种 AI 允许多开（两个 Claude 跑不同模型/角色是有效用法），
//   成员数也不设上限——实际基本停在 3 人，但那是用户的选择，不该由代码写死。
function _nextGroupMemberKind() {
  const present = new Set(_groupSlots.map(slot => slot.kind));
  return GROUP_MEMBER_KINDS.find(kind => !present.has(kind))
    || GROUP_MEMBER_KINDS[_groupSlots.length % GROUP_MEMBER_KINDS.length];
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
  const addBtn = _modalEl.querySelector('#mcm-add-member');
  if (addBtn && _isGroupChat) {
    const nextKind = _nextGroupMemberKind();
    addBtn.disabled = false;
    addBtn.textContent = `+ 添加 ${KIND_LABELS[nextKind] || nextKind}`;
    addBtn.title = `添加成员 ${KIND_LABELS[nextKind] || nextKind}；同一种 AI 可以多开，人数不设上限`;
  }
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
            <button type="button" class="mcm-workspace-choice selected" data-mcm-workspace-mode="default" role="radio" aria-checked="true"><strong>默认工作目录</strong><small>全员开在工作根，跨会话文件互相可见</small></button>
            <button type="button" class="mcm-workspace-choice" data-mcm-workspace-mode="scratch" role="radio" aria-checked="false"><strong>临时目录</strong><small>随机新建一次性目录，全员共用</small></button>
            <button type="button" class="mcm-workspace-choice" data-mcm-workspace-mode="existing" role="radio" aria-checked="false"><strong>选择已有路径</strong><small>可选项目、领域或外部目录</small></button>
          </div>
          <div class="mcm-workspace-existing" id="mcm-workspace-existing" hidden><code id="mcm-workspace-path">尚未选择</code><button type="button" class="mcm-workspace-button" id="mcm-workspace-button">选择文件夹…</button></div>
        </div>
        <div class="mcm-scene" id="mcm-scene-row">
          <span class="mcm-scene-caption">场景</span>
          ${_renderSceneChoices('general')}
        </div>
        <div class="mcm-scene-hint" id="mcm-scene-hint" style="display:none; font-size:12px; color:#888; margin:-6px 0 12px; line-height:1.6;"></div>
        <div class="mcm-member-caption">
          <strong>成员配置</strong>
          <span>默认保留 Claude + Codex；需要第三视角时再添加 DeepSeek。可继续加人，同一种 AI 也能多开。每位成员可独立选择模型、思考强度、速度与 MCP。</span>
        </div>
        <div class="mcm-slots"></div>
        <button type="button" class="mcm-add-member" id="mcm-add-member">+ 添加成员</button>
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
  _modalEl.querySelector('#mcm-add-member').addEventListener('click', () => {
    _syncGroupSlotsFromDom();
    const nextKind = _nextGroupMemberKind();
    _groupSlots.push(_normalizeSlotSpec({ kind: nextKind, model: DEFAULT_MODEL_BY_KIND[nextKind] }));
    _renderSlots();
  });
  _modalEl.querySelectorAll('[data-mcm-workspace-mode]').forEach(button => {
    button.addEventListener('click', () => {
      const requested = button.getAttribute('data-mcm-workspace-mode');
      _meetingWorkspaceMode = requested === 'existing' || requested === 'scratch' ? requested : 'default';
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
      if (!radio.checked) return;
      _applyScene(radio.value);
      // 开发场景必须开在项目根：预设 prompt 读的是「本仓库的 .agents/AUTHOR.md」，
      // 落在默认工作根（平铺目录，不是仓库）就一定读不到，而 AI 不会自己 cd 过去。
      // 默认那一档在这里是错的，替用户切掉，而不是等它在第一步失败。
      if (radio.value === 'dev' && _meetingWorkspaceMode !== 'existing') {
        _meetingWorkspaceMode = 'existing';
        _paintWorkspace();
      }
      const hint = _modalEl.querySelector('#mcm-scene-hint');
      if (!hint) return;
      if (radio.value === 'dev') {
        // 开发场景需要解释一句：工作目录档位是被自动切的，不说明用户下次会以为是自己选的。
        hint.textContent = '开发场景要开在项目根上：预设 prompt 读的是这个仓库里的 '
          + '.agents/AUTHOR.md，所以工作目录已切到「选择已有路径」，请挑到项目根。'
          + '项目没整理过的话，先用 project-prep skill 跑一次。';
        hint.style.display = '';
      } else {
        hint.style.display = 'none';
      }
    });
  });
  _modalEl.addEventListener('click', (e) => {
    if (!_presentation.embedded && e.target === _modalEl) closeMeetingCreateModal();
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
    await window.WorkspaceController.loadPrimaryModelCatalogs();
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
    if (scene === 'dev') {
      // 挡在建群这一刻。落错目录的代价是几分钟后才看得出来的一次空转，
      // 而这里只要一行判断。见 renderer/dev-workspace-guard.js 的注释。
      const verdict = checkDevWorkspace(workspace && workspace.path);
      if (!verdict.ok) throw new Error(verdict.message);
    }
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
    _applyDefaultDevWorkflow(meeting, scene, slots);
    const onCreated = _presentation.onCreated;
    closeMeetingCreateModal();
    if (typeof onCreated === 'function') {
      try { onCreated(meeting); } catch (error) { console.error('[meeting-create] onCreated failed', error); }
    }
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

// 开发场景默认就配好「工作位 ↔ 合并位」循环，用户不用再点一次工作流配置。
//
// 为什么放在建群这一刻：发送按钮已经会看 serialWorkflow.loop.enabled 决定跑循环还是
// 普通提问（meeting-room.js 的 doSend 三岔路）。所以只要建群时把它写好，用户后面
// 就只剩「打一句话 + 回车」这一个动作 —— 零配置界面。
//
// 想随便问一句而不跑流程？关掉工作流开关即可，走的还是原来那条普通群聊路径。
// memberId 是位置约定：loop-engine 的 sidOf() 把 m1 解析成 subSessions[0]。
function _applyDefaultDevWorkflow(meeting, scene, slots) {
  if (scene !== 'dev') return;
  const WT = window.WorkflowTemplates;
  if (!WT || typeof WT.createTemplateConfig !== 'function') return;
  if (!Array.isArray(slots) || slots.length < 2) return;   // 单人没法自审自合，不配
  try {
    const members = slots.map((s, i) => ({ memberId: `m${i + 1}`, kind: s.kind }));
    const config = WT.createTemplateConfig('dev-task', members);
    if (!config) return;
    config.templateId = 'dev-task';
    ipcRenderer.send('update-meeting', {
      meetingId: meeting.id,
      fields: { serialWorkflow: config },
    });
  } catch (error) {
    // 配不上不该挡住建群 —— 用户还能手动点工作流配置补上
    console.warn('[meeting-create] 默认开发工作流写入失败:', error && error.message);
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
  const requestedScene = SCENES.some(scene => scene.id === options.scene)
    ? options.scene
    : 'general';
  _currentMode = requestedScene;
  _ensureModal();
  const embeddedHost = options.embedded === true && options.host && typeof options.host.appendChild === 'function'
    ? options.host
    : null;
  if (embeddedHost) embeddedHost.appendChild(_modalEl);
  else if (_modalEl.parentElement !== document.body) document.body.appendChild(_modalEl);
  _modalEl.classList.toggle('mcm-embedded', !!embeddedHost);
  const dialogEl = _modalEl.querySelector('.mcm-dialog');
  if (dialogEl) {
    dialogEl.setAttribute('role', embeddedHost ? 'group' : 'dialog');
    dialogEl.setAttribute('aria-labelledby', embeddedHost ? 'launch-center-group-title' : 'mcm-title-text');
  }
  _presentation = {
    embedded: !!embeddedHost,
    onCreated: typeof options.onCreated === 'function' ? options.onCreated : null,
  };
  _clearError();
  _applyScene(requestedScene, { clearTitle: true, resetSlots: true });
  _meetingWorkspaceMode = 'default';
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
  void window.WorkspaceController.loadPrimaryModelCatalogs().then(() => {
    if (!_modalEl || _modalEl.style.display === 'none') return;
    _syncGroupSlotsFromDom();
    _renderSlots();
  });
  if (_escListener) document.removeEventListener('keydown', _escListener);
  _escListener = null;
  if (!_presentation.embedded) {
    _escListener = (e) => {
      if (e.key === 'Escape' && _modalEl.style.display !== 'none') closeMeetingCreateModal();
    };
    document.addEventListener('keydown', _escListener);
  }
}

function closeMeetingCreateModal() {
  if (_modalEl) _modalEl.style.display = 'none';
  if (_escListener) {
    document.removeEventListener('keydown', _escListener);
    _escListener = null;
  }
  _presentation = { embedded: false, onCreated: null };
}

window.openMeetingCreateModal = openMeetingCreateModal;
window.closeMeetingCreateModal = closeMeetingCreateModal;
})();
