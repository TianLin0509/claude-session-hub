'use strict';

const { modelOptionsFor, canSwitchInline } = require('../core/model-options.js');

// Map a model id to a CSS family class for badge coloring.
function modelClass(id) {
  if (!id) return '';
  const s = id.toLowerCase();
  if (s.includes('opus')) return 'opus';
  if (s.includes('sonnet')) return 'sonnet';
  if (s.includes('haiku')) return 'haiku';
  if (s.includes('gemini')) return 'gemini';
  if (s.includes('codex') || s.includes('gpt-5') || s.includes('o3') || s.includes('o4-mini')) return 'codex';
  if (s.includes('deepseek')) return 'deepseek';
  if (s.includes('glm')) return 'glm';
  if (s.includes('gpt')) return 'gpt';
  if (s.includes('kimi')) return 'kimi';
  if (s.includes('qwen')) return 'qwen';
  return '';
}

// Short label for the sidebar badge. display_name is already compact
// ("Opus 4.6 (1M context)"); we strip the parenthetical to keep the pill slim.
function modelShort(m) {
  if (!m) return '';
  const dn = m.displayName || '';
  if (dn) return dn.replace(/\s*\(.*?\)\s*$/, '').trim();
  const id = (m.id || '').toLowerCase();
  if (id.includes('opus')) return 'Opus';
  if (id.includes('sonnet')) return 'Sonnet';
  if (id.includes('haiku')) return 'Haiku';
  if (id.includes('gemini')) return id.replace(/^gemini-/, 'Gemini ').replace(/-/g, ' ');
  if (id.includes('codex')) return 'Codex';
  if (id.includes('deepseek')) return 'DS';
  if (id.includes('glm')) return 'GLM';
  if (id.includes('gpt')) return 'GP';
  if (id.includes('kimi')) return 'KI';
  if (id.includes('qwen')) return 'QW';
  return m.id || '';
}

function createModelUiController({ document, ipcRenderer, sessions, terminalPanelEl, getActiveSessionId, escapeHtml, setTimeoutFn = setTimeout }) {
  if (!document) throw new Error('document is required');
  if (!ipcRenderer) throw new Error('ipcRenderer is required');
  if (!sessions) throw new Error('sessions is required');
  if (!terminalPanelEl) throw new Error('terminalPanelEl is required');
  if (typeof getActiveSessionId !== 'function') throw new Error('getActiveSessionId is required');
  if (typeof escapeHtml !== 'function') throw new Error('escapeHtml is required');

  // Refresh just the terminal-header badge for the active session without a full re-render.
  function updateActiveModelBadge() {
    const activeSessionId = getActiveSessionId();
    const session = activeSessionId ? sessions.get(activeSessionId) : null;
    if (!session) return;
    const titleSection = terminalPanelEl.querySelector('.terminal-title-section');
    if (!titleSection) return; // header not mounted yet (empty state)
    let badge = titleSection.querySelector('.terminal-model-badge');
    if (!session.currentModel) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      titleSection.appendChild(badge);
    }
    badge.className = 'terminal-model-badge ' + modelClass(session.currentModel.id);
    badge.textContent = session.currentModel.displayName || modelShort(session.currentModel);
    badge.title = session.currentModel.id + ' — click to switch model';
    // attach after className is set — attach uses classList.add to preserve
    attachModelPickerHandler(badge, activeSessionId);
  }
  
  // ---- Model picker dropdown ----
  // Per-kind model option source of truth lives in core/model-options.js.
  // claude / deepseek / glm / gpt / kimi / qwen \u90fd\u8dd1\u5728 claude CLI \u4e0a\uff08\u76f4\u8fde\u6216 ANTHROPIC_BASE_URL \u4e2d\u8f6c\uff09\uff0c
  // \u8d70\u539f\u5730 `/model <id>\r` \u5207\u6362\u3002codex / gemini \u7684 PTY \u4e0d\u8bc6\u522b inline `/model`\uff08spec \u00a73.1 \u5df2\u8bba\u8bc1\uff09\uff0c
  // picker \u6539\u4e3a\u663e\u793a\u53ea\u8bfb\u6e05\u5355 + \u63d0\u793a"\u91cd\u65b0\u5efa\u7acb session"\u2014\u2014\u907f\u514d\u53d1\u9001\u65e0\u6548\u5207\u6362\u8ba9\u7528\u6237\u8bef\u4ee5\u4e3a\u5207\u4e86\u3002
  
  
  let openModelPicker = null; // { el, badge, onDocClick } while a picker is open
  
  function attachModelPickerHandler(badgeEl, sessionId) {
    if (!badgeEl || badgeEl._modelPickerBound) return;
    badgeEl._modelPickerBound = true;
    badgeEl.classList.add('clickable');
    badgeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (openModelPicker && openModelPicker.badge === badgeEl) {
        closeModelPicker();
        return;
      }
      showModelPicker(badgeEl, sessionId);
    });
  }
  
  function showModelPicker(badgeEl, sessionId) {
    closeModelPicker();
    const session = sessions.get(sessionId);
    const kind = session && session.kind ? session.kind : '';
    const options = modelOptionsFor(kind);
    const inlineOk = canSwitchInline(kind);
    const currentId = session && session.currentModel ? (session.currentModel.id || '') : '';
  
    const menu = document.createElement('div');
    menu.className = 'model-picker-menu';
  
    if (options.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'model-picker-empty';
      empty.textContent = '\u8be5\u4f1a\u8bdd\u7c7b\u578b\u4e0d\u652f\u6301\u6a21\u578b\u5207\u6362';
      menu.appendChild(empty);
    } else {
      if (!inlineOk) {
        const note = document.createElement('div');
        note.className = 'model-picker-note';
        note.textContent = '\u2139 \u8be5 CLI \u4e0d\u652f\u6301\u539f\u5730\u5207\u6362\u6a21\u578b\u2014\u2014\u8bf7\u5173\u95ed\u540e\u65b0\u5efa\u4f1a\u8bdd\u65f6\u9009\u62e9';
        menu.appendChild(note);
      }
      options.forEach((opt) => {
        const item = document.createElement('div');
        item.className = 'model-picker-item';
        if (!inlineOk) item.classList.add('disabled');
        item.dataset.modelId = opt.id;
        if (opt.id === currentId) item.classList.add('current');
        item.innerHTML = `<span class="model-picker-check">${opt.id === currentId ? '\u2713' : ''}</span><span class="model-picker-label">${escapeHtml(opt.label)}</span><span class="model-picker-id">${escapeHtml(opt.id)}</span>`;
        if (inlineOk) {
          item.addEventListener('click', (e) => {
            e.stopPropagation();
            ipcRenderer.send('terminal-input', { sessionId, data: `/model ${opt.id}\r` });
            closeModelPicker();
          });
        } else {
          item.addEventListener('click', (e) => {
            e.stopPropagation();
            // \u53ea\u8bfb\uff1a\u70b9\u51fb\u5173\u95ed menu\uff0c\u4e0d\u53d1 PTY \u8f93\u5165\u3002
            closeModelPicker();
          });
        }
        menu.appendChild(item);
      });
    }
  
    document.body.appendChild(menu);
    const rect = badgeEl.getBoundingClientRect();
    menu.style.top = (rect.bottom + 4) + 'px';
    menu.style.left = rect.left + 'px';
    const onDocClick = (e) => { if (!menu.contains(e.target)) closeModelPicker(); };
    // defer so the triggering click doesn't immediately close the menu
    setTimeoutFn(() => document.addEventListener('click', onDocClick), 0);
    openModelPicker = { el: menu, badge: badgeEl, onDocClick };
  }
  
  function closeModelPicker() {
    if (!openModelPicker) return;
    document.removeEventListener('click', openModelPicker.onDocClick);
    openModelPicker.el.remove();
    openModelPicker = null;
  }

  return {
    attachModelPickerHandler,
    updateActiveModelBadge,
    closeModelPicker,
  };
}

module.exports = { modelClass, modelShort, createModelUiController };
