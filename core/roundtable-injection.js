'use strict';
// Roundtable Injection — 上一轮注入矩阵算法 (方案 F · 2026-05-02)
//
// 核心规则（spec §8）：
//   1. lastTurn 为 null（首轮） → 不注入
//   2. lastTurn 是摘要轮（mode === 'summary-brief'）→ 给所有当前发言者注入摘要全文
//   3. 同组跳过：当前发言者集合 === 上一轮发言者集合 → 整体跳过注入
//      - pilot → pilot（同一主驾）：主驾自己 PTY 上下文里有
//      - observer → observer（同两副驾）：保持副驾各自独立观点
//   4. 其他情况：每个当前发言者收到「上一轮发言者中除自己外」的内容
//
// 接口：
//   computeLastTurnInjection(lastTurn, currentTargetSids, sidLabelFn, sidRoleFn)
//     → Map<sid, InjectionPayload | null>
//
//   InjectionPayload = {
//     lastTurnNum: number,
//     lastTurnMode: string,         // 'fanout'|'debate'|'summary'|'summary-brief'
//     lastDispatchMode: string,     // 'all'|'pilot'|'observer'
//     isSummaryInjection: boolean,  // true 时格式化为「摘要轮注入」
//     speakers: [{ sid, label, role, text, status }]
//   }
//
//   返回 sid → null 表示该 sid 跳过注入（同组跳过 / 上一轮无对方内容）

// ---------------------------------------------------------------------------
// 主算法
// ---------------------------------------------------------------------------
function computeLastTurnInjection(lastTurn, currentTargetSids, sidLabelFn, sidRoleFn) {
  const result = {};
  const targets = Array.isArray(currentTargetSids) ? currentTargetSids.filter(Boolean) : [];
  if (targets.length === 0) return result;

  // 规则 1：首轮无注入
  if (!lastTurn || !lastTurn.by || typeof lastTurn.by !== 'object') {
    for (const sid of targets) result[sid] = null;
    return result;
  }

  const lastByMap = lastTurn.by || {};
  const lastByStatus = lastTurn.byStatus || {};
  const lastSpeakers = Object.keys(lastByMap);
  if (lastSpeakers.length === 0) {
    for (const sid of targets) result[sid] = null;
    return result;
  }

  // 规则 2：摘要轮 → 全注入摘要给所有 target（包括摘要发出方自己 — 摘要也值得他自己回看）
  const isSummary = lastTurn.mode === 'summary-brief';
  if (isSummary) {
    const speakers = lastSpeakers.map(sid => _renderSpeaker(sid, lastByMap, lastByStatus, sidLabelFn, sidRoleFn));
    const payload = {
      lastTurnNum: lastTurn.n,
      lastTurnMode: lastTurn.mode,
      lastDispatchMode: lastTurn.dispatchMode || 'all',
      isSummaryInjection: true,
      speakers,
    };
    for (const sid of targets) result[sid] = payload;
    return result;
  }

  // 规则 3：同组跳过 — 仅当上一轮是 pilot/observer 模式且发言者集合相同
  //   pilot → pilot（同主驾）：主驾自己 PTY 上下文里有
  //   observer → observer（同两副驾）：保持副驾各自独立观点（不让副驾互通）
  //   注：all → all 不跳过（all 模式下每家 AI 看不到其他人，必须注入另两家）
  const lastDM = lastTurn.dispatchMode || 'all';
  if (lastDM !== 'all' && _setsEqual(targets, lastSpeakers)) {
    for (const sid of targets) result[sid] = null;
    return result;
  }

  // 规则 4：个性化注入 — 每个 target 收到「上一轮发言者中除自己外」的内容
  for (const sid of targets) {
    const otherSpeakers = lastSpeakers.filter(s => s !== sid);
    if (otherSpeakers.length === 0) {
      result[sid] = null;
      continue;
    }
    const speakers = otherSpeakers.map(s => _renderSpeaker(s, lastByMap, lastByStatus, sidLabelFn, sidRoleFn));
    result[sid] = {
      lastTurnNum: lastTurn.n,
      lastTurnMode: lastTurn.mode,
      lastDispatchMode: lastTurn.dispatchMode || 'all',
      isSummaryInjection: false,
      speakers,
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function _setsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  for (const x of a) if (!setB.has(x)) return false;
  return true;
}

function _renderSpeaker(sid, byMap, byStatus, sidLabelFn, sidRoleFn) {
  const label = (typeof sidLabelFn === 'function' ? sidLabelFn(sid) : null) || sid;
  const role = (typeof sidRoleFn === 'function' ? sidRoleFn(sid) : null) || null;
  const status = byStatus && byStatus[sid] ? byStatus[sid] : 'completed';
  const text = byMap[sid] || '';
  return { sid, label, role, text, status };
}

module.exports = {
  computeLastTurnInjection,
  // 暴露内部 helper 供 unit test
  _setsEqual,
};
