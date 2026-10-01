'use strict';

function installSessionFirstNavigation(doc = globalThis.document) {
  const app = doc?.getElementById('app-container');
  const trigger = doc?.getElementById('rail-edge-trigger');
  const pin = doc?.getElementById('rail-pin');
  if (!app || !trigger || !pin) return;

  require('./navigation-artwork').installNavigationArtwork(doc);
  // Reserve a real navigation column and preserve the user's display choice.
  const storage = doc.defaultView?.localStorage;
  const key = 'hub.navigationExpanded';
  const setPinned = (pinned, persist = true) => {
    app.classList.toggle('rail-pinned', pinned);
    pin.setAttribute('aria-pressed', String(pinned));
    pin.setAttribute('aria-label', pinned ? '收起功能导航' : '展开功能导航');
    pin.title = pinned ? '收起功能导航' : '展开功能导航';
    trigger.setAttribute('aria-expanded', String(pinned));
    if (persist) { try { storage?.setItem(key, String(pinned)); } catch {} }
    doc.dispatchEvent(new doc.defaultView.Event('hub:navigation-layout'));
  };
  let expanded = true;
  try { expanded = storage?.getItem(key) !== 'false'; } catch {}
  setPinned(expanded, false);
  trigger.addEventListener('click', () => setPinned(true));
  pin.addEventListener('click', () => setPinned(!app.classList.contains('rail-pinned')));
}

module.exports = { installSessionFirstNavigation };
