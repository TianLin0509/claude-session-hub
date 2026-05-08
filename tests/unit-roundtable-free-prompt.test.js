'use strict';
// 测 core/roundtable-free.js prompt 三模板 + 第一行格式契约
// 2026-05-04 P6: free 路径纳入 L3 统一骨架 (5 段 + 字段化调度上下文 + footer 压缩)
//   B1 决议: 第一行从 `# 自由模式 第 N 轮 ...` 改为 `[<scene> · 第 N 轮 · <模式>]`
//   C1 决议: 轻提醒 (≤ 1500 字 / 不写文件 / 不展开多步骤工作流) 注入

const assert = require('assert');
const free = require('../core/roundtable-free');

let failed = 0;
function run(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + ':', e.message); failed++; }
}

const baseMeeting = {
  scene: 'general',
  subSessions: ['sid_pi', 'sid_ch', 'sid_sq'],
  participants: [0, 1, 2],
};

// === P6 B1: 第一行使用 pilot 格式 [<scene> · 第 N 轮 · <模式>] ===
function testFanoutFirstLineContract() {
  const p = free.buildFreeFanoutPrompt({
    meeting: baseMeeting,
    selfSlot: 1,
    participants: [0, 1],
    userInput: 'hello',
    lastTurnInjection: null,
    turnNum: 5,
    sceneName: '通用圆桌',
  });
  const firstLine = p.split('\n')[0];
  // P6 B1 契约: [<scene> · 第 N 轮 · 默认提问]
  assert.ok(firstLine.length > 0, 'first line non-empty');
  assert.ok(/^\[.+ · 第 \d+ 轮 · .+\]$/.test(firstLine), `first line matches [<scene> · 第 N 轮 · <模式>] format, got: ${firstLine}`);
  assert.ok(firstLine.includes('第 5 轮'), 'first line contains turn number');
  assert.ok(firstLine.includes('默认提问'), 'first line includes 默认提问 (fanout)');
  assert.ok(firstLine.includes('通用圆桌'), 'first line includes scene name');
  // 防回归: 旧 `# 自由模式` 格式不应再出现
  assert.ok(!firstLine.startsWith('# 自由模式'), 'P6 B1: must not use old `# 自由模式` format');
  assert.ok(!firstLine.startsWith('##'), 'must not be ## title');
}

function testDebateFirstLineContract() {
  const p = free.buildFreeDebatePrompt({
    meeting: baseMeeting,
    selfSlot: 1,
    participants: [0, 1],
    userInput: '反驳一下',
    lastTurnInjection: null,
    turnNum: 6,
    sceneName: '通用圆桌',
  });
  const firstLine = p.split('\n')[0];
  assert.ok(/^\[.+ · 第 \d+ 轮 · .+\]$/.test(firstLine), `first line format, got: ${firstLine}`);
  assert.ok(firstLine.includes('第 6 轮'), 'turn number');
  assert.ok(firstLine.includes('@debate'), 'mode marker');
  assert.ok(!firstLine.startsWith('# 自由模式'), 'P6 B1: no `# 自由模式` regression');
}

// 摘要功能 2026-05-08 整体下线：buildFreeSummaryPrompt 已删
function testFreeSummaryPromptRemoved() {
  assert.strictEqual(typeof free.buildFreeSummaryPrompt, 'undefined',
    'buildFreeSummaryPrompt 已删除（摘要功能下线）');
}

// === P6 字段化调度上下文契约 ===
function testFanoutHasFieldedDispatchContext() {
  const p = free.buildFreeFanoutPrompt({
    meeting: baseMeeting,
    selfSlot: 0,
    participants: [0, 1],
    userInput: 'hi',
    lastTurnInjection: null,
    turnNum: 1,
    sceneName: '通用圆桌',
  });
  // P6 必须含字段化调度上下文段
  assert.ok(p.includes('## 调度上下文'), 'has ## 调度上下文 section');
  assert.ok(p.includes('- 你是:'), 'has 你是 field');
  assert.ok(p.includes('- 参与者:'), 'has 参与者 field (free mode replaces "同台")');
  assert.ok(p.includes('- 模式:自由'), 'has 模式 field with 自由 prefix');
  assert.ok(p.includes('- 轮次性质:fanout'), 'has 轮次性质 field');
  assert.ok(p.includes('- 回答方式:'), 'has 回答方式 field');
  // C1 决议: 轻提醒注入
  assert.ok(p.includes('- 轻提醒:'), 'has 轻提醒 field (P6 C1)');
  assert.ok(p.includes('≤ 1500 字'), 'has 1500 字 limit (P6 C1 decision)');
}

function testFanoutListsParticipants() {
  const p = free.buildFreeFanoutPrompt({
    meeting: baseMeeting,
    selfSlot: 0,
    participants: [0, 1],
    userInput: 'hi',
    lastTurnInjection: null,
    turnNum: 1,
    sceneName: '通用圆桌',
  });
  assert.ok(p.includes('皮卡丘'), 'lists 皮卡丘');
  assert.ok(p.includes('小火龙'), 'lists 小火龙');
  assert.ok(!p.includes('杰尼龟'), '未勾选的不列出');
}

// === P6 B1: free 取消主驾/副驾概念,prompt 不应包含这些字眼 ===
function testFanoutHasNoMainCoPilot() {
  const p = free.buildFreeFanoutPrompt({
    meeting: baseMeeting,
    selfSlot: 0,
    participants: [0, 1, 2],
    userInput: 'q',
    lastTurnInjection: null,
    turnNum: 2,
    sceneName: '通用圆桌',
  });
  assert.ok(!p.includes('主驾'), 'no 主驾');
  assert.ok(!p.includes('副驾'), 'no 副驾');
  assert.ok(!p.includes('co-pilot'), 'no co-pilot');
}

function testDebateMentionsRebuttal() {
  const p = free.buildFreeDebatePrompt({
    meeting: baseMeeting,
    selfSlot: 0,
    participants: [0, 1],
    userInput: 'q',
    lastTurnInjection: null,
    turnNum: 1,
    sceneName: '通用圆桌',
  });
  // 辩论 prompt 必须明确说"反驳/呼应"(可在调度上下文"回答方式"字段或任务体)
  assert.ok(p.includes('反驳') || p.includes('呼应'), 'debate prompt mentions rebut/respond');
}

// 摘要功能 2026-05-08 整体下线：原 testSummaryNoMainCoPilot 已删

function testInjectionIsRendered() {
  const inj = {
    lastTurnNum: 4,
    lastTurnMode: 'fanout',
    lastDispatchMode: 'all',
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
    sceneName: '通用圆桌',
  });
  assert.ok(p.includes('上一轮 Pikachu 说了 X'), 'injection text rendered');
  assert.ok(p.includes('Pikachu'), 'injection speaker label rendered');
}

// === P6: 删除散落的独立行为提示段 (并入"回答方式"字段) ===
function testNoStandaloneAnswerStyleSection() {
  const fp = free.buildFreeFanoutPrompt({
    meeting: baseMeeting,
    selfSlot: 0,
    participants: [0, 1, 2],
    userInput: 'q',
    lastTurnInjection: null,
    turnNum: 1,
    sceneName: '通用圆桌',
  });
  // P6 删: 末尾"请独立回答（与其他发言人互相看不到本轮发言，保持各自独立视角）。"
  assert.ok(!fp.match(/\n\n请独立回答（与其他发言人互相看不到本轮发言/),
    'P6: standalone "请独立回答" section removed (merged into 回答方式 field)');

  const dp = free.buildFreeDebatePrompt({
    meeting: baseMeeting,
    selfSlot: 0,
    participants: [0, 1],
    userInput: 'q',
    lastTurnInjection: null,
    turnNum: 1,
    sceneName: '通用圆桌',
  });
  // P6 删: 末尾"请反驳/呼应其他发言人的观点（你们看得到对方本轮言论）。"
  assert.ok(!dp.match(/\n\n请反驳\/呼应其他发言人的观点（你们看得到对方本轮言论/),
    'P6: standalone "请反驳/呼应" section removed');
}

// === P6: timeline footer 压缩为 > 完整历史:path ===
function testTimelineFooterCompressed() {
  const p = free.buildFreeFanoutPrompt({
    meeting: baseMeeting,
    selfSlot: 0,
    participants: [0],
    userInput: 'q',
    lastTurnInjection: null,
    turnNum: 1,
    sceneName: '通用圆桌',
    timelinePath: '/tmp/timeline.md',
  });
  assert.ok(p.includes('> 完整历史:/tmp/timeline.md'), 'footer uses compressed > 完整历史: format');
  assert.ok(!p.includes('---\n完整历史:'), 'no old --- 双行 format');
}

// === turnNum 边界防御（保留原测试）===
function testFanoutTurnNumZeroFallback() {
  const p = free.buildFreeFanoutPrompt({
    meeting: baseMeeting,
    selfSlot: 0,
    participants: [0],
    userInput: 'q',
    lastTurnInjection: null,
    turnNum: 0,
    sceneName: '通用圆桌',
  });
  const firstLine = p.split('\n')[0];
  assert.ok(!firstLine.includes('第 0 轮'), 'turnNum=0 should fall back, not literal');
  assert.ok(firstLine.includes('第 ? 轮'), 'fallback ?');
}

function testFanoutTurnNumUndefinedFallback() {
  const p = free.buildFreeFanoutPrompt({
    meeting: baseMeeting,
    selfSlot: 0,
    participants: [0],
    userInput: 'q',
    lastTurnInjection: null,
    sceneName: '通用圆桌',
  });
  const firstLine = p.split('\n')[0];
  assert.ok(!firstLine.includes('undefined'), 'no undefined word');
  assert.ok(firstLine.includes('第 ? 轮'), 'fallback ?');
}

// === _slotLabel 数字字符串支持 (P6 后通过调度上下文段验证) ===
function testSlotLabelAcceptsNumericString() {
  const p = free.buildFreeFanoutPrompt({
    meeting: baseMeeting,
    selfSlot: '0',  // 数字字符串
    participants: [0],
    userInput: 'q',
    lastTurnInjection: null,
    turnNum: 1,
    sceneName: '通用圆桌',
  });
  // P6 后第一行不再含 selfLabel,改在调度上下文"你是"字段
  // 称谓中文化（2026-05-08）：_slotLabel 改走 getSlotPromptName 走中文
  assert.ok(p.includes('皮卡丘'), 'numeric string slot should resolve to 皮卡丘 (in 你是 field), not AI');
  assert.ok(p.includes('- 你是:⚡ 皮卡丘'), 'verifies 你是 field renders correctly');
  assert.ok(!p.includes('- 你是:AI'), 'no AI fallback for valid numeric string');
}

// === sceneName 兜底测试 (caller 不传时按 meeting.scene 兜底) ===
function testSceneNameFallback() {
  const p = free.buildFreeFanoutPrompt({
    meeting: { scene: 'research', subSessions: ['a', 'b', 'c'], participants: [0] },
    selfSlot: 0,
    participants: [0],
    userInput: 'q',
    lastTurnInjection: null,
    turnNum: 1,
    // sceneName 未传
  });
  const firstLine = p.split('\n')[0];
  assert.ok(firstLine.includes('投研圆桌'), 'fallback to 投研圆桌 from meeting.scene=research');
}

console.log('--- roundtable-free prompt (P6 unified skeleton) ---');
run('testFanoutFirstLineContract', testFanoutFirstLineContract);
run('testFanoutListsParticipants', testFanoutListsParticipants);
run('testFanoutHasFieldedDispatchContext', testFanoutHasFieldedDispatchContext);
run('testFanoutHasNoMainCoPilot', testFanoutHasNoMainCoPilot);
run('testDebateFirstLineContract', testDebateFirstLineContract);
run('testDebateMentionsRebuttal', testDebateMentionsRebuttal);
run('testFreeSummaryPromptRemoved', testFreeSummaryPromptRemoved);
run('testInjectionIsRendered', testInjectionIsRendered);
run('testNoStandaloneAnswerStyleSection', testNoStandaloneAnswerStyleSection);
run('testTimelineFooterCompressed', testTimelineFooterCompressed);
run('testFanoutTurnNumZeroFallback', testFanoutTurnNumZeroFallback);
run('testFanoutTurnNumUndefinedFallback', testFanoutTurnNumUndefinedFallback);
run('testSlotLabelAcceptsNumericString', testSlotLabelAcceptsNumericString);
run('testSceneNameFallback', testSceneNameFallback);

process.exit(failed > 0 ? 1 : 0);
