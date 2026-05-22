const test = require('node:test');
const assert = require('node:assert');
const { createShellController } = require('../renderer/shell-controller.js');

function makeElement() {
  return {
    style: {},
    innerHTML: 'content',
    classList: {
      values: new Set(),
      add(name) { this.values.add(name); },
      contains(name) { return this.values.has(name); },
    },
  };
}

test('escapeToHome hides overlays, clears active ids, restores launcher shell', () => {
  const byId = new Map([
    ['options-menu', makeElement()],
    ['theme-picker-popup', makeElement()],
    ['resume-modal', makeElement()],
    ['search-modal', makeElement()],
    ['msg-overlay', makeElement()],
  ]);
  const modalOverlay = makeElement();
  const terminalPanelEl = makeElement();
  let inserted = null;
  terminalPanelEl.insertBefore = (el) => { inserted = el; };
  const emptyStateEl = makeElement();
  const terminalCache = new Map([['s1', { container: makeElement() }]]);
  const calls = [];

  const controller = createShellController({
    document: {
      getElementById: (id) => byId.get(id) || null,
      querySelectorAll: () => [modalOverlay],
    },
    menuEl: makeElement(),
    resumeMenuEl: makeElement(),
    contextMenuEl: makeElement(),
    termCtxMenuEl: makeElement(),
    terminalCache,
    terminalPanelEl,
    emptyStateEl,
    closeTerminalSearch: () => calls.push('closeSearch'),
    closePreviewPanel: () => calls.push('closePreview'),
    closeMeetingPanel: () => calls.push('closeMeeting'),
    setActiveSessionId: (value) => calls.push(['session', value]),
    setActiveMeetingId: (value) => calls.push(['meeting', value]),
    applySidebarCollapsed: (value) => calls.push(['sidebar', value]),
    preserveAndClearTerminalPanel: () => calls.push('preserve'),
    applyViewMode: (mode) => calls.push(['view', mode]),
    renderSessionList: () => calls.push('render'),
  });

  controller.escapeToHome();

  assert.strictEqual(byId.get('options-menu').style.display, 'none');
  assert.strictEqual(byId.get('resume-modal').style.display, 'none');
  assert.strictEqual(modalOverlay.classList.contains('hidden'), true);
  assert.strictEqual(terminalCache.get('s1').container.style.display, 'none');
  assert.strictEqual(inserted, emptyStateEl);
  assert.deepStrictEqual(calls, [
    'closeSearch',
    'closePreview',
    'closeMeeting',
    ['session', null],
    ['meeting', null],
    ['sidebar', false],
    'preserve',
    ['view', 'pty'],
    'render',
  ]);
});
