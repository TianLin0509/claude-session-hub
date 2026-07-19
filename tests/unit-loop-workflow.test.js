'use strict';
/*
 * 循环工作流纯逻辑单测（Phase 1，2026-06-29 道雪）
 * 跑法：node tests/unit-loop-workflow.test.js
 * 覆盖：parseVerdict / mergeVerdicts(AND-pass,OR-fail,空verified保守fail) / advanceLoopState(达标→打磨→done,三道强制退出) / builderTaskText
 */
const assert = require('assert');
const LW = require('../renderer/loop-workflow.js');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); } }
function section(s) { console.log('\n' + s); }

const V = (o) => '<<<VERDICT>>>\n' + JSON.stringify(o) + '\n<<<END>>>';

// ───────────────── parseVerdict ─────────────────
section('parseVerdict');
t('正常 pass + verified', () => {
  const v = LW.parseVerdict('随便前言…' + V({ decision: 'pass', blockers: [], suggestions: [], verified: ['跑了 npm test 42/42'] }) + '后记');
  assert(v && v.decision === 'pass');
  assert(v.verified.length === 1);
});
t('正常 fail + blockers', () => {
  const v = LW.parseVerdict(V({ decision: 'fail', blockers: [{ what: '登录500', evidence: 'pytest 失败' }], verified: ['x'] }));
  assert(v.decision === 'fail' && v.blockers.length === 1);
});
t('无标记 → null', () => { assert(LW.parseVerdict('我觉得通过了，没问题') === null); });
t('坏 JSON → null', () => { assert(LW.parseVerdict('<<<VERDICT>>>{not json,}<<<END>>>') === null); });
t('decision 非显式 pass → 归一为 fail', () => {
  const v = LW.parseVerdict(V({ decision: 'PASS', verified: ['x'] })); // 大写不算 pass
  assert(v.decision === 'fail');
});
t('```json 围栏容错', () => {
  const raw = '<<<VERDICT>>>\n```json\n' + JSON.stringify({ decision: 'pass', verified: ['x'] }) + '\n```\n<<<END>>>';
  const v = LW.parseVerdict(raw);
  assert(v && v.decision === 'pass');
});

// ───────────────── mergeVerdicts ─────────────────
section('mergeVerdicts');
const okV = (from) => ({ from, verdict: { decision: 'pass', blockers: [], suggestions: [], verified: ['亲测通过'] }, raw: '' });
t('两个都 pass + verified 非空 → pass', () => {
  const r = LW.mergeVerdicts([okV('Claude'), okV('DeepSeek')]);
  assert(r.pass === true && r.blockers.length === 0);
});
t('一个 fail → OR-fail，blockers 带 from', () => {
  const r = LW.mergeVerdicts([okV('Claude'), { from: 'DeepSeek', verdict: { decision: 'fail', blockers: [{ what: '崩溃' }], verified: ['x'] }, raw: '' }]);
  assert(r.pass === false);
  assert(r.blockers.some(b => b.from === 'DeepSeek' && b.what === '崩溃'));
});
t('一个解析失败(null) → 保守 fail + 占位 blocker', () => {
  const r = LW.mergeVerdicts([okV('Claude'), { from: 'DeepSeek', verdict: null, raw: '乱码' }]);
  assert(r.pass === false);
  assert(r.blockers.some(b => /未给出可解析裁决/.test(b.what)));
});
t('verified 为空 → 红线②保守 fail', () => {
  const r = LW.mergeVerdicts([{ from: 'Claude', verdict: { decision: 'pass', blockers: [], verified: [] }, raw: '' }]);
  assert(r.pass === false);
  assert(r.blockers.some(b => /验证证据/.test(b.what)));
});
t('suggestions 合并进池', () => {
  const r = LW.mergeVerdicts([
    { from: 'Claude', verdict: { decision: 'pass', blockers: [], verified: ['x'], suggestions: [{ idea: '加缓存' }] }, raw: '' },
    { from: 'DeepSeek', verdict: { decision: 'pass', blockers: [], verified: ['y'], suggestions: [{ idea: '加索引' }] }, raw: '' },
  ]);
  assert(r.pass === true && r.suggestions.length === 2);
});

// ───────────────── advanceLoopState ─────────────────
section('advanceLoopState');
const cfg = (over) => Object.assign(LW.defaultConfig(), over || {});
const PASS = { pass: true, blockers: [], suggestions: [], fullVerdicts: [] };
const FAIL = { pass: false, blockers: [{ what: '同一个bug', from: 'C' }], suggestions: [], fullVerdicts: [] };

t('reaching+pass(无 polish) → done', () => {
  const s = LW.newLoopState();
  LW.advanceLoopState(s, PASS, cfg({ polish: { enabled: false }, gate: { consecutivePass: 1 } }), 0);
  assert(s.status === 'done', 'status=' + s.status);
});
t('reaching+pass(有 polish+池非空) → polishing', () => {
  const s = LW.newLoopState();
  LW.advanceLoopState(s, { pass: true, blockers: [], suggestions: [{ idea: 'x' }], fullVerdicts: [] }, cfg({ gate: { consecutivePass: 1 } }), 0);
  assert(s.phase === 'polishing' && s.status === 'running', 'phase=' + s.phase + ' status=' + s.status);
});
t('reaching+fail → 继续 running, green 归零', () => {
  const s = LW.newLoopState();
  LW.advanceLoopState(s, FAIL, cfg(), 0);
  assert(s.status === 'running' && s.consecutiveGreen === 0 && s.phase === 'reaching');
});
t('consecutivePass=2：一次 pass 不达标，两次才达标', () => {
  const c = cfg({ gate: { consecutivePass: 2 }, polish: { enabled: false } });
  const s = LW.newLoopState();
  LW.advanceLoopState(s, PASS, c, 0);
  assert(s.status === 'running' && s.consecutiveGreen === 1, '第一次应未达标');
  LW.advanceLoopState(s, PASS, c, 0);
  assert(s.status === 'done', '第二次应达标 done，实际 ' + s.status);
});
t('polishing+pass → 取走该建议，池空则 done', () => {
  const s = LW.newLoopState();
  s.phase = 'polishing'; s.suggestionPool = [{ idea: '唯一优化' }];
  LW.advanceLoopState(s, PASS, cfg(), 0);
  assert(s.status === 'done' && s.suggestionPool.length === 0);
});
t('polishing+pass 池还有 → 继续 running', () => {
  const s = LW.newLoopState();
  s.phase = 'polishing'; s.suggestionPool = [{ idea: 'a' }, { idea: 'b' }];
  LW.advanceLoopState(s, PASS, cfg(), 0);
  assert(s.status === 'running' && s.suggestionPool.length === 1);
});
t('强制退出①：maxRounds', () => {
  const c = cfg({ stop: { maxRounds: 2, deadlineTs: null, noProgressRounds: 99 } });
  const s = LW.newLoopState();
  LW.advanceLoopState(s, FAIL, c, 0); // round1
  assert(s.status === 'running');
  LW.advanceLoopState(s, FAIL, c, 0); // round2 → max
  assert(s.status === 'stopped_max', 'status=' + s.status);
});
t('强制退出②：deadline', () => {
  const c = cfg({ stop: { maxRounds: 99, deadlineTs: 1000, noProgressRounds: 99 } });
  const s = LW.newLoopState();
  LW.advanceLoopState(s, FAIL, c, 2000); // now > deadline
  assert(s.status === 'stopped_deadline', 'status=' + s.status);
});
t('强制退出③：noProgress（相同阻断项连续重复）', () => {
  const c = cfg({ stop: { maxRounds: 99, deadlineTs: null, noProgressRounds: 2 } });
  const s = LW.newLoopState();
  LW.advanceLoopState(s, FAIL, c, 0); // round1 sig=X, noProgress=0
  LW.advanceLoopState(s, FAIL, c, 0); // round2 same, noProgress=1
  assert(s.status === 'running', '两轮还不该停');
  LW.advanceLoopState(s, FAIL, c, 0); // round3 same, noProgress=2 → stuck
  assert(s.status === 'stopped_stuck', 'status=' + s.status);
});
t('不同阻断项 → 不算无进展', () => {
  const c = cfg({ stop: { maxRounds: 99, deadlineTs: null, noProgressRounds: 2 } });
  const s = LW.newLoopState();
  LW.advanceLoopState(s, { pass: false, blockers: [{ what: 'bug A' }], suggestions: [], fullVerdicts: [] }, c, 0);
  LW.advanceLoopState(s, { pass: false, blockers: [{ what: 'bug B' }], suggestions: [], fullVerdicts: [] }, c, 0);
  LW.advanceLoopState(s, { pass: false, blockers: [{ what: 'bug C' }], suggestions: [], fullVerdicts: [] }, c, 0);
  assert(s.status === 'running', '阻断项每轮不同应视为有进展，status=' + s.status);
});

// ───────────────── builderTaskText ─────────────────
section('builderTaskText');
t('round 0 → firstRound', () => {
  const s = LW.newLoopState();
  const r = LW.builderTaskText(s, null, cfg());
  assert(r.firstRound === true);
});
t('polishing → 取 pool[0]', () => {
  const s = LW.newLoopState(); s.round = 3; s.phase = 'polishing'; s.suggestionPool = [{ idea: '加缓存', why: '更快' }];
  const r = LW.builderTaskText(s, null, cfg());
  assert(r.phase === 'polishing' && /加缓存/.test(r.taskText));
});
t('reaching 回灌 → 列出 blockers', () => {
  const s = LW.newLoopState(); s.round = 2;
  const r = LW.builderTaskText(s, { blockers: [{ what: '登录500', from: 'Claude', evidence: 'x' }] }, cfg());
  assert(/登录500/.test(r.taskText) && /Claude/.test(r.taskText));
});

// ───────────────── buildReportHtml ─────────────────
section('buildReportHtml');
t('生成自包含 HTML，含目标/状态/轮次/建议', () => {
  const s = LW.newLoopState();
  s.round = 2; s.status = 'done'; s.phase = 'polishing'; s.consecutiveGreen = 1;
  s.history = [
    { round: 1, phase: 'reaching', pass: false, blockers: [{ what: '登录500' }] },
    { round: 2, phase: 'reaching', pass: true, blockers: [] },
  ];
  s.suggestionPool = [{ idea: '加缓存', why: '更快', from: 'DeepSeek' }];
  const html = LW.buildReportHtml('实现登录功能', s, cfg(), { builderLabel: 'Codex', reviewerLabels: 'Claude+DeepSeek', finishedAt: '2026-06-29 03:00' });
  assert(html.indexOf('<!DOCTYPE') === 0, '应是完整 HTML');
  assert(/实现登录功能/.test(html), '含目标');
  assert(/达成|打磨完成/.test(html), '含状态中文');
  assert(/登录500/.test(html), '含阻断项');
  assert(/加缓存/.test(html), '含建议池');
  assert(/Codex/.test(html) && /Claude\+DeepSeek/.test(html), '含角色');
});
t('HTML 转义防注入', () => {
  const s = LW.newLoopState(); s.round = 1; s.status = 'done';
  const html = LW.buildReportHtml('<script>x</script>', s, cfg(), {});
  assert(html.indexOf('<script>x</script>') === -1, '目标里的尖括号应被转义');
  assert(/&lt;script&gt;/.test(html), '应转义为实体');
});

// ───────────────── resumeState（Phase 2b 断点续跑）─────────────────
section('resumeState');
t('从持久化重建 round/phase/goal/池', () => {
  const r = LW.resumeState({ status: 'running', phase: 'polishing', round: 3, consecutiveGreen: 1, suggestionPool: [{ idea: 'x' }], history: [{ round: 1, pass: true }], goal: '实现登录' });
  assert(r.state.round === 3 && r.state.phase === 'polishing' && r.state.goal === '实现登录');
  assert(r.state.suggestionPool.length === 1);
});
t('上一轮未过 → prevMerge 回灌其阻断项', () => {
  const r = LW.resumeState({ status: 'running', round: 2, history: [{ round: 2, pass: false, blockers: [{ what: '登录500' }] }], goal: 'g' });
  assert(r.prevMerge && r.prevMerge.pass === false && r.prevMerge.blockers[0].what === '登录500');
});
t('上一轮通过 → prevMerge 为 null', () => {
  const r = LW.resumeState({ status: 'running', round: 1, history: [{ round: 1, pass: true, blockers: [] }], goal: 'g' });
  assert(r.prevMerge === null);
});
t('空/无效 → 退化为新状态', () => {
  const r = LW.resumeState(null);
  assert(r.state.round === 0 && r.state.status === 'running' && r.prevMerge === null);
});
t('续跑后能被 advanceLoopState 继续推进', () => {
  const r = LW.resumeState({ status: 'running', round: 1, consecutiveGreen: 0, history: [{ round: 1, pass: false, blockers: [{ what: 'b' }] }], goal: 'g' });
  LW.advanceLoopState(r.state, { pass: true, blockers: [], suggestions: [], fullVerdicts: [] }, cfg({ polish: { enabled: false } }), 0);
  assert(r.state.round === 2 && r.state.status === 'done', '续跑第2轮 pass→done，实际 round=' + r.state.round + ' status=' + r.state.status);
});

// ───────────────── 汇总 ─────────────────
console.log('\n──────────────');
console.log(`通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
