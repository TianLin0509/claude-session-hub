'use strict';

const icons = Object.freeze({
  'btn-home': 'home',
  'btn-research': 'research',
  'btn-study': 'learning',
  'btn-ran': 'board',
  'btn-rail-memo': 'memo',
  'btn-rail-memory': 'memory',
  'btn-rail-capabilities': 'tools',
  'btn-rail-accounts': 'accounts',
  'btn-writing': 'writing',
  'btn-hub-restart': 'restart',
  'btn-theme': 'theme',
  'btn-options': 'options',
});

function installNavIcons(doc = globalThis.document, ImageType = globalThis.Image) {
  if (!doc || typeof ImageType !== 'function') return;
  for (const [id, name] of Object.entries(icons)) {
    const button = doc.getElementById(id);
    if (!button) continue;
    const image = new ImageType();
    image.onload = () => button.classList.add('nav-icon-ready');
    image.src = new URL(`assets/navigation/pro-${name}.webp`, doc.baseURI).href;
  }
}

module.exports = { installNavIcons };
