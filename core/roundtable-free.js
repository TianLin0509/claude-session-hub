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
//     P6 (2026-05-04): 与 pilot 路径统一 5 段骨架 + 字段化调度上下文 + footer 压缩
//     第一行格式: [<sceneName> · 第 N 轮 · <模式中文>] (B1 决议·hub 头部解析依赖)
//
// P4 SSoT (2026-05-04): COVENANT_GENERAL 与 buildBriefSummaryPrompt 共用同一份字段定义,
//   通过 renderFiveElementItems / renderBriefSummaryConstraints helper 渲染。
//   free 路径目前没有 brief-summary 模式 (用户在 UI 点摘要按钮走 pilot 路径)。

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
// Prompt 模板（free 模式专用，P6 统一骨架·2026-05-04）
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
  return participants.map(idx => _slotLabel(idx)).join(' / ');
}

function _renderInjection(inj) {
  if (!inj || !Array.isArray(inj.speakers) || inj.speakers.length === 0) return '';
  const lines = ['', '## 上一轮注入'];
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

// P6 (2026-05-04): free 路径字段化调度上下文 helper
//   字段差异 (vs pilot):
//     - "你是" 不带 (副驾/主驾) 角色括注 (free 取消该概念)
//     - "参与者" (含自己) 替代 pilot 的 "同台" (不含自己)
//     - "模式" 固定为 "自由（参与者勾选）"
function _renderFreeDispatchContext({ selfSlot, participants, turnKind, answerStyle }) {
  const lines = ['## 调度上下文'];
  lines.push(`- 你是:${_slotLabel(selfSlot)}`);
  const partList = _formatParticipantList(participants);
  if (partList) lines.push(`- 参与者:${partList}`);
  lines.push('- 模式:自由（参与者勾选）');
  lines.push(`- 轮次性质:${turnKind}`);
  lines.push(`- 回答方式:${answerStyle}`);
  lines.push('- 轻提醒:≤ 1500 字 / 不写文件 / 不展开多步骤工作流');
  return lines.join('\n');
}

// P6 (2026-05-04): timeline footer 压缩 (与 pilot 路径 _renderTimelineFooter 一致)
function _renderFreeTimelineFooter(timelinePath) {
  if (!timelinePath || typeof timelinePath !== 'string') return null;
  return `> 完整历史:${timelinePath}`;
}

function buildFreeFanoutPrompt({ meeting, selfSlot, participants, userInput, lastTurnInjection, turnNum, sceneName, timelinePath }) {
  const n = (typeof turnNum === 'number' && turnNum > 0) ? turnNum : '?';
  const scene = sceneName || (meeting && meeting.scene === 'research' ? '投研圆桌' : '通用圆桌');
  // P6 B1 (2026-05-04): 第一行改用 pilot 格式 [<scene> · 第 N 轮 · <模式中文>]
  //   撤销原 `# 自由模式 第 N 轮 fanout — 你是 ⚡ Pikachu` 格式 (与 hub 头部解析契约统一)
  const lines = [`[${scene} · 第 ${n} 轮 · 默认提问]`];

  lines.push('', _renderFreeDispatchContext({
    selfSlot, participants,
    turnKind: 'fanout',
    answerStyle: '独立回答（与其他参与者互相看不到本轮发言）',
  }));

  const inj = _renderInjection(lastTurnInjection);
  if (inj) lines.push(inj);

  lines.push('', '## 用户问题', userInput || '');

  // P6: 删除原"请独立回答（与其他发言人互相看不到本轮发言，保持各自独立视角）"独立段
  //   (已并入 _renderFreeDispatchContext 的"回答方式"字段)

  const footer = _renderFreeTimelineFooter(timelinePath);
  if (footer) lines.push('', footer);

  return lines.join('\n');
}

function buildFreeDebatePrompt({ meeting, selfSlot, participants, userInput, lastTurnInjection, turnNum, sceneName, timelinePath }) {
  const n = (typeof turnNum === 'number' && turnNum > 0) ? turnNum : '?';
  const scene = sceneName || (meeting && meeting.scene === 'research' ? '投研圆桌' : '通用圆桌');
  // P6 B1: 第一行 [<scene> · 第 N 轮 · @debate]
  const lines = [`[${scene} · 第 ${n} 轮 · @debate]`];

  lines.push('', _renderFreeDispatchContext({
    selfSlot, participants,
    turnKind: 'debate',
    answerStyle: '反驳/呼应其他参与者观点（可看到对方本轮言论）',
  }));

  if (userInput && typeof userInput === 'string' && userInput.trim().length > 0) {
    lines.push('', '## 用户在本轮补充的新信息', userInput);
  }

  const inj = _renderInjection(lastTurnInjection);
  if (inj) lines.push(inj);

  lines.push('', '## 你的任务');
  lines.push('请基于上一轮内容 + 用户补充信息发表新观点：可继承、可反驳，但要明示引用对方哪一点。');

  // P6: 删除原"请反驳/呼应其他发言人的观点（你们看得到对方本轮言论）"独立段

  const footer = _renderFreeTimelineFooter(timelinePath);
  if (footer) lines.push('', footer);

  return lines.join('\n');
}

function buildFreeSummaryPrompt({ meeting, summarizerSlot, userInput, lastTurnInjection, turnNum, sceneName, timelinePath }) {
  const n = (typeof turnNum === 'number' && turnNum > 0) ? turnNum : '?';
  const scene = sceneName || (meeting && meeting.scene === 'research' ? '投研圆桌' : '通用圆桌');
  const selfLabel = _slotLabel(summarizerSlot);
  // P6 B1: 第一行 [<scene> · 第 N 轮 · @summary @<X>]
  const lines = [`[${scene} · 第 ${n} 轮 · @summary @${selfLabel}]`];

  lines.push('', _renderFreeDispatchContext({
    selfSlot: summarizerSlot,
    participants: null,  // summary 轮只发给被点名的 summarizer,无"参与者"概念
    turnKind: 'summary',
    answerStyle: '综合上述历史给出总结',
  }));

  const inj = _renderInjection(lastTurnInjection);
  if (inj) lines.push(inj);

  lines.push('', '## 你的任务', userInput || '请综合上述历史给出总结。');

  // P6: 删除原"请综合上述历史给出总结。"独立段

  const footer = _renderFreeTimelineFooter(timelinePath);
  if (footer) lines.push('', footer);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// IPC 校验 helper（main.js 用）
// ---------------------------------------------------------------------------

function _validateMode(mode) {
  if (mode !== 'pilot' && mode !== 'free') {
    throw new Error(`Invalid mode: ${JSON.stringify(mode)} (expected 'pilot' or 'free')`);
  }
  return mode;
}

function _validateParticipants(arr) {
  if (!Array.isArray(arr)) {
    throw new Error(`participants must be array, got ${typeof arr}`);
  }
  const seen = new Set();
  for (const x of arr) {
    if (!Number.isInteger(x) || x < 0 || x > 2) {
      throw new Error(`Invalid participant slot: ${JSON.stringify(x)} (expected 0|1|2)`);
    }
    seen.add(x);
  }
  return [...seen].sort((a, b) => a - b);
}

module.exports = {
  deriveTargetSids,
  derivePilotCompatDispatchMode,
  buildFreeFanoutPrompt,
  buildFreeDebatePrompt,
  buildFreeSummaryPrompt,
  _validateMode,
  _validateParticipants,
};
