const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('resume picker passes transcriptPath into created Claude resume session', () => {
  const src = read('renderer/renderer.js');
  assert.match(
    src,
    /resumeCCSessionId:\s*it\.sessionId,\s*resumeTranscriptPath:\s*it\.path/,
  );
  assert.match(
    src,
    /resumeCCSessionId:\s*h\.sessionId,\s*resumeTranscriptPath:\s*h\.path/,
  );
});

test('renderer persists and restores transcriptPath session meta', () => {
  const src = read('renderer/renderer.js');
  assert.match(src, /transcriptPath:\s*s\.transcriptPath\s*\|\|\s*null/);
  assert.match(src, /transcriptPath:\s*meta\.transcriptPath\s*\|\|\s*null/);
  assert.match(src, /transcriptPath:\s*dormant\.transcriptPath/);
  assert.match(src, /transcriptPath:\s*existing\.transcriptPath\s*\|\|\s*session\.transcriptPath/);
});

test('parse-session-transcript uses session transcriptPath before ccSession scan', () => {
  const src = read('main/ipc/transcript-handlers.js');
  const mainSrc = read('main.js');
  assert.match(src, /if\s*\(!transcriptPath\s*&&\s*session\s*&&\s*session\.transcriptPath\)/);
  assert.match(src, /updateSessionTranscriptBinding\(hubSessionId,\s*\{\s*transcriptPath\s*\}/);
  assert.match(mainSrc, /transcriptPath:\s*session\.transcriptPath\s*\|\|\s*undefined/);
});

test('TranscriptTap extractLatestTurn routes by registered backend ownership', () => {
  const src = read('core/transcript-tap.js');
  assert.match(src, /if\s*\(this\._claude\.hasSession\(hubSessionId\)\)/);
  assert.match(src, /if\s*\(this\._gemini\.hasSession\(hubSessionId\)\)/);
  assert.match(src, /if\s*\(this\._codex\.hasSession\(hubSessionId\)\)/);
});
