'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

test('every card history load is generation-scoped and rejects a result after session/view switch', () => {
  const start = rendererSource.indexOf('async function loadSessionHistoryToOverlay');
  const end = rendererSource.indexOf("ipcRenderer.on('prompt-submitted-event'", start);
  assert.ok(start >= 0 && end > start, 'loadSessionHistoryToOverlay block not found');
  const block = rendererSource.slice(start, end);

  assert.match(
    block,
    /window\._cardLoadSeqBySid\.set\(sessionId, loadSeq\);/,
    'incremental loads also need a generation token',
  );
  assert.doesNotMatch(
    block,
    /if\s*\(!incremental\)\s*window\._cardLoadSeqBySid\.set/,
    'generation token must not be limited to full loads',
  );
  assert.match(
    block,
    /sessionId\s*!==\s*activeSessionId[\s\S]{0,180}currentView\s*!==\s*['"]card['"][\s\S]{0,180}_cardLoadSeqBySid\.get\(sessionId\)\s*!==\s*loadSeq/,
    'stale guard must check active session, active view, and latest generation',
  );
});

test('turn-complete card append rechecks render ownership after async transcript IPC', () => {
  const start = rendererSource.indexOf("ipcRenderer.on('turn-complete-event'");
  const end = rendererSource.indexOf('\n});', start);
  assert.ok(start >= 0 && end > start, 'turn-complete-event handler not found');
  const block = rendererSource.slice(start, end);
  const invokeAt = block.indexOf("await ipcRenderer.invoke('parse-session-transcript'");
  assert.ok(invokeAt >= 0, 'turn-complete transcript IPC not found');
  const postAwait = block.slice(invokeAt);
  assert.match(
    postAwait,
    /if\s*\(hubSessionId\s*!==\s*activeSessionId\s*\|\|\s*currentView\s*!==\s*['"]card['"]\)\s*return;/,
    'late IPC response must not append a card after the user switched session or view',
  );
});

test('meeting Codex sessions opt into prompt-owned rollout binding', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = mainSource.indexOf('function registerSessionForTap');
  const end = mainSource.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, 'registerSessionForTap block not found');
  assert.match(
    mainSource.slice(start, end),
    /requirePromptMatch:\s*!!session\.meetingId/,
    'meeting members must not bind a rollout by cwd/time before their submitted prompt matches',
  );
});

test('incremental card refresh keeps existing cards when parsing is temporarily empty or fails', () => {
  const start = rendererSource.indexOf('async function loadSessionHistoryToOverlay');
  const end = rendererSource.indexOf("ipcRenderer.on('prompt-submitted-event'", start);
  const block = rendererSource.slice(start, end);

  assert.match(
    block,
    /catch \(err\) \{[\s\S]*?if \(!incremental\) \{\s*showPlaceholder\(\s*'加载历史失败：'/,
    'incremental IPC exceptions must not replace already-rendered cards with a placeholder',
  );
  assert.match(
    block,
    /if \(turns\.length === 0 && ipcError\) \{[\s\S]*?if \(!incremental\) \{\s*showPlaceholder\(\s*txt/,
    'incremental parser errors must preserve already-rendered cards',
  );
  assert.match(
    block,
    /if \(turns\.length === 0\) \{[\s\S]*?if \(!incremental\) \{\s*showPlaceholder\(\s*'新会话/,
    'an empty incremental snapshot must not erase existing cards',
  );
});

test('closing a session clears card load generations and stream-end fallback timers', () => {
  const start = rendererSource.indexOf("ipcRenderer.on('session-closed'");
  const end = rendererSource.indexOf('\n});', start);
  assert.ok(start >= 0 && end > start, 'session-closed handler not found');
  const block = rendererSource.slice(start, end);
  assert.match(block, /window\._cardLoadSeqBySid\.delete\(sessionId\)/);
  assert.match(block, /clearTimeout\(window\._cardStopFallbackBySid\.get\(sessionId\)\)/);
  assert.match(block, /window\._cardStopFallbackBySid\.delete\(sessionId\)/);
});

test('turn render signature changes when visible model, kind, or timestamp metadata changes', () => {
  const { createTurnCardRenderer } = require('../renderer/turn-card-renderer.js');
  const renderer = createTurnCardRenderer({
    document: { addEventListener() {} },
    window: { _sessionTurns: new Map(), navigator: { clipboard: { writeText: async () => {} } } },
    navigator: { clipboard: { writeText: async () => {} } },
    CSS: { escape: String },
    marked: { parse: String },
    DOMPurify: { sanitize: String },
    formatAbsoluteTime: String,
    normalizeMarkdownPathBreaks: String,
    escapeHtml: String,
  });
  const base = {
    id: 'assistant-1',
    role: 'assistant',
    text: 'same text',
    ts: 100,
    model: 'gpt-old',
    kind: 'codex',
  };
  const baseSig = renderer.turnRenderSignature(base);
  assert.notEqual(renderer.turnRenderSignature({ ...base, model: 'gpt-new' }), baseSig);
  assert.notEqual(renderer.turnRenderSignature({ ...base, kind: 'claude' }), baseSig);
  assert.notEqual(renderer.turnRenderSignature({ ...base, ts: 200 }), baseSig);
});
