'use strict';

const {
  canSwitchInSession,
  modelOptionsFor,
  modelSwitchStrategy,
} = require('../core/model-options.js');

// Map a model id to a CSS family class for badge coloring.
function modelClass(id) {
  if (!id) return '';
  const s = id.toLowerCase();
  if (s.includes('opus')) return 'opus';
  if (s.includes('fable')) return 'fable';
  if (s.includes('sonnet')) return 'sonnet';
  if (s.includes('haiku')) return 'haiku';
  if (s.includes('gemini')) return 'gemini';
  if (s.includes('codex') || s.includes('gpt-5') || s.includes('o3') || s.includes('o4-mini')) return 'codex';
  if (s.includes('deepseek')) return 'deepseek';
  if (s.includes('kimi') || s === 'k3') return 'kimi';
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
  if (id.includes('fable')) return 'Fable';
  if (id.includes('sonnet')) return 'Sonnet';
  if (id.includes('haiku')) return 'Haiku';
  if (id.includes('gemini')) return id.replace(/^gemini-/, 'Gemini ').replace(/-/g, ' ');
  if (id.includes('codex')) return 'Codex';
  if (id.includes('deepseek')) return 'DS';
  if (id.includes('kimi') || id === 'k3') return 'Kimi K3';
  return m.id || '';
}

const EFFORT_RANK = Object.freeze({ low: 1, medium: 2, high: 3, xhigh: 4, max: 5, ultra: 6 });

function pickerRows(screen) {
  const rows = [];
  for (const line of String(screen || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(›|>)?\s*(\d+)\.\s+(.+?)\s*$/);
    if (!match) continue;
    rows.push({
      highlighted: !!match[1],
      number: Number(match[2]),
      text: match[3],
    });
  }
  return rows;
}

function parseCodexModelPicker(screen) {
  if (!/Select Model and Effort/i.test(String(screen || ''))) return null;
  const entries = pickerRows(screen).map(row => {
    const match = row.text.match(/^((?:gpt-[\w.-]+|o\d[\w.-]*))\b/i);
    return match ? { ...row, value: match[1] } : null;
  }).filter(Boolean);
  if (!entries.length) return null;
  return { entries, highlighted: entries.find(entry => entry.highlighted) || entries[0] };
}

function reasoningLabelToEffort(label) {
  const value = String(label || '').replace(/\s*\(default\).*/i, '').trim().toLowerCase();
  if (value.startsWith('extra high') || value === 'xhigh') return 'xhigh';
  if (value.startsWith('ultra')) return 'ultra';
  if (value.startsWith('maximum') || value === 'max') return 'max';
  if (value.startsWith('high')) return 'high';
  if (value.startsWith('medium')) return 'medium';
  if (value.startsWith('low')) return 'low';
  return '';
}

function parseCodexReasoningPicker(screen, modelId = '') {
  const text = String(screen || '');
  if (!/Select Reasoning Level/i.test(text)) return null;
  if (modelId && !text.toLowerCase().includes(String(modelId).toLowerCase())) return null;
  const entries = pickerRows(text).map(row => {
    const value = reasoningLabelToEffort(row.text);
    return value ? { ...row, value } : null;
  }).filter(Boolean);
  if (!entries.length) return null;
  return { entries, highlighted: entries.find(entry => entry.highlighted) || entries[0] };
}

function pickerNavigationInput(fromNumber, toNumber) {
  const from = Number(fromNumber);
  const to = Number(toNumber);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) return '';
  return (to > from ? '\x1b[B' : '\x1b[A').repeat(Math.abs(to - from));
}

function compatibleEffort(requested, entries, highlighted) {
  const available = (entries || []).map(entry => entry.value).filter(value => EFFORT_RANK[value]);
  if (!available.length) return null;
  const wanted = String(requested || '').toLowerCase();
  if (available.includes(wanted)) return wanted;
  const rank = EFFORT_RANK[wanted];
  if (rank) {
    const compatible = available.filter(value => EFFORT_RANK[value] <= rank);
    if (compatible.length) return compatible.sort((a, b) => EFFORT_RANK[b] - EFFORT_RANK[a])[0];
  }
  return highlighted && available.includes(highlighted.value) ? highlighted.value : available[0];
}

function modelSelectionMatches(actualId, selectedId) {
  const actual = String(actualId || '').replace(/\[1m\]$/i, '').toLowerCase();
  const selected = String(selectedId || '').replace(/\[1m\]$/i, '').toLowerCase();
  if (!actual || !selected) return false;
  if (actual === selected) return true;
  return ['fable', 'opus', 'sonnet', 'haiku'].some(alias => selected === alias && actual.includes(`-${alias}-`));
}

function terminalAcceptsModelCommand(screen, strategy) {
  const lines = String(screen || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (strategy === 'codex-picker') {
    const prompts = lines.filter(line => line.startsWith('›'));
    const last = prompts[prompts.length - 1] || '';
    return /^›\s*Ask Codex to do anything\s*$/i.test(last);
  }
  if (strategy === 'claude-inline') {
    const prompts = lines.filter(line => line.startsWith('❯'));
    const last = prompts[prompts.length - 1] || '';
    return /^❯\s*$/.test(last) || /^❯\s*Try\s+["“].+["”]\s*$/i.test(last);
  }
  return false;
}

function createModelUiController({
  document,
  ipcRenderer,
  sessions,
  terminalPanelEl,
  getActiveSessionId,
  escapeHtml,
  getModelOptions = modelOptionsFor,
  refreshModelCatalog = async () => null,
  getTerminalScreenText = () => '',
  isSessionBusy = session => !!(session && session.status === 'running'),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now,
  switchTimeoutMs = 7000,
  setTimeoutFn = setTimeout,
}) {
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
    if (session._modelSwitchPending) badge.classList.add('switching');
    badge.textContent = session._modelSwitchPending
      ? `${session.currentModel.displayName || modelShort(session.currentModel)} → ${session._modelSwitchPending.label}`
      : (session.currentModel.displayName || modelShort(session.currentModel));
    badge.title = session.currentModel.id + ' — click to switch model';
    // attach after className is set — attach uses classList.add to preserve
    attachModelPickerHandler(badge, activeSessionId);
  }
  
  // ---- Model picker dropdown ----
  // Claude accepts an inline model argument. Codex 0.151 uses two native
  // keyboard pickers. Both are driven through the real PTY and confirmed from
  // the live screen before Hub changes its own metadata.
  
  
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
      void showModelPicker(badgeEl, sessionId);
    });
  }

  function placeMenu(menu, badgeEl) {
    const rect = badgeEl.getBoundingClientRect();
    menu.style.top = (rect.bottom + 4) + 'px';
    menu.style.left = rect.left + 'px';
  }

  function menuNote(menu, text, state = 'info') {
    const note = document.createElement('div');
    note.className = 'model-picker-note';
    note.dataset.state = state;
    note.textContent = text;
    menu.appendChild(note);
    return note;
  }

  function renderModelPicker(menu, badgeEl, sessionId, message = null) {
    if (!menu || menu._removed) return;
    const session = sessions.get(sessionId);
    const kind = session && session.kind ? session.kind : '';
    const options = getModelOptions(kind);
    const strategy = modelSwitchStrategy(kind);
    const currentId = session && session.currentModel ? (session.currentModel.id || '') : '';
    const hasExactCurrent = options.some(option => String(option.id).toLowerCase() === String(currentId).toLowerCase());
    menu.innerHTML = '';
    if (message) menuNote(menu, message.text, message.state);
    if (options.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'model-picker-empty';
      empty.textContent = '该会话类型没有可用模型目录';
      menu.appendChild(empty);
      return;
    }
    if (!canSwitchInSession(kind)) {
      menuNote(menu, 'ℹ 该 CLI 暂不支持从 Hub 原地切换；请在新建会话时选择', 'warning');
    } else if (strategy === 'codex-picker') {
      const live = options.some(option => option.source === 'codex-app-server');
      menuNote(menu, `${live ? '当前账号实时目录' : 'Codex CLI 本地缓存'} · `
        + '将打开原生模型与推理档位面板；Hub 确认终端回执后再更新徽标。');
    } else {
      const accountCache = options.some(option => option.source === 'claude-cli-cache');
      menuNote(menu, `${accountCache ? '当前账号模型缓存' : 'Claude CLI 兼容目录'} · `
        + '支持会话内切换；“最新可用版本”由 CLI 按当前账号解析。');
    }

    options.forEach((opt) => {
      const item = document.createElement('div');
      item.className = 'model-picker-item';
      if (!strategy) item.classList.add('disabled');
      item.dataset.modelId = opt.id;
      const current = String(currentId).toLowerCase() === String(opt.id).toLowerCase()
        || (!hasExactCurrent && modelSelectionMatches(currentId, opt.id));
      if (current) item.classList.add('current');
      if (session && session._modelSwitchPending) item.classList.add('disabled');
      item.title = opt.description || opt.id;
      item.innerHTML = `<span class="model-picker-check">${current ? '✓' : ''}</span>`
        + `<span class="model-picker-label">${escapeHtml(opt.label)}</span>`
        + `<span class="model-picker-id">${escapeHtml(opt.id)}</span>`;
      if (strategy && !(session && session._modelSwitchPending)) {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          if (current) { closeModelPicker(); return; }
          void switchModel(sessionId, opt, menu, badgeEl);
        });
      }
      menu.appendChild(item);
    });
  }

  async function showModelPicker(badgeEl, sessionId) {
    closeModelPicker();
    const menu = document.createElement('div');
    menu.className = 'model-picker-menu';
    document.body.appendChild(menu);
    placeMenu(menu, badgeEl);
    const onDocClick = (e) => { if (!menu.contains(e.target)) closeModelPicker(); };
    // defer so the triggering click doesn't immediately close the menu
    setTimeoutFn(() => document.addEventListener('click', onDocClick), 0);
    openModelPicker = { el: menu, badge: badgeEl, onDocClick };
    menuNote(menu, '正在刷新当前账号的模型目录…', 'pending');
    const session = sessions.get(sessionId);
    try {
      const catalog = await refreshModelCatalog(session && session.kind, session);
      if (openModelPicker && openModelPicker.el === menu) {
        renderModelPicker(menu, badgeEl, sessionId, catalog && catalog.refreshError ? {
          text: `实时目录刷新失败，已使用本地兜底：${catalog.refreshError}`,
          state: 'warning',
        } : null);
        placeMenu(menu, badgeEl);
      }
    } catch (error) {
      if (openModelPicker && openModelPicker.el === menu) {
        renderModelPicker(menu, badgeEl, sessionId, {
          text: `目录刷新失败，已使用本地兜底：${error && error.message ? error.message : String(error)}`,
          state: 'warning',
        });
      }
    }
  }

  async function waitForScreen(sessionId, predicate, label) {
    const deadline = now() + switchTimeoutMs;
    let lastScreen = '';
    while (now() < deadline) {
      lastScreen = String(getTerminalScreenText(sessionId) || '');
      const value = predicate(lastScreen);
      if (value) return { value, screen: lastScreen };
      await sleep(60);
    }
    const error = new Error(`${label}超时`);
    error.screen = lastScreen;
    throw error;
  }

  function writeTerminal(sessionId, data) {
    ipcRenderer.send('terminal-input', { sessionId, data });
  }

  async function submitSlashCommand(sessionId, command, strategy) {
    if (strategy === 'claude-inline') {
      writeTerminal(sessionId, `\x1b[200~${command}\x1b[201~`);
      await sleep(700);
    } else {
      writeTerminal(sessionId, command);
      await sleep(600);
    }
    // Text and Enter must be separate writes. Sending them in one chunk lets
    // Codex/Claude paste detection consume CR as pasted text, leaving `/model`
    // visibly stuck in the prompt instead of executing it.
    writeTerminal(sessionId, '\r');
  }

  async function switchCodexModel(sessionId, session, option) {
    if (isSessionBusy(session)) throw new Error('当前回答仍在运行，请结束后再切换模型');
    if (!terminalAcceptsModelCommand(getTerminalScreenText(sessionId), 'codex-picker')) {
      throw new Error('Codex 输入框有未发送内容或当前不在主提示符；请先处理后再切换模型');
    }
    await submitSlashCommand(sessionId, '/model', 'codex-picker');
    const modelStep = await waitForScreen(sessionId, screen => parseCodexModelPicker(screen), '等待 Codex 模型面板');
    const target = modelStep.value.entries.find(entry => entry.value.toLowerCase() === option.id.toLowerCase());
    if (!target) {
      writeTerminal(sessionId, '\x1b');
      throw new Error('Codex 原生面板未列出该模型，目录可能刚刚变化，请重新打开后重试');
    }
    writeTerminal(sessionId, pickerNavigationInput(modelStep.value.highlighted.number, target.number) + '\r');
    const effortStep = await waitForScreen(
      sessionId,
      screen => parseCodexReasoningPicker(screen, option.id),
      '等待 Codex 推理档位面板',
    );
    const effort = compatibleEffort(session.effort, effortStep.value.entries, effortStep.value.highlighted);
    const effortTarget = effortStep.value.entries.find(entry => entry.value === effort) || effortStep.value.highlighted;
    writeTerminal(sessionId, pickerNavigationInput(effortStep.value.highlighted.number, effortTarget.number) + '\r');
    await waitForScreen(sessionId, screen => {
      const escaped = option.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`Model changed to\\s+${escaped}\\s+${effortTarget.value}`, 'i').test(screen)
        && screen.toLowerCase().includes(`${option.id.toLowerCase()} ${effortTarget.value}`);
    }, '确认 Codex 模型切换');
    return { modelId: option.id, displayName: option.label, effort: effortTarget.value };
  }

  async function switchClaudeModel(sessionId, session, option) {
    if (isSessionBusy(session)) throw new Error('当前回答仍在运行，请结束后再切换模型');
    if (!terminalAcceptsModelCommand(getTerminalScreenText(sessionId), 'claude-inline')) {
      throw new Error('Claude 输入框有未发送内容或当前不在主提示符；请先处理后再切换模型');
    }
    await submitSlashCommand(sessionId, `/model ${option.id}`, 'claude-inline');
    const confirmation = await waitForScreen(sessionId, screen => {
      const current = sessions.get(sessionId);
      if (current && current.currentModel && modelSelectionMatches(current.currentModel.id, option.id)) {
        return { modelId: current.currentModel.id, displayName: current.currentModel.displayName || option.label };
      }
      const lower = String(screen || '').toLowerCase();
      const family = String(option.id).replace(/^claude-/, '').split('-')[0].replace(/\[1m\]$/i, '');
      if (/(invalid model|not available|does not have access|unknown model)/i.test(lower)) {
        const error = new Error('Claude Code 拒绝了该模型或当前账号无权限');
        error.modelRejected = true;
        throw error;
      }
      const commandEcho = `/model ${String(option.id).toLowerCase()}`;
      return lower.includes(commandEcho) && lower.includes(family.toLowerCase())
        && /(set model to|model changed|model switched|now using)/i.test(lower)
        ? { modelId: option.id, displayName: option.label }
        : null;
    }, '确认 Claude 模型切换');
    return confirmation.value;
  }

  async function confirmSwitch(sessionId, result) {
    if (typeof ipcRenderer.invoke !== 'function') return { ok: true, model: result };
    const response = await ipcRenderer.invoke('confirm-session-model-switch', {
      sessionId,
      modelId: result.modelId,
      displayName: result.displayName,
      effort: result.effort,
    });
    if (!response || response.ok !== true) {
      throw new Error(response && response.message || 'Hub 未能保存已确认的模型切换');
    }
    return response;
  }

  async function switchModel(sessionId, option, menu, badgeEl) {
    const session = sessions.get(sessionId);
    if (!session || !option || session._modelSwitchPending) return null;
    const strategy = modelSwitchStrategy(session.kind);
    if (!strategy) return null;
    session._modelSwitchPending = { id: option.id, label: option.label };
    updateActiveModelBadge();
    renderModelPicker(menu, badgeEl, sessionId, { text: `正在切换到 ${option.label}…`, state: 'pending' });
    let preferencePrepared = false;
    try {
      if (strategy === 'claude-inline' && typeof ipcRenderer.invoke === 'function') {
        const prepared = await ipcRenderer.invoke('prepare-session-model-switch', {
          sessionId,
          modelId: option.id,
        });
        if (!prepared || prepared.ok !== true) {
          throw new Error(prepared && prepared.message || '无法保护 Claude 的全局默认模型');
        }
        preferencePrepared = true;
      }
      const switched = strategy === 'codex-picker'
        ? await switchCodexModel(sessionId, session, option)
        : await switchClaudeModel(sessionId, session, option);
      const confirmed = await confirmSwitch(sessionId, switched);
      const model = confirmed.model || { id: switched.modelId, displayName: switched.displayName };
      session.currentModel = { id: model.id || switched.modelId, displayName: model.displayName || switched.displayName };
      if (switched.effort) session.effort = switched.effort;
      delete session._modelSwitchPending;
      updateActiveModelBadge();
      const preferenceWarning = confirmed.preference && confirmed.preference.restored !== true
        && confirmed.preference.status !== 'missing-snapshot';
      renderModelPicker(menu, badgeEl, sessionId, {
        text: preferenceWarning
          ? `已切换到 ${session.currentModel.displayName}，但恢复 Claude 默认模型失败：${confirmed.preference.status}`
          : `✓ 已切换到 ${session.currentModel.displayName}${confirmed.preference ? '；全局默认未改变' : ''}`,
        state: preferenceWarning ? 'warning' : 'success',
      });
      await sleep(650);
      if (openModelPicker && openModelPicker.el === menu) closeModelPicker();
      return { ok: true, model: session.currentModel, effort: switched.effort || null };
    } catch (error) {
      let cleanupWarning = '';
      if (preferencePrepared && typeof ipcRenderer.invoke === 'function') {
        try {
          const cleanup = await ipcRenderer.invoke('cancel-session-model-switch', { sessionId });
          if (cleanup && cleanup.preference && cleanup.preference.status === 'restore-failed') {
            cleanupWarning = `；同时恢复 Claude 默认模型失败：${cleanup.preference.error || 'unknown error'}`;
          }
        }
        catch (restoreError) {
          cleanupWarning = `；同时恢复 Claude 默认模型失败：${restoreError && restoreError.message ? restoreError.message : String(restoreError)}`;
          console.warn('[model-switch] Claude preference cleanup failed:', restoreError && restoreError.message);
        }
      }
      delete session._modelSwitchPending;
      updateActiveModelBadge();
      console.warn('[model-switch] failed:', error && (error.stack || error.message));
      if (strategy === 'codex-picker') writeTerminal(sessionId, '\x1b');
      if (openModelPicker && openModelPicker.el === menu) {
        renderModelPicker(menu, badgeEl, sessionId, {
          text: `切换失败：${error && error.message ? error.message : String(error)}${cleanupWarning}`,
          state: 'error',
        });
      }
      return { ok: false, error: error && error.message ? error.message : String(error) };
    }
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
    showModelPicker,
    switchModel,
  };
}

module.exports = {
  compatibleEffort,
  createModelUiController,
  modelClass,
  modelSelectionMatches,
  modelShort,
  parseCodexModelPicker,
  parseCodexReasoningPicker,
  pickerNavigationInput,
  reasoningLabelToEffort,
  terminalAcceptsModelCommand,
};
