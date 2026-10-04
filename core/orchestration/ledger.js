'use strict';
// AI 编排模式的计划账本（纯函数，便于单测）。
// 账本是界面展示、中断恢复和编排员换班的唯一依据：编排员只能改计划部分，
// 工作段的通过与否只由交付工作流的结果（审核位判定）推进。
const crypto = require('node:crypto');

const DEFAULT_SETTINGS = Object.freeze({ requireConfirm: true, roundCap: 8, timeCapMin: 180, maxMembers: 3, stuckMin: 40 });
const PRESETS = ['development', 'research', 'roundtable', 'custom'];
const PRESET_LABELS = { development: '开发交付', research: '资料调研', roundtable: '方案圆桌', custom: '自定义' };
const SEGMENT_LABELS = {
  starting: '启动中', running: '进行中', rework: '返工中', paused: '已暂停', passed: '通过',
  completed: '已完成', cancelled: '已取消', failed: '启动失败', skipped: '已跳过',
};
const HALT_LABELS = {
  budget_rounds: '迭代额度用满', budget_time: '时长额度用满', no_progress: '连续两次没有新进展',
  need_decision: '编排员请你决定', user_pause: '你已暂停', runtime_error: '运行故障，等待你处理',
};
const MAX_EVENTS = 80, MAX_SEEN = 400;

const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
function normalizeSettings(input = {}) {
  const s = input && typeof input === 'object' ? input : {};
  return {
    requireConfirm: s.requireConfirm !== false,
    roundCap: clampInt(s.roundCap, 1, 30, DEFAULT_SETTINGS.roundCap),
    timeCapMin: clampInt(s.timeCapMin, 15, 24 * 60, DEFAULT_SETTINGS.timeCapMin),
    maxMembers: clampInt(s.maxMembers, 1, 3, DEFAULT_SETTINGS.maxMembers),
    stuckMin: clampInt(s.stuckMin, 5, 240, DEFAULT_SETTINGS.stuckMin),
  };
}

function create(meetingId, settings, now = Date.now()) {
  const s = normalizeSettings(settings);
  return {
    version: 1, meetingId, status: s.requireConfirm ? 'planning' : 'running', halt: null, settings: s,
    budget: { roundsUsed: 0, roundCap: s.roundCap, activeMs: 0, timeCapMs: s.timeCapMin * 60000, grants: 0, lastTickAt: now },
    plan: null, roles: {}, segments: [], asks: [], reports: [],
    notices: [], seen: [], progressSeq: 0, lastWakeSeq: 0, wakesWithoutProgress: 0,
    events: [], createdAt: now, updatedAt: now,
  };
}

function event(ledger, text, now = Date.now()) {
  ledger.events.push({ at: now, text: String(text).slice(0, 400) });
  if (ledger.events.length > MAX_EVENTS) ledger.events.splice(0, ledger.events.length - MAX_EVENTS);
}
function bump(ledger) { ledger.progressSeq += 1; ledger.wakesWithoutProgress = 0; }

// ---- 计划 ----
const text = (value, max) => String(value == null ? '' : value).trim().slice(0, max);
function proposePlan(ledger, input = {}, now = Date.now()) {
  if (ledger.status === 'ended') throw new Error('编排已结束，田哥恢复编排后才能提交计划');
  if (ledger.status === 'finished') ledger.status = 'running';
  const summary = text(input.summary, 4000);
  if (!summary) throw new Error('计划需要 summary：一段白话说明目标、队伍和步骤');
  const team = (Array.isArray(input.team) ? input.team : []).map(t => ({
    memberId: text(t && t.memberId, 40),
    role: text(t && t.role, 40), kind: text(t && t.kind, 20), model: text(t && t.model, 80),
    effort: text(t && t.effort, 20), tier: text(t && t.tier, 20), reason: text(t && t.reason, 300),
  })).filter(t => t.role);
  if (team.length > ledger.settings.maxMembers) throw new Error(`队伍最多 ${ledger.settings.maxMembers} 位成员（不含编排员）`);
  const segments = (Array.isArray(input.segments) ? input.segments : []).map(seg => ({
    name: text(seg && seg.name, 80), preset: PRESETS.includes(seg && seg.preset) ? seg.preset : 'custom',
    goal: text(seg && seg.goal, 2000), acceptance: text(seg && seg.acceptance, 2000),
  })).filter(seg => seg.name);
  if (!segments.length) throw new Error('计划至少要有一段工作（segments），每段写清 name、preset、goal、acceptance');
  if (segments.length > 8) throw new Error('计划最多 8 段工作');
  const missing = segments.filter(seg => !seg.acceptance).map(seg => seg.name);
  if (missing.length) throw new Error('每段工作都要写验收标准（acceptance）：' + missing.join('、'));
  if(new Set(segments.map(s=>s.name)).size!==segments.length)throw Error('计划工作段名称必须唯一');
  for(const seg of segments)seg.id=crypto.createHash('sha256').update(JSON.stringify([seg.name,seg.preset,seg.goal,seg.acceptance])).digest('hex').slice(0,16);
  const version = (ledger.plan?.version || 0) + 1;
  ledger.plan = { version, summary, team, segments, budget: input.budget || null, estimateRounds: clampInt(input.estimateRounds, 0, 99, 0),
    proposedAt: now, confirmedAt: ledger.plan?.confirmedAt || null, confirmedVersion: ledger.plan?.confirmedVersion || 0 };
  if (ledger.settings.requireConfirm) {
    if (ledger.status !== 'halted') ledger.status = 'awaiting_confirm';
  } else if (ledger.status === 'planning') ledger.status = 'running';
  event(ledger, `编排员提交计划 v${version}`, now);
  bump(ledger);
  return ledger.plan;
}
function confirmPlan(ledger, now = Date.now()) {
  if (!ledger.plan) throw new Error('还没有计划可以确认');
  if (ledger.plan.confirmedVersion === ledger.plan.version && ledger.status !== 'awaiting_confirm') return false;
  ledger.plan.confirmedVersion = ledger.plan.version;
  ledger.plan.confirmedAt = now;
  if(ledger.plan.budget){ledger.budget.roundCap=ledger.plan.budget.roundCap;ledger.budget.timeCapMs=ledger.plan.budget.timeCapMin*60000;}
  for(const member of ledger.plan.team)if(member.memberId)ledger.roles[member.memberId]={role:member.role,kind:member.kind};
  if (ledger.status === 'awaiting_confirm' || ledger.status === 'planning') ledger.status = 'running';
  ledger.budget.lastTickAt = now;
  event(ledger, `田哥确认计划 v${ledger.plan.version}`, now);
  bump(ledger);
  return true;
}

// 能否派活：计划确认（若要求）、未暂停、未结束。查询类工具不受影响。
function canDispatch(ledger) {
  if (ledger.status === 'ended') return { ok: false, reason: '编排已结束；田哥恢复编排前不能派活' };
  if (ledger.status === 'finished') return { ok: false, reason: '任务已结项；田哥提出新要求后再提交新计划' };
  if (ledger.status === 'halted') return { ok: false, reason: `已暂停（${HALT_LABELS[ledger.halt?.reason] || '等待田哥'}）：先用 orch_report 汇报，等田哥决定` };
  if (ledger.settings.requireConfirm && (!ledger.plan || ledger.plan.confirmedVersion !== ledger.plan.version)) {
    return { ok: false, reason: '计划还没被田哥确认：先用 orch_propose_plan 提交计划，等田哥确认后再组队派活' };
  }
  if (ledger.status === 'awaiting_confirm') return { ok: false, reason: `计划 v${ledger.plan.version} 等待田哥确认，确认前不能派活` };
  return { ok: true };
}

// ---- 工作段 ----
function newId(prefix) { return prefix + '-' + crypto.randomBytes(5).toString('hex'); }
function startSegment(ledger, seg, now = Date.now()) {
  const record = {
    id: newId('seg'), runId: null, name: text(seg.name, 80) || PRESET_LABELS[seg.preset] || '工作段',
    preset: seg.preset, goal: text(seg.goal, 4000), acceptance: text(seg.acceptance, 2000),
    members: seg.members || [], status: 'starting', rounds: 0, steps: 0, verdict: null, verdictPath: '',
    planSegmentId: seg.planSegmentId || '',
    error: '', missing: [], stuckNotified: '', startedAt: now, endedAt: null,
  };
  ledger.segments.push(record);
  event(ledger, `启动工作段「${record.name}」（${PRESET_LABELS[record.preset] || record.preset}）`, now);
  bump(ledger);
  return record;
}
function activeSegment(ledger) {
  return [...ledger.segments].reverse().find(s => ['starting', 'running', 'rework', 'paused'].includes(s.status)) || null;
}

// 计次规则：开发交付按「审查」计（一轮实现→审核 = 1）；串行模板每完成一步计 1。
function countRounds(run) {
  if (!run || !Array.isArray(run.steps)) return 0;
  const review = run.kind === 'file';
  return run.steps.filter(step => {
    const stage = run.stages?.[step.index];
    if (review && stage?.after !== 'review') return false;
    const members = Array.isArray(step.members) ? step.members : [];
    return members.length > 0 && members.every(m => step.deliveries && step.deliveries[m]);
  }).length;
}
function reviewVerdict(run) {
  if (!run || !Array.isArray(run.steps)) return null;
  for (let i = run.steps.length - 1; i >= 0; i -= 1) {
    const step = run.steps[i];
    const stage = run.stages?.[step.index];
    const lead = step.members?.[0];
    const delivery = lead && step.deliveries?.[lead];
    if (!delivery) continue;
    if (run.kind === 'file' ? stage?.after === 'review' : (stage?.after === 'end' || i === run.steps.length - 1)) {
      return { outcome: delivery.outcome, path: delivery.path || '', memberId: lead, stage: stage?.name || '' };
    }
  }
  return null;
}

// 用交付工作流的 run.json 推进账本里对应的段；返回需要告诉编排员的通知。
function applyRun(ledger, run, now = Date.now()) {
  const notices = [];
  if (!run || !run.id) return notices;
  const seg = ledger.segments.find(s => s.runId === run.id);
  if (!seg) return notices;
  const before = JSON.stringify([seg.status, seg.rounds, seg.steps, seg.error, seg.verdict?.outcome, seg.verdictPath]);
  const prevRounds = seg.rounds || 0;
  seg.steps = Array.isArray(run.steps) ? run.steps.length : 0;
  seg.rounds = countRounds(run);
  const verdict = reviewVerdict(run);
  const last = run.steps?.at(-1);
  seg.missing = last ? (last.members || []).filter(m => !last.deliveries?.[m]) : [];
  if (verdict) { seg.verdict = verdict; seg.verdictPath = verdict.path; }
  let status = seg.status;
  if (run.status === 'done') status = run.kind === 'file' ? 'passed' : 'completed';
  else if (run.status === 'cancelled') status = 'cancelled';
  else if (run.status === 'paused') status = 'paused';
  else if (run.status === 'running') status = verdict?.outcome === 'rework' && run.kind === 'file' && seg.rounds > 0 ? 'rework' : 'running';
  seg.error = run.status === 'paused' ? text(run.error, 600) : '';
  const prevStatus = seg.status;
  if (status === 'paused' && prevStatus !== 'paused') seg.pauses = (seg.pauses || 0) + 1;
  seg.status = status;
  if (['passed', 'completed', 'cancelled'].includes(status) && !seg.endedAt) seg.endedAt = now;
  ledger.budget.roundsUsed = ledger.segments.reduce((sum, s) => sum + (s.rounds || 0), 0);
  const after = JSON.stringify([seg.status, seg.rounds, seg.steps, seg.error, seg.verdict?.outcome, seg.verdictPath]);
  if (before === after) return notices;
  bump(ledger);
  const key = `${seg.id}:${seg.rounds}:${status}:${seg.verdict?.outcome || ''}:${status === 'paused' ? 'p' + (seg.pauses || 0) : ''}`;
  if (status !== prevStatus || (status === 'rework' && seg.rounds !== prevRounds)) {
    if (status === 'passed') notices.push({ key, text: `工作段「${seg.name}」审核通过。审核结论：${seg.verdictPath}` });
    else if (status === 'completed') notices.push({ key, text: `工作段「${seg.name}」已完成。最后交付：${seg.verdictPath}` });
    else if (status === 'rework') notices.push({ key, text: `工作段「${seg.name}」审核判定需返工（已用 ${seg.rounds} 轮），工作流已自动开始下一轮实现。审核结论：${seg.verdictPath}` });
    else if (status === 'paused') notices.push({ key, text: `工作段「${seg.name}」已暂停：${seg.error || '原因未知'}。可用 orch_control_workflow 选择 continue（续跑）、remind（提醒未交付成员）或 cancel。` });
    else if (status === 'cancelled') notices.push({ key, text: `工作段「${seg.name}」已取消。` });
  }
  if (notices.length) event(ledger, notices.map(n => n.text).join('；'), now);
  return notices;
}

// ---- 预算 ----
function tick(ledger, now = Date.now(), { working = false } = {}) {
  const delta = Math.max(0, Math.min(now - (ledger.budget.lastTickAt || now), 60000));
  ledger.budget.lastTickAt = now;
  if (ledger.status === 'running' && working) ledger.budget.activeMs += delta;
}
function overBudget(ledger) {
  if (ledger.status !== 'running') return null;
  if (ledger.budget.roundsUsed >= ledger.budget.roundCap) return 'budget_rounds';
  if (ledger.budget.activeMs >= ledger.budget.timeCapMs) return 'budget_time';
  return null;
}
function halt(ledger, reason, message = '', now = Date.now()) {
  ledger.status = 'halted';
  ledger.halt = { reason, at: now, message: text(message, 1000), reported: false };
  event(ledger, `暂停：${HALT_LABELS[reason] || reason}${message ? '（' + text(message, 200) + '）' : ''}`, now);
}
function grant(ledger, { rounds = 0, minutes = 0 } = {}, now = Date.now()) {
  const r = clampInt(rounds, 0, 30, 0), m = clampInt(minutes, 0, 24 * 60, 0);
  if (r) ledger.budget.roundCap = Math.max(ledger.budget.roundCap, ledger.budget.roundsUsed) + r;
  if (m) ledger.budget.timeCapMs = Math.max(ledger.budget.timeCapMs, ledger.budget.activeMs) + m * 60000;
  ledger.budget.grants += 1;
  const wasHalted = ledger.status === 'halted';
  if (wasHalted) { ledger.status = 'running'; ledger.halt = null; }
  ledger.wakesWithoutProgress = 0;
  ledger.budget.lastTickAt = now;
  event(ledger, `田哥追加额度：${r ? r + ' 轮' : ''}${r && m ? '、' : ''}${m ? m + ' 分钟' : ''}${!r && !m ? '恢复编排' : ''}`, now);
  bump(ledger);
  return wasHalted;
}
function resume(ledger, now = Date.now()) { return grant(ledger, {}, now); }

// ---- 通知队列（不丢不重：queued → sending → sent；重启时 sending 标为可能已送达）----
function enqueue(ledger, key, body, now = Date.now()) {
  const k = String(key || '');
  if (k && ledger.seen.includes(k)) return false;
  if (k) { ledger.seen.push(k); if (ledger.seen.length > MAX_SEEN) ledger.seen.splice(0, ledger.seen.length - MAX_SEEN); }
  ledger.notices.push({ id: newId('n'), key: k, text: text(body, 2000), at: now, state: 'queued', attempts: 0 });
  return true;
}
function pendingNotices(ledger) { return ledger.notices.filter(n => n.state === 'queued' || n.state === 'uncertain'); }
function markSending(ledger, ids, now = Date.now()) {
  for (const n of ledger.notices) if (ids.includes(n.id)) { n.state = 'sending'; n.attempts += 1; n.sentAt = now; }
}
function markSent(ledger, ids) {
  ledger.notices = ledger.notices.filter(n => !ids.includes(n.id));
}
function markRetry(ledger, ids, now = Date.now()) {
  for (const n of ledger.notices) if (ids.includes(n.id)) n.state = n.attempts >= 3 ? 'failed' : 'queued';
  const failed = ledger.notices.filter(n => n.state === 'failed');
  if (failed.length) {
    event(ledger, `有 ${failed.length} 条通知连续 3 次没送达编排员，已放弃：` + failed.map(n => n.text.slice(0, 60)).join('；'), now);
    ledger.notices = ledger.notices.filter(n => n.state !== 'failed');
  }
}
// Hub 重启后，发送中但没有回执的通知可能已送达：不静默重发，标注后随下一批说明。
function recoverAfterRestart(ledger) {
  let count = 0;
  for (const n of ledger.notices) if (n.state === 'sending') { n.state = 'uncertain'; count += 1; }
  return count;
}

// 自动唤醒（不含田哥亲自发言）前调用：两次唤醒之间账本没前进 → 计一次「没进展」。
function noteWake(ledger) {
  if (ledger.progressSeq === ledger.lastWakeSeq) ledger.wakesWithoutProgress += 1;
  else ledger.wakesWithoutProgress = 0;
  ledger.lastWakeSeq = ledger.progressSeq;
  return ledger.wakesWithoutProgress;
}
function noteUserMessage(ledger) { ledger.wakesWithoutProgress = 0; ledger.lastWakeSeq = ledger.progressSeq; }

// ---- 汇报与结项 ----
function finalGate(ledger) {
  if(!ledger.plan?.segments?.length)return {ok:false,reason:'缺少完整计划，不能结项'};
  const missing=ledger.plan.segments.filter(p=>!ledger.segments.some(s=>(s.planSegmentId===p.id || (!s.planSegmentId && s.name===p.name && s.preset===p.preset && s.goal===p.goal && s.acceptance===p.acceptance)) && ['passed','completed'].includes(s.status) && s.verdictPath));
  if(missing.length)return {ok:false,reason:'计划工作段未完成或缺审核证据：'+missing.map(s=>s.name).join('、')};
  if (!ledger.segments.length) return { ok: false, reason: '还没有任何工作段，不能结项' };
  const open = ledger.segments.filter(s => !['passed', 'completed', 'cancelled', 'skipped', 'failed'].includes(s.status));
  if (open.length) return { ok: false, reason: '还有工作段没结束：' + open.map(s => `「${s.name}」${SEGMENT_LABELS[s.status] || s.status}`).join('、') };
  const done = ledger.segments.filter(s => ['passed', 'completed'].includes(s.status));
  if (!done.length) return { ok: false, reason: '没有任何工作段通过审核，不能报完成；请用 need_decision 向田哥说明' };
  const noEvidence = done.filter(s => !s.verdictPath);
  if (noEvidence.length) return { ok: false, reason: '以下工作段缺审核结论文件：' + noEvidence.map(s => s.name).join('、') };
  return { ok: true };
}
function addReport(ledger, kind, summary, now = Date.now()) {
  const report = { at: now, kind, summary: text(summary, 6000) };
  ledger.reports.push(report);
  if (ledger.reports.length > 30) ledger.reports.splice(0, ledger.reports.length - 30);
  if (ledger.status === 'halted' && ledger.halt) ledger.halt.reported = true;
  event(ledger, `编排员汇报（${kind}）`, now);
  return report;
}

// ---- 展示 ----
function fmtMin(ms) { return Math.round((ms || 0) / 60000); }
function progressRows(ledger) {
  return ledger.segments.map(s => ({
    id: s.id, name: s.name, preset: s.preset, presetLabel: PRESET_LABELS[s.preset] || s.preset,
    status: s.status, statusLabel: SEGMENT_LABELS[s.status] || s.status, rounds: s.rounds,
    members: s.members, verdict: s.verdict?.outcome || '', verdictPath: s.verdictPath || '', error: s.error || '',
    missing: s.missing || [],
  }));
}
function view(ledger) {
  if (!ledger) return null;
  const pendingAsks = ledger.asks.filter(a => a.status === 'pending');
  return {
    meetingId: ledger.meetingId, status: ledger.status,
    halt: ledger.halt ? { ...ledger.halt, label: HALT_LABELS[ledger.halt.reason] || ledger.halt.reason } : null,
    settings: ledger.settings,
    budget: { roundsUsed: ledger.budget.roundsUsed, roundCap: ledger.budget.roundCap,
      minutesUsed: fmtMin(ledger.budget.activeMs), minutesCap: fmtMin(ledger.budget.timeCapMs) },
    plan: ledger.plan ? { version: ledger.plan.version, confirmedVersion: ledger.plan.confirmedVersion, summary: ledger.plan.summary,
      segments: ledger.plan.segments, team: ledger.plan.team } : null,
    roles: ledger.roles, segments: progressRows(ledger),
    asks: ledger.asks.slice(-10).map(a => ({ id: a.id, memberId: a.memberId, status: a.status, answerPath: a.answerPath || '' })),
    pendingAsks: pendingAsks.length,
    lastReport: ledger.reports.at(-1) || null,
    events: ledger.events.slice(-12),
    updatedAt: ledger.updatedAt,
  };
}
function cell(value) { return String(value == null ? '' : value).replace(/\|/g, '/').replace(/\r?\n/g, ' '); }
function markdownTable(ledger) {
  const rows = progressRows(ledger);
  if (!rows.length) return '（还没有工作段）';
  return ['| 段 | 模板 | 负责人 | 状态 | 已用轮次 | 审核结论 | 备注 |', '|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${cell(r.name)} | ${cell(r.presetLabel)} | ${cell((r.members || []).join(' / '))} | ${cell(r.statusLabel)} | ${r.rounds} | ${cell(r.verdictPath || '—')} | ${cell(r.error || (r.missing.length ? '待交付：' + r.missing.join('、') : ''))} |`)].join('\n');
}
function renderMarkdown(ledger) {
  const v = view(ledger);
  const lines = [`# 计划账本`, '', `- 状态：${v.status}${v.halt ? '（' + v.halt.label + '）' : ''}`,
    `- 额度：${v.budget.roundsUsed}/${v.budget.roundCap} 轮 · ${v.budget.minutesUsed}/${v.budget.minutesCap} 分钟`, ''];
  if (ledger.plan) lines.push(`## 计划 v${ledger.plan.version}${ledger.plan.confirmedVersion === ledger.plan.version ? '（已确认）' : '（待确认）'}`, '', ledger.plan.summary, '');
  lines.push('## 工作段', '', markdownTable(ledger), '');
  if (Object.keys(ledger.roles).length) lines.push('## 队伍', '', ...Object.entries(ledger.roles).map(([id, r]) => `- ${id}：${r.role}（${r.label || r.kind || ''}）`), '');
  if (ledger.asks.length) lines.push('## 单独提问', '', ...ledger.asks.slice(-10).map(a => `- ${a.memberId}：${a.status === 'answered' ? '已回答 ' + a.answerPath : '待回答'}`), '');
  lines.push('## 最近事件', '', ...ledger.events.slice(-15).map(e => `- ${new Date(e.at).toISOString()} ${e.text}`), '');
  return lines.join('\n');
}

module.exports = {
  DEFAULT_SETTINGS, PRESETS, PRESET_LABELS, SEGMENT_LABELS, HALT_LABELS,
  normalizeSettings, create, event, proposePlan, confirmPlan, canDispatch, startSegment, activeSegment,
  countRounds, reviewVerdict, applyRun, tick, overBudget, halt, grant, resume,
  enqueue, pendingNotices, markSending, markSent, markRetry, recoverAfterRestart, noteWake, noteUserMessage,
  finalGate, addReport, progressRows, view, markdownTable, renderMarkdown, newId,
};
