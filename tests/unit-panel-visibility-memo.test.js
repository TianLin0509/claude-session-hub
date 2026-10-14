'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPanelVisibility } = require('../renderer/panel-visibility');

// A tiny element tree: attributes live in a Map so the key sees every change,
// and measuring is counted because that is what forces a style recalc.
function el(tag, attrs = {}, parent = null) {
  const node = {
    tagName: tag, parentElement: parent, childElementCount: 0, hidden: false, style: { display: '' },
    attrs: new Map(Object.entries(attrs)), rect: 0, offsetParentValue: null,
    get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); },
    getBoundingClientRect() { measured.count += 1; return { height: this.rect }; },
    get offsetParent() { measured.count += 1; return this.offsetParentValue; },
    ownerDocument: doc,
  };
  return node;
}
const measured = { count: 0 };
const doc = { head: { childElementCount: 50 } };
const win = { innerWidth: 1720, innerHeight: 926 };

function tree() {
  const html = el('HTML', { class: 'hub-app', 'data-theme': 'codex' });
  const body = el('BODY', { class: '' }, html);
  const panel = el('DIV', { id: 'study-panel' }, body);
  return { html, body, panel };
}

test('reuses the answer while nothing that decides visibility changed', () => {
  measured.count = 0;
  const visible = createPanelVisibility({ win, env: {} });
  const { panel } = tree();
  assert.equal(visible(panel), false);
  const after = measured.count;
  for (let i = 0; i < 10; i++) assert.equal(visible(panel), false);
  assert.equal(measured.count, after, 'no further layout reads');
});

test('measures again after a class, attribute or inline style change anywhere up the chain', () => {
  measured.count = 0;
  const visible = createPanelVisibility({ win, env: {} });
  const { body, panel } = tree();
  assert.equal(visible(panel), false);
  body.attrs.set('class', 'writing-open');
  panel.offsetParentValue = body;
  assert.equal(visible(panel), true, 'ancestor class change is seen');
  panel.attrs.set('style', 'display: grid');
  panel.offsetParentValue = null;
  assert.equal(visible(panel), false, 'own inline style change is seen');
});

test('the viewport, Hub stylesheets and first content are part of the key', () => {
  const visible = createPanelVisibility({ win, env: {} });
  const { panel } = tree();
  panel.offsetParentValue = null;
  assert.equal(visible(panel), false);
  panel.offsetParentValue = {};
  win.innerWidth = 800;
  assert.equal(visible(panel), true, 'resize');
  panel.offsetParentValue = null;
  doc.head.childElementCount = 51;
  assert.equal(visible(panel), false, 'stylesheet added to <head>');
  panel.rect = 20;
  panel.childElementCount = 1;
  assert.equal(visible(panel), true, 'empty fixed panel gains content');
  win.innerWidth = 1720; doc.head.childElementCount = 50;
});

test('hidden and display:none answer without measuring; the kill switch always measures', () => {
  measured.count = 0;
  const visible = createPanelVisibility({ win, env: {} });
  const { panel } = tree();
  panel.hidden = true;
  assert.equal(visible(panel), false);
  panel.hidden = false; panel.style.display = 'none';
  assert.equal(visible(panel), false);
  assert.equal(measured.count, 0);
  assert.equal(visible(null), false);

  const always = createPanelVisibility({ win, env: { HUB_DISABLE_PANEL_VISIBILITY_MEMO: '1' } });
  panel.style.display = '';
  always(panel); always(panel);
  assert.equal(measured.count, 4, 'offsetParent and height read on each call');
});

test('renderer keeps panelIsVisible hoisted and routes it through the memo', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.match(src, /function panelIsVisible\(el\) \{\s*panelIsVisible\.check \|\|= require\('\.\/panel-visibility'\)\.createPanelVisibility/);
});
