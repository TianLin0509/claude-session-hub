'use strict';
// Roundtable Timeline — 系统侧自动维护的会议外置历史 (方案 F · 2026-05-02)
//
// 设计理念：
//   每轮 turn-complete 后系统侧自动 append 一段到 timeline.md。AI 看不到这个过程，
//   但每轮 prompt 末尾会附上文件绝对路径，AI 可主动 Read 它做长期上下文回顾。
//   滚动策略：保留近 10 个非摘要轮 + 全部摘要轮（摘要永久保留），过老的非摘要轮
//   归档到 -archive.md（追加模式）。
//
// 文件位置（按优先级）：
//   1. <projectCwd>/.arena/timeline-<meetingId>.md  (优先：AI 自然能 Read)
//   2. <hubDataDir>/timelines/timeline-<meetingId>.md  (无 cwd 时退到此)
//
// 文件结构示例：
//   # Roundtable Timeline · <meetingId>
//   > 场景：投研圆桌
//   > 创建时间：2026-05-02T10:23:00Z
//   > 滚动策略：保留近 10 个非摘要轮 + 全部摘要轮
//   ---
//
//   ## 第 1 轮 · fanout · all
//   - 时间：...
//   - 用户输入：...
//
//   ### Claude (主驾)
//   <全文>
//   ### Gemini
//   <全文>
//   ...
//
//   ## 第 4 轮 · 摘要 by Claude（五元组）
//   ...

const fs = require('fs');
const path = require('path');

const MAX_NON_SUMMARY_TURNS = 10;

// ---------------------------------------------------------------------------
// 路径计算
// ---------------------------------------------------------------------------
function getTimelinePath(meetingId, projectCwd, hubDataDir) {
  if (!meetingId) throw new Error('getTimelinePath: missing meetingId');
  if (projectCwd && _isUsableDir(projectCwd)) {
    return path.join(projectCwd, '.arena', `timeline-${meetingId}.md`);
  }
  if (!hubDataDir) throw new Error('getTimelinePath: no projectCwd and no hubDataDir');
  return path.join(hubDataDir, 'timelines', `timeline-${meetingId}.md`);
}

function getArchivePath(timelinePath) {
  return timelinePath.replace(/\.md$/, '-archive.md');
}

function _isUsableDir(p) {
  // 字符串非空 + 父目录存在（不要求 .arena 已存在；下面 mkdir 会建）
  if (typeof p !== 'string' || !p) return false;
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// ensureFile — 确保 timeline.md 存在并有头部
// ---------------------------------------------------------------------------
function ensureFile(meetingId, projectCwd, hubDataDir, sceneName) {
  const fp = getTimelinePath(meetingId, projectCwd, hubDataDir);
  if (fs.existsSync(fp)) return fp;
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const header = _renderHeader(meetingId, sceneName);
  fs.writeFileSync(fp, header, 'utf-8');
  return fp;
}

function _renderHeader(meetingId, sceneName) {
  return `# Roundtable Timeline · ${meetingId}\n\n` +
    `> 场景：${sceneName || '通用圆桌'}\n` +
    `> 创建时间：${new Date().toISOString()}\n` +
    `> 自动生成 · 系统侧维护\n` +
    `> 滚动策略：保留近 ${MAX_NON_SUMMARY_TURNS} 个非摘要轮 + 全部摘要轮（摘要永久保留）\n\n` +
    `---\n`;
}

// ---------------------------------------------------------------------------
// writeTurn — 追加一轮，触发滚动检查
// ---------------------------------------------------------------------------
//
// turnRecord 形态参照 RoundtableOrchestrator.completeTurn：
//   { n, mode, userInput, by: {sid: text}, byStatus: {sid: status}, timestamp,
//     dispatchMode?, summarizers? (摘要轮：参与摘要的 sid 数组) }
//
// sidLabelFn(sid) → 显示名（如 'Claude', 'Gemini'）。可选；缺省直接用 sid 前 8 位
//
function writeTurn(meetingId, turnRecord, sceneName, projectCwd, hubDataDir, sidLabelFn) {
  if (!turnRecord || typeof turnRecord.n !== 'number') {
    throw new Error('writeTurn: invalid turnRecord (missing .n)');
  }
  const fp = ensureFile(meetingId, projectCwd, hubDataDir, sceneName);
  const section = _renderTurnSection(turnRecord, sidLabelFn);
  fs.appendFileSync(fp, '\n' + section, 'utf-8');
  _rollIfNeeded(fp);
  return fp;
}

function _renderTurnSection(turnRecord, sidLabelFn) {
  // 摘要功能 2026-05-08 整体下线：新 turnRecord 仅 fanout / debate；
  //   _parseTurnSections 仍按 isSummary 解析历史 timeline 文件（向后兼容）。
  const { n, mode, userInput, by, byStatus, timestamp, dispatchMode } = turnRecord;
  const ts = new Date(timestamp || Date.now()).toISOString();
  const labelOf = (sid) => {
    if (typeof sidLabelFn === 'function') {
      const l = sidLabelFn(sid);
      if (l) return l;
    }
    return (typeof sid === 'string' && sid.length > 8) ? sid.slice(0, 8) : (sid || 'AI');
  };

  const dm = dispatchMode || 'all';
  const title = `## 第 ${n} 轮 · ${mode} · ${dm}`;

  let out = title + '\n';
  out += `- 时间：${ts}\n`;
  if (userInput && typeof userInput === 'string' && userInput.trim()) {
    const oneLine = userInput.replace(/\s*\n+\s*/g, ' ').slice(0, 200);
    out += `- 用户输入：${oneLine}${userInput.length > 200 ? '…' : ''}\n`;
  }
  out += '\n';

  // 各家发言
  const sids = Object.keys(by || {});
  for (const sid of sids) {
    const text = by[sid];
    const status = byStatus && byStatus[sid] ? byStatus[sid] : 'completed';
    out += `### ${labelOf(sid)}`;
    if (status === 'absent') out += '（本轮未参与）';
    else if (status === 'errored') out += '（本轮错误）';
    else if (status === 'manual_extracted') out += '（手动提取）';
    out += '\n';
    out += (text && String(text).trim()) ? text : '(无输出)';
    if (!String(out).endsWith('\n')) out += '\n';
    out += '\n';
  }
  return out;
}

// ---------------------------------------------------------------------------
// 滚动：超过 MAX_NON_SUMMARY_TURNS 个非摘要轮时归档最早的
// ---------------------------------------------------------------------------
function _rollIfNeeded(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const sections = _parseTurnSections(content);
  if (!sections) return;

  const { header, turns } = sections;
  const nonSummary = turns.filter(t => !t.isSummary);
  if (nonSummary.length <= MAX_NON_SUMMARY_TURNS) return;

  const toArchive = nonSummary.slice(0, nonSummary.length - MAX_NON_SUMMARY_TURNS);
  const toArchiveSet = new Set(toArchive);
  const kept = turns.filter(t => t.isSummary || !toArchiveSet.has(t));

  const newContent = header + kept.map(t => t.text).join('');
  const archivePath = getArchivePath(filePath);
  const archiveAppend = '\n' + toArchive.map(t => t.text).join('');

  // BUGFIX (4-way review · DeepSeek#1)：
  //   旧逻辑先写新主文件再 append archive —— 若 archive 写失败，主文件已被截断，
  //   滚出窗口的轮次永久丢失。
  //   修复：先确保 archive 写成功，再覆写主文件。任一步失败都不丢数据。
  try {
    if (!fs.existsSync(archivePath)) {
      const archiveHeader = `# Timeline Archive · ${path.basename(filePath, '.md')}\n\n` +
        `> 系统自动归档：从主 timeline 滚出窗口的非摘要轮（按时间顺序追加）\n\n---\n`;
      fs.writeFileSync(archivePath, archiveHeader, 'utf-8');
    }
    fs.appendFileSync(archivePath, archiveAppend, 'utf-8');
  } catch (e) {
    // archive 写失败 → 不动主文件，下次再尝试滚动
    console.warn(`[timeline] archive write failed, skip rolling: ${e.message}`);
    return;
  }
  // archive 已成功 → 安全截断主文件
  fs.writeFileSync(filePath, newContent, 'utf-8');
}

// 解析 timeline 内容为 { header, turns: [{ text, isSummary, n }] }
// 不解析失败抛错，仅在结构完整时返回
function _parseTurnSections(content) {
  // BUGFIX (4-way review · DeepSeek#2)：要求标题格式必含 " · "（系统侧标题严格固定格式
  //   "## 第 N 轮 · <mode> · <dispatchMode>" 或 "## 第 N 轮 · 摘要 by ..."），
  //   降低 AI 输出"## 第 N 轮"字面量被误识别为新轮起点的概率。
  const turnTitleRe = /^## 第 (\d+) 轮 · .*$/gm;
  const matches = [];
  let m;
  while ((m = turnTitleRe.exec(content)) !== null) {
    matches.push({ index: m.index, n: parseInt(m[1], 10), title: m[0] });
  }
  if (matches.length === 0) return null;

  const headerEnd = matches[0].index;
  const header = content.slice(0, headerEnd);

  const turns = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : content.length;
    const text = content.slice(start, end);
    const isSummary = /^## 第 \d+ 轮 · 摘要 by /.test(matches[i].title);
    turns.push({ text, isSummary, n: matches[i].n });
  }
  return { header, turns };
}

// ---------------------------------------------------------------------------
// readFull — 用于 e2e / debug
// ---------------------------------------------------------------------------
function readFull(meetingId, projectCwd, hubDataDir) {
  const fp = getTimelinePath(meetingId, projectCwd, hubDataDir);
  if (!fs.existsSync(fp)) return '';
  return fs.readFileSync(fp, 'utf-8');
}

module.exports = {
  getTimelinePath,
  getArchivePath,
  ensureFile,
  writeTurn,
  readFull,
  // 内部 helper 暴露供 unit test
  _renderTurnSection,
  _parseTurnSections,
  MAX_NON_SUMMARY_TURNS,
};
