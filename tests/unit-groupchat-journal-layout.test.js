'use strict';
// 2026-10-14: entering a room with 200 answers spent 4–8 s re-laying out the whole
// history once per card, because enhance() wrote a card's state and read its height
// card by card. A fake DOM counts how often a height read follows a write.
const test = require('node:test');
const assert = require('node:assert/strict');

const store = new Map();
global.localStorage = { getItem: k => store.get(k) || null, setItem: (k, v) => store.set(k, v) };
const journal = require('../renderer/groupchat-journal');

function fakePanel(specs, room = 'room') {
  const layout = { dirty: true, forced: 0 };
  const touch = () => { layout.dirty = true; };
  const tracked = target => new Proxy(target, { set(obj, key, value) { obj[key] = value; touch(); return true; } });
  const element = extra => ({
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; touch(); },
    ...extra,
  });
  const articles = specs.map((spec, index) => {
    const dataset = tracked({ journalKey: JSON.stringify([room, 'm' + index, index + 1, '']) });
    const classes = new Set();
    const article = element({ dataset });
    article.classList = { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); touch(); }, has: n => classes.has(n) };
    const text = {
      textContent: 'x'.repeat(spec.chars || 10),
      get scrollHeight() {
        if (layout.dirty) { layout.forced += 1; layout.dirty = false; }
        return dataset.journalMinimized === 'true' ? 0 : spec.height;
      },
    };
    const expand = tracked(element({ hidden: true, textContent: '' }));
    const minimize = tracked(element({ title: '' }));
    article.querySelector = selector => ({
      '.gc-journal-text': text, '.gc-journal-expand': expand, '.gc-journal-minimize': minimize,
    })[selector] || null;
    article.closest = () => null;
    return { article, expand, minimize, classes };
  });
  const panel = {
    __journalBound: true,
    ownerDocument: null,
    querySelectorAll: selector => selector === '[data-journal-key]' ? articles.map(a => a.article) : [],
  };
  return { panel, articles, layout };
}

test('measuring every card costs one layout, not one per card', () => {
  const { panel, layout } = fakePanel(Array.from({ length: 200 }, (_, i) => ({ height: i % 2 ? 900 : 120 })));
  journal.enhance(panel);
  assert.equal(layout.forced, 1);
});

test('long, short and minimized cards get the same marks as before', () => {
  store.set('gc-journal:' + JSON.stringify(['marks', 'm2', 3, '']), JSON.stringify({ expanded: false, minimized: true }));
  store.set('gc-journal:' + JSON.stringify(['marks', 'm3', 4, '']), JSON.stringify({ expanded: false, minimized: false }));
  const { panel, articles } = fakePanel([{ height: 900, chars: 1234 }, { height: 120 }, { height: 900 }, { height: 900, chars: 5000 }], 'marks');
  journal.enhance(panel);
  const [long, short, minimized, collapsed] = articles;
  assert.equal(long.classes.has('gc-journal-long'), true);
  assert.equal(long.expand.hidden, false);
  assert.equal(long.expand.textContent, '收起全文');
  assert.equal(short.classes.has('gc-journal-long'), false);
  assert.equal(short.expand.hidden, true);
  // A minimized card's text is hidden, so it measures 0 and is not marked long.
  assert.equal(minimized.article.dataset.journalMinimized, 'true');
  assert.equal(minimized.classes.has('gc-journal-long'), false);
  assert.equal(minimized.minimize.attributes['aria-expanded'], 'false');
  assert.equal(collapsed.expand.hidden, false);
  assert.match(collapsed.expand.textContent, /5,000 字 · 展开全文/);
  assert.equal(collapsed.expand.attributes['aria-expanded'], 'false');
});
