'use strict';
// Materialized at the group-chat write boundary. UPDATE is informational;
// PROGRESS / RESULT retain their existing final-handoff meanings.
const listeners = new Set();
const EMPTY = /^(无|none|n\/a|-|—|null)$/i;
function clean(value, max = 4096) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return EMPTY.test(text) ? '' : text.slice(0, max);
}
function fields(text) {
  if (typeof text !== 'string') return {};
  const out = {}; let fence = null;
  for (const line of text.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker) { if (!fence) fence = marker[1][0]; else if (fence === marker[1][0]) fence = null; continue; }
    if (fence || /^\s*>/.test(line)) continue;
    const match = /^\s{0,3}(UPDATE|PROGRESS|VERIFIED|RISK|REPORT|RESULT|BLOCKERS|NEXT)\s*[:：]\s*(.*)$/i.exec(line);
    if (match) out[match[1].toUpperCase()] = match[2].trim();
  }
  return out;
}
function source(message, index) {
  return {
    messageId: clean(message.id, 256), sid: clean(message.sid, 256),
    speaker: clean(message.speaker || message.memberId, 100) || 'Agent',
    turnNum: Math.max(0, Number(message.turnNum) || 0),
    at: Number(message.updatedAt || message.createdAt) || 0, index,
    seq: Number(message.seq) || 0, runId: clean(message.runId, 256), attemptId: clean(message.attemptId, 256),
    memberId: clean(message.memberId, 100), providerTurnId: clean(message.providerTurnId, 256),
  };
}
function summarizeGroupState(state) {
  const data = state && typeof state === 'object' ? state : {};
  const summary = { schemaVersion: 2, revision: Number(data.revision) || 0, card: null, review: null, update: null, currentTurn: Number(data.currentTurn) || 0, truncated: false };
  const run = data.activeRun;
  if (run && typeof run === 'object') summary.execution = {
    runId: clean(run.runId, 256), status: clean(run.status, 80), turnNum: Number(run.turnNum) || 0,
    updatedAt: Number(run.updatedAt || run.startedAt) || 0, hasFailures: !!run.hasFailures,
    attempts: Object.values(data.attempts || {}).filter(a => a && a.runId === run.runId).slice(-32).map(a => ({
      attemptId: clean(a.attemptId, 256), memberId: clean(a.memberId, 100), sid: clean(a.sid, 256),
      status: clean(a.status, 80), providerTurnId: clean(a.providerTurnId, 256),
      updatedAt: Number(a.updatedAt) || 0, failure: a.failure ? { summary: clean(a.failure.summary, 300), action: clean(a.failure.action, 100) } : null,
    })),
  };
  let messages = Array.isArray(data.messages) ? data.messages : [];
  if (!messages.length && Array.isArray(data.turns)) {
    messages = data.turns.flatMap(turn => Object.entries(turn && turn.by || {}).map(([sid, text]) =>
      ({ role: 'assistant', content: text, sid, turnNum: turn.n, createdAt: turn.ts })));
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== 'assistant') continue;
    if (message.status === 'progress_update' && message.attemptId && data.attempts?.[message.attemptId]?.status === 'superseded') continue;
    const f = fields(message.content || message.text);
    const meta = source(message, i);
    if (!summary.card && clean(f.PROGRESS)) summary.card = {
      ...meta, progress: clean(f.PROGRESS), verified: clean(f.VERIFIED), risk: clean(f.RISK), report: clean(f.REPORT, 8192),
    };
    if (!summary.review && /^(PASS|FAIL)\b/i.test(f.RESULT || '')) summary.review = {
      ...meta, decision: /^PASS\b/i.test(f.RESULT) ? 'pass' : 'fail',
      blockers: clean(f.BLOCKERS), verified: clean(f.VERIFIED), next: clean(f.NEXT), report: clean(f.REPORT, 8192),
    };
    if (!summary.update && clean(f.UPDATE)) summary.update = { ...meta, text: clean(f.UPDATE) };
    if (Object.entries(f).some(([key, value]) => value.length > (key === 'REPORT' ? 8192 : 4096))) summary.truncated = true;
    if (summary.card && summary.review && summary.update) break;
  }
  return summary;
}
function publishSaved(hubDataDir, meetingId, summary) {
  for (const listener of listeners) {
    try { listener({ hubDataDir, meetingId, summary }); }
    catch (error) { console.error('[dev-workbench] subscriber failed:', error.message); }
  }
}
function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
function processUpdate(text) { return clean(fields(text).UPDATE); }
module.exports = { summarizeGroupState, publishSaved, subscribe, clean, processUpdate };
