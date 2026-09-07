'use strict';

const fs = require('fs');
const path = require('path');
const { KIND_LABELS } = require('./ai-kinds.js');
const {
  ATTEMPT_ABSENT,
  ATTEMPT_ACCEPTED,
  ATTEMPT_AWAITING_BINDING,
  ATTEMPT_COMPLETED,
  ATTEMPT_FAILED,
  ATTEMPT_INTERRUPTED,
  ATTEMPT_PREPARED,
  ATTEMPT_RECOVERING,
  ATTEMPT_RUNNING,
  ATTEMPT_SUBMITTING,
  ATTEMPT_SUPERSEDED,
  createAttemptId,
  createRunId,
  isTerminalAttemptStatus,
  promptFingerprint,
  attemptEventMatches,
} = require('./groupchat-attempt-protocol.js');
const devWorkbenchFeed = require('./dev-workbench-feed');

// 过程汇报（recordProgressUpdate 写入的 `UPDATE: …`）也是一条 assistant 消息，
//   role / turnNum / sid 与正式答复完全一样，而且落盘更早。凡是按「本轮 + 本席位」
//   找答复的地方都必须先把它排掉，否则它会顶替正式答复：跑空时被当成答案存档，
//   有答复时被就地改写、丢掉 a{n}-{memberId} 身份。
const PROGRESS_UPDATE_STATUS = 'progress_update';
// 同一轮同一席位最多留这么多条过程汇报；再多就原地改写最后一条。
const MAX_PROGRESS_UPDATES_PER_STEP = 40;
const isProgressUpdateMessage = message => !!message && message.status === PROGRESS_UPDATE_STATUS;

// 投研场景反空话禁用词：命中即要求重写为有数字/来源的判断。
const BANNED_PHRASES = ['基本面良好', '前景广阔', '值得关注', '拭目以待', '综合来看值得', '具有投资价值'];

const STATE_VERSION = 4;
const MAX_ATTEMPT_HISTORY = 300;
const MAX_ATTEMPT_EVENTS = 500;
const TRANSIENT_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const ATOMIC_RENAME_RETRIES = 80;
const ATOMIC_RENAME_DELAY_MS = 15;
const _renameSleepCell = new Int32Array(new SharedArrayBuffer(4));

function atomicWriteUtf8(filePath, text) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(tmp, filePath);
        break;
      } catch (error) {
        if (!error || !TRANSIENT_RENAME_CODES.has(error.code) || attempt >= ATOMIC_RENAME_RETRIES) throw error;
        Atomics.wait(_renameSleepCell, 0, 0, ATOMIC_RENAME_DELAY_MS);
      }
    }
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
}

function arenaPromptsDir(hubDataDir) {
  return path.join(hubDataDir, 'arena-prompts');
}

function groupChatStatePath(hubDataDir, meetingId) {
  return path.join(arenaPromptsDir(hubDataDir), `${meetingId}-groupchat.json`);
}

function cleanup(hubDataDir, meetingId) {
  const fp = groupChatStatePath(hubDataDir, meetingId);
  try {
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch {}
}

function rawMessageAnchor(meetingId, messageId) {
  return `raw://group/${meetingId}/msg/${messageId}`;
}

function _clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * 把一次派发的身份收成可存档的最小形状：谁、第几步、第几次尝试、属于哪个 run。
 * 没有 stepIndex 就不算一次「有身份的派发」（普通群聊发言就是这种），返回空对象，
 * 消息形状与老版本逐字一致 —— 老状态文件、老渲染路径都不受影响。
 */
function normalizeDispatchMeta(dispatch) {
  if (!dispatch || typeof dispatch !== 'object') return {};
  const stepIndex = Number(dispatch.stepIndex);
  if (!Number.isInteger(stepIndex) || stepIndex < 0) return {};
  const labels = (Array.isArray(dispatch.toLabels) ? dispatch.toLabels : [])
    .map(x => String(x || '').trim()).filter(Boolean).slice(0, 8);
  const memberIds = (Array.isArray(dispatch.toMemberIds) ? dispatch.toMemberIds : [])
    .map(x => String(x || '').trim()).filter(Boolean).slice(0, 8);
  return {
    dispatch: {
      kind: String(dispatch.kind || 'workflow'),
      stepIndex,
      attempt: Number(dispatch.attempt) > 0 ? Number(dispatch.attempt) : 1,
      runId: dispatch.runId ? String(dispatch.runId) : null,
      role: dispatch.role ? String(dispatch.role) : '',
    },
    toMemberIds: memberIds,
    toLabels: labels,
  };
}

function _memberLabel(member) {
  if (!member) return 'AI';
  return member.displayName || member.alias || KIND_LABELS[member.kind] || member.kind || member.memberId || 'AI';
}

const RESEARCH_SCENE_PROMPT = [
  '## 投研场景',
  '优先补充他人未覆盖的角度、证据缺口或反例。在评价已知材料的基础上，尽量挖掘新线索、变量或解释路径，为讨论带回新信息、方向。涉及股票、板块、消息和近期行情时，尽量查证；事实和数字标来源，未查证就说明不确定。不要只顺着已有倾向，主动指出风险或证伪信号。若信息不足或判断分叉，先问用户 1-2 个会改变结论的问题。',
  '涉及具体 A 股、板块或买卖时机时，优先主动调用已注入的 stock_market(symbol)、stock_news(symbol)，stock_static(symbol) 仅在单只核心标的需要估值/基本面画像时再补。不要在同一轮对多只股票批量发 static+market；多股对比先 news 或至多 1-3 个 market，避免 MCP 客户端 120s 工具超时。',
  '涉及用户当前持仓、个股/板块旧记录、投资理念或交易纪律时，先调用 chuxin_context(topic) 读取初心个人上下文；它是用户历史记录，不是实时事实，当前价格、公告、财报和消息仍需用 stock_* 核验。',
  '只有问题涉及过去的加减仓、历史成本或曾经持有时才调用 chuxin_portfolio_history；只在用户明确说“记入初心/保存到初心/归档到初心”时调用 chuxin_inbox_add，并压缩成一条研究胶囊，禁止自动保存普通对话。',
  '用户写“@英灵”、点名巴菲特/利弗莫尔镜头或要求英灵对抗时：先用 stock_* 补齐与该镜头有关的证据，再调用 spirit_prepare 生成统一 Lens Packet；所有席位按同一 rule_id 与 manifest_hash 发言。英灵只是有边界的方法论，禁止自称历史人物本人，也不得把英灵建议当成交易执行。',
  '只引用工具返回中能改变判断的关键字段；工具不可用或数据缺失时明确说未查到，不要凭记忆补数字。',
  'stock_static 返回的估值/基本面字段带 `confidence` 标签（HIGH/MEDIUM/LOW/CONFLICT/UNAVAILABLE，详细措辞规则见该工具 description），引用前先看 `_meta.warnings` 扫一眼非 HIGH 字段；CONFLICT/UNAVAILABLE 时 value=null，禁止编数值或填默认值。',
  `反空话铁律：结论必须落到具体数字或可查事实上，禁用空话套话（${BANNED_PHRASES.join('、')} 等同类表述）——出现即视为无效结论，请用带数字/来源的判断重写。`,
].join('\n');

// 右侧交易战法纪律（投委会「纪律底色」，常驻 research 场景）。与「流程档位」解耦：
// 纪律永远在（自由聊也带），五幕固定流程只在 committee-conductor 投委会档激活。
// 内容 = 用户锁定的追涨/低吸右侧画像表（preference_invest_chase_vs_dip）。
const COMMITTEE_DISCIPLINE = [
  '## 右侧交易战法纪律（底色）',
  '本群偏中短线**右侧交易**。评估个股先归位是「追涨」还是「低吸」——两者**都是右侧、都在上升趋势**，差异只在阶段，不是方向：',
  '- 共同底座（缺一即降级）：右侧上升趋势 · 板块龙头/认同度高 · 题材正宗够硬 · 基本面硬 · 关键趋势线不破。',
  '- **追涨**（主升进行中）：5/10 日线强趋势、空中加油、接力强势龙；主升浪里跟随。',
  '- **低吸**（回调赌第二波）：强势股大涨后回调 15–30%、重新站上 20 日线、缩量企稳、有催化预期。**这是右侧回调再进场，不是左侧抄底/价值反弹**。',
  '否决线（命中即降级到观察/风险隔离，不进买入）：趋势破位 · 题材不正宗(蹭概念/相关营收占比极低) · 量价背离 · 高位假强势 · 基本面证伪。',
  '每条信息都想一层：它对「追涨」更有价值，还是对「低吸」更有价值？给出倾向。选股看：睡得着 · 预期差 · 催化剂 · 资金利用效率。**宁可错过，不可做错**。',
].join('\n');

// 2026-06-05 联邦记忆下线：原 MEMORY_DISCIPLINE_PROMPT 教各家 AI 写 memory 的指令段已删除。
// 记忆维护完全交给 Claude/Codex 各自原生 auto-memory 能力，群聊 prompt 不再越俎代庖。

// 产物落点：跟着 workspace 走，不再写死 home 下的公共 artifacts 目录。
// 旧写法 `C:\Users\lintian\artifacts\` 是 workspace 重构之前的遗留，结果是
// 三家 AI 都老老实实把报告写回用户最想摆脱的 home 目录 —— 规则层没跟上目录层
// 的重构，AI 就会照旧规则执行（2026-07-28）。
function artifactsInstruction(workspace) {
  const dir = workspace && String(workspace).trim()
    ? `${String(workspace).replace(/[\\/]+$/, '')}\\artifacts\\`
    : '当前工作目录下的 artifacts\\';
  return `简单问题直答；复杂分析 / 多方案 / 含表格 / 预计 > 300 字 -> HTML 三段式`
    + `（先口头大纲 -> 写 ${dir}{msgId}-{name}.html -> 贴绝对路径+3-8 条摘要卡片）。`;
}

function buildSystemPromptText(displayName, scene, opts = {}) {
  const name = displayName || 'AI';
  const parts = [
    '## 规则',
    `- 这里是AI群聊，你是${name}。可赞同、反对、追问、反问用户及其他群聊队友或另起话题。`,
    '- 独到见解 > 全面但泛泛而谈。',
    '',
    '## 输出',
    artifactsInstruction(opts.workspace),
  ];
  if (scene === 'research') {
    parts.push('', RESEARCH_SCENE_PROMPT, '', COMMITTEE_DISCIPLINE);
  }
  return parts.join('\n');
}

class GroupChatOrchestrator {
  constructor(hubDataDir, meetingId) {
    this.hubDataDir = hubDataDir;
    this.meetingId = meetingId;
    this.state = {
      schemaVersion: STATE_VERSION,
      meetingId,
      currentTurn: 0,
      currentMode: 'idle',
      revision: 0,
      activeRun: null,
      messages: [],
      nextMessageSeq: 1,
      lastDeliveredIdx: {},
      lastDeliveredSeq: {},
      memberIdsBySid: {},
      attempts: {},
      attemptEvents: [],
      // Exact prompts prepared for the current in-flight turn.  Keeping this
      // durable makes a post-crash/manual resend faithful to the original
      // system+delta+hero prompt instead of degrading to the raw user line.
      pendingPrompts: {},
      turns: [],
      aiStats: {},
    };
    this._activePrompts = {};
    this._loadState();
  }

  _stateFilePath() {
    return groupChatStatePath(this.hubDataDir, this.meetingId);
  }

  _loadState() {
    const fp = this._stateFilePath();
    if (!fs.existsSync(fp)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      if (raw && raw.meetingId === this.meetingId) {
        const { summarySegments, ...rest } = raw;
        this.state = {
          schemaVersion: STATE_VERSION,
          currentMode: 'idle',
          turns: [],
          aiStats: {},
          ...rest,
          schemaVersion: STATE_VERSION,
          meetingId: this.meetingId,
          messages: Array.isArray(raw.messages) ? raw.messages : [],
          lastDeliveredIdx: raw.lastDeliveredIdx && typeof raw.lastDeliveredIdx === 'object' ? raw.lastDeliveredIdx : {},
          lastDeliveredSeq: raw.lastDeliveredSeq && typeof raw.lastDeliveredSeq === 'object' ? raw.lastDeliveredSeq : {},
          memberIdsBySid: raw.memberIdsBySid && typeof raw.memberIdsBySid === 'object' ? raw.memberIdsBySid : {},
          attempts: raw.attempts && typeof raw.attempts === 'object' ? raw.attempts : {},
          attemptEvents: Array.isArray(raw.attemptEvents) ? raw.attemptEvents.slice(-MAX_ATTEMPT_EVENTS) : [],
          revision: Math.max(0, Number(raw.revision) || 0),
          activeRun: raw.activeRun && typeof raw.activeRun === 'object' ? raw.activeRun : null,
          pendingPrompts: raw.pendingPrompts && typeof raw.pendingPrompts === 'object' ? raw.pendingPrompts : {},
        };
        let nextMessageSeq = 1;
        for (const message of this.state.messages) {
          if (!message || typeof message !== 'object') continue;
          if (!Number.isInteger(message.seq) || message.seq <= 0) message.seq = nextMessageSeq;
          nextMessageSeq = Math.max(nextMessageSeq, message.seq + 1);
        }
        this.state.nextMessageSeq = Math.max(nextMessageSeq, Number(raw.nextMessageSeq) || 1);
        // Stable delivery cursors survive message array insertion/removal.
        for (const [sid, indexValue] of Object.entries(this.state.lastDeliveredIdx || {})) {
          if (Number.isInteger(this.state.lastDeliveredSeq[sid])) continue;
          const message = this.state.messages[Number(indexValue)];
          this.state.lastDeliveredSeq[sid] = message && Number.isInteger(message.seq) ? message.seq : 0;
        }
        // 2026-07-20 道雪 [修#9]：崩溃/重启后的悬空轮标记——用户消息所在轮没有任何
        //   turn 记录时，给该消息打"已被重启打断"标记（此前问题孤悬、无任何提示）。
        const turnNums = new Set((this.state.turns || []).map(t => t && t.n));
        let touched = this.state.schemaVersion !== Number(raw.schemaVersion)
          || !raw.lastDeliveredSeq || !raw.memberIdsBySid || !raw.attempts;
        let hasInterruptedTurn = false;
        for (const m of this.state.messages) {
          if (m && m.role === 'user' && Number(m.turnNum) > 0 && !turnNums.has(Number(m.turnNum))) {
            hasInterruptedTurn = true;
            if (!m.interruptedNote) {
              m.interruptedNote = true;
              touched = true;
            }
          }
        }
        // 进程重启后不存在任何活跃 watcher。旧状态若仍是 group，renderer 会永久渲染
        // 全员“思考中”；把悬空轮明确收回 idle，同时保留用户消息和已抢救的 AI 结果。
        if (hasInterruptedTurn && this.state.currentMode !== 'idle') {
          this.state.currentMode = 'idle';
          touched = true;
        }
        // A fresh Hub process has no live watcher. Keep exact receipts in a
        // recoverable state; the dispatcher will reconcile them against the
        // provider transcript after sessions are restored.
        for (const attempt of Object.values(this.state.attempts || {})) {
          if (!attempt || isTerminalAttemptStatus(attempt.status)) continue;
          attempt.status = ATTEMPT_RECOVERING;
          attempt.recoveryReason = 'hub_restart';
          attempt.updatedAt = Date.now();
          touched = true;
        }
        if (this.state.activeRun && !isTerminalAttemptStatus(this.state.activeRun.status)) {
          this.state.activeRun.status = ATTEMPT_RECOVERING;
          this.state.activeRun.updatedAt = Date.now();
          touched = true;
        }
        if (touched) this._saveState('state_migrated', { fromSchemaVersion: Number(raw.schemaVersion) || 0 });
      }
    } catch (e) {
      console.warn(`[groupchat] load state failed for ${this.meetingId}:`, e.message);
    }
  }

  _appendAttemptEvent(type, details = {}) {
    if (!type) return;
    const safe = {};
    for (const key of ['attemptId', 'runId', 'turnNum', 'sid', 'memberId', 'status', 'source', 'reason', 'providerTurnId']) {
      if (details[key] != null && details[key] !== '') safe[key] = details[key];
    }
    if (!safe.reason && details.lastRejectedReason) safe.reason = details.lastRejectedReason;
    if (details.failure && typeof details.failure === 'object') {
      safe.failure = {
        code: details.failure.code || 'provider_error',
        category: details.failure.category || 'provider',
        retryable: details.failure.retryable === true,
        autoRetry: details.failure.autoRetry === true,
        action: details.failure.action || null,
      };
    }
    this.state.attemptEvents = Array.isArray(this.state.attemptEvents) ? this.state.attemptEvents : [];
    this.state.attemptEvents.push({ revision: this.state.revision, type: String(type), at: Date.now(), ...safe });
    if (this.state.attemptEvents.length > MAX_ATTEMPT_EVENTS) {
      this.state.attemptEvents = this.state.attemptEvents.slice(-MAX_ATTEMPT_EVENTS);
    }
  }

  _bumpRevision(eventType = null, details = {}) {
    this.state.revision = Math.max(0, Number(this.state.revision) || 0) + 1;
    if (eventType) this._appendAttemptEvent(eventType, details);
    return this.state.revision;
  }

  _pruneAttemptHistory() {
    const attempts = this.state.attempts && typeof this.state.attempts === 'object' ? this.state.attempts : {};
    const rows = Object.values(attempts).filter(Boolean);
    if (rows.length <= MAX_ATTEMPT_HISTORY) return;
    rows.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    const keep = new Set(rows.slice(0, MAX_ATTEMPT_HISTORY).map(row => row.attemptId));
    for (const [attemptId, attempt] of Object.entries(attempts)) {
      if (!keep.has(attemptId) && attempt && isTerminalAttemptStatus(attempt.status)) delete attempts[attemptId];
    }
  }

  _saveState(eventType = null, details = {}) {
    this._bumpRevision(eventType, details);
    this._pruneAttemptHistory();
    const fp = this._stateFilePath();
    // This is a projection of already-authored messages, never a new AI request.
    // Keep it in the same durable write as the source before announcing it.
    const summary = devWorkbenchFeed.summarizeGroupState(this.state);
    this.state.devWorkbench = summary;
    atomicWriteUtf8(fp, JSON.stringify(this.state, null, 2));
    devWorkbenchFeed.publishSaved(this.hubDataDir, this.meetingId, summary);
    return this.state.revision;
  }

  // Renderer events may need a strictly increasing revision without forcing a
  // disk write for every 1.5s streaming heartbeat. The next durable save
  // persists the in-memory counter; a process restart also restarts Renderer.
  reserveRevision(eventType = null, details = {}) {
    return this._bumpRevision(eventType, details);
  }

  ensureMemberIdentity(sid, suggestedMemberId = null, details = {}) {
    const key = String(sid || '');
    if (!key) return null;
    if (!this.state.memberIdsBySid || typeof this.state.memberIdsBySid !== 'object') this.state.memberIdsBySid = {};
    if (this.state.memberIdsBySid[key]) return this.state.memberIdsBySid[key];
    const used = new Set(Object.values(this.state.memberIdsBySid).map(String));
    let memberId = String(suggestedMemberId || '').trim();
    if (!memberId || used.has(memberId)) {
      let next = 1;
      while (used.has(`m${next}`)) next += 1;
      memberId = `m${next}`;
    }
    this.state.memberIdsBySid[key] = memberId;
    this._saveState('member_identity_created', { sid: key, memberId, source: details.source || 'orchestrator' });
    return memberId;
  }

  getAttempt(attemptId) {
    const attempt = this.state.attempts && this.state.attempts[String(attemptId || '')];
    return attempt ? _clone(attempt) : null;
  }

  listRecoverableAttempts(filter = {}) {
    return Object.values(this.state.attempts || {})
      .filter(attempt => attempt && !isTerminalAttemptStatus(attempt.status))
      .filter(attempt => filter.recoveryOnly !== true || attempt.recoveryReason === 'hub_restart')
      .filter(attempt => !filter.sid || attempt.sid === filter.sid)
      .filter(attempt => !filter.runId || attempt.runId === filter.runId)
      .map(_clone);
  }

  updateAttempt(attemptId, patch = {}, eventType = 'attempt_updated', options = {}) {
    const key = String(attemptId || '');
    const attempt = this.state.attempts && this.state.attempts[key];
    if (!attempt) return null;
    if (isTerminalAttemptStatus(attempt.status) && patch.status && patch.status !== attempt.status
        && options.allowTerminalPatch !== true) return _clone(attempt);
    const next = { ...patch };
    delete next.prompt;
    delete next.promptText;
    Object.assign(attempt, next, { updatedAt: Number(patch.updatedAt) || Date.now() });
    if (patch.providerTurnId) attempt.providerTurnId = String(patch.providerTurnId);
    if (patch.failure && typeof patch.failure === 'object') attempt.failure = _clone(patch.failure);
    const details = { ...attempt, failure: attempt.failure };
    if (options.persist === false) this._bumpRevision(eventType, details);
    else this._saveState(eventType, details);
    return _clone(attempt);
  }

  settleAttempt(attemptId, result = {}, options = {}) {
    const statusMap = {
      completed: ATTEMPT_COMPLETED,
      manual_extracted: ATTEMPT_COMPLETED,
      errored: ATTEMPT_FAILED,
      failed: ATTEMPT_FAILED,
      interrupted: ATTEMPT_INTERRUPTED,
      superseded: ATTEMPT_SUPERSEDED,
      absent: ATTEMPT_ABSENT,
    };
    return this.updateAttempt(attemptId, {
      status: statusMap[result.status] || result.status || ATTEMPT_FAILED,
      completedAt: Number(result.completedAt) || Date.now(),
      signalSource: result.signalSource || null,
      providerTurnId: result.providerTurnId || null,
      finality: result.finality || null,
      resultTextLength: String(result.text || '').length,
      reason: result.reason || null,
      failure: result.failure || null,
    }, 'attempt_settled', options);
  }

  completeInternalRun(runId, results = []) {
    for (const result of results) {
      if (result && result.attemptId) this.settleAttempt(result.attemptId, result, { persist: false });
    }
    const pending = this.state.pendingPrompts && this.state.pendingPrompts['0'];
    if (pending) {
      for (const [sid, entry] of Object.entries(pending)) {
        if (!runId || (entry && entry.runId === runId)) delete pending[sid];
      }
      if (Object.keys(pending).length === 0) delete this.state.pendingPrompts['0'];
    }
    this._saveState('internal_run_completed', { runId, turnNum: 0, status: ATTEMPT_COMPLETED });
  }

  getState() {
    return _clone(this.state);
  }

  // Informational, source-authored progress. Never touches turn results,
  // completion receipts or workflow gates. Fence against old/dormant sessions.
  recordProgressUpdate(sid, text, at, speaker, event = {}) {
    const turnNum = Number(this.state.currentTurn) || 0;
    const pending = this.state.pendingPrompts?.[String(turnNum)]?.[sid];
    const user = this.state.messages.find(message => message && message.id === `u${turnNum}`);
    if (!pending || !turnNum || !text || !Number.isFinite(at) || (user && at < user.createdAt)) return false;
    const attempt = pending.attemptId && this.state.attempts?.[pending.attemptId];
    if (pending.runId && this.state.activeRun?.runId && pending.runId !== this.state.activeRun.runId) return false;
    if (pending.attemptId && (!attempt || isTerminalAttemptStatus(attempt.status))) return false;
    if (attempt && (at < Math.max(attempt.dispatchAt || 0, attempt.acceptedAt || 0, attempt.startedAt || 0)
        || !attemptEventMatches(attempt, { ...event, sid, observedAt: at }).ok)) return false;
    // 过程汇报是**追加**，不是覆盖。
    // 老写法每轮每席位只留一条、新的原地改写旧的：agent 中途写了五次进展，
    // 维护者在群里只看得到最后一次 —— 整个过程等于没记。工作台要的「当前一句」
    // 由读取端取最新一条来满足，那是投影问题，不该靠丢历史来实现。
    const base = `p${turnNum}-${sid}` + (pending.attemptId ? `-${pending.attemptId}` : '');
    const mine = this.state.messages.filter(message => isProgressUpdateMessage(message)
      && (message.id === base || String(message.id || '').startsWith(base + '.')));
    const previous = mine[mine.length - 1];
    // 实时通道现在也送 PLAN / ASK，不再只有 UPDATE。标签由采集端给，认不出就退回 UPDATE。
    const requested = String(event.tag || '').toUpperCase();
    const tag = devWorkbenchFeed.LIVE_TAGS.includes(requested) ? requested : 'UPDATE';
    const content = tag + ': ' + text;
    // 去重要分清两件事，只看正文会把它们混成一件：
    //   ① **事件重放**——同一条 transcript 记录被重新读到（尾随重连、一条消息里
    //      PLAN 和 UPDATE 各发一次事件后整行重读）。它的来源时刻和已落盘的那条一样。
    //   ② **同文新消息**——agent 真的又说了一遍同样的话：跑测试 → 有一条红在修 →
    //      再跑一遍。第三条是真进展，丢了工作台就停在「在修」不动。
    // 判据因此是「正文相同**且**来源时刻相同」，不是「正文相同」。
    // 上一版只比正文，把 ② 也当成重放拒收了（合并位实测复现）。
    const sourceAt = message => Number(message.createdAt) === at || Number(message.updatedAt) === at;
    if (mine.some(message => message.content === content && sourceAt(message))) return false;
    // 连着重复的同一句仍然只留一条：没有时间戳的来源（回落到 Date.now()）靠这条兜底。
    if (previous && previous.content === content) return false;
    if (previous && at < previous.updatedAt) return false;
    // 上限只防失控、不防话多：到顶之后退回原地改写最后一条，
    // 这份 state 每次都要整份落盘，不能让一个刷屏的席位把它撑爆。
    if (previous && mine.length >= MAX_PROGRESS_UPDATES_PER_STEP) Object.assign(previous, { content, updatedAt: at });
    else this._appendMessage({ id: mine.length ? `${base}.${mine.length + 1}` : base,
      role: 'assistant', sid, speaker, turnNum, content,
      runId: pending.runId || null, attemptId: pending.attemptId || null, memberId: pending.memberId || null,
      providerTurnId: attempt?.providerTurnId || event.turnId || null,
      status: PROGRESS_UPDATE_STATUS, createdAt: at, updatedAt: at });
    this._saveState('progress_reported', { runId: pending.runId, attemptId: pending.attemptId, sid, turnNum });
    return true;
  }

  beginTurn(userInput, opts = {}) {
    const requestedTurnNum = Number(opts.turnNum);
    const n = Number.isInteger(requestedTurnNum) && requestedTurnNum > 0
      ? requestedTurnNum
      : (this.state.currentTurn || 0) + 1;
    const appendUserMessage = opts.appendUserMessage !== false;
    const runId = String(opts.runId || createRunId(this.meetingId, n));
    this.state.currentTurn = Math.max(this.state.currentTurn || 0, n);
    this.state.currentMode = 'group';
    this.state.activeRun = {
      runId,
      turnNum: n,
      status: ATTEMPT_PREPARED,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      dispatchMode: opts.dispatchMode || 'group',
    };
    let msg = this.state.messages.find(m => m.id === `u${n}` && m.role === 'user') || null;
    let didAppendUserMessage = false;
    if (appendUserMessage && !msg) {
      // clientMessageId：渲染层那条本地 pending 气泡的身份。带上它，前端才能确认
      // 「服务端接手的正是我刚发的这一条」，而不是内容碰巧一样的另一条历史消息。
      const clientMessageId = typeof opts.clientMessageId === 'string' ? opts.clientMessageId.trim() : '';
      msg = this._appendMessage({
        id: `u${n}`,
        turnNum: n,
        role: 'user',
        speaker: '你',
        content: userInput || '',
        runId,
        ...normalizeDispatchMeta(opts.dispatch),
        ...(clientMessageId ? { clientMessageId } : {}),
      });
      didAppendUserMessage = true;
    }
    if (!appendUserMessage && msg && msg.interruptedNote) delete msg.interruptedNote;
    if (msg && !msg.runId) msg.runId = runId;
    this._saveState('run_started', { runId, turnNum: n, status: ATTEMPT_PREPARED });
    return { turnNum: n, runId, userMessage: msg, didAppendUserMessage, revision: this.state.revision };
  }

  /**
   * 复用同一轮、但发给另一批成员的那次派发，也要在群聊里留一张卡片。
   *
   * 为什么必须单独有这个方法：一轮只有一条 `u{n}` 用户消息，被第一步（工作位）占了；
   * 评审那一步走 appendUserMessage:false 复用同一轮，于是**它收到的指令从来没进过消息流**，
   * 群聊窗口里自然什么都看不到（2026-09-06 维护者报的正是这个）。
   *
   * 身份而不是轮次决定去重：id 里带 stepIndex，所以
   *   - 工作位卡片（u{n}）和评审卡片（u{n}-d{step}）是两张，不共用身份；
   *   - 同一步的第 2 次传输重试拿到同一个 id，不会再造一张卡。
   * 角色仍是 user —— buildDelta 明确过滤 role==='user'，这保证新卡片不会被灌进
   * 任何成员的上下文，纯属 UI 与存档层的可追溯性。
   */
  appendDispatchMessage(turnNum, content, dispatch = {}) {
    const n = Number(turnNum);
    if (!Number.isInteger(n) || n <= 0) return null;
    const meta = normalizeDispatchMeta(dispatch);
    if (!meta.dispatch) return null;
    const id = `u${n}-d${meta.dispatch.stepIndex}`;
    const existing = this.state.messages.find(m => m && m.id === id) || null;
    if (existing) return existing;
    const message = this._appendMessage({
      id,
      turnNum: n,
      role: 'user',
      speaker: '你',
      content: String(content || ''),
      runId: meta.dispatch.runId || (this.state.activeRun && this.state.activeRun.runId) || null,
      ...meta,
    });
    this._saveState('dispatch_card_appended', {
      runId: message.runId, turnNum: n, stepIndex: meta.dispatch.stepIndex,
    });
    return message;
  }

  /** 循环自愈等后台动作留给人看的一行系统提示。role 仍是 user，同样不进任何成员的上下文。 */
  appendSystemNote(turnNum, text, meta = {}) {
    const n = Number(turnNum);
    const body = String(text || '').trim();
    if (!Number.isInteger(n) || n <= 0 || !body) return null;
    const sameText = this.state.messages.find(m => m && m.systemNote && m.turnNum === n && m.content === body);
    if (sameText) return sameText;
    const seq = this.state.messages.filter(m => m && m.systemNote && m.turnNum === n).length + 1;
    const message = this._appendMessage({
      id: `sys${n}-${seq}`,
      turnNum: n,
      role: 'user',
      speaker: '系统',
      content: body,
      systemNote: true,
      noteKind: String(meta.kind || 'info'),
      runId: meta.runId || (this.state.activeRun && this.state.activeRun.runId) || null,
    });
    this._saveState('system_note_appended', { runId: message.runId, turnNum: n, kind: message.noteKind });
    return message;
  }

  rollbackTurn(turnNum, runId = null) {
    this.state.messages = this.state.messages.filter(m => m.turnNum !== turnNum);
    this.state.turns = this.state.turns.filter(t => t.n !== turnNum);
    const lastIdx = this.state.messages.length - 1;
    for (const sid of Object.keys(this.state.lastDeliveredIdx || {})) {
      if (this.state.lastDeliveredIdx[sid] > lastIdx) this.state.lastDeliveredIdx[sid] = lastIdx;
    }
    this.state.currentTurn = Math.max(0, ...this.state.turns.map(t => t.n || 0));
    const activeRunMatches = !runId || !this.state.activeRun || this.state.activeRun.runId === runId;
    if (activeRunMatches) {
      this.state.currentMode = 'idle';
      this.state.activeRun = null;
      delete this._activePrompts[turnNum];
    }
    this._clearPendingPromptsForRun(turnNum, runId);
    this._saveState('run_rolled_back', { runId, turnNum, status: ATTEMPT_SUPERSEDED });
  }

  _appendMessage(msg) {
    const message = {
      createdAt: Date.now(),
      seq: Math.max(1, Number(this.state.nextMessageSeq) || 1),
      ...msg,
    };
    this.state.nextMessageSeq = message.seq + 1;
    message.anchor = rawMessageAnchor(this.meetingId, message.id);
    this.state.messages.push(message);
    return message;
  }

  recordTurnPrompt(turnNum, sid, prompt, details = {}) {
    if (!this._activePrompts[turnNum]) this._activePrompts[turnNum] = {};
    this._activePrompts[turnNum][sid] = prompt || '';
    const key = String(turnNum);
    if (!this.state.pendingPrompts || typeof this.state.pendingPrompts !== 'object') this.state.pendingPrompts = {};
    if (!this.state.pendingPrompts[key] || typeof this.state.pendingPrompts[key] !== 'object') this.state.pendingPrompts[key] = {};
    const previous = this.state.pendingPrompts[key][sid] || {};
    const runId = String(details.runId || (this.state.activeRun && this.state.activeRun.runId) || createRunId(this.meetingId, turnNum));
    const memberId = this.ensureMemberIdentity(sid, details.memberId, { source: 'turn_prompt' });
    const attemptId = String(details.attemptId || createAttemptId(runId, memberId || sid));
    const createdAt = Number(details.createdAt) || Date.now();
    for (const oldAttempt of Object.values(this.state.attempts || {})) {
      if (!oldAttempt || isTerminalAttemptStatus(oldAttempt.status)) continue;
      if (oldAttempt.sid !== sid || Number(oldAttempt.turnNum) !== Number(turnNum) || oldAttempt.runId === runId) continue;
      oldAttempt.status = ATTEMPT_SUPERSEDED;
      oldAttempt.reason = 'new_attempt_for_same_member_turn';
      oldAttempt.completedAt = createdAt;
      oldAttempt.updatedAt = createdAt;
      this._bumpRevision('attempt_superseded', oldAttempt);
    }
    this.state.pendingPrompts[key][sid] = {
      prompt: prompt || '',
      status: 'prepared',
      attempts: Number(previous.attempts) || 0,
      updatedAt: createdAt,
      runId,
      attemptId,
      memberId,
      kind: details.kind || previous.kind || null,
      promptHash: promptFingerprint(prompt),
      dispatchAt: Number(details.dispatchAt) || createdAt,
      ...(details.workflowRun && details.workflowRun.runId ? {
        workflowRun: {
          runId: String(details.workflowRun.runId),
          kind: String(details.workflowRun.kind || 'serial'),
          stepIndex: Math.max(0, Number(details.workflowRun.stepIndex) || 0),
          attempt: Math.max(1, Number(details.workflowRun.attempt) || 1),
          targetMemberIds: Array.isArray(details.workflowRun.targetMemberIds)
            ? details.workflowRun.targetMemberIds.map(String)
            : [],
        },
      } : {}),
    };
    if (!this.state.attempts || typeof this.state.attempts !== 'object') this.state.attempts = {};
    this.state.attempts[attemptId] = {
      attemptId,
      runId,
      turnNum: Number(turnNum) || 0,
      sid,
      memberId,
      kind: details.kind || null,
      mode: details.mode || 'group',
      status: ATTEMPT_PREPARED,
      promptHash: promptFingerprint(prompt),
      dispatchAt: Number(details.dispatchAt) || createdAt,
      createdAt,
      updatedAt: createdAt,
      deliveryAttempt: 0,
      ...(details.workflowRun && details.workflowRun.runId ? { workflowRun: _clone(details.workflowRun) } : {}),
    };
    this._saveState('attempt_created', this.state.attempts[attemptId]);
    return _clone(this.state.pendingPrompts[key][sid]);
  }

  getActivePrompt(turnNum, sid = null) {
    const key = String(turnNum);
    const volatile = this._activePrompts[turnNum] || {};
    const durable = this.state.pendingPrompts && this.state.pendingPrompts[key] || {};
    const promptBy = {};
    for (const [memberSid, entry] of Object.entries(durable)) {
      promptBy[memberSid] = entry && typeof entry === 'object' ? (entry.prompt || '') : String(entry || '');
    }
    Object.assign(promptBy, volatile);
    if (sid) return promptBy[sid] ? { prompt: promptBy[sid], status: durable[sid] || null } : null;
    return Object.keys(promptBy).length ? { promptBy } : null;
  }

  _clearPendingPromptsForRun(turnNum, runId = null) {
    const key = String(turnNum);
    const pending = this.state.pendingPrompts && this.state.pendingPrompts[key];
    if (!pending) return;
    if (!runId) {
      delete this.state.pendingPrompts[key];
      return;
    }
    for (const [sid, entry] of Object.entries(pending)) {
      if (entry && entry.runId === runId) delete pending[sid];
    }
    if (Object.keys(pending).length === 0) delete this.state.pendingPrompts[key];
  }

  setSendStatus(turnNum, sid, status, details = {}) {
    const key = String(turnNum);
    const bySid = this.state.pendingPrompts && this.state.pendingPrompts[key];
    if (!bySid || !bySid[sid]) return false;
    const entry = bySid[sid];
    entry.status = status || entry.status || 'unknown';
    entry.updatedAt = Date.now();
    if (/retry|sent|submitted|recovered/i.test(String(status || ''))) {
      entry.attempts = (Number(entry.attempts) || 0) + 1;
    }
    if (details && typeof details === 'object') {
      if (details.acknowledgementSource) entry.acknowledgementSource = String(details.acknowledgementSource);
      if (details.reason) entry.reason = String(details.reason);
      if (details.providerTurnId) entry.providerTurnId = String(details.providerTurnId);
      if (details.attemptId) entry.attemptId = String(details.attemptId);
    }
    const attemptId = String(details.attemptId || entry.attemptId || '');
    const phase = /send_failed|exception/i.test(String(status || '')) ? ATTEMPT_FAILED
      : /stuck|unknown|awaiting_binding/i.test(String(status || '')) ? ATTEMPT_AWAITING_BINDING
        : /submitted|recovered|\bok\b/i.test(String(status || '')) ? ATTEMPT_ACCEPTED
          : /sending|submitting/i.test(String(status || '')) ? ATTEMPT_SUBMITTING
            : null;
    if (attemptId && this.state.attempts[attemptId]) {
      const attempt = this.state.attempts[attemptId];
      if (phase) attempt.status = phase;
      attempt.deliveryAttempt = Math.max(Number(attempt.deliveryAttempt) || 0, Number(entry.attempts) || 0);
      attempt.acknowledgementSource = entry.acknowledgementSource || null;
      attempt.providerTurnId = entry.providerTurnId || attempt.providerTurnId || null;
      attempt.reason = entry.reason || null;
      attempt.acceptedAt = phase === ATTEMPT_ACCEPTED ? Date.now() : (attempt.acceptedAt || null);
      attempt.updatedAt = Date.now();
    }
    this._saveState('attempt_send_status', attemptId && this.state.attempts[attemptId]
      ? this.state.attempts[attemptId]
      : { attemptId, turnNum, sid, status, reason: details.reason });
    return true;
  }

  buildDelta(selfSid, userInput, opts = {}) {
    const lastIdx = this.state.lastDeliveredIdx[selfSid] ?? -1;
    const legacyMessage = this.state.messages[lastIdx];
    const lastSeq = Number.isInteger(this.state.lastDeliveredSeq[selfSid])
      ? this.state.lastDeliveredSeq[selfSid]
      : (legacyMessage && Number.isInteger(legacyMessage.seq) ? legacyMessage.seq : 0);
    const currentUserMessageAppended = opts.currentUserMessageAppended !== false;
    // [全量注入] 投委会幕间传 includeCommitteeMid:true——把中间幕发言全文注入下一幕，让每个委员看到
    //   队友调研全文（群聊式，dispatchInternalPrompt 用）。自由聊默认 false：中间幕不灌回、只带 outcome
    //   （末轮辩论+收敛），省 token 不灌爆上下文（点6）。
    const includeCommitteeMid = opts.includeCommitteeMid === true;
    const newMsgs = this.state.messages
      .filter((message, index) => (Number(message && message.seq) || (index + 1)) > lastSeq)
      .filter(m => m.role !== 'user' && m.sid !== selfSid && m.content && (includeCommitteeMid || !(m.committeeAct && !m.committeeOutcome)));
    void currentUserMessageAppended; // kept in the public contract for callers on old state files
    const parts = [];
    if (newMsgs.length > 0) {
      parts.push('## 新增发言\n' + newMsgs.map(m => `${m.speaker}：${m.content}`).join('\n\n'));
    }
    parts.push('## 用户\n' + (userInput || ''));
    parts.push('请发言。');
    return parts.join('\n\n');
  }

  buildFirstDelta(selfSid, userInput, systemPromptText, opts = {}) {
    if (this.state.lastDeliveredIdx[selfSid] === undefined) {
      return String(systemPromptText || '') + '\n\n' + this.buildDelta(selfSid, userInput, opts);
    }
    return this.buildDelta(selfSid, userInput, opts);
  }

  completeTurn(turnNum, userInput, results, memberBySid, statsBySid = {}, opts = {}) {
    let turn = this.state.turns.find(t => t.n === turnNum);
    const isExistingTurn = !!turn;
    const by = isExistingTurn && turn.by && typeof turn.by === 'object' ? turn.by : {};
    const byStatus = isExistingTurn && turn.byStatus && typeof turn.byStatus === 'object' ? turn.byStatus : {};
    const thinkSecBy = isExistingTurn && turn.thinkSecBy && typeof turn.thinkSecBy === 'object' ? turn.thinkSecBy : {};
    const tokensBy = isExistingTurn && turn.tokensBy && typeof turn.tokensBy === 'object' ? turn.tokensBy : {};
    const attemptIdBy = isExistingTurn && turn.attemptIdBy && typeof turn.attemptIdBy === 'object' ? turn.attemptIdBy : {};
    const providerTurnIdBy = isExistingTurn && turn.providerTurnIdBy && typeof turn.providerTurnIdBy === 'object' ? turn.providerTurnIdBy : {};
    const failureBy = isExistingTurn && turn.failureBy && typeof turn.failureBy === 'object' ? turn.failureBy : {};
    const runId = String(opts.runId || (this.state.activeRun && this.state.activeRun.runId) || (turn && turn.runId) || '');
    // 一位 AI 先完成、其他成员仍在跑时，patchTurnResult 会先把可用结果写进 messages。
    // 完整 turn 尚未建立时从这些持久消息恢复合并基线，避免最后一个成员结算时把
    // 先到结果（尤其手动同步救回的结果）覆盖或清空。
    if (!isExistingTurn) {
      for (const m of this.state.messages) {
        if (!m || m.role !== 'assistant' || Number(m.turnNum) !== Number(turnNum) || !m.sid) continue;
        // 过程汇报只是半路进展，不是答案：拿它当合并基线会把「本轮跑空」记成
        //   by[sid] = 'UPDATE: …'，这一轮的答复就被一句中途汇报顶掉了。
        if (isProgressUpdateMessage(m)) continue;
        if (m.content && String(m.content).trim()) by[m.sid] = m.content;
        if (m.status) byStatus[m.sid] = m.status;
        if (typeof m.thinkSec === 'number') thinkSecBy[m.sid] = m.thinkSec;
        if (typeof m.tokens === 'number') tokensBy[m.sid] = m.tokens;
      }
    }
    const aiMessages = [];

    for (const r of results) {
      const sid = r.sid;
      const member = memberBySid[sid] || {};
      // [查看本轮 prompt] 该 AI 本轮实际收到的完整 prompt（dispatcher 已 recordTurnPrompt 存入 _activePrompts，
      //   本循环结束前不会被 delete），随消息持久化，供前端气泡「📥 查看 prompt」弹窗复盘/优化。
      const _durablePrompt = this.state.pendingPrompts
        && this.state.pendingPrompts[String(turnNum)]
        && this.state.pendingPrompts[String(turnNum)][sid];
      const _srcPrompt = (this._activePrompts[turnNum] && this._activePrompts[turnNum][sid])
        || (_durablePrompt && _durablePrompt.prompt)
        || '';
      // 2026-06-21 道雪：与 patchTurnResult 对齐——仅确有新文本时写正文；
      //   errored/超时返回空文本时保留已有答案，防重发/串行工作流抹掉已生成内容。
      // 2026-07-12 道雪收紧：completed 空文本（process_exit_clean 兜底 settle）同样
      //   不得覆盖——旧规则"成功态无条件写"会让干净退出的 CLI 把已有/已手动同步的
      //   答案抹成空气泡。真理源统一为 by[sid]，消息正文从 by[sid] 取，不再直接用 r.text。
      const _rStatus = r.status || 'completed';
      // trim 判空与渲染层口径一致（多方审查加固）：纯空白文本视为无内容，不覆盖已有答案。
      const _writeContent = !!(r.text && String(r.text).trim().length);
      const _prevStatus = byStatus[sid];
      const _existingMsg = this.state.messages.find(m => m && m.role === 'assistant'
        && Number(m.turnNum) === Number(turnNum) && m.sid === sid && !isProgressUpdateMessage(m));
      const _hasManualResult = _prevStatus === 'manual_extracted'
        && !!(by[sid] && String(by[sid]).trim().length);
      const _incomingIsManual = _rStatus === 'manual_extracted';
      const _sameAttempt = !_existingMsg || !_existingMsg.attemptId || !r.attemptId
        || String(_existingMsg.attemptId) === String(r.attemptId);
      const _hasCompletedResult = _prevStatus === 'completed'
        && !!(by[sid] && String(by[sid]).trim().length)
        && _sameAttempt
        && _existingMsg && _existingMsg.finality === 'provider_final';
      const _preserveExistingFinal = _hasCompletedResult && _rStatus === 'errored';
      // 用户主动同步得到的完整文本优先于随后迟到的自动/退出信号；再次手动同步仍可更新。
      const _acceptIncomingContent = _writeContent
        && (!_hasManualResult || _incomingIsManual)
        && !_preserveExistingFinal;
      by[sid] = _acceptIncomingContent ? r.text : (by[sid] || '');
      // 状态守卫：本轮已被手动同步（manual_extracted）且新结果没带更有效文本时，
      //   保留 manual_extracted——对齐 waitTurnComplete.onTurnPatched 的同名守卫，
      //   防止"手动救回的答案"在整轮 settle 时又被标回 errored。
      byStatus[sid] = (_hasManualResult && !_incomingIsManual)
        ? 'manual_extracted'
        : (_preserveExistingFinal ? 'completed' : _rStatus);
      if (r.attemptId) attemptIdBy[sid] = String(r.attemptId);
      if (r.providerTurnId) providerTurnIdBy[sid] = String(r.providerTurnId);
      if (!_preserveExistingFinal && r.failure && typeof r.failure === 'object') failureBy[sid] = _clone(r.failure);
      else if (byStatus[sid] !== 'errored') delete failureBy[sid];
      // 空结果（重发失败/干净退出兜底）不把已有 thinkSec/tokens 统计清零（多方审查加固）。
      thinkSecBy[sid] = statsBySid[sid]?.thinkSec || r.thinkSec || thinkSecBy[sid] || 0;
      tokensBy[sid] = statsBySid[sid]?.tokens || (r.tokens && r.tokens.total) || tokensBy[sid] || 0;
      const messageId = `a${turnNum}-${member.memberId || sid.slice(0, 8)}`;
      const _failReason = byStatus[sid] === 'errored' && ((r.failure && r.failure.code) || r.reason)
        ? String((r.failure && r.failure.code) || r.reason)
        : null;
      let msg = _existingMsg || this.state.messages.find(m => m && m.role === 'assistant' && m.id === messageId);
      if (msg) {
        msg.sid = sid;
        msg.memberId = member.memberId || sid;
        msg.speaker = _memberLabel(member);
        msg.content = by[sid] || '';
        msg.status = byStatus[sid];
        if (runId) msg.runId = runId;
        if (attemptIdBy[sid]) msg.attemptId = attemptIdBy[sid];
        if (providerTurnIdBy[sid]) msg.providerTurnId = providerTurnIdBy[sid];
        if (failureBy[sid]) msg.failure = _clone(failureBy[sid]);
        else delete msg.failure;
        if (_acceptIncomingContent && r.finality) msg.finality = r.finality;
        if (_acceptIncomingContent && r.signalSource) msg.signalSource = r.signalSource;
        msg.updatedAt = Date.now();
        if (_srcPrompt) msg.sourcePrompt = _srcPrompt;
        // 迟到的无 reason errored 不抹掉已持久化的失败原因；非 errored 终态才清除。
        if (_failReason) msg.statusReason = _failReason;
        else if (byStatus[sid] !== 'errored') delete msg.statusReason;
      } else {
        msg = this._appendMessage({
          id: messageId,
          turnNum,
          role: 'assistant',
          sid,
          memberId: member.memberId || sid,
          speaker: _memberLabel(member),
          content: by[sid] || '',
          status: byStatus[sid],
          ...(runId ? { runId } : {}),
          ...(attemptIdBy[sid] ? { attemptId: attemptIdBy[sid] } : {}),
          ...(providerTurnIdBy[sid] ? { providerTurnId: providerTurnIdBy[sid] } : {}),
          ...(failureBy[sid] ? { failure: _clone(failureBy[sid]) } : {}),
          ...(r.finality ? { finality: r.finality } : {}),
          ...(r.signalSource ? { signalSource: r.signalSource } : {}),
          sourcePrompt: _srcPrompt,
          ...(_failReason ? { statusReason: _failReason } : {}),
        });
      }
      aiMessages.push(msg);

      const prev = this.state.aiStats[sid] || { totalThinkSec: 0, totalTokens: 0, turns: 0 };
      const metricKey = String(r.attemptId || `legacy:${turnNum}:${sid}`);
      const counted = new Set(Array.isArray(prev.countedAttemptIds) ? prev.countedAttemptIds : []);
      if (!counted.has(metricKey)) {
        prev.totalThinkSec += thinkSecBy[sid] || 0;
        prev.totalTokens += tokensBy[sid] || 0;
        prev.turns += 1;
        counted.add(metricKey);
        prev.countedAttemptIds = [...counted].slice(-200);
      }
      prev.kind = member.kind || prev.kind;
      prev.model = member.model || prev.model;
      this.state.aiStats[sid] = prev;
    }

    if (!turn) {
      turn = {
        n: turnNum,
        ...(runId ? { runId } : {}),
        mode: 'group',
        userInput: userInput || '',
        by,
        byStatus,
        thinkSecBy,
        tokensBy,
        attemptIdBy,
        providerTurnIdBy,
        failureBy,
        timestamp: Date.now(),
        meta: {
          dispatchMode: opts.dispatchMode || 'group',
        },
      };
      this.state.turns.push(turn);
    } else {
      turn.userInput = turn.userInput || userInput || '';
      turn.by = by;
      turn.byStatus = byStatus;
      turn.thinkSecBy = thinkSecBy;
      turn.tokensBy = tokensBy;
      turn.attemptIdBy = attemptIdBy;
      turn.providerTurnIdBy = providerTurnIdBy;
      turn.failureBy = failureBy;
      if (runId) turn.runId = runId;
      turn.lastUpdatedAt = Date.now();
      turn.meta = turn.meta && typeof turn.meta === 'object' ? turn.meta : {};
      if (opts.dispatchMode) turn.meta.dispatchMode = opts.dispatchMode;
    }
    if (opts.workflowRun && typeof opts.workflowRun === 'object' && opts.workflowRun.runId) {
      turn.meta = turn.meta && typeof turn.meta === 'object' ? turn.meta : {};
      const steps = Array.isArray(turn.meta.workflowSteps) ? turn.meta.workflowSteps : [];
      const entry = {
        runId: String(opts.workflowRun.runId),
        kind: String(opts.workflowRun.kind || 'serial'),
        stepIndex: Math.max(0, Number(opts.workflowRun.stepIndex) || 0),
        attempt: Math.max(1, Number(opts.workflowRun.attempt) || 1),
        targetMemberIds: Array.isArray(opts.workflowRun.targetMemberIds)
          ? opts.workflowRun.targetMemberIds.map(String)
          : [],
        completedAt: Date.now(),
        results: (results || []).map(result => ({
          sid: result && result.sid || null,
          status: result && result.status || 'unknown',
          textLength: result && result.text ? String(result.text).length : 0,
        })),
      };
      const existingIndex = steps.findIndex(item => item
        && item.runId === entry.runId
        && Number(item.stepIndex) === entry.stepIndex);
      if (existingIndex >= 0) steps[existingIndex] = entry;
      else steps.push(entry);
      turn.meta.workflowSteps = steps.slice(-100);
    }
    for (const result of results) {
      if (result && result.attemptId) this.settleAttempt(result.attemptId, result, { persist: false });
    }
    const runStatus = results.some(result => result && result.status === 'interrupted')
      ? ATTEMPT_INTERRUPTED
      : results.some(result => result && result.status === 'superseded')
        ? ATTEMPT_SUPERSEDED
        : (results.length > 0 && results.every(result => result && ['errored', 'failed', 'absent'].includes(result.status)))
          ? ATTEMPT_FAILED
          : ATTEMPT_COMPLETED;
    const activeRunMatches = !this.state.activeRun || !runId || this.state.activeRun.runId === runId;
    if (activeRunMatches) {
      this.state.currentMode = 'idle';
      if (this.state.activeRun) {
        this.state.activeRun.status = runStatus;
        this.state.activeRun.hasFailures = results.some(result => result && ['errored', 'failed'].includes(result.status));
        this.state.activeRun.completedAt = Date.now();
        this.state.activeRun.updatedAt = Date.now();
      }
    }
    if (activeRunMatches) delete this._activePrompts[turnNum];
    this._clearPendingPromptsForRun(turnNum, runId);
    const lastIdx = this.state.messages.length - 1;
    for (const r of results) {
      this.state.lastDeliveredIdx[r.sid] = Number.isInteger(r.deliveredIdx) ? r.deliveredIdx : lastIdx;
      const deliveredMessage = Number.isInteger(r.deliveredSeq)
        ? null
        : this.state.messages[Number.isInteger(r.deliveredIdx) ? r.deliveredIdx : lastIdx];
      this.state.lastDeliveredSeq[r.sid] = Number.isInteger(r.deliveredSeq)
        ? r.deliveredSeq
        : (deliveredMessage && Number.isInteger(deliveredMessage.seq) ? deliveredMessage.seq : 0);
    }
    this._saveState('run_completed', { runId, turnNum, status: runStatus });
    return turn;
  }

  // silent 内部编排（投委会五幕）每幕后调：标记这些委员已收到 systemPrompt 并对齐到当前 messages
  // 末尾，使后续幕 buildFirstDelta 走增量、不再每幕全量重发规则（点2 上下文污染根因）。故意不写
  // messages（silent 不污染自由聊 transcript）——委员靠各自持久 CLI 会话记忆延续上下文。
  markDeliveredSilent(results) {
    const lastIdx = this.state.messages.length - 1;
    for (const r of results || []) {
      if (!r || !r.sid) continue;
      this.state.lastDeliveredIdx[r.sid] = Number.isInteger(r.deliveredIdx) ? r.deliveredIdx : lastIdx;
      const deliveredMessage = Number.isInteger(r.deliveredSeq)
        ? null
        : this.state.messages[Number.isInteger(r.deliveredIdx) ? r.deliveredIdx : lastIdx];
      this.state.lastDeliveredSeq[r.sid] = Number.isInteger(r.deliveredSeq)
        ? r.deliveredSeq
        : (deliveredMessage && Number.isInteger(deliveredMessage.seq) ? deliveredMessage.seq : 0);
    }
    this._saveState('silent_delivery_advanced');
  }

  // 投委会发言落进群聊 messages（带 committeeAct 幕次 meta）——每个 AI 发言以气泡卡片承载在群聊主
  // 界面、按时间排列（阶段二 UI）。actMeta.outcome=true 的（末轮辩论 / 主席收敛）额外标 committeeOutcome：
  // 这类会被 buildDelta 带给回归自由聊后没看到的 AI（点6）；中间幕发言 buildDelta 跳过（省 token）。
  // 只写 messages、不写 turns —— 不进群聊 turn 列表，仅作气泡渲染 + 选择性上下文传递。
  appendCommitteeSpeeches(items, actMeta = {}) {
    const list = (items || []).filter(it => it && it.sid && String(it.content || '').trim());
    if (!list.length) return 0;
    for (const it of list) {
      this._appendMessage({
        id: `committee-${actMeta.act || 'x'}-${String(it.sid).slice(0, 8)}-${this.state.messages.length}`,
        role: 'assistant',
        sid: it.sid,
        memberId: it.memberId || it.sid,
        speaker: it.speaker || '委员',
        content: String(it.content),
        status: 'completed',
        committeeAct: actMeta.act || '',
        committeeRound: actMeta.round,
        committeeSub: actMeta.sub || '',
        committeeOutcome: !!actMeta.outcome,
        sourcePrompt: it.prompt || '',
      });
    }
    this._saveState();
    return list.length;
  }

  // 兼容旧入口（点6）：末轮+主席发言，标 outcome。新代码走 appendCommitteeSpeeches。
  appendCommitteeOutcome(items) { return this.appendCommitteeSpeeches(items, { outcome: true }); }

  clearTurnInProgress(turnNum, runId = null) {
    if (!turnNum || this.state.currentTurn !== turnNum) return;
    if (runId && this.state.activeRun && this.state.activeRun.runId !== runId) return;
    this.state.currentMode = 'idle';
    if (!runId || (this.state.activeRun && this.state.activeRun.runId === runId)) this.state.activeRun = null;
    delete this._activePrompts[turnNum];
    this._clearPendingPromptsForRun(turnNum, runId);
    this._saveState('run_cleared', { runId, turnNum });
  }

  patchTurnResult(turnNum, sid, {
    text,
    status,
    thinkSec,
    tokens,
    memberId,
    speaker,
    sourcePrompt,
    statusReason,
    attemptId,
    runId,
    providerTurnId,
    failure,
    signalSource,
    finality,
    completedAt,
  } = {}) {
    const turn = this.state.turns.find(t => t.n === turnNum);
    const userMsg = this.state.messages.find(m => m && m.role === 'user' && Number(m.turnNum) === Number(turnNum));
    // turns 只在全员结算后创建；进行中/崩溃中断轮次仍有 u{n}，允许先保存可用结果。
    // 连用户消息都不存在才是真正的错误 turn，继续拒绝，避免跨轮误写。
    if (!turn && !userMsg) return null;

    const pending = !turn;
    const by = pending ? {} : (turn.by = turn.by || {});
    const byStatus = pending ? {} : (turn.byStatus = turn.byStatus || {});
    const thinkSecBy = pending ? {} : (turn.thinkSecBy = turn.thinkSecBy || {});
    const tokensBy = pending ? {} : (turn.tokensBy = turn.tokensBy || {});
    const attemptIdBy = pending ? {} : (turn.attemptIdBy = turn.attemptIdBy || {});
    const providerTurnIdBy = pending ? {} : (turn.providerTurnIdBy = turn.providerTurnIdBy || {});
    const failureBy = pending ? {} : (turn.failureBy = turn.failureBy || {});
    let msg = this.state.messages.find(m => m && Number(m.turnNum) === Number(turnNum)
      && m.role === 'assistant' && m.sid === sid && !isProgressUpdateMessage(m));
    if (pending && msg) {
      if (msg.content && String(msg.content).trim()) by[sid] = msg.content;
      if (msg.status) byStatus[sid] = msg.status;
      if (typeof msg.thinkSec === 'number') thinkSecBy[sid] = msg.thinkSec;
      if (typeof msg.tokens === 'number') tokensBy[sid] = msg.tokens;
    }

    // 任意终态只要带非空文本就先保住正文；errored + partial text 也比丢结果更有价值。
    const _writeContent = !!(text && String(text).trim().length);
    const _prevPatchStatus = byStatus[sid];
    const _hasManualResult = _prevPatchStatus === 'manual_extracted'
      && !!(by[sid] && String(by[sid]).trim().length);
    const _incomingStatus = status || 'completed';
    const _incomingIsManual = _incomingStatus === 'manual_extracted';
    const _acceptIncomingContent = _writeContent && (!_hasManualResult || _incomingIsManual);
    if (_acceptIncomingContent) by[sid] = text;
    const _finalStatus = (_hasManualResult && !_incomingIsManual)
      ? 'manual_extracted'
      : _incomingStatus;
    byStatus[sid] = _finalStatus;
    if (attemptId) attemptIdBy[sid] = String(attemptId);
    if (providerTurnId) providerTurnIdBy[sid] = String(providerTurnId);
    if (failure && typeof failure === 'object') failureBy[sid] = _clone(failure);
    else if (_finalStatus !== 'errored') delete failureBy[sid];
    if (typeof thinkSec === 'number') thinkSecBy[sid] = thinkSec;
    if (tokens && typeof tokens.total === 'number') tokensBy[sid] = tokens.total;
    const patchedAt = Date.now();
    if (turn) turn.lastPatchedAt = patchedAt;

    if (!msg) {
      const stableMemberId = memberId || sid.slice(0, 8);
      msg = this._appendMessage({
        id: `a${turnNum}-${stableMemberId}`,
        turnNum,
        role: 'assistant',
        sid,
        memberId: memberId || sid,
        speaker: speaker || 'AI',
        content: by[sid] || '',
        status: _finalStatus,
        ...(runId ? { runId } : {}),
        ...(attemptId ? { attemptId: String(attemptId) } : {}),
        ...(providerTurnId ? { providerTurnId: String(providerTurnId) } : {}),
        ...(failure ? { failure: _clone(failure) } : {}),
        ...(finality ? { finality } : {}),
        ...(signalSource ? { signalSource } : {}),
        ...(sourcePrompt ? { sourcePrompt } : {}),
      });
    } else {
      if (_acceptIncomingContent) msg.content = text;
      msg.status = _finalStatus;
      if (memberId) msg.memberId = memberId;
      if (speaker) msg.speaker = speaker;
      if (sourcePrompt && !msg.sourcePrompt) msg.sourcePrompt = sourcePrompt;
      if (runId) msg.runId = runId;
      if (attemptId) msg.attemptId = String(attemptId);
      if (providerTurnId) msg.providerTurnId = String(providerTurnId);
      if (failure) msg.failure = _clone(failure);
      else if (_finalStatus !== 'errored') delete msg.failure;
      if (_acceptIncomingContent && finality) msg.finality = finality;
      if (_acceptIncomingContent && signalSource) msg.signalSource = signalSource;
    }
    msg.patchedAt = patchedAt;
    if (typeof thinkSec === 'number') msg.thinkSec = thinkSec;
    if (tokens && typeof tokens.total === 'number') msg.tokens = tokens.total;
    if (_finalStatus === 'errored' && (failure || statusReason)) msg.statusReason = String((failure && failure.code) || statusReason);
    else if (_acceptIncomingContent) delete msg.statusReason;

    if (attemptId) {
      this.settleAttempt(attemptId, {
        status: _finalStatus,
        text,
        providerTurnId,
        failure,
        reason: (failure && failure.code) || statusReason,
        signalSource,
        finality,
        completedAt,
      }, { persist: false, allowTerminalPatch: _incomingIsManual || finality === 'provider_final' });
    }

    this._saveState('attempt_result_persisted', {
      attemptId, runId, turnNum, sid, memberId, status: _finalStatus,
      providerTurnId, failure, source: signalSource,
    });
    if (turn) return _clone(turn);
    return _clone({
      n: turnNum,
      inProgress: true,
      userInput: userMsg.content || '',
      by,
      byStatus,
      thinkSecBy,
      tokensBy,
      attemptIdBy,
      providerTurnIdBy,
      failureBy,
      lastPatchedAt: patchedAt,
    });
  }

  searchRaw(query, limit = 20) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    return this.state.messages
      .filter(m => String(m.content || '').toLowerCase().includes(q))
      .slice(-Math.max(1, limit))
      .map(m => ({
        id: m.id,
        anchor: m.anchor,
        speaker: m.speaker,
        turnNum: m.turnNum,
        snippet: String(m.content || '').replace(/\s+/g, ' ').trim(),
      }));
  }

  readRaw(messageId) {
    const id = String(messageId || '').trim();
    return this.state.messages.find(m => m.id === id || m.anchor === id) || null;
  }
}

const _cache = new Map();

function getOrchestrator(hubDataDir, meetingId) {
  const key = `${hubDataDir}::${meetingId}`;
  if (!_cache.has(key)) _cache.set(key, new GroupChatOrchestrator(hubDataDir, meetingId));
  return _cache.get(key);
}

module.exports = {
  getOrchestrator,
  groupChatStatePath,
  cleanup,
  rawMessageAnchor,
  buildSystemPromptText,
  normalizeDispatchMeta,
  _private: {
    buildSystemPromptText,
    normalizeDispatchMeta,
    RESEARCH_SCENE_PROMPT,
    COMMITTEE_DISCIPLINE,
    GroupChatOrchestrator,
    resetCache: () => _cache.clear(),
  },
};
