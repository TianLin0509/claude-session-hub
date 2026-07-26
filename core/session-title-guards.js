'use strict';

const { KIND_LABELS } = require('./ai-kinds.js');

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeTitle(title) {
  return String(title || '').trim();
}

function resolveKindLabels(kindLabels) {
  return kindLabels && typeof kindLabels === 'object' ? kindLabels : KIND_LABELS;
}

function buildGenericSessionTitleRe(kindLabels = KIND_LABELS) {
  const labels = Object.values(resolveKindLabels(kindLabels))
    .filter(Boolean)
    .map(escapeRegExp)
    .sort((a, b) => b.length - a.length)
    .join('|');
  if (!labels) return /^$/;
  return new RegExp(`^(?:${labels})(?: Resume)? \\d+$`, 'i');
}

function isGenericAutoSessionTitle(title, kindLabels = KIND_LABELS) {
  const clean = normalizeTitle(title);
  return !clean || buildGenericSessionTitleRe(kindLabels).test(clean);
}

function looksLikePathTitle(title) {
  const clean = normalizeTitle(title);
  if (!clean) return false;
  if (/[A-Za-z]:[\\/]/.test(clean)) return true;
  if (/^\\\\/.test(clean)) return true;
  if (/[\\/]\.claude-session-hub[\\/]/i.test(clean)) return true;
  const slashCount = (clean.match(/[\\/]/g) || []).length;
  if (slashCount >= 2) return true;
  if (slashCount > 0 && /\.(?:png|jpe?g|gif|webp|bmp|exe|ps1|bat|cmd|md|html?|jsonl?|txt)(?:\s|$)/i.test(clean)) {
    return true;
  }
  return false;
}

function isStableSessionTitle(title, kindLabels = KIND_LABELS) {
  const clean = normalizeTitle(title);
  if (!clean) return false;
  if (/^Claude Code$/i.test(clean)) return false;
  return !looksLikePathTitle(clean) && !isGenericAutoSessionTitle(clean, kindLabels);
}

function shouldAcceptExternalSessionTitle(session, proposedTitle, kindLabels = KIND_LABELS) {
  if (!session || session.userRenamed || session.autoTitleGenerated || session.meetingId) return false;
  const clean = normalizeTitle(proposedTitle);
  if (!clean || /^Claude Code$/i.test(clean)) return false;
  if (looksLikePathTitle(clean)) return false;
  return isGenericAutoSessionTitle(session.title, kindLabels);
}

module.exports = {
  buildGenericSessionTitleRe,
  isGenericAutoSessionTitle,
  isStableSessionTitle,
  looksLikePathTitle,
  normalizeTitle,
  shouldAcceptExternalSessionTitle,
};
