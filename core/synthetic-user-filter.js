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
};
