'use strict';

const assert = require('assert');
const { createTerminalSearch } = require('../renderer/terminal-search.js');

function fakeEl(id) {
  return {
    id,
    style: { display: 'none' },
    value: '',
    textContent: '',
    listeners: {},
    addEventListener(name, fn) { this.listeners[name] = fn; },
    focusCount: 0,
    selectCount: 0,
    focus() { this.focusCount += 1; },
    select() { this.selectCount += 1; },
  };
}

const elements = new Map([
  ['terminal-search', fakeEl('terminal-search')],
  ['terminal-search-input', fakeEl('terminal-search-input')],
  ['terminal-search-count', fakeEl('terminal-search-count')],
  ['terminal-search-prev', fakeEl('terminal-search-prev')],
  ['terminal-search-next', fakeEl('terminal-search-next')],
  ['terminal-search-close', fakeEl('terminal-search-close')],
]);
const calls = [];
const cache = new Map([['s1', {
  terminal: { focus: () => calls.push('terminal.focus') },
  searchAddon: {
    clearDecorations: () => calls.push('clear'),
    findNext: (q) => { calls.push(`next:${q}`); return q === 'hit'; },
    findPrevious: (q) => { calls.push(`prev:${q}`); return q === 'hit'; },
  },
}]]);

const search = createTerminalSearch({
  document: { getElementById: (id) => elements.get(id) || null },
  getActiveSessionId: () => 's1',
  getTerminalCache: () => cache,
});
search.init();

search.open();
assert.strictEqual(elements.get('terminal-search').style.display, 'flex',
  'open should show the terminal search bar');
assert.strictEqual(elements.get('terminal-search-input').focusCount, 1,
  'open should focus the search input');

elements.get('terminal-search-input').value = 'missing';
search.run(1);
assert.strictEqual(elements.get('terminal-search-count').textContent, 'no match',
  'run should show no match when searchAddon returns false');
assert.deepStrictEqual(calls.slice(-1), ['next:missing']);

elements.get('terminal-search-input').value = 'hit';
search.run(-1);
assert.strictEqual(elements.get('terminal-search-count').textContent, '',
  'run should clear no-match text when a match exists');
assert.deepStrictEqual(calls.slice(-1), ['prev:hit']);

search.close();
assert.strictEqual(elements.get('terminal-search').style.display, 'none',
  'close should hide the terminal search bar');
assert.ok(calls.includes('clear') && calls.includes('terminal.focus'),
  'close should clear decorations and restore terminal focus');

console.log('Terminal search contract: ok');
