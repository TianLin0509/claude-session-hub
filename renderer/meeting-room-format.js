// Shared presentation helpers for meeting-room.js.

const KIND_AVATAR_SRC = {
  claude: 'assets/pokemon/pikachu.png',
  gemini: 'assets/pokemon/charmander.png',
  codex: 'assets/pokemon/squirtle.png',
  deepseek: 'assets/pokemon/pikachu.png',
  glm: 'assets/pokemon/pikachu.png',
  gpt: 'assets/pokemon/pikachu.png',
  kimi: 'assets/pokemon/pikachu.png',
  qwen: 'assets/pokemon/pikachu.png',
};

const KIND_AVATAR_FALLBACK = {
  claude: '\uD83D\uDFE1',
  gemini: '\uD83D\uDFE0',
  codex: '\uD83D\uDD35',
  deepseek: '\uD83D\uDFE2',
  glm: '\uD83D\uDFE3',
  gpt: '\u26AA',
  kimi: '\uD83D\uDFE4',
  qwen: '\uD83D\uDD34',
};

const SLOT_AVATARS = [
  'assets/pokemon/pikachu.png',
  'assets/pokemon/charmander.png',
  'assets/pokemon/squirtle.png',
];
const SLOT_AVATAR_FALLBACK = ['\uD83D\uDFE1', '\uD83D\uDFE0', '\uD83D\uDD35'];

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ftCtxClass(pct) {
  if (typeof pct !== 'number') return 'ok';
  if (pct >= 80) return 'high';
  if (pct >= 50) return 'warn';
  return 'ok';
}

function formatTokens(n) {
  if (n == null || n === 0) return '-';
  if (n < 1000) return String(n);
  if (n < 1000000) {
    const v = (n / 1000).toFixed(1);
    return v.replace(/\.0$/, '') + 'k';
  }
  return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
}

function formatThinkTime(seconds) {
  if (seconds == null || seconds === 0) return '-';
  if (seconds < 60) {
    return seconds < 10 ? `${seconds.toFixed(1).replace(/\.0$/, '')}s` : `${Math.round(seconds)}s`;
  }
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s === 0 ? `${m}m` : `${m}m${String(s).padStart(2, '0')}s`;
}

function avatarSrcFor(kind) {
  return KIND_AVATAR_SRC[kind] || '';
}

function avatarFallbackFor(kind) {
  return KIND_AVATAR_FALLBACK[kind] || '\uD83E\uDD16';
}

function avatarBySlot(index) {
  return SLOT_AVATARS[index] || '';
}

function avatarFallbackBySlot(index) {
  return SLOT_AVATAR_FALLBACK[index] || '\uD83E\uDD16';
}

module.exports = {
  avatarBySlot,
  avatarFallbackBySlot,
  avatarFallbackFor,
  avatarSrcFor,
  escapeHtml,
  formatThinkTime,
  formatTokens,
  ftCtxClass,
};
