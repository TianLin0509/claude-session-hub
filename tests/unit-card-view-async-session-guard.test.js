'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

test('full and incremental card loads use separate generations while rejecting session/view switches', () => {
  const start = rendererSource.indexOf('async function loadSessionHistoryToOverlay');
  const end = rendererSource.indexOf("ipcRenderer.on('prompt-submitted-event'", start);
  assert.ok(start >= 0 && end > start, 'loadSessionHistoryToOverlay block not found');
  const block = rendererSource.slice(start, end);

  assert.match(
    block,
    /const loadLane = incremental \? 'incremental' : 'full';/,
    'full hydration and incremental refreshes need independent generation lanes',
  );
  assert.match(
    block,
    /loadSeqs\[loadLane\] = loadSeq;[\s\S]{0,120}_cardLoadSeqBySid\.set\(sessionId, loadSeqs\);/,
    'the newest request must replace only its own lane generation',
  );
  assert.match(
    block,
    /sessionId\s*!==\s*activeSessionId[\s\S]{0,180}currentView\s*!==\s*['"]card['"][\s\S]{0,260}_cardLoadSeqBySid\.get\(sessionId\)\[loadLane\]\s*!==\s*loadSeq/,
    'stale guard must check active session, active view, and latest generation in the same lane',
  );
  assert.doesNotMatch(
    block,
    /_cardLoadSeqBySid\.get\(sessionId\)\s*!==\s*loadSeq/,
    'an incremental request must not invalidate an in-flight full-history request',
  );
  assert.match(
    block,
    /const concurrentFullCards = !incremental[\s\S]{0,220}:scope > \.turn-card/,
    'full hydration must retain cards that arrived while its transcript parse was in flight',
  );
  assert.match(
    block,
    /for \(const card of concurrentExtraCards\) \{[\s\S]{0,120}placeBeforeStreamingTail\(card\);/,
    'newer concurrent cards must be placed after the authoritative full-history order',
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
    /if \(turns\.length === 0 && ipcError\) \{[\s\S]*?if \(!incremental && concurrentFullCards\.length === 0\) \{\s*showPlaceholder\(\s*txt/,
    'incremental parser errors must preserve already-rendered cards',
  );
  assert.match(
    block,
    /if \(turns\.length === 0\) \{[\s\S]*?if \(!incremental\) \{\s*if \(concurrentFullCards\.length === 0\) \{\s*showPlaceholder\(\s*'新会话/,
    'an empty incremental snapshot must not erase existing cards',
  );
});

test('active card refresh is provider-aware without requiring renderer transcript metadata', () => {
  const start = rendererSource.indexOf('const CARD_STREAM_REFRESH_MIN_INTERVAL_MS');
  const end = rendererSource.indexOf('// Status updates from our custom statusline script.', start);
  assert.ok(start >= 0 && end > start, 'card live-refresh scheduler block not found');
  const block = rendererSource.slice(start, end);

  assert.match(
    block,
    /isClaudeFamily\(session\.kind\)[\s\S]{0,100}isCodexKind\(session\.kind\)[\s\S]{0,100}isKimiCliKind\(session\.kind\)/,
    'Claude, Codex/DeepSeek and Kimi must share the same active-card refresh gate',
  );
  assert.doesNotMatch(
    block,
    /!sessForReload\.transcriptPath[\s\S]{0,80}!sessForReload\.ccSessionId/,
    'a newly bound Codex/Kimi session must not be skipped just because renderer metadata has not arrived yet',
  );
  assert.match(
    block,
    /CARD_STREAM_SETTLE_RETRY_MS\s*=\s*\[1000,\s*2500,\s*6000\]/,
    'late transcript writeback needs finite settle retries instead of permanent polling',
  );
  assert.match(
    block,
    /parseOpts:\s*\{\s*limit:\s*1,\s*fromTail:\s*true\s*\}/,
    'each live refresh must stay bounded to the transcript tail',
  );
});

test('closing a session clears card load generations and all live-refresh timers', () => {
  const start = rendererSource.indexOf("ipcRenderer.on('session-closed'");
  const end = rendererSource.indexOf('\n});', start);
  assert.ok(start >= 0 && end > start, 'session-closed handler not found');
  const block = rendererSource.slice(start, end);
  assert.match(block, /window\._cardLoadSeqBySid\.delete\(sessionId\)/);
  assert.match(block, /clearCardLiveRefreshState\(sessionId\)/);
  assert.match(
    rendererSource,
    /function clearCardLiveRefreshState\(sessionId\)[\s\S]{0,120}clearCardSettleRefresh\(sessionId\)/,
  );
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
