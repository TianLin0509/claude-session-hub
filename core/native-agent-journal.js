'use strict';
const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');

// Durable submission identities live in Hub's data directory, not provider
// screen buffers. A malformed journal is an explicit recovery error.
class NativeAgentJournal {
  constructor({ directory, sessionId }) {
    if (!directory || !path.isAbsolute(directory)) throw new Error('Native journal requires an absolute data directory');
    if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9-]+$/.test(sessionId)) throw new Error('Invalid Hub session ID');
    this.sessionId = sessionId;
    this.filePath = path.join(directory, sessionId + '.jsonl');
    this.failure = null;
    this.bytes = 0;
    this.entries = this.read();
    this.records = new Map();
    this.activities = new Map();
    for (const entry of this.entries) this.project(entry);
  }

  read() {
    let raw;
    try {
      const bytes = fs.readFileSync(this.filePath);
      raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      this.bytes = bytes.length;
    }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (raw && !raw.endsWith('\n')) throw new Error('Native journal has an incomplete final record: ' + this.filePath);
    return raw.split('\n').filter(Boolean).map((line, index) => {
      const entry = JSON.parse(line);
      if (entry.version !== 1 || entry.sequence !== index + 1 || entry.sessionId !== this.sessionId
          || !['submission', 'lifecycle', 'activity'].includes(entry.type) || !entry.data) {
        throw new Error('Invalid native journal record ' + (index + 1));
      }
      return entry;
    });
  }

  project(entry) {
    if (entry.type === 'activity') {
      if (!entry.data.userMessageId || !entry.data.nativeActivity || !entry.data.origin?.kind
          || entry.data.origin.kind === 'human') throw new Error('Invalid native activity identity');
      this.activities.set(entry.data.userMessageId, entry.data);
      return;
    }
    const id = entry.data.submissionId || entry.data.clientSubmissionId;
    if (!id) throw new Error('Native journal record has no submission identity');
    const previous = this.records.get(id);
    if (previous?.promptFingerprint && entry.data.promptFingerprint
        && previous.promptFingerprint !== entry.data.promptFingerprint) throw new Error('Native journal content identity changed');
    const merged = { ...previous, ...entry.data };
    if (entry.type === 'lifecycle') {
      // Lifecycle text is assistant output. Never overwrite the original prompt
      // under the same field when rebuilding durable submissions.
      merged.text = previous?.text;
      merged.finalText = entry.data.text ?? previous?.finalText;
      merged.lifecycleType = entry.data.type;
      merged.submissionId = id;
    }
    this.records.set(id, merged);
  }

  append(type, data) {
    if (this.failure) throw this.failure;
    const entry = { version: 1, sequence: this.entries.length + 1,
      sessionId: this.sessionId, type, at: Date.now(), data };
    // Validate before writing. A failed append must not update in-memory truth.
    const target = type === 'activity' ? this.activities : this.records;
    const id = type === 'activity' ? data.userMessageId : data.submissionId || data.clientSubmissionId;
    const old = target.get(id);
    this.project(entry);
    if (old) target.set(id, old); else target.delete(id);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    let size;
    try { size = fs.statSync(this.filePath).size; }
    catch (error) { if (error.code === 'ENOENT') size = 0; else throw error; }
    if (size !== this.bytes) throw new Error('Native journal changed outside its owner; reload required');
    const line = JSON.stringify(entry) + '\n';
    const fd = fs.openSync(this.filePath, 'a');
    try {
      fs.writeFileSync(fd, line, 'utf8');
      fs.fsyncSync(fd);
    } catch (error) {
      // A failed append may have left a partial line. No subsequent writes may
      // pretend that line never existed; reopening performs strict validation.
      this.failure = error;
      throw error;
    } finally { fs.closeSync(fd); }
    this.bytes += Buffer.byteLength(line, 'utf8');
    this.entries.push(entry);
    this.project(entry);
    return entry;
  }

  saveSubmission(data) { return this.append('submission', data); }
  saveLifecycle(data) { return this.append('lifecycle', data); }
  saveActivity(data) { return this.append('activity', data); }
  listActivities() { return [...this.activities.values()].map(record => ({ ...record })); }
  list() { return [...this.records.values()].map(record => ({ ...record })); }
}

module.exports = { NativeAgentJournal };
