'use strict';

const { installNavIcons } = require('./nav-icon-loader.js');

function installSessionFirstNavigation(doc = globalThis.document) {
  const app = doc?.getElementById('app-container');
  const trigger = doc?.getElementById('rail-edge-trigger');
  const pin = doc?.getElementById('rail-pin');
  if (!app || !trigger || !pin) return;

  installNavIcons(doc, doc.defaultView?.Image);
  const setPinned = pinned => {
    app.classList.toggle('rail-pinned', pinned);
    pin.setAttribute('aria-pressed', String(pinned));
    pin.setAttribute('aria-label', pinned ? '取消固定功能导航' : '固定功能导航');
    pin.title = pinned ? '取消固定功能导航' : '固定功能导航';
    trigger.setAttribute('aria-expanded', String(pinned));
  };
  trigger.addEventListener('click', () => setPinned(true));
  pin.addEventListener('click', () => setPinned(!app.classList.contains('rail-pinned')));
  doc.addEventListener('keydown', event => {
    if (event.key === 'Escape' && app.classList.contains('rail-pinned')) setPinned(false);
  });
}

module.exports = { installSessionFirstNavigation };
