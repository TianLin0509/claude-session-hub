'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY_ROOT = path.resolve(ROOT, '..', 'spirit-lens-registry');
const MCP_SERVER = path.join(ROOT, 'core', 'research-mcp-server.js');

function callMcp(requests, hubDataDir) {
  const input = requests.map(value => JSON.stringify(value)).join('\n') + '\n';
  const result = spawnSync(process.execPath, [MCP_SERVER], {
    cwd: ROOT,
    input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ARENA_MEETING_ID: 'spirit-mcp-test',
      ARENA_HUB_PORT: '1',
      ARENA_HOOK_TOKEN: 'test-token',
      ARENA_AI_KIND: 'codex',
      ARENA_HUB_DATA_DIR: hubDataDir,
      SPIRIT_REGISTRY_ROOT: REGISTRY_ROOT,
      PYTHONUTF8: '1',
    },
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-spirit-mcp-'));
const responses = callMcp([
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'spirit_prepare',
      arguments: {
        spirit_ids: ['buffett.mature.v1', 'livermore.trend.v1'],
        mandate: 'value_speculation',
        question: '审视样本股',
        evidence: { symbol: '600001.SH', technical: { close: 10.1 } },
      },
    },
  },
], temp);

const tools = responses.find(value => value.id === 2).result.tools;
for (const name of ['spirit_list', 'spirit_manifest', 'spirit_prepare', 'spirit_validate']) {
  assert.ok(tools.some(tool => tool.name === name), `missing MCP tool ${name}`);
}

const preparedResponse = responses.find(value => value.id === 3).result;
assert.strictEqual(preparedResponse.isError, undefined);
const packet = JSON.parse(preparedResponse.content[0].text);
assert.deepStrictEqual(packet.spirit_ids, ['buffett.mature.v1', 'livermore.trend.v1']);
assert.ok(packet.rendered_prompt.includes('[B01]'));
assert.ok(packet.rendered_prompt.includes('[L01]'));
assert.ok(packet.manifest_hash);
assert.ok(packet.evidence_snapshot_hash);

const auditPath = path.join(temp, 'arena-spirit-audit', 'spirit-mcp-test.jsonl');
assert.ok(fs.existsSync(auditPath), 'spirit_prepare must append an audit row');
const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8').trim());
assert.strictEqual(audit.prompt_hash, packet.prompt_hash);
assert.strictEqual(audit.ai_kind, 'codex');

console.log('  OK research MCP exposes and executes provider-orthogonal spirit tools');
