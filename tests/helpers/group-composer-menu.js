'use strict';
// Follow the user path before clicking a control now housed in a group popup.
async function revealGroupComposerControl(client, selector, click) {
  const key = await client.eval(`(()=>{const panel=document.querySelector(${JSON.stringify(selector)})?.closest('.mr-composer-menu');return panel?.hidden?panel.id.replace('mr-composer-menu-',''):null})()`);
  if (key) await click('[data-group-menu="' + key + '"]');
}
module.exports = { revealGroupComposerControl };
