const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const transcriptIpcSrc = fs.readFileSync(path.join(root, 'main', 'ipc', 'transcript-handlers.js'), 'utf8');
const persistenceIpcSrc = fs.readFileSync(path.join(root, 'main', 'ipc', 'persistence-handlers.js'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const tapSrc = fs.readFileSync(path.join(root, 'core', 'transcript-tap.js'), 'utf8');
const sessionStoreSrc = fs.readFileSync(path.join(root, 'core', 'session-store.js'), 'utf8');

assert.ok(
  transcriptIpcSrc.includes("parseCodexRolloutToTurns"),
  'parse-session-transcript must route Codex sessions through the Codex rollout parser',
);
assert.ok(
  transcriptIpcSrc.includes("findCodexRolloutBySid"),
  'parse-session-transcript must recover persisted Codex sessions by codexSid',
);
assert.ok(
  transcriptIpcSrc.includes("findCodexRolloutByCwd"),
  'parse-session-transcript must recover Codex resume sessions without codexSid by cwd + mtime',
);
assert.ok(
  /const liveRolloutPath = hubSessionId \? transcriptTap\.getCodexRolloutPath\(hubSessionId\) : null;/.test(transcriptIpcSrc)
    && /if \(liveRolloutPath\) \{\s*transcriptPath = liveRolloutPath;\s*\}/.test(transcriptIpcSrc),
  'parse-session-transcript must prefer the live CodexTap rollout over stale renderer transcriptPath',
);
assert.ok(
  /findCodexRolloutBySid\(meta\.codexSid,\s*meta\.codexSessionsRoot\s*\|\|\s*DEFAULT_CODEX_SESSIONS_ROOT\)/.test(mainSrc),
  'resume-session must recover a Codex rollout path from persisted codexSid',
);
assert.ok(
  transcriptIpcSrc.includes('isCodexCliKind(kind)'),
  'parse-session-transcript must branch for Codex CLI variants',
);
assert.ok(
  rendererSrc.includes('isCodexSessionKind: isCodexKind'),
  'renderer must import centralized Codex session kind detection',
);
assert.ok(
  rendererSrc.includes('isClaudeFamily(kind) || isCodexKind(kind)'),
  'renderer card history gate must preserve Claude support and add Codex variants',
);
assert.ok(
  rendererSrc.includes("scheduleCodexHistoryRetry"),
  'renderer must retry transient Codex rollout binding during resume',
);
assert.ok(
  rendererSrc.includes("const cachedBeforeSelect = terminalCache.get(id);") &&
  rendererSrc.includes("const requestedBottomPin = opts && opts.forceScrollBottom === true;") &&
  rendererSrc.includes("const forceScrollBottom = !!(session && isCodexKind(session.kind) && (requestedBottomPin || !cachedBeforeSelect || !cachedBeforeSelect.opened));") &&
  rendererSrc.includes("showTerminal(id, { focus: shouldFocusTerminal, forceScrollBottom });"),
  'Codex sidebar selection must force bottom pin when requested and on first terminal mount',
);
assert.ok(
  rendererSrc.includes("selectSession(s.id, { forceScrollBottom: true })") &&
  rendererSrc.includes("selectSession(subId, { forceScrollBottom: true })"),
  'left sidebar clicks must request bottom pinning for Codex sessions',
);
assert.ok(
  rendererSrc.includes("detachFromBottom") &&
  rendererSrc.includes("cached._codexFollowBottom = false;"),
  'Codex wheel-up intent must immediately disable bottom following before the next streaming write',
);
assert.ok(
  rendererSrc.includes("loadSessionHistoryToOverlay(sessionId, { forceScrollBottom: !!opts.forceScrollBottom })") &&
  rendererSrc.includes("const _batchWasAtBottom = forceScrollBottom || (incremental ? _isCardOverlayAtBottom(container) : overlayScrollBeforeLoad.wasAtBottom);"),
  'Codex card overlay reload must honor explicit sidebar bottom pinning',
);
assert.ok(
  rendererSrc.includes("const overlayScrollBeforeLoad = {") &&
  rendererSrc.includes("const _batchWasAtBottom = forceScrollBottom || (incremental ? _isCardOverlayAtBottom(container) : overlayScrollBeforeLoad.wasAtBottom);") &&
  rendererSrc.includes("container.scrollTop = Math.min("),
  'full card reload must decide bottom state before clearing and restore user-scrolled position',
);
assert.ok(
  rendererSrc.includes("const _bodyFoldState = new Map()") &&
  rendererSrc.includes("_bodyFoldState.set(turnId, true)") &&
  rendererSrc.includes("_bodyFoldState.get(turnId) === true"),
  'card body expand/collapse state must survive incremental Codex card re-renders',
);
assert.ok(
  rendererSrc.includes("function turnRenderSignature") &&
  rendererSrc.includes("const _turnRenderSigs = new Map()") &&
  rendererSrc.includes("prevSig === nextSig"),
  'incremental card reload must skip unchanged turn replacement to avoid disrupting reading',
);
assert.ok(
  tapSrc.includes("getCodexRolloutPath(hubSessionId)"),
  'TranscriptTap must expose the bound Codex rollout path to the IPC parser',
);
assert.ok(
  /transcriptPath:\s*entry\.rolloutPath/.test(tapSrc),
  'Codex turn-complete events must carry rollout path for immediate card append',
);
assert.ok(
  /transcriptPath/.test(tapSrc) && /bind by transcriptPath failed/.test(tapSrc),
  'CodexTap must accept a persisted rollout path and bind it directly during resume',
);
assert.ok(
  /transcriptPath:\s*cur\.transcriptPath/.test(mainSrc),
  'session-bound Codex metadata must broadcast transcriptPath to renderer memory',
);
assert.ok(
  rendererSrc.includes('codexSessionsRoot: s.codexSessionsRoot || null')
    && rendererSrc.includes('codexAllowMtimeFallback: !!s.codexAllowMtimeFallback')
    && persistenceIpcSrc.includes("'codexSessionsRoot'")
    && persistenceIpcSrc.includes("'codexAllowMtimeFallback'")
    && sessionStoreSrc.includes('transcriptPath: data.transcriptPath || null')
    && sessionStoreSrc.includes('codexSessionsRoot: data.codexSessionsRoot || null'),
  'Codex card history metadata must persist transcriptPath, sessionsRoot, and mtime fallback',
);

console.log('codex single-session card view contract ok');
