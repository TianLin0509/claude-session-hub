'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createMemoPanel } = require('../renderer/memo-panel.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-memo-panel-'));
const store = new Map();

const memo = createMemoPanel({
  baseDir: dir,
  clipboard: { writeText: () => {} },
  document: {
    createElement: () => ({ textContent: '', innerHTML: '' }),
    getElementById: () => null,
    querySelectorAll: () => [],
  },
  getActiveSessionId: () => null,
  getActiveTerminal: () => null,
  localStorage: {
    getItem: (k) => store.get(k) || null,
    setItem: (k, v) => store.set(k, String(v)),
  },
  scheduleRefit: () => {},
});

assert.deepStrictEqual(memo.loadItems(), [], 'memo panel should start with an empty item list');
assert.strictEqual(memo.addItem('  first note  '), true, 'addItem should accept non-empty text');
assert.strictEqual(memo.addItem('   '), false, 'addItem should reject blank text');
assert.strictEqual(memo.loadItems().length, 1, 'memo item should persist to memo.json');
assert.strictEqual(memo.loadItems()[0].text, 'first note', 'memo text should be trimmed before saving');

const id = memo.loadItems()[0].id;
memo.deleteItem(id);
assert.deepStrictEqual(memo.loadItems(), [], 'deleteItem should remove by id');

memo.addItem('second note');
memo.clearAll();
assert.deepStrictEqual(memo.loadItems(), [], 'clearAll should remove all memo items');

store.set('claude-hub-memo-open', 'true');
assert.strictEqual(memo.isOpen(), true, 'isOpen should read the persisted open flag');

console.log('Memo panel contract: ok');
