'use strict';

const assert = require('node:assert/strict');
const { Terminal } = require('@xterm/headless');
const {
  CodexXtermScrollbackRewriter,
} = require('../core/codex-xterm-scrollback-rewriter.js');

const ESC = '\x1b';

function write(terminal, data) {
  return new Promise(resolve => terminal.write(data, resolve));
}

function bufferLines(terminal) {
  const buffer = terminal.buffer.normal;
  const lines = [];
  for (let index = 0; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    lines.push(line ? line.translateToString(true) : '');
  }
  return lines;
}

function visibleLines(terminal) {
  const buffer = terminal.buffer.normal;
  const lines = [];
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.baseY + row);
    lines.push(line ? line.translateToString(true) : '');
  }
  return lines;
}

function markerFrame() {
  let output = '';
  for (let row = 1; row <= 8; row += 1) {
    output += `${ESC}[${row};1HMARK-${String(row).padStart(2, '0')}`;
  }
  output += `${ESC}[9;1HINPUT-OLD${ESC}[10;1HSTATUS-OLD`;
  return output;
}

function codexRegionScroll() {
  return `${ESC}[1;8r${ESC}[3S${ESC}[r`
    + `${ESC}[6;1H${ESC}[J${ESC}[9;1HINPUT-NEW${ESC}[10;1HSTATUS-NEW`;
}

function markers(lines) {
  return lines.flatMap(line => [...line.matchAll(/MARK-(\d{2})/g)].map(match => match[1]));
}

function conptyFrame(lines, { synchronized = false } = {}) {
  const boundary = synchronized ? `${ESC}[?2026h${ESC}[?2026l` : '';
  return boundary
    + `${ESC}[?25l${ESC}[H`
    + lines.map((line, index) => (
      `${line}${ESC}[K${index === lines.length - 1 ? '' : '\r\n'}`
    )).join('')
    + `${ESC}[?25h`;
}

async function replay(data) {
  const terminal = new Terminal({ cols: 40, rows: 10, scrollback: 100, allowProposedApi: true });
  await write(terminal, data);
  return terminal;
}

async function main() {
  const raw = markerFrame() + codexRegionScroll();
  const broken = await replay(raw);
  assert.deepStrictEqual(markers(bufferLines(broken)), ['04', '05', '06', '07', '08'],
    'xterm baseline must reproduce Codex partial-region history loss');

  const rewriter = new CodexXtermScrollbackRewriter();
  const patched = await replay(rewriter.write(raw));
  assert.deepStrictEqual(markers(bufferLines(patched)), ['01', '02', '03', '04', '05', '06', '07', '08']);
  assert.deepStrictEqual(visibleLines(patched), visibleLines(broken),
    'Codex repaint must leave the final viewport unchanged');
  assert.deepStrictEqual(rewriter.stats(), {
    rewrittenScrolls: 1,
    rescuedLines: 3,
    pendingChars: 0,
    alternateScreen: false,
    originMode: false,
    scrollRegion: null,
    observedConptyFrames: 0,
    rewrittenConptyFrames: 0,
    conptyFailOpenFrames: 0,
  });

  const chunked = new CodexXtermScrollbackRewriter();
  const chunks = [];
  for (let index = 0; index < raw.length; index += 1) {
    chunks.push(chunked.write(raw[index]));
  }
  chunks.push(chunked.flush());
  const chunkedTerminal = await replay(chunks.join(''));
  assert.deepStrictEqual(markers(bufferLines(chunkedTerminal)), ['01', '02', '03', '04', '05', '06', '07', '08'],
    'ANSI sequences split across arbitrary PTY chunks must still be rewritten');
  assert.equal(chunked.stats().rewrittenScrolls, 1);

  // Windows ConPTY consumes the original DECSTBM + CSI S before node-pty can
  // observe it. It serializes the resulting synchronized update as a full
  // repaint from cursor home. The second mitigation path recognizes the exact
  // shifted frame and commits the displaced rows to xterm scrollback first.
  const previousWindowsFrame = [
    'MARK-01', 'MARK-02', 'MARK-03', 'MARK-04', 'MARK-05',
    'MARK-06', 'MARK-07', 'MARK-08', 'INPUT-OLD', 'STATUS-OLD',
  ];
  const nextWindowsFrame = [
    'MARK-04', 'MARK-05', 'MARK-06', 'MARK-07', 'MARK-08',
    '', '', '', 'INPUT-NEW', 'STATUS-NEW',
  ];
  const serializedInitial = conptyFrame(previousWindowsFrame);
  const serializedUpdate = conptyFrame(nextWindowsFrame, { synchronized: true });

  const brokenWindows = await replay(serializedInitial + serializedUpdate);
  assert.deepStrictEqual(markers(bufferLines(brokenWindows)), ['04', '05', '06', '07', '08'],
    'ConPTY baseline must reproduce the Windows home-repaint history loss');

  const windowsRewriter = new CodexXtermScrollbackRewriter({
    conptySerialized: true,
    cols: 40,
    rows: 10,
  });
  const serializedInitialSafe = windowsRewriter.write(serializedInitial);
  // Hub fit/resize may report an unchanged geometry; it must not discard the
  // comparison baseline immediately before a Codex repaint.
  windowsRewriter.resize(40, 10);
  const patchedWindows = await replay(serializedInitialSafe + windowsRewriter.write(serializedUpdate));
  assert.deepStrictEqual(markers(bufferLines(patchedWindows)),
    ['01', '02', '03', '04', '05', '06', '07', '08']);
  assert.deepStrictEqual(visibleLines(patchedWindows), visibleLines(brokenWindows),
    'ConPTY mitigation must preserve the final visible viewport');
  assert.equal(patchedWindows.buffer.normal.baseY, 3,
    'displaced ConPTY rows must become real xterm scrollback');
  assert.deepStrictEqual(windowsRewriter.stats(), {
    rewrittenScrolls: 1,
    rescuedLines: 3,
    pendingChars: 0,
    alternateScreen: false,
    originMode: false,
    scrollRegion: null,
    observedConptyFrames: 2,
    rewrittenConptyFrames: 1,
    conptyFailOpenFrames: 0,
  });

  const chunkedWindows = new CodexXtermScrollbackRewriter({
    conptySerialized: true,
    cols: 40,
    rows: 10,
  });
  const windowsChunks = [chunkedWindows.write(serializedInitial)];
  for (const character of serializedUpdate) windowsChunks.push(chunkedWindows.write(character));
  windowsChunks.push(chunkedWindows.flush());
  const chunkedWindowsTerminal = await replay(windowsChunks.join(''));
  assert.deepStrictEqual(markers(bufferLines(chunkedWindowsTerminal)),
    ['01', '02', '03', '04', '05', '06', '07', '08'],
    'ConPTY frames split across arbitrary PTY chunks must still be preserved');
  assert.equal(chunkedWindows.stats().rewrittenConptyFrames, 1);

  const incompleteWindows = new CodexXtermScrollbackRewriter({ conptySerialized: true, rows: 10 });
  const incompleteFrame = `${ESC}[?2026h${ESC}[?2026l${ESC}[?25l${ESC}[Hpartial`;
  assert.equal(incompleteWindows.write(incompleteFrame), '',
    'an in-progress synchronized ConPTY frame should remain atomic');
  assert.equal(incompleteWindows.flush(), incompleteFrame,
    'flush must fail open rather than lose an incomplete ConPTY frame');

  const alternate = new CodexXtermScrollbackRewriter();
  const alternateRaw = `${ESC}[?1049h${ESC}[1;8r${ESC}[3S${ESC}[r${ESC}[?1049l`;
  assert.equal(alternate.write(alternateRaw), alternateRaw, 'alternate-screen scrolling must pass through');
  assert.equal(alternate.stats().rewrittenScrolls, 0);

  const nonTopRegion = new CodexXtermScrollbackRewriter();
  const nonTopRaw = `${ESC}[2;8r${ESC}[3S${ESC}[r`;
  assert.equal(nonTopRegion.write(nonTopRaw), nonTopRaw, 'regions not anchored at row 1 must pass through');
  assert.equal(nonTopRegion.stats().rewrittenScrolls, 0);

  const clamped = new CodexXtermScrollbackRewriter();
  const clampedOutput = clamped.write(`${ESC}[1;3r${ESC}[999S${ESC}[r`);
  assert.equal((clampedOutput.match(/\n/g) || []).length, 3, 'scroll amount must be clamped to region height');
  assert.equal(clamped.stats().rescuedLines, 3);

  const identity = new CodexXtermScrollbackRewriter();
  const ordinary = `plain text\r\n${ESC}[31mred${ESC}[0m`;
  assert.equal(identity.write(ordinary), ordinary, 'ordinary PTY data must remain byte-for-byte');

  for (const terminal of [
    broken,
    patched,
    chunkedTerminal,
    brokenWindows,
    patchedWindows,
    chunkedWindowsTerminal,
  ]) terminal.dispose();
  console.log('unit-codex-xterm-scrollback-rewriter: PASS');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
