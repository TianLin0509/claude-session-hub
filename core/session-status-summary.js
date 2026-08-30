'use strict';

function baseKind(session) {
  return String(session && session.kind || '').replace(/-resume$/i, '').toLowerCase();
}

function sessionModelLabel(session) {
  const model = session && session.currentModel;
  if (!model || typeof model !== 'object') return '';
  return String(model.id || model.displayName || '').trim();
}

function sessionEffortLabel(session) {
  const kind = baseKind(session);
  if (!['claude', 'codex', 'deepseek', 'deepseek-claude'].includes(kind)) return '';
  return String(session && session.effort || 'max').trim().toLowerCase();
}

function sessionSpeedLabel(session) {
  const kind = baseKind(session);
  if (kind === 'claude' || kind === 'deepseek-claude') {
    return session && session.fastMode === false ? 'standard' : 'fast';
  }
  if (kind === 'codex') {
    return String(session && session.codexSpeedTier || 'fast').trim().toLowerCase();
  }
  if (kind === 'deepseek') {
    const tier = String(session && session.codexSpeedTier || 'inherit').trim().toLowerCase();
    return tier === 'inherit' ? '' : tier;
  }
  return '';
}

function sessionContextLeft(session) {
  const used = Number(session && session.contextPct);
  if (!Number.isFinite(used)) return null;
  return Math.max(0, Math.min(100, Math.round(100 - used)));
}

function buildSessionStatusSummary(session) {
  const model = sessionModelLabel(session);
  const effort = sessionEffortLabel(session);
  const speed = sessionSpeedLabel(session);
  const contextLeft = sessionContextLeft(session);
  const cwd = String(session && session.cwd || '').trim();
  const compact = [model, effort, speed].filter(Boolean).join(' · ');
  return {
    kind: baseKind(session),
    model,
    effort,
    speed,
    contextLeft,
    contextText: contextLeft == null ? '' : `Context ${contextLeft}% left`,
    cwd,
    compact,
    ariaLabel: [compact, contextLeft == null ? '' : `上下文剩余 ${contextLeft}%`, cwd]
      .filter(Boolean).join('，'),
  };
}

module.exports = {
  baseKind,
  buildSessionStatusSummary,
  sessionContextLeft,
  sessionEffortLabel,
  sessionModelLabel,
  sessionSpeedLabel,
};
