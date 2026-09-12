'use strict';

function isNativeClaude(session) { return session?.runtimeBackend === 'claude-stream-json'; }
function claudeRuntimeTruth(session) {
  const snapshot = session.nativeRuntime || {};
  const state = session.status === 'dormant' ? 'dormant'
    : snapshot.connection === 'disconnected' && !['completed', 'failed', 'interrupted'].includes(snapshot.state)
      ? 'unknown' : snapshot.state || 'unknown';
  return { state, source: 'claude-stream-json', confidence: 'authoritative',
    observedAt: snapshot.observedAt || 0, startedAt: snapshot.startedAt || 0,
    completedAt: snapshot.completedAt || 0, expiresAt: 0, reason: snapshot.reason || null,
    turnId: snapshot.turnId || null, userMessageId: snapshot.userMessageId || null,
    providerSessionId: snapshot.providerSessionId || null, epoch: snapshot.epoch || 0,
    revision: snapshot.revision || 0, evidence: snapshot.reason || '', corroborations: [],
    connection: snapshot.connection || 'disconnected',
  };
}

module.exports = { isNativeClaude, claudeRuntimeTruth };
