const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTerminalLinkRegistrar } = require('../renderer/terminal-link-provider.js');

function makeLine(text, isWrapped = false) {
  return {
    isWrapped,
    translateToString(trimRight) {
      return trimRight ? String(text).replace(/\s+$/, '') : String(text);
    },
  };
}

function makeTerminal(lines, cols = 80) {
  let provider = null;
  return {
    cols,
    buffer: { active: { getLine: (idx) => lines[idx] || null } },
    registerLinkProvider(next) { provider = next; },
    getProvider() { return provider; },
  };
}

function provide(provider, lineNumber) {
  let out = Symbol('unset');
  provider.provideLinks(lineNumber, (links) => { out = links; });
  return out;
}

test('registers absolute file links with xterm coordinates', async () => {
  const opened = [];
  const terminal = makeTerminal([makeLine('Open C:\\Users\\me\\report.html')]);
  const register = createTerminalLinkRegistrar({
    getCwd: () => null,
    openPathInHub: async (...args) => { opened.push(args); },
  });
  register(terminal, 's1');

  const links = provide(terminal.getProvider(), 1);
  assert.strictEqual(links.length, 1);
  assert.strictEqual(links[0].text, 'C:\\Users\\me\\report.html');
  assert.deepStrictEqual(links[0].range, {
    start: { x: 6, y: 1 },
    end: { x: 28, y: 1 },
  });
  await links[0].activate();
  assert.deepStrictEqual(opened, [['C:\\Users\\me\\report.html', { cwd: null, requireExistsForRel: false }]]);
});

test('resolves relative paths against session cwd', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-terminal-links-'));
  fs.mkdirSync(path.join(cwd, 'docs'));
  fs.writeFileSync(path.join(cwd, 'docs', 'note.md'), '# note');
  const terminal = makeTerminal([makeLine('See docs/note.md')]);
  const register = createTerminalLinkRegistrar({
    getCwd: () => cwd,
    openPathInHub: async () => {},
  });
  register(terminal, 's1');

  const links = provide(terminal.getProvider(), 1);
  assert.strictEqual(links.length, 1);
  assert.strictEqual(links[0].text, path.join(cwd, 'docs', 'note.md'));
});

test('splits wrapped long paths into per-line link ranges', () => {
  const terminal = makeTerminal([
    makeLine('Open C:\\Users\\me\\long-'),
    makeLine('path\\report.html', true),
  ], 80);
  const register = createTerminalLinkRegistrar({
    getCwd: () => null,
    openPathInHub: async () => {},
  });
  register(terminal, 's1');

  const firstLineLinks = provide(terminal.getProvider(), 1);
  const secondLineLinks = provide(terminal.getProvider(), 2);
  assert.strictEqual(firstLineLinks.length, 1);
  assert.strictEqual(secondLineLinks.length, 1);
  assert.strictEqual(firstLineLinks[0].text, 'C:\\Users\\me\\long-path\\report.html');
  assert.strictEqual(secondLineLinks[0].text, 'C:\\Users\\me\\long-path\\report.html');
  assert.deepStrictEqual(firstLineLinks[0].range.start, { x: 6, y: 1 });
  assert.deepStrictEqual(secondLineLinks[0].range.start, { x: 1, y: 2 });
});
