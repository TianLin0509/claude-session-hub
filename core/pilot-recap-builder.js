'use strict';
// pilot-recap-builder（2026-05-01）— 主驾切回时生成对话历史的 markdown 镜像 + segment 索引。
//
// 给副驾的 prompt 注入是 D'（不限字数摘要 by 主驾）+ F2（md 镜像 path）+ F5（段落目录）。
// segment 切分双模：
//   - F5-A 智能切（默认）：主驾自己一并产出"段落 N: <主题>"目录，本 builder 按目录均分
//   - F5-B 按轮切：每轮一段（idx, mode, title='Q: <用户原话前 30 字>', turnRange=[i,i+1]）
// builder 不调 LLM；smart 切的标题由 main.js _generatePilotRecap 调 summary-engine 解析。
//
// segment 字段约定：{ idx, mode: 'turn'|'smart', title, mdLineStart, mdLineEnd, turnRange: [start, end) }
// turn 形状：{ ts, userInput, response }（来自 private-store 的 sid 索引存储）

const fs = require('fs');

// 用户问题前 30 个字（不含空白）作为标题；用户输入太短则附 AI 答前 15 字。
function _shortTitleForTurn(turn) {
  const userInput = String(turn?.userInput || '').replace(/\s+/g, ' ').trim();
  if (userInput.length >= 5) return `Q: ${userInput.slice(0, 30)}`;
  const aiAns = String(turn?.response || '').replace(/\s+/g, ' ').trim().slice(0, 15);
  return `Q: ${userInput || '(空)'} · A: ${aiAns}`;
}

// F5-B：每轮一段
function splitByTurn(turns) {
  if (!Array.isArray(turns) || turns.length === 0) return [];
  return turns.map((t, i) => ({
    idx: i + 1,
    mode: 'turn',
    title: _shortTitleForTurn(t),
    mdLineStart: 0, mdLineEnd: 0,
    turnRange: [i, i + 1],
  }));
}

// F5-A：按主题切（segmentTitles 来自 LLM 解析）。
// 当 segmentTitles 不可用 / 数量异常时降级到 F5-B。
function splitBySmart(turns, segmentTitles) {
  if (!Array.isArray(turns) || turns.length === 0) return [];
  if (!Array.isArray(segmentTitles) || segmentTitles.length === 0) {
    return splitByTurn(turns);
  }
  // 上限 10 段，下限 1 段（segment 数 > turns 数也截断）
  const N = Math.max(1, Math.min(segmentTitles.length, Math.min(10, turns.length)));
  const titles = segmentTitles.slice(0, N);
  const turnsPerSeg = Math.ceil(turns.length / N);
  return titles.map((title, i) => ({
    idx: i + 1,
    mode: 'smart',
    title: String(title || '').trim().slice(0, 60) || `段落 ${i + 1}`,
    mdLineStart: 0, mdLineEnd: 0,
    turnRange: [i * turnsPerSeg, Math.min((i + 1) * turnsPerSeg, turns.length)],
  }));
}

function _formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  // 取 HH:MM:SS（ISO 切片即可）
  return d.toISOString().slice(11, 19);
}

function _formatDateRange(turns) {
  if (!turns.length) return '';
  const first = new Date(turns[0].ts || Date.now());
  const last = new Date(turns[turns.length - 1].ts || Date.now());
  return `${first.toISOString().slice(0, 16).replace('T', ' ')} ~ ${last.toISOString().slice(11, 16)}`;
}

// 写 markdown 镜像 + 在 segments[i] 上打 mdLineStart/mdLineEnd 行号（1-based 闭区间）。
// 行号方便副驾用 Read 工具按 offset+limit 精确读对应段落。
async function build(mdPath, turns, segments, meta) {
  const lines = [];
  const pilotKind = meta?.pilotKind || 'AI';
  const pilotSlot = (typeof meta?.pilotSlot === 'number') ? meta.pilotSlot : 0;

  lines.push(`# 主驾期会话历史 · Slot ${pilotSlot + 1} (${pilotKind})`);
  lines.push(`> ${_formatDateRange(turns)} · ${turns.length} 轮 · 主驾 ${pilotKind}`);
  lines.push('');

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const startLine = lines.length + 1; // 1-based
    lines.push(`<!-- segment ${i + 1} start -->`);
    lines.push(`## 段落 ${i + 1} · ${seg.title}`);
    lines.push('');

    const [a, b] = seg.turnRange;
    const turnsInSeg = turns.slice(a, b);
    for (let j = 0; j < turnsInSeg.length; j++) {
      const t = turnsInSeg[j];
      const turnNum = a + j + 1; // 全局轮次号
      lines.push(`### 第 ${turnNum} 轮 (${_formatTime(t.ts)})`);
      lines.push(`**用户**: ${t.userInput || ''}`);
      lines.push('');
      lines.push(`**${pilotKind}**: ${t.response || ''}`);
      lines.push('');
    }
    lines.push(`<!-- segment ${i + 1} end -->`);
    lines.push('');
    seg.mdLineStart = startLine;
    seg.mdLineEnd = lines.length; // 含 end-marker
  }

  await fs.promises.writeFile(mdPath, lines.join('\n'), 'utf8');
  return segments;
}

// 切段模式切换时重写 md（同一组 turns，不同 segments 划分）。
async function rebuildMd(mdPath, turns, segments, meta) {
  return build(mdPath, turns, segments, meta);
}

module.exports = {
  splitByTurn,
  splitBySmart,
  build,
  rebuildMd,
  _shortTitleForTurn,  // 给单测用
};
