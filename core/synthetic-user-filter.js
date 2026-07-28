'use strict';

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (!item) return '';
      if (typeof item === 'string') return item;
      if (typeof item.text === 'string') return item.text;
      if (typeof item.content === 'string') return item.content;
      if (Array.isArray(item.content)) return textFromContent(item.content);
      return '';
    }).filter(Boolean).join('\n');
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
    if (Array.isArray(content.content)) return textFromContent(content.content);
  }
  return '';
}

function isSyntheticUserText(text) {
  const t = String(text || '').trimStart();
  if (!t) return false;
  return (
    t.startsWith('<task-notification>') ||
    t.startsWith('<local-command-caveat>') ||
    t.startsWith('<command-name>') ||
    // 斜杠命令的回显（/model、/goal 等）。CLI 把它当 user 消息写进 transcript，
    // 但用户并没有"说"过这段话，卡片视图里出现就是噪音。
    t.startsWith('<local-command-stdout>') ||
    // 用户按 Esc / 打断工具调用时 CLI 自己插入的占位
    t.startsWith('[Request interrupted by user') ||
    t.startsWith('This session is being continued from a previous conversation that ran out of context.') ||
    t.startsWith('# AGENTS.md instructions for ') ||
    t.startsWith('<permissions instructions>') ||
    t.startsWith('<environment_context>') ||
    t.startsWith('<skills_instructions>') ||
    t.startsWith('<plugins_instructions>') ||
    t.startsWith('<collaboration_mode>') ||
    t.startsWith('# Model Set Context') ||
    (t.includes('<INSTRUCTIONS>') && t.includes('CAT-CAFE-GOVERNANCE-START'))
  );
}

// AI 群聊里，Hub 发给每个成员的其实是一整段脚手架（group-chat-orchestrator.js
// buildSystemPromptText / buildDelta 拼的）：
//     ## 规则           ← Hub 注入的角色设定
//     ## 输出
//     ## 新增发言       ← 其他成员的发言转述
//     ## 用户
//     <用户真正打的字>
//     请发言。
// 整段都会以 user 消息落进各成员的 transcript。原样渲染就变成"我的 prompt 是一大坨
// 规则"，实测这是卡片视图里最大的一类误显示（扫 101 份 transcript，78 次）。
// 但也不能整条丢掉——用户真正的输入就藏在 `## 用户` 里，丢了就什么都看不到。
// 所以只把那一段抽出来。
function extractGroupChatUserInput(text) {
  const t = String(text || '');
  const marker = /(^|\n)##[ \t]*用户[ \t]*\r?\n/g;
  let last = null;
  let m;
  while ((m = marker.exec(t)) !== null) last = m;
  if (!last) return null;
  // 只在确认是群聊脚手架时才动手，避免误伤正文里恰好写了 "## 用户" 的普通提问
  if (!/(^|\n)##[ \t]*规则/.test(t) && !/(^|\n)##[ \t]*新增发言/.test(t)) return null;
  let body = t.slice(last.index + last[0].length);
  body = body.replace(/\r?\n+[ \t]*请发言。[ \t]*\r?\n*$/, '');
  return body.trim();
}

// 卡片视图该显示什么：null = 这条压根不该出现；否则返回应显示的文本。
function displayUserText(text) {
  if (isSyntheticUserText(text)) return null;
  const groupChat = extractGroupChatUserInput(text);
  if (groupChat === null) return String(text || '');
  // 纯转述轮（用户这一轮没说话，只是让 AI 接着聊）不该冒出一张空的"你"卡片
  return groupChat || null;
}

function isSyntheticUserEntry(entry, text) {
  if (!entry || typeof entry !== 'object') return false;
  const candidate = text !== undefined ? text : textFromContent(entry.message?.content ?? entry.payload?.content ?? entry.payload?.message);
  if (entry.isMeta === true || entry.isCompactSummary === true || entry.isVisibleInTranscriptOnly === true) return true;
  if (entry.origin && entry.origin.kind === 'task-notification') return true;
  if (entry.promptSource === 'system' && (entry.origin || isSyntheticUserText(candidate))) return true;
  return isSyntheticUserText(candidate);
}

module.exports = {
  textFromContent,
  isSyntheticUserText,
  isSyntheticUserEntry,
  extractGroupChatUserInput,
  displayUserText,
};
