'use strict';

function isNativeClaude(session) { return session?.runtimeBackend === 'claude-stream-json'; }
// Same evidence line Codex shows while waiting: the question or the tool being
// approved, not a generic "在等你回答".
function claudeRequestSummary(request) {
  const p = request && request.params || {};
  return (p.questions || []).map(q => q && q.question).filter(Boolean).join('; ')
    || (p.toolName ? '等待批准工具 ' + p.toolName : '') || 'Claude 等待你确认';
}
function claudeRuntimeTruth(session) {
  const snapshot = session.nativeRuntime || {};
  const state = session.status === 'dormant' ? 'dormant'
    : snapshot.connection === 'disconnected' && !['completed', 'failed', 'interrupted'].includes(snapshot.state)
      ? 'unknown' : snapshot.state || 'unknown';
  const connected = snapshot.connection === 'connected';
  return { state, source: 'claude-stream-json', confidence: connected || snapshot.connection === 'unstarted' ? 'authoritative' : 'none',
    observedAt: snapshot.observedAt || 0, startedAt: snapshot.startedAt || 0,
    completedAt: snapshot.completedAt || 0, expiresAt: 0, reason: snapshot.reason || null,
    turnId: snapshot.turnId || null, userMessageId: snapshot.userMessageId || null,
    providerSessionId: snapshot.providerSessionId || null, epoch: snapshot.epoch || 0,
    revision: snapshot.revision || 0, corroborations: [],
    evidence: state === 'waiting' ? (snapshot.requests || []).map(claudeRequestSummary).join('; ') || (snapshot.reason || '')
      : snapshot.reason || '',
    connection: snapshot.connection || 'disconnected',
    cancellation: snapshot.cancellation || null,
  };
}

module.exports = { isNativeClaude, claudeRuntimeTruth, claudeRequestSummary };
