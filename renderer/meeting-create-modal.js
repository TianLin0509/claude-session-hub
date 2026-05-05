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
// KIND_LABELS / ALL_AI_KINDS 来自 ai-kinds.js 单一真理源，含 deepseek/glm/gpt/kimi/qwen，
// 未来加新 AI 自动覆盖；本模块只额外维护 model 列表（每家 CLI 支持的 model id 不一样）。
const { KIND_LABELS, ALL_AI_KINDS } = require('../core/ai-kinds.js');

// 清单按 docs/superpowers/specs/2026-05-01-per-cli-model-picker-design.md §6.1 对齐。
// 例外：claude 多保留一项 'claude-sonnet-4-5'——DEFAULT_SLOTS 当前默认指向它（调试期决定，
// tests/meeting-create-modal-static.test.js + 多个 E2E 锁死），删了会让默认 dropdown 选不中。
const MODELS_BY_KIND = {
  claude:   [
    'claude-opus-4-7[1m]',
    'claude-opus-4-7',
    'claude-opus-4-6[1m]',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-sonnet-4-5',
    'claude-haiku-4-5',
  ],
  gemini:   ['gemini-3-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
  codex:    ['gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex'],
  deepseek: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  glm:      ['glm-5.1', 'glm-4.6', 'glm-4.5-air'],
  // PackyAPI 三家：跑在 Claude CLI 上，model id 由 PackyAPI 端确定。
  // gpt kind 不含 'gpt-5.5'——PackyAPI 中转仅支持到 5.4；5.5 只在 codex kind（OpenAI 官方）下可用。
  gpt:      ['gpt-5.4-high', 'gpt-5.4'],
  kimi:     ['kimi-k2.5'],
  qwen:     ['qwen3.6-plus'],
};

// 2026-05-05：圆桌主流程已跑稳，从"同种 ×3 调试期默认"恢复混合默认（道雪指定）。
const DEFAULT_SLOTS = [
  { kind: 'claude',   model: 'claude-opus-4-7[1m]' },
  { kind: 'gpt',      model: 'gpt-5.4-high' },
  { kind: 'deepseek', model: 'deepseek-v4-pro' },
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
  // E4 修复 (2026-05-03)：旧版仅 if (_modalEl) return —— 若 modal 被外部
  //   .remove() 出 DOM（DevTools / 测试 / 极端 UI 路径），缓存的 detached
  //   element 仍 truthy，下次 open 直接返回 detached 节点，modal 永远不显示。
  //   修复：检查 element 是否仍在 document 树里。
  if (_modalEl && document.body.contains(_modalEl)) return _modalEl;
  _modalEl = null;
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
        <div class="mcm-name-row">
          <label class="mcm-name-label" for="mcm-title-input">房名（可选）</label>
          <input id="mcm-title-input" class="mcm-title-input" type="text" maxlength="40"
                 placeholder="留空 → 自动编号" autocomplete="off">
        </div>
        <div class="mcm-slots">
          ${[0, 1, 2].map(i => _slotHtml(i)).join('')}
        </div>
        <!-- 2026-05-05 道雪：废弃主驾模式入口，所有圆桌默认 free。原 mcm-meeting-mode radio 已删除。 -->
        <div class="mcm-scene">
          场景:
          <label><input type="radio" name="mcm-scene" value="general" checked> 通用</label>
          <label><input type="radio" name="mcm-scene" value="research"> 投研 <span class="mcm-scene-hint" title="投研场景需配置 A 股数据后端（设环境变量 LINDANG_DIR），未配置时 AI 拿不到行情数据。详见 README → 协作集成。">ⓘ</span></label>
          <label><input type="radio" name="mcm-scene" value="dev"> 开发</label>
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
  // legacy mode 字段镜像 scene (向后兼容): research→research, dev→dev (plan-dev-scenario.md), 其他→general
  const mode = (scene === 'research' || scene === 'dev') ? scene : 'general';
  // 2026-05-05 道雪：主驾模式入口废弃，meetingMode 不再传（core/meeting-room.js 强制 'free'）。
  // 2026-05-05 道雪：房名输入框，非空 → 覆盖后端默认编号 title；空 → 后端走 `通用 #N` 等。
  const titleInput = _modalEl.querySelector('#mcm-title-input');
  const title = titleInput ? titleInput.value.trim() : '';

  const createBtn = _modalEl.querySelector('.mcm-create');
  createBtn.disabled = true;
  createBtn.textContent = '创建中…';

  // 清掉之前可能残留的 inline error
  _clearError();
  try {
    const meeting = await ipcRenderer.invoke('create-meeting', { mode, scene, slots, title });
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
    // E2 修复 (2026-05-03)：原 alert() 同步阻塞 Electron renderer 主线程，UI 卡死。
    //   改为 modal 内 inline error span，不阻塞 + 用户可见错误后修正重试。
    console.error('[meeting-create-modal] create failed:', e);
    _showError((e && e.message) ? e.message : String(e));
    createBtn.disabled = false;
    createBtn.textContent = '创建圆桌';
  }
}

function _showError(text) {
  if (!_modalEl) return;
  let bar = _modalEl.querySelector('.mcm-error');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'mcm-error';
    const footer = _modalEl.querySelector('.mcm-footer');
    if (footer) footer.before(bar); else _modalEl.querySelector('.mcm-body')?.appendChild(bar);
  }
  bar.textContent = '⚠ 创建失败：' + text;
}

function _clearError() {
  if (!_modalEl) return;
  const bar = _modalEl.querySelector('.mcm-error');
  if (bar) bar.remove();
}

function openMeetingCreateModal(mode = 'general') {
  _currentMode = mode === 'research' ? 'research' : 'general';
  _ensureModal();
  _modalEl.querySelector('#mcm-mode-label').textContent = _currentMode === 'research' ? '投研' : '通用';
  // 房名输入框：每次打开清空 + 按 mode 给提示词。用户填了即覆盖编号 title，留空 → 后端默认。
  const titleInput = _modalEl.querySelector('#mcm-title-input');
  if (titleInput) {
    titleInput.value = '';
    const hint = _currentMode === 'research' ? '投研' : '通用';
    titleInput.placeholder = `留空 → 自动编号「${hint} #N」`;
  }
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

