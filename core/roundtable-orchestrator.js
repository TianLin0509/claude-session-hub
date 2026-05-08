'use strict';
// Roundtable Orchestrator — 圆桌轮次状态机
//
// 两种轮次模式（2026-05-08 摘要功能整体下线后）：
//   fanout : 默认提问 → 三家独立回答（互不知情）
//   debate : @debate → 把另两家上一轮观点中转给第三家（可附用户补充）
//
// 持久化：
//   <arena-prompts>/<meetingId>-roundtable.json  — 状态
//   <arena-prompts>/<meetingId>-turn-N.json      — 每轮详细记录
//
// PTY 输入 / turn-complete 监听由 main.js 的 IPC handler 调度（复用 executeReview 既有模式）

const fs = require('fs');
const path = require('path');
const { ALL_AI_KINDS } = require('./ai-kinds.js');
// dev scene (plan-dev-scenario.md): per-turn L2b 触发追注 (clarify/handoff/review)
const {
  detectDevTrigger,
  buildDevL2bSection,
} = require('./roundtable-scenes.js');

const MAX_DEBATE_OPINION_CHARS = 5000;
const MAX_DEBATE_OPINION_KEEP = 2000;
// 软提醒两阶段：T1 先弹 banner 提示"还在等"，T2 再升级提醒。
//   永不自动 settle—— 真正退出由用户点"手动提取/跳过/重发"或 L1/L2 信号决定。
//   设计文档：docs/superpowers/specs/2026-04-30-roundtable-resilience-design.md
//   （旧 TURN_WATCHDOG_MS = 600000 强制超时已在 Stage 2 commit 2 移除——
//    main.js _rtWaitTurnComplete 改用 turn-completion-watcher。）
const SOFT_ALERT_T1_MS = 90000;  //  90s — 首阶段提醒
const SOFT_ALERT_T2_MS = 180000; // 180s — 二阶段升级

function arenaPromptsDir(hubDataDir) {
  return path.join(hubDataDir, 'arena-prompts');
}

// pilot recap injection 已废弃 (2026-05-02)
//   shell/卡片分离后 pilot recap 整体删除（圆桌只承载协作，私聊去子会话区）。
//   旧 _maybePilotRecapPrefix / findLatestPilotRecap 实现详见 git 历史。

class RoundtableOrchestrator {
  constructor(hubDataDir, meetingId, scene) {
    this.hubDataDir = hubDataDir;
    this.meetingId = meetingId;
    this.scene = scene || { name: '圆桌', dataPackEnabled: false };
    this.state = {
      meetingId,
      currentTurn: 0,
      currentMode: 'idle',
      turns: [], // [{ n, mode, userInput, by: { sid: text }, timestamp, meta }]
      // meeting-create-modal（2026-05-01）：sid 索引化（允许 3 个相同 kind 的 slot
      //   各自独立累加），卡片 row3/row4 仍显示"本轮/累计"。老 kind 索引格式
      //   会在 setMeetingContext() 调用时迁移；迁移失败丢累计统计但不影响功能。
      aiStats: {},
    };
    this._loadState();
  }

  _stateFilePath() {
    return path.join(arenaPromptsDir(this.hubDataDir), `${this.meetingId}-roundtable.json`);
  }
  _turnFilePath(n) {
    return path.join(arenaPromptsDir(this.hubDataDir), `${this.meetingId}-turn-${n}.json`);
  }

  _loadState() {
    const fp = this._stateFilePath();
    if (!fs.existsSync(fp)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      if (raw && raw.meetingId === this.meetingId) {
        this.state = raw;
        // 兜底字段，防止 undefined 抛错。aiStats 老格式（kind 索引）这里不改写——
        //   等 setMeetingContext(sidToKindMap) 调用时再尝试 migrateAiStats，
        //   失败则丢累计统计起新（per spec §4.4）。
        if (!this.state.aiStats || typeof this.state.aiStats !== 'object') {
          this.state.aiStats = {};
        }
      }
    } catch (e) {
      console.warn(`[roundtable] load state failed for ${this.meetingId}:`, e.message);
    }
  }

  // meeting-create-modal（2026-05-01）：让 main.js 在 IPC 调度阶段把当前 meeting
  //   的 sid → {kind, model} 映射注入 orchestrator，触发老 aiStats 格式迁移
  //   + 让 completeTurn 能给新 sid 项写 kind/model 元数据。
  setMeetingContext(sidToInfoMap) {
    this._sidInfo = sidToInfoMap || {};
    // 仅在有 sid 信息时迁移，否则 migrateAiStats 会保守返回原 stats（防数据丢失）。
    const hasSidInfo = Object.keys(this._sidInfo).some(k => !!k && !!this._sidInfo[k]);
    if (hasSidInfo && _isLegacyKindKeyed(this.state.aiStats)) {
      const migrated = migrateAiStats(this.state.aiStats, this._sidInfo);
      // 防御：迁移结果非法（不是对象）时不动 state
      if (migrated && typeof migrated === 'object') {
        this.state.aiStats = migrated;
        // silent-failure-hunter M2（2026-05-04 道雪）：原空 catch 吞掉 _saveState throw →
        //   内存迁移成功但磁盘没更新 → 下次 Hub 启动又载入老格式重新迁移、aiStats 累计回滚。
        //   留 try/catch（迁移失败不应阻断 setMeetingContext 流程），但加 warn 方便追溯。
        try { this._saveState(); } catch (e) {
          console.warn('[orchestrator] setMeetingContext: _saveState failed after aiStats migration:', e && e.message);
        }
      }
    }
  }

  // silent-failure-hunter#2（2026-05-03 道雪）：原代码无 try/catch，磁盘满/EBUSY/
  //   权限错误时 writeFileSync 抛错 → 调用方（completeTurn/patchTurnResult/...）
  //   异常冒泡到 dispatchRoundtableTurn 的 finally → 内存 state.turns 已 push
  //   但磁盘 .json 没更新 → 重启后 _loadState 漏掉这轮 → turnNum 重用乱跳。
  //   修：catch + console.error + 重 throw 让调用方有机会 rollback。
  _saveState() {
    const fp = this._stateFilePath();
    try {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (e) {
      console.error(`[orchestrator] _saveState failed for ${this.meetingId} (${fp}):`, e.message);
      throw e;
    }
  }

  _saveTurnFile(turnRecord) {
    const fp = this._turnFilePath(turnRecord.n);
    try {
      fs.writeFileSync(fp, JSON.stringify(turnRecord, null, 2), 'utf-8');
    } catch (e) {
      console.error(`[orchestrator] _saveTurnFile failed for ${this.meetingId} turn ${turnRecord.n} (${fp}):`, e.message);
      throw e;
    }
  }

  getState() { return JSON.parse(JSON.stringify(this.state)); }
  getLastTurn() {
    return this.state.turns.length > 0 ? this.state.turns[this.state.turns.length - 1] : null;
  }

  // ---------------------------------------------------------------------
  // Prompt 拼装（方案 F · 2026-05-02 重构）
  //
  // 三个 build*Prompt 接受统一参数：
  //   dispatchSpec       — { mode, selfRole, sameStageLabels, pilotLabel } 或 null
  //   injectionPayload   — computeLastTurnInjection(...) 返回的当前 sid 对应 payload，或 null（同组跳过 / 首轮）
  //   timelinePath       — timeline.md 绝对路径，或 null（无 timeline 时省略相关段）
  //
  // 内部用三个共享渲染 helper：
  //   _renderDispatchContext(dispatchSpec)       → '## 调度上下文' 段
  //   _renderLastTurnSection(payload, tlPath)    → '## 上一轮 ...' 段（嵌 timeline 索引）
  //   _renderTimelineFooter(tlPath)              → '完整历史：...' 末尾段
  // ---------------------------------------------------------------------

  // P6 (2026-05-04) 字段化调度上下文 — 6 字段 bullet,集中协议层运行时信息
  //   字段顺序: 你是 / 同台 / 模式 / 轮次性质 / 回答方式 / 轻提醒
  //   "回答方式"+"轻提醒"两字段把原散落在 build 函数末尾的独立行为提示段并入此处,
  //   攻击 attention recency (位于头部 + 距离任务体最近)。
  //   dispatchSpec=null 时返回 null (resend 路径兼容)。
  _renderDispatchContext(dispatchSpec, mySid, sidLabelFn, turnKind) {
    if (!dispatchSpec || typeof dispatchSpec !== 'object') return null;
    const { mode, selfRole, sameStageLabels, pilotLabel } = dispatchSpec;
    if (mode !== 'all' && mode !== 'pilot' && mode !== 'observer') return null;

    const lines = ['## 调度上下文'];
    // 你是
    const myLabel = sidLabelFn ? (sidLabelFn(mySid) || mySid || 'AI') : (mySid || 'AI');
    let youAre = `- 你是:${myLabel}`;
    if (selfRole === 'pilot') youAre += '（主驾）';
    else if (selfRole === 'observer' || selfRole === 'co-pilot') youAre += '（副驾）';
    lines.push(youAre);
    // 同台
    if (Array.isArray(sameStageLabels) && sameStageLabels.length > 0) {
      lines.push(`- 同台:${sameStageLabels.join(' / ')}`);
    }
    // 模式
    lines.push(`- 模式:${this._dispatchModeLabel(mode, pilotLabel)}`);
    // 轮次性质 + 回答方式
    if (turnKind) {
      lines.push(`- 轮次性质:${turnKind}`);
      lines.push(`- 回答方式:${this._answerStyleFor(turnKind, mode)}`);
    }
    // 轻提醒 (P6 micro-reminder · 攻击长对话 attention decay)
    lines.push('- 轻提醒:≤ 1500 字 / 写文件按用户表达：明确要求→写；未明确→提议 / 不展开多步骤工作流');
    return lines.join('\n');
  }

  _dispatchModeLabel(mode, pilotLabel) {
    if (mode === 'all') return '群策群力（参与者同台独立回答）';
    if (mode === 'pilot') return '主驾发言（你被点名独说，副驾们本轮静音）';
    if (mode === 'observer') return `副驾发言（主驾${pilotLabel ? ' ' + pilotLabel : ''} 本轮静音，用户希望听副驾视角）`;
    return mode || '未知';
  }

  _answerStyleFor(turnKind, dispatchMode) {
    if (turnKind === 'fanout') {
      if (dispatchMode === 'pilot') return '独立回答（本轮你被点名独说，副驾们本轮静音）';
      if (dispatchMode === 'observer') return '独立回答（你与另一位副驾互相看不到本轮发言，保持各自独立视角）';
      return '独立回答（看不到他人本轮观点）';
    }
    if (turnKind === 'debate') return '引用并回应上一轮他人观点（可看到对方本轮言论）';
    return '按本轮上下文回答';
  }

  // 共享渲染：## 上一轮 段（按 injection 矩阵注入；payload null 时返回 null 整段省略）
  _renderLastTurnSection(injectionPayload, timelinePath) {
    if (!injectionPayload || typeof injectionPayload !== 'object') return null;
    const { lastTurnNum, lastTurnMode, lastDispatchMode, speakers } = injectionPayload;
    if (!Array.isArray(speakers) || speakers.length === 0) return null;

    const lines = [];
    lines.push(`## 上一轮（第 ${lastTurnNum} 轮 · ${lastTurnMode || 'fanout'} · ${lastDispatchMode || 'all'}）`);
    if (timelinePath) {
      lines.push(`> 提示:本段是上一轮内容。如需更早历史请 Read ${timelinePath}`);
    }
    lines.push('');

    for (const sp of speakers) {
      const { label, role, text, status } = sp;
      const labelDisplay = label || sp.sid || 'AI';
      let header = `### ${labelDisplay}`;
      if (role === 'pilot') header += '（主驾）';
      else if (role === 'observer' || role === 'co-pilot') header += '（副驾）';
      if (status === 'absent') header += '（本轮未参与）';
      else if (status === 'errored') header += '（本轮错误）';
      lines.push(header);
      let body;
      if (status === 'absent') {
        body = `（${labelDisplay} 本轮因故未参与，请勿引用）`;
      } else if (status === 'errored') {
        body = `（${labelDisplay} 本轮发生错误未输出，请勿引用）`;
      } else {
        let trimmed = text || '(无输出)';
        if (trimmed.length > MAX_DEBATE_OPINION_CHARS) {
          trimmed = trimmed.slice(0, MAX_DEBATE_OPINION_KEEP)
            + '\n\n…[中段已省略以控制 prompt 长度]…\n\n'
            + trimmed.slice(-MAX_DEBATE_OPINION_KEEP);
        }
        body = trimmed;
      }
      lines.push(body);
      lines.push('');
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  }

  // 共享渲染：末尾"完整历史"footer (P6 压缩 · 与上一轮注入段提示行格式统一)
  _renderTimelineFooter(timelinePath) {
    if (!timelinePath || typeof timelinePath !== 'string') return null;
    return `> 完整历史:${timelinePath}`;
  }

  // dev scene · L2b 触发段渲染 (plan-dev-scenario.md §3.3 / §4.1)
  //   首轮默认 clarify · handoff/review/brainstorm 关键词命中追注
  //   非 dev scene 或无 trigger → 返回 null (整段省略, 不污染其他场景)
  //   注: 仅 fanout/debate 注入
  _renderDevL2bSection(turnNum, userInput) {
    if (!this.scene || this.scene.key !== 'dev') return null;
    const isFirstTurn = (typeof turnNum === 'number' && turnNum === 1);
    const trigger = detectDevTrigger(userInput, isFirstTurn);
    return buildDevL2bSection(trigger);
  }

  // P6 (2026-05-04) 默认 fanout 轮:scene 标签 + 字段化调度上下文 + [上一轮?] + [数据包?] + 用户问题 + [timeline footer?]
  //   独立行为提示段已删除 — 已并入 _renderDispatchContext 的"回答方式"字段
  //   新参数 mySid / sidLabelFn 用于"你是"字段渲染 (向后兼容: caller 不传则降级显示 sid)
  buildFanoutPrompt(turnNum, userInput, dataPack, dispatchSpec, injectionPayload, timelinePath, mySid, sidLabelFn) {
    const parts = [`[${this.scene.name} · 第 ${turnNum} 轮 · 默认提问]`];

    const ctx = this._renderDispatchContext(dispatchSpec, mySid, sidLabelFn, 'fanout');
    if (ctx) parts.push('', ctx);

    const last = this._renderLastTurnSection(injectionPayload, timelinePath);
    if (last) parts.push('', last);

    if (this.scene.dataPackEnabled && dataPack && typeof dataPack === 'string' && dataPack.trim().length > 0) {
      parts.push('', '## 数据接入（Hub 自动调数据后端拉取）', dataPack);
    }

    // dev scene L2b 触发追注 (plan-dev-scenario.md §3.3) — 在用户问题前
    const devL2b = this._renderDevL2bSection(turnNum, userInput);
    if (devL2b) parts.push('', devL2b);

    parts.push('', '## 用户问题', userInput || '');

    const footer = this._renderTimelineFooter(timelinePath);
    if (footer) parts.push('', footer);

    return parts.join('\n');
  }

  // P6 (2026-05-04) debate 轮:scene 标签 + 字段化调度上下文 + [用户补充?] + [上一轮?] + 任务说明 + [timeline footer?]
  buildDebatePrompt(turnNum, userInput, dispatchSpec, injectionPayload, timelinePath, mySid, sidLabelFn) {
    const parts = [`[${this.scene.name} · 第 ${turnNum} 轮 · @debate]`];

    const ctx = this._renderDispatchContext(dispatchSpec, mySid, sidLabelFn, 'debate');
    if (ctx) parts.push('', ctx);

    if (userInput && typeof userInput === 'string' && userInput.trim().length > 0) {
      parts.push('', '## 用户在本轮补充的新信息', userInput);
    }

    const last = this._renderLastTurnSection(injectionPayload, timelinePath);
    if (last) {
      parts.push('', last);
    } else {
      parts.push('', '（无上一轮内容可参考，请独立发表观点）');
    }

    parts.push('', '## 你的任务');
    parts.push('请基于上一轮内容 + 用户补充信息发表新观点:可继承、可反驳，但要明示引用对方哪一点。');

    // dev scene L2b 触发追注 (plan-dev-scenario.md §3.3)
    //   debate 不会是首轮 (debate 至少需要上一轮内容), 所以传 isFirstTurn=false 等价行为;
    //   _renderDevL2bSection 内部用 turnNum===1 判定首轮, 自然 false
    const devL2b = this._renderDevL2bSection(turnNum, userInput);
    if (devL2b) parts.push('', devL2b);

    const footer = this._renderTimelineFooter(timelinePath);
    if (footer) parts.push('', footer);

    return parts.join('\n');
  }

  // 摘要功能 2026-05-08 整体下线：
  //   - buildSummaryPrompt（原 @summary @<who> 综合）已删
  //   - buildBriefSummaryPrompt（原 UI 摘要按钮触发的五元组压缩）已删
  //   仅保留 fanout / debate 两条路径。

  // ---------------------------------------------------------------------
  // 状态记录
  // ---------------------------------------------------------------------

  // 启动一轮：返回新 turnNum
  beginTurn(mode) {
    this.state.currentTurn += 1;
    this.state.currentMode = mode;
    this._saveState();
    return this.state.currentTurn;
  }

  // 完成一轮：写持久化
  // byMap: { sid: text }
  // meta: 任意附加（如 summarizer / decisionTitle）
  // byStatus: { sid: 'completed' | 'manual_extracted' | 'absent' | 'errored' | ... }
  //   新增（Stage 2 容错升级）。null/undefined 表示老格式 — buildDebate/Summary 会按
  //   "全部 completed" 处理。下游 prompt builder 用此字段过滤 absent/errored 参与者。
  // stats: { thinkSecBy: {sid: number}, tokensBy: {sid: number} }
  //   meeting-create-modal（2026-05-01）：纯 sid 索引（去掉了老的 thinkSecByKind/tokensByKind）。
  //   null/undefined 时跳过累加（向后兼容）。state.aiStats[<sid>] 累加 totalThinkSec/totalTokens。
  //   sid → kind/model 元数据由 setMeetingContext(sidToInfoMap) 注入，迁移老格式同此入口。
  completeTurn(turnNum, mode, userInput, byMap, meta = {}, byStatus = null, stats = null) {
    const record = {
      n: turnNum,
      mode,
      userInput: userInput || '',
      by: byMap || {},
      byStatus: byStatus || null,
      thinkSecBy: (stats && stats.thinkSecBy) || {},
      tokensBy: (stats && stats.tokensBy) || {},
      timestamp: Date.now(),
      ...meta,
    };
    // Resend & Auto-Recovery（2026-05-03）：merge active prompt meta 到 record
    //   promptHeaderBy + sendStatus 长存（小，调试用）；
    //   promptBy 不复制到 record（节流策略：仅活跃轮持有，settle 时随 _activePrompts[turnNum] 整体删除）
    const _activeSlot = this.state._activePrompts && this.state._activePrompts[turnNum];
    if (_activeSlot) {
      record.promptHeaderBy = _activeSlot.promptHeaderBy || {};
      record.sendStatus = _activeSlot.sendStatus || {};
      delete this.state._activePrompts[turnNum];
    }

    this.state.turns.push(record);
    this.state.currentMode = 'idle';
    delete this.state.currentSummarizerSlot;

    // meeting-create-modal（2026-05-01）：sid 索引累加。stats.thinkSecBy / tokensBy
    //   已经是 sid-keyed 格式（见调用方 main.js）。state.aiStats[<sid>] 写入
    //   { totalThinkSec, totalTokens, perTurnHistory, kind, model }。
    if (stats && (stats.thinkSecBy || stats.tokensBy)) {
      if (!this.state.aiStats || typeof this.state.aiStats !== 'object') this.state.aiStats = {};
      const tsBy = stats.thinkSecBy || {};
      const tkBy = stats.tokensBy || {};
      const sids = new Set([
        ...Object.keys(byMap || {}),
        ...Object.keys(tsBy),
        ...Object.keys(tkBy),
      ]);
      for (const sid of sids) {
        if (!sid) continue;
        if (!this.state.aiStats[sid]) {
          const info = (this._sidInfo && this._sidInfo[sid]) || {};
          this.state.aiStats[sid] = {
            totalThinkSec: 0,
            totalTokens: 0,
            perTurnHistory: [],
            kind: info.kind || null,
            model: info.model || null,
          };
        }
        const s = this.state.aiStats[sid];
        const thisSec = tsBy[sid] || 0;
        const thisTok = tkBy[sid] || 0;
        s.totalThinkSec += thisSec;
        s.totalTokens   += thisTok;
        if (thisSec > 0 || thisTok > 0) {
          s.perTurnHistory.push({ n: turnNum, thinkSec: thisSec, tokens: thisTok, ts: Date.now() });
        }
      }
    }

    this._saveState();
    this._saveTurnFile(record);
    return record;
  }

  // 回滚（启动后失败）
  rollbackTurn(turnNum) {
    if (this.state.currentTurn === turnNum) {
      this.state.currentTurn -= 1;
      this.state.currentMode = 'idle';
      delete this.state.currentSummarizerSlot;
      if (this.state._activePrompts) {
        delete this.state._activePrompts[turnNum];
      }
      this._saveState();
    }
  }

  // FIX-F（2026-05-01）：单家"重新拉起"成功后，把新结果 patch 进指定轮记录。
  //   仅修改 by[sid] / byStatus[sid] / thinkSecBy[sid] / tokensBy[sid]；
  //   不改 mode / userInput / meta / 累计统计 aiStats（避免重复累加）。
  // 返回 patch 后的 record（深拷贝），方便调用方推 turn-complete IPC。
  patchTurnResult(turnNum, sid, { text, status, thinkSec, tokens }) {
    const record = this.state.turns.find(t => t.n === turnNum);
    if (!record) return null;
    record.by = record.by || {};
    record.byStatus = record.byStatus || {};
    record.thinkSecBy = record.thinkSecBy || {};
    record.tokensBy = record.tokensBy || {};
    if (status === 'completed' || status === 'manual_extracted') {
      record.by[sid] = text || '';
    }
    record.byStatus[sid] = status || 'errored';
    if (typeof thinkSec === 'number') record.thinkSecBy[sid] = thinkSec;
    if (tokens && typeof tokens.total === 'number') record.tokensBy[sid] = tokens.total;
    record.lastPatchedAt = Date.now();
    this._saveState();
    this._saveTurnFile(record);
    return JSON.parse(JSON.stringify(record));
  }

  // 2026-05-03 道雪 bug ④ 续修：patch turn 顶层 meta 字段（archivedTo/decisionTitle 等）
  //   并持久化。dispatch 路径写完决策档案后调用 patchTurnMeta(turnNum, { archivedTo })，
  //   manual-extract 重写归档时再读到这个 archivedTo 复用同一文件名。
  //   仅写 metaPatch 提供的 key（浅合并到 record 顶层），不动 by/byStatus/stats。
  // 返回 patch 后的 record（深拷贝）；turn 不存在返回 null。
  patchTurnMeta(turnNum, metaPatch) {
    const record = this.state.turns.find(t => t.n === turnNum);
    if (!record) return null;
    if (metaPatch && typeof metaPatch === 'object') {
      for (const [k, v] of Object.entries(metaPatch)) {
        record[k] = v;
      }
    }
    record.lastPatchedAt = Date.now();
    this._saveState();
    this._saveTurnFile(record);
    return JSON.parse(JSON.stringify(record));
  }

  // ============================================================================
  // Resend & Auto-Recovery（2026-05-03）— prompt 元数据 API
  // ============================================================================
  // 设计：dispatch 前 recordTurnPrompt 把当前轮 prompt 落到 _activePrompts，
  //   resendCurrentPrompt 时从这里取；completeTurn/rollbackTurn 节流删 promptBy
  //   只保留 promptHeaderBy（指纹）+ sendStatus（调试）到 turn record 长存。
  //   节流策略详见 docs/superpowers/specs/2026-05-03-roundtable-resend-and-auto-recovery-design.md

  recordTurnPrompt(turnNum, sid, prompt) {
    // _activePrompts 不持久化（临时数据，crash 后无 resend 语义损失）
    if (!this.state._activePrompts) this.state._activePrompts = {};
    if (!this.state._activePrompts[turnNum]) {
      this.state._activePrompts[turnNum] = { promptBy: {}, promptHeaderBy: {}, sendStatus: {} };
    }
    const slot = this.state._activePrompts[turnNum];
    slot.promptBy[sid] = String(prompt || '');
    slot.promptHeaderBy[sid] = String(prompt || '').split('\n')[0] || '';
  }

  setSendStatus(turnNum, sid, status) {
    // _activePrompts 不持久化（临时数据，crash 后无 resend 语义损失）
    if (!this.state._activePrompts) return;
    if (!this.state._activePrompts[turnNum]) return;
    this.state._activePrompts[turnNum].sendStatus[sid] = status;
  }

  getActivePrompt(turnNum) {
    if (!this.state._activePrompts) return null;
    return this.state._activePrompts[turnNum] || null;
  }
}

// meeting-create-modal（2026-05-01）：判断 aiStats 是不是老 kind 索引格式（含
//   claude/gemini/codex/deepseek/glm 顶层 key），用于 setMeetingContext 时触发迁移。
//
// 2026-05-02 修复：旧版本仅检测 ['claude', 'gemini', 'codex']，DeepSeek/GLM 用户从老
//   版本升级时迁移条件不命中 → 累计统计漂浮。改为遍历 ALL_AI_KINDS（来自 core/ai-kinds.js），
//   单一真理源，未来加新 AI 自动覆盖。
function _isLegacyKindKeyed(stats) {
  if (!stats || typeof stats !== 'object') return false;
  return ALL_AI_KINDS.some(k => stats[k] && typeof stats[k] === 'object'
    && (typeof stats[k].totalThinkSec === 'number' || typeof stats[k].totalTokens === 'number'));
}

// 把 kind 索引的老 aiStats 重写成 sid 索引。sidToInfoMap 是 { sid: {kind, model} }，
//   通常由 main.js 从当前 meeting.subSessions + sessions[sid].kind/currentModel 构造。
//   多个 sid 同 kind 时（比如 3 个 Claude），老格式聚合的累计值会划给第一个匹配的 sid，
//   其余 sid 起 0 — 因为老数据本来就是按 kind 共用，无法精准还原到具体 sid。
//   迁移失败（无任何 sid 匹配上）返回空对象 {}（per spec §4.4：丢累计统计不影响功能）。
function migrateAiStats(stats, sidToInfoMap) {
  if (!stats || typeof stats !== 'object') return {};
  if (!_isLegacyKindKeyed(stats)) return stats;
  // 边界保护：sidToInfoMap 为空时直接保留原 stats —— 否则会落盘空对象覆盖老数据（数据丢失）。
  // 调用方（setMeetingContext）确保只在拿到非空 sidInfo 时调，但这里多一层兜底。
  const sidEntries = Object.entries(sidToInfoMap || {}).filter(([sid, info]) => sid && info);
  if (sidEntries.length === 0) return stats;
  const migrated = {};
  const used = new Set();
  for (const [sid, info] of sidEntries) {
    const k = info.kind;
    const old = stats[k];
    if (old && !used.has(k)) {
      migrated[sid] = {
        totalThinkSec: old.totalThinkSec || 0,
        totalTokens: old.totalTokens || 0,
        perTurnHistory: Array.isArray(old.perTurnHistory) ? old.perTurnHistory.slice() : [],
        kind: k,
        model: info.model || null,
      };
      used.add(k); // 同 kind 多 sid 时只迁第一个
    } else {
      // 同 kind 已被消费，或老数据无此 kind → 起 0 累加器
      migrated[sid] = {
        totalThinkSec: 0,
        totalTokens: 0,
        perTurnHistory: [],
        kind: k || null,
        model: info.model || null,
      };
    }
  }
  return migrated;
}

// 单例池：每会议室一个 orchestrator
const _pool = new Map();
function getOrchestrator(hubDataDir, meetingId, scene) {
  const key = `${hubDataDir}::${meetingId}`;
  if (!_pool.has(key)) _pool.set(key, new RoundtableOrchestrator(hubDataDir, meetingId, scene));
  const orch = _pool.get(key);
  if (scene) orch.scene = scene;
  return orch;
}
function releaseOrchestrator(hubDataDir, meetingId) {
  const key = `${hubDataDir}::${meetingId}`;
  _pool.delete(key);
}

module.exports = {
  RoundtableOrchestrator,
  getOrchestrator,
  releaseOrchestrator,
  migrateAiStats,
  _isLegacyKindKeyed,
  SOFT_ALERT_T1_MS,
  SOFT_ALERT_T2_MS,
};
