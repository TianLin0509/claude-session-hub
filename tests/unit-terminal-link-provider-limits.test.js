'use strict';
// 终端链接识别的封顶与超时保护（2026-10-19 公司真机：点开 CodeAgent 会话的后台，界面卡死、
// 内存约 20 秒涨到 4 GB 后崩溃，调用栈停在 provideLinks → _lineTextMetrics）。
// 根因：xterm 5.5 的 buffer.getLine(i) 越过末行会绕回开头（备用屏幕总是如此，普通屏幕在滚动缓冲
// 写满后也如此），旧代码往下拼行只靠 getLine 返回空值收尾，遇到每行都算续行的内容就无限拼接。
// 这里用真实的 xterm 缓冲（@xterm/headless）复现两种触发内容，并锁住上限、超时放弃和原有识别结果。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Terminal } = require('@xterm/headless');
const { Unicode11Addon } = require('@xterm/addon-unicode11');
const {
  createTerminalLinkRegistrar,
  LINK_GROUP_MAX_LINES,
  LINK_GROUP_MAX_CHARS,
  LINK_SCAN_BUDGET_MS,
  LINK_MAX_STATS,
} = require('../renderer/terminal-link-provider.js');
const { collectPathCandidates } = require('../renderer/path-candidates.js');

function fakeTerminal(lineTexts, cols, wrapped = true) {
  const lines = lineTexts.map((text, i) => ({ isWrapped: wrapped && i > 0, translateToString: () => text }));
  return {
    cols,
    buffer: { active: { length: lines.length, getLine: i => lines[i] || null } },
    registerLinkProvider() { return { dispose() {} }; },
  };
}

// 统计（并可拖慢）同步磁盘查询：path-candidates 调用时才取 fs.existsSync / fs.statSync，替换模块属性即可。
function withFsSpy(onCall, fn) {
  const origExists = fs.existsSync;
  const origStat = fs.statSync;
  fs.existsSync = (...args) => { onCall(args[0]); return origExists(...args); };
  fs.statSync = (...args) => { onCall(args[0]); return origStat(...args); };
  try { return fn(); } finally { fs.existsSync = origExists; fs.statSync = origStat; }
}

const quietWarn = (fn) => {
  const orig = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = orig; }
};

const B = '\\';
const ESC = '\x1b[';
const cellWidth = ch => (ch.codePointAt(0) > 0x2e80 ? 2 : 1);
const width = s => [...s].reduce((n, ch) => n + cellWidth(ch), 0);

function headless(cols, rows, scrollback = 10000) {
  const t = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  t.loadAddon(new Unicode11Addon());
  t.unicode.activeVersion = '11';
  return t;
}
const write = (t, data) => new Promise(resolve => t.write(data, resolve));

// 统计 getLine 调用次数；超过上限就抛错，旧代码的无限循环在这里会变成一个可读的失败而不是撑爆内存。
function wrapTerminal(t, { maxGetLine = 200000 } = {}) {
  const stats = { getLine: 0 };
  const active = () => t.buffer.active;
  const buffer = {
    get active() {
      const buf = active();
      return {
        get length() { return buf.length; },
        get type() { return buf.type; },
        getLine(y) {
          stats.getLine += 1;
          if (stats.getLine > maxGetLine) throw new Error(`getLine called ${stats.getLine} times: unbounded scan`);
          return buf.getLine(y);
        },
      };
    },
  };
  return { cols: t.cols, rows: t.rows, buffer, stats, registerLinkProvider() { return { dispose() {} }; } };
}

function provide(provider, lineNumber) {
  let out = Symbol('unset');
  provider.provideLinks(lineNumber, links => { out = links; });
  assert.notEqual(typeof out, 'symbol', 'callback must be called synchronously');
  return out || [];
}

function register(term, opts = {}) {
  return createTerminalLinkRegistrar({ getCwd: () => null, openPathInHub: async () => {}, ...opts })(term, opts.sessionId || 's1');
}

// 四周带边框的全屏 TUI（CodeAgent 这类 opentui 界面的形态）：每一行都写到最后一列，
// 每一行都会被「贴着右边缘」的启发式判成上一行的续行，最后一行又绕回第一行。
function boxedScreen(cols, rows, bodyAt) {
  let s = `${ESC}?1049h${ESC}2J`;
  for (let r = 1; r <= rows; r++) {
    let line;
    if (r === 1) line = '┌' + '─'.repeat(cols - 2) + '┐';
    else if (r === rows) line = '└' + '─'.repeat(cols - 2) + '┘';
    else {
      const body = bodyAt[r] || ` CodeAgent 启动界面 第 ${r} 行`;
      line = '│' + body + ' '.repeat(Math.max(0, cols - 2 - width(body))) + '│';
    }
    s += `${ESC}${r};1H` + line;
  }
  return s;
}

test('xterm getLine wraps around past the last line (the reason a length bound is required)', async () => {
  const t = headless(20, 5, 10);
  await write(t, `${ESC}?1049h${ESC}1;1HALT-FIRST`);
  const buf = t.buffer.active;
  assert.equal(buf.type, 'alternate');
  assert.equal(buf.length, 5);
  assert.equal(buf.getLine(buf.length).translateToString(true), 'ALT-FIRST', 'line past the end is the first line again');
});

test('full-screen bordered TUI on the alternate screen: bounded scan, link still found', async () => {
  const cols = 120;
  const rows = 40;
  const target = ['C:', 'Users', 'me', '报告.md'].join(B);
  const t = headless(cols, rows);
  await write(t, boxedScreen(cols, rows, { 5: ' 输出路径：' + target }));
  const term = wrapTerminal(t);
  const provider = register(term);
  const started = performance.now();
  const links = provide(provider, 5);
  const ms = performance.now() - started;
  assert.equal(links.length, 1);
  assert.equal(links[0].text, target);
  assert.deepEqual(links[0].range, {
    start: { x: width('│ 输出路径：') + 1, y: 5 },
    end: { x: width('│ 输出路径：' + target), y: 5 },
  });
  // 一屏 40 行：每次识别读行次数与屏幕行数同一量级，不再绕圈。
  assert.ok(term.stats.getLine <= rows * 8, `getLine calls ${term.stats.getLine}`);
  assert.ok(ms < 500, `took ${ms.toFixed(1)} ms`);
  for (let line = 1; line <= rows; line++) {
    const before = term.stats.getLine;
    provide(provider, line);
    assert.ok(term.stats.getLine - before <= rows * 8, `line ${line}: ${term.stats.getLine - before} getLine calls`);
  }
});

test('one long line that fills the whole scrollback: gives up quickly, bounded reads and memory', async () => {
  const cols = 120;
  const t = headless(cols, 40, 10000);
  await write(t, 'x'.repeat(cols * 10100));
  const buf = t.buffer.active;
  assert.equal(buf.length, 10040, 'scrollback is full, so getLine wraps around');
  const term = wrapTerminal(t);
  const provider = register(term);
  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  for (const line of [buf.length - 2, buf.length, 1, 5000]) {
    const before = term.stats.getLine;
    assert.deepEqual(provide(provider, line), []);
    assert.ok(term.stats.getLine - before <= (LINK_GROUP_MAX_LINES + 2) * 4, `line ${line}: ${term.stats.getLine - before} getLine calls`);
  }
  const ms = performance.now() - started;
  assert.ok(ms < 500, `took ${ms.toFixed(1)} ms`);
  assert.ok(process.memoryUsage().heapUsed - heapBefore < 64 * 1024 * 1024);
});

test(`a logical line longer than ${LINK_GROUP_MAX_LINES} rows is skipped; a shorter wrapped path still links`, async () => {
  const cols = 80;
  const target = ['C:', 'Work', '项目', 'very-long-directory-name-' + 'x'.repeat(90), '结果 报告.md'].join(B);
  const t = headless(cols, 30, 10000);
  // 第一段：3000 行不换行的长串里夹一条路径（超过上限，这一组放弃识别）；
  // 第二段：一条跨三行的路径单独成行（正常识别，跨行的每一行都给出链接）。
  await write(t, '─'.repeat(cols * 3000) + ' 路径：' + target + ' ' + '─'.repeat(cols * 500) + '\r\n'
    + '结果路径：' + target + '\r\n');
  const term = wrapTerminal(t);
  const provider = register(term);
  const buf = t.buffer.active;
  const found = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf.getLine(i).translateToString(true).includes('路径：')) found.push(i + 1);
  }
  assert.equal(found.length, 2);
  const started = performance.now();
  assert.deepEqual(provide(provider, found[0]), []);
  const links = provide(provider, found[1]);
  const nextLinks = provide(provider, found[1] + 1);
  const ms = performance.now() - started;
  assert.equal(links.length, 1);
  assert.equal(links[0].text, target);
  assert.equal(nextLinks.length, 1);
  assert.equal(nextLinks[0].text, target);
  assert.deepEqual(nextLinks[0].range.start, { x: 1, y: found[1] + 1 });
  assert.ok(ms < 200, `took ${ms.toFixed(1)} ms`);
  assert.ok(LINK_GROUP_MAX_CHARS >= 3 * 2083, 'cap still leaves room for the longest practical URL');
});

test('time budget: an over-budget scan gives up, logs session + line count only, and rate-limits the log', () => {
  const lines = [];
  for (let i = 0; i < 20; i++) {
    lines.push({ isWrapped: i > 0, translateToString: () => 'abcdefghij'.repeat(8) });
  }
  const term = {
    cols: 80,
    buffer: { active: { length: lines.length, getLine: i => lines[i] || null } },
    registerLinkProvider() { return { dispose() {} }; },
  };
  let clock = 0;
  const reports = [];
  const provider = register(term, {
    sessionId: 'budget-session',
    now: () => { clock += 15; return clock; },
    onScanBudgetExceeded: detail => reports.push(detail),
  });
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(provide(provider, 15), []);
    assert.deepEqual(provide(provider, 15), []);
  } finally { console.warn = origWarn; }
  assert.equal(reports.length, 1, 'second over-budget scan within a minute is not logged again');
  assert.deepEqual(Object.keys(reports[0]).sort(), ['lines', 'ms', 'reason', 'sessionId']);
  assert.equal(reports[0].reason, 'time');
  assert.equal(reports[0].sessionId, 'budget-session');
  assert.ok(reports[0].ms > LINK_SCAN_BUDGET_MS);
  assert.ok(Number.isInteger(reports[0].lines) && reports[0].lines < lines.length);
});

test('giving up on the line / char cap is logged with its reason only; the log throttle is shared by all terminals', () => {
  const reports = [];
  const registrar = createTerminalLinkRegistrar({
    getCwd: () => null, openPathInHub: async () => {}, onScanBudgetExceeded: d => reports.push(d),
  });
  const tall = fakeTerminal(Array.from({ length: 100 }, () => 'a'.repeat(80)), 80);
  const wide = fakeTerminal(Array.from({ length: 50 }, () => 'b'.repeat(200)), 200);
  quietWarn(() => {
    assert.deepEqual(provide(registrar(tall, 's-tall'), 90), []);
    assert.deepEqual(provide(registrar(wide, 's-wide'), 1), []);
  });
  assert.equal(reports.length, 1, 'second session within a minute is throttled by the shared limiter');
  assert.equal(reports[0].reason, 'lines');
  assert.equal(reports[0].sessionId, 's-tall');
  assert.deepEqual(Object.keys(reports[0]).sort(), ['lines', 'ms', 'reason', 'sessionId']);

  const reportsWide = [];
  const fresh = createTerminalLinkRegistrar({
    getCwd: () => null, openPathInHub: async () => {}, onScanBudgetExceeded: d => reportsWide.push(d),
  });
  quietWarn(() => assert.deepEqual(provide(fresh(wide, 's-wide'), 1), []));
  assert.equal(reportsWide[0].reason, 'chars');
});

test('time budget covers candidate parsing: slow disk lookups make this scan give up', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-link-slowfs-'));
  const tag = Date.now().toString(36);
  const text = `see docs/${tag}-a.md docs/${tag}-b.md docs/${tag}-c.md`;
  const term = fakeTerminal([text], 120, false);
  let fakeNow = 1000;
  const reports = [];
  const provider = createTerminalLinkRegistrar({
    getCwd: () => cwd, openPathInHub: async () => {}, now: () => fakeNow, onScanBudgetExceeded: d => reports.push(d),
  })(term, 's-slow');
  // 每次磁盘查询假装花 30 ms（杀软较重的电脑）。拼行几乎不花时间，超时全在解析候选里。
  const links = withFsSpy(p => { if (String(p).startsWith(cwd)) fakeNow += 30; }, () => quietWarn(() => provide(provider, 1)));
  assert.deepEqual(links, []);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].reason, 'time');
  assert.ok(reports[0].ms > LINK_SCAN_BUDGET_MS);
});

test(`one scan does at most ${LINK_MAX_STATS} synchronous disk lookups; card parsing (no budget) is unchanged`, () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-link-stats-'));
  const tag = Date.now().toString(36);
  const text = Array.from({ length: 40 }, (_, i) => `w${tag}x${i}`).join(' ');
  const term = fakeTerminal([text], 2000, false);
  const provider = createTerminalLinkRegistrar({ getCwd: () => cwd, openPathInHub: async () => {} })(term, 's-stats');
  let terminalCalls = 0;
  withFsSpy(p => { if (String(p).startsWith(cwd)) terminalCalls += 1; }, () => provide(provider, 1));
  assert.ok(terminalCalls > 0 && terminalCalls <= LINK_MAX_STATS, `terminal lookups ${terminalCalls}`);
  let cardCalls = 0;
  const text2 = Array.from({ length: 40 }, (_, i) => `v${tag}y${i}`).join(' ');
  withFsSpy(p => { if (String(p).startsWith(cwd)) cardCalls += 1; }, () => collectPathCandidates(text2, cwd));
  assert.ok(cardCalls >= 40, `card lookups ${cardCalls}`);
});

test('normal content keeps the exact pre-fix results (Chinese, wide-glyph wrap, spaces, URL, relative path)', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-link-limits-'));
  fs.mkdirSync(path.join(cwd, 'docs'));
  fs.writeFileSync(path.join(cwd, 'docs', 'note.md'), '# note');
  const cols = 37;
  const abs = ['C:', 'Vibe', '中文目录', 'My Report', '报告.md'].join(B);
  const url = 'https://example.com/api/items?id=1&mode=full';
  const t = headless(cols, 24, 1000);
  await write(t, [
    '输出路径：' + abs,
    'See docs/note.md here',
    '链接：' + url,
  ].join('\r\n') + '\r\n');
  const term = wrapTerminal(t);
  const provider = createTerminalLinkRegistrar({ getCwd: () => cwd, openPathInHub: async () => {} })(term, 's1');
  const all = [];
  for (let line = 1; line <= t.buffer.active.length; line++) {
    for (const link of provide(provider, line)) all.push({ text: link.text, range: link.range });
  }
  // 期望值由修复前的实现在同一缓冲上算出（见提交说明里的逐行对比），这里逐项锁住。
  assert.deepEqual(all, [
    { text: abs, range: { start: { x: 11, y: 1 }, end: { x: 37, y: 1 } } },
    { text: abs, range: { start: { x: 1, y: 2 }, end: { x: 7, y: 2 } } },
    { text: path.join(cwd, 'docs', 'note.md'), range: { start: { x: 5, y: 3 }, end: { x: 16, y: 3 } } },
    { text: url, range: { start: { x: 7, y: 4 }, end: { x: 37, y: 4 } } },
    { text: url, range: { start: { x: 1, y: 5 }, end: { x: 13, y: 5 } } },
  ]);
});
