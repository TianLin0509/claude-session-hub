'use strict';

const { canonicalAiKind } = require('../core/ai-kinds');

// Artwork is a presentation registry, not another list of supported runtimes.
const ARTWORK = Object.freeze({
  gpt: 'codex', claude: 'claude', gemini: 'gemini', deepseek: 'deepseek',
  kimi: 'kimi', qwen: 'qwen', glm: 'glm',
});
const USER_AVATAR_SRC = '../claude-wx.ico';
const ASSISTANT_AVATAR_SRC = 'assets/assistant/penguin.png';

function chatAvatarSrc(kind, { assistant = false } = {}) {
  if (assistant) return ASSISTANT_AVATAR_SRC;
  const family = canonicalAiKind(String(kind || '').toLowerCase().replace(/-resume$/, ''));
  const name = ARTWORK[family];
  return name ? `assets/ai-avatars/v1/${name}.png` : null;
}

module.exports = { chatAvatarSrc, USER_AVATAR_SRC, ASSISTANT_AVATAR_SRC };
