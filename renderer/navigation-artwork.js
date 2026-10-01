'use strict';

// A single generated family is displayed through CSS viewports. The original
// image is preserved; the existing SVGs remain the fallback and other themes.
const SIZE = 1254, CROP = 330, DISPLAY = 28;
const ICONS = [
  ['btn-home',220,228], ['btn-assistant',626,221], ['btn-research',1036,223],
  ['btn-study',220,630], ['btn-ran',627,626], ['btn-rail-memo',1028,623],
  ['btn-rail-capabilities',221,1003], ['btn-rail-accounts',626,1008], ['btn-writing',1030,1004],
];
function installNavigationArtwork(doc = globalThis.document) {
  if (!doc?.defaultView?.Image) return;
  const scale = DISPLAY / CROP;
  for (const [id,x,y] of ICONS) {
    const host = doc.getElementById(id)?.querySelector('.btn-icon');
    if (!host || host.querySelector('.nav-artwork')) continue;
    const artwork = doc.createElement('span');
    artwork.className = 'nav-artwork';
    artwork.setAttribute('aria-hidden','true');
    artwork.style.backgroundSize = `${SIZE * scale}px ${SIZE * scale}px`;
    artwork.style.backgroundPosition = `${DISPLAY/2 - x*scale}px ${DISPLAY/2 - y*scale}px`;
    host.appendChild(artwork);
  }
  const image = new doc.defaultView.Image();
  image.onload = () => doc.documentElement.classList.add('navigation-artwork-ready');
  image.onerror = () => doc.documentElement.classList.remove('navigation-artwork-ready');
  image.src = 'assets/navigation/coldwhite-enamel-v1.png';
}
module.exports = { installNavigationArtwork };
