'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = path.join(os.tmpdir(), `hub-live-membership-core-${process.pid}-${Date.now()}`);
process.env.CLAUDE_HUB_DATA_DIR = testDir;

const meetingStore = require('../core/meeting-store');
const { MeetingRoomManager } = require('../core/meeting-room');
const { registerMeetingIpc } = require('../main/ipc/meeting-handlers');

console.log('Running live membership MeetingRoomManager tests...');

let meetingId = null;
try {
  const manager = new MeetingRoomManager();
  const created = manager.createMeeting({
    title: 'live membership core test',
    participants: [0, 1, 2],
  });
  meetingId = created.id;
  manager.addSubSession(created.id, 's1');
  manager.addSubSession(created.id, 's2');
  manager.addSubSession(created.id, 's3');
  manager.setSlotSpecs(created.id, [
    { kind: 'claude' },
    { kind: 'codex' },
    { kind: 'gemini' },
  ]);

  const workflow = {
    schemaVersion: 2,
    enabled: true,
    steps: [['m1'], ['m2', 'm3']],
    stepConfigs: [{ name: '执行', prompt: '实现' }, { name: '评审', prompt: '验证' }],
    loop: { enabled: true, maxRounds: 3 },
  };
  const updated = manager.updateMeeting(created.id, { serialWorkflow: workflow });
  assert.deepStrictEqual(updated.serialWorkflow, workflow, 'real manager must accept serialWorkflow updates');

  workflow.steps[0].push('m3');
  assert.deepStrictEqual(
    manager.getMeeting(created.id).serialWorkflow.steps,
    [['m1'], ['m2', 'm3']],
    'manager must not retain renderer-owned workflow references'
  );

  meetingStore.flushAll();
  assert.deepStrictEqual(
    meetingStore.loadMeetingFile(created.id).serialWorkflow.steps,
    [['m1'], ['m2', 'm3']],
    'serialWorkflow must survive per-meeting persistence'
  );

  const ipc = {
    handlers: new Map(),
    listeners: new Map(),
    handle(channel, fn) { this.handlers.set(channel, fn); },
    on(channel, fn) { this.listeners.set(channel, fn); },
  };
  const closed = [];
  registerMeetingIpc(ipc, {
    getHubDataDir: () => testDir,
    groupchat: {
      getOrchestrator: () => ({ getState: () => ({ currentMode: 'idle' }) }),
      cleanup() {},
    },
    meetingManager: manager,
    scenes: {
      COVENANT_RESEARCH: '',
      getScene: () => null,
    },
    sendToRenderer() {},
    sessionManager: { closeSession: sid => closed.push(sid) },
    sessionStore: { deleteSessionFile() {}, cancelDirty() {} },
    stateStore: { save() {}, markRemovedSession() {}, markRemovedMeeting() {} },
  });

  const removal = ipc.handlers.get('remove-meeting-sub')(null, {
    meetingId: created.id,
    sessionId: 's2',
  });
  assert.strictEqual(removal.ok, true);
  assert.deepStrictEqual(removal.meeting.participants, [0, 1]);
  assert.deepStrictEqual(removal.meeting.slotSpecs, [
    { kind: 'claude' },
    { kind: 'gemini' },
  ]);
  assert.deepStrictEqual(removal.meeting.serialWorkflow.steps, [['m1'], ['m2']]);
  assert.deepStrictEqual(removal.meeting.serialWorkflow.stepConfigs, [
    { name: '执行', prompt: '实现' },
    { name: '评审', prompt: '验证' },
  ]);
  assert.deepStrictEqual(closed, ['s2']);

  meetingStore.flushAll();
  const persistedAfterRemoval = meetingStore.loadMeetingFile(created.id);
  assert.deepStrictEqual(persistedAfterRemoval.subSessions, ['s1', 's3']);
  assert.deepStrictEqual(persistedAfterRemoval.participants, [0, 1]);
  assert.deepStrictEqual(persistedAfterRemoval.slotSpecs, [
    { kind: 'claude' },
    { kind: 'gemini' },
  ]);
  assert.deepStrictEqual(persistedAfterRemoval.serialWorkflow.steps, [['m1'], ['m2']]);
  assert.deepStrictEqual(persistedAfterRemoval.serialWorkflow.stepConfigs, [
    { name: '执行', prompt: '实现' },
    { name: '评审', prompt: '验证' },
  ]);

  const restored = new MeetingRoomManager();
  restored.restoreMeeting(manager.getMeeting(created.id));
  assert.deepStrictEqual(
    restored.getMeeting(created.id).serialWorkflow.steps,
    [['m1'], ['m2']],
    'serialWorkflow must survive manager restore'
  );

  console.log('  OK real manager accepts and clones serialWorkflow');
  console.log('  OK real remove handler reindexes and persists all dependent state');
} finally {
  if (meetingId) meetingStore.cancelDirty(meetingId);
  const resolved = path.resolve(testDir);
  if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('hub-live-membership-core-')) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
