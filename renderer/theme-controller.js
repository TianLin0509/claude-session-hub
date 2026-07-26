'use strict';

const XTERM_THEMES = {
  default: {
    background: '#0d1117', foreground: '#f0f6fc', cursor: '#58a6ff',
    cursorAccent: '#0d1117', selectionBackground: 'rgba(88, 166, 255, 0.3)',
    black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
    blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39d353', white: '#f0f6fc',
    brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364',
    brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
    brightCyan: '#56d364', brightWhite: '#ffffff',
  },
};

function createThemeController({ document, terminalCache, openConfigModal }) {
  if (!document) throw new Error('document is required');
  if (!terminalCache) throw new Error('terminalCache is required');
  if (typeof openConfigModal !== 'function') throw new Error('openConfigModal is required');

  function applyTheme() {
    for (const [, cached] of terminalCache) {
      cached.terminal.options.theme = XTERM_THEMES.default;
    }
  }

  function init() {
    applyTheme();

    const optionsBtn = document.getElementById('btn-options');
    const optionsMenu = document.getElementById('options-menu');
    if (!optionsBtn || !optionsMenu) return;

    optionsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      optionsMenu.style.display = optionsMenu.style.display === 'none' ? 'block' : 'none';
    });

    document.addEventListener('mousedown', (e) => {
      if (!optionsBtn.contains(e.target) && !optionsMenu.contains(e.target)) {
        optionsMenu.style.display = 'none';
      }
    });

    optionsMenu.addEventListener('mousedown', (e) => {
      if (e.target === optionsMenu) optionsMenu.style.display = 'none';
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && optionsMenu.style.display !== 'none') {
        optionsMenu.style.display = 'none';
      }
    });

    const settingsItem = document.getElementById('options-settings');
    if (settingsItem) {
      settingsItem.addEventListener('click', async (e) => {
        e.stopPropagation();
        optionsMenu.style.display = 'none';
        openConfigModal();
      });
    }
  }

  init();
  return { applyTheme, init };
}

module.exports = { XTERM_THEMES, createThemeController };
