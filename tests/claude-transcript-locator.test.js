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
  const validCwd = path.join(tmp, 'work', 'hub');
  fs.mkdirSync(validCwd, { recursive: true });
  const transcriptPath = path.join(projectDir, 'cc-123.jsonl');
  fs.writeFileSync(transcriptPath, JSON.stringify({ type: 'user', cwd: validCwd }) + '\n', 'utf8');

  assert.strictEqual(findTranscriptByCCSessionId('cc-123', tmp), transcriptPath);
  assert.strictEqual(findTranscriptByCCSessionId('missing', tmp), null);
  assert.strictEqual(extractCwdFromTranscript(transcriptPath), validCwd);

  const sessions = [{
    ccSessionId: 'cc-123',
    cwd: path.join(tmp, 'old'),
    cwdFellBackFrom: path.join(tmp, 'missing-original'),
    transcriptPath,
    title: 'Session A',
  }];
  const logs = [];
  assert.strictEqual(healPersistedCwds(sessions, { homeDir: tmp, logger: { log: msg => logs.push(msg) } }), 1);
  assert.strictEqual(sessions[0].cwd, validCwd);
  assert.strictEqual(sessions[0].cwdFellBackFrom, undefined, 'successful heal clears the fallback warning');
  assert.ok(logs[0].includes('heal cwd'));

  const invalidCwd = path.join(tmp, 'already-moved-away');
  const staleTranscript = path.join(projectDir, 'cc-stale.jsonl');
  fs.writeFileSync(staleTranscript, JSON.stringify({ type: 'user', cwd: invalidCwd }) + '\n', 'utf8');
  const stale = [{ ccSessionId: 'cc-stale', cwd: tmp, title: 'Stale Session', transcriptPath: staleTranscript }];
  const warnings = [];
  assert.strictEqual(healPersistedCwds(stale, {
    homeDir: tmp,
    logger: { log() {}, warn: msg => warnings.push(msg) },
  }), 0, 'a transcript that points to a deleted workspace must not be treated as healed');
  assert.strictEqual(stale[0].cwd, tmp);
  assert.ok(warnings.some(msg => msg.includes('skip invalid transcript cwd')));

  console.log('claude-transcript-locator.test.js OK');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
