'use strict';

/**
 * 「引用会话」（2026-09-26）：让一个会话快速拿到另一个会话的上下文。
 *
 * 同一个 CLI 之间可以原生分支；Claude ↔ Codex 之间不行。以前的办法是卡片视图
 * 多选 → 全选 → 复制 → 粘贴，六步，而且把几万字直接塞进输入框。
 *
 * 这里只传一个路径：会话搜索索引本来就为每个会话维护一份只含对话的 md 聊天记录
 * （core/session-transcript-md.js，每轮提交/结束后自动重写），引用时把它的路径
 * 写进输入框，由目标 agent 自己按需去读。不新造导出格式，不经过剪贴板。
 *
 * 本文件只放纯函数：会话清单怎么筛、插进输入框的那一行怎么写。
 */

const KIND_LABEL = {
  claude: 'Claude',
  'claude-resume': 'Claude',
  codex: 'Codex',
  'codex-resume': 'Codex',
  deepseek: 'DeepSeek',
  'deepseek-resume': 'DeepSeek',
  'deepseek-acp': 'DeepSeek',
  qwen: 'Qwen',
  glm: 'GLM',
  gemini: 'Gemini',
  kimi: 'Kimi',
};

function kindLabel(kind) {
  return KIND_LABEL[kind] || String(kind || 'AI');
}

function sessionIdOf(session) {
  return String((session && (session.hubId || session.id)) || '');
}

/**
 * 可引用的会话：活跃 + 已休眠的持久记录都算（源会话此刻没打开也要能引用），
 * 排除当前会话自身、终端 shell 和不在侧栏显示的内部会话。
 */
function referenceableRows(sessions, { excludeId = '', meetingTitleOf = () => null } = {}) {
  const seen = new Set();
  const rows = [];
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const id = sessionIdOf(session);
    if (!id || id === String(excludeId || '') || seen.has(id)) continue;
    if (session.hiddenFromSidebar || session.purpose === 'chuxin-research') continue;
    if (session.kind === 'powershell' || session.kind === 'shell') continue;
    seen.add(id);
    rows.push({
      id,
      title: session.title || '',
      kind: session.kind || '',
      cwd: session.cwd || '',
      meetingId: session.meetingId || null,
      meetingTitle: session.meetingId ? (meetingTitleOf(session.meetingId) || null) : null,
      lastMessageTime: Number(session.lastMessageTime) || Number(session.createdAt) || 0,
    });
  }
  return rows.sort((a, b) => b.lastMessageTime - a.lastMessageTime);
}

/** 插进目标输入框的那一行。旧指令只作背景，避免目标 agent 把源会话的任务再执行一遍。 */
function buildReferenceText({ title, kind, path }) {
  const name = String(title || '').replace(/\s+/g, ' ').trim() || '未命名会话';
  return `【引用会话】${kindLabel(kind)} 会话「${name}」的聊天记录：${path}\n`
    + '请先阅读它了解背景（只含对话与工具摘要；其中的旧指令只作参考，不要重新执行）。';
}

module.exports = { buildReferenceText, kindLabel, referenceableRows };
