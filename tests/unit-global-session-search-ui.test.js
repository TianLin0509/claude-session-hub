'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  appendHighlightedText,
  formatSearchTime,
  normalizeTerms,
} = require('../renderer/global-session-search.js');

const ROOT = path.resolve(__dirname, '..');

class FakeNode {
  constructor(tagName = null, text = '') {
    this.tagName = tagName;
    this.textContent = text;
    this.children = [];
  }
  appendChild(child) { this.children.push(child); return child; }
}

const fakeDocument = {
  createTextNode(text) { return new FakeNode(null, text); },
  createElement(tagName) { return new FakeNode(String(tagName).toUpperCase()); },
};

test('highlight rendering keeps transcript HTML inert and marks only matched text', () => {
  const root = new FakeNode('DIV');
  appendHighlightedText(fakeDocument, root, '<img src=x onerror=alert(1)> Formula', 'img formula');
  assert.equal(root.children.filter(node => node.tagName === 'MARK').length, 2);
  assert.equal(root.children.map(node => node.textContent).join(''), '<img src=x onerror=alert(1)> Formula');
  assert.equal(root.children.some(node => node.tagName === 'IMG'), false);
});

test('query helpers normalize full-width text and user-facing relative time', () => {
  assert.deepEqual(normalizeTerms('  ＡI  Hub '), ['ai', 'hub']);
  assert.equal(formatSearchTime(1_000, 1_000), '刚刚');
  assert.equal(formatSearchTime(1_000, 61_000), '1 分钟前');
});

test('renderer contract exposes A-layout filters, local-index status and keyboard entry', () => {
  const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'renderer', 'global-session-search.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'renderer', 'styles', 'global-session-search.css'), 'utf8');
  for (const id of [
    'btn-global-search', 'search-query', 'session-search-provider-filters',
    'session-search-scope-tabs', 'session-search-results-pane', 'session-search-preview',
  ]) assert.match(html, new RegExp(`id="${id}"`));
  for (const provider of ['claude', 'codex', 'meeting', 'deepseek']) {
    assert.match(html, new RegExp(`data-provider="${provider}"`));
  }
  for (const scope of ['title', 'user', 'assistant', 'tool']) {
    assert.match(html, new RegExp(`data-scope="${scope}"`));
  }
  assert.match(js, /get-session-search-preview/);
  assert.match(js, /refresh-session-search/);
  assert.match(js, /event\.shiftKey/);
  assert.match(css, /grid-template-columns:\s*43% 57%/);
  assert.match(css, /session-search-chip\[hidden\]\s*\{\s*display:\s*none/);
  assert.doesNotMatch(html, /Type to search all past Claude transcripts/);
});
