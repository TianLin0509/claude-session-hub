'use strict';

const RESUME_META_FIELDS = [
  'transcriptPath',
  'codexSid',
  'codexAppThreadId',
  'codexSessionsRoot',
  'codexAllowMtimeFallback',
  'codexProfile',
  'codexProfileLabel',
  'geminiChatId',
  'geminiProjectHash',
  'geminiProjectRoot',
  'currentModel',
  'contextPct',
  'contextUsed',
  'contextMax',
  'userRenamed',
  'autoTitleGenerated',
];

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
    };
  });
}

function handlePersistSessions(list, meetingList, deps) {
  if (!Array.isArray(list)) return false;

  const {
    getImmersiveByMeeting,
    getLastPersistedMeetingIds,
    getLastPersistedSessionIds,
    getLastPersistedSessions,
    meetingManager,
    meetingStore,
    sessionStore,
    setLastPersistedMeetingIds,
    setLastPersistedSessionIds,
    setLastPersistedSessions,
    stateStore,
  } = deps;

  mergeResumeMetaFields(list, getLastPersistedSessions());

  const nowTs = Date.now();
  for (const session of list) {
    if (session && session.hubId) session.updatedAt = nowTs;
  }

  const newSessionIds = new Set(list.map(session => session && session.hubId).filter(Boolean));
  for (const oldId of getLastPersistedSessionIds()) {
    if (!newSessionIds.has(oldId)) {
      stateStore.markRemovedSession(oldId);
      sessionStore.deleteSessionFile(oldId);
      sessionStore.cancelDirty(oldId);
    }
  }
  setLastPersistedSessionIds(newSessionIds);

  for (const session of list) {
    if (session && session.hubId) sessionStore.markDirty(session.hubId, session);
  }

  setLastPersistedSessions(list);

  const meetingsForState = buildMeetingsForState(meetingList, meetingManager);
  for (const meeting of meetingsForState) {
    if (meeting && meeting.id) meeting.updatedAt = nowTs;
  }

  const newMeetingIds = new Set(meetingsForState.map(meeting => meeting && meeting.id).filter(Boolean));
  for (const oldId of getLastPersistedMeetingIds()) {
    if (!newMeetingIds.has(oldId)) {
      stateStore.markRemovedMeeting(oldId);
      meetingStore.deleteMeetingFile(oldId);
      meetingStore.cancelDirty(oldId);
    }
  }
  setLastPersistedMeetingIds(newMeetingIds);

  const immersiveByMeeting = getImmersiveByMeeting();
  for (const meeting of meetingsForState) {
    if (meeting && meeting.id) {
      const immersive = immersiveByMeeting[meeting.id];
      if (typeof immersive === 'boolean') meeting.immersive = immersive;
      meetingStore.markDirty(meeting.id, meeting);
    }
  }

  stateStore.save({
    version: 1,
    cleanShutdown: false,
    sessions: list,
    meetings: meetingsForState,
    immersiveByMeeting,
  });

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
  registerPersistenceIpc,
};
