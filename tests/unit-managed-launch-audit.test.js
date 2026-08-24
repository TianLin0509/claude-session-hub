'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  appendManagedLaunchAudit,
  inspectManagedLaunchAudit,
  readManagedLaunchAudit,
} = require('../core/managed-launch-audit.js');

test('managed launch audit persists only the supplied sanitized contract', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-managed-launch-audit-'));
  const auditPath = path.join(tempRoot, 'diagnostics', 'managed-cli-launches.jsonl');
  try {
    const record = {
      schemaVersion: 1,
      sessionId: 'session-a',
      trigger: 'create-pty-ready',
      model: 'gpt-5.6-sol',
      contextRequested: 1_000_000,
      mcpProfile: 'none',
      mcpDisabled: true,
      commandSha256: 'a'.repeat(64),
    };
    assert.equal(appendManagedLaunchAudit(record, { auditPath }), auditPath);
    appendManagedLaunchAudit({ ...record, sessionId: 'session-b' }, { auditPath });
    fs.appendFileSync(auditPath, '{not-json}\n', 'utf8');
    const filtered = readManagedLaunchAudit({ auditPath, sessionId: 'session-a' });
    assert.deepEqual(filtered, [record]);
    const inspected = inspectManagedLaunchAudit({ auditPath });
    assert.equal(inspected.exists, true);
    assert.equal(inspected.malformedLines, 1);
    assert.equal(inspected.readError, null);
    assert.equal(inspected.records.length, 2);
    const raw = fs.readFileSync(auditPath, 'utf8');
    assert.doesNotMatch(raw, /dangerously-bypass|API_KEY|mcp_server.*command/i);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
