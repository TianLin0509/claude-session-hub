'use strict';
// pilot-mode Task 6（2026-05-01）— buildFanoutPrompt / buildDebatePrompt 的 pilot
// recap 前缀注入单测。覆盖：
//   1. findLatestPilotRecap 找最末 pilot-recap entry
//   2. 副驾的 fanout 第一次回归 → 注入 recap 摘要 + md 路径 + 段落目录
//   3. 主驾自己 → 不注入
//   4. cursor 防重复：cursor > recap.idx 时不再注入
//   5. md 漂移：recapMdPath 不存在时仅注入摘要不附 path
//   6. debate 同样注入

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  RoundtableOrchestrator, findLatestPilotRecap, _maybePilotRecapPrefix,
} = require('../core/roundtable-orchestrator.js');
const scenes = require('../core/roundtable-scenes.js');

let _tmpRoot = null;
function setupTmp() { _tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-pilot-inj-')); return _tmpRoot; }
function cleanupTmp() { if (_tmpRoot) { try { fs.rmSync(_tmpRoot, { recursive: true, force: true }); } catch {} _tmpRoot = null; } }

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('Running orchestrator pilot-recap injection tests...');

function makeRecap(overrides = {}) {
  return {
    idx: 5,
    sid: 'system',
    tag: 'pilot-recap',
    text: '主驾摘要：用户和我聊了科技股 + AI 半导体。',
    recapMdPath: null,
    segments: [
      { idx: 1, mode: 'smart', title: '宏观判断', mdLineStart: 5, mdLineEnd: 18 },
      { idx: 2, mode: 'smart', title: 'AI/半导体', mdLineStart: 19, mdLineEnd: 30 },
    ],
    segmentMode: 'smart',
    pilotSlot: 0,
    pilotKind: 'claude',
    turnCount: 3,
    ts: Date.now(),
    ...overrides,
  };
}

test('findLatestPilotRecap returns last pilot-recap entry', () => {
  const timeline = [
    { idx: 1, sid: 'sid-a', text: 'turn1' },
    { idx: 2, sid: 'system', tag: 'pilot-recap', pilotSlot: 0 },
    { idx: 3, sid: 'sid-b', text: 'turn2' },
    { idx: 4, sid: 'system', tag: 'pilot-recap', pilotSlot: 1 },
  ];
  const r = findLatestPilotRecap(timeline);
  assert.strictEqual(r.idx, 4);
  assert.strictEqual(r.pilotSlot, 1);
});

test('findLatestPilotRecap returns null when no recap exists', () => {
  assert.strictEqual(findLatestPilotRecap([]), null);
  assert.strictEqual(findLatestPilotRecap([{ idx: 1, sid: 'sid-x' }]), null);
});

test('_maybePilotRecapPrefix injects for non-pilot slot first time', () => {
  const recap = makeRecap();
  const meeting = {
    _timeline: [recap],
    _cursors: { 'sid-2': 0 },
    subSessions: ['sid-1', 'sid-2', 'sid-3'],
  };
  const out = _maybePilotRecapPrefix({
    meeting, targetSid: 'sid-2', targetSlotIndex: 1,
  });
  assert.match(out, /你刚才暂时离场/);
  assert.match(out, /Slot1（claude）/);
  assert.match(out, /主驾摘要：用户和我聊了科技股/);
  // cursor 推进到 recap.idx + 1
  assert.strictEqual(meeting._cursors['sid-2'], 6);
});

test('_maybePilotRecapPrefix returns null for pilot slot itself', () => {
  const recap = makeRecap({ pilotSlot: 0 });
  const meeting = {
    _timeline: [recap],
    _cursors: { 'sid-1': 0 },
    subSessions: ['sid-1', 'sid-2', 'sid-3'],
  };
  const out = _maybePilotRecapPrefix({
    meeting, targetSid: 'sid-1', targetSlotIndex: 0, // 主驾自己
  });
  assert.strictEqual(out, null);
});

test('_maybePilotRecapPrefix skips when cursor already past recap (no double-inject)', () => {
  const recap = makeRecap({ idx: 5 });
  const meeting = {
    _timeline: [recap],
    _cursors: { 'sid-2': 6 }, // already past
    subSessions: ['sid-1', 'sid-2', 'sid-3'],
  };
  const out = _maybePilotRecapPrefix({
    meeting, targetSid: 'sid-2', targetSlotIndex: 1,
  });
  assert.strictEqual(out, null);
});

test('_maybePilotRecapPrefix includes md path + segments when md exists', () => {
  const tmp = path.join(os.tmpdir(), `recap-md-test-${Date.now()}.md`);
  fs.writeFileSync(tmp, '# fake md', 'utf8');
  const recap = makeRecap({ recapMdPath: tmp });
  const meeting = {
    _timeline: [recap],
    _cursors: {},
    subSessions: ['sid-1', 'sid-2'],
  };
  const out = _maybePilotRecapPrefix({
    meeting, targetSid: 'sid-2', targetSlotIndex: 1,
  });
  assert.match(out, /📂 完整历史:/);
  assert.match(out, new RegExp(tmp.replace(/\\/g, '\\\\')));
  assert.match(out, /段落 1 \[行 5-18\]/);
  assert.match(out, /段落 2 \[行 19-30\]/);
  fs.unlinkSync(tmp);
});

test('_maybePilotRecapPrefix omits md path when file missing (drift)', () => {
  const recap = makeRecap({ recapMdPath: '/nonexistent/path/foo.md' });
  const meeting = {
    _timeline: [recap],
    _cursors: {},
    subSessions: ['sid-1', 'sid-2'],
  };
  const out = _maybePilotRecapPrefix({
    meeting, targetSid: 'sid-2', targetSlotIndex: 1,
  });
  assert.match(out, /主驾摘要：用户和我聊了/);
  // md path 不应出现
  assert.ok(!/📂 完整历史/.test(out));
});

test('buildFanoutPrompt injects recap prefix for non-pilot slot', () => {
  const dir = setupTmp();
  const orch = new RoundtableOrchestrator(dir, 'm-fanout-pilot', scenes.getScene('general'));
  const meeting = {
    _timeline: [makeRecap()],
    _cursors: { 'sid-2': 0 },
    subSessions: ['sid-1', 'sid-2', 'sid-3'],
  };
  const prompt = orch.buildFanoutPrompt(2, '新问题：Tesla 怎么看', null, {
    meeting, targetSid: 'sid-2', targetSlotIndex: 1,
  });
  assert.match(prompt, /你刚才暂时离场/);
  assert.match(prompt, /## 用户问题\n新问题：Tesla 怎么看/);
  cleanupTmp();
});

test('buildFanoutPrompt does NOT inject for pilot slot', () => {
  const dir = setupTmp();
  const orch = new RoundtableOrchestrator(dir, 'm-fanout-noinj', scenes.getScene('general'));
  const meeting = {
    _timeline: [makeRecap({ pilotSlot: 0 })],
    _cursors: { 'sid-1': 0 },
    subSessions: ['sid-1', 'sid-2', 'sid-3'],
  };
  const prompt = orch.buildFanoutPrompt(2, '主驾自己继续', null, {
    meeting, targetSid: 'sid-1', targetSlotIndex: 0,
  });
  assert.ok(!/你刚才暂时离场/.test(prompt));
  cleanupTmp();
});

test('buildFanoutPrompt without ctx behaves like before (back-compat)', () => {
  const dir = setupTmp();
  const orch = new RoundtableOrchestrator(dir, 'm-fanout-noctx', scenes.getScene('general'));
  const prompt = orch.buildFanoutPrompt(1, 'q', null);  // no ctx
  assert.match(prompt, /第 1 轮/);
  assert.ok(!/你刚才暂时离场/.test(prompt));
  cleanupTmp();
});

test('buildDebatePrompt injects recap prefix for non-pilot slot', () => {
  const dir = setupTmp();
  const orch = new RoundtableOrchestrator(dir, 'm-debate-pilot', scenes.getScene('general'));
  const meeting = {
    _timeline: [makeRecap()],
    _cursors: { 'sid-2': 0 },
    subSessions: ['sid-1', 'sid-2', 'sid-3'],
  };
  const lastTurn = { by: { 'sid-1': 'A', 'sid-2': 'B' } };
  const prompt = orch.buildDebatePrompt(3, '辩论', lastTurn, 'sid-2', () => 'AI', {
    meeting, targetSid: 'sid-2', targetSlotIndex: 1,
  });
  assert.match(prompt, /你刚才暂时离场/);
  assert.match(prompt, /@debate/);
  cleanupTmp();
});

console.log('All passed.');
