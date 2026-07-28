'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkspaceService } = require('../core/workspace-service.js');
const { registerWorkspaceIpc } = require('../main/ipc/workspace-handlers.js');

(async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-workspace-archive-ipc-'));
  try {
    const workspaceRoot = path.join(tempRoot, 'Vibe');
    const dataDir = path.join(tempRoot, 'hub-data');
    const toolsDir = path.join(workspaceRoot, 'Tools');
    fs.mkdirSync(toolsDir, { recursive: true });
    const workspaceService = new WorkspaceService({
      getHubDataDir: () => dataDir,
      isIsolatedHub: () => true,
      workspaceRoot,
      initGit: () => true,
      logger: { warn() {}, error() {} },
      randomId: () => 'draft1',
    });
    const scratch = workspaceService.createScratchWorkspace({ label: 'Hub 归档流程' });
    workspaceService.updateSuggestedName(scratch.path, 'Hub 归档流程');
    fs.writeFileSync(path.join(scratch.path, 'work.txt'), 'preserve me', 'utf8');

    const handlers = new Map();
    const sessions = new Map([
      ['s1', {
        id: 's1', kind: 'codex', title: 'Hub 归档流程', cwd: scratch.path,
        codexSid: '11111111-1111-4111-8111-111111111111',
        currentModel: { id: 'gpt-5.4' }, autoTitleGenerated: true,
      }],
    ]);
    const events = [];
    const migrationIds = new Set();
    const sessionManager = {
      getSession: id => sessions.get(id),
      getAllSessions: () => [...sessions.values()],
      closeSession(id) { sessions.delete(id); },
    };
    const meetingManager = {
      getMeeting() { return null; },
      getAllMeetings() { return []; },
    };

    registerWorkspaceIpc({
      handle(name, fn) { handlers.set(name, fn); },
    }, {
      dialog: { showOpenDialog: async () => ({ canceled: true }) },
      meetingManager,
      resumeSession: async meta => {
        const resumed = { id: meta.hubId, kind: meta.kind, title: meta.title, cwd: meta.cwd, workspaceLabel: meta.workspaceLabel };
        sessions.set(resumed.id, resumed);
        return resumed;
      },
      sendToRenderer: (channel, payload) => events.push({ channel, payload }),
      sessionManager,
      shell: { openPath: async () => '' },
      workspaceMigrationSessionIds: migrationIds,
      workspaceService,
    });

    const context = handlers.get('workspace:archive-context')(null, { scope: 'session', id: 's1' });
    assert.equal(context.required, true);
    assert.equal(context.resumeReady, true);
    assert.equal(context.categories.some(item => item.name === 'Tools'), true);

    const result = await handlers.get('workspace:archive-and-restart')(null, {
      scope: 'session', id: 's1', parent: toolsDir, folderName: 'hub-archive-flow',
    });
    assert.equal(result.ok, true);
    assert.equal(result.resumedSessionIds[0], 's1');
    assert.equal(fs.existsSync(scratch.path), false);
    assert.equal(fs.readFileSync(path.join(result.workspace.path, 'work.txt'), 'utf8'), 'preserve me');
    assert.equal(sessions.get('s1').cwd, result.workspace.path);
    assert.equal(migrationIds.size, 0);
    assert.equal(events.some(event => event.channel === 'workspace-updated'), true);

    const unsafeScratch = workspaceService.createScratchWorkspace({ label: '尚未绑定' });
    sessions.set('s2', { id: 's2', kind: 'codex', title: '尚未绑定', cwd: unsafeScratch.path });
    const unsafeContext = handlers.get('workspace:archive-context')(null, { scope: 'session', id: 's2' });
    assert.equal(unsafeContext.resumeReady, false);
    await assert.rejects(
      handlers.get('workspace:archive-and-restart')(null, {
        scope: 'session', id: 's2', parent: toolsDir, folderName: 'must-not-move',
      }),
      /尚未绑定 Codex session ID/,
    );
    assert.equal(fs.existsSync(unsafeScratch.path), true, 'unsafe fallback resume must not move the draft');
    assert.equal(sessions.has('s2'), true, 'unsafe fallback resume must not close the live CLI');

    console.log('unit-workspace-archive-ipc: PASS');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
