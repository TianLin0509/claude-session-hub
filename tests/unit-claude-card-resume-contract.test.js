const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('resume picker passes transcriptPath into created Claude resume session', () => {
  const src = read('renderer/past-session-modals.js');
  const rendererSrc = read('renderer/renderer.js');
  // 2026-10-13：「昨日之我」恢复参数抽到 renderer/search-hit-resume.js（CodeAgent 记录走 codeagent-resume）。
  const searchResumeSrc = read('renderer/search-hit-resume.js');
  assert.match(rendererSrc, /resumeRequestForSearchHit\(hit,/, 'global search resume goes through search-hit-resume.js');
  assert.match(
    src,
    /resumeCCSessionId:\s*it\.sessionId,\s*resumeTranscriptPath:\s*it\.path/,
  );
  assert.match(
    searchResumeSrc,
    /resumeTranscriptPath:\s*hit\.transcriptPath\s*\|\|\s*undefined/,
    'global search resume must keep the exact indexed transcript path',
  );
  assert.match(
    searchResumeSrc,
    /opts\.resumeCCSessionId\s*=\s*hit\.nativeSessionId/,
    'global search must resume the exact Claude native session id',
  );
});

test('renderer persists and restores transcriptPath session meta', () => {
  const src = read('renderer/renderer.js');
  assert.match(src, /transcriptPath:\s*s\.transcriptPath\s*\|\|\s*null/);
  assert.match(src, /transcriptPath:\s*meta\.transcriptPath\s*\|\|\s*null/);
  assert.match(src, /buildSessionResumeMeta\(dormant\)/,
    'dormant wake should use the shared provider-native resume metadata contract');
  assert.match(src, /transcriptPath:\s*session\.transcriptPath\s*\|\|\s*existing\.transcriptPath/);
  assert.match(src, /transcriptPath:\s*resumed\.transcriptPath\s*\|\|\s*s\.transcriptPath/);
  assert.match(src, /const wasDormant = !!pendingResume \|\|/);
  assert.match(src, /resumeDormantSession\(id, opts\)/);
});

test('parse-session-transcript uses session transcriptPath before ccSession scan', () => {
  const src = read('main/ipc/transcript-handlers.js');
  const mainSrc = read('main.js');
  const authoritativePath = src.indexOf(
    'transcriptPath = session && session.transcriptPath ? session.transcriptPath : null;',
  );
  const rendererFallback = src.indexOf('if (!transcriptPath && inPath)', authoritativePath);
  const ccSessionFallback = src.indexOf('if (!transcriptPath && ccSessionId)', authoritativePath);
  assert.ok(authoritativePath >= 0, 'main-process session path must be the Claude authority');
  assert.ok(rendererFallback > authoritativePath, 'renderer path must remain a fallback');
  assert.ok(ccSessionFallback > rendererFallback, 'ccSession scan must run after bound paths');
  assert.match(src, /updateSessionTranscriptBinding\(hubSessionId,\s*\{\s*transcriptPath\s*\}/);
  assert.match(mainSrc, /transcriptPath:\s*session\.transcriptPath\s*\|\|\s*undefined/);
});

test('TranscriptTap extractLatestTurn routes by registered backend ownership', () => {
  const src = read('core/transcript-tap.js');
  assert.match(src, /if\s*\(this\._claude\.hasSession\(hubSessionId\)\)/);
  assert.match(src, /if\s*\(this\._gemini\.hasSession\(hubSessionId\)\)/);
  assert.match(src, /if\s*\(this\._codex\.hasSession\(hubSessionId\)\)/);
});
