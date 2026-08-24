'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const spiritRegistry = require('../core/spirit-registry');
const { createFakeSpiritRegistry } = require('./helpers/fake-spirit-registry.js');

const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-spirit-registry-fixture-'));
const REGISTRY_ROOT = createFakeSpiritRegistry(path.join(FIXTURE_ROOT, 'registry'));
process.on('exit', () => { try { fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true }); } catch {} });

function test(name, fn) {
  try {
    fn();
    console.log('  OK ' + name);
  } catch (error) {
    console.error('  FAIL ' + name);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

console.log('Running spirit registry bridge tests...');

test('lists canonical spirits through strict JSON CLI', () => {
  const result = spiritRegistry.list({ root: REGISTRY_ROOT });
  assert.deepStrictEqual(result.spirits.map(row => row.spirit_id), [
    'buffett.mature.v1',
    'livermore.trend.v1',
  ]);
  assert.strictEqual(result.constitution_id, 'chuxin.spirit.constitution.v1');
});

test('same evidence compiles to the same hashes across base models', () => {
  const base = {
    spirit_ids: ['buffett.mature.v1', 'livermore.trend.v1'],
    mandate: 'value_speculation',
    question: '审视样本股',
    evidence: { symbol: '600001.SH', technical: { close: 10.1 } },
    output_format: 'markdown',
    host: 'hub-test',
  };
  const claude = spiritRegistry.prepare({ ...base, base_model: 'claude' }, { root: REGISTRY_ROOT });
  const codex = spiritRegistry.prepare({ ...base, base_model: 'codex' }, { root: REGISTRY_ROOT });
  assert.strictEqual(claude.prompt_hash, codex.prompt_hash);
  assert.strictEqual(claude.manifest_hash, codex.manifest_hash);
  assert.strictEqual(claude.evidence_snapshot_hash, codex.evidence_snapshot_hash);
  assert.ok(claude.rendered_prompt.includes('[B01]'));
  assert.ok(claude.rendered_prompt.includes('[L01]'));
});

test('audit ledger records hashes without executing any trade action', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-spirit-audit-'));
  const packet = spiritRegistry.prepare({
    spirit_ids: ['livermore.trend.v1'],
    mandate: 'trend_speculation',
    question: '趋势是否确认',
    evidence: { technical: { close: 10.1 } },
    output_format: 'markdown',
  }, { root: REGISTRY_ROOT });
  const auditPath = spiritRegistry.appendAudit({
    hubDataDir: temp,
    meetingId: 'meeting-test',
    aiKind: 'codex',
    action: 'prepare',
    packet,
  });
  const row = JSON.parse(fs.readFileSync(auditPath, 'utf8').trim());
  assert.strictEqual(row.prompt_hash, packet.prompt_hash);
  assert.strictEqual(row.action, 'prepare');
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'trade_action'));
});

test('CLI timeout is surfaced as a bounded error', () => {
  const timeoutError = Object.assign(new Error('fixture timeout'), { code: 'ETIMEDOUT' });
  assert.throws(() => spiritRegistry.runCli('list', {
    root: REGISTRY_ROOT,
    timeoutMs: 1_000,
    spawnSyncImpl: () => ({ error: timeoutError }),
  }), /英灵 CLI 超时/);
});
