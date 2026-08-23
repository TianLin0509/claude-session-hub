const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTerminalLinkRegistrar } = require('../renderer/terminal-link-provider.js');

function cellWidth(char) {
  return char.codePointAt(0) > 0xFF ? 2 : 1;
}

function makeCellLine(text, isWrapped = false) {
  const cells = [];
  for (const char of String(text)) {
    const width = cellWidth(char);
    cells.push({ getChars: () => char, getWidth: () => width });
    if (width === 2) cells.push({ getChars: () => '', getWidth: () => 0 });
  }
  return {
    ...makeLine(text, isWrapped),
    getCell(index) { return cells[index] || { getChars: () => '', getWidth: () => 1 }; },
  };
}

function displayedWidth(text) {
  return Array.from(String(text)).reduce((sum, char) => sum + cellWidth(char), 0);
}

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

test('repairs doubled Windows separators while preserving xterm hit coordinates', async () => {
  const opened = [];
  const rawPath = 'C:\\\\Vibe\\\\_scratch\\\\report.md';
  const terminal = makeTerminal([makeLine(`Open ${rawPath}`)]);
  const register = createTerminalLinkRegistrar({
    getCwd: () => null,
    openPathInHub: async (...args) => { opened.push(args); },
  });
  register(terminal, 's1');

  const links = provide(terminal.getProvider(), 1);
  assert.strictEqual(links.length, 1);
  assert.strictEqual(links[0].text, 'C:\\Vibe\\_scratch\\report.md');
  assert.deepStrictEqual(links[0].range, {
    start: { x: 6, y: 1 },
    end: { x: 5 + rawPath.length, y: 1 },
  });
  await links[0].activate();
  assert.strictEqual(opened[0][0], 'C:\\Vibe\\_scratch\\report.md');
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

test('maps Chinese prompt prefixes and path names to xterm cell coordinates', async () => {
  const prefix = '输出路径：';
  const rawPath = 'C:\\Vibe\\中文目录\\报告.md';
  const opened = [];
  const terminal = makeTerminal([makeCellLine(prefix + rawPath)], 100);
  const register = createTerminalLinkRegistrar({
    getCwd: () => null,
    openPathInHub: async (...args) => { opened.push(args); },
  });
  register(terminal, 's1');

  const links = provide(terminal.getProvider(), 1);
  assert.strictEqual(links.length, 1);
  assert.deepStrictEqual(links[0].range, {
    start: { x: displayedWidth(prefix) + 1, y: 1 },
    end: { x: displayedWidth(prefix + rawPath), y: 1 },
  });
  await links[0].activate();
  assert.strictEqual(opened[0][0], rawPath);
});

test('rejoins a hard-wrapped URL without a file extension', () => {
  const firstText = '链接：https://example.com/api/';
  const terminal = makeTerminal([
    makeCellLine(firstText),
    makeCellLine('items?id=1&mode=full', false),
  ], displayedWidth(firstText));
  const register = createTerminalLinkRegistrar({
    getCwd: () => null,
    openPathInHub: async () => {},
  });
  register(terminal, 's1');

  const firstLineLinks = provide(terminal.getProvider(), 1);
  const secondLineLinks = provide(terminal.getProvider(), 2);
  assert.strictEqual(firstLineLinks.length, 1);
  assert.strictEqual(secondLineLinks.length, 1);
  assert.strictEqual(firstLineLinks[0].text, 'https://example.com/api/items?id=1&mode=full');
  assert.strictEqual(secondLineLinks[0].text, 'https://example.com/api/items?id=1&mode=full');
  assert.strictEqual(firstLineLinks[0].range.start.x, displayedWidth('链接：') + 1);
  assert.strictEqual(secondLineLinks[0].range.start.x, 1);
});

test('removes ConPTY wide-glyph wrap padding without deleting real path spaces', () => {
  const firstText = '路径：C:\\Vibe\\ ';
  const terminal = makeTerminal([
    makeCellLine(firstText),
    makeCellLine('工作区\\My Report\\报告.md', true),
  ], displayedWidth(firstText));
  const register = createTerminalLinkRegistrar({
    getCwd: () => null,
    openPathInHub: async () => {},
  });
  register(terminal, 's1');

  const links = provide(terminal.getProvider(), 1);
  assert.strictEqual(links.length, 1);
  assert.strictEqual(links[0].text, 'C:\\Vibe\\工作区\\My Report\\报告.md');
});
