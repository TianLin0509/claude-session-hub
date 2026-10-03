'use strict';

// Move the existing controls, retaining their listeners and per-member state.
function mountGroupComposerPopovers(rail) {
  const document = rail.ownerDocument, window = document.defaultView;
  const entries = [];
  function close(restoreFocus = false) {
    for (const entry of entries) {
      const wasOpen = !entry.panel.hidden;
      entry.panel.hidden = true;
      entry.button.setAttribute('aria-expanded', 'false');
      if (restoreFocus && wasOpen) entry.button.focus();
    }
  }
  function place(entry) {
    const r = entry.button.getBoundingClientRect(), panel = entry.panel;
    const width = Math.min(480, window.innerWidth - 16);
    panel.style.width = width + 'px';
    panel.style.maxHeight = Math.max(100, r.top - 16) + 'px';
    panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) + 'px';
    panel.style.bottom = Math.max(8, window.innerHeight - r.top + 6) + 'px';
  }
  function add(content, key, label) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'composer-chip mr-composer-menu-trigger';
    button.dataset.groupMenu = key; button.textContent = label;
    button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-controls', 'mr-composer-menu-' + key);
    const panel = document.createElement('section');
    panel.id = 'mr-composer-menu-' + key; panel.className = 'mr-composer-menu'; panel.hidden = true;
    panel.setAttribute('aria-label', label);
    const heading = document.createElement('header'), title = document.createElement('strong'), dismiss = document.createElement('button');
    title.textContent = label; dismiss.type = 'button'; dismiss.textContent = '×'; dismiss.setAttribute('aria-label', '关闭' + label);
    heading.append(title, dismiss); panel.append(heading, content); rail.append(button, panel);
    const entry = { button, panel }; entries.push(entry);
    button.addEventListener('click', () => {
      const opening = panel.hidden; close();
      if (opening) { panel.hidden = false; button.setAttribute('aria-expanded', 'true'); place(entry); }
    });
    dismiss.addEventListener('click', () => close(true));
    return entry;
  }
  add(rail.querySelector('.fi-bridge-toolbar'), 'tools', '工具');
  const members = add(rail.querySelector('.mr-input-tuning-members'), 'members', 'AI 设置');
  document.addEventListener('mousedown', event => {
    if (!rail.contains(event.target) && !event.target.closest('.model-picker-menu')) close();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !document.querySelector('.model-picker-menu')) close(true);
  });
  window.addEventListener('resize', () => entries.filter(e => !e.panel.hidden).forEach(place));
  let meetingId;
  return {
    update(id, count) {
      if (meetingId !== id) { close(); meetingId = id; }
      members.button.textContent = 'AI 设置 · ' + count;
      members.button.title = '分别设置每位 AI 的模型、推理、速度和上下文';
    },
    close,
  };
}
module.exports = { mountGroupComposerPopovers };
