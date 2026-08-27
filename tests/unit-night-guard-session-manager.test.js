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
