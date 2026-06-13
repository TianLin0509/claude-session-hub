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
// 投委会五席预设（三面五席；席位映射见 core/committee-scene.js）
// 2026-06-12：消息面官改 Claude，技术面官改 Codex GPT-5.5，避开 Kimi/Qwen 登录链路。
// 2026-06-13：消息面官 + 主席统一跟随 DEFAULT_MODEL_BY_KIND.claude（用户偏好"立花道雪
//   工作台"所有 Claude 会话默认走最新模型 = Opus 4.8 1M）。
const COMMITTEE_SLOTS = [
  { kind: 'deepseek', model: 'deepseek-v4-pro[1m]' },         // 🛡️ 基本面官
  { kind: 'claude', model: DEFAULT_MODEL_BY_KIND.claude },     // 📡 消息面官
  { kind: 'codex', model: 'gpt-5.5' },                         // 📈 技术面官
  { kind: 'codex', model: 'gpt-5.5' },                         // ⚔️ 质询官
  { kind: 'claude', model: DEFAULT_MODEL_BY_KIND.claude },     // ⚖️ 主席
];
const DEFAULT_GROUP_MEMBERS = DEFAULT_SLOTS.map(x => ({ ...x }));
const SLOT_AVATARS = [
  'assets/pokemon/pikachu.png',
  'assets/pokemon/charmander.png',
  'assets/pokemon/squirtle.png',
];
const SLOT_NAMES = ['皮卡丘位', '小火龙位', '杰尼龟位'];

let _modalEl = null;
let _currentMode = 'general';
let _isGroupChat = true;
let _groupSlots = DEFAULT_GROUP_MEMBERS.map(x => ({ ...x }));
let _escListener = null;

function _escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _aiLogo(kind) {
  return `assets/ai-logos/${kind}.svg`;
}

function _modelOptions(kind, selected) {
  const opts = MODELS_BY_KIND[kind] || [];
  return opts.map((m, i) =>
    `<option value="${_escapeHtml(m)}"${m === selected || (!selected && i === 0) ? ' selected' : ''}>${_escapeHtml(m)}</option>`
  ).join('');
}

function _slotHtml(i, spec, isGroup) {
  const def = spec || DEFAULT_SLOTS[i] || DEFAULT_SLOTS[0];
  const aiOptions = Object.keys(MODELS_BY_KIND).map(k =>
    `<option value="${_escapeHtml(k)}"${k === def.kind ? ' selected' : ''}>${_escapeHtml(KIND_LABELS[k] || k)}</option>`
  ).join('');
  const avatarSrc = isGroup ? _aiLogo(def.kind) : SLOT_AVATARS[i];
  const avatarAlt = isGroup ? (KIND_LABELS[def.kind] || def.kind) : SLOT_NAMES[i];
  const label = isGroup ? `成员 ${i + 1}` : `Slot ${i + 1} · ${SLOT_NAMES[i]}`;
  const removeBtn = isGroup && i >= 1
    ? `<button type="button" class="mcm-remove-member" data-remove-member="${i}" title="移除此成员">×</button>`
    : '';
  return `
    <div class="mcm-slot${isGroup ? ' mcm-group-member' : ''}" data-slot="${i}">
      ${removeBtn}
      <img class="mcm-avatar" src="${_escapeHtml(avatarSrc)}" alt="${_escapeHtml(avatarAlt)}">
      <div class="mcm-slot-label">${_escapeHtml(label)}</div>
      <label>AI: <select class="mcm-ai-select">${aiOptions}</select></label>
      <label>Model: <select class="mcm-model-select">${_modelOptions(def.kind, def.model)}</select></label>
    </div>
  `;
}

function _syncGroupSlotsFromDom() {
  if (!_modalEl || !_isGroupChat) return;
  _groupSlots = Array.from(_modalEl.querySelectorAll('.mcm-slot')).map(el => ({
    kind: el.querySelector('.mcm-ai-select').value,
    model: el.querySelector('.mcm-model-select').value,
  }));
}

function _refreshModelOptions(slotEl) {
  const kind = slotEl.querySelector('.mcm-ai-select').value;
  const modelSel = slotEl.querySelector('.mcm-model-select');
  modelSel.innerHTML = _modelOptions(kind);
  const img = slotEl.querySelector('.mcm-avatar');
  if (_isGroupChat && img) {
    img.src = _aiLogo(kind);
    img.alt = KIND_LABELS[kind] || kind;
  }
}

function _renderSlots() {
  if (!_modalEl) return;
  const wrap = _modalEl.querySelector('.mcm-slots');
  if (!wrap) return;
  const specs = _isGroupChat ? _groupSlots : DEFAULT_SLOTS;
  wrap.innerHTML = specs.map((spec, i) => _slotHtml(i, spec, _isGroupChat)).join('');
  wrap.querySelectorAll('.mcm-slot').forEach(slotEl => {
    slotEl.querySelector('.mcm-ai-select').addEventListener('change', () => {
      _refreshModelOptions(slotEl);
      _syncGroupSlotsFromDom();
    });
    slotEl.querySelector('.mcm-model-select').addEventListener('change', _syncGroupSlotsFromDom);
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
        <div class="mcm-slots"></div>
        <button type="button" class="mcm-add-member" id="mcm-add-member">+ 添加成员</button>
        <div class="mcm-scene">
          场景:
          <label><input type="radio" name="mcm-scene" value="general" checked> 通用</label>
          <label><input type="radio" name="mcm-scene" value="research"> 投研</label>
          <label><input type="radio" name="mcm-scene" value="committee"> ⚖️ 投委会</label>
          <label><input type="radio" name="mcm-scene" value="dev"> 开发</label>
        </div>
        <div class="mcm-scene-hint" id="mcm-scene-hint" style="display:none; font-size:12px; color:#888; margin-top:6px; line-height:1.6;"></div>
      </div>
      <div class="mcm-footer">
        <button class="mcm-cancel">取消</button>
        <button class="mcm-create mcm-primary">创建群聊</button>
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
  _modalEl.querySelector('.mcm-create').addEventListener('click', _onCreate);
  _modalEl.querySelector('#mcm-add-member').addEventListener('click', () => {
    _syncGroupSlotsFromDom();
    _groupSlots.push({ ...DEFAULT_GROUP_MEMBERS[_groupSlots.length % DEFAULT_GROUP_MEMBERS.length] });
    _renderSlots();
  });
  // 选中投委会场景 → 自动装填五席预设（三面五席）
  _modalEl.querySelectorAll('input[name="mcm-scene"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const hint = _modalEl.querySelector('#mcm-scene-hint');
      if (radio.value === 'committee' && radio.checked) {
        _groupSlots = COMMITTEE_SLOTS.map(x => ({ ...x }));
        _renderSlots();
        if (hint) {
          hint.style.display = 'block';
          hint.textContent = '五席已自动装填：🛡️基本面官=DeepSeek · 📡消息面官=Claude Opus 4.8 · 📈技术面官=Codex GPT-5.5 · ⚔️质询官=Codex GPT-5.5 · ⚖️主席=Claude Opus 4.8。创建后可直接输入股票中文名/代码，例如“赛力斯怎么样”“中远海控深挖一下”；多票对比会先识别并防止误跑第一只。';
        }
      } else if (radio.checked && hint) {
        hint.style.display = 'none';
      }
    });
  });
  _modalEl.addEventListener('click', (e) => {
    if (e.target === _modalEl) closeMeetingCreateModal();
  });
}

async function _onCreate() {
  const slots = Array.from(_modalEl.querySelectorAll('.mcm-slot')).map((el, i) => ({
    index: i,
    kind: el.querySelector('.mcm-ai-select').value,
    model: el.querySelector('.mcm-model-select').value,
  }));
  const scene = _modalEl.querySelector('input[name="mcm-scene"]:checked').value;
  // createMeeting 的 scene 实际取自 mode（过 MEETING_MODES 白名单），scene 字段只是透传
  const mode = (scene === 'research' || scene === 'dev' || scene === 'committee') ? scene : 'general';
  const titleInput = _modalEl.querySelector('#mcm-title-input');
  const title = titleInput ? titleInput.value.trim() : '';

  const createBtn = _modalEl.querySelector('.mcm-create');
  createBtn.disabled = true;
  createBtn.textContent = '创建群聊中...';
  _clearError();
  try {
    const meeting = await ipcRenderer.invoke('create-meeting', {
      mode,
      scene,
      slots,
      title,
      groupChat: _isGroupChat,
      groupMode: _isGroupChat ? 'deliberation' : null,
      groupRecentRawN: 5,
      participants: _isGroupChat ? slots.map((_, i) => i) : null,
    });
    if (!meeting || !meeting.id) throw new Error('create-meeting returned empty meeting');
    closeMeetingCreateModal();
    if (typeof selectMeeting === 'function') selectMeeting(meeting.id);
    else if (typeof window.selectMeeting === 'function') window.selectMeeting(meeting.id);
  } catch (e) {
    console.error('[meeting-create-modal] create failed:', e);
    _showError((e && e.message) ? e.message : String(e));
    createBtn.disabled = false;
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

function openMeetingCreateModal(mode = 'general') {
  if (mode === 'group') {
    _isGroupChat = true;
  } else {
    _isGroupChat = true;
  }
  _currentMode = 'general';
  _ensureModal();
  _clearError();
  _groupSlots = DEFAULT_GROUP_MEMBERS.map(x => ({ ...x }));
  _renderSlots();

  const modeLabel = _modalEl.querySelector('#mcm-mode-label');
  modeLabel.textContent = 'AI 群聊';

  const titleInput = _modalEl.querySelector('#mcm-title-input');
  if (titleInput) {
    titleInput.value = '';
    titleInput.placeholder = '留空则自动编号：AI 群聊 #N';
  }
  const sceneRadio = _modalEl.querySelector(`input[name="mcm-scene"][value="${_currentMode}"]`);
  if (sceneRadio) sceneRadio.checked = true;
  const addBtn = _modalEl.querySelector('#mcm-add-member');
  if (addBtn) addBtn.style.display = 'inline-flex';
  const createBtn = _modalEl.querySelector('.mcm-create');
  createBtn.disabled = false;
  createBtn.textContent = '创建群聊';
  _modalEl.style.display = 'flex';
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
