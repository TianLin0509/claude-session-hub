const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const sessionManagerSrc = fs.readFileSync(path.join(root, 'core', 'session-manager.js'), 'utf8');

function test(name, fn) {
  try {
    fn();
    console.log('  PASS ' + name);
  } catch (err) {
    console.error('  FAIL ' + name);
    console.error('    ' + err.message);
    process.exitCode = 1;
  }
}

console.log('Running codex session UX stability contracts...');

test('status-event only updates context fields when the payload carries them', () => {
  assert.match(rendererSrc, /hasOwnProperty\.call\(payload, 'contextPct'\)/);
  assert.match(rendererSrc, /hasOwnProperty\.call\(payload, 'contextUsed'\)/);
  assert.match(rendererSrc, /hasOwnProperty\.call\(payload, 'contextMax'\)/);
});

test('dormant persistence keeps context badges and user rename state', () => {
  assert.match(rendererSrc, /contextPct:\s*typeof s\.contextPct === 'number'/);
  assert.match(rendererSrc, /contextPct:\s*typeof meta\.contextPct === 'number'/);
  assert.match(mainSrc, /'contextPct', 'contextUsed', 'contextMax', 'userRenamed'/);
});

test('resume preserves card view and reloads Codex cards after sid binding', () => {
  assert.match(rendererSrc, /applyViewMode\(wasDormant \? currentView : 'pty'\)/);
  assert.match(rendererSrc, /session-meta-updated[\s\S]*loadSessionHistoryToOverlay\(ev\.hubSessionId\)/);
});

test('xterm resize goes through the de-jittered fit helper', () => {
  assert.match(rendererSrc, /function fitAndResizeTerminal/);
  assert.match(rendererSrc, /_lastFitBoxSig/);
  assert.match(rendererSrc, /_lastResizeSig/);
  assert.match(sessionManagerSrc, /conptyInheritCursor:\s*isCodex \? false : !opts\.noInheritCursor/);
});

test('first prompt can auto-title generic Codex sessions without overwriting manual renames', () => {
  assert.match(mainSrc, /function maybeAutoTitleSessionFromPrompt/);
  assert.match(mainSrc, /generateSessionTitleFromPrompt/);
  assert.match(mainSrc, /ALL_AI_KINDS/);
  assert.match(mainSrc, /isAutoTitleSessionKind\(session\.kind\)/);
  assert.match(mainSrc, /latest\.userRenamed/);
  assert.match(mainSrc, /latest\.autoTitleGenerated/);
  assert.match(rendererSrc, /!session\.userRenamed && !session\.autoTitleGenerated/);
  assert.match(rendererSrc, /rename-session', \{ sessionId, title: trimmed, userRenamed: true \}/);
});

test('roundtable and group-chat rooms can auto-title only default names', () => {
  assert.match(mainSrc, /function maybeAutoTitleMeetingFromPrompt/);
  assert.match(mainSrc, /AUTO_TITLE_MEETING_RE/);
  assert.match(mainSrc, /safe\.autoTitlePending = !hasCustomTitle/);
  assert.match(mainSrc, /maybeAutoTitleMeetingFromPrompt\(meetingId, userInput \|\| ''\)/);
  assert.match(mainSrc, /autoTitleGenerated: true/);
});
