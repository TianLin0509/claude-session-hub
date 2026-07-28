'use strict';
// Archiving a scratch workspace renames its directory. Claude CLI buckets
// transcripts by cwd, so without migrating the .jsonl the post-archive
// `--resume <id>` dies with "No conversation found with session ID" and the whole
// conversation is lost. These tests pin the migration and its wiring.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  migrateTranscriptsForCwdChange,
  projectSlug,
} = require('../core/claude-transcript-locator.js');

const HANDLER_SRC = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'workspace-handlers.js'), 'utf8');

function test(name, fn) {
  try {
    fn();
    console.log(`  OK ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

console.log('Running archive transcript migration tests...');

test('projectSlug matches the Claude CLI bucket naming', () => {
  assert.strictEqual(projectSlug('C:\\Users\\lintian'), 'C--Users-lintian');
  assert.strictEqual(
    projectSlug('C:\\Vibe\\_scratch\\inbox-20260727-004157-5d6346'),
    'C--Vibe--scratch-inbox-20260727-004157-5d6346',
  );
});

test('transcripts are copied into the new cwd bucket, under the same CLI root', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-migrate-'));
  try {
    const oldCwd = 'C:\\Vibe\\_scratch\\inbox-abc';
    const newCwd = 'C:\\Vibe\\AI\\my-task';
    // deepseek lives under .claude-deepseek; the copy must stay in that root.
    const oldDir = path.join(home, '.claude-deepseek', 'projects', projectSlug(oldCwd));
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'cc-1.jsonl'), '{"type":"user"}\n', 'utf8');

    const result = migrateTranscriptsForCwdChange({
      toCwd: newCwd,
      ccSessionIds: ['cc-1', 'cc-missing'],
      homeDir: home,
      logger: { warn() {} },
    });

    const expected = path.join(home, '.claude-deepseek', 'projects', projectSlug(newCwd), 'cc-1.jsonl');
    assert.ok(fs.existsSync(expected), 'transcript must land in the new bucket');
    assert.deepStrictEqual(result.copied, [expected]);
    assert.deepStrictEqual(result.missing, ['cc-missing']);
    assert.deepStrictEqual(result.errors, []);
    assert.ok(fs.existsSync(path.join(oldDir, 'cc-1.jsonl')), 'source is copied, not moved');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('re-archiving to the same path is a no-op rather than a self-copy error', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-migrate-same-'));
  try {
    const cwd = 'C:\\Vibe\\AI\\my-task';
    const dir = path.join(home, '.claude', 'projects', projectSlug(cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cc-2.jsonl'), '{"type":"user"}\n', 'utf8');

    const result = migrateTranscriptsForCwdChange({
      toCwd: cwd,
      ccSessionIds: ['cc-2'],
      homeDir: home,
      logger: { warn() {} },
    });
    assert.deepStrictEqual(result.errors, []);
    assert.deepStrictEqual(result.missing, []);
    assert.strictEqual(result.copied.length, 1);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'cc-2.jsonl'), 'utf8'), '{"type":"user"}\n');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('migration runs before resumeAll and only for cwd-bound CLI kinds', () => {
  const migrateAt = HANDLER_SRC.indexOf('migrateTranscriptsForCwdChange({');
  const resumeAt = HANDLER_SRC.indexOf('const restart = await resumeAll(');
  assert.ok(migrateAt > 0, 'archive flow must migrate transcripts');
  assert.ok(resumeAt > migrateAt, 'migration must happen before the CLIs are resumed');
  assert.match(
    HANDLER_SRC,
    /CWD_BOUND_TRANSCRIPT_KINDS = new Set\(\['claude', 'deepseek'\]\)/,
    'codex rollouts and gemini project roots are not cwd-bucketed and must be left alone',
  );
  assert.match(HANDLER_SRC, /toCwd: workspace\.path/, 'migration target must be the archived path');
});

if (!process.exitCode) console.log('All archive transcript migration tests passed.');
