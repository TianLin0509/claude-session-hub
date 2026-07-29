'use strict';
// core/transcript-tap.js
//
// 统一 Transcript 抽取适配器：从各 CLI（Claude / Codex / Gemini / Kimi）自动落盘的
// 权威 transcript 文件读取最后一轮 AI 回答，替代会议室 SM-START/SM-END 标识符协议。
//
// 路径（已在 2026-04-25 实测确认）：
//   Claude:  ~/.claude/projects/<slug>/<sid>.jsonl        每行 {type:"assistant|user|tool_*"}
//   Codex:   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl 末行 task_complete.last_agent_message
//   Gemini:  ~/.gemini/tmp/<dir>/chats/session-*.jsonl    行 type:"gemini" 带 tokens 字段
//
// 完成信号：
//   Claude:  Stop hook 触发（main.js /api/hook/stop 路由调 notifyClaudeStop）
//   Codex:   rollout JSONL 末尾出现 task_complete 事件
//   Gemini:  JSONL 新增 type:"gemini" 行且 tokens.total != null（非流式中间态）
//
// Fallback：若任一 Tap 未捕获（hook 未触发 / 文件路径漂移 / CLI 版本不兼容），

const { EventEmitter } = require('events');
const { isClaudeFamily, isCodexCliKind, isKimiCliKind } = require('./ai-kinds.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { parseClaudeTranscriptToTurns } = require('./claude-transcript-parser');
const {
  isCodexTopLevelRolloutMeta,
  readCodexRolloutMeta,
} = require('./codex-transcript-parser.js');
const { JsonlTail } = require('./jsonl-tail.js');
const { codexTextFromPayload, timestampToMs } = require('./transcript-payload-utils.js');
const { KimiTap } = require('./kimi-transcript-tap.js');
const {
  extractCwdFromTranscript,
  findTranscriptByCCSessionId,
  listClaudeTranscriptsForCwd,
} = require('./claude-transcript-locator.js');

// ---------------------------------------------------------------------------
// JsonlTail — 共用工具：监听 JSONL 文件增长，按行回调 JSON.parse 后的对象
// ---------------------------------------------------------------------------
// 设计：
// - fs.watch 监听文件事件（Windows ConPTY 偶发丢事件，降级 500ms 轮询 mtime）
// - 维护 offset，每次增长从 offset 读到尾，按 \n 切行
// - StringDecoder 处理 UTF-8 跨 chunk 边界
// - onLine 回调的异常静默吞掉（单行坏不影响整体）

// ---------------------------------------------------------------------------
// ClaudeTap — Stop hook 驱动，直接读 transcript JSONL 尾部找 last assistant
// ---------------------------------------------------------------------------
// Claude Code 的 transcript 由 CC CLI 自己写入，Hub 通过 Stop hook 拿到路径。
// 相比 Codex/Gemini 不需要 fs.watch——hook 触发即代表 agent loop 完整结束，
// 此时尾部 assistant 条目必已 flush。

// Card optimization Task 1（2026-05-01）— ClaudeTap 升级流式 tail：
//   旧实现：只在 Stop hook 触发时一次性读 transcript 末尾的 last assistant；renderer 看不到 thinking/tool_use。
//   新实现：notifyStop 首次拿到 transcriptPath 后，启动 JsonlTail；
//          后续每条新 assistant message_id 块（thinking / text / tool_use）累积到 _streamingBuf；
//          getStreamingText / clearStreamingBuf 暴露给上层（main.js groupChatWatcher.extractStreamingText 优先使用）。
//   降级：notifyStop 永不被调用 → _streamingBuf 永远空 → main.js 走 PTY 兜底（既有体验，不回归）。
//
// 2026-05-02 根治升级（Bug "DeepSeek/GLM 卡片不更新"）：
//   旧链路：Stop hook 触发 → notifyStop → emit 'turn-complete' → watcher settle
//   断点：Stop hook 因任何原因没触发（CLI 自我退出 / hook 5s timeout / settings.json 漂移）→ 永不 emit
//         → watcher 无限等待 → 卡片停在上一轮
//   根治：JsonlTail.onLine 看到新 assistant 行时启动 5s idle timer，连续 5s 无新行视为本轮答完，
//         **主动 emit 'turn-complete'**（兜底信号）。Stop hook 仍是快路径：来了立即 emit + 取消 timer。
const _CLAUDE_STREAM_BUF_MAX_BYTES = 50000;
// 2026-05-03 道雪 R3：用 Claude 自带的 message.stop_reason 语义信号判定本轮真结束。
//   原 5s idle 启发式在 tool_use 边界后误触发 — Claude 等 tool_result + 思考可达 27-67s
//   静默（无新 assistant 行），被 hub 当成"本轮答完"主动 emit，导致后续真答案 M2（4647 字）
//   到达 transcript 时 watcher 已 settle 无人监听，卡片永远定格在 M1 首句。
//   R3 主路径：onLine 看到 stop_reason ∈ {end_turn, max_tokens, refusal} 立即（200ms 防抖）emit；
//             "tool_use" / null 不 emit，等下一条 message。
//   90s idle 仅留作"transcript 完全卡死/写入异常"的最终兜底，不再是主路径。
const _CLAUDE_STOP_REASON_DEBOUNCE_MS = 200;
// 2026-05-05 道雪：从 90s 缩回 15s。R3 之前 5s idle 误触发的根因不是时长，是 readLast
//   会把 tool_use 行的"我先读取..."中间 text 当成本轮答案 emit。现在 _scheduleIdleEmit
//   改用 readLastTerminalAssistantTextFromClaudeTranscript 终态过滤（只接受 stop_reason
//   ∈ {end_turn, max_tokens, refusal}），中间态行被跳过 → 时长可以安全缩短。
//   兜底场景：transcript 写入异常 / Stop hook 没触发 / stop_reason 字段缺失。
//   15s 取舍：足够等待 transcript 异步刷盘 + fs.watch 漂移，又不至于让用户卡得明显。
const _CLAUDE_IDLE_EMIT_MS = 15 * 1000;

// B1 修复（2026-07-29 道雪）—— "全新 Claude 会话的第 1 轮拿不到 blocks"。
//   旧链路：JsonlTail 只在 notifyStop 里创建，而 notifyStop 由 Stop hook 驱动、
//           Stop hook 只在**本轮结束时**才响 → 首轮全程 _streamingBuf 结构性恒空
//           → 群聊 extractStreamingText 拿不到 tap 数据 → 卡片恒显示「💭 思考中…」。
//   新链路：不再等 Stop hook，三条早绑通道按可信度排序，先到先绑（_ensureTail 幂等）：
//     1) registerSession 拿到 transcriptPath / ccSessionId（resume、fork、已知绑定）→ 立即建 tail；
//     2) UserPromptSubmit hook（notifyPrompt）→ CC 自己给的权威路径，且该 hook 在
//        assistant 任何一行落盘之前同步触发，从当前 EOF 起 tail 就能覆盖本轮全部块；
//     3) 全新会话首轮连 ccSessionId 都还没有 → 轮询 cwd 对应的 projects/<slug> bucket，
//        等新 jsonl 出现（对齐 KimiTap 扫 session_index、GeminiTap 扫 chats/ 的既有做法）。
//   歧义保护：同一 cwd 下若同时冒出多个新 jsonl（例如一个群聊里两位 Claude 成员），
//     发现期一律不猜，等通道 1/2 的权威路径 —— 绑错文件比晚绑更糟。
const _CLAUDE_DISCOVERY_POLL_MS = 500;
// 发现期回放整个新文件时的上限，与 Codex/Kimi tail 同口径。
const _CLAUDE_TAIL_MAX_INITIAL_BYTES = 8 * 1024 * 1024;

// 2026-05-02 Gemini 兜底：与 ClaudeTap 同套 idle-timer 思路。用户血泪反馈：
//   "第一轮 Gemini 子 session 输出后没快速提取，手动提取后流程继续"。
// 根因：GeminiTap.onLine 仅 L1a result_event / L1b message_update / L3 tokens.total
//   三种情况触发 emit。第一轮启动慢时 token 计数延迟到达，三个信号都没到 → 卡片永远
//   停在 streaming，需要用户手动点"一键提取"。
// 兜底：每条带 content 的 gemini 行重置 5s timer，连续 5s 无新行 → 主动 emit
//   turn-complete（signalSource=idle_timer_5s）。L1/L3 抢先时取消 timer。
const _GEMINI_IDLE_EMIT_MS = 5000;

class ClaudeTap extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._parserService = opts.parserService || null;
    this._bound = new Map(); // hubSessionId → { transcriptPath, lastText, _streamingBuf, _tail }
    // B1: 发现期用。homeDir / pollMs 只为单测可注入，生产不传走默认。
    this._homeDir = opts.homeDir || null;
    this._discoveryPollMs = Number(opts.discoveryPollMs) > 0
      ? Number(opts.discoveryPollMs)
      : _CLAUDE_DISCOVERY_POLL_MS;
    this._claimedPaths = new Map(); // normalized transcript path → hubSessionId（一文件只归一会话）
    this._discoveryTimer = null;
  }

  _newEntry() {
    return {
      transcriptPath: null,
      lastText: null,
      lastModel: null,    // T13: 最近一条 assistant message.model
      lastUsage: null,    // T13: 最近一条 assistant message.usage
      _streamingBuf: [],
      _tail: null,
      _idleTimer: null,
      _stopReasonTimer: null,  // R3: stop_reason 终态防抖 timer
      _pendingEmitText: null,
      // B1 早绑状态
      kind: null,
      cwd: null,
      ccSessionId: null,
      registeredAt: Date.now(),
      _tailPath: null,        // 当前 tail 监听的文件（归一化，用于幂等 + 认领）
      _tailSource: null,      // 'register' | 'locator_cc_sid' | 'prompt_hook' | 'stop_hook' | 'cwd_discovery'
      _tailStartedAt: null,
      _discovering: false,
      _preexistingPaths: null, // 注册瞬间 bucket 里已存在的 jsonl（不是本会话的）
    };
  }

  registerSession(hubSessionId, ctx = {}) {
    if (!this._bound.has(hubSessionId)) this._bound.set(hubSessionId, this._newEntry());
    const entry = this._bound.get(hubSessionId);
    if (ctx && ctx.kind) entry.kind = ctx.kind;
    if (ctx && ctx.cwd) entry.cwd = ctx.cwd;
    if (ctx && ctx.ccSessionId) entry.ccSessionId = ctx.ccSessionId;
    if (ctx && Number(ctx.registeredAt) > 0) entry.registeredAt = Number(ctx.registeredAt);
    if (ctx && typeof ctx.transcriptPath === 'string' && ctx.transcriptPath) {
      entry.transcriptPath = ctx.transcriptPath;
    }

    // B1 通道 1：路径已知（resume / fork / 已持久化绑定）→ 立即建 tail，首轮就有流式。
    //   startAtEnd:true —— 老 transcript 里全是上几轮内容，回放只会污染 _streamingBuf
    //   并让历史 stop_reason 终态行误触发 turn-complete。
    let known = entry.transcriptPath;
    if (!known && entry.ccSessionId) {
      known = this._locateByCCSessionId(entry.ccSessionId);
      if (known) entry.transcriptPath = known;
    }
    if (known) {
      void this._ensureTail(hubSessionId, known, { startAtEnd: true, source: 'register' });
      return;
    }

    // B1 通道 3：全新会话 —— jsonl 还没被 CLI 创建。先记下 bucket 里"注册前就存在"的
    //   文件（那些属于别的会话），之后只认新出现的那一个。
    //   重复 registerSession（session-handlers 的重建路径会再调一次）不得重拍快照 ——
    //   否则本会话刚创建出来的 jsonl 会被当成"注册前就有"，永远绑不上。
    if (entry.cwd) {
      if (!entry._preexistingPaths) {
        entry._preexistingPaths = new Set(
          this._listCwdTranscripts(entry).map(f => normalizePathForCompare(f.path))
        );
      }
      entry._discovering = true;
      this._ensureDiscoveryTimer();
    }
  }

  hasSession(hubSessionId) {
    return this._bound.has(hubSessionId);
  }

  unregisterSession(hubSessionId) {
    const entry = this._bound.get(hubSessionId);
    if (entry?._tail) {
      try { entry._tail.close(); } catch {}
      entry._tail = null;
    }
    if (entry?._tailPath && this._claimedPaths.get(entry._tailPath) === hubSessionId) {
      this._claimedPaths.delete(entry._tailPath);
    }
    if (entry?._idleTimer) {
      try { clearTimeout(entry._idleTimer); } catch {}
    }
    if (entry?._stopReasonTimer) {
      try { clearTimeout(entry._stopReasonTimer); } catch {}
    }
    this._bound.delete(hubSessionId);
    this._stopDiscoveryTimerIfIdle();
  }

  // -------------------------------------------------------------------------
  // B1: tail 生命周期（幂等建 / 换文件重绑 / 关闭）
  // -------------------------------------------------------------------------
  //   同一文件重复调 → 直接返回 false，绝不建第二个 tail（双 tail = 双份 blocks）。
  //   换文件（发现期猜的路径被 hook 的权威路径推翻）→ 关旧 tail、清掉错文件累计的
  //   blocks，再建新 tail。opts.authoritative 表示路径来自 CC 自己（hook / ccSessionId
  //   精确定位），可以抢占别的会话对同一文件的认领。
  async _ensureTail(hubSessionId, transcriptPath, opts = {}) {
    if (!hubSessionId || !transcriptPath) return false;
    const entry = this._bound.get(hubSessionId);
    if (!entry) return false;
    const key = normalizePathForCompare(transcriptPath);
    if (entry._tail && entry._tailPath === key) {
      entry.transcriptPath = transcriptPath;
      entry._discovering = false;
      return false;   // 已在监听同一文件 —— 幂等，不重复建
    }

    const owner = this._claimedPaths.get(key);
    if (owner && owner !== hubSessionId) {
      if (!opts.authoritative) return false;  // 非权威来源不抢别人的文件
      const victim = this._bound.get(owner);
      if (victim && victim._tailPath === key) {
        try { victim._tail?.close(); } catch {}
        victim._tail = null;
        victim._tailPath = null;
        victim._streamingBuf = [];
        victim._discovering = !!victim.cwd;
        if (victim._discovering) this._ensureDiscoveryTimer();
      }
      this._claimedPaths.delete(key);
    }

    if (entry._tail) {
      try { entry._tail.close(); } catch {}
      if (entry._tailPath && this._claimedPaths.get(entry._tailPath) === hubSessionId) {
        this._claimedPaths.delete(entry._tailPath);
      }
      entry._tail = null;
      entry._streamingBuf = [];   // 之前那个文件的块不属于本会话，整体丢弃
    }

    entry.transcriptPath = transcriptPath;
    entry._tailPath = key;
    entry._tailSource = opts.source || 'unknown';
    entry._tailStartedAt = Date.now();
    entry._discovering = false;
    entry._preexistingPaths = null;
    this._claimedPaths.set(key, hubSessionId);
    this._stopDiscoveryTimerIfIdle();

    // startAtEnd 语义（边界 3）：
    //   - 文件尚不存在或为空 → JsonlTail 的 stat 失败/size=0，offset 天然停在 0，
    //     文件一旦被 CLI 创建就从第 0 字节读起，首轮一行不漏（两种取值等价）。
    //   - 发现期绑定的是"注册之后才出现"的新文件 → startAtEnd:false 整份回放，
    //     补上建 tail 之前那 ≤500ms 已落盘的行。
    //   - 其余（resume / hook 给的老文件）→ startAtEnd:true，不回放历史。
    const tail = new JsonlTail(transcriptPath, this._makeOnLine(hubSessionId, entry), {
      startAtEnd: opts.startAtEnd !== false,
      maxInitialBytes: _CLAUDE_TAIL_MAX_INITIAL_BYTES,
    });
    entry._tail = tail;
    try { await tail.start(); } catch { /* JsonlTail 内部已吞 IO 错误，这里只兜异常 */ }
    return true;
  }

  _locateByCCSessionId(ccSessionId) {
    if (!ccSessionId) return null;
    try {
      return this._homeDir
        ? findTranscriptByCCSessionId(ccSessionId, this._homeDir)
        : findTranscriptByCCSessionId(ccSessionId);
    } catch { return null; }
  }

  _listCwdTranscripts(entry) {
    if (!entry || !entry.cwd) return [];
    try {
      return listClaudeTranscriptsForCwd(entry.cwd, {
        kind: entry.kind,
        ...(this._homeDir ? { homeDir: this._homeDir } : {}),
      });
    } catch { return []; }
  }

  _ensureDiscoveryTimer() {
    if (this._discoveryTimer) return;
    this._discoveryTimer = setInterval(() => {
      try { this._scanForNewTranscripts(); }
      catch (e) { console.warn('[claude-tap] discovery scan failed:', e && e.message); }
    }, this._discoveryPollMs);
    this._discoveryTimer.unref?.();
  }

  _stopDiscoveryTimerIfIdle() {
    if (!this._discoveryTimer) return;
    for (const entry of this._bound.values()) {
      if (entry._discovering && !entry._tail) return;
    }
    clearInterval(this._discoveryTimer);
    this._discoveryTimer = null;
  }

  // 边界 1：transcript 此刻不存在不是放弃的理由 —— 只要会话还注册着就一直等。
  _scanForNewTranscripts() {
    for (const [hubSessionId, entry] of this._bound) {
      if (!entry._discovering || entry._tail) continue;

      // 用户开了会话但迟迟不发第一句时，transcript 可能几小时都不出现。降频到 2s，
      // 免得 Electron 主线程被无意义的 readdir 长期占用（仍然不放弃，见边界 1）。
      entry._scanTick = (entry._scanTick || 0) + 1;
      const stride = (Date.now() - entry.registeredAt) > 120000 ? 4 : 1;
      if (entry._scanTick % stride !== 0) continue;

      // ccSessionId 可能在发现期途中由 hook 补上 → 精确定位优先于目录启发式
      if (entry.ccSessionId) {
        const exact = this._locateByCCSessionId(entry.ccSessionId);
        if (exact) {
          // 走到这里说明注册时就带了 ccSessionId（resume/fork）但文件当时还没落地，
          // 现在出现的很可能是带历史的老 transcript → startAtEnd:true 不回放；
          // 文件此刻仍为空时 JsonlTail 的 offset 天然是 0，首轮照样一行不漏。
          void this._ensureTail(hubSessionId, exact, {
            startAtEnd: true, authoritative: true, source: 'locator_cc_sid',
          });
          continue;
        }
      }

      const fresh = this._listCwdTranscripts(entry).filter((f) => {
        const key = normalizePathForCompare(f.path);
        if (entry._preexistingPaths && entry._preexistingPaths.has(key)) return false;
        if (this._claimedPaths.has(key)) return false;
        return this._transcriptCwdMatches(f.path, entry.cwd);
      });
      // 边界 4：多于一个候选 = 无法确定绑定到本会话 → 不猜，等权威路径。
      if (fresh.length !== 1) continue;
      void this._ensureTail(hubSessionId, fresh[0].path, {
        startAtEnd: false, source: 'cwd_discovery',
      });
    }
    this._stopDiscoveryTimerIfIdle();
  }

  // bucket 目录本来就是 cwd 的 slug，这层校验是为了防 slug 碰撞（不同 cwd 归一成同名
  // 目录）。刚创建的 jsonl 首行可能还没有 cwd 字段 → 拿不到就放行，不做假阴性拒绝。
  _transcriptCwdMatches(transcriptPath, cwd) {
    if (!cwd) return true;
    let recorded = null;
    try { recorded = extractCwdFromTranscript(transcriptPath); } catch { recorded = null; }
    if (!recorded) return true;
    return normalizePathForCompare(recorded) === normalizePathForCompare(cwd);
  }

  // 资源收尾（边界 6）：关掉全部 tail + 发现期 timer，不留 fd / interval。
  dispose() {
    for (const id of Array.from(this._bound.keys())) this.unregisterSession(id);
    this._claimedPaths.clear();
    if (this._discoveryTimer) {
      clearInterval(this._discoveryTimer);
      this._discoveryTimer = null;
    }
  }

  getDebugSnapshot() {
    const out = [];
    for (const [hubSessionId, entry] of this._bound) {
      out.push({
        hubSessionId,
        kind: entry.kind,
        cwd: entry.cwd,
        ccSessionId: entry.ccSessionId,
        transcriptPath: entry.transcriptPath,
        hasTail: !!entry._tail,
        tailSource: entry._tailSource,
        tailStartedAt: entry._tailStartedAt,
        discovering: !!entry._discovering,
        streamingBlocks: Array.isArray(entry._streamingBuf) ? entry._streamingBuf.length : 0,
      });
    }
    return { discoveryActive: !!this._discoveryTimer, sessions: out };
  }

  getLastAssistantText(hubSessionId) {
    const e = this._bound.get(hubSessionId);
    return e?.lastText || null;
  }

  // 2026-05-02 Bug 修复：扩展手动提取支持 Claude/DeepSeek/GLM。
  //   旧版本仅 GeminiTap 有 extractLatestGeminiTurn → 用户对 Claude/DeepSeek/GLM 卡片点
  //   "一键提取"永远拿到 null，UI 显"提取失败"——按钮形同虚设。
  //   新版本：复用 parseClaudeTranscriptToTurns 读 transcript 末尾的合并 turn，并按
  //   sincePromptTs 做时间窗下界过滤（见下方 2026-07-20 修复说明）。
  //   返回 { text, source } 与 GeminiTap 同形；transcriptPath 未知（hook/scan 都未拿到）→ null。
  //
  // 2026-05-14 道雪：切到合并版 readLastAssistantTurnMergedTextFromClaudeTranscript，
  //   修群聊只拿到 [3] recap 段的 bug（plan 段在首条 entry，旧函数只读末条）。
  //
  // 2026-07-20 道雪 [修#1]：补上 sincePromptTs 时间窗下界。旧版忽略该参数 —— AI 卡住
  //   /思考中时 transcript 最后一个完整 turn 是「上一轮」的答案，一键提取会把它抓进
  //   本轮（张冠李戴）。现在末轮完成时间早于本轮 prompt 5s 以上 → 视为旧答案拒绝提取。
  async extractLatestTurn(hubSessionId, sincePromptTs = 0) {
    const entry = this._bound.get(hubSessionId);
    if (!entry || !entry.transcriptPath) return null;
    let last = null;
    try {
      const turns = this._parserService
        ? (await this._parserService.parse('claude', entry.transcriptPath, { limit: 1, fromTail: true })).turns
        : parseClaudeTranscriptToTurns(entry.transcriptPath, { limit: 1, fromTail: true });
      last = turns[turns.length - 1];
    } catch { return null; }
    if (!last || last.role !== 'assistant') return null;
    const turnEndMs = last.tsEnd || last.ts || 0;
    if (sincePromptTs && turnEndMs && turnEndMs < sincePromptTs - 5000) return null;
    const text = typeof last.text === 'string' ? last.text.trim() : '';
    if (!text) return null;
    return { text, source: 'manual_claude_transcript' };
  }

  getStreamingText(hubSessionId) {
    const e = this._bound.get(hubSessionId);
    if (!e || !Array.isArray(e._streamingBuf) || e._streamingBuf.length === 0) return null;
    return [...e._streamingBuf];
  }

  clearStreamingBuf(hubSessionId) {
    const e = this._bound.get(hubSessionId);
    if (e) e._streamingBuf = [];
  }

  // JsonlTail 的 onLine：每条 assistant 行 → 累积 blocks 到 _streamingBuf + 判定终态。
  // 原先内联在 notifyStop 里（导致 tail 只能由 Stop hook 创建），B1 提出来复用给
  // registerSession / notifyPrompt / 发现期三条早绑通道。逻辑逐行保持不变。
  _makeOnLine(hubSessionId, entry) {
    return (obj) => {
      if (obj?.type !== 'assistant' || !obj.message?.content) return;
      const content = obj.message.content;
      if (!Array.isArray(content)) return;
      // T13（2026-06-08）：抽 message.model + message.usage 缓存到 entry，turn emit 时附给卡片视图。
      //   transcript 每行 assistant message 都带这两个字段（CC CLI 包装 anthropic API 响应原样落盘）。
      //   model 形如 "claude-opus-4-7" / "claude-sonnet-4-5"；usage 含 input/output/cache_read/cache_creation。
      //   tool_use 中间行的 usage 是"到目前为止"的累积值（API 行为），所以无脑覆盖到 terminal 行
      //   就是本轮最终值，符合卡片视图"显示本轮消耗"的语义。
      if (typeof obj.message.model === 'string' && obj.message.model) {
        entry.lastModel = obj.message.model;
      }
      if (obj.message.usage && typeof obj.message.usage === 'object') {
        const u = obj.message.usage;
        entry.lastUsage = {
          input_tokens: u.input_tokens || 0,
          output_tokens: u.output_tokens || 0,
          cache_read_input_tokens: u.cache_read_input_tokens || 0,
          cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
        };
      }
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          entry._streamingBuf.push({ type: 'text', text: block.text });
        } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
          entry._streamingBuf.push({ type: 'thinking', text: block.thinking });
        } else if (block.type === 'tool_use' && block.name) {
          entry._streamingBuf.push({
            type: 'tool_use',
            name: block.name,
            input: block.input || {},
          });
        }
      }
      // 50KB 头部截断：从尾部累计，直到超出预算就把更早的丢掉
      let totalLen = 0;
      for (let i = entry._streamingBuf.length - 1; i >= 0; i--) {
        const b = entry._streamingBuf[i];
        const blen = (b.text != null) ? String(b.text).length : JSON.stringify(b.input || {}).length;
        totalLen += blen;
        if (totalLen > _CLAUDE_STREAM_BUF_MAX_BYTES) {
          entry._streamingBuf = entry._streamingBuf.slice(i + 1);
          break;
        }
      }

      // 2026-05-03 道雪 R3：用 Claude 自带的 message.stop_reason 语义信号判定本轮真结束。
      //   终态值 {end_turn, max_tokens, refusal} 是 Claude 主动标的"本轮真完结"，立即（200ms 防抖）emit。
      //   "tool_use" 表明还要等 tool_result + 后续 assistant message，不 emit。
      //   null 表示流式中间态（未 finalize），不 emit。
      //   90s idle timer 仅作 transcript 完全卡死的最终兜底，不再是主路径。
      const stopReason = obj.message.stop_reason;
      const isTerminal = stopReason === 'end_turn' || stopReason === 'max_tokens' || stopReason === 'refusal';
      if (isTerminal) {
        this._scheduleStopReasonEmit(hubSessionId);
      } else {
        // tool_use / null：取消任何 pending stop_reason emit，启动 90s 兜底 idle
        this._cancelStopReasonEmit(hubSessionId);
        this._scheduleIdleEmit(hubSessionId);
      }
    };
  }

  // B1 通道 2 —— 由 main.js 的 /api/hook/prompt（UserPromptSubmit）路由调用。
  //   这是全新会话第 1 轮唯一能在 assistant 任何一行落盘**之前**拿到权威 transcript
  //   路径的信号：CC 会等 hook 进程退出才继续处理 prompt，所以此刻从 EOF 起 tail
  //   必然覆盖本轮全部块，同时不会回放上一轮历史（避免旧 stop_reason 误 emit）。
  //   只建 tail、不 emit —— 完成判定仍归 stop_reason / Stop hook / idle 兜底。
  async notifyPrompt(hubSessionId, transcriptPath, ccSessionId = null) {
    if (!hubSessionId || !transcriptPath) return;
    if (!this._bound.has(hubSessionId)) this._bound.set(hubSessionId, this._newEntry());
    const entry = this._bound.get(hubSessionId);
    if (ccSessionId) entry.ccSessionId = ccSessionId;
    await this._ensureTail(hubSessionId, transcriptPath, {
      startAtEnd: true, authoritative: true, source: 'prompt_hook',
    });
  }

  // 由 main.js 的 /api/hook/stop 路由调用。transcriptPath 是 CC 原生给的
  // ~/.claude/projects/<slug>/<ccSessionId>.jsonl。
  async notifyStop(hubSessionId, transcriptPath) {
    if (!transcriptPath || !hubSessionId) return;
    if (!this._bound.has(hubSessionId)) this._bound.set(hubSessionId, this._newEntry());
    const entry = this._bound.get(hubSessionId);
    entry.transcriptPath = transcriptPath;

    // 首次拿到路径 → 启动 JsonlTail，让后续轮也能流式。
    // notifyStop already parses the latest completed turn below.  Replaying
    // an entire long transcript here only rebuilds historical streaming
    // state on Electron's main thread, so watch from EOF for future turns.
    await this._ensureTail(hubSessionId, transcriptPath, {
      startAtEnd: true, authoritative: true, source: 'stop_hook',
    });

    // Stop hook 触发 → 取消 idle timer + stop_reason timer，走快路径直接读 transcript 末尾立即 emit
    // 2026-05-14 道雪：用合并版读，避免群聊丢失 [1] plan 段（多 entry 合并 bug 修复）
    this._cancelIdleEmit(hubSessionId);
    this._cancelStopReasonEmit(hubSessionId);
    const text = await readLastAssistantTurnMergedTextFromClaudeTranscript(transcriptPath);
    if (text && text !== entry.lastText) {
      entry.lastText = text;
      this.emit('turn-complete', {
        hubSessionId,
        text,
        completedAt: Date.now(),
        signalSource: 'stop_hook',
        // T13: 附带 model + usage 给卡片视图显示真实模型名 + token chip
        modelId: entry.lastModel || null,
        usage: entry.lastUsage || null,
      });
    }
  }

  // 内部：每条新 assistant 行调用一次，重置 idle timer。
  //   timer 触发时（连续 N 秒无新行）从 transcript 末尾读 last assistant 主动 emit。
  //   防重复：emit 前比对 lastText，相同则不再重复 emit。
  // 2026-05-05 道雪：兜底 emit 增加 stop_reason 终态过滤 — 历史 R3 修了"5s idle 拿到
  //   tool_use 行的中间 text 误 emit settle"的 bug，但代价是把 idle 时间拉到 90s，
  //   transcript 写入异常 / stop_reason 字段缺失场景下卡片要等 90s 才更新。
  //   现在让兜底也用 stop_reason 过滤：只在 transcript 末尾真有 terminal 行（end_turn/
  //   max_tokens/refusal）时才 emit，否则视为"还在 thinking/tool_use 中"不 emit。
  //   这样既保留 R3 的防误读，又能把兜底时间安全压到合理范围。
  _scheduleIdleEmit(hubSessionId) {
    const entry = this._bound.get(hubSessionId);
    if (!entry) return;
    if (entry._idleTimer) clearTimeout(entry._idleTimer);
    entry._idleTimer = setTimeout(async () => {
      entry._idleTimer = null;
      if (!entry.transcriptPath) return;
      try {
        // 终态过滤：transcript 末尾必须有 terminal stop_reason 行才 emit
        const result = await readLastTerminalAssistantTextFromClaudeTranscript(entry.transcriptPath);
        if (!result || !result.text || !result.text.trim()) return;
        if (result.text === entry.lastText) return; // 已 emit 过相同内容
        entry.lastText = result.text;
        this.emit('turn-complete', {
          hubSessionId,
          text: result.text,
          completedAt: Date.now(),
          signalSource: 'idle_timer_terminal',
          // T13: 附带 model + usage 给卡片视图显示真实模型名 + token chip
          modelId: entry.lastModel || null,
          usage: entry.lastUsage || null,
        });
      } catch (e) {
        console.warn('[claude-tap] idle-emit read failed:', e.message);
      }
    }, _CLAUDE_IDLE_EMIT_MS);
    entry._idleTimer.unref?.();
  }

  _cancelIdleEmit(hubSessionId) {
    const entry = this._bound.get(hubSessionId);
    if (entry?._idleTimer) {
      clearTimeout(entry._idleTimer);
      entry._idleTimer = null;
    }
  }

  // R3（2026-05-03 道雪）：stop_reason 终态信号触发的延迟 emit。
  //   onLine 看到 stop_reason ∈ {end_turn, max_tokens, refusal} 时调，200ms 防抖窗口
  //   兼容罕见的"end_turn 后还有续 chunk 落盘"场景。emit 时取消 idle timer 不再兜底。
  _scheduleStopReasonEmit(hubSessionId) {
    const entry = this._bound.get(hubSessionId);
    if (!entry) return;
    // 语义信号优先，取消 idle 兜底
    this._cancelIdleEmit(hubSessionId);
    if (entry._stopReasonTimer) clearTimeout(entry._stopReasonTimer);
    entry._stopReasonTimer = setTimeout(async () => {
      entry._stopReasonTimer = null;
      if (!entry.transcriptPath) return;
      try {
        // 2026-05-14 道雪：用合并版（多 entry 合并 bug 修复）
        const text = await readLastAssistantTurnMergedTextFromClaudeTranscript(entry.transcriptPath);
        if (!text || !text.trim()) return;
        if (text === entry.lastText) return; // 已 emit 过相同内容（如 Stop hook 抢先）
        entry.lastText = text;
        this.emit('turn-complete', {
          hubSessionId,
          text,
          completedAt: Date.now(),
          signalSource: 'stop_reason_terminal',
          // T13: 附带 model + usage 给卡片视图显示真实模型名 + token chip
          modelId: entry.lastModel || null,
          usage: entry.lastUsage || null,
        });
      } catch (e) {
        console.warn('[claude-tap] stop_reason emit read failed:', e.message);
      }
    }, _CLAUDE_STOP_REASON_DEBOUNCE_MS);
    entry._stopReasonTimer.unref?.();
  }

  _cancelStopReasonEmit(hubSessionId) {
    const entry = this._bound.get(hubSessionId);
    if (entry?._stopReasonTimer) {
      clearTimeout(entry._stopReasonTimer);
      entry._stopReasonTimer = null;
    }
  }
}

// Read just the first line of a file (no size limit). Used for session_meta
// headers which can exceed typical buffer sizes (Codex embeds a multi-KB
// base_instructions.text as JSON escaped string in line 1).
function readFirstLine(filepath) {
  return new Promise((resolve, reject) => {
    let stream;
    try { stream = fs.createReadStream(filepath, { encoding: 'utf8' }); }
    catch (e) { return reject(e); }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let done = false;
    rl.on('line', (line) => {
      if (done) return;
      done = true;
      rl.close();
      stream.destroy();
      resolve(line);
    });
    rl.on('close', () => { if (!done) resolve(''); });
    rl.on('error', (e) => { if (!done) { done = true; reject(e); } });
    stream.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

async function readCodexUserMessageEvents(rolloutPath) {
  let raw;
  try { raw = await fs.promises.readFile(rolloutPath, 'utf8'); }
  catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (obj?.type !== 'event_msg' || obj.payload?.type !== 'user_message') continue;
    const text = codexTextFromPayload(obj.payload).trim();
    if (text) {
      out.push({
        text,
        submittedAt: timestampToMs(obj.timestamp) || 0,
      });
    }
  }
  return out;
}

async function readCodexUserMessages(rolloutPath) {
  return (await readCodexUserMessageEvents(rolloutPath)).map(ev => ev.text);
}

function normalizePromptForCompare(text) {
  return String(text || '').replace(/\r\n/g, '\n').trim();
}

function canonicalizeLongPromptForTuiCompare(text) {
  // Codex TUI 0.144 can drop presentation-only Unicode characters while a
  // bracketed paste crosses the Windows PTY boundary (observed: em dashes and
  // circled list numbers). Keep semantic letters + decimal digits so a long
  // group-chat prompt still binds to its rollout without weakening matching
  // for short prompts where punctuation may be meaningful.
  return normalizePromptForCompare(text)
    .normalize('NFC')
    .replace(/[^\p{L}\p{Nd}]+/gu, '')
    .toLowerCase();
}

function codexPromptMatchesExpected(userMessage, expectedPrompt) {
  const msg = normalizePromptForCompare(userMessage);
  const expected = normalizePromptForCompare(expectedPrompt);
  if (!msg || !expected) return false;
  if (msg === expected) return true;
  if (expected.includes('A UTF-8 group-chat prompt has been saved to this file:')) {
    return msg.includes(expected);
  }
  const expectedCanonical = canonicalizeLongPromptForTuiCompare(expected);
  if (expectedCanonical.length < 80) return false;
  return canonicalizeLongPromptForTuiCompare(msg) === expectedCanonical;
}

// 2026-05-14 道雪：多 entry 合并版 — 修群聊只拿到 [3] recap 段的 bug。
//   Claude CLI 把"1 个 user prompt + N 次工具调用"拆成 N+1 条 assistant entry，
//   中间 stop_reason='tool_use'、末条 stop_reason='end_turn'。旧版
//   readLastAssistantMessageFromClaudeTranscript 只读末条，导致首条 entry 的 text
//   （三段式输出里就是 [1] plan）丢失。
//   复用 parseClaudeTranscriptToTurns 的 _mergeConsecutiveAssistantTurns 把 N+1 条
//   合并成 1 个 logical turn 后取 text。limit=1 + fromTail 让 parser 只解析末尾窗口，
//   避免大 transcript 全量读。
//   未完成轮（stop_reason 一直 'tool_use'）→ 合并器 acc 不 flush → turns 为空或末轮
//   不存在 → 返回 null，与旧函数 null 兜底语义一致（不向群聊 emit 半截内容）。
//   返回纯字符串（与旧函数同形），便于 4 处出口直接替换。
async function readLastAssistantTurnMergedTextFromClaudeTranscript(transcriptPath) {
  try {
    const turns = parseClaudeTranscriptToTurns(transcriptPath, { limit: 1, fromTail: true });
    const last = turns[turns.length - 1];
    if (!last || last.role !== 'assistant') return null;
    const text = typeof last.text === 'string' ? last.text.trim() : '';
    return text || null;
  } catch {
    return null;
  }
}

// 2026-05-05 道雪：终态 stop_reason 过滤版本 — 用于 idle 兜底 emit。
// 从尾部向前扫，找第一个 stop_reason ∈ {end_turn, max_tokens, refusal} 且 content
// 含 text 块的 assistant message。
// 与 readLastAssistantMessageFromClaudeTranscript 的区别：本函数会跳过 stop_reason='tool_use'
// 等中间态行（这些行的 text 块是工具调用前的"我先读取..."类中间输出，不是本轮真答案）。
// 返回 { text, stopReason } 或 null（找不到 terminal 行）。
//
// 2026-05-14 道雪 升级：上述老版本只读末条 entry → 群聊丢 [1] plan。改为复用合并版
// readLastAssistantTurnMergedTextFromClaudeTranscript 取整段 turn，stopReason 从
// 合并后的 turn 取（_mergeConsecutiveAssistantTurns 已保证末条决定 stopReason）。
// 终态过滤语义保留：未 flush 的 turn（stop_reason 一直 'tool_use'）合并器返回为空，
// 这里的 null 兜底等价于"还没到终态"。
const _CLAUDE_TERMINAL_STOP_REASONS = new Set(['end_turn', 'max_tokens', 'refusal']);
async function readLastTerminalAssistantTextFromClaudeTranscript(transcriptPath) {
  try {
    const turns = parseClaudeTranscriptToTurns(transcriptPath, { limit: 1, fromTail: true });
    const last = turns[turns.length - 1];
    if (!last || last.role !== 'assistant') return null;
    // _mergeConsecutiveAssistantTurns 已经按 stopReason !== 'tool_use' 终止 flush，
    // 末轮 stopReason 必是 terminal 或末轮根本没 flush 进 turns。这里再 double-check
    // 一次终态过滤保住对老语义的契约（防 parser 未来改 flush 规则误放行 tool_use）。
    if (!_CLAUDE_TERMINAL_STOP_REASONS.has(last.stopReason)) return null;
    const text = typeof last.text === 'string' ? last.text.trim() : '';
    if (!text) return null;
    return { text, stopReason: last.stopReason };
  } catch {
    return null;
  }
}

// Claude transcript JSONL 末尾读取。模式对称于 main.js:readLastUserMessage —
// 从尾部 64KB 切块扫，找第一个完整 type:"assistant" 条目（最近一条），合并
// message.content 里所有 text 块。
async function readLastAssistantMessageFromClaudeTranscript(transcriptPath) {
  const CHUNK = 65536;
  let fh;
  try {
    fh = await fs.promises.open(transcriptPath, 'r');
    const { size } = await fh.stat();
    let pos = size;
    let tail = '';
    while (pos > 0) {
      const readLen = Math.min(CHUNK, pos);
      pos -= readLen;
      const buf = Buffer.alloc(readLen);
      await fh.read(buf, 0, readLen, pos);
      tail = buf.toString('utf8') + tail;
      const lines = tail.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj?.type === 'assistant' && obj.message) {
          const content = obj.message.content;
          if (Array.isArray(content)) {
            const parts = [];
            for (const p of content) {
              if (p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string') {
                parts.push(p.text);
              }
            }
            const joined = parts.join('').trim();
            if (joined) return joined;
          } else if (typeof content === 'string') {
            if (content.trim()) return content.trim();
          }
        }
      }
      if (pos === 0) break;
      tail = lines[0] || '';
    }
    return null;
  } catch {
    return null;
  } finally {
    try { await fh?.close(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// CodexTap — 监听 ~/.codex/sessions/<今日>/ 下新 rollout-*.jsonl 创建，
// 按 (cwd, timestamp) 就近绑定到 Hub session，tail 到 task_complete 触发
// ---------------------------------------------------------------------------
// 挑战：Codex CLI 自己生成 sid，Hub 预先不知道 rollout 文件名。
// 策略：spawn 前记下 (hubSessionId, cwd, spawnTime)，fs.watch 当日目录。
// 新文件创建时读首行 session_meta，匹配 cwd 相同 && timestamp ∈ [spawnTime-5s, spawnTime+60s]
// 的 pending 条目，按 |delta| 最小就近绑定。

const CODEX_SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');

class CodexTap extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.sessionsRoot]    rollout 扫描根目录（默认 ~/.codex/sessions）
   *                                        2026-05-04 codex equiv 引入：单测注入 tmp 目录隔离
   * @param {number} [opts.pollIntervalMs]  scan 间隔（默认 1000ms）
   *                                        2026-05-04 codex equiv 引入：单测压到 50-100ms 加快
   */
  constructor(opts = {}) {
    super();
    this._parserService = opts.parserService || null;
    // 多 sessionsRoot：默认含 ~/.codex/sessions（订阅模式）；API 模式 sub session
    // 走 isolated CODEX_HOME（hubDataDir/codex-api-profile/sessions），registerSession
    // 时按需加入。Set 自动去重。
    this._sessionsRoots = new Set([opts.sessionsRoot || CODEX_SESSIONS_ROOT]);
    this._pollIntervalMs = opts.pollIntervalMs || 1000;
    this._pending = new Map(); // hubSessionId → { cwd, spawnTime }
    this._bound = new Map();   // hubSessionId → { rolloutPath, tail, lastText }
    this._pollTimer = null;
    this._seen = new Set();    // rollout paths we've already processed
    this._scanning = false;    // re-entry guard: setInterval may fire while
                               // a slow scan is still in flight; without this
                               // two scans could both pass _seen.has() then
                               // both _tryBind() and double-bind a file.
  }

  registerSession(hubSessionId, {
    cwd,
    sessionsRoot,
    codexSid,
    transcriptPath,
    allowMtimeFallback = false,
    requirePromptMatch = false,
  } = {}) {
    const normCwd = normalizePathForCompare(cwd || process.cwd());
    if (sessionsRoot) this._sessionsRoots.add(sessionsRoot);
    this._pending.set(hubSessionId, {
      cwd: normCwd,
      spawnTime: Date.now(),
      allowMtimeFallback: !!allowMtimeFallback,
      requirePromptMatch: !!requirePromptMatch,
      expectedPrompt: null,
      expectedPromptAt: null,
    });
    this._ensureWatcher();
    if (transcriptPath) {
      this._bindRolloutToHubSession(hubSessionId, transcriptPath).then((bound) => {
        if (!bound) return;
        this._pending.delete(hubSessionId);
        this._seen.add(transcriptPath);
      }).catch((e) => {
        console.warn('[codex-tap] bind by transcriptPath failed:', e.message);
      });
      return;
    }
    if (codexSid) {
      this._bindByCodexSid(hubSessionId, codexSid).catch((e) => {
        console.warn('[codex-tap] bind by codexSid failed:', e.message);
      });
    }
  }

  hasSession(hubSessionId) {
    return this._pending.has(hubSessionId) || this._bound.has(hubSessionId);
  }

  notePrompt(hubSessionId, prompt) {
    if (!hubSessionId || typeof prompt !== 'string') return;
    const entry = this._pending.get(hubSessionId);
    if (!entry) return;
    entry.expectedPrompt = normalizePromptForCompare(prompt);
    entry.expectedPromptAt = Date.now();
    this._ensureWatcher();
  }

  unregisterSession(hubSessionId) {
    this._pending.delete(hubSessionId);
    const bound = this._bound.get(hubSessionId);
    if (bound) {
      try { bound.tail?.close(); } catch {}
      // P2-1 清理 task_complete debounce 的 pending timer，防 memory leak / unhandled emit
      if (bound._pendingEmitTimer) {
        try { clearTimeout(bound._pendingEmitTimer); } catch {}
      }
      this._bound.delete(hubSessionId);
    }
    if (this._pending.size === 0 && this._bound.size === 0) {
      this._stopWatcher();
    }
  }

  getLastAssistantText(hubSessionId) {
    return this._bound.get(hubSessionId)?.lastText || null;
  }

  getRolloutPath(hubSessionId) {
    return this._bound.get(hubSessionId)?.rolloutPath || null;
  }

  async hasUserMessageSince(hubSessionId, sincePromptTs = 0) {
    const rolloutPath = this.getRolloutPath(hubSessionId);
    if (!rolloutPath) return false;
    const threshold = Math.max(0, Number(sincePromptTs) || 0);
    const events = await readCodexUserMessageEvents(rolloutPath);
    return events.some(ev => (Number(ev.submittedAt) || 0) >= threshold);
  }

  // 2026-05-04 codex equiv extract-failure debug —— 给运行时排查"为什么没 bind"用。
  //   不暴露 timer / tail object / EventEmitter listeners 等内部句柄；
  //   返回值必须 JSON 可序列化（IPC 跨进程边界）。
  getDebugSnapshot() {
    const now = Date.now();
    const pending = [];
    for (const [hubSessionId, entry] of this._pending) {
      pending.push({
        hubSessionId,
        cwd: entry.cwd,
        spawnTime: entry.spawnTime,
        ageMs: now - entry.spawnTime,
        hasExpectedPrompt: !!entry.expectedPrompt,
        expectedPromptAt: entry.expectedPromptAt || null,
      });
    }
    const bound = [];
    for (const [hubSessionId, entry] of this._bound) {
      bound.push({
        hubSessionId,
        rolloutPath: entry.rolloutPath,
        hasLastText: !!entry.lastText,
      });
    }
    return {
      sessionsRoots: Array.from(this._sessionsRoots),
      pending,
      bound,
      seen: Array.from(this._seen),
    };
  }

  // 2026-05-02 Bug 修复：手动提取支持 Codex（同 ClaudeTap.extractLatestTurn 设计）。
  //   优先读 rollout 末尾的 task_complete.last_agent_message。
  //   降级：本轮还在 streaming（task_complete 未写）时拼接 sincePromptTs 之后所有
  //   agent_message.message — codex 一个 turn 内会写多条 commentary phase + 最后一条
  //   final phase 的 agent_message，task_complete 才写在末尾。
  //
  // 2026-05-04 codex equiv（Spec S2）：返回值新增 `extractMode` 字段，4 态契约：
  //   - final_answer          ← rollout 末尾命中 task_complete（含 last_agent_message）
  //   - partial_commentary    ← 仅 agent_message，无 task_complete
  //   - no_task_complete_yet  ← 已绑定但 agent_message 全部为空（罕见，think-only 阶段）
  //   - no_rollout_bound      ← _bound.get(hubSessionId).rolloutPath 不存在
  //   返回值始终是对象（不再返回 null），text='' 时由调用方按 extractMode 区分原因。
  //   `source` 字段（manual_codex_rollout / manual_codex_rollout_streaming）保留用于日志追溯。
  // 2026-07-12 道雪：新增 opts.untilTs —— 轮次窗口上界（开区间）。
  //   「重新提取」旧轮时，调用方传该轮用户消息时间做 sincePromptTs、下一轮用户消息
  //   时间做 untilTs，把提取严格框在该轮内；否则"从尾向前扫最新 task_complete"
  //   永远拿到最新轮的答案，patch 回旧轮 = 内容张冠李戴。untilTs 缺省 null = 原行为。
  async extractLatestTurn(hubSessionId, sincePromptTs = 0, opts = {}) {
    const entry = this._bound.get(hubSessionId);
    if (!entry || !entry.rolloutPath) {
      return { text: '', extractMode: 'no_rollout_bound', source: null };
    }
    if (this._parserService) {
      try {
        const { turns } = await this._parserService.parse('codex', entry.rolloutPath, { fromTail: false });
        const untilTs = Number.isFinite(Number(opts.untilTs)) && Number(opts.untilTs) > 0 ? Number(opts.untilTs) : null;
        let effectiveSinceTs = Math.max(0, Number(sincePromptTs) || 0);
        for (const turn of turns) {
          const ts = Number(turn && (turn.tsEnd || turn.ts)) || 0;
          if (turn && turn.role === 'user' && ts >= effectiveSinceTs && (untilTs === null || ts < untilTs)) {
            effectiveSinceTs = ts;
          }
        }
        const candidates = turns.filter((turn) => {
          if (!turn || turn.role !== 'assistant') return false;
          const ts = Number(turn.tsEnd || turn.ts) || 0;
          if (effectiveSinceTs && ts && ts < effectiveSinceTs) return false;
          if (untilTs !== null && (!ts || ts >= untilTs)) return false;
          return typeof turn.text === 'string' && turn.text.trim();
        });
        const latest = candidates[candidates.length - 1];
        if (!latest) return { text: '', extractMode: 'no_task_complete_yet', source: null };
        const isFinal = latest.stopReason === 'task_complete';
        return {
          text: latest.text.trim(),
          extractMode: isFinal ? 'final_answer' : 'partial_commentary',
          source: isFinal ? 'manual_codex_rollout' : 'manual_codex_rollout_streaming',
        };
      } catch {
        return { text: '', extractMode: 'no_rollout_bound', source: null };
      }
    }
    let raw;
    try { raw = await fs.promises.readFile(entry.rolloutPath, 'utf8'); }
    catch { return { text: '', extractMode: 'no_rollout_bound', source: null }; }
    const untilTs = Number.isFinite(Number(opts.untilTs)) && Number(opts.untilTs) > 0 ? Number(opts.untilTs) : null;
    const beyondWindow = (ts) => untilTs !== null && Number.isFinite(ts) && ts >= untilTs;
    const lines = raw.split('\n');
    let effectiveSinceTs = Math.max(0, Number(sincePromptTs) || 0);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try { obj = JSON.parse(trimmed); } catch { continue; }
      if (obj?.type !== 'event_msg' || obj.payload?.type !== 'user_message') continue;
      const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
      // 窗口内的最后一条 user_message 才能推进下界；窗口外（下一轮）的不算
      if (Number.isFinite(ts) && ts >= effectiveSinceTs && !beyondWindow(ts)) {
        effectiveSinceTs = ts;
      }
    }

    // 优先：从尾向前扫 task_complete.last_agent_message（带 since/until 窗口过滤）
    // 二轮加固（多方审查）：窗口模式（untilTs 有值 = 精确旧轮重提取）下，时间戳缺失/
    //   非法的事件一律不信任——NaN 会同时穿过 since 和 until 过滤，把别轮答案带进窗口。
    //   无窗口（最新轮/兼容旧调用）保持宽松原行为。
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj?.type !== 'event_msg' || obj.payload?.type !== 'task_complete') continue;
      const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
      if (untilTs !== null && !Number.isFinite(ts)) continue;
      if (effectiveSinceTs && Number.isFinite(ts) && ts < effectiveSinceTs) continue;
      if (beyondWindow(ts)) continue;
      const text = obj.payload.last_agent_message;
      if (typeof text !== 'string' || !text.trim()) continue;
      return {
        text: text.trim(),
        extractMode: 'final_answer',
        source: 'manual_codex_rollout',
      };
    }

    // 降级：streaming 中（无 task_complete）→ 拼窗口内所有 agent_message
    const collected = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try { obj = JSON.parse(trimmed); } catch { continue; }
      if (obj?.type !== 'event_msg' || obj.payload?.type !== 'agent_message') continue;
      const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
      if (untilTs !== null && !Number.isFinite(ts)) continue;
      if (effectiveSinceTs && Number.isFinite(ts) && ts < effectiveSinceTs) continue;
      if (beyondWindow(ts)) continue;
      const msg = obj.payload.message;
      if (typeof msg !== 'string' || !msg.trim()) continue;
      collected.push(msg.trim());
    }
    if (collected.length === 0) {
      return { text: '', extractMode: 'no_task_complete_yet', source: null };
    }
    return {
      text: collected.join('\n\n'),
      extractMode: 'partial_commentary',
      source: 'manual_codex_rollout_streaming',
    };
  }

  _ensureWatcher() {
    if (this._pollTimer) return;
    this._scanOnce().catch((e) => console.warn('[codex-tap] scan error:', e.message));
    this._pollTimer = setInterval(() => this._scanOnce().catch((e) => console.warn('[codex-tap] scan error:', e.message)), this._pollIntervalMs);
    this._pollTimer.unref?.();
  }

  _stopWatcher() {
    try { clearInterval(this._pollTimer); } catch {}
    this._pollTimer = null;
  }

  _candidateDirs() {
    // Scan today + yesterday across all known sessionsRoots. A Codex session
    // started at 23:55 keeps appending to yesterday's rollout file across midnight;
    // the old +1 direction (tomorrow) would never see a real file.
    // Multi-root: 订阅模式（~/.codex/sessions）+ API 模式（hubDataDir/codex-api-profile/sessions）
    // 共存时都要扫。
    const now = new Date();
    const dirs = [];
    for (const root of this._sessionsRoots) {
      for (const offset of [0, -86400000]) {
        const d = new Date(now.getTime() + offset);
        dirs.push(path.join(
          root,
          String(d.getFullYear()),
          String(d.getMonth() + 1).padStart(2, '0'),
          String(d.getDate()).padStart(2, '0'),
        ));
      }
    }
    return dirs;
  }

  async _scanOnce() {
    if (this._pending.size === 0) return;
    if (this._scanning) return; // skip if previous scan is still running
    this._scanning = true;
    try {
      for (const dir of this._candidateDirs()) {
        let files;
        try { files = await fs.promises.readdir(dir); } catch { continue; }
        for (const fname of files) {
          if (!fname.startsWith('rollout-') || !fname.endsWith('.jsonl')) continue;
          const full = path.join(dir, fname);
          if (this._seen.has(full)) continue;
          await this._tryBind(full);
        }
      }
    } finally {
      this._scanning = false;
    }
  }

  async _bindByCodexSid(hubSessionId, codexSid) {
    if (!hubSessionId || !codexSid || this._bound.has(hubSessionId)) return false;
    const rolloutPath = await this._findRolloutByCodexSid(codexSid);
    if (!rolloutPath) return false;
    const bound = await this._bindRolloutToHubSession(hubSessionId, rolloutPath);
    if (!bound) return false;
    this._pending.delete(hubSessionId);
    this._seen.add(rolloutPath);
    return true;
  }

  async _findRolloutByCodexSid(codexSid) {
    const suffix = `-${codexSid}.jsonl`;
    const roots = Array.from(this._sessionsRoots);
    let best = null;
    const visit = async (dir, depth) => {
      if (depth > 3 || best) return;
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
      catch { return; }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          await visit(full, depth + 1);
          if (best) return;
        } else if (ent.isFile() && ent.name.startsWith('rollout-') && ent.name.endsWith(suffix)) {
          best = full;
          return;
        }
      }
    };
    for (const root of roots) {
      await visit(root, 0);
      if (best) break;
    }
    return best;
  }

  async _tryBind(rolloutPath) {
    // Codex rollout first line (session_meta) can exceed 20KB due to a huge
    // base_instructions.text field — read via readline to get a full line
    // without truncation.
    let meta;
    try {
      const firstLine = await readFirstLine(rolloutPath);
      if (!firstLine) return;  // file still flushing; retry next scan
      let obj;
      try { obj = JSON.parse(firstLine); } catch { return; }
      if (obj?.type !== 'session_meta' || !obj.payload) return;
      meta = obj.payload;
    } catch { return; }

    // Hub sessions own top-level Codex TUI threads. Codex subagents write
    // sibling rollout files in the same cwd and often within the same second;
    // accepting one here permanently cross-wires card history and PTY state.
    if (!isCodexTopLevelRolloutMeta(meta)) {
      this._seen.add(rolloutPath);
      return;
    }

    const metaCwd = normalizePathForCompare(meta.cwd || '');
    const metaTs = Date.parse(meta.timestamp || '');
    if (!metaCwd) { console.warn(`[codex-tap] rollout has no cwd: ${rolloutPath}`); return; }

    // Fallback: if meta.timestamp is missing/malformed, use file mtime as a
    // best-effort proxy for session start time.
    let statMtime = null;
    try { statMtime = (await fs.promises.stat(rolloutPath)).mtimeMs; } catch {}
    let effectiveTs = Number.isFinite(metaTs) ? metaTs : null;
    if (effectiveTs == null) effectiveTs = statMtime;

    const candidates = [];
    let normalizedUserMessages = null;
    let sawMatchingPendingCwd = false;
    for (const [hubSessionId, entry] of this._pending) {
      if (entry.cwd !== metaCwd) continue;
      sawMatchingPendingCwd = true;
      let delta = null;
      if (effectiveTs != null) {
        const metaDelta = effectiveTs - entry.spawnTime;
        if (metaDelta >= -10000 && metaDelta <= 300000) delta = metaDelta;
      }
      if (delta == null && statMtime != null && entry.allowMtimeFallback) {
        // Resume can append to an old rollout whose session_meta timestamp is
        // hours old. mtime is the only fresh signal for `codex resume --last`.
        const mtimeDelta = statMtime - entry.spawnTime;
        if (mtimeDelta >= -10000 && mtimeDelta <= 300000) delta = mtimeDelta;
      }
      if (delta == null && effectiveTs == null && candidates.length === 0) {
        delta = 0;
      }
      if (delta == null) continue;
      if (entry.requirePromptMatch) {
        if (!entry.expectedPrompt) continue;
        if (normalizedUserMessages === null) {
          normalizedUserMessages = (await readCodexUserMessages(rolloutPath)).map(normalizePromptForCompare);
        }
        if (!normalizedUserMessages.some(msg => codexPromptMatchesExpected(msg, entry.expectedPrompt))) continue;
      }
      candidates.push({ hubSessionId, entry, delta });
    }
    let best = null;
    if (candidates.length === 1) {
      best = candidates[0];
    } else if (candidates.length > 1) {
      const promptCandidates = candidates.filter(c => c.entry.expectedPrompt);
      if (promptCandidates.length === 0) return;
      const userMessages = normalizedUserMessages
        || (await readCodexUserMessages(rolloutPath)).map(normalizePromptForCompare);
      if (userMessages.length === 0) return;
      const matched = promptCandidates.filter(c =>
        userMessages.some(msg => codexPromptMatchesExpected(msg, c.entry.expectedPrompt))
      );
      if (matched.length === 1) {
        best = matched[0];
      } else if (matched.length > 1) {
        matched.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));
        best = matched[0];
      } else {
        return;
      }
    }
    if (!best) {
      if (sawMatchingPendingCwd) {
        // Do not mark same-cwd old rollout files as permanently seen while a
        // pending Codex session exists. A resumed CLI may append to one of
        // them seconds later, refreshing mtime into the bind window.
        return;
      }
      // Rollout outside any pending window — mark seen to skip on future scans.
      this._seen.add(rolloutPath);
      return;
    }

    this._seen.add(rolloutPath);
    this._pending.delete(best.hubSessionId);
    await this._bindRolloutToHubSession(best.hubSessionId, rolloutPath);
  }

  async _bindRolloutToHubSession(hubSessionId, rolloutPath) {
    const existing = this._bound.get(hubSessionId);
    if (existing) return existing.rolloutPath === rolloutPath;
    const meta = readCodexRolloutMeta(rolloutPath);
    if (!isCodexTopLevelRolloutMeta(meta)) {
      this._seen.add(rolloutPath);
      return false;
    }
    // Emit session-bound so main.js can persist codexSid for future resume.
    const codexSid = extractCodexSidFromRolloutPath(rolloutPath);
    this.emit('session-bound', { hubSessionId, kind: 'codex', codexSid, rolloutPath });

    // Stage 2 P2-1：Codex 多 turn 加固 — task_complete 后短 debounce 防误判。
    //   场景：codex 一次 prompt 内可能跑多个 task（think → search → think 再 task_complete），
    //   每个 task 都会写一条 task_complete 事件。我们要的是"全部 task 完成后的最终消息"。
    //   策略：task_complete 触发后启动 timer 暂存 pendingText；
    //         若 timer 内观察到新的 task_started 事件（明确表示又起新 task），
    //         取消 pending 并丢弃旧 text，等下一次 task_complete；
    //         静默后才真 emit 'turn-complete'。
    //
    // 2026-06-07 道雪：原 3000ms 拖累卡片同步体验。每个简单 prompt（如"你好"、"1+1"）codex 只产生
    //   1 个 task_complete，3s debounce 是纯 dead time。多 task 场景下 codex 写下一条
    //   task_started 间隔通常 50-200ms（核心 event loop 同步），400ms 足够防误判。
    //   对比 ClaudeTap stop_reason 终态 emit 只用 200ms debounce。
    const TASK_COMPLETE_DEBOUNCE_MS = 400;
    const onLine = (obj) => {
      // T13（2026-06-08）：turn_context 不是 event_msg，单独分发，提早抽 model 字段。
      //   Codex CLI 每次切模型/起新 turn 都写一条 turn_context 行，含 payload.model（如 "gpt-5.5"）。
      //   不命中 event_msg guard → 必须提前 short-circuit 单独处理。
      if (obj?.type === 'turn_context' && obj.payload?.model) {
        const entry2 = this._bound.get(hubSessionId);
        if (entry2 && typeof obj.payload.model === 'string') {
          entry2.lastModel = obj.payload.model;
        }
        return;
      }
      if (obj?.type !== 'event_msg' || !obj.payload) return;
      const entry = this._bound.get(hubSessionId);
      if (!entry) return;
      const eventType = obj.payload.type;

      // T13: token_count 事件含 last_token_usage（本轮）+ total_token_usage（累计）
      //   Codex 一个 turn 内可能写多次 token_count（每个 task 完成都写），last_token_usage 是
      //   最近一次 task 的 token，不是整 turn 累加；total_token_usage 是 session 起算的累计。
      //   卡片视图"本轮消耗"语义 → 用最后一条 token_count 的 last_token_usage（最后 task 的实际值，
      //   也是最贴近"本轮回复"的语义）。多 task 时各自的 token 看不到，但首屏体验已经足够。
      if (eventType === 'token_count' && obj.payload.info) {
        const info = obj.payload.info;
        const lastU = info.last_token_usage;
        if (lastU && typeof lastU === 'object') {
          entry.lastUsage = {
            input_tokens: lastU.input_tokens || 0,
            output_tokens: lastU.output_tokens || 0,
            cache_read_input_tokens: lastU.cached_input_tokens || 0,
            cache_creation_input_tokens: 0,    // Codex 不区分 5m/1h，统一塞 0
            reasoning_output_tokens: lastU.reasoning_output_tokens || 0,
          };
        }
      }

      if (eventType === 'user_message') {
        const text = codexTextFromPayload(obj.payload).trim();
        if (text) {
          const sig = `${obj.timestamp || ''}:${text}`;
          if (entry._lastPromptSig !== sig) {
            entry._lastPromptSig = sig;
            this.emit('prompt-submitted', {
              hubSessionId,
              text,
              transcriptPath: entry.rolloutPath,
              submittedAt: timestampToMs(obj.timestamp) || Date.now(),
              signalSource: 'user_message',
            });
          }
        }
      }

      // 新 task 开始 → 取消 pending emit（视为"还在进行"，丢弃上一次的 pendingText）
      if (eventType === 'task_started' && entry._pendingEmitTimer) {
        clearTimeout(entry._pendingEmitTimer);
        entry._pendingEmitTimer = null;
        entry._pendingText = null;
        entry._pendingDurationMs = null;
      }

      if (eventType === 'task_complete' && typeof obj.payload.last_agent_message === 'string') {
        const text = obj.payload.last_agent_message.trim();
        if (!text) return;
        // 重置 debounce timer：每次新 task_complete 都重新计时（最后一次 task_complete 的 text 为准）
        if (entry._pendingEmitTimer) clearTimeout(entry._pendingEmitTimer);
        entry._pendingText = text;
        entry._pendingDurationMs = obj.payload.duration_ms;
        entry._pendingEmitTimer = setTimeout(() => {
          entry._pendingEmitTimer = null;
          const finalText = entry._pendingText;
          const finalDuration = entry._pendingDurationMs;
          entry._pendingText = null;
          entry._pendingDurationMs = null;
          if (!finalText) return;
          entry.lastText = finalText;
          this.emit('turn-complete', {
            hubSessionId,
            text: finalText,
            transcriptPath: entry.rolloutPath,
            completedAt: Date.now(),
            durationMs: finalDuration,
            signalSource: 'task_complete',
            // T13: 附带 model + usage 给卡片视图显示真实模型名 + token chip
            modelId: entry.lastModel || null,
            usage: entry.lastUsage || null,
          });
        }, TASK_COMPLETE_DEBOUNCE_MS);
      }
    };

    const tail = new JsonlTail(rolloutPath, onLine, { maxInitialBytes: 8 * 1024 * 1024 });
    this._bound.set(hubSessionId, {
      rolloutPath, tail, lastText: null,
      lastModel: null, lastUsage: null,    // T13
      _pendingEmitTimer: null, _pendingText: null, _pendingDurationMs: null,
      _lastPromptSig: null,
    });
    await tail.start();
    return true;
  }
}

// ---------------------------------------------------------------------------
// GeminiTap — 扫 ~/.gemini/tmp/*/.project_root 反查 cwd → 匹配 chats/ 目录，
// fs.watch 等待 session-*.jsonl 创建，tail 到 type:"gemini" 且 tokens 完整触发
// ---------------------------------------------------------------------------
// 注意 Gemini 0.39+ 改用 JSONL，0.38 及以前是单 JSON 整覆盖。
// JSONL 路径为主；若 chats/ 下只有 .json 不带 jsonl，退化为整文件读 + 防抖。

const GEMINI_TMP_ROOT = path.join(os.homedir(), '.gemini', 'tmp');

class GeminiTap extends EventEmitter {
  constructor(opts = {}) {
    super();
    // 2026-05-04 gemini equiv：opts.tmpRoot 让单测把 fake session 写到 tmpdir，
    // 不污染真实 ~/.gemini/tmp。生产路径不传 opts → 默认走 GEMINI_TMP_ROOT。
    this._tmpRoot = opts.tmpRoot || GEMINI_TMP_ROOT;
    this._pending = new Map(); // hubSessionId → { cwd, spawnTime, projectDir }
    this._bound = new Map();   // hubSessionId → { sessionPath, tail, lastText, isJsonl, debounceTimer }
    this._pollTimer = null;
    this._seen = new Set();    // session file paths we've already bound
    this._scanning = false;    // re-entry guard (see CodexTap for rationale)
  }

  // 2026-05-04 gemini equiv extract-failure debug —— 暴露 _pending / _bound / _seen 当前状态。
  // main.js 的 groupchat-gemini-debug-state IPC handler 转发此快照给 renderer，
  // 用户报告"gemini 已回答但卡片提取不到"时排查为什么没 bind / 已 bind 但未 emit。
  // 不暴露 timer / tail object / EventEmitter listeners 等内部句柄；JSON 可序列化。
  getDebugSnapshot() {
    const now = Date.now();
    const pending = [];
    for (const [hubSessionId, entry] of this._pending) {
      pending.push({
        hubSessionId,
        cwd: entry.cwd,
        spawnTime: entry.spawnTime,
        ageMs: now - entry.spawnTime,
        projectDir: entry.projectDir || null,
      });
    }
    const bound = [];
    for (const [hubSessionId, entry] of this._bound) {
      bound.push({
        hubSessionId,
        sessionPath: entry.sessionPath,
        isJsonl: !!entry.isJsonl,
        hasLastText: !!entry.lastText,
      });
    }
    return {
      tmpRoot: this._tmpRoot,
      pending,
      bound,
      seen: Array.from(this._seen),
    };
  }

  registerSession(hubSessionId, { cwd } = {}) {
    const resolvedCwd = normalizePathForCompare(cwd || process.cwd());
    this._pending.set(hubSessionId, {
      cwd: resolvedCwd,
      spawnTime: Date.now(),
      projectDir: null,
    });
    this._ensureWatcher();
  }

  hasSession(hubSessionId) {
    return this._pending.has(hubSessionId) || this._bound.has(hubSessionId);
  }

  unregisterSession(hubSessionId) {
    this._pending.delete(hubSessionId);
    const bound = this._bound.get(hubSessionId);
    if (bound) {
      try { bound.tail?.close(); } catch {}
      try { clearTimeout(bound.debounceTimer); } catch {}
      // 2026-05-02：清 idle-timer 防 leak（用户血泪场景兜底新增的 timer）
      if (bound._idleTimer) { try { clearTimeout(bound._idleTimer); } catch {} }
      this._bound.delete(hubSessionId);
    }
    if (this._pending.size === 0 && this._bound.size === 0) {
      this._stopWatcher();
    }
  }

  getLastAssistantText(hubSessionId) {
    return this._bound.get(hubSessionId)?.lastText || null;
  }

  // Card redesign（2026-05-01）— 最新 token 计数缓存：
  //   GeminiTap onLine 看到 obj.tokens.total 时调 this._recordTokens(sid, obj.tokens) 缓存。
  //   _gcWaitTurnComplete 在 watcher settle 时调 this.getLastTokens(sid) 拿到最新值，
  //   附到 result.tokens 上传给 renderer 卡片 row4 显示"本轮 X tokens · 累计 Y tokens"。
  _recordTokens(hubSessionId, tokens) {
    if (!hubSessionId || !tokens || typeof tokens.total !== 'number') return;
    const entry = this._bound.get(hubSessionId);
    if (entry) entry.lastTokens = { ...tokens };
  }

  getLastTokens(hubSessionId) {
    const entry = this._bound.get(hubSessionId);
    return entry?.lastTokens || null;
  }

  // 每轮发新 prompt 前清空，避免上一轮的 token 数据被本轮用作"本轮"统计
  clearLastTokens(hubSessionId) {
    const entry = this._bound.get(hubSessionId);
    if (entry) entry.lastTokens = null;
  }

  // Card optimization Task 2（2026-05-01）— 流式 streamingBuf 接口。
  //   onLine 累积逻辑见 _bindSession 的 onLine（type:"gemini" 分支）。
  //   返回数组 Array<Block> | null，与 ClaudeTap 同形（main.js groupChatWatcher.extractStreamingText 统一处理）。
  getStreamingText(hubSessionId) {
    const entry = this._bound.get(hubSessionId);
    if (!entry || !Array.isArray(entry._streamingBuf) || entry._streamingBuf.length === 0) return null;
    return [...entry._streamingBuf];
  }

  clearStreamingBuf(hubSessionId) {
    const entry = this._bound.get(hubSessionId);
    if (entry) entry._streamingBuf = [];
  }

  // Stage 2 容错升级（2026-05-01）— 手动提取兜底：
  //   当 Gemini 永不 emit L1/L3 完成信号时（OAuth 异常 / 限流 / 卡死），
  //   用户在 UI 点"一键提取"会调本方法，直接读 JSONL 拼接 sincePromptTs 之后的所有
  //   type:"gemini" 行 content，绕过完成检测。
  //   返回 { text, lineCount, source: 'manual' }；JSONL 不可读 / 无匹配行返回 null。
  async extractLatestGeminiTurn(hubSessionId, sincePromptTs) {
    const entry = this._bound.get(hubSessionId);
    if (!entry || !entry.sessionPath || !entry.isJsonl) return null;
    let raw;
    try { raw = await fs.promises.readFile(entry.sessionPath, 'utf8'); }
    catch { return null; }
    const lines = raw.split('\n');
    const collected = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj?.type !== 'gemini') continue;
      // 2026-05-04 gemini-equiv Bug 2 修复：gemini 0.40.1 jsonl 写的 timestamp 是
      //   ISO 字符串（"2026-05-04T13:38:21.867Z"），旧代码只识 number → 全部置 null
      //   → ts < sincePromptTs 过滤被绕过，一键提取拿到整个 jsonl 历史多轮 content。
      //   现接受 ISO 字符串 + number 两种格式；解析失败置 null（保留旧"无 ts 不过滤"行为）。
      let ts = null;
      if (typeof obj.timestamp === 'number') ts = obj.timestamp;
      else if (typeof obj.timestamp === 'string') {
        const parsed = Date.parse(obj.timestamp);
        if (!Number.isNaN(parsed)) ts = parsed;
      } else if (typeof obj.ts === 'number') ts = obj.ts;
      if (ts !== null && ts < sincePromptTs) continue;
      if (typeof obj.content !== 'string') continue;
      const piece = obj.content;
      if (!piece.trim()) continue;
      // 去重：Gemini 某些版本流式输出末尾会出现连续重复 chunk。
      if (collected.length && collected[collected.length - 1] === piece) continue;
      collected.push(piece);
    }
    if (collected.length === 0) return null;
    const text = collected.join('').trim();
    if (!text) return null;
    return { text, lineCount: collected.length, source: 'manual' };
  }

  _ensureWatcher() {
    if (this._pollTimer) return;
    this._scanOnce().catch((e) => console.warn('[gemini-tap] scan error:', e && e.message));
    this._pollTimer = setInterval(() => this._scanOnce().catch((e) => console.warn('[gemini-tap] scan error:', e && e.message)), 1000);
    this._pollTimer.unref?.();
  }

  _stopWatcher() {
    try { clearInterval(this._pollTimer); } catch {}
    this._pollTimer = null;
  }

  async _scanOnce() {
    if (this._pending.size === 0) return;
    if (this._scanning) return;
    this._scanning = true;
    try {
      let tmpDirs;
      try { tmpDirs = await fs.promises.readdir(this._tmpRoot); } catch { return; }

      // Phase 1: resolve projectDir for pending entries without one
      for (const [, entry] of this._pending) {
        if (entry.projectDir) continue;
        for (const sub of tmpDirs) {
          const projectRootFile = path.join(this._tmpRoot, sub, '.project_root');
          let content;
          try { content = await fs.promises.readFile(projectRootFile, 'utf8'); }
          catch { continue; }
          if (normalizePathForCompare(content.trim()) === entry.cwd) {
            entry.projectDir = path.join(this._tmpRoot, sub);
            break;
          }
        }
      }

      // Phase 2: look for new session-*.jsonl files with mtime ≥ spawnTime-2s
      for (const [hubSessionId, entry] of this._pending) {
        if (!entry.projectDir) continue;
        const chatsDir = path.join(entry.projectDir, 'chats');
        let files;
        try { files = await fs.promises.readdir(chatsDir); } catch { continue; }
        const candidates = [];
        for (const f of files) {
          if (!f.startsWith('session-')) continue;
          if (!f.endsWith('.jsonl') && !f.endsWith('.json')) continue;
          const full = path.join(chatsDir, f);
          if (this._seen.has(full)) continue;
          let stat;
          try { stat = await fs.promises.stat(full); } catch { continue; }
          if (stat.mtimeMs < entry.spawnTime - 2000) continue;
          candidates.push({ full, mtime: stat.mtimeMs, isJsonl: f.endsWith('.jsonl') });
        }
        if (candidates.length === 0) continue;
        candidates.sort((a, b) => a.mtime - b.mtime);
        const pick = candidates[0];
        this._seen.add(pick.full);
        this._pending.delete(hubSessionId);
        await this._bindSession(hubSessionId, pick.full, pick.isJsonl);
      }
    } finally {
      this._scanning = false;
    }
  }

  async _bindSession(hubSessionId, sessionPath, isJsonl) {
    // Card optimization Task 2（2026-05-01）— streamingBuf 累积流式 chunk，让 main.js groupChatWatcher.extractStreamingText
    //   优先用 tap 的 blocks 数组渲染（替代 PTY ringBuffer 过滤），preview 区不再有 throbbing 字符。
    // 2026-05-02 加 _idleTimer 字段：用户反馈"Gemini 第一轮没快速提取"，token 信号
    //   延迟到达时三层 emit 都不触发；idle-timer 兜底见 _scheduleGeminiIdleEmit。
    const boundEntry = { sessionPath, tail: null, lastText: null, isJsonl, debounceTimer: null, _streamingBuf: [], _idleTimer: null };
    this._bound.set(hubSessionId, boundEntry);

    // Emit session-bound for main.js to persist resume meta.
    // sessionPath is `<projectDir>/chats/session-...`. Walk up 2 levels for projectDir.
    const projectDir = path.dirname(path.dirname(sessionPath));
    let projectRoot = null;
    try {
      projectRoot = (await fs.promises.readFile(path.join(projectDir, '.project_root'), 'utf8')).trim();
    } catch {}

    // Read full sessionId UUID from first line of JSONL (authoritative).
    // Falls back to 8charId from filename if read fails.
    let geminiChatId = extractGeminiChatIdFromSessionPath(sessionPath);
    try {
      const raw = await fs.promises.readFile(sessionPath, 'utf8');
      const firstLine = raw.split('\n')[0];
      const meta = JSON.parse(firstLine);
      if (meta.sessionId && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(meta.sessionId)) {
        geminiChatId = meta.sessionId;
      }
    } catch {}

    this.emit('session-bound', {
      hubSessionId,
      kind: 'gemini',
      geminiChatId,
      geminiProjectHash: extractGeminiProjectHashFromDir(projectDir),
      geminiProjectRoot: projectRoot,
      sessionPath,
    });

    // Stage 2 容错升级（2026-05-01）：emit payload 增加 signalSource 字段，
    //   让下游 turn-completion-watcher 区分 L1（result/message_update）/ L3（tokens_total）信号。
    //   向后兼容——既有调用方（main.js _gcWaitTurnComplete）忽略此字段不影响。
    // 2026-05-02：emit 时取消 idle timer（避免重复 emit）。
    const emitIfComplete = (content, meta = {}) => {
      const text = (content || '').trim();
      if (!text) return;
      if (text === boundEntry.lastText) return;
      boundEntry.lastText = text;
      // L1/L3 抢先 → 取消 idle timer
      if (boundEntry._idleTimer) {
        clearTimeout(boundEntry._idleTimer);
        boundEntry._idleTimer = null;
      }
      this.emit('turn-complete', {
        hubSessionId,
        text,
        completedAt: Date.now(),
        signalSource: meta.signalSource || 'tokens_total',
      });
    };

    // 2026-05-02 idle-timer 兜底：每条新 content 行重置 5s timer，
    //   连续 5s 无新行 → 把 streamingBuf 拼成完整 text 主动 emit。
    //   防止"第一轮 token 延迟到达"导致卡片永远 streaming（用户血泪反馈）。
    const _scheduleGeminiIdleEmit = () => {
      if (boundEntry._idleTimer) clearTimeout(boundEntry._idleTimer);
      boundEntry._idleTimer = setTimeout(() => {
        boundEntry._idleTimer = null;
        // 拼 streamingBuf 内容；过滤 type:'text' 块（Gemini 只 push text 块）
        const text = boundEntry._streamingBuf
          .filter(b => b && b.type === 'text' && typeof b.text === 'string')
          .map(b => b.text).join('').trim();
        if (!text) return;
        if (text === boundEntry.lastText) return;
        boundEntry.lastText = text;
        this.emit('turn-complete', {
          hubSessionId,
          text,
          completedAt: Date.now(),
          signalSource: 'idle_timer_5s',
        });
      }, _GEMINI_IDLE_EMIT_MS);
      boundEntry._idleTimer.unref?.();
    };

    if (isJsonl) {
      // Gemini 0.39+ JSONL: 三层完成信号识别（按可靠度优先匹配）：
      //   L1a result_event: type:"result"（headless --output-format stream-json 模式）
      //   L1b message_update: type:"message_update" + status:"finalized"（TUI fallback）
      //   L3  tokens_total:  type:"gemini" + tokens.total（启发式，慢/限流时不可靠）
      // Card optimization Task 2（2026-05-01）— 同步累积流式 content 到 _streamingBuf：
      //   只要看到带 content 的 gemini/result/message_update 行就 push（无视 token 是否到位），
      //   让 preview 区在 token 到达之前就能显示流式中间态。50KB tail-preserving 截断防内存膨胀。
      const _STREAM_BUF_MAX_BYTES = 50000;
      const _pushStreamBlock = (text) => {
        if (typeof text !== 'string' || text.length === 0) return;
        boundEntry._streamingBuf.push({ type: 'text', text });
        // 50KB 头部截断，保留尾部
        let totalLen = 0;
        for (let i = boundEntry._streamingBuf.length - 1; i >= 0; i--) {
          totalLen += String(boundEntry._streamingBuf[i].text || '').length;
          if (totalLen > _STREAM_BUF_MAX_BYTES) {
            boundEntry._streamingBuf = boundEntry._streamingBuf.slice(i + 1);
            break;
          }
        }
      };

      const onLine = (obj) => {
        // M2.4 修复 (2026-05-03)：把 idle_timer_5s 提升为"所有路径的 catch-all 兜底"。
        //   旧版只在 line 963 分支（type:"gemini" + content + 无 tokens）schedule timer，
        //   导致以下用户血泪场景永不触发 turn-complete：
        //   - Gemini 写 type:"gemini" + content + tokens.total=null（限流 / 流式中断）
        //   - 主路径 emitIfComplete 因 lastText 去重提前返回但下一行有新 content
        //   - 真实 jsonl 完全无 type:"result" / "message_update"（只有 type:"gemini"）
        //   现在策略：任何 type:"gemini"/"result"/"message_update" 的有 content 行都
        //   schedule timer。emitIfComplete 已用 lastText 去重，5s 后兜底 emit 安全。
        const isContentLine = (
          (obj?.type === 'gemini' || obj?.type === 'result' || obj?.type === 'message_update')
          && typeof obj?.content === 'string'
          && obj.content.trim().length > 0
        );
        if (isContentLine) _scheduleGeminiIdleEmit();

        // L1a — 协议级 result 事件（最可靠）
        if (obj?.type === 'result' && typeof obj.content === 'string' && obj.content.trim().length > 0) {
          _pushStreamBlock(obj.content);
          emitIfComplete(obj.content, { signalSource: 'result_event' });
          return;
        }
        // L1b — message_update finalized（TUI 模式 fallback）
        if (obj?.type === 'message_update' && obj.status === 'finalized'
            && typeof obj.content === 'string' && obj.content.trim().length > 0) {
          _pushStreamBlock(obj.content);
          emitIfComplete(obj.content, { signalSource: 'message_update' });
          return;
        }
        // L3 — tokens.total 启发式（保留向后兼容；慢响应/限流时永不写入）
        if (obj?.type === 'gemini' && obj.tokens && obj.tokens.total != null
            && typeof obj.content === 'string' && obj.content.trim().length > 0) {
          // Card redesign（2026-05-01）：缓存最新 token 计数，让 _gcWaitTurnComplete 在 settle
          //   时把数据透传给 watcher.wait() 的 result.tokens。卡片 row4 显示"本轮 X tokens"。
          this._recordTokens(hubSessionId, obj.tokens);
          _pushStreamBlock(obj.content);
          emitIfComplete(obj.content, { signalSource: 'tokens_total' });
        } else if (obj?.type === 'gemini' && obj.tokens && obj.tokens.total != null) {
          // 仅缓存 token，不触发 emit（content 为空时 token 信息仍有用：streaming 中实时更新）
          this._recordTokens(hubSessionId, obj.tokens);
        } else if (obj?.type === 'gemini' && typeof obj.content === 'string' && obj.content.trim().length > 0) {
          // Task 2（2026-05-01）— 流式中间态：content 已到、token 未到，仍累积让 preview 显示
          _pushStreamBlock(obj.content);
          // M2.4 修复：idle timer 已在 onLine 顶部统一 schedule，此处不再重复
        }
      };
      const tail = new JsonlTail(sessionPath, onLine, { maxInitialBytes: 8 * 1024 * 1024 });
      boundEntry.tail = tail;
      await tail.start();
    } else {
      // Gemini 0.38 and older: single-file JSON overwritten each turn.
      // Poll mtime; when it settles (>400ms idle), read whole file,
      // take last messages[] entry with type:"gemini".
      let lastMtime = 0;
      const poll = async () => {
        let stat;
        try { stat = await fs.promises.stat(sessionPath); } catch { return; }
        if (stat.mtimeMs === lastMtime) return;
        lastMtime = stat.mtimeMs;
        if (boundEntry.debounceTimer) clearTimeout(boundEntry.debounceTimer);
        boundEntry.debounceTimer = setTimeout(async () => {
          try {
            const raw = await fs.promises.readFile(sessionPath, 'utf8');
            const parsed = JSON.parse(raw);
            const msgs = parsed?.messages || [];
            for (let i = msgs.length - 1; i >= 0; i--) {
              const m = msgs[i];
              if (m?.type === 'gemini' && typeof m.content === 'string') {
                emitIfComplete(m.content);
                break;
              }
            }
          } catch {}
        }, 400);
      };
      const timer = setInterval(poll, 500);
      timer.unref?.();
      boundEntry.tail = { close: () => clearInterval(timer) };
    }
  }
}

// ---------------------------------------------------------------------------
// TranscriptTap — 外部入口，组合各 CLI transcript 后端
// ---------------------------------------------------------------------------

class TranscriptTap extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._claude = new ClaudeTap({
      parserService: opts.parserService,
      // 单测注入用；生产不传 → 走真实 ~/.claude 与 500ms 默认轮询
      ...(opts.claudeHomeDir ? { homeDir: opts.claudeHomeDir } : {}),
      ...(opts.claudeDiscoveryPollMs ? { discoveryPollMs: opts.claudeDiscoveryPollMs } : {}),
    });
    this._codex = new CodexTap({ parserService: opts.parserService });
    this._gemini = new GeminiTap();
    this._kimi = new KimiTap({ parserService: opts.parserService });
    for (const b of [this._claude, this._codex, this._gemini, this._kimi]) {
      b.on('turn-complete', (ev) => this.emit('turn-complete', ev));
      b.on('session-bound', (ev) => this.emit('session-bound', ev));
      b.on('prompt-submitted', (ev) => this.emit('prompt-submitted', ev));
    }
  }

  dispose() {
    const ids = new Set();
    for (const backend of [this._claude, this._codex, this._gemini, this._kimi]) {
      for (const mapName of ['_bound', '_pending']) {
        const map = backend && backend[mapName];
        if (map && typeof map.keys === 'function') {
          for (const id of map.keys()) ids.add(id);
        }
      }
    }
    for (const id of ids) this.unregisterSession(id);
    try { this._kimi.dispose(); } catch {}
    try { this._claude.dispose(); } catch {}
    this.removeAllListeners();
  }

  hasSession(hubSessionId) {
    return (
      this._claude.hasSession(hubSessionId) ||
      this._codex.hasSession(hubSessionId) ||
      this._gemini.hasSession(hubSessionId) ||
      this._kimi.hasSession(hubSessionId)
    );
  }

  // kind: 'claude' | 'claude-resume' | 'codex' | 'gemini' | 'kimi'
  // ctx: { cwd }
  registerSession(hubSessionId, kind, ctx = {}) {
    if (!hubSessionId || !kind) return;
    const backend = this._backendFor(kind);
    if (!backend) return;
    try { backend.registerSession(hubSessionId, { ...ctx, kind, allowExistingSession: ctx.allowExistingSession || kind === 'kimi-resume' }); }
    catch (e) { console.warn(`[transcript-tap] registerSession(${kind}) failed:`, e.message); }
  }

  notePrompt(hubSessionId, kind, prompt) {
    if (!hubSessionId || !kind || typeof prompt !== 'string') return;
    const backend = this._backendFor(kind);
    if (!backend || typeof backend.notePrompt !== 'function') return;
    try { backend.notePrompt(hubSessionId, prompt); }
    catch (e) { console.warn(`[transcript-tap] notePrompt(${kind}) failed:`, e.message); }
  }

  unregisterSession(hubSessionId) {
    for (const b of [this._claude, this._codex, this._gemini, this._kimi]) {
      try { b.unregisterSession(hubSessionId); } catch {}
    }
  }

  getLastAssistantText(hubSessionId) {
    return (
      this._claude.getLastAssistantText(hubSessionId) ||
      this._codex.getLastAssistantText(hubSessionId) ||
      this._gemini.getLastAssistantText(hubSessionId) ||
      this._kimi.getLastAssistantText(hubSessionId) ||
      null
    );
  }

  // Card optimization Task 3（2026-05-01）— 顶层流式聚合代理。
  //   按 claude → gemini → codex 顺序代理（codex 在 spike FAIL 后无 streamingBuf，可选链回退 null）。
  //   返回 Array<Block> | null，调用方拿到 null 时走 PTY 兜底。
  getStreamingText(hubSessionId) {
    return (
      this._claude.getStreamingText(hubSessionId) ||
      this._gemini.getStreamingText(hubSessionId) ||
      this._kimi.getStreamingText(hubSessionId) ||
      (this._codex.getStreamingText ? this._codex.getStreamingText(hubSessionId) : null) ||
      null
    );
  }

  clearStreamingBuf(hubSessionId) {
    for (const b of [this._claude, this._gemini, this._codex, this._kimi]) {
      try {
        if (typeof b.clearStreamingBuf === 'function') b.clearStreamingBuf(hubSessionId);
      } catch {}
    }
  }

  // Stage 2 容错升级（2026-05-01）— 委托到 GeminiTap，让外部 IPC handler 用统一的
  //   transcriptTap.extractLatestGeminiTurn(...) 入口，不必感知 _gemini 子实例。
  async extractLatestGeminiTurn(hubSessionId, sincePromptTs) {
    return this._gemini.extractLatestGeminiTurn(hubSessionId, sincePromptTs);
  }

  // 2026-05-02 Bug 修复：统一手动提取入口，按 backend 路由。
  //   Claude/DeepSeek     → ClaudeTap.extractLatestTurn（读 transcript 末 last assistant）
  //   Codex               → CodexTap.extractLatestTurn（读 rollout 末 task_complete）
  //   Gemini              → GeminiTap.extractLatestGeminiTurn（既有实现，过滤 sincePromptTs）
  //   旧 IPC handler 只调 extractLatestGeminiTurn，对 Claude/DeepSeek/Codex 永远返回 null
  //   → 用户报告"提取按钮假的"。统一入口后所有 backend 都能真正工作。
  //   返回 { text, source } 或 null。调用方应顺序尝试三个 backend，因为同一 sid 只在一个里。
  // opts.untilTs（2026-07-12）：轮次窗口上界，仅 Codex 后端支持（rollout 事件带时间戳，
  //   可精确框定旧轮）；Claude/Gemini 后端只能读"最新回答"，忽略该参数——调用方
  //   （groupchat-recovery-handlers）对非 Codex 的旧轮重提取会提前拒绝，不会静默错位。
  async extractLatestTurn(hubSessionId, sincePromptTs = 0, opts = {}) {
    // 一个 sid 只属于一个 backend。按注册归属路由，避免 Claude 未绑定
    // transcriptPath 时继续落到 Codex 并返回 no_rollout_bound 空结果。
    if (this._claude.hasSession(hubSessionId)) {
      try { return await this._claude.extractLatestTurn(hubSessionId, sincePromptTs); } catch { return null; }
    }
    if (this._gemini.hasSession(hubSessionId)) {
      try { return await this._gemini.extractLatestGeminiTurn(hubSessionId, sincePromptTs); } catch { return null; }
    }
    if (this._codex.hasSession(hubSessionId)) {
      let r = null;
      try { r = await this._codex.extractLatestTurn(hubSessionId, sincePromptTs, opts); } catch {}
      if (r && r.text) return r;
      // 2026-05-04 codex equiv：codex 4 态契约——即便 text='' 也要把 extractMode 透传给 IPC
      // （承载 'no_task_complete_yet' / 'no_rollout_bound'，让 UI 区分原因，不再笼统 no_content）
      if (r && r.extractMode) return r;
      return null;
    }
    if (this._kimi.hasSession(hubSessionId)) {
      try { return await this._kimi.extractLatestTurn(hubSessionId, sincePromptTs); } catch { return null; }
    }
    // 2026-05-04 codex equiv：codex 4 态契约——即便 text='' 也要把 extractMode 透传给 IPC
    // （承载 'no_task_complete_yet' / 'no_rollout_bound'，让 UI 区分原因，不再笼统 no_content）
    return null;
  }

  // Card redesign（2026-05-01）— 最新 token 计数代理。
  //   目前仅 Gemini 提供 obj.tokens.total（Claude/Codex 无此通道），
  //   外部调用方收到 null 时按"未上报"处理（卡片 row4 显示 "-"）。
  getLastTokens(hubSessionId) {
    return this._gemini.getLastTokens(hubSessionId);
  }

  clearLastTokens(hubSessionId) {
    this._gemini.clearLastTokens(hubSessionId);
  }

  async notifyClaudeStop(hubSessionId, transcriptPath) {
    try { await this._claude.notifyStop(hubSessionId, transcriptPath); }
    catch (e) { console.warn('[transcript-tap] notifyClaudeStop failed:', e.message); }
  }

  // B1（2026-07-29）：UserPromptSubmit hook 入口。Stop hook 只在本轮结束才响，
  //   全新会话第 1 轮的 JsonlTail 必须靠这条（或注册期发现）提前建起来，
  //   否则 _streamingBuf 结构性恒空、群聊卡片恒「思考中」。
  async notifyClaudePrompt(hubSessionId, transcriptPath, ccSessionId = null) {
    try { await this._claude.notifyPrompt(hubSessionId, transcriptPath, ccSessionId); }
    catch (e) { console.warn('[transcript-tap] notifyClaudePrompt failed:', e.message); }
  }

  getClaudeDebugSnapshot() {
    return this._claude.getDebugSnapshot();
  }

  // 2026-05-04 codex equiv extract-failure debug —— TranscriptTap 转发 CodexTap 调试快照
  // 给 main.js 的 groupchat-codex-debug-state IPC handler 用，
  // renderer 可以拿到当前 _bound / _pending / _seen 状态排查为什么 manual-extract 拿不到。
  getCodexDebugSnapshot() {
    return this._codex.getDebugSnapshot();
  }

  getCodexRolloutPath(hubSessionId) {
    return this._codex.getRolloutPath(hubSessionId);
  }

  async hasCodexUserMessageSince(hubSessionId, sincePromptTs = 0) {
    if (!this._codex.hasSession(hubSessionId)) return false;
    return this._codex.hasUserMessageSince(hubSessionId, sincePromptTs);
  }

  // 2026-05-04 gemini equiv：与 codex 镜像，给 groupchat-gemini-debug-state IPC handler 用。
  getGeminiDebugSnapshot() {
    return this._gemini.getDebugSnapshot();
  }

  getKimiDebugSnapshot() {
    return this._kimi.getDebugSnapshot();
  }

  _backendFor(kind) {
    // DeepSeek 跑在 Claude Code CLI 上（CLAUDE_CONFIG_DIR 隔离），transcript
    // JSONL 与 Claude 同 shape（spike 验证：tests/_spike-deepseek-stop-hook-result.md），
    // 直接复用 ClaudeTap 即让 AI 群聊 timeline + streaming preview 自动接入。CLAUDE_FAMILY 是单一
    // 真理源，含 claude/claude-resume/deepseek，未来加新 Claude 衍生家族自动覆盖。
    if (isClaudeFamily(kind)) {
      return this._claude;
    }
    if (isCodexCliKind(kind)) return this._codex;
    if (kind === 'gemini') return this._gemini;
    if (isKimiCliKind(kind)) return this._kimi;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Path normalization helper — Windows paths are case-insensitive and can
// use / or \. Normalize both into lower-case forward-slash form for compare.
// ---------------------------------------------------------------------------
function normalizePathForCompare(p) {
  if (!p || typeof p !== 'string') return '';
  let n = p.replace(/\\/g, '/');
  if (n.length > 3 && n.endsWith('/')) n = n.slice(0, -1);
  if (process.platform === 'win32') n = n.toLowerCase();
  return n;
}

function extractCodexSidFromRolloutPath(rolloutPath) {
  const base = path.basename(rolloutPath, '.jsonl');
  if (base.length < 36) return null;
  const sid = base.slice(-36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid)) return null;
  return sid;
}

function extractGeminiChatIdFromSessionPath(sessionPath) {
  const base = path.basename(sessionPath).replace(/\.(jsonl?|json)$/, '');
  if (!base.startsWith('session-')) return null;
  const parts = base.split('-');
  const last = parts[parts.length - 1];
  if (last && /^[0-9a-f]{8}$/i.test(last)) return last;
  return null;
}

function extractGeminiProjectHashFromDir(projectDir) {
  if (!projectDir) return null;
  return path.basename(projectDir);
}

module.exports = {
  TranscriptTap,
  ClaudeTap,          // B1（2026-07-29）：单测注入 homeDir/discoveryPollMs 直测首轮早绑
  CodexTap,           // 2026-05-04 codex equiv：单测注入 sessionsRoot 直测 4 态 extractMode
  GeminiTap,          // 2026-05-04 gemini equiv：单测注入 tmpRoot 直测 _bound 字段
  JsonlTail,
  readLastAssistantMessageFromClaudeTranscript,
  readLastTerminalAssistantTextFromClaudeTranscript,
  readCodexUserMessageEvents,
  extractCodexSidFromRolloutPath,
  extractGeminiChatIdFromSessionPath,
  extractGeminiProjectHashFromDir,
};
