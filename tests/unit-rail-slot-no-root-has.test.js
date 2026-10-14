'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = path.join(__dirname, '..', 'renderer');
const cssFiles = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.css')) cssFiles.push(full);
  }
})(renderer);

// `:root:has(<anything>)` / `html:has(...)` / `body:has(...)` outside a media query make
// the browser re-check the whole page on every inserted node: one session switch
// restyled <html> ~400 times (2026-10-14). The rail slot reads mirrored classes.
test('no stylesheet asks the root element whether the app container has a rail class', () => {
  const offenders = [];
  for (const file of cssFiles) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [i, line] of text.split(/\r?\n/).entries()) {
      if (/:root[^{,]*:has\(\s*\.app-container/.test(line)) offenders.push(`${path.relative(renderer, file)}:${i + 1}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('rail-slot rules keep their cascade weight with the mirrored <html> classes', () => {
  const read = name => fs.readFileSync(path.join(renderer, 'styles', name), 'utf8');
  assert.match(read('coldwhite-workspace.css'), /:root\.hub-app\.hub-rail-unpinned \{ --hub-rail-slot:56px; \}/);
  assert.match(read('compact-status-shell.css'), /:root\.hub-app\.hub-rail-unpinned \{ --hub-rail-slot:44px; \}/);
  assert.match(read('display-presets.css'), /:root\[data-display-mode\]\.hub-app\.hub-rail-hidden \{ --hub-rail-slot:0px; \}/);
  assert.match(read('editor-workspace.css'), /:root\.hub-app\.hub-rail-hidden \{ --hub-rail-slot:0px; \}/);
  assert.match(read('navigation-hover.css'), /:root\.hub-app\.hub-rail-preview \{ --hub-rail-slot:var\(--display-rail-width,44px\); \}/);
  // Before the navigation script runs the container has no rail-pinned class.
  assert.match(fs.readFileSync(path.join(renderer, 'index.html'), 'utf8'), /<html[^>]*class="hub-app hub-rail-unpinned"/);
});

function fakeDoc() {
  const listeners = {};
  const classes = owner => {
    const set = new Set();
    return { set, contains: c => set.has(c), add: c => set.add(c), toggle: (c, on) => { if (on) set.add(c); else set.delete(c); return on; } };
  };
  const node = (id) => ({ id, dataset: {}, classList: classes(), attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener() {}, matches: () => false, contains: () => false, querySelectorAll: () => [] });
  const nodes = { 'app-container': node('app-container'), 'rail-edge-trigger': node('t'), 'rail-pin': node('p'), 'btn-toggle-navigation': node('b'), 'scene-rail': node('r') };
  const store = new Map();
  const win = { localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
    setTimeout, clearTimeout, Event: class { constructor(type) { this.type = type; } },
    MutationObserver: class { observe() {} } };
  return { store, nodes, documentElement: node('html'), defaultView: win, activeElement: null,
    getElementById: id => nodes[id] || null, addEventListener: (t, f) => { (listeners[t] ||= []).push(f); }, dispatchEvent() {} };
}

test('the navigation mirrors pinned / preview / hidden onto <html>', () => {
  const Module = require('node:module');
  const file = path.join(renderer, 'session-first-navigation.js');
  // Stub the artwork/order installers; this test only covers the class mirror.
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (/navigation-artwork|navigation-order/.test(request)) return { installNavigationArtwork() {}, installNavigationOrder() {} };
    return original.apply(this, arguments);
  };
  try {
    delete require.cache[file];
    const { installSessionFirstNavigation } = require(file);
    const doc = fakeDoc();
    doc.store.set('hub.navigationExpanded', 'false');
    installSessionFirstNavigation(doc);
    const html = doc.documentElement.classList.set, app = doc.nodes['app-container'].classList.set;
    assert.ok(html.has('hub-app'));
    assert.equal(html.has('hub-rail-unpinned'), !app.has('rail-pinned'));
    assert.equal(html.has('hub-rail-hidden'), app.has('rail-hidden'));
    assert.equal(html.has('hub-rail-preview'), app.has('rail-preview'));
    assert.ok(html.has('hub-rail-unpinned') && html.has('hub-rail-hidden'));
  } finally { Module._load = original; delete require.cache[file]; }
});
