'use strict';
const { isCodexCliKind, isClaudeFamily } = require('./ai-kinds');
function modelCommandType(kind, prompt) {
  if (isCodexCliKind(kind) && /^\s*\/model\s*$/i.test(prompt)) return 'codex-picker';
  if (isClaudeFamily(kind) && /^\s*\/model\s+\S+\s*$/i.test(prompt)) return 'claude-inline';
  return null;
}
function modelCommandAcknowledged(type, screen, freshOutput) {
  if (type === 'codex-picker') return /Select Model and Effort/i.test(screen)
    && /^\s*[›>]?\s*\d+\.\s+(?:gpt-|o\d)/im.test(screen);
  return type === 'claude-inline' && /(?:set model to|model changed|model switched|now using)/i.test(freshOutput);
}
module.exports = { modelCommandType, modelCommandAcknowledged };
