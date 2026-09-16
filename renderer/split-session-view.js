'use strict';

const { displayTurns } = require('../core/conversation-display');
const { createTurnCardRenderer } = require('./turn-card-renderer');
const { createCardFollowScroll } = require('./card-follow-scroll');

function createSplitSessionView({ document: doc, window: win, sessionId, panel, services: s, rendererOptions }) {
  const state = { _sessionTurns: new Map() };
  let disposed = false, visible = true, busy = false, dirty = false, timer = null;
  let mode = s.initialMode(), limit = 8, hydrated = false;
  const overlay = doc.createElement('div'); overlay.className = 'msg-overlay';
  overlay.dataset.sessionId = sessionId;
  const status = doc.createElement('div'); status.className = 'split-history-status'; status.hidden = true; status.setAttribute('role', 'status');
  const jump = doc.createElement('button'); jump.className = 'split-jump-latest';
  panel.append(overlay, status, jump);
  const follow = createCardFollowScroll({ element: overlay, window: win, document: doc, button: jump });
  follow.activate(sessionId, { force: true });
  const renderer = createTurnCardRenderer({ ...rendererOptions, document: doc, window: win,
    root: panel, container: overlay, state, getActiveSessionId: () => sessionId });
  const multiBar = doc.createElement('div'); multiBar.className = 'card-multi-select-bar'; multiBar.hidden = true;
  multiBar.innerHTML = '<span class="cms-count"></span><button class="cms-btn" data-multi="all">全选</button><button class="cms-btn cms-primary" data-multi="copy">一键复制</button><button class="cms-btn cms-exit" data-multi="exit">退出多选</button>';
  panel.append(multiBar);
  const multiSelect = require('./card-multi-select').createCardMultiSelectController({ document: doc, window: win,
    navigator: rendererOptions.navigator, container: overlay,
    elements: { bar: multiBar, count: multiBar.querySelector('.cms-count'), all: multiBar.querySelector('[data-multi="all"]'), copy: multiBar.querySelector('[data-multi="copy"]'), exit: multiBar.querySelector('[data-multi="exit"]') },
    getActiveSessionId: () => sessionId, getTurnById: id => state._sessionTurns.get(id),
    extractVisibleCardText: require('./visible-card-text').extractVisibleCardText,
  });
  if (!multiSelect.init()) throw new Error('右屏多选控制器初始化失败');
  const navRoot = doc.createElement('nav'); navRoot.className = 'card-question-nav'; navRoot.setAttribute('aria-label', '右屏问题导航'); panel.append(navRoot);
  const navigation = require('./card-question-navigator').createCardQuestionNavigator({ document: doc, window: win,
    overlay, root: navRoot, getCurrentView: () => visible ? mode : 'hidden', getActiveSessionId: () => sessionId,
    getTurnById: id => state._sessionTurns.get(id), requestAnimationFrame: cb => win.requestAnimationFrame(cb), cancelAnimationFrame: id => win.cancelAnimationFrame(id),
  });
  if (!navigation.init()) throw new Error('右屏问题导航初始化失败');
  const terminal = s.mountTerminal(panel, {
    history: () => { follow.follow(); schedule(); },
    optimistic: (text, kind, options) => renderer.mountOptimisticUserCard(sessionId, text, kind, options),
    isCard: () => mode === 'card',
  });
  function updateStatus() {
    if (disposed) return;
    terminal.updateStatus();
  }
  function notice(message) { status.textContent = message; status.hidden = !message; }
  async function refresh(older = false) {
    if (disposed || !visible || mode !== 'card') { dirty = true; return; }
    if (busy) { dirty = true; return; }
    busy = true; dirty = false;
    const capture = follow.capture();
    const requestedLimit = older ? limit + 24 : limit;
    try {
      const session = s.session();
      const result = await s.parse({ hubSessionId: sessionId, kind: session.kind,
        ccSessionId: session.ccSessionId, transcriptPath: session.transcriptPath,
        opts: { limit: requestedLimit + 1, fromTail: true, includeBranchHistory: true } });
      if (disposed) return;
      const turns = displayTurns(result?.turns || []);
      if (result?.error && !turns.length) {
        // Keep all previously rendered records on transient source failures.
        notice('历史读取失败：' + result.error);
        return;
      }
      notice(result?.error ? '历史读取不完整：' + result.error : '');
      if (!hydrated) overlay.replaceChildren();
      const shown = turns.slice(-requestedLimit);
      const staging = doc.createElement('div');
      for (const turn of shown) {
        const exists = state._sessionTurns.has(turn.id);
        renderer.mountSessionTurnCard(sessionId, turn, { kind: session.kind, container: older && !exists ? staging : overlay });
      }
      if (staging.children.length) overlay.prepend(...staging.children);
      overlay.querySelector(':scope > .split-load-older')?.remove();
      if (turns.length > requestedLimit || (result?.turns?.length || 0) > requestedLimit) {
        const more = doc.createElement('button'); more.className = 'split-load-older'; more.textContent = '↑ 加载更早对话';
        more.addEventListener('click', () => { more.disabled = true; void refresh(true).finally(() => { more.disabled = false; }); });
        overlay.prepend(more);
      }
      if (!turns.length && !hydrated) overlay.innerHTML = s.welcome(session);
      else if (turns.length) overlay.querySelector('.session-welcome')?.remove();
      limit = requestedLimit; hydrated = true;
      follow.restore(capture);
      follow.request();
    } catch (error) {
      if (!disposed) notice('历史读取失败：' + error.message);
    } finally {
      busy = false;
      if (!disposed && dirty) schedule();
    }
  }
  function schedule() {
    if (disposed) return;
    dirty = true; updateStatus();
    if (timer || busy || !visible || mode !== 'card') return;
    timer = setTimeout(() => { timer = null; void refresh(); }, 150);
  }
  function applyMode() {
    multiSelect.setVisible(mode === 'card' && visible);
    navigation.scheduleRefresh();
    panel.classList.toggle('card-view-active', mode === 'card');
    overlay.classList.toggle('hidden', mode !== 'card');
    if (mode !== 'card') { jump.hidden = true; status.hidden = true; }
    terminal.setMode(mode, visible);
    if (mode === 'card') schedule();
  }
  const events = ['codex-content-updated', 'native-agent-item', 'terminal-data', 'turn-complete-event',
    'turn-started-event', 'turn-failed-event', 'turn-aborted-event', 'session-updated', 'session-meta-updated',
    'status-event', 'session-usage-updated', 'agent-usage', 'hook-event'];
  const listeners = events.map(channel => {
    const listener = (_event, payload) => {
      const id = payload?.sessionId || payload?.hubSessionId || payload?.session?.id;
      if (id === sessionId) schedule();
    };
    s.ipc.on(channel, listener); return [channel, listener];
  });
  // A visible error has a bounded, explicit retry action.
  status.addEventListener('click', schedule); status.title = '点击重新读取';
  applyMode();
  return {
    sessionId, renderer, turns: state._sessionTurns, overlay, multiSelect,
    focus: () => panel.querySelector('.floating-input-box')?.focus(),
    resize: () => terminal.resize(), updateStatus,
    schedule,
    mode: () => mode,
    toggleMode() { mode = mode === 'card' ? 'pty' : 'card'; applyMode(); },
    setVisible(value) {
      if (visible === value) return;
      visible = value; terminal.setMode(mode, visible);
      multiSelect.setVisible(visible && mode === 'card');
      navigation.scheduleRefresh();
      if (visible && dirty) schedule();
    },
    dispose() {
      disposed = true; clearTimeout(timer);
      for (const [channel, listener] of listeners) s.ipc.removeListener(channel, listener);
      navigation.dispose(); multiSelect.destroy(); renderer.dispose(); follow.dispose(); terminal.dispose(); panel.replaceChildren();
    },
  };
}
module.exports = { createSplitSessionView };
