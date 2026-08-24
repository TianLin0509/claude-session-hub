'use strict';

const { ipcRenderer } = require('electron');

window.addEventListener('keydown', (event) => {
  if (!event.isTrusted) return;
  const key = String(event.key || '').toLowerCase();
  if (event.key === 'F3') {
    event.preventDefault();
    event.stopImmediatePropagation();
    ipcRenderer.sendToHost('preview-shortcut', 'find-next', event.shiftKey ? -1 : 1);
    return;
  }
  if (event.key === 'Escape') {
    ipcRenderer.sendToHost('preview-shortcut', 'escape');
    return;
  }
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
  const action = key === 'f' ? 'find' : key === 'o' ? 'open-path' : null;
  if (!action) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  ipcRenderer.sendToHost('preview-shortcut', action);
}, true);
