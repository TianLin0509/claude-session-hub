'use strict';

const ALLOWED_ROUND_COUNTS = new Set([1, 2, 3]);

function normalizeRoundCount(value) {
  const count = Number.parseInt(value, 10);
  return ALLOWED_ROUND_COUNTS.has(count) ? count : 1;
}

function normalizeCopiedText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function assistantSender(entry = {}) {
  const kindLabels = {
    claude: 'Claude',
    codex: 'Codex',
    deepseek: 'DeepSeek',
    gemini: 'Gemini',
    kimi: 'Kimi',
  };
  const baseKind = String(entry.kind || '')
    .toLowerCase()
    .replace(/-resume$/, '')
    .replace(/-api$/, '');
  const kind = kindLabels[baseKind] || '';
  const model = String(entry.model || '').trim();
  const details = [];
  if (kind) details.push(kind);
  if (model && !details.some(item => item.toLowerCase() === model.toLowerCase())) details.push(model);
  return details.length ? `AI（${details.join(' · ')}）` : 'AI';
}

// One round is one user question plus every assistant card that follows it up
// to the next user question. Incomplete trailing questions are intentionally
// omitted: "copy 1 round" must always contain both sender sides.
function collectCompleteConversationRounds(entries) {
  const rounds = [];
  let current = null;

  for (const raw of Array.isArray(entries) ? entries : []) {
    if (!raw || (raw.role !== 'user' && raw.role !== 'assistant')) continue;
    const entry = { ...raw, text: normalizeCopiedText(raw.text) };
    if (!entry.text) continue;

    if (entry.role === 'user') {
      if (current && current.user && current.assistants.length) rounds.push(current);
      current = { user: entry, assistants: [] };
      continue;
    }

    if (!current || !current.user) continue;
    const sender = assistantSender(entry);
    const previous = current.assistants[current.assistants.length - 1];
    if (previous && previous.text === entry.text && assistantSender(previous) === sender) continue;
    current.assistants.push(entry);
  }

  if (current && current.user && current.assistants.length) rounds.push(current);
  return rounds;
}

function formatRecentConversation(entries, requestedCount) {
  const count = normalizeRoundCount(requestedCount);
  const rounds = collectCompleteConversationRounds(entries);
  const selected = rounds.slice(-count);
  const text = selected.map((round, index) => {
    const blocks = [
      `===== 第 ${index + 1} 轮 =====`,
      '我：',
      round.user.text,
    ];
    for (const reply of round.assistants) {
      blocks.push('', `${assistantSender(reply)}：`, reply.text);
    }
    return blocks.join('\n');
  }).join('\n\n');

  return {
    text,
    copiedRounds: selected.length,
    availableRounds: rounds.length,
    requestedRounds: count,
  };
}

function createRecentTurnCopyController(options = {}) {
  const doc = options.document || (typeof document !== 'undefined' ? document : null);
  const win = options.window || (typeof window !== 'undefined' ? window : null);
  const nav = options.navigator || (win && win.navigator) || {};
  const storage = options.storage || (win && win.localStorage) || null;
  const getActiveSessionId = typeof options.getActiveSessionId === 'function'
    ? options.getActiveSessionId
    : () => null;
  const getTurnById = typeof options.getTurnById === 'function'
    ? options.getTurnById
    : (turnId) => win && win._sessionTurns && win._sessionTurns.get(turnId);
  const extractVisibleCardText = typeof options.extractVisibleCardText === 'function'
    ? options.extractVisibleCardText
    : (root) => String((root && (root.innerText || root.textContent)) || '').trim();
  const storageKey = options.storageKey || 'hub-card-copy-round-count';

  let root = null;
  let countSelect = null;
  let copyButton = null;
  let resetTimer = null;

  function collectVisibleEntries() {
    const overlay = doc && doc.getElementById('msg-overlay');
    const activeSessionId = String(getActiveSessionId() || '');
    if (!overlay || !activeSessionId) return [];

    return Array.from(overlay.querySelectorAll(':scope > .turn-card[data-turn-id]'))
      .map(card => {
        const cardSessionId = String((card.dataset && card.dataset.sessionId) || '');
        if (cardSessionId && cardSessionId !== activeSessionId) return null;
        const turn = getTurnById(card.dataset.turnId);
        if (!turn || (turn.role !== 'user' && turn.role !== 'assistant')) return null;
        return {
          role: turn.role,
          text: extractVisibleCardText(card.querySelector('.turn-body')),
          kind: turn.kind,
          model: turn.model,
        };
      })
      .filter(Boolean);
  }

  function selectedCount() {
    return normalizeRoundCount(countSelect && countSelect.value);
  }

  function refreshAccessibleLabel() {
    if (!copyButton) return;
    copyButton.title = `按“我 / AI”角色复制最近 ${selectedCount()} 个完整问答轮次（纯文本）`;
  }

  function restoreButton() {
    if (!copyButton) return;
    copyButton.textContent = copyButton.dataset.defaultLabel || '复制对话';
    copyButton.classList.remove('copied', 'copy-empty', 'copy-error');
  }

  function showFeedback(label, className) {
    if (!copyButton) return;
    if (resetTimer) clearTimeout(resetTimer);
    copyButton.textContent = label;
    copyButton.classList.remove('copied', 'copy-empty', 'copy-error');
    if (className) copyButton.classList.add(className);
    resetTimer = setTimeout(restoreButton, 1800);
  }

  async function copyRecent() {
    const result = formatRecentConversation(collectVisibleEntries(), selectedCount());
    if (!result.text) {
      showFeedback('暂无完整轮次', 'copy-empty');
      return result;
    }
    try {
      if (!nav.clipboard || typeof nav.clipboard.writeText !== 'function') {
        throw new Error('clipboard unavailable');
      }
      await Promise.resolve(nav.clipboard.writeText(result.text));
      showFeedback(`已复制 ${result.copiedRounds} 轮`, 'copied');
      return result;
    } catch (error) {
      showFeedback('复制失败', 'copy-error');
      return { ...result, error: error && error.message ? error.message : String(error) };
    }
  }

  function onCountChanged() {
    const count = selectedCount();
    if (countSelect) countSelect.value = String(count);
    try { if (storage) storage.setItem(storageKey, String(count)); } catch {}
    refreshAccessibleLabel();
  }

  function init() {
    if (!doc) return false;
    root = doc.getElementById('recent-turn-copy');
    countSelect = doc.getElementById('recent-turn-copy-count');
    copyButton = doc.getElementById('recent-turn-copy-button');
    if (!root || !countSelect || !copyButton) return false;
    copyButton.dataset.defaultLabel = copyButton.textContent || '复制对话';
    try {
      const saved = normalizeRoundCount(storage && storage.getItem(storageKey));
      countSelect.value = String(saved);
    } catch {
      countSelect.value = '1';
    }
    countSelect.addEventListener('change', onCountChanged);
    copyButton.addEventListener('click', copyRecent);
    refreshAccessibleLabel();
    return true;
  }

  function setVisible(visible) {
    if (root) root.hidden = !visible;
  }

  function destroy() {
    if (resetTimer) clearTimeout(resetTimer);
    if (countSelect) countSelect.removeEventListener('change', onCountChanged);
    if (copyButton) copyButton.removeEventListener('click', copyRecent);
  }

  return {
    collectVisibleEntries,
    copyRecent,
    destroy,
    init,
    setVisible,
  };
}

module.exports = {
  assistantSender,
  collectCompleteConversationRounds,
  createRecentTurnCopyController,
  formatRecentConversation,
  normalizeRoundCount,
};
