'use strict';
// 投委会 JS 高置信 bug 修复单测（2026-06-13 审计）：
//   ① scene.extractJsonBlock 括号配平兜底（不用围栏/JSON 后跟解释/不以换行+{ 开头）
//   ② conductor 路由负缓存中毒（失败不固化，条件变化后能重新识别）
// 跑法：node tests/unit-committee-bugfix.test.js

const assert = require('assert');
const scene = require('../core/committee-scene.js');
const { createCommitteeConductor } = require('../main/groupchat/committee-conductor.js');

let passed = 0;
function t(name, fn) {
  try { fn(); passed += 1; console.log('  ok -', name); }
  catch (e) { console.error('  FAIL -', name, ':', e.message); process.exitCode = 1; }
}

// ---- ① extractJsonBlock 括号配平 ----
t('围栏 json 正常解析', () => {
  const o = scene.extractJsonBlock('前言\n```json\n{"signal":"看多","confidence":70}\n```\n后记');
  assert.strictEqual(o.signal, '看多');
  assert.strictEqual(o.confidence, 70);
});

t('无围栏 + JSON 后还跟解释（旧版 lastIndexOf 会截错）', () => {
  const text = '我的结论是 {"rating":"A","ok":true} ，以上就是分析。';
  const o = scene.extractJsonBlock(text);
  assert.ok(o, '应能提取到 JSON');
  assert.strictEqual(o.rating, 'A');
});

t('正文先出现别的花括号，应取真正的对象', () => {
  const text = '举例 {x:1} 是无效的；真正结论：```json\n{"rating":"B","cap":10}\n```';
  const o = scene.extractJsonBlock(text);
  assert.strictEqual(o.rating, 'B');
  assert.strictEqual(o.cap, 10);
});

t('JSON 不以换行+{ 开头（行内缩进）也能提取', () => {
  const text = '    {"signal":"看空","confidence":40}';
  const o = scene.extractJsonBlock(text);
  assert.strictEqual(o.signal, '看空');
});

t('无 JSON 返回 null', () => {
  assert.strictEqual(scene.extractJsonBlock('完全没有 JSON 的纯文本'), null);
  assert.strictEqual(scene.extractJsonBlock(''), null);
});

t('字符串内的花括号不破坏配平', () => {
  const o = scene.extractJsonBlock('```json\n{"note":"风险点 {重要}","ok":1}\n```');
  assert.strictEqual(o.note, '风险点 {重要}');
  assert.strictEqual(o.ok, 1);
});

// ---- 新功能：机器加权基线（反 sycophancy 锚） ----
t('aggregateSignals 按 confidence 加权方向', () => {
  const reports = {
    fund: { valid: true, json: { signal: '看多', confidence: 80 } },
    news: { valid: true, json: { signal: '看多', confidence: 60 } },
    tech: { valid: true, json: { signal: '看空', confidence: 50 } },
  };
  const b = scene.aggregateSignals(reports);
  assert.strictEqual(b.direction, '看多');           // 多 140 vs 空 50
  assert.strictEqual(b.n, 3);
  assert.ok(b.net_score > 10);
  assert.ok(b.consensus >= 50 && b.consensus <= 100);
});

t('aggregateSignals 忽略缺席/skip/中性不计方向', () => {
  const reports = {
    fund: { valid: false, json: null },                       // 缺席
    news: { valid: true, json: { signal: 'skip', confidence: 90 } },  // skip
    tech: { valid: true, json: { signal: '中性', confidence: 70 } },
  };
  const b = scene.aggregateSignals(reports);
  assert.strictEqual(b.direction, '中性');
  assert.strictEqual(b.n, 1);   // 只有 tech 计入
});

t('buildAct3ChairPrompt 注入基线 + 偏离须说明', () => {
  const p = scene.buildAct3ChairPrompt('@m5', { maxRating: 'S', baseline: { direction: '看多', net_score: 40, consensus: 70, bull: 140, bear: 50, neutral: 0, n: 3 } });
  assert.ok(p.includes('机器加权基线'), '含基线行');
  assert.ok(p.includes('看多'), '含方向');
  assert.ok(p.includes('必须在决议正文明确说明为何偏离'), '含偏离须说明');
});

t('buildAct3ChairPrompt 无基线时不报错', () => {
  const p = scene.buildAct3ChairPrompt('@m5', { maxRating: 'B' });
  assert.ok(p.includes('主席裁决'));
  assert.ok(!p.includes('机器加权基线'));
});

// ---- decideChallenge 量化共识增强 ----
t('decideChallenge: 加权共识高度集中(未全同向)也触发质询', () => {
  const reports = {
    fund: { valid: true, json: { signal: '看多', confidence: 90 } },
    news: { valid: true, json: { signal: '看多', confidence: 80 } },
    tech: { valid: true, json: { signal: '看空', confidence: 20 } }, // 弱看空，共识仍≈89%
  };
  const d = scene.decideChallenge(reports, 'quick');
  assert.strictEqual(d.challenge, true);
});

t('decideChallenge: 真实质均势分歧 → 跳过', () => {
  const reports = {
    fund: { valid: true, json: { signal: '看多', confidence: 80 } },
    news: { valid: true, json: { signal: '看空', confidence: 75 } },
  };
  assert.strictEqual(scene.decideChallenge(reports, 'quick').challenge, false);
});

t('decideChallenge: errored 席位不拉低 avgConf(修样本集 bug)', () => {
  const reports = {
    fund: { valid: true, json: { signal: '看多', confidence: 80 } },
    news: { valid: true, json: { signal: '看多', confidence: 78 } },
    tech: { valid: false, json: null }, // 缺席不应被当 conf=0 拉低均值
  };
  // 两席同向高信心 → 应触发（若错误把 errored 计入 conf=0，avg≈52.7 不会触发）
  assert.strictEqual(scene.decideChallenge(reports, 'quick').challenge, true);
});

// ---- ② 路由负缓存中毒修复 ----
async function routeCacheTest() {
  const sessions = {
    fund: { id: 'fund', kind: 'deepseek', status: 'active' },
    news: { id: 'news', kind: 'claude', status: 'active' },
    tech: { id: 'tech', kind: 'codex', status: 'active' },
    challenger: { id: 'challenger', kind: 'codex', status: 'active' },
    chair: { id: 'chair', kind: 'claude', status: 'active' },
  };
  // 第一次 LLM 路由返回垃圾（识别失败 → route=null）；翻转后返回合法 JSON。
  let llmReturnsValid = false;
  const conductor = createCommitteeConductor({
    dispatchGroupChatTurn: async () => ({
      status: 'completed',
      results: [{
        sid: 'chair',
        text: llmReturnsValid
          ? JSON.stringify({ intent: 'single_stock', mode: 'quick', symbols: [{ name: '赛力斯', symbol: '601127' }], needs_clarification: false })
          : '抱歉我无法识别（故意返回非 JSON 让路由失败）',
      }],
    }),
    meetingManager: {
      getMeeting: () => ({ scene: 'committee', groupChat: true, subSessions: ['fund', 'news', 'tech', 'challenger', 'chair'] }),
    },
    sessionManager: { getSession: sid => sessions[sid] || null },
    logger: { log() {}, warn() {}, error() {} },
    sendToRenderer() {},
  });

  const input = '请用投委会分析我刚说的那个核心标的';
  const first = await conductor.isCommitteeCommand('m-poison', input);
  assert.strictEqual(first, false, '首次 LLM 识别失败应返回 false');

  // 关键：失败结果不应被缓存固化。翻转使 LLM 现在能成功识别。
  llmReturnsValid = true;
  const second = await conductor.isCommitteeCommand('m-poison', input);
  assert.strictEqual(second, true, '修复后：失败未被固化，条件变化后同一输入应能重新识别');
}

// ---- run ----
(async () => {
  await routeCacheTest().then(() => { passed += 1; console.log('  ok - 路由负缓存不固化失败结果'); })
    .catch(e => { console.error('  FAIL - 路由负缓存:', e.message); process.exitCode = 1; });
  console.log(`${passed} passed`);
})();
