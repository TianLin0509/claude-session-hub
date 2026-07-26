const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  CLAUDE_PROJECT_ROOT_DIRS,
  claudeProjectRoots,
  extractCwdFromTranscript,
  findTranscriptByCCSessionId,
  healPersistedCwds,
} = require('../core/claude-transcript-locator.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-claude-locator-'));
try {
  assert.ok(CLAUDE_PROJECT_ROOT_DIRS.includes('.claude-deepseek'));
  assert.strictEqual(claudeProjectRoots(tmp).length, CLAUDE_PROJECT_ROOT_DIRS.length);

  const projectDir = path.join(tmp, '.claude-deepseek', 'projects', 'proj-a');
  fs.mkdirSync(projectDir, { recursive: true });
  const transcriptPath = path.join(projectDir, 'cc-123.jsonl');
  fs.writeFileSync(transcriptPath, '{"type":"user","cwd":"C:\\\\work\\\\hub"}\n', 'utf8');

  assert.strictEqual(findTranscriptByCCSessionId('cc-123', tmp), transcriptPath);
  assert.strictEqual(findTranscriptByCCSessionId('missing', tmp), null);
  assert.strictEqual(extractCwdFromTranscript(transcriptPath), 'C:\\work\\hub');

  const sessions = [{ ccSessionId: 'cc-123', cwd: 'C:\\old', title: 'Session A' }];
  const logs = [];
  assert.strictEqual(healPersistedCwds(sessions, { homeDir: tmp, logger: { log: msg => logs.push(msg) } }), 1);
  assert.strictEqual(sessions[0].cwd, 'C:\\work\\hub');
  assert.ok(logs[0].includes('heal cwd'));

  console.log('claude-transcript-locator.test.js OK');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
