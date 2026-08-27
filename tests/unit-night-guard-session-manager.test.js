'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionManager } = require('../core/session-manager.js');

test('host-shell night guard relaunch resumes the exact SID with one quoted follow-up prompt', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-night-guard-resume-'));
  const writes = [];
  const manager = new SessionManager();
  const sid = '11111111-1111-4111-8111-111111111111';
  try {
    fs.writeFileSync(path.join(configDir, 'config.toml'), '', 'utf8');
    manager.sessions.set('s1', {
      info: {
        id: 's1', kind: 'codex', cwd: 'C:\\work', codexSid: sid,
        currentModel: { id: 'gpt-5.6-sol' }, effort: 'max', mcpProfile: 'none',
        codexSessionsRoot: path.join(configDir, 'sessions'),
      },
      pty: { write: data => writes.push(data), kill() {} },
      pendingTimers: new Set(),
      codexMcpEntries: [],
      ringBuffer: 'PS C:\\work> ',
    });
    assert.equal(manager.relaunchCli('s1', {
      resume: true,
      prompt: "继续未完成任务，不要重复已完成步骤。",
      trigger: 'night-guard-resume',
    }), true);
    const command = writes.join('');
    assert.match(command, new RegExp(`codex resume '${sid}'`));
    assert.match(command, /--model gpt-5\.6-sol/);
    assert.match(command, /'继续未完成任务，不要重复已完成步骤。'/);
    assert.equal((command.match(/codex resume/g) || []).length, 1);
    assert.equal(manager.getManagedLaunchAudit('s1')[0].trigger, 'night-guard-resume');
  } finally {
    manager.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('Claude host-shell night guard relaunch resumes the exact ccSessionId with one prompt', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-night-guard-claude-resume-'));
  const previousDataDir = process.env.CLAUDE_HUB_DATA_DIR;
  const writes = [];
  const manager = new SessionManager();
  const ccSessionId = '22222222-2222-4222-8222-222222222222';
  const recoveryPrompt = 'Continue the unfinished task after checking the current workspace state.';
  try {
    process.env.CLAUDE_HUB_DATA_DIR = dataDir;
    manager.sessions.set('claude-1', {
      info: {
        id: 'claude-1', kind: 'claude', cwd: 'C:\\work', ccSessionId,
        currentModel: { id: 'claude-opus-5' }, effort: 'max', mcpProfile: 'none',
        fastMode: false,
      },
      pty: { write: data => writes.push(data), kill() {} },
      pendingTimers: new Set(),
      ringBuffer: 'PS C:\\work> ',
    });
    assert.equal(manager.relaunchCli('claude-1', {
      resume: true,
      prompt: recoveryPrompt,
      trigger: 'night-guard-resume',
    }), true);
    const command = writes.join('');
    assert.match(command, new RegExp(`claude --resume '${ccSessionId}'`));
    assert.match(command, /--model claude-opus-5/);
    assert.match(command, /--effort max/);
    assert.match(command, new RegExp(`'${recoveryPrompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
    assert.equal((command.match(/claude --resume/g) || []).length, 1);
    assert.equal((command.match(/Continue the unfinished task/g) || []).length, 1);
  } finally {
    manager.dispose();
    if (previousDataDir === undefined) delete process.env.CLAUDE_HUB_DATA_DIR;
    else process.env.CLAUDE_HUB_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
