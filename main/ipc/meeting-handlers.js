'use strict';

function withUserRenameFields(fields) {
  if (fields && typeof fields.title === 'string' && !fields.autoTitleGenerated) {
    return { ...fields, userRenamed: true, autoTitlePending: false };
  }
  return fields;
}

function isValidMeetingId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id) && id.length > 0 && id.length < 256;
}

function reindexParticipantsAfterRemoval(participants, removedIndex) {
  if (!Array.isArray(participants)) return null;
  return participants
    .filter(index => index !== removedIndex)
    .map(index => index > removedIndex ? index - 1 : index);
}

function reindexSerialWorkflowAfterRemoval(serialWorkflow, removedIndex) {
  if (!serialWorkflow || typeof serialWorkflow !== 'object' || !Array.isArray(serialWorkflow.steps)) {
    return serialWorkflow || null;
  }
  const removedMemberId = 'm' + (removedIndex + 1);
  const remapMemberId = (memberId) => {
    const match = /^m(\d+)$/.exec(String(memberId || ''));
    if (!match) return memberId;
    const oneBased = Number(match[1]);
    if (memberId === removedMemberId) return null;
    return oneBased > removedIndex + 1 ? 'm' + (oneBased - 1) : memberId;
  };
  const promptSteps = Array.isArray(serialWorkflow.stepPrompts) ? serialWorkflow.stepPrompts : [];
  const reindexed = serialWorkflow.steps.map((step, stepIndex) => {
    const nextStep = Array.isArray(step) ? step.map(remapMemberId).filter(Boolean) : [];
    const sourcePrompts = promptSteps[stepIndex] && typeof promptSteps[stepIndex] === 'object'
      ? promptSteps[stepIndex]
      : {};
    const nextPrompts = {};
    for (const [memberId, prompt] of Object.entries(sourcePrompts)) {
      const nextMemberId = remapMemberId(memberId);
      if (nextMemberId && typeof prompt === 'string' && prompt.trim()) nextPrompts[nextMemberId] = prompt;
    }
    return { step: nextStep, prompts: nextPrompts };
  }).filter(item => item.step.length > 0);
  const steps = reindexed.map(item => item.step);
  const stepPrompts = reindexed.map(item => item.prompts);
  const loop = serialWorkflow.loop && typeof serialWorkflow.loop === 'object'
    ? {
        ...serialWorkflow.loop,
        enabled: serialWorkflow.loop.enabled && steps.length >= 2,
      }
    : serialWorkflow.loop;
  return {
    ...serialWorkflow,
    enabled: !!serialWorkflow.enabled && steps.length > 0,
    steps,
    stepPrompts,
    ...(loop ? { loop } : {}),
  };
}

function switchScene({ meetingId, scene, covenant, deps }) {
  const {
    getHubDataDir,
    logger = console,
    meetingManager,
    scenes,
    sendToRenderer,
    slotIds = [],
  } = deps;

  if (!isValidMeetingId(meetingId)) return { ok: false, error: 'invalid meetingId' };
  if (!scenes.getScene(scene)) return { ok: false, error: `invalid scene: ${scene}` };
  const meeting = meetingManager.getMeeting(meetingId);
  if (!meeting) return { ok: false, error: 'meeting not found' };

  const fields = { scene };
  if (typeof covenant === 'string') fields.covenantText = covenant;

  let updated;
  try {
    updated = meetingManager.updateMeeting(meetingId, fields);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!updated) return { ok: false, error: 'update failed' };

  const text = typeof covenant === 'string' ? covenant : (updated.covenantText || '');
  try {
    const hubDataDir = getHubDataDir();
    scenes.writeCovenantSnapshot(hubDataDir, meetingId, text);
    if (scene === 'research') {
      for (const sid of slotIds) {
        scenes.writePromptFile(hubDataDir, meetingId, scene, text, sid);
      }
    }
    scenes.writePromptFile(hubDataDir, meetingId, scene, text);
  } catch (err) {
    logger.warn(`[switch-scene] write prompt files failed: ${err.message}`);
  }

  sendToRenderer('meeting-updated', { meeting: updated });
  return { ok: true, meeting: updated };
}

function registerMeetingIpc(ipcMain, deps) {
  const {
    getHubDataDir = () => null,
    getImmersiveByMeeting = () => ({}),
    getLastPersistedSessions = () => [],
    groupchat,
    meetingManager,
    scenes,
    sendToRenderer,
    sessionManager,
    sessionStore,
    stateStore,
  } = deps;

  ipcMain.handle('get-immersive-mode', () => {
    return { immersive: false };
  });

  ipcMain.handle('save-immersive-mode', () => {
    return { ok: true };
  });

  ipcMain.handle('groupchat:set-participants', async (_e, { meetingId, participants } = {}) => {
    if (!meetingId) throw new Error('Missing meetingId');
    const meeting = meetingManager.getMeeting(meetingId);
    if (!meeting) throw new Error(`Meeting not found: ${meetingId}`);
    if (!meeting.groupChat) throw new Error('Meeting is not a group chat');
    if (!Array.isArray(participants)) throw new Error(`participants must be array, got ${typeof participants}`);

    const max = Array.isArray(meeting.subSessions) ? meeting.subSessions.length : 0;
    const seen = new Set();
    for (const x of participants) {
      if (!Number.isInteger(x) || x < 0 || x >= max) {
        throw new Error(`Invalid group participant index: ${JSON.stringify(x)}`);
      }
      seen.add(x);
    }
    const validated = [...seen].sort((a, b) => a - b);

    meetingManager.setParticipants(meetingId, validated);

    let persistWarning = null;
    try {
      stateStore.save({
        version: 1,
        cleanShutdown: false,
        sessions: getLastPersistedSessions(),
        meetings: meetingManager.getAllMeetings(),
        immersiveByMeeting: getImmersiveByMeeting(),
      });
    } catch (err) {
      console.warn('[groupchat] set-participants persist failed:', err.message);
      persistWarning = `state.json persist failed: ${err.message} (meeting already persisted to per-meeting JSON)`;
    }

    const freshMeeting = meetingManager.getMeeting(meetingId);
    sendToRenderer('meeting-updated', { meeting: freshMeeting });
    return {
      ok: true,
      meeting: freshMeeting,
      ...(persistWarning ? { persistWarning } : {}),
    };
  });

  ipcMain.on('update-meeting', (_e, { meetingId, fields }) => {
    const updated = meetingManager.updateMeeting(meetingId, withUserRenameFields(fields));
    if (updated) sendToRenderer('meeting-updated', { meeting: updated });
  });

  ipcMain.handle('update-meeting-sync', (_e, { meetingId, fields }) => {
    const updated = meetingManager.updateMeeting(meetingId, withUserRenameFields(fields));
    if (updated) sendToRenderer('meeting-updated', { meeting: updated });
    return !!updated;
  });

  ipcMain.handle('get-scene-covenant', (_e, sceneKey) => {
    const sceneObj = scenes.getScene(sceneKey || 'research');
    return sceneObj ? sceneObj.defaultCovenant : '';
  });

  ipcMain.handle('get-research-covenant-template', () => scenes.COVENANT_RESEARCH);

  ipcMain.handle('switch-scene', (_e, { meetingId, scene, covenant } = {}) => {
    return switchScene({ meetingId, scene, covenant, deps });
  });

  ipcMain.handle('get-meetings', () => {
    return meetingManager.getAllMeetings();
  });

  ipcMain.handle('remove-meeting-sub', (_e, { meetingId, sessionId } = {}) => {
    const meeting = meetingManager.getMeeting(meetingId);
    if (!meeting) return { ok: false, reason: 'meeting_not_found' };
    const subSessions = Array.isArray(meeting.subSessions) ? meeting.subSessions : [];
    const removedIndex = subSessions.indexOf(sessionId);
    if (removedIndex < 0) return { ok: false, reason: 'not_member' };
    if (meeting.groupChat && subSessions.length <= 1) return { ok: false, reason: 'last_member' };

    if (meeting.groupChat && groupchat && typeof groupchat.getOrchestrator === 'function') {
      try {
        const state = groupchat.getOrchestrator(getHubDataDir(), meetingId).getState();
        if (state && state.currentMode && state.currentMode !== 'idle') {
          return { ok: false, reason: 'turn_in_progress' };
        }
      } catch (err) {
        console.warn('[groupchat] cannot verify turn state before member removal:', err && err.message);
        return { ok: false, reason: 'turn_state_unavailable' };
      }
    }

    const removed = meetingManager.removeSubSession(meetingId, sessionId);
    if (!removed) return { ok: false, reason: 'remove_failed' };

    if (Array.isArray(meeting.participants)) {
      meetingManager.setParticipants(
        meetingId,
        reindexParticipantsAfterRemoval(meeting.participants, removedIndex)
      );
    }
    if (Array.isArray(meeting.slotSpecs)) {
      const slotSpecs = meeting.slotSpecs.slice();
      if (removedIndex < slotSpecs.length) slotSpecs.splice(removedIndex, 1);
      meetingManager.setSlotSpecs(meetingId, slotSpecs);
    }
    if (meeting.serialWorkflow && typeof meeting.serialWorkflow === 'object') {
      meetingManager.updateMeeting(meetingId, {
        serialWorkflow: reindexSerialWorkflowAfterRemoval(meeting.serialWorkflow, removedIndex),
      });
    }

    sessionManager.closeSession(sessionId);
    stateStore.markRemovedSession?.(sessionId);
    sessionStore.deleteSessionFile?.(sessionId);
    sessionStore.cancelDirty?.(sessionId);

    const freshMeeting = meetingManager.getMeeting(meetingId);
    let persistWarning = null;
    try {
      stateStore.save({
        version: 1,
        cleanShutdown: false,
        sessions: getLastPersistedSessions(),
        meetings: meetingManager.getAllMeetings(),
        immersiveByMeeting: getImmersiveByMeeting(),
      });
    } catch (err) {
      console.warn('[groupchat] remove member persist failed:', err.message);
      persistWarning = `state.json persist failed: ${err.message}`;
    }
    sendToRenderer('meeting-updated', { meeting: freshMeeting });
    return {
      ok: true,
      meeting: freshMeeting,
      ...(persistWarning ? { persistWarning } : {}),
    };
  });

  ipcMain.handle('close-meeting', (_e, meetingId) => {
    const subIds = meetingManager.closeMeeting(meetingId);
    if (!subIds) return false;
    for (const sid of subIds) {
      sessionManager.closeSession(sid);
      stateStore.markRemovedSession(sid);
      sessionStore.deleteSessionFile(sid);
      sessionStore.cancelDirty(sid);
    }
    groupchat.cleanup?.(deps.getHubDataDir(), meetingId);
    stateStore.markRemovedMeeting(meetingId);
    deps.deleteImmersiveByMeeting?.(meetingId);
    sendToRenderer('meeting-closed', { meetingId });
    return true;
  });
}

module.exports = {
  isValidMeetingId,
  reindexParticipantsAfterRemoval,
  reindexSerialWorkflowAfterRemoval,
  registerMeetingIpc,
  switchScene,
  withUserRenameFields,
};
