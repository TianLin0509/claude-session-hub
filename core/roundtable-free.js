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

// ---------------------------------------------------------------------------
// Prompt 模板（free 模式专用）
// ---------------------------------------------------------------------------

const SLOT_DISPLAY = {
  pikachu:    { en: 'Pikachu',    icon: '⚡' },
  charmander: { en: 'Charmander', icon: '🔥' },
  squirtle:   { en: 'Squirtle',   icon: '💎' },
};

function _slotLabel(slotIdOrIdx) {
  let id;
  if (typeof slotIdOrIdx === 'number') {
    id = SLOT_IDS[slotIdOrIdx];
  } else if (typeof slotIdOrIdx === 'string') {
    // 接受数字字符串（如 "0"）和 slot id 字符串（如 "pikachu"）
    const asNum = Number(slotIdOrIdx);
    id = (Number.isInteger(asNum) && asNum >= 0 && asNum <= 2)
      ? SLOT_IDS[asNum]
      : slotIdOrIdx;
  }
  const d = id && SLOT_DISPLAY[id];
  return d ? `${d.icon} ${d.en}` : 'AI';
}

function _formatParticipantList(participants) {
  if (!Array.isArray(participants) || participants.length === 0) return '';
  return participants.map(idx => _slotLabel(idx)).join(', ');
}

function _renderInjection(inj) {
  if (!inj || !Array.isArray(inj.speakers) || inj.speakers.length === 0) return '';
  const lines = ['', '[上一轮注入]'];
  if (inj.isSummaryInjection) {
    lines.push(`（上一轮是摘要轮，第 ${inj.lastTurnNum} 轮 · ${inj.lastTurnMode}）`);
  } else {
    lines.push(`（第 ${inj.lastTurnNum} 轮 · ${inj.lastTurnMode} · ${inj.lastDispatchMode}）`);
  }
  for (const s of inj.speakers) {
    lines.push('');
    lines.push(`### ${s.label}（${s.status || 'completed'}）`);
    lines.push(s.text || '');
  }
  return lines.join('\n');
}

function buildFreeFanoutPrompt({ meeting, selfSlot, participants, userInput, lastTurnInjection, turnNum }) {
  const n = (typeof turnNum === 'number' && turnNum > 0) ? turnNum : '?';
  const selfLabel = _slotLabel(selfSlot);
  const partList = _formatParticipantList(participants);
  const lines = [
    `# 自由模式 第 ${n} 轮 fanout — 你是 ${selfLabel}`,
    '',
    '[本轮上下文]',
    `- 模式：自由模式 · fanout`,
    `- 本轮发言人：${partList}`,
    `- 你是：${selfLabel}`,
  ];
  const inj = _renderInjection(lastTurnInjection);
  if (inj) lines.push(inj);
  lines.push('', '[用户输入]', userInput || '');
  lines.push('', '请独立回答（与其他发言人互相看不到本轮发言，保持各自独立视角）。');
  return lines.join('\n');
}

function buildFreeDebatePrompt({ meeting, selfSlot, participants, userInput, lastTurnInjection, turnNum }) {
  const n = (typeof turnNum === 'number' && turnNum > 0) ? turnNum : '?';
  const selfLabel = _slotLabel(selfSlot);
  const partList = _formatParticipantList(participants);
  const lines = [
    `# 自由模式 第 ${n} 轮 debate — 你是 ${selfLabel}`,
    '',
    '[本轮上下文]',
    `- 模式：自由模式 · 辩论`,
    `- 本轮发言人：${partList}`,
    `- 你是：${selfLabel}`,
  ];
  const inj = _renderInjection(lastTurnInjection);
  if (inj) lines.push(inj);
  lines.push('', '[用户输入]', userInput || '');
  lines.push('', '请反驳/呼应其他发言人的观点（你们看得到对方本轮言论）。');
  return lines.join('\n');
}

function buildFreeSummaryPrompt({ meeting, summarizerSlot, userInput, lastTurnInjection, turnNum }) {
  const n = (typeof turnNum === 'number' && turnNum > 0) ? turnNum : '?';
  const selfLabel = _slotLabel(summarizerSlot);
  const lines = [
    `# 自由模式 第 ${n} 轮 summary — 你是 ${selfLabel}`,
    '',
    '[本轮上下文]',
    `- 模式：自由模式 · 总结`,
    `- 你被点名担任本轮总结人`,
  ];
  const inj = _renderInjection(lastTurnInjection);
  if (inj) lines.push(inj);
  lines.push('', '[用户输入]', userInput || '');
  lines.push('', '请综合上述历史给出总结。');
  return lines.join('\n');
}

module.exports = {
  deriveTargetSids,
  derivePilotCompatDispatchMode,
  buildFreeFanoutPrompt,
  buildFreeDebatePrompt,
  buildFreeSummaryPrompt,
};
