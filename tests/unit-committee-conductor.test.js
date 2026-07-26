'use strict';
/**
 * 投委会五幕状态机单测（task#3）。
 * mock dispatchTurn / getGroupMembers / emitProgress，验证编排骨架：
 * 角色分配、幕次顺序、各幕选委员（主席幕 vs 全员幕）、辩论迭代+主席收口、抽取双榜、主席换帽子。
 */
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..');
const cc = require(path.join(root, 'main', 'groupchat', 'committee-conductor.js'));
const T = cc._test;

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log(' FAIL ' + m); } else { console.log('  ok   ' + m); } };

// ───── 纯函数 ─────
// 角色分配：claude 优先当主席；kind→face
const roles = T.assignRoles([
  { memberId: 'ds', kind: 'deepseek', displayName: 'DeepSeek' },
  { memberId: 'cl', kind: 'claude', displayName: 'Claude' },
  { memberId: 'cx', kind: 'codex', displayName: 'Codex' },
]);
const byId = Object.fromEntries(roles.map(r => [r.memberId, r]));
ok(byId.cl.isChair === true, '角色: Claude 兼主席');
ok(byId.ds.isChair === false && byId.cx.isChair === false, '角色: 仅一个主席');
ok(byId.ds.face === '技术面' && byId.cl.face === '基本面' && byId.cx.face === '消息面', '角色: 三面映射 DS技术/CL基本/CX消息');

// parseLastJson：围栏 + 平衡{} 兜底 + 容错
ok(JSON.stringify(T.parseLastJson('前言\n```json\n{"a":1}\n```')) === '{"a":1}', 'parseLastJson 围栏');
ok(T.parseLastJson('说了一堆 {"b":2} 结尾').b === 2, 'parseLastJson 平衡{}兜底');
ok(T.parseLastJson('没有json') === null, 'parseLastJson 无JSON返null');
ok(T.parseLastJson('坏的 {bad json') === null, 'parseLastJson 坏JSON返null不崩');

// buildBoards：双榜聚合 + 矛盾探针 + 风险隔离
const stocks = [{ code: '688256', name: '寒武纪' }, { code: '603823', name: '百合花' }];
const reviews = [
  { label: 'DeepSeek', byStock: { '688256': { chase: 85, ambush: 45, faces: { 技术面: 88 } }, '603823': { chase: 30, ambush: 65, faces: { 技术面: 40 }, veto: true } } },
  { label: 'Claude', byStock: { '688256': { chase: 85, ambush: 45 }, '603823': { chase: 70, ambush: 65, veto: true } } },
];
const boards = T.buildBoards(reviews, stocks);
ok(boards.chase_ranking[0].code === '688256', '双榜: 追涨榜寒武纪居首');
ok(boards.ambush_ranking[0].code === '603823', '双榜: 低吸榜百合花居首');
ok(boards.probes.some(p => p.code === '603823'), '矛盾探针: 百合花追涨分分歧(30 vs 70)');
ok(boards.isolated.some(i => i.code === '603823'), '风险隔离: 百合花被否决');

// parseChair
const chair = T.parseChair('综合\n```json\n{"chase_buys":[{"code":"688256","name":"寒武纪","rank":1}],"ambush_buys":[],"appendix":"宁错过"}\n```');
ok(chair.chase_buys.length === 1 && chair.appendix === '宁错过', 'parseChair 抽主席报告');

// ───── 编排（mock dispatchTurn）─────
const NAME = { ds: 'DeepSeek', cl: 'Claude', cx: 'Codex' };
function fakeText(prompt, id) {
  if (prompt.includes('收敛') && prompt.includes('换帽子')) {
    return '主席换帽子综合。\n```json\n' + JSON.stringify({
      chase_buys: [{ code: '688256', name: '寒武纪', rank: 1, reason: '最强龙' }],
      ambush_buys: [{ code: '603823', name: '百合花', rank: 1, reason: '回调企稳' }],
      cross_advice: '资金有限先追寒武纪', conflict_rulings: [{ topic: '百合花技术', ruling: '弱', evidence: '背离' }],
      isolated: [], appendix: '宁错过不做错',
    }) + '\n```';
  }
  if (prompt.includes('点评') || prompt.includes('辩论')) {
    const hi = prompt.includes('辩论');
    const cz = { faces: { 基本面: 60, 技术面: 88, 消息面: 80 }, chase: 85, ambush: 45, lean: '追涨', veto: false, top_bull: ['强势龙[追涨向]'], top_bear: [] };
    const bh = { faces: { 基本面: 45, 技术面: 40, 消息面: 70 }, chase: hi ? 32 : 30, ambush: 65, lean: '低吸', veto: hi, top_bull: ['催化[低吸向]'], top_bear: ['题材存疑'] };
    if (id === 'cl') bh.chase = hi ? 35 : 70; // 制造矛盾探针 spread
    return '点评中。\n```json\n' + JSON.stringify({ stocks: { '688256': cz, '603823': bh } }) + '\n```';
  }
  return '[' + id + '] ' + prompt.slice(0, 16) + ' … 发言完毕';
}
const calls = [];
const events = [];
const speechCalls = [];
const persistedRecords = [];
const conductor = cc.createCommitteeConductor({
  dispatchTurn: async (meetingId, opts) => {
    calls.push({ ids: opts.targetMemberIds.slice(), silent: opts.silent, prompt: opts.userInput });
    const results = opts.targetMemberIds.map(id => ({ sid: id + 's', label: NAME[id], status: 'ok', text: fakeText(opts.userInput, id) }));
    return { status: 'completed', results };
  },
  getGroupMembers: () => [
    { memberId: 'ds', kind: 'deepseek', displayName: 'DeepSeek' },
    { memberId: 'cl', kind: 'claude', displayName: 'Claude' },
    { memberId: 'cx', kind: 'codex', displayName: 'Codex' },
  ],
  emitProgress: (mid, p) => events.push(p),
  appendSpeeches: (mid, items, actMeta) => { speechCalls.push({ mid, items, actMeta }); return (items || []).length; },
  persistHistory: (rec) => { persistedRecords.push(rec); return 'hist-1'; },
});

(async () => {
  const out = await conductor.run('m1', { stocks: [{ code: '688256', name: '寒武纪' }, { code: '603823', name: '百合花' }], rounds: 2 }); // rounds = 辩论轮数（点5）：2 轮辩论

  ok(out.status === 'completed', 'run 完成');
  ok(out.chair.displayName === undefined && out.members.find(m => m.isChair).label === 'Claude', '主席=Claude');

  // 幕次顺序（act 事件）
  const actSeq = events.filter(e => e.type === 'act').map(e => e.act);
  ok(JSON.stringify(actSeq) === JSON.stringify(['立会', '建库', '点评', '辩论', '辩论', '收敛']),
    '幕次顺序: 立会→建库→点评→辩论×2→收敛 (实得 ' + actSeq.join('/') + ')');

  // 各幕选委员：立会=[cl], 建库/点评/辩论=[ds,cl,cx], 收口=[cl], 收敛=[cl]
  ok(JSON.stringify(calls[0].ids) === JSON.stringify(['cl']), '立会只主席发');
  ok(calls[1].ids.length === 3 && calls[2].ids.length === 3, '建库/点评全员并行');
  ok(JSON.stringify(calls[3].ids) === JSON.stringify(['ds', 'cl', 'cx']), '辩论1全员交锋');
  ok(JSON.stringify(calls[4].ids) === JSON.stringify(['cl']), '辩论1主席串行收口');
  ok(JSON.stringify(calls[calls.length - 1].ids) === JSON.stringify(['cl']), '收敛只主席(换帽子)');
  ok(calls.length === 7, 'dispatchTurn 调用 7 次 (立会+建库+点评+辩论×2+收口×1末轮跳+收敛) 实得 ' + calls.length);
  ok(JSON.stringify(calls[5].ids) === JSON.stringify(['ds', 'cl', 'cx']) && JSON.stringify(calls[6].ids) === JSON.stringify(['cl']), '末轮辩论后直接收敛(跳收口)，避免主席连续被叫');
  ok(calls.every(c => c.silent === true), '所有幕 silent:true (内部编排不当用户消息)');

  // 抽取 + 双榜
  ok(out.boards.chase_ranking[0].code === '688256', '终局追涨榜寒武纪居首');
  ok(out.boards.ambush_ranking[0].code === '603823', '终局低吸榜百合花居首');
  ok(out.boards.isolated.some(i => i.code === '603823'), '辩论后百合花被否决→风险隔离');

  // 主席报告
  ok(out.chair.chase_buys.length === 1 && out.chair.chase_buys[0].code === '688256', '主席追涨买入榜=寒武纪');
  ok(out.chair.appendix.includes('宁错过'), '主席附言');

  // 阶段二: 每幕发言进群聊 messages（appendSpeeches）+ 末轮/收敛标 outcome（点6 喂回 AI）
  ok(speechCalls.length >= 5, '阶段二: 每幕调 appendSpeeches 写发言进群聊 (实得 ' + speechCalls.length + ')');
  ok(speechCalls.some(c => c.actMeta.act === '建库' && c.items.length === 3), '阶段二: 建库幕 3 委员发言进 messages');
  ok(speechCalls.every(c => c.items.every(it => it.sid && it.content)), '阶段二: 每条发言带 sid + content');
  const outcomeCalls = speechCalls.filter(c => c.actMeta && c.actMeta.outcome);
  ok(outcomeCalls.length >= 2, '点6: 末轮辩论+收敛标 outcome (实得 ' + outcomeCalls.length + ')');
  ok(outcomeCalls.some(c => c.actMeta.act === '辩论') && outcomeCalls.some(c => c.actMeta.act === '收敛'), '点6: outcome 含末轮辩论 + 收敛');

  // 点4/点3a: 每幕 emit act-detail（前端按幕看每个 AI 表现）+ 闭庭持久化整场 record
  const details = events.filter(e => e.type === 'act-detail');
  ok(details.length >= 5, '点4: 每幕都 emit act-detail (实得 ' + details.length + ')');
  ok(details.some(d => d.act === '建库' && d.speeches.length === 3), '点4: 建库幕带 3 委员发言原文');
  ok(details.some(d => d.act === '辩论' && d.round === 1 && d.sub === '交锋'), '点4: 辩论幕 act-detail 带 round+sub');
  ok(persistedRecords.length === 1, '点3a: 闭庭持久化一次');
  const rec = persistedRecords[0];
  ok(rec.acts && rec.acts.length >= 5 && Array.isArray(rec.stocks) && rec.chairReport, '点3a: record 含 acts/stocks/chairReport');
  ok((rec.acts.find(a => a.act === '点评') || {}).speeches.length === 3, '点3a: record 点评幕含 3 委员发言原文');

  // 进度事件齐全
  ok(events[0].type === 'start' && events[events.length - 1].type === 'done', '进度: start…done');
  ok(events.some(e => e.type === 'board') && events.some(e => e.type === 'chair'), '进度: board + chair 事件');

  console.log('\n' + (fails === 0 ? '=== committee-conductor 全绿 ===' : '=== ' + fails + ' FAILED ==='));
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('THREW', e); process.exit(1); });
