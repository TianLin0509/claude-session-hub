'use strict';
/**
 * screener-score 真实数据单测（task#1）。
 * 真读 C:\Users\lintian\kline-screener\data.json（本机开发数据）；文件不存在则 skip。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const screener = require(path.join(root, 'core', 'screener-score.js'));

if (!fs.existsSync(screener.DATA_PATH)) {
  console.log('screener-score: data.json 不存在，skip 真实数据断言（' + screener.DATA_PATH + '）');
  process.exit(0);
}

// ── 池内票 ──
// 原来写死百合花 603823。池子每天随行情轮动，该票一旦出池整个测试就红，
// 而这跟被测代码毫无关系（2026-07-27 实测连挂）。改为从当日榜单动态取样：
// 结构、归一化、NaN 容错这些真正要守的契约一条没少，只是不再绑定某只票。
const snapForPick = screener.latestSnapshot({ limit: 5 });
const poolPick = (snapForPick.top_chase[0] || snapForPick.top_setup[0] || {}).code;
assert.ok(poolPick, '当日榜单必须至少有一只候选票，否则 data.json 有问题');

const bh = screener.brief(poolPick);
assert.strictEqual(bh.available, true, `${poolPick} 应在池内 available=true`);
assert.strictEqual(bh.in_pool, true, `${poolPick} in_pool=true`);
assert.ok(['chase', 'setup'].includes(bh.mode), 'mode 应为 chase/setup');
assert.ok(typeof bh.screener_score === 'number' && bh.screener_score > 0, 'screener_score 正数');
assert.ok(typeof bh.chase_score === 'number', 'chase_score 数值');
assert.ok(bh.summary && bh.summary.length > 10, 'summary 非空白话');
assert.ok(bh.end_date && String(bh.end_date).length === 8, 'end_date 截止日 YYYYMMDD');
assert.ok(Object.keys(bh.indicators).length >= 5, 'indicators 至少 5 项');
// NaN 容错铁律：每个指标要么有限数要么 null，绝不能漏出 NaN
for (const [k, v] of Object.entries(bh.indicators)) {
  assert.ok(v === null || Number.isFinite(v), `indicator ${k} 不能是 NaN/Infinity，得到 ${v}`);
}

// ── 代码归一化：带交易所后缀也命中同一条 ──
const suffixed = `${poolPick}${poolPick.startsWith('6') ? '.SH' : '.SZ'}`;
const bh2 = screener.brief(suffixed);
assert.strictEqual(bh2.available, true, `${suffixed} 带后缀也应命中`);
assert.strictEqual(bh2.chase_score, bh.chase_score, '后缀归一化后结果一致');

// ── 池外票：同样动态挑，避免某天茅台真的进了池导致假失败 ──
const outCandidates = ['600519', '000858', '601398', '600036', '000001'];
const outPick = outCandidates.find(code => screener.brief(code).available === false);
assert.ok(outPick, `候选里应至少有一只池外票（试过 ${outCandidates.join('/')}）`);
const mt = screener.brief(outPick);
assert.strictEqual(mt.available, false, `${outPick} 池外 available=false`);
assert.ok(mt.note && mt.note.includes('不脑补'), '降级 note 必须标注「不脑补」');

// ── promptBlock 文本块 ──
const pbIn = screener.promptBlock(poolPick);
assert.ok(pbIn.includes('kline-screener') && (pbIn.includes('追涨') || pbIn.includes('蓄势')), 'promptBlock 池内含技术初筛+模式');
assert.ok(!pbIn.includes('NaN'), 'promptBlock 不得漏出 NaN 文本');
const pbOut = screener.promptBlock(outPick);
assert.ok(pbOut.includes('技术初筛') && pbOut.includes('研判'), 'promptBlock 池外降级文本');

// ── mtime 缓存：连续两次结果一致、不崩 ──
const a = screener.brief(poolPick);
const b = screener.brief(poolPick);
assert.strictEqual(a.chase_score, b.chase_score, '缓存命中结果一致');

// ── Hub UI 当日技术初筛快照：双模式榜单 + 统计元信息 ──
const snap = screener.latestSnapshot({ limit: 5 });
assert.ok(snap.end_date && String(snap.end_date).length === 8, 'latestSnapshot 返回快照日期');
assert.ok(snap.total === snap.chase_count + snap.setup_count, 'latestSnapshot 候选总数=追涨+蓄势');
assert.ok(Array.isArray(snap.top_chase) && snap.top_chase.length > 0, 'latestSnapshot 返回追涨 Top');
assert.ok(Array.isArray(snap.top_setup), 'latestSnapshot 返回蓄势 Top 数组');
assert.ok(snap.top_chase[0].code && typeof snap.top_chase[0].score === 'number', 'latestSnapshot Top 行含 code/score');

// ── MCP 注册契约：research-mcp-server 两处接线 + require ──
const mcpSrc = fs.readFileSync(path.join(root, 'core', 'research-mcp-server.js'), 'utf8');
assert.ok(mcpSrc.includes("require('./screener-score')"), 'research-mcp-server 应 require screener-score');
assert.ok(mcpSrc.includes("name: 'screener_score'"), 'TOOLS 应含 screener_score 定义');
assert.ok(mcpSrc.includes("if (name === 'screener_score')"), 'CallTool 应分发 screener_score');

console.log(`screener-score ok | 池内样本 ${poolPick}(${bh.name}):`, bh.mode,
  'score=' + bh.screener_score, '| end_date=' + bh.end_date,
  `| 池外样本 ${outPick} 降级=` + (mt.available === false));
