'use strict';

const {
  RUNTIME_COMPLETED,
  RUNTIME_DORMANT,
  RUNTIME_FAILED,
  RUNTIME_RUNNING,
  RUNTIME_STARTING,
  RUNTIME_WAITING,
  getSessionRuntimeTruth,
} = require('./session-runtime-truth.js');
const { hasStreamDisconnectIssue } = require('./stream-disconnect.js');
const { sessionNeedsUserInput } = require('./session-attention-state.js');
// 问题摘要的截断规则复用问题导航条的那个纯函数，不另写一份。
// （它只导出函数，模块加载时不碰 DOM；本文件也只被渲染进程加载。）
const { normalizeQuestionSummary } = require('../renderer/card-question-navigator.js');

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

// 通用会话摘要。群聊的成员行要在一行里说清「谁 · 什么模型 · 什么档」，
// 那是它唯一能显示模型名的地方，所以这一份保留 model / cwd 不动。
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

// T2 冷杉 v2 · 舞台状态行专用。模型名归 composer 底栏的 chip，工作目录归头部面包屑，
// 这里只留「这一轮跑起来会怎样」的实时量：思考档、速度档、上下文余量。
// 刻意另起一份而不是把字段从上面那份删掉：群聊和舞台是两种读者，共用一个对象
// 只会让下一次改动在两种读者之间赌一把 —— 舞台要瘦，群聊那一行反而必须带模型名。
function buildStageStatusSummary(session) {
  const effort = sessionEffortLabel(session);
  const speed = sessionSpeedLabel(session);
  const contextLeft = sessionContextLeft(session);
  const compact = [effort, speed].filter(Boolean).join(' · ');
  return {
    kind: baseKind(session),
    effort,
    speed,
    contextLeft,
    contextText: contextLeft == null ? '' : `Context ${contextLeft}% left`,
    compact,
    ariaLabel: [compact, contextLeft == null ? '' : `上下文剩余 ${contextLeft}%`]
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

// ── Composer 状态行（T1 冷杉 v2）──────────────────────────────────────────
// 舞台头部的状态徽章和 composer 状态行说的是同一件事，所以 runtime 结论由渲染层
// 用 deriveSessionRuntimeStatus 算**一次**再传进来，这里只负责把它折成四档展示态。
// 复制一份判据 = 两个地方迟早说出互相矛盾的话，这里刻意不那么做。

const COMPOSER_STATUS_READY = 'ready';
const COMPOSER_STATUS_WORKING = 'working';
const COMPOSER_STATUS_WAITING = 'waiting';
const COMPOSER_STATUS_DEAD = 'dead';

// 状态行要的是「38s」这种口语时长，不是头部徽章的 mm:ss 计时器。
function formatRuntimeSeconds(value) {
  const totalSeconds = Math.max(0, Math.floor((Number(value) || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

// CLI 把选项摆成编号行时（「1. 是，继续 / 2. 先看 diff」）解析成快捷答复。
// 解析不出来就返回空数组 —— 宁可不给 chip，也不要造一个用户点了会答错的按钮。
// 只有一条候选不算选择题，同样不渲染。
function parseQuickReplyOptions(text, { max = 4, maxLength = 18 } = {}) {
  const seen = new Set();
  const options = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const match = rawLine.match(/^\s*(?:[>›❯▶*-]\s*)?(\d{1,2})\s*[.)、．]\s*(.+?)\s*$/);
    if (!match) continue;
    const label = String(match[2])
      .replace(/\s*\(default\)\s*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!label || label.length > maxLength) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(label);
    if (options.length >= max) break;
  }
  return options.length >= 2 ? options : [];
}

// 把编号选项行从问题正文里摘掉，剩下的才是「AI 到底在问什么」。
function stripQuickReplyLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter(line => !/^\s*(?:[>›❯▶*-]\s*)?\d{1,2}\s*[.)、．]\s+\S/.test(line))
    .join('\n')
    .trim();
}

function composerStateFor(runtimeState, { needsRespond = false, disconnected = false } = {}) {
  // 断开优先于一切：休眠会话上残留的 waitingText 不该冒充「在等你回答」，
  // 那会让用户对着一个收不到消息的会话打字。
  if (disconnected || runtimeState === RUNTIME_DORMANT || runtimeState === RUNTIME_FAILED) {
    return COMPOSER_STATUS_DEAD;
  }
  if (needsRespond || runtimeState === RUNTIME_WAITING) return COMPOSER_STATUS_WAITING;
  if (runtimeState === RUNTIME_STARTING || runtimeState === RUNTIME_RUNNING) return COMPOSER_STATUS_WORKING;
  return COMPOSER_STATUS_READY;
}

function composerRunStartedAt(session, truth) {
  return Number(truth && truth.startedAt)
    || Number(session && session.runStartedAt)
    || Number(session && session.cardWorkingSince)
    || 0;
}

/**
 * Composer 状态行的展示模型。纯函数：同样的输入永远给同样的结果。
 *
 * @param {object} session
 * @param {object} options
 * @param {object} options.runtime  渲染层 deriveSessionRuntimeStatus 的结果（必填，
 *   保证 composer 和舞台头部读的是同一个结论）。
 * @param {{waiting:boolean, reason?:string, text?:string}|null} options.liveQuestion
 *   现有问题检测（terminal-activity-monitor 的 isWaitingForUser）在当前终端画面上的结果。
 *   会话级的 attention 信号目前只有 Claude 会点亮，Codex 那条路径不调用它，
 *   所以 composer 额外接受一份**当前画面**的检测结果作为补充证据。
 * @returns {{ state, text, detail, quickReplies, action, canStop, runtime }}
 */
function buildComposerStatusModel(session, options = {}) {
  const native = require('./codex-native-runtime.js').isNativeSession(session);
  const now = Number(options.now) || Date.now();
  const runtime = options.runtime;
  if (!runtime || typeof runtime !== 'object') {
    throw new Error('buildComposerStatusModel requires the derived runtime status');
  }
  const truth = getSessionRuntimeTruth(session, { now });
  if (session?.runtimeBackend === 'claude-stream-json') {
    const snapshot = session.nativeRuntime || {};
    const labels = { unknown: '本条提交待核对', starting: 'Claude 已收到，等待执行',
      waiting: 'Claude 在等你回答', failed: '本轮执行失败', interrupted: '已停止' };
    if (labels[snapshot.state]) {
      // Same entry point Codex offers when its native state needs checking:
      // one button that reconciles the engine record without resending.
      const needsReconcile = snapshot.state === 'unknown' || snapshot.connection === 'disconnected';
      return { state: snapshot.state === 'starting' ? COMPOSER_STATUS_WORKING
        : snapshot.state === 'interrupted' ? COMPOSER_STATUS_READY
          : snapshot.state === 'failed' ? COMPOSER_STATUS_DEAD : COMPOSER_STATUS_WAITING,
        text: labels[snapshot.state], detail: snapshot.reason || '', quickReplies: [],
        action: needsReconcile ? { kind: 'reconnect', label: '核对连接' } : null,
        canStop: snapshot.connection === 'connected' && ['starting', 'waiting'].includes(snapshot.state), runtime };
    }
  }
  const liveQuestion = !native && session?.runtimeBackend !== 'claude-stream-json' && options.liveQuestion && options.liveQuestion.waiting
    ? options.liveQuestion
    : null;
  // 「等你响应」的判据与 respond-pill 完全一致（sessionNeedsUserInput），
  // 区别只在 pill 会跳过当前会话 —— composer 说的就是当前会话，所以不跳过。
  // liveQuestion 是同一件事的第二个证据来源，两者取或。
  const needsRespond = sessionNeedsUserInput(session) || !!liveQuestion;
  const disconnected = native ? truth.state === 'unknown' || truth.connection === 'disconnected' : hasStreamDisconnectIssue(session);
  const state = native && truth.state === 'failed' && !disconnected
    ? COMPOSER_STATUS_READY : composerStateFor(runtime.state, { needsRespond, disconnected });
  const provider = runtime.provider || 'AI';

  if (state === COMPOSER_STATUS_WORKING) {
    if (truth.cancellation?.status === 'pending') return {
      state, text:`${provider} 正在停止`, detail:truth.evidence || '',
      quickReplies:[], action:null, canStop:false, runtime,
    };
    const startedAt = composerRunStartedAt(session, truth);
    const elapsed = startedAt > 0 && now >= startedAt ? formatRuntimeSeconds(now - startedAt) : '';
    return {
      state,
      text: elapsed ? `${provider} 正在工作 · ${elapsed}` : `${provider} 正在工作`,
      detail: runtime.visibleDetail || '',
      quickReplies: [],
      action: null,
      canStop: true,
      runtime,
    };
  }

  if (state === COMPOSER_STATUS_WAITING) {
    const raw = String(
      (native ? truth.evidence : (session && session.waitingText) || (liveQuestion && liveQuestion.text)) || runtime.detail || '',
    ).trim();
    const quickReplies = native ? [] : parseQuickReplyOptions(liveQuestion ? liveQuestion.screen || raw : raw);
    // 选项行属于「快捷答复」那一行，不该再挤进问题摘要里念一遍。
    const question = quickReplies.length ? stripQuickReplyLines(raw) : raw;
    const summary = question ? normalizeQuestionSummary(question, 48) : '';
    return {
      state,
      text: summary ? `${provider} 在等你回答：「${summary}」` : `${provider} 在等你回答`,
      detail: '',
      quickReplies,
      action: null,
      canStop: native,
      runtime,
    };
  }

  if (state === COMPOSER_STATUS_DEAD) {
    if (native && runtime.state !== RUNTIME_DORMANT) return {
      state, text: truth.state === 'unknown' ? `${provider} 状态待核对` : `${provider} 连接已断开`,
      detail: truth.evidence || '', quickReplies: [], canStop: false, runtime,
      action: ['codex-app-server','acp','claude-stream-json'].includes(session.runtimeBackend) ? { kind:'reconnect', label:'核对连接' } : null,
    };
    const issue = session && session.connectionIssue;
    const lost = session && session._processLost;
    const reason = String(
      // CLI 进程真的没了是最具体的一条事实，优先念它；否则会被
      // 笼统的“会话已休眠”盖掉，用户分不清是自己收的还是崩的。
      (lost && lost.reason)
      || (disconnected && issue && (issue.reason || issue.detail))
      // 休眠不是故障，它的 detail 是一句操作提示（「点击会话可恢复原生 CLI」），
      // 拿来当断开原因念出来是答非所问。
      || (runtime.state === RUNTIME_DORMANT ? '会话已休眠' : '')
      || runtime.detail
      || (session && (session.lastError || session.error || session.spawnError))
      || '',
    ).replace(/\s+/g, ' ').trim().slice(0, 60);
    return {
      state,
      text: reason
        ? `会话已断开（${reason}）· 重连后可继续`
        : '会话已断开 · 重连后可继续',
      detail: '',
      quickReplies: [],
      action: { kind: 'reconnect', label: '重连' },
      canStop: false,
      runtime,
    };
  }

  // 就绪：runtime.meta 在 COMPLETED 下就是 formatCompletionAge 的结果（「2 分钟前」）。
  const age = runtime.state === RUNTIME_COMPLETED ? String(runtime.meta || '').trim() : '';
  return {
    state: COMPOSER_STATUS_READY,
    text: native && truth.state === 'interrupted' ? '上一轮已中断 · 可继续发送'
      : native && truth.state === 'failed' ? '上一轮执行失败 · 可继续发送'
      : age ? `已就绪 · ${age}完成上一轮` : '已就绪',
    detail: native && truth.state === 'failed' ? truth.evidence || '' : '',
    quickReplies: [],
    action: age ? { kind: 'scroll-latest', label: '查看上一轮 ↑' } : null,
    canStop: false,
    runtime,
  };
}

module.exports = {
  COMPOSER_CTX_DANGER_AT,
  COMPOSER_CTX_WARN_AT,
  COMPOSER_STATUS_DEAD,
  COMPOSER_STATUS_READY,
  COMPOSER_STATUS_WAITING,
  COMPOSER_STATUS_WORKING,
  baseKind,
  buildComposerRailModel,
  buildComposerStatusModel,
  buildSessionStatusSummary,
  buildStageStatusSummary,
  composerContextRing,
  composerModelChip,
  composerStateFor,
  composerThinkingChip,
  formatRuntimeSeconds,
  parseQuickReplyOptions,
  sessionContextLeft,
  sessionEffortLabel,
  sessionModelLabel,
  sessionSpeedLabel,
};
