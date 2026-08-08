'use strict';

const fs = require('fs');
const path = require('path');
const { KIND_LABELS } = require('./ai-kinds.js');

// 投研场景反空话禁用词：命中即要求重写为有数字/来源的判断。
const BANNED_PHRASES = ['基本面良好', '前景广阔', '值得关注', '拭目以待', '综合来看值得', '具有投资价值'];

const STATE_VERSION = 2;

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
      messages: [],
      lastDeliveredIdx: {},
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
          meetingId: this.meetingId,
          messages: Array.isArray(raw.messages) ? raw.messages : [],
          lastDeliveredIdx: raw.lastDeliveredIdx && typeof raw.lastDeliveredIdx === 'object' ? raw.lastDeliveredIdx : {},
        };
        // 2026-07-20 道雪 [修#9]：崩溃/重启后的悬空轮标记——用户消息所在轮没有任何
        //   turn 记录时，给该消息打"已被重启打断"标记（此前问题孤悬、无任何提示）。
        const turnNums = new Set((this.state.turns || []).map(t => t && t.n));
        let touched = false;
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
        if (touched) this._saveState();
      }
    } catch (e) {
      console.warn(`[groupchat] load state failed for ${this.meetingId}:`, e.message);
    }
  }

  _saveState() {
    const fp = this._stateFilePath();
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(this.state, null, 2), 'utf-8');
  }

  getState() {
    return _clone(this.state);
  }

  beginTurn(userInput, opts = {}) {
    const requestedTurnNum = Number(opts.turnNum);
    const n = Number.isInteger(requestedTurnNum) && requestedTurnNum > 0
      ? requestedTurnNum
      : (this.state.currentTurn || 0) + 1;
    const appendUserMessage = opts.appendUserMessage !== false;
    this.state.currentTurn = Math.max(this.state.currentTurn || 0, n);
    this.state.currentMode = 'group';
    let msg = this.state.messages.find(m => m.id === `u${n}` && m.role === 'user') || null;
    let didAppendUserMessage = false;
    if (appendUserMessage && !msg) {
      msg = this._appendMessage({
        id: `u${n}`,
        turnNum: n,
        role: 'user',
        speaker: '你',
        content: userInput || '',
      });
      didAppendUserMessage = true;
    }
    this._saveState();
    return { turnNum: n, userMessage: msg, didAppendUserMessage };
  }

  rollbackTurn(turnNum) {
    this.state.messages = this.state.messages.filter(m => m.turnNum !== turnNum);
    this.state.turns = this.state.turns.filter(t => t.n !== turnNum);
    const lastIdx = this.state.messages.length - 1;
    for (const sid of Object.keys(this.state.lastDeliveredIdx || {})) {
      if (this.state.lastDeliveredIdx[sid] > lastIdx) this.state.lastDeliveredIdx[sid] = lastIdx;
    }
    this.state.currentTurn = Math.max(0, ...this.state.turns.map(t => t.n || 0));
    this.state.currentMode = 'idle';
    delete this._activePrompts[turnNum];
    this._saveState();
  }

  _appendMessage(msg) {
    const message = {
      createdAt: Date.now(),
      ...msg,
    };
    message.anchor = rawMessageAnchor(this.meetingId, message.id);
    this.state.messages.push(message);
    return message;
  }

  recordTurnPrompt(turnNum, sid, prompt) {
    if (!this._activePrompts[turnNum]) this._activePrompts[turnNum] = {};
    this._activePrompts[turnNum][sid] = prompt || '';
  }

  getActivePrompt(turnNum) {
    const promptBy = this._activePrompts[turnNum];
    return promptBy ? { promptBy } : null;
  }

  setSendStatus(_turnNum, _sid, _status) {
    // Group chat keeps transient send state in renderer partials; this method
    // preserves the shared watcher recovery contract.
  }

  buildDelta(selfSid, userInput, opts = {}) {
    const lastIdx = this.state.lastDeliveredIdx[selfSid] ?? -1;
    const currentUserMessageAppended = opts.currentUserMessageAppended !== false;
    // [全量注入] 投委会幕间传 includeCommitteeMid:true——把中间幕发言全文注入下一幕，让每个委员看到
    //   队友调研全文（群聊式，dispatchInternalPrompt 用）。自由聊默认 false：中间幕不灌回、只带 outcome
    //   （末轮辩论+收敛），省 token 不灌爆上下文（点6）。
    const includeCommitteeMid = opts.includeCommitteeMid === true;
    const cutoff = currentUserMessageAppended
      ? Math.max(0, this.state.messages.length - 1)
      : this.state.messages.length;
    const newMsgs = this.state.messages
      .slice(lastIdx + 1, cutoff)
      .filter(m => m.role !== 'user' && m.sid !== selfSid && m.content && (includeCommitteeMid || !(m.committeeAct && !m.committeeOutcome)));
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
    // 一位 AI 先完成、其他成员仍在跑时，patchTurnResult 会先把可用结果写进 messages。
    // 完整 turn 尚未建立时从这些持久消息恢复合并基线，避免最后一个成员结算时把
    // 先到结果（尤其手动同步救回的结果）覆盖或清空。
    if (!isExistingTurn) {
      for (const m of this.state.messages) {
        if (!m || m.role !== 'assistant' || Number(m.turnNum) !== Number(turnNum) || !m.sid) continue;
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
      const _srcPrompt = (this._activePrompts[turnNum] && this._activePrompts[turnNum][sid]) || '';
      // 2026-06-21 道雪：与 patchTurnResult 对齐——仅确有新文本时写正文；
      //   errored/超时返回空文本时保留已有答案，防重发/串行工作流抹掉已生成内容。
      // 2026-07-12 道雪收紧：completed 空文本（process_exit_clean 兜底 settle）同样
      //   不得覆盖——旧规则"成功态无条件写"会让干净退出的 CLI 把已有/已手动同步的
      //   答案抹成空气泡。真理源统一为 by[sid]，消息正文从 by[sid] 取，不再直接用 r.text。
      const _rStatus = r.status || 'completed';
      // trim 判空与渲染层口径一致（多方审查加固）：纯空白文本视为无内容，不覆盖已有答案。
      const _writeContent = !!(r.text && String(r.text).trim().length);
      const _prevStatus = byStatus[sid];
      const _hasManualResult = _prevStatus === 'manual_extracted'
        && !!(by[sid] && String(by[sid]).trim().length);
      const _incomingIsManual = _rStatus === 'manual_extracted';
      // 用户主动同步得到的完整文本优先于随后迟到的自动/退出信号；再次手动同步仍可更新。
      const _acceptIncomingContent = _writeContent && (!_hasManualResult || _incomingIsManual);
      by[sid] = _acceptIncomingContent ? r.text : (by[sid] || '');
      // 状态守卫：本轮已被手动同步（manual_extracted）且新结果没带更有效文本时，
      //   保留 manual_extracted——对齐 waitTurnComplete.onTurnPatched 的同名守卫，
      //   防止"手动救回的答案"在整轮 settle 时又被标回 errored。
      byStatus[sid] = (_hasManualResult && !_incomingIsManual) ? 'manual_extracted' : _rStatus;
      // 空结果（重发失败/干净退出兜底）不把已有 thinkSec/tokens 统计清零（多方审查加固）。
      thinkSecBy[sid] = statsBySid[sid]?.thinkSec || r.thinkSec || thinkSecBy[sid] || 0;
      tokensBy[sid] = statsBySid[sid]?.tokens || (r.tokens && r.tokens.total) || tokensBy[sid] || 0;
      const messageId = `a${turnNum}-${member.memberId || sid.slice(0, 8)}`;
      const _failReason = (byStatus[sid] === 'errored' && r.reason) ? String(r.reason) : null;
      let msg = this.state.messages.find(m => m && m.role === 'assistant'
        && (m.id === messageId || (Number(m.turnNum) === Number(turnNum) && m.sid === sid)));
      if (msg) {
        msg.sid = sid;
        msg.memberId = member.memberId || sid;
        msg.speaker = _memberLabel(member);
        msg.content = by[sid] || '';
        msg.status = byStatus[sid];
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
          sourcePrompt: _srcPrompt,
          ...(_failReason ? { statusReason: _failReason } : {}),
        });
      }
      aiMessages.push(msg);

      const prev = this.state.aiStats[sid] || { totalThinkSec: 0, totalTokens: 0, turns: 0 };
      prev.totalThinkSec += thinkSecBy[sid] || 0;
      prev.totalTokens += tokensBy[sid] || 0;
      prev.turns += 1;
      prev.kind = member.kind || prev.kind;
      prev.model = member.model || prev.model;
      this.state.aiStats[sid] = prev;
    }

    if (!turn) {
      turn = {
        n: turnNum,
        mode: 'group',
        userInput: userInput || '',
        by,
        byStatus,
        thinkSecBy,
        tokensBy,
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
      turn.lastUpdatedAt = Date.now();
      turn.meta = turn.meta && typeof turn.meta === 'object' ? turn.meta : {};
      if (opts.dispatchMode) turn.meta.dispatchMode = opts.dispatchMode;
    }
    this.state.currentMode = 'idle';
    delete this._activePrompts[turnNum];
    const lastIdx = this.state.messages.length - 1;
    for (const r of results) {
      this.state.lastDeliveredIdx[r.sid] = Number.isInteger(r.deliveredIdx) ? r.deliveredIdx : lastIdx;
    }
    this._saveState();
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
    }
    this._saveState();
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

  clearTurnInProgress(turnNum) {
    if (!turnNum || this.state.currentTurn !== turnNum) return;
    this.state.currentMode = 'idle';
    delete this._activePrompts[turnNum];
    this._saveState();
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
    let msg = this.state.messages.find(m => m && Number(m.turnNum) === Number(turnNum) && m.role === 'assistant' && m.sid === sid);
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
        ...(sourcePrompt ? { sourcePrompt } : {}),
      });
    } else {
      if (_acceptIncomingContent) msg.content = text;
      msg.status = _finalStatus;
      if (memberId) msg.memberId = memberId;
      if (speaker) msg.speaker = speaker;
      if (sourcePrompt && !msg.sourcePrompt) msg.sourcePrompt = sourcePrompt;
    }
    msg.patchedAt = patchedAt;
    if (typeof thinkSec === 'number') msg.thinkSec = thinkSec;
    if (tokens && typeof tokens.total === 'number') msg.tokens = tokens.total;
    if (_finalStatus === 'errored' && statusReason) msg.statusReason = String(statusReason);
    else if (_acceptIncomingContent) delete msg.statusReason;

    this._saveState();
    if (turn) return _clone(turn);
    return _clone({
      n: turnNum,
      inProgress: true,
      userInput: userMsg.content || '',
      by,
      byStatus,
      thinkSecBy,
      tokensBy,
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
  _private: { buildSystemPromptText, RESEARCH_SCENE_PROMPT, COMMITTEE_DISCIPLINE },
};
