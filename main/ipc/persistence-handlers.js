'use strict';

const { isDeepStrictEqual } = require('node:util');

// 注意：memoryLinkWarning **故意不在这个名单里**。这里的语义是「新会话缺该字段就继承旧值」，
// 而 memory link 每次 spawn 都会重新检测——放进来会让警告一旦出现就永久粘住，修好了也删不掉
// （cwdFellBackFrom 能放是因为 healPersistedCwds 里有显式 delete 清除路径，它没有）。
const RESUME_META_FIELDS = [
  'cwdFellBackFrom',
  'transcriptPath',
  'codexSid',
  'codexSessionsRoot',
  'codexAllowMtimeFallback',
  'codexProfile',
  'codexProfileLabel',
  'geminiChatId',
  'geminiProjectHash',
  'geminiProjectRoot',
  'kimiSid',
  'kimiSessionDir',
  'currentModel',
  'contextPct',
  'contextUsed',
  'contextMax',
  'userRenamed',
  'autoTitleGenerated',
  'purpose',
  'researchSessionId',
  'chuxinTaskId',
  'heroIds',
  'promptPolicyVersion',
  'hiddenFromSidebar',
];

function withoutVolatileTimestamps(entity) {
  if (!entity || typeof entity !== 'object') return entity;
  const { updatedAt: _updatedAt, savedAt: _savedAt, ...stable } = entity;
  return stable;
}

function persistentEntityEquals(left, right) {
  if (!left || !right) return left === right;
  return isDeepStrictEqual(
    withoutVolatileTimestamps(left),
    withoutVolatileTimestamps(right),
  );
}

function mergeResumeMetaFields(list, previousSessions) {
  const oldByHubId = new Map((previousSessions || []).map(s => [s.hubId, s]));
  for (const newSession of list || []) {
    if (!newSession || !newSession.hubId) continue;
    const oldSession = oldByHubId.get(newSession.hubId);
    if (!oldSession) continue;
    for (const field of RESUME_META_FIELDS) {
      if (field === 'userRenamed' && oldSession.userRenamed === true) {
        newSession.userRenamed = true;
        continue;
      }
      if (newSession[field] == null && oldSession[field] != null) {
        newSession[field] = oldSession[field];
      }
    }
  }
  return list;
}

function buildMeetingsForState(meetingList, meetingManager) {
  if (!Array.isArray(meetingList)) {
    return meetingManager.getAllMeetings();
  }
  return meetingList.map(rendererMeeting => {
    if (!rendererMeeting || !rendererMeeting.id) return rendererMeeting;
    const authoritative = meetingManager.getMeeting(rendererMeeting.id);
    if (!authoritative) return rendererMeeting;
    return {
      ...rendererMeeting,
      scene: rendererMeeting.scene || authoritative.scene,
      mode: rendererMeeting.mode || authoritative.mode,
      groupChat: typeof rendererMeeting.groupChat === 'boolean'
        ? rendererMeeting.groupChat
        : !!authoritative.groupChat,
      groupMode: rendererMeeting.groupMode || authoritative.groupMode || 'deliberation',
      groupRecentRawN: Number.isInteger(rendererMeeting.groupRecentRawN)
        ? rendererMeeting.groupRecentRawN
        : (Number.isInteger(authoritative.groupRecentRawN) ? authoritative.groupRecentRawN : 5),
      userRenamed: typeof rendererMeeting.userRenamed === 'boolean'
        ? rendererMeeting.userRenamed
        : !!authoritative.userRenamed,
      autoTitlePending: typeof rendererMeeting.autoTitlePending === 'boolean'
        ? rendererMeeting.autoTitlePending
        : !!authoritative.autoTitlePending,
      autoTitleGenerated: typeof rendererMeeting.autoTitleGenerated === 'boolean'
        ? rendererMeeting.autoTitleGenerated
        : !!authoritative.autoTitleGenerated,
      participants: Array.isArray(rendererMeeting.participants)
        ? rendererMeeting.participants
        : (Array.isArray(authoritative.participants) ? authoritative.participants : null),
      slotSpecs: Array.isArray(rendererMeeting.slotSpecs)
        ? rendererMeeting.slotSpecs
        : (Array.isArray(authoritative.slotSpecs) ? authoritative.slotSpecs : null),
      covenantText: (typeof rendererMeeting.covenantText === 'string' && rendererMeeting.covenantText)
        ? rendererMeeting.covenantText
        : (authoritative.covenantText || ''),
      // 串行工作流配置（2026-06-17 道雪）：state.json 是 boot 恢复源，必须带上；
      //   优先 renderer 值，兜底后端权威（update-meeting 已写入 authoritative）
      serialWorkflow: (rendererMeeting.serialWorkflow && typeof rendererMeeting.serialWorkflow === 'object')
        ? rendererMeeting.serialWorkflow
        : (authoritative.serialWorkflow || null),
    };
  });
}

function handlePersistSessions(list, meetingList, deps) {
  if (!Array.isArray(list)) return false;

  const {
    getImmersiveByMeeting,
    getLastPersistedMeetingIds,
    getLastPersistedMeetings = () => [],
    getLastPersistedSessionIds,
    getLastPersistedSessions,
    meetingManager,
    meetingStore,
    sessionStore,
    setLastPersistedMeetingIds,
    setLastPersistedMeetings = () => {},
    setLastPersistedSessionIds,
    setLastPersistedSessions,
    stateStore,
  } = deps;

  const previousSessions = getLastPersistedSessions();
  const previousSessionsById = new Map(
    (previousSessions || []).filter(Boolean).map(session => [session.hubId, session]),
  );
  mergeResumeMetaFields(list, previousSessions);

  const nowTs = Date.now();
  let changedSessions = 0;
  let changedMeetings = 0;
  let removedEntities = 0;

  const newSessionIds = new Set(list.map(session => session && session.hubId).filter(Boolean));
  for (const oldId of getLastPersistedSessionIds()) {
    if (!newSessionIds.has(oldId)) {
      stateStore.markRemovedSession(oldId);
      sessionStore.deleteSessionFile(oldId);
      sessionStore.cancelDirty(oldId);
      removedEntities += 1;
    }
  }
  setLastPersistedSessionIds(newSessionIds);

  for (const session of list) {
    if (!session || !session.hubId) continue;
    const previous = previousSessionsById.get(session.hubId);
    const changed = !previous
      || typeof previous.updatedAt !== 'number'
      || !persistentEntityEquals(session, previous);
    if (changed) {
      session.updatedAt = nowTs;
      sessionStore.markDirty(session.hubId, session);
      changedSessions += 1;
    } else {
      session.updatedAt = previous.updatedAt;
    }
  }

  setLastPersistedSessions(list);

  const meetingsForState = buildMeetingsForState(meetingList, meetingManager);
  const previousMeetings = getLastPersistedMeetings();
  const previousMeetingsById = new Map(
    (previousMeetings || []).filter(Boolean).map(meeting => [meeting.id, meeting]),
  );

  const newMeetingIds = new Set(meetingsForState.map(meeting => meeting && meeting.id).filter(Boolean));
  for (const oldId of getLastPersistedMeetingIds()) {
    if (!newMeetingIds.has(oldId)) {
      stateStore.markRemovedMeeting(oldId);
      meetingStore.deleteMeetingFile(oldId);
      meetingStore.cancelDirty(oldId);
      removedEntities += 1;
    }
  }
  setLastPersistedMeetingIds(newMeetingIds);

  const immersiveByMeeting = getImmersiveByMeeting();
  for (const meeting of meetingsForState) {
    if (meeting && meeting.id) {
      const immersive = immersiveByMeeting[meeting.id];
      if (typeof immersive === 'boolean') meeting.immersive = immersive;
      const previous = previousMeetingsById.get(meeting.id);
      const changed = !previous
        || typeof previous.updatedAt !== 'number'
        || !persistentEntityEquals(meeting, previous);
      if (changed) {
        meeting.updatedAt = nowTs;
        meetingStore.markDirty(meeting.id, meeting);
        changedMeetings += 1;
      } else {
        meeting.updatedAt = previous.updatedAt;
      }
    }
  }

  setLastPersistedMeetings(meetingsForState);

  if (changedSessions > 0 || changedMeetings > 0 || removedEntities > 0) {
    stateStore.save({
      version: 1,
      cleanShutdown: false,
      sessions: list,
      meetings: meetingsForState,
      immersiveByMeeting,
    });
  }

  return true;
}

function registerPersistenceIpc(ipcMain, deps) {
  ipcMain.handle('get-dormant-sessions', () => ({
    sessions: deps.getLastPersistedSessions(),
    wasCleanShutdown: deps.bootWasClean,
  }));

  ipcMain.on('persist-sessions', (_e, list, meetingList) => {
    handlePersistSessions(list, meetingList, deps);
  });
}

module.exports = {
  RESUME_META_FIELDS,
  buildMeetingsForState,
  handlePersistSessions,
  mergeResumeMetaFields,
  persistentEntityEquals,
  registerPersistenceIpc,
};
