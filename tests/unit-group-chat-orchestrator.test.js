'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-groupchat-'));
const groupchat = require('../core/group-chat-orchestrator.js');

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  OK ' + name);
  } catch (e) {
    failed++;
    console.error('  FAIL ' + name);
    console.error(e.stack || e.message);
  }
}

function fresh() {
  const meetingId = `gc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    meetingId,
    orch: groupchat.getOrchestrator(tmp, meetingId),
  };
}

const members = [
  { sid: 's-claude', index: 0, memberId: 'm1', kind: 'claude', model: 'opus', displayName: 'Claude', aliases: ['m1', 'Claude'] },
  { sid: 's-codex', index: 1, memberId: 'm2', kind: 'codex', model: 'gpt-5.5', displayName: 'Codex', aliases: ['m2', 'Codex'] },
];

console.log('--- group chat orchestrator ---');

test('prompt includes member manifest, summary ledger, recent raw, and same-turn isolation rule', () => {
  const { orch } = fresh();
  const { turnNum } = orch.beginTurn('Explain OFDM pilot contamination.');
  const prompt = orch.buildPrompt({
    meeting: { groupRecentRawN: 5, groupMode: 'deliberation' },
    members,
    selfMember: members[0],
    targetMembers: members,
    userInput: 'Explain OFDM pilot contamination.',
    turnNum,
  });
  assert.match(prompt, /m1: Claude/);
  assert.match(prompt, /m2: Codex/);
  assert.match(prompt, /历史摘要账本/);
  assert.match(prompt, /最近 5 条原文/);
  assert.match(prompt, /raw:\/\/group\//);
  assert.match(prompt, /同一轮的多位 AI 彼此看不到本轮实时输出/);
});

test('completeTurn records provisional five-field summary and raw anchors', () => {
  const { orch, meetingId } = fresh();
  const { turnNum } = orch.beginTurn('Compare OFDMA and SC-FDMA.');
  const turn = orch.completeTurn(turnNum, 'Compare OFDMA and SC-FDMA.', [
    { sid: 's-claude', status: 'completed', text: 'OFDMA is efficient for downlink scheduling.' },
    { sid: 's-codex', status: 'completed', text: 'SC-FDMA lowers uplink PAPR.' },
  ], Object.fromEntries(members.map(m => [m.sid, m])));

  const state = orch.getState();
  assert.strictEqual(turn.meta.dispatchMode, 'group');
  assert.strictEqual(state.summarySegments.length, 1);
  const seg = state.summarySegments[0];
  assert.strictEqual(seg.schema, 'deliberation-v1');
  assert.strictEqual(seg.status, 'provisional');
  for (const key of ['Position:', 'Evidence:', 'Assumptions:', 'Counterpoints:', 'Follow-up:']) {
    assert.ok(seg.summary.includes(key), key + ' missing');
  }
  assert.ok(seg.anchors.includes(groupchat.rawMessageAnchor(meetingId, 'u1')));
  assert.ok(seg.anchors.some(x => x.includes('/msg/a1-m1')));
});

test('searchRaw and readRaw expose indexed original messages', () => {
  const { orch } = fresh();
  const { turnNum } = orch.beginTurn('Massive MIMO channel hardening details.');
  orch.completeTurn(turnNum, 'Massive MIMO channel hardening details.', [
    { sid: 's-codex', status: 'completed', text: 'Channel hardening reduces small-scale fading variance.' },
  ], { 's-codex': members[1] });

  const hits = orch.searchRaw('hardening', 10);
  assert.ok(hits.length >= 2);
  assert.ok(hits.every(h => h.anchor && h.anchor.startsWith('raw://group/')));
  const raw = orch.readRaw(hits[0].id);
  assert.ok(raw);
  assert.ok(String(raw.content).toLowerCase().includes('hardening'));
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(failed ? 1 : 0);
