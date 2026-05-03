'use strict';
// Roundtable Free Mode — 自由模式 dispatch + prompt 模板（2026-05-04）
//
// 与主驾模式（pilot mode）共存，独立模块。
// pilot 路径完全不动；本模块仅在 meeting.mode === 'free' 时被 main.js 调用。
//
// 核心接口：
//   deriveTargetSids(meeting, mode, summarizerSlot) → string[]
//     按 mode 决定本轮目标：
//       summary → [summarizerSub.sid]（不受 participants 影响）
//       fanout/debate → participants 对应的 sub.sid，按 slot 顺序
//
//   derivePilotCompatDispatchMode(participants, mode) → 'all'|'pilot'|'observer'
//     兼容字段：写到 turn record 的 dispatchMode，让现有 roundtable-injection.js
//     同组跳过算法零修改。语义：参与者集合的等价类标签。
//     特殊：debate 模式永远返回 'all'（debate 必须互看，不能走 observer 同组跳过）。
//
//   buildFreeFanoutPrompt / buildFreeDebatePrompt / buildFreeSummaryPrompt
//     第一行格式：# 自由模式 第 N 轮 <mode> — 你是 <slotLabel>
//     满足 Resend T2 第一行契约（非空 + 含轮号）

const SLOT_IDS = ['pikachu', 'charmander', 'squirtle'];

function deriveTargetSids(meeting, mode, summarizerSlot) {
  if (!meeting || !Array.isArray(meeting.subSessions)) return [];

  if (mode === 'summary') {
    if (!summarizerSlot) return [];
    const idx = SLOT_IDS.indexOf(summarizerSlot);
    if (idx < 0) return [];
    if (idx >= meeting.subSessions.length) {
      console.warn(`[roundtable-free] summarizerSlot '${summarizerSlot}' (idx=${idx}) 超出 subSessions 长度 ${meeting.subSessions.length}`);
      return [];
    }
    const sid = meeting.subSessions[idx];
    return sid ? [sid] : [];
  }

  // fanout / debate：按 participants 过滤 sub
  if (!Array.isArray(meeting.participants)) return [];
  const result = [];
  for (const slotIdx of meeting.participants) {
    if (typeof slotIdx !== 'number' || slotIdx < 0 || slotIdx > 2) continue;
    if (slotIdx >= meeting.subSessions.length) {
      console.warn(`[roundtable-free] participants slot ${slotIdx} 超出 subSessions 长度 ${meeting.subSessions.length}`);
      continue;
    }
    const sid = meeting.subSessions[slotIdx];
    if (sid) result.push(sid);
  }
  return result;
}

function derivePilotCompatDispatchMode(participants, mode) {
  if (!Array.isArray(participants)) return 'all';
  // debate 永远派生 'all'：debate 模式必须让参与者互看，不能复用 observer 同组跳过语义
  //   （否则 injection.js 同组跳过会让两人看不到对方上一轮发言 → debate 失败）
  if (mode === 'debate') return 'all';
  const len = participants.length;
  if (len === 1) return 'pilot';
  if (len === 2) return 'observer';
  // 0 / 3 / >3 → all（兜底；3 人是天然全员；0/>3 防御性默认）
  return 'all';
}

module.exports = {
  deriveTargetSids,
  derivePilotCompatDispatchMode,
  // T3 会补 buildFree* prompt 模板
};
