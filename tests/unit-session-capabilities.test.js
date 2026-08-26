'use strict';

const assert = require('node:assert/strict');
const {
  buildSessionResumeMeta,
  nativeSessionIdentity,
  runtimeKindForSession,
  sessionModelId,
  sessionProviderFamily,
  supportsForkSession,
  supportsRecoverableSession,
} = require('../core/session-capabilities.js');

const currentDeepSeek = {
  id: 'ds-new', kind: 'deepseek', codexSid: 'codex-native',
};
const legacyDeepSeek = {
  id: 'ds-old', kind: 'deepseek', ccSessionId: 'claude-native',
};

assert.equal(runtimeKindForSession(currentDeepSeek), 'deepseek');
assert.equal(sessionProviderFamily(currentDeepSeek), 'codex');
assert.deepEqual(nativeSessionIdentity(currentDeepSeek), {
  family: 'codex', field: 'codexSid', value: 'codex-native',
});

assert.equal(runtimeKindForSession(legacyDeepSeek), 'deepseek-legacy');
assert.equal(sessionProviderFamily(legacyDeepSeek), 'claude');
assert.deepEqual(nativeSessionIdentity(legacyDeepSeek), {
  family: 'claude', field: 'ccSessionId', value: 'claude-native',
});

for (const session of [
  { kind: 'claude', ccSessionId: 'cc' },
  { kind: 'codex-resume', codexSid: 'cx' },
  currentDeepSeek,
  legacyDeepSeek,
]) {
  assert.equal(supportsRecoverableSession(session), true);
  assert.equal(supportsForkSession(session), true);
}
assert.equal(supportsForkSession({ kind: 'gemini', geminiChatId: 'g' }), false);
assert.equal(supportsRecoverableSession({ kind: 'powershell' }), false);
assert.equal(supportsRecoverableSession({ kind: 'codex', purpose: 'chuxin-research' }), true,
  'provider capability stays resumable; user-facing lifecycle policy protects Chuxin separately');
assert.equal(supportsForkSession({ kind: 'codex', purpose: 'chuxin-research' }), false);
assert.equal(sessionModelId({ kind: 'codex', currentModel: { id: 'gpt-image-gen2' } }), 'gpt-5.6-sol');
assert.equal(sessionModelId({ kind: 'codex', currentModel: { id: 'gpt-5.6-terra' } }), 'gpt-5.6-terra');

const resumeMeta = buildSessionResumeMeta({
  id: 'hub-1', kind: 'codex-resume', title: 'Codex Thread', cwd: 'C:\\repo',
  codexSid: 'native-1', codexSessionsRoot: 'C:\\codex\\sessions',
  codexProfile: 'work', codexProfileLabel: 'Work', mcpProfile: 'browser',
  currentModel: { id: 'gpt-5.5', displayName: 'GPT-5.5' },
  pinned: true, userRenamed: true, branchSourceSessionId: 'parent',
  branchAutoTitlePending: false, branchIndex: 2, contextPct: 42, effort: 'high',
  workspaceLabel: 'AI', lastMessageTime: 123, lastOutputPreview: 'done',
  completionNotificationEnabled: true,
});
assert.deepEqual({
  hubId: resumeMeta.hubId,
  kind: resumeMeta.kind,
  model: resumeMeta.model,
  codexSid: resumeMeta.codexSid,
  codexProfile: resumeMeta.codexProfile,
  mcpProfile: resumeMeta.mcpProfile,
  pinned: resumeMeta.pinned,
  userRenamed: resumeMeta.userRenamed,
  branchSourceSessionId: resumeMeta.branchSourceSessionId,
  autoTitleGenerated: resumeMeta.autoTitleGenerated,
  branchAutoTitlePending: resumeMeta.branchAutoTitlePending,
  branchIndex: resumeMeta.branchIndex,
  contextPct: resumeMeta.contextPct,
  effort: resumeMeta.effort,
  workspaceLabel: resumeMeta.workspaceLabel,
  completionNotificationEnabled: resumeMeta.completionNotificationEnabled,
}, {
  hubId: 'hub-1',
  kind: 'codex-resume',
  model: 'gpt-5.5',
  codexSid: 'native-1',
  codexProfile: 'work',
  mcpProfile: 'browser',
  pinned: true,
  userRenamed: true,
  branchSourceSessionId: 'parent',
  autoTitleGenerated: true,
  branchAutoTitlePending: false,
  branchIndex: 2,
  contextPct: 42,
  effort: 'high',
  workspaceLabel: 'AI',
  completionNotificationEnabled: true,
});

const pendingBranchMeta = buildSessionResumeMeta({
  id: 'branch-pending', kind: 'codex', title: '分支: 待命名',
  branchSourceSessionId: 'parent', branchAutoTitlePending: true,
});
assert.equal(pendingBranchMeta.autoTitleGenerated, false,
  'a pending branch title must remain eligible for the normal auto-title pass');
assert.equal(pendingBranchMeta.branchAutoTitlePending, true);

console.log('session capability matrix ok');
