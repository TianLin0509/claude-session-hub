'use strict';
// meeting-create-modal（2026-05-01）：新建圆桌引导 Modal。
//
// 用户从侧边栏 + → "新建圆桌" 时弹出本 Modal（非阻塞），三个横排 slot：
//   - 每 slot 选 AI（claude / gemini / codex / deepseek / glm）
//   - 每 slot 选 model（按 AI 动态过滤）
//   - 场景 radio：通用 / 投研
// 提交时通过 ipcRenderer.invoke('create-meeting', { mode, scene, slots }) 创建会议
//   + 自动 add-meeting-sub 三个；返回的 meeting 已含 subSessions + slotSpecs。
//
// 与 renderer.js 通过 selectMeeting() 全局函数 + meeting-created IPC 事件协作。
//
// 整个模块包裹在 IIFE 里 — renderer.js 顶层已 const ipcRenderer 等，与本模块共享
// 全局 script scope，再次 const 会抛 "Identifier 'ipcRenderer' has already been declared"。

(function () {

const { ipcRenderer } = require('electron');

const MODELS_BY_KIND = {
  claude:   ['claude-opus-4-7[1m]', 'claude-opus-4-6', 'claude-sonnet-4-5'],
  gemini:   ['gemini-2.5-flash', 'gemini-2.5-pro'],
  codex:    ['gpt-5.5', 'gpt-5.4'],
  deepseek: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  glm:      ['glm-5.1', 'glm-4.6', 'glm-4-plus', 'glm-4-air'],
};

const KIND_LABELS = {
  claude: 'Claude',
  gemini: 'Gemini',
  codex:  'Codex',
  deepseek: 'DeepSeek',
  glm:    'GLM',
};

const DEFAULT_SLOTS = [
  { kind: 'claude', model: 'claude-opus-4-7[1m]' },
  { kind: 'gemini', model: 'gemini-2.5-flash' },
  { kind: 'codex',  model: 'gpt-5.5' },
];

const SLOT_AVATARS = [
  'assets/pokemon/pikachu.png',
  'assets/pokemon/charmander.png',
  'assets/pokemon/squirtle.png',
];
const SLOT_NAMES = ['皮卡丘位', '小火龙位', '杰尼龟位'];

let _modalEl = null;
let _currentMode = 'general';
let _escListener = null;

function _escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _slotHtml(i) {
  const def = DEFAULT_SLOTS[i];
  const aiOptions = Object.keys(MODELS_BY_KIND).map(k =>
    `<option value="${_escapeHtml(k)}"${k === def.kind ? ' selected' : ''}>${_escapeHtml(KIND_LABELS[k])}</option>`
  ).join('');
  const modelOptions = MODELS_BY_KIND[def.kind].map(m =>
    `<option value="${_escapeHtml(m)}"${m === def.model ? ' selected' : ''}>${_escapeHtml(m)}</option>`
  ).join('');
  return `
    <div class="mcm-slot" data-slot="${i}">
      <img class="mcm-avatar" src="${SLOT_AVATARS[i]}" alt="${SLOT_NAMES[i]}">
      <div class="mcm-slot-label">Slot ${i + 1} · ${SLOT_NAMES[i]}</div>
      <label>AI: <select class="mcm-ai-select">${aiOptions}</select></label>
      <label>Model: <select class="mcm-model-select">${modelOptions}</select></label>
    </div>
  `;
}

function _ensureModal() {
  if (_modalEl) return _modalEl;
  _modalEl = document.createElement('div');
  _modalEl.id = 'meeting-create-modal';
  _modalEl.className = 'mcm-overlay';
  _modalEl.style.display = 'none';
  _modalEl.innerHTML = `
    <div class="mcm-dialog" role="dialog" aria-labelledby="mcm-title-text">
      <div class="mcm-header">
        <span class="mcm-title" id="mcm-title-text">新建<span id="mcm-mode-label">通用</span>圆桌</span>
        <button class="mcm-close" aria-label="关闭">×</button>
      </div>
      <div class="mcm-body">
        <div class="mcm-slots">
          ${[0, 1, 2].map(i => _slotHtml(i)).join('')}
        </div>
        <div class="mcm-scene">
          场景:
          <label><input type="radio" name="mcm-scene" value="general" checked> 通用</label>
          <label><input type="radio" name="mcm-scene" value="research"> 投研</label>
        </div>
      </div>
      <div class="mcm-footer">
        <button class="mcm-cancel">取消</button>
        <button class="mcm-create mcm-primary">创建圆桌</button>
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

  // 点遮罩关闭
  _modalEl.addEventListener('click', (e) => {
    if (e.target === _modalEl) closeMeetingCreateModal();
  });

  // AI dropdown 改变 → 刷新该 slot 的 model 列表（选中第一个 model）
  _modalEl.querySelectorAll('.mcm-slot').forEach(slotEl => {
    const aiSel = slotEl.querySelector('.mcm-ai-select');
    aiSel.addEventListener('change', () => _refreshModelOptions(slotEl));
  });
}

function _refreshModelOptions(slotEl) {
  const kind = slotEl.querySelector('.mcm-ai-select').value;
  const modelSel = slotEl.querySelector('.mcm-model-select');
  const opts = MODELS_BY_KIND[kind] || [];
  modelSel.innerHTML = opts.map((m, i) =>
    `<option value="${_escapeHtml(m)}"${i === 0 ? ' selected' : ''}>${_escapeHtml(m)}</option>`
  ).join('');
}

async function _onCreate() {
  const slots = [];
  _modalEl.querySelectorAll('.mcm-slot').forEach((el, i) => {
    slots.push({
      index: i,
      kind: el.querySelector('.mcm-ai-select').value,
      model: el.querySelector('.mcm-model-select').value,
    });
  });
  const scene = _modalEl.querySelector('input[name="mcm-scene"]:checked').value;
  const mode = scene === 'research' ? 'research' : 'general';

  const createBtn = _modalEl.querySelector('.mcm-create');
  createBtn.disabled = true;
  createBtn.textContent = '创建中…';

  try {
    const meeting = await ipcRenderer.invoke('create-meeting', { mode, scene, slots });
    if (!meeting || !meeting.id) {
      throw new Error('create-meeting returned empty meeting');
    }
    closeMeetingCreateModal();
    // selectMeeting 是 renderer.js 的 top-level 函数，全局可调用
    if (typeof selectMeeting === 'function') {
      selectMeeting(meeting.id);
    } else if (typeof window.selectMeeting === 'function') {
      window.selectMeeting(meeting.id);
    } else {
      console.warn('[meeting-create-modal] selectMeeting not found globally; meeting created but UI not switched');
    }
  } catch (e) {
    console.error('[meeting-create-modal] create failed:', e);
    alert('创建失败：' + (e && e.message ? e.message : String(e)));
    createBtn.disabled = false;
    createBtn.textContent = '创建圆桌';
  }
}

function openMeetingCreateModal(mode = 'general') {
  _currentMode = mode === 'research' ? 'research' : 'general';
  _ensureModal();
  _modalEl.querySelector('#mcm-mode-label').textContent = _currentMode === 'research' ? '投研' : '通用';
  // 重置到默认值
  _modalEl.querySelectorAll('.mcm-slot').forEach((el, i) => {
    el.querySelector('.mcm-ai-select').value = DEFAULT_SLOTS[i].kind;
    _refreshModelOptions(el);
    el.querySelector('.mcm-model-select').value = DEFAULT_SLOTS[i].model;
  });
  const sceneRadio = _modalEl.querySelector(`input[name="mcm-scene"][value="${_currentMode}"]`);
  if (sceneRadio) sceneRadio.checked = true;
  const createBtn = _modalEl.querySelector('.mcm-create');
  createBtn.disabled = false;
  createBtn.textContent = '创建圆桌';
  _modalEl.style.display = 'flex';
  // Esc 关闭：每次打开重新绑（避免泄漏 + 关闭时移除）
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

