'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { effortConfirmed, setPtyClaudeEffort, PTY_CLAUDE_EFFORTS } = require('../core/claude-pty-effort');

// 样本取自 Claude Code 2.1.310 真实 transcript 的 local-command-stdout。
test('recognises the real /effort confirmations and nothing looser', () => {
  assert.ok(effortConfirmed('<local-command-stdout>Set effort level to high (saved as your default for new sessions): Comprehensive', 'high'));
  assert.ok(effortConfirmed('Set effort level to max (this session only): Maximum capability', 'max'));
  assert.ok(effortConfirmed('Effort level set to auto', 'auto'));
  assert.equal(effortConfirmed('Set effort level to xhigh (saved', 'high'), false);
  assert.equal(effortConfirmed('Set effort level to high', 'xhigh'), false);
  assert.equal(effortConfirmed('/effort high', 'high'), false, 'the echoed command alone is not a confirmation');
  assert.deepEqual(PTY_CLAUDE_EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max']);
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-effort-'));
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, '{"old":"Set effort level to high (saved as your default for new sessions)"}\n');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ theme: 'light', effortLevel: 'medium' }));
  return { dir, transcript };
}

test('confirms from new transcript lines only, then restores the account default', async () => {
  const { dir, transcript } = fixture();
  const sent = [];
  const result = await setPtyClaudeEffort({
    session: { transcriptPath: transcript }, effort: 'high', configDir: dir, wait: async () => {},
    send: async (text, observer) => {
      sent.push(text);
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ theme: 'light', effortLevel: 'high' }));
      fs.appendFileSync(transcript, '{"content":"<local-command-stdout>Set effort level to high (saved as your default for new sessions)"}\n');
      return { ok: true };
    },
  });
  assert.deepEqual(sent, ['/effort high']);
  assert.equal(result.ok, true);
  assert.equal(result.defaultRestored, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')), { theme: 'light', effortLevel: 'medium' });
});

test('an old confirmation already in the transcript never counts', async () => {
  const { dir, transcript } = fixture();
  const result = await setPtyClaudeEffort({ session: { transcriptPath: transcript }, effort: 'high', configDir: dir,
    wait: async () => {}, timeoutMs: 300, send: async (_text, observer) => ({ ok: (await observer.wait()).ok }) });
  assert.equal(result.ok, false);
});

test('rejects unknown levels, unbound transcripts and unsent commands without claiming success', async () => {
  const { dir, transcript } = fixture();
  const send = async () => ({ ok: true });
  assert.equal((await setPtyClaudeEffort({ session: { transcriptPath: transcript }, effort: 'ultracode', configDir: dir, send })).ok, false);
  assert.equal((await setPtyClaudeEffort({ session: {}, effort: 'high', configDir: dir, send })).ok, false);
  const stuck = await setPtyClaudeEffort({ session: { transcriptPath: transcript }, effort: 'high', configDir: dir,
    send: async () => ({ ok: false, sendStatus: 'stuck', message: '未确认提交' }) });
  assert.equal(stuck.ok, false);
  assert.match(stuck.message, /未确认提交/);
});
