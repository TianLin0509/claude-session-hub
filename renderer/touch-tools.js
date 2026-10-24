'use strict';

const { readSelectedText } = require('./clipboard-controller');

function initTouchTools({ document, window, copyText, expandText, ipcRenderer, getTerminal, pasteTerminal }) {
  const root = document.getElementById('touch-tools');
  const toggle = document.getElementById('btn-touch-tools');
  const panel = document.getElementById('touch-tools-panel');
  const status = panel.querySelector('[role="status"]');
  let saved = null;
  let busy = false;
  function remember(target = document.activeElement) {
    if (root.contains(target)) return;
    const selection = window.getSelection();
    const terminal = target?.closest?.('.xterm') ? getTerminal(target) : null;
    saved = { target, terminal, text: terminal ? terminal.getSelection() : readSelectedText(target, window),
      start: target?.selectionStart, end: target?.selectionEnd,
      range: selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null };
  }
  function open() { if (panel.hidden) { remember(); status.textContent = ''; } panel.hidden = false; toggle.setAttribute('aria-expanded', 'true'); }
  function close() { panel.hidden = true; toggle.setAttribute('aria-expanded', 'false'); }
  function restore() {
    if (!saved?.target?.isConnected) throw new Error('请先点击要操作的输入位置');
    saved.target.focus({ preventScroll: true });
    if (Number.isInteger(saved.start)) saved.target.setSelectionRange(saved.start, saved.end);
    else if (saved.range && saved.range.startContainer.isConnected) {
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(saved.range);
    }
  }
  root.addEventListener('pointerdown', event => { if (panel.hidden) remember(); event.preventDefault(); });
  document.addEventListener('focusout', event => {
    if (!root.contains(event.target) && root.contains(event.relatedTarget)) remember(event.target);
  });
  toggle.addEventListener('click', () => panel.hidden ? open() : close());
  root.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') open(); });
  document.addEventListener('pointerdown', event => { if (!root.contains(event.target)) close(); }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) { close(); toggle.focus(); event.stopPropagation(); } }, true);
  panel.addEventListener('click', async event => {
    const action = event.target.closest('[data-touch-action]')?.dataset.touchAction;
    if (!action || busy) return;
    busy = true;
    status.textContent = '正在处理…';
    try {
      if (action === 'copy') {
        const text = expandText(saved?.text || '');
        if (!text) throw new Error('请先选中文字，再点复制');
        const result = await copyText(text, { source: 'touch-tools' });
        if (!result.ok) throw new Error('复制未成功，请重试');
        status.textContent = `已复制 ${result.length} 字`;
      } else if (action === 'screenshot') {
        close();
        await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
        const result = await ipcRenderer.invoke('touch-tools:screenshot');
        open();
        if (!result.ok) throw new Error(result.error);
        status.textContent = '全屏截图已复制，可粘贴到输入框';
      } else {
        restore();
        if (action === 'paste') {
          if (!saved.terminal && !saved.target.matches('input:not([readonly]):not([disabled]), textarea:not([readonly]):not([disabled]), [contenteditable="true"]')) throw new Error('请先点击要粘贴的输入框');
          if (saved.terminal) await pasteTerminal(saved.terminal);
          else await ipcRenderer.invoke('touch-tools:paste');
          close();
        } else if (action === 'select-all') {
          if (saved.terminal) saved.terminal.selectAll();
          else if (typeof saved.target.select === 'function') saved.target.select();
          else document.execCommand('selectAll');
          remember(); status.textContent = '已全选，可点击复制';
        }
      }
    } catch (error) { open(); status.textContent = error.message; }
    finally { busy = false; }
  });
}
module.exports = { initTouchTools };
