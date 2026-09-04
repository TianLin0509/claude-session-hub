'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildTurnPresentation,
  looksLikeVerification,
  normalizeToolActivity,
  parseEmbeddedCommand,
  verificationStatus,
} = require('../core/turn-presentation.js');

test('delivery summary is deterministic from tools, checks and existing artifact paths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-turn-presentation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifactDir = path.join(root, 'artifacts');
  fs.mkdirSync(artifactDir, { recursive: true });
  const artifactPath = path.join(artifactDir, '20260903-proof.html');
  fs.writeFileSync(artifactPath, '<!doctype html><title>proof</title>', 'utf8');
  const changedPath = path.join(root, 'src', 'feature.js');

  const presentation = buildTurnPresentation({
    role: 'assistant',
    stopReason: 'end_turn',
    text: `已生成交付物。\n\n绝对路径：${artifactPath}`,
    toolCalls: [
      {
        id: 'edit-1',
        name: 'apply_patch',
        input: { command: `*** Begin Patch\n*** Update File: ${changedPath}\n*** End Patch` },
        result: 'Done',
      },
      {
        id: 'check-1',
        name: 'Bash',
        input: { command: 'npm test' },
        result: '12 tests passed',
        exitCode: 0,
        durationMs: 1250,
      },
    ],
  }, { cwd: root });

  assert.equal(presentation.source, 'deterministic');
  assert.equal(presentation.delivery.source, 'deterministic');
  assert.equal(presentation.delivery.hasContent, true);
  assert.deepEqual(presentation.delivery.changedFiles.map(item => item.path), [path.normalize(changedPath)]);
  assert.equal(presentation.delivery.checks.length, 1);
  assert.equal(presentation.delivery.checks[0].status, 'completed');
  assert.deepEqual(presentation.delivery.artifacts.map(item => item.path), [fs.realpathSync(artifactPath)]);
});

test('activity status does not claim success before a tool has a result', () => {
  assert.equal(normalizeToolActivity({ id: 'a', name: 'Bash', input: { command: 'npm test' } }).status, 'running');
  assert.equal(normalizeToolActivity({ id: 'a', name: 'Bash', input: { command: 'npm test' }, result: '' }).status, 'completed');
  assert.equal(normalizeToolActivity({ id: 'a', name: 'Bash', input: { command: 'npm test' }, exitCode: 1 }).status, 'failed');
  assert.equal(normalizeToolActivity({ id: 'a', name: 'Bash', input: { command: 'npm test' }, exitCode: null }).exitCode, null);
});

test('verification detection is narrow and embedded Codex commands are decoded', () => {
  assert.equal(looksLikeVerification('npm test'), true);
  assert.equal(looksLikeVerification('python -m pytest -q'), true);
  assert.equal(looksLikeVerification('echo test'), false);
  assert.equal(
    parseEmbeddedCommand('const r = await tools.exec_command({"cmd":"Start-Sleep -Seconds 6","shell":"powershell"});'),
    'Start-Sleep -Seconds 6',
  );
});

test('verification outcomes never call a completed tool "passed" without evidence', () => {
  assert.equal(verificationStatus({ status: 'completed', result: 'command finished' }), 'unknown');
  assert.equal(verificationStatus({ status: 'completed', exitCode: 0 }), 'completed');
  assert.equal(verificationStatus({ status: 'completed', result: 'pass 12\nfail 0' }), 'completed');
  assert.equal(verificationStatus({ status: 'completed', result: 'pass 11\nfail 1' }), 'failed');
});
