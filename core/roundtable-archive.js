'use strict';
// core/roundtable-archive.js
// 圆桌 summary 完成后的决策档案写入。从 main.js 抽出（2026-05-03 道雪）。
//
// 语义：summary mode 的 turnRecord 完成后，把"最终意见 + 全部历史轮次"
//   落到 <projectCwd>/.arena/sessions/<datetime>-<title>.md。turn-complete
//   路径首次写入；manual-extract 路径若 patched 同 turn 则覆写（让磁盘档案
//   始终反映最新文本）。
//
// 字段路径修复（同时修 ad24977 引入的 bug ④ 复发）：
//   原 helper 错读 turnRecord.meta?.X，但 orchestrator.completeTurn 用
//   `...meta` 顶层展开 record，没有 .meta 嵌套字段。结果 summarizer /
//   summarizerSid / decisionTitle 全部 undefined → 归档 .md 写出
//   "## 最终意见（undefined）" + "(无输出)"。修：直接读 turnRecord 顶层。
//
// 依赖注入（deps）：避免 module 反向依赖 main.js
//   meetingManager / sessionManager / scenes / roundtable / getHubDataDir

const fs = require('fs');
const path = require('path');

function writeDecisionArchive(meetingId, turnRecord, deps) {
  if (!turnRecord || turnRecord.mode !== 'summary') return null;
  const { meetingManager, sessionManager, scenes, roundtable, getHubDataDir } = deps || {};
  if (!meetingManager || !sessionManager || !scenes || !roundtable || !getHubDataDir) {
    console.warn('[roundtable-archive] missing deps; skip archive');
    return null;
  }
  try {
    const meeting = meetingManager.getMeeting(meetingId);
    if (!meeting) return null;
    // claude session 的 cwd 当 projectCwd（与原归档同源）
    const claudeSid = (meeting.subSessions || [])
      .find(sid => sessionManager.getSession(sid)?.kind === 'claude');
    const claudeSession = claudeSid ? sessionManager.getSession(claudeSid) : null;
    const projectCwd = claudeSession?.cwd;
    if (!projectCwd) return null;

    const summarizer = turnRecord.summarizer;
    const summarizerSid = turnRecord.summarizerSid;
    const decisionTitle = turnRecord.decisionTitle;

    const labelMap = new Map();
    for (const sid of meeting.subSessions || []) {
      const s = sessionManager.getSession(sid);
      if (s) labelMap.set(sid, s.title || s.kind || 'AI');
    }
    const sidLabelFn = (sid) => labelMap.get(sid) || 'AI';

    const sceneObj = scenes.getScene(meeting.scene);
    const orch = roundtable.getOrchestrator(getHubDataDir(), meetingId, sceneObj);

    const sessionsDir = path.join(projectCwd, '.arena', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    // 文件名：首次按当前时间戳，后续复用 turnRecord.archivedTo（若已持久化）。
    // 注：当前 archivedTo 仅写到 dispatch 闭包的 meta 对象，未持久化进 record；
    //   下个迭代加 orch.patchTurnMeta 后此处才能复用旧文件名（避免重复落档）。
    let fileName = turnRecord.archivedTo;
    const isFirstWrite = !fileName;
    if (isFirstWrite) {
      const ts = new Date();
      const stamp = `${ts.getFullYear()}-${String(ts.getMonth()+1).padStart(2,'0')}-${String(ts.getDate()).padStart(2,'0')}-${String(ts.getHours()).padStart(2,'0')}${String(ts.getMinutes()).padStart(2,'0')}`;
      const titleSlug = (decisionTitle || `session-${turnRecord.n}`).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
      fileName = `${stamp}-${titleSlug}.md`;
    }

    const archiveTitle = meeting.scene === 'research' ? '# 投研圆桌决策档案' : '# 圆桌讨论决策档案';
    const summaryFinalText = turnRecord.by?.[summarizerSid] || '(无输出)';
    const lines = [
      archiveTitle,
      `- 标题：${decisionTitle || '(未提供)'}`,
      `- 总结人：${summarizer || 'unknown'}`,
      `- 完成时间：${new Date().toLocaleString('zh-CN')}`,
      `- 会议室：${meetingId}`,
      `- 历史轮数：${orch.state.turns.length}`,
      '',
      `## 最终意见（${summarizer || 'unknown'}）`,
      '',
      summaryFinalText,
      '',
      `## 全部历史轮次`,
      '',
    ];
    for (const t of orch.state.turns) {
      lines.push(`### 第 ${t.n} 轮 · ${t.mode}`);
      if (t.userInput) lines.push(`**用户输入**：${t.userInput}`);
      for (const [sid, text] of Object.entries(t.by || {})) {
        lines.push('', `#### ${sidLabelFn(sid)}`, text || '(无输出)');
      }
      lines.push('');
    }
    fs.writeFileSync(path.join(sessionsDir, fileName), lines.join('\n'), 'utf-8');
    console.log(`[roundtable-archive] decision archived (${isFirstWrite ? 'first' : 'patched'}): ${fileName}`);
    return fileName;
  } catch (e) {
    console.warn('[roundtable-archive] archive failed:', e.message);
    return null;
  }
}

module.exports = { writeDecisionArchive };
