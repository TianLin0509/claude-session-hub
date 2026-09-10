'use strict';

function bindClaudeNativeSession(manager, id, driver) {
  const current = () => {
    const entry = manager.sessions.get(id);
    return entry?.pty === driver ? entry : null;
  };
  const publish = () => {
    const entry = current();
    if (entry) manager.emit('session-updated', manager._toPublic(entry.info));
  };
  driver.on('state', snapshot => {
    const entry = current();
    if (!entry) return;
    const info = entry.info;
    if (snapshot.connection === 'connected' && info.nativeRuntime?.connection !== 'connected') info.nativeActionError = null;
    info.nativeRuntime = snapshot;
    info.ccSessionId = snapshot.providerSessionId;
    info.needsUserInput = snapshot.state === 'waiting';
    info.isWaiting = info.needsUserInput;
    info.gcWorking = false;
    info.runStartedAt = snapshot.startedAt || 0;
    info.status = ['starting', 'running', 'waiting'].includes(snapshot.state) ? 'running'
      : snapshot.state === 'failed' ? 'error' : 'idle';
    entry.groupChatReady = snapshot.connection === 'connected';
    publish();
  });
  driver.on('lifecycle', event => {
    const entry = current();
    if (!entry) return;
    if (event.type === 'agent-turn-started') manager.noteAgentTurnStarted(id, event);
    if (event.type === 'agent-turn-complete') {
      entry.info.lastCompletedAt = driver.runtime.completedAt;
      entry.info.lastMessageTime = driver.runtime.completedAt;
      entry.info.lastOutputPreview = event.text || '';
      publish();
    }
    manager.emit('native-agent-lifecycle', { ...event, sessionId: id });
  });
  driver.on('item', event => {
    if (current()) manager.emit('native-agent-item', { ...event, sessionId: id, source: 'claude-stream-json' });
  });
  driver.on('usage', usage => {
    const entry = current();
    if (!entry) return;
    Object.assign(entry.info, { contextUsed: usage.totalTokens, contextMax: usage.rawMaxTokens || usage.maxTokens,
      contextEffectiveMax: usage.maxTokens, contextPct: usage.percentage, contextEffectiveObservedAt: Date.now() });
    publish();
  });
  driver.on('migration-draft', text => {
    const entry = current();
    if (!entry) return;
    entry.info.nativeMigrationDraft = text;
    publish();
  });
  driver.on('action-error', message => {
    const entry = current();
    if (!entry) return;
    entry.info.nativeActionError = String(message);
    publish();
  });
  driver.on('diagnostic', event => {
    if (current()) manager.emit('native-agent-diagnostic', { sessionId: id, ...event });
  });
  setImmediate(() => {
    if (!current() || driver.closed) return;
    driver.start().catch(error => {
      if (!current()) return;
      driver.update({ state: 'failed', connection: 'disconnected', reason: error.message });
      driver.emit('action-error', error.message);
    });
  });
}

function claudeNativeReceipt(receipt) {
  const accepted = ['accepted', 'completed', 'failed', 'interrupted'].includes(receipt.sendStatus);
  return { ...receipt, sendStatus: receipt.sendStatus === 'queued' ? 'queued' : accepted ? 'ok' : receipt.sendStatus,
    status: receipt.sendStatus, mode: 'claude-stream-json', enterAttempts: 0,
    acknowledgementSource: accepted ? 'claude-stream-json' : null,
    acknowledgementTurnId: null, // Claude exposes a user UUID, not a provider turn ID.
  };
}

module.exports = { bindClaudeNativeSession, claudeNativeReceipt };
