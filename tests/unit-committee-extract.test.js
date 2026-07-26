'use strict';
/**
 * 投委会抽取/双榜聚合单测（task#4）。聚焦强化点：lean 共识、top3 方向去重、coverage 降级、容错。
 */
const assert = require('assert');
const path = require('path');
const ex = require(path.join(__dirname, '..', 'core', 'committee-extract.js'));

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log(' FAIL ' + m); } else { console.log('  ok   ' + m); } };

// ── parseLastJson 边界 ──
ok(ex.parseLastJson('x\n```json\n{"a":1}\n```').a === 1, 'parseLastJson: 围栏');
ok(ex.parseLastJson('尾巴 {"b":2}').b === 2, 'parseLastJson: 平衡{}兜底');
ok(ex.parseLastJson('多个 ```json\n{"a":1}\n``` 再 ```json\n{"a":9}\n```').a === 9, 'parseLastJson: 取最后一个JSON');
ok(ex.parseLastJson('无') === null && ex.parseLastJson('{坏') === null && ex.parseLastJson(null) === null, 'parseLastJson: 容错返null');

// ── extractReviews: 多委员 + 缺JSON + 非法code过滤 ──
const stocks = [{ code: '688256', name: '寒武纪' }, { code: '603823', name: '百合花' }];
const results = [
  { label: 'DeepSeek', status: 'ok', text: '技术面点评 ```json\n' + JSON.stringify({ stocks: { '688256': { chase: 88, ambush: 40, lean: '追涨', faces: { 技术面: 90 }, top_bull: ['强势龙[追涨向]'] }, '603823': { chase: 30, ambush: 60, lean: '低吸', veto: true, top_bear: ['题材存疑'] }, '999999': { chase: 50 } } }) + '\n```' },
  { label: 'Claude', status: 'ok', text: '基本面点评 ```json\n' + JSON.stringify({ stocks: { '688256': { chase: 82, ambush: 50, lean: '追涨', faces: { 基本面: 60 }, top_bull: ['市占10%[通用]', '强势龙[追涨向]'] }, '603823': { chase: 70, ambush: 60, lean: '低吸', veto: true } } }) + '\n```' },
  { label: 'Codex', status: 'ok', text: '消息面没给结构化 JSON，纯文字。' },
];
const reviews = ex.extractReviews(results, stocks);
ok(reviews.length === 3, 'extractReviews: 3 委员');
ok(reviews[0].hasJson === true && reviews[2].hasJson === false, '缺JSON委员 hasJson=false');
ok(!reviews[0].byStock['999999'], '非标的代码被过滤');
ok(reviews[0].byStock['688256'].chase === 88, '抽出 chase 分');

// ── buildBoards 强化 ──
const boards = ex.buildBoards(reviews, stocks);
const cz = boards.rows.find(r => r.code === '688256');
const bh = boards.rows.find(r => r.code === '603823');
ok(cz.chase_agg === 85, '双榜聚合: 寒武纪 chase 平均(88,82)=85');
ok(cz.lean_consensus === '追涨', 'lean 共识: 寒武纪=追涨');
ok(cz.top_bull.includes('强势龙[追涨向]') && cz.top_bull.includes('市占10%[通用]'), 'top_bull 聚合+去重(强势龙只一条)');
ok(cz.top_bull.filter(x => x === '强势龙[追涨向]').length === 1, 'top_bull 去重生效');
ok(cz.coverage.gave === 2 && cz.coverage.total === 3 && cz.coverage.degraded === true, 'coverage: 2/3 委员给分→降级标注');
ok(boards.chase_ranking[0].code === '688256', '追涨榜寒武纪居首');
ok(boards.ambush_ranking[0].code === '603823', '低吸榜百合花居首');
ok(boards.probes.some(p => p.code === '603823'), '矛盾探针: 百合花 chase 30 vs 70 分歧');
ok(boards.isolated.some(i => i.code === '603823' && i.by.length === 2), '风险隔离: 百合花被2委员否决');

// ── per_member: 每委员对该股的原始打分 + gave（排查谁没给分） ──
const pmCz = boards.rows.find(r => r.code === '688256');
ok(pmCz.per_member && pmCz.per_member.length === 3, 'per_member: 含全部 3 委员');
ok(pmCz.per_member.find(m => m.label === 'DeepSeek').gave === true && pmCz.per_member.find(m => m.label === 'DeepSeek').chase === 88, 'per_member: DeepSeek 给了分(chase 88)');
ok(pmCz.per_member.find(m => m.label === 'Codex').gave === false, 'per_member: Codex 没给结构化分(gave=false)→可排查出是它没输出');

// ── mergeReviews: 辩论覆盖 ──
const next = ex.extractReviews([{ label: 'DeepSeek', status: 'ok', text: '辩论改判 ```json\n' + JSON.stringify({ stocks: { '603823': { chase: 20, ambush: 55, lean: '观望', veto: true } } }) + '\n```' }], stocks);
const merged = ex.mergeReviews(reviews, next);
const dsMerged = merged.find(r => r.label === 'DeepSeek');
ok(dsMerged.byStock['603823'].chase === 20, 'mergeReviews: 辩论后 DS 把百合花 chase 30→20');
ok(dsMerged.byStock['688256'].chase === 88, 'mergeReviews: 未改动的标的保留');

// ── 点1/3b：用户输名字（无代码）——委员按名字做 key 的打分不再被 validCodes 过滤丢弃 ──
const nstocks = [{ code: '', name: '长川科技' }, { code: '', name: '北方华创' }];
ok(ex.idOf(nstocks[0]) === '长川科技', 'idOf: 无代码用名称');
ok(ex.idOf({ code: '688256', name: '寒武纪' }) === '688256', 'idOf: 有代码用代码');
ok(ex.labelOf(nstocks[0]) === '长川科技', 'labelOf: 无代码只显名（不重复）');
ok(ex.labelOf({ code: '688256', name: '寒武纪' }) === '688256 寒武纪', 'labelOf: 代码+名');
ok(ex.labelOf({ code: '长川科技', name: '长川科技' }) === '长川科技', 'labelOf: code===name 去重（旧数据兼容，不再「长川科技 长川科技」）');
const nreviews = ex.extractReviews([
  { label: 'DeepSeek', status: 'ok', text: '点评 ```json\n' + JSON.stringify({ stocks: { '长川科技': { chase: 78, ambush: 60, faces: { 技术面: 82 } }, '北方华创': { chase: 66, ambush: 70 } } }) + '\n```' },
], nstocks);
ok(nreviews[0].byStock['长川科技'] && nreviews[0].byStock['长川科技'].chase === 78, '点3b: 输名字时委员按名字 key 的打分不再被丢弃');
const nboards = ex.buildBoards(nreviews, nstocks);
ok(nboards.rows.find(r => r.code === '长川科技').faces.技术面 === 82, '点3b: 绝对体检拿到三面分（不再全 0/3）');
ok(nboards.chase_ranking[0].code === '长川科技', '点3b: 相对买入榜聚合出来（不再「暂无」）');

// ── parseChair: 正常 + 降级 ──
const chairOk = ex.parseChair('报告\n```json\n{"chase_buys":[{"code":"688256","rank":1}],"appendix":"宁错过"}\n```');
ok(chairOk.chase_buys.length === 1 && chairOk.degraded === false, 'parseChair: 正常抽取');
const chairBad = ex.parseChair('主席只说了大白话没给 JSON');
ok(chairBad.degraded === true && chairBad.chase_buys.length === 0 && chairBad.raw.length > 0, 'parseChair: 无JSON降级保留原文');

console.log('\n' + (fails === 0 ? '=== committee-extract 全绿 ===' : '=== ' + fails + ' FAILED ==='));
process.exit(fails === 0 ? 0 : 1);
