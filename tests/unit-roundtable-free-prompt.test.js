'use strict';
// 测 core/roundtable-free.js prompt 三模板 + 第一行格式契约

const assert = require('assert');
const free = require('../core/roundtable-free');

let failed = 0;
function run(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + ':', e.message); failed++; }
}

const baseMeeting = {
  subSessions: ['sid_pi', 'sid_ch', 'sid_sq'],
  participants: [0, 1, 2],
};

function testFanoutFirstLineContract() {
  const p = free.buildFreeFanoutPrompt({
    meeting: baseMeeting,
    selfSlot: 1,            // Charmander 视角
    participants: [0, 1],
    userInput: 'hello',
    lastTurnInjection: null,
    turnNum: 5,
  });
  const firstLine = p.split('\n')[0];
  // 契约：非空 + 含轮号 + 自由模式标识 + slot label
  assert.ok(firstLine.length > 0, 'first line non-empty');
  assert.ok(/第\s*5\s*轮/.test(firstLine), 'first line contains turn number');
  assert.ok(firstLine.includes('自由模式'), 'first line marks 自由模式');
  assert.ok(firstLine.includes('fanout'), 'first line includes mode');
  assert.ok(firstLine.includes('Charmander'), 'first line includes self slot');
}

function testFanoutListsParticipants() {
  const p = free.buildFreeFanoutPrompt({
    meeting: baseMeeting,
    selfSlot: 0,
    participants: [0, 1],
    userInput: 'hi',
    lastTurnInjection: null,
    turnNum: 1,
  });
  // 显式列出参与者（自由模式不藏 selfRole，只列发言人）
  assert.ok(p.includes('Pikachu'), 'lists Pikachu');
  assert.ok(p.includes('Charmander'), 'lists Charmander');
  assert.ok(!p.includes('Squirtle'), '未勾选的不列出');
}

function testFanoutHasNoMainCoPilot() {
  // 确认 free 模式 prompt 完全不包含"主驾"/"副驾"/"co-pilot" 字眼
  const p = free.buildFreeFanoutPrompt({
    meeting: baseMeeting,
    selfSlot: 0,
    participants: [0, 1, 2],
    userInput: 'q',
    lastTurnInjection: null,
    turnNum: 2,
  });
  assert.ok(!p.includes('主驾'), 'no 主驾');
  assert.ok(!p.includes('副驾'), 'no 副驾');
  assert.ok(!p.includes('co-pilot'), 'no co-pilot');
}

function testDebateFirstLineContract() {
  const p = free.buildFreeDebatePrompt({
    meeting: baseMeeting,
    selfSlot: 1,
    participants: [0, 1],
    userInput: '反驳一下',
    lastTurnInjection: null,
    turnNum: 6,
  });
  const firstLine = p.split('\n')[0];
  assert.ok(/第\s*6\s*轮/.test(firstLine), 'turn number');
  assert.ok(firstLine.includes('自由模式'), 'free mode marker');
  assert.ok(firstLine.includes('debate'), 'mode marker');
}

function testDebateMentionsRebuttal() {
  const p = free.buildFreeDebatePrompt({
    meeting: baseMeeting,
    selfSlot: 0,
    participants: [0, 1],
    userInput: 'q',
    lastTurnInjection: null,
    turnNum: 1,
  });
  // 辩论 prompt 必须明确说"反驳/呼应"
  assert.ok(p.includes('反驳') || p.includes('呼应'), 'debate prompt mentions rebut/respond');
}

function testSummaryFirstLineContract() {
  const p = free.buildFreeSummaryPrompt({
    meeting: baseMeeting,
    summarizerSlot: 'squirtle',
    userInput: '',
    lastTurnInjection: null,
    turnNum: 7,
  });
  const firstLine = p.split('\n')[0];
  assert.ok(/第\s*7\s*轮/.test(firstLine), 'turn number');
  assert.ok(firstLine.includes('自由模式'), 'free mode marker');
  assert.ok(firstLine.includes('summary'), 'mode marker');
  assert.ok(firstLine.includes('Squirtle'), 'summarizer label');
}

function testSummaryNoMainCoPilot() {
  const p = free.buildFreeSummaryPrompt({
    meeting: baseMeeting,
    summarizerSlot: 'pikachu',
    userInput: '',
    lastTurnInjection: null,
    turnNum: 3,
  });
  assert.ok(!p.includes('主驾'), 'summary no 主驾');
  assert.ok(!p.includes('副驾'), 'summary no 副驾');
}

function testInjectionIsRendered() {
  const inj = {
    lastTurnNum: 4,
    lastTurnMode: 'fanout',
    lastDispatchMode: 'all',
    isSummaryInjection: false,
    speakers: [
      { sid: 'sid_pi', label: 'Pikachu', role: null, text: '上一轮 Pikachu 说了 X', status: 'completed' },
    ],
  };
  const p = free.buildFreeFanoutPrompt({
    meeting: baseMeeting,
    selfSlot: 1,
    participants: [0, 1],
    userInput: 'q',
    lastTurnInjection: inj,
    turnNum: 5,
  });
  assert.ok(p.includes('上一轮 Pikachu 说了 X'), 'injection text rendered');
  assert.ok(p.includes('Pikachu'), 'injection speaker label rendered');
}

console.log('--- roundtable-free prompt ---');
run('testFanoutFirstLineContract', testFanoutFirstLineContract);
run('testFanoutListsParticipants', testFanoutListsParticipants);
run('testFanoutHasNoMainCoPilot', testFanoutHasNoMainCoPilot);
run('testDebateFirstLineContract', testDebateFirstLineContract);
run('testDebateMentionsRebuttal', testDebateMentionsRebuttal);
run('testSummaryFirstLineContract', testSummaryFirstLineContract);
run('testSummaryNoMainCoPilot', testSummaryNoMainCoPilot);
run('testInjectionIsRendered', testInjectionIsRendered);

process.exit(failed > 0 ? 1 : 0);
