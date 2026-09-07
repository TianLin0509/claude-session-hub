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


// ── Composer 底栏模型（T1 冷杉 v2）─────────────────────────────────────────
// 底栏三个「这条 prompt 怎么发」的决定：用什么模型、用多深的思考档、还剩多少预算。
// 全部是纯函数：渲染层只负责把结果画出来，判据在这里一处可测。

const COMPOSER_CTX_WARN_AT = 70;
const COMPOSER_CTX_DANGER_AT = 90;

// 上下文预算环。percent 是**已用**百分比（与 status-event 下发的 contextPct 同义），
// 与 card-session-status 的 ctx 读同一个字段，不另起一套算法。
function composerContextRing(session) {
  const raw = Number(session && session.contextPct);
  if (!Number.isFinite(raw)) {
    return { visible: false, percent: null, level: 'ok', title: '', ariaLabel: '' };
  }
  const percent = Math.max(0, Math.min(100, Math.round(raw)));
  const level = percent > COMPOSER_CTX_DANGER_AT
    ? 'danger'
    : (percent >= COMPOSER_CTX_WARN_AT ? 'warn' : 'ok');
  const parts = [`上下文已用 ${percent}%`];
  const used = Number(session && session.contextUsed);
  if (Number.isFinite(used) && used > 0) parts.push(`约 ${used.toLocaleString()} tokens`);
  const effective = Number(session && session.contextEffectiveMax);
  if (Number.isFinite(effective) && effective > 0) {
    parts.push(`运行时有效窗口 ${effective.toLocaleString()} tokens`);
  }
  const requested = Number(session && session.contextMax);
  if (Number.isFinite(requested) && requested > 0) {
    parts.push(`Hub 启动请求 ${requested.toLocaleString()} tokens`);
  }
  return {
    visible: true,
    percent,
    level,
    title: parts.join('，'),
    ariaLabel: `上下文预算已用 ${percent}%`,
  };
}

function composerModelChip(session) {
  const model = session && typeof session.currentModel === 'object' ? session.currentModel : null;
  const id = model ? String(model.id || '').trim() : '';
  const displayName = model ? String(model.displayName || '').trim() : '';
  // 徽章一直用 displayName 优先、id 兜底；chip 沿用同一口径，避免两处显示不同的名字。
  const label = displayName || id;
  const pending = session && session._modelSwitchPending
    ? String(session._modelSwitchPending.label || session._modelSwitchPending.id || '').trim()
    : '';
  return { visible: !!label, label, id, pending };
}

// 思考档 chip 只对**实测**支持该能力的 CLI 渲染。
//   - Codex 系：档位按模型走，由调用方读 ~/.codex/models_cache.json 后传进来
//     （core/codex-model-catalog.js 的 describeCodexModelTuning）。写死一份必然
//     给某些模型多出或少掉档位 —— gpt-5.6-sol 到 ultra，gpt-5.5 只到 xhigh。
//   - Claude 系：沿用现有 effort 字段，但 Hub 目前没有「会话内改档」的现成通路，
//     所以只显示不可点，不为了凑一个 ▾ 去新造一条写 PTY 的路径。
//   - DeepSeek 走的是 Codex 运行时但另一套模型目录，本轮按只读处理，不假装能改。
//   - Gemini / Kimi / PowerShell：没有这个概念，直接不渲染。
function composerThinkingChip(session, options = {}) {
  const kind = baseKind(session);
  const label = sessionEffortLabel(session);
  const hidden = { visible: false, label: '', interactive: false, options: [] };
  if (!label) return hidden;
  if (kind === 'codex') {
    const supported = Array.isArray(options.supportedEfforts)
      ? options.supportedEfforts.map(value => String(value || '').trim().toLowerCase()).filter(Boolean)
      : [];
    if (!supported.length) return hidden;
    return { visible: true, label, interactive: true, options: supported };
  }
  return { visible: true, label, interactive: false, options: [] };
}

function buildComposerRailModel(session, options = {}) {
  return {
    kind: baseKind(session),
    model: composerModelChip(session),
    thinking: composerThinkingChip(session, options),
    context: composerContextRing(session),
  };
}

module.exports = {
  COMPOSER_CTX_DANGER_AT,
  COMPOSER_CTX_WARN_AT,
  baseKind,
  buildComposerRailModel,
  buildSessionStatusSummary,
  composerContextRing,
  composerModelChip,
  composerThinkingChip,
  sessionContextLeft,
  sessionEffortLabel,
  sessionModelLabel,
  sessionSpeedLabel,
};
