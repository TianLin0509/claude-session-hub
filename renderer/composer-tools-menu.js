'use strict';

// Move existing secondary controls rather than copying their event handlers.
function mountComposerToolsMenu({ composer, tuningControls, bridgeToolbar }) {
  const doc=composer.ownerDocument;
  const actions=[...bridgeToolbar.querySelectorAll('.fi-bridge-pull,.fi-bridge-fork')];
  if(!actions.length)return {dispose(){}};
  const toggle=doc.createElement('button'); toggle.type='button';
  toggle.className='composer-chip composer-tools-toggle'; toggle.textContent='工具';
  toggle.setAttribute('aria-expanded','false'); toggle.title='会话工具：公司拉取与分支';
  const menu=doc.createElement('div');menu.className='composer-tools-popover';menu.hidden=true;
  menu.setAttribute('role','group');menu.setAttribute('aria-label','会话工具');menu.append(...actions);
  composer.append(menu);tuningControls.prepend(toggle);
  const close=()=>{menu.hidden=true;toggle.setAttribute('aria-expanded','false');};
  toggle.addEventListener('click',()=>{const open=menu.hidden;menu.hidden=!open;toggle.setAttribute('aria-expanded',String(open));});
  const outside=e=>{if(!menu.hidden&&!menu.contains(e.target)&&!toggle.contains(e.target))close();};
  const key=e=>{if(!menu.hidden&&e.key==='Escape'){e.preventDefault();e.stopPropagation();close();toggle.focus();}};
  doc.addEventListener('pointerdown',outside,true);composer.addEventListener('keydown',key);
  return {dispose(){doc.removeEventListener('pointerdown',outside,true);composer.removeEventListener('keydown',key);}};
}
module.exports={mountComposerToolsMenu};
