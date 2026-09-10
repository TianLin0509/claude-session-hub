'use strict';
const { randomUUID } = require('crypto');
const { captureClaudeMessage } = require('./claude-native-transcript');
const END = new Set(['completed', 'failed', 'interrupted']);
function originKey(origin) { return JSON.stringify([origin?.kind, origin?.subkind || null, origin?.server || null]); }

// A result closes one query turn, not the lifetime of a Claude process. Injected
// turns have their own provenance and never acquire a Hub submission receipt.
class ClaudeNativeActivities {
  constructor(options) {
    this.options = options;
    this.records = new Map();
    this.toolOwners = new Map();
    this.current = null;
    this.segment = [];
    this.ambiguous = false;
    for (const saved of options.restoredActivities || []) {
      const record = { ...saved, status: END.has(saved.status) ? saved.status : 'unknown',
        messages: new Map((saved.transcriptMessages || []).map(m => [m.uuid || m.message?.id, m])) };
      this.records.set(record.userMessageId, record);
      this.rememberTools(record);
    }
  }
  pending() { return [...this.records.values()].filter(r => !END.has(r.status) && !r.reconciliation); }
  save(record) {
    const { messages, streams, ...data } = record;
    const saved = this.options.persistActivity?.({ ...data, transcriptMessages: [...(messages?.values() || [])] });
    if (saved && typeof saved.then === 'function') throw new Error('persistActivity must save synchronously');
  }
  begin(frame) {
    const id = frame.uuid || randomUUID(); // Local display identity if the provider omitted its UUID.
    const record = { userMessageId: id, providerMessageId: frame.uuid || null,
      nativeActivity: true, origin: frame.origin, status: 'running', createdAt: Date.now(),
      content: frame.message?.content, finalText: '', messages: new Map() };
    this.save(record);
    this.records.set(id, record);
    this.current = record;
    return record;
  }
  owner(frame, human) {
    if (frame.parent_tool_use_id) return this.toolOwners.get(frame.parent_tool_use_id) || null;
    const results = Array.isArray(frame.message?.content) ? frame.message.content.filter(b => b.type === 'tool_result') : [];
    if (results.length) {
      const owners = results.map(b => this.toolOwners.get(b.tool_use_id));
      if (owners.every(owner => owner && owner === owners[0])) return owners[0];
      return null;
    }
    return this.current || human;
  }
  capture(record, frame) {
    // User echoes acknowledge intake, not which root query owns later output.
    // A query's result.origin is the final attribution boundary. Keep its
    // frames until that boundary, especially when injected inputs arrive early.
    if (!END.has(record.status)) this.segment.push({ record, frame });
    if (!this.ambiguous || END.has(record.status)) captureClaudeMessage(record, frame);
    for (const block of frame.message?.content || []) {
      if (block.type === 'tool_use' && block.id) this.toolOwners.set(block.id, record);
    }
  }
  unprojectSegment() {
    for (const { record, frame } of this.segment) {
      record.messages?.delete(frame.uuid || frame.message?.id);
      record.streams?.delete(frame.parent_tool_use_id || 'root');
      record.finalText = '';
    }
  }
  deferSegment() {
    this.unprojectSegment();
    this.ambiguous = true;
  }
  resolveSegment(owner) {
    this.unprojectSegment();
    for (const { frame } of this.segment) {
      captureClaudeMessage(owner, frame);
      for (const block of frame.message?.content || []) {
        if (block.type === 'tool_use' && block.id) this.toolOwners.set(block.id, owner);
      }
      if (frame.type === 'assistant' && !frame.parent_tool_use_id) {
        owner.finalText = (frame.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      }
    }
    this.segment = []; this.ambiguous = false;
  }
  rememberTools(record) {
    for (const frame of record.messages?.values() || []) {
      for (const block of frame.message?.content || []) {
        if (block.type === 'tool_use' && block.id) this.toolOwners.set(block.id, record);
      }
    }
  }
  finish(frame) {
    const matches = this.pending().filter(r => originKey(r.origin) === originKey(frame.origin));
    if (matches.length > 1) throw new Error('Claude injected result has ambiguous origin; no activity was settled');
    // Some CLI event types omit a replayed user frame. Keep that result as a
    // standalone activity; never borrow the active human's output or identity.
    const previous = this.current;
    const record = matches[0] || this.begin({ origin: frame.origin });
    this.resolveSegment(record);
    const interrupted = ['aborted_streaming', 'aborted_tools'].includes(frame.terminal_reason);
    const status = interrupted ? 'interrupted' : frame.is_error || frame.subtype !== 'success' ? 'failed' : 'completed';
    const completed = { ...record, status, completedAt: Date.now(), providerResultId: frame.uuid || null,
      finalText: typeof frame.result === 'string' ? frame.result : record.finalText,
      errors: frame.errors || null };
    this.save(completed);
    Object.assign(record, completed);
    if (this.current === record) this.current = matches.length ? null : previous;
    return record;
  }
  reset() {
    this.current = null;
    this.segment = []; this.ambiguous = false;
    for (const record of this.pending()) {
      this.save({ ...record, status: 'unknown' });
      record.status = 'unknown';
    }
  }
  recoverTasks(tasks, epoch, persist = true) {
    for (const task of tasks) {
      const id = 'task-recovery:' + epoch + ':' + task.id;
      if (this.records.has(id)) continue;
      // This is a Hub recovery record, explicitly not a provider user turn.
      const record = { userMessageId: id, providerMessageId: null, nativeActivity: true,
        nativeTask: true, taskId: task.id, origin: { kind: 'hub-task-recovery' },
        status: 'unknown', createdAt: Date.now(), content: '未确认结束的后台任务 ' + task.id,
        finalText: '', messages: new Map() };
      if (persist) this.save(record);
      this.records.set(id, record);
    }
  }
}
module.exports = { ClaudeNativeActivities };
