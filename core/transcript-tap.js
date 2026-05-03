'use strict';
// core/transcript-tap.js
//
// 统一 Transcript 抽取适配器：从三家 CLI（Claude / Codex / Gemini）各自自动落盘的
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
// summary-engine.js 会回退到原 marker 扫描。Tap 不抛错，不崩 Hub。

const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

// ---------------------------------------------------------------------------
// JsonlTail — 共用工具：监听 JSONL 文件增长，按行回调 JSON.parse 后的对象
// ---------------------------------------------------------------------------
// 设计：
// - fs.watch 监听文件事件（Windows ConPTY 偶发丢事件，降级 500ms 轮询 mtime）
// - 维护 offset，每次增长从 offset 读到尾，按 \n 切行
// - StringDecoder 处理 UTF-8 跨 chunk 边界
// - onLine 回调的异常静默吞掉（单行坏不影响整体）

class JsonlTail {
  constructor(filepath, onLine) {
    this._filepath = filepath;
    this._onLine = onLine;
    this._offset = 0;
    this._buf = '';
    this._decoder = new StringDecoder('utf8');
    this._watcher = null;
    this._pollTimer = null;
    this._closed = false;
    this._reading = false;
  }

  async start() {
    if (this._closed) return;
    // First pass: drain any existing content — caller may have registered
    // after lines were already written.
    try { await this._drain(); } catch {}

    try {
      this._watcher = fs.watch(this._filepath, { persistent: false }, () => {
        this._drain().catch(() => {});
      });
      this._watcher.on('error', () => {});
    } catch {
      // fs.watch can fail on network drives / exotic FS — fall through to poll
    }

    // Defensive polling: Windows fs.watch occasionally misses events.
    this._pollTimer = setInterval(() => {
      this._drain().catch(() => {});
    }, 500);
    this._pollTimer.unref?.();
  }

  async _drain() {
    if (this._closed || this._reading) return;
    this._reading = true;
    try {
      const stat = await fs.promises.stat(this._filepath);
      if (stat.size <= this._offset) return;
      const fh = await fs.promises.open(this._filepath, 'r');
      try {
        const len = stat.size - this._offset;
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, this._offset);
        this._offset = stat.size;
        this._buf += this._decoder.write(buf);
        const lines = this._buf.split('\n');
        this._buf = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let obj;
          try { obj = JSON.parse(trimmed); } catch { continue; }
          try { this._onLine(obj); } catch {}
        }
      } finally {
        await fh.close();
      }
    } catch {
      // Transient IO errors (file rotated, deleted) — next tick will retry.
    } finally {
      this._reading = false;
    }
  }

  close() {
    this._closed = true;
    try { this._watcher?.close(); } catch {}
    try { clearInterval(this._pollTimer); } catch {}
    this._watcher = null;
    this._pollTimer = null;
    this._decoder.end();
  }
}

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
//          getStreamingText / clearStreamingBuf 暴露给上层（main.js _rtExtractStreamingText 优先使用）。
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
const _CLAUDE_IDLE_EMIT_MS = 90 * 1000; // 极端兜底（原 5s 误触发太多）

// 2026-05-02 Gemini 兜底：与 ClaudeTap 同套 idle-timer 思路。用户血泪反馈：
//   "第一轮 Gemini 子 session 输出后没快速提取，手动提取后流程继续"。
// 根因：GeminiTap.onLine 仅 L1a result_event / L1b message_update / L3 tokens.total
//   三种情况触发 emit。第一轮启动慢时 token 计数延迟到达，三个信号都没到 → 卡片永远
//   停在 streaming，需要用户手动点"一键提取"。
// 兜底：每条带 content 的 gemini 行重置 5s timer，连续 5s 无新行 → 主动 emit
//   turn-complete（signalSource=idle_timer_5s）。L1/L3 抢先时取消 timer。
const _GEMINI_IDLE_EMIT_MS = 5000;

class ClaudeTap extends EventEmitter {
  constructor() {
    super();
    this._bound = new Map(); // hubSessionId → { transcriptPath, lastText, _streamingBuf, _tail }
  }

  registerSession(hubSessionId /* , ctx */) {
    if (!this._bound.has(hubSessionId)) {
      this._bound.set(hubSessionId, {
        transcriptPath: null,
        lastText: null,
        _streamingBuf: [],
        _tail: null,
        _idleTimer: null,
        _stopReasonTimer: null,  // R3: stop_reason 终态防抖 timer
        _pendingEmitText: null,
      });
    }
  }

  unregisterSession(hubSessionId) {
    const entry = this._bound.get(hubSessionId);
    if (entry?._tail) {
      try { entry._tail.close(); } catch {}
    }
    if (entry?._idleTimer) {
      try { clearTimeout(entry._idleTimer); } catch {}
    }
    if (entry?._stopReasonTimer) {
      try { clearTimeout(entry._stopReasonTimer); } catch {}
    }
    this._bound.delete(hubSessionId);
  }

  getLastAssistantText(hubSessionId) {
    const e = this._bound.get(hubSessionId);
    return e?.lastText || null;
  }

  // 2026-05-02 Bug 修复：扩展手动提取支持 Claude/DeepSeek/GLM。
  //   旧版本仅 GeminiTap 有 extractLatestGeminiTurn → 用户对 Claude/DeepSeek/GLM 卡片点
  //   "一键提取"永远拿到 null，UI 显"提取失败"——按钮形同虚设。
  //   新版本：复用 readLastAssistantMessageFromClaudeTranscript 读 transcript 末尾的
  //   last assistant text。sincePromptTs 暂不过滤（Claude transcript 末尾通常就是本轮，
  //   误差可接受；后续可加 timestamp 字段过滤）。
  //   返回 { text, source } 与 GeminiTap 同形；transcriptPath 未知（hook/scan 都未拿到）→ null。
  async extractLatestTurn(hubSessionId, _sincePromptTs = 0) {
    const entry = this._bound.get(hubSessionId);
    if (!entry || !entry.transcriptPath) return null;
    const text = await readLastAssistantMessageFromClaudeTranscript(entry.transcriptPath);
    if (!text || !text.trim()) return null;
    return { text: text.trim(), source: 'manual_claude_transcript' };
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

  // 由 main.js 的 /api/hook/stop 路由调用。transcriptPath 是 CC 原生给的
  // ~/.claude/projects/<slug>/<ccSessionId>.jsonl。
  async notifyStop(hubSessionId, transcriptPath) {
    if (!transcriptPath || !hubSessionId) return;
    if (!this._bound.has(hubSessionId)) {
      this._bound.set(hubSessionId, {
        transcriptPath: null, lastText: null, _streamingBuf: [], _tail: null,
        _idleTimer: null, _pendingEmitText: null,
      });
    }
    const entry = this._bound.get(hubSessionId);
    entry.transcriptPath = transcriptPath;

    // 首次拿到路径 → 启动 JsonlTail，让后续轮也能流式
    if (!entry._tail) {
      const onLine = (obj) => {
        if (obj?.type !== 'assistant' || !obj.message?.content) return;
        const content = obj.message.content;
        if (!Array.isArray(content)) return;
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
      entry._tail = new JsonlTail(transcriptPath, onLine);
      await entry._tail.start();
    }

    // Stop hook 触发 → 取消 idle timer + stop_reason timer，走快路径直接读 transcript 末尾立即 emit
    this._cancelIdleEmit(hubSessionId);
    this._cancelStopReasonEmit(hubSessionId);
    const text = await readLastAssistantMessageFromClaudeTranscript(transcriptPath);
    if (text && text !== entry.lastText) {
      entry.lastText = text;
      this.emit('turn-complete', {
        hubSessionId,
        text,
        completedAt: Date.now(),
        signalSource: 'stop_hook',
      });
    }
  }

  // 内部：每条新 assistant 行调用一次，重置 idle timer。
  //   timer 触发时（连续 5s 无新行）从 transcript 末尾读 last assistant 主动 emit。
  //   防重复：emit 前比对 lastText，相同则不再重复 emit。
  _scheduleIdleEmit(hubSessionId) {
    const entry = this._bound.get(hubSessionId);
    if (!entry) return;
    if (entry._idleTimer) clearTimeout(entry._idleTimer);
    entry._idleTimer = setTimeout(async () => {
      entry._idleTimer = null;
      if (!entry.transcriptPath) return;
      try {
        const text = await readLastAssistantMessageFromClaudeTranscript(entry.transcriptPath);
        if (!text || !text.trim()) return;
        if (text === entry.lastText) return; // 已 emit 过相同内容（如 Stop hook 抢先）
        entry.lastText = text;
        this.emit('turn-complete', {
          hubSessionId,
          text,
          completedAt: Date.now(),
          signalSource: 'idle_timer_5s',
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
        const text = await readLastAssistantMessageFromClaudeTranscript(entry.transcriptPath);
        if (!text || !text.trim()) return;
        if (text === entry.lastText) return; // 已 emit 过相同内容（如 Stop hook 抢先）
        entry.lastText = text;
        this.emit('turn-complete', {
          hubSessionId,
          text,
          completedAt: Date.now(),
          signalSource: 'stop_reason_terminal',
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
  constructor() {
    super();
    this._pending = new Map(); // hubSessionId → { cwd, spawnTime }
    this._bound = new Map();   // hubSessionId → { rolloutPath, tail, lastText }
    this._pollTimer = null;
    this._seen = new Set();    // rollout paths we've already processed
    this._scanning = false;    // re-entry guard: setInterval may fire while
                               // a slow scan is still in flight; without this
                               // two scans could both pass _seen.has() then
                               // both _tryBind() and double-bind a file.
  }

  registerSession(hubSessionId, { cwd } = {}) {
    const normCwd = normalizePathForCompare(cwd || process.cwd());
    this._pending.set(hubSessionId, {
      cwd: normCwd,
      spawnTime: Date.now(),
    });
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

  // 2026-05-02 Bug 修复：手动提取支持 Codex（同 ClaudeTap.extractLatestTurn 设计）。
  //   优先读 rollout 末尾的 task_complete.last_agent_message。
  //   降级：本轮还在 streaming（task_complete 未写）时拼接 sincePromptTs 之后所有
  //   agent_message.message — codex 一个 turn 内会写多条 commentary phase + 最后一条
  //   final phase 的 agent_message，task_complete 才写在末尾。用户 codex 子 session
  //   有真实输出但点"一键提取"返回 null 即此场景。
  //   未绑定 rolloutPath（CodexTap scan 还没找到文件）→ null。
  async extractLatestTurn(hubSessionId, sincePromptTs = 0) {
    const entry = this._bound.get(hubSessionId);
    if (!entry || !entry.rolloutPath) return null;
    let raw;
    try { raw = await fs.promises.readFile(entry.rolloutPath, 'utf8'); }
    catch { return null; }
    const lines = raw.split('\n');

    // 优先：从尾向前扫 task_complete.last_agent_message（带 sincePromptTs 过滤）
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj?.type !== 'event_msg' || obj.payload?.type !== 'task_complete') continue;
      const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
      if (sincePromptTs && Number.isFinite(ts) && ts < sincePromptTs) continue;
      const text = obj.payload.last_agent_message;
      if (typeof text !== 'string' || !text.trim()) continue;
      return { text: text.trim(), source: 'manual_codex_rollout' };
    }

    // 降级：streaming 中（无 task_complete）→ 拼 sincePromptTs 之后所有 agent_message
    const collected = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try { obj = JSON.parse(trimmed); } catch { continue; }
      if (obj?.type !== 'event_msg' || obj.payload?.type !== 'agent_message') continue;
      const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
      if (sincePromptTs && Number.isFinite(ts) && ts < sincePromptTs) continue;
      const msg = obj.payload.message;
      if (typeof msg !== 'string' || !msg.trim()) continue;
      collected.push(msg.trim());
    }
    if (collected.length === 0) return null;
    return { text: collected.join('\n\n'), source: 'manual_codex_rollout_streaming' };
  }

  _ensureWatcher() {
    if (this._pollTimer) return;
    this._scanOnce().catch((e) => console.warn('[codex-tap] scan error:', e.message));
    this._pollTimer = setInterval(() => this._scanOnce().catch((e) => console.warn('[codex-tap] scan error:', e.message)), 1000);
    this._pollTimer.unref?.();
  }

  _stopWatcher() {
    try { clearInterval(this._pollTimer); } catch {}
    this._pollTimer = null;
  }

  _candidateDirs() {
    // Scan today + yesterday. A Codex session started at 23:55 keeps appending
    // to yesterday's rollout file across midnight; the old +1 direction
    // (tomorrow) would never see a real file.
    const now = new Date();
    const dirs = [];
    for (const offset of [0, -86400000]) {
      const d = new Date(now.getTime() + offset);
      const p = path.join(
        CODEX_SESSIONS_ROOT,
        String(d.getFullYear()),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0'),
      );
      dirs.push(p);
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

    const metaCwd = normalizePathForCompare(meta.cwd || '');
    const metaTs = Date.parse(meta.timestamp || '');
    if (!metaCwd) { console.warn(`[codex-tap] rollout has no cwd: ${rolloutPath}`); return; }

    // Fallback: if meta.timestamp is missing/malformed, use file mtime as a
    // best-effort proxy for session start time.
    let effectiveTs = Number.isFinite(metaTs) ? metaTs : null;
    if (effectiveTs == null) {
      try { effectiveTs = (await fs.promises.stat(rolloutPath)).mtimeMs; } catch {}
    }

    let best = null;
    for (const [hubSessionId, entry] of this._pending) {
      if (entry.cwd !== metaCwd) continue;
      if (effectiveTs != null) {
        const delta = effectiveTs - entry.spawnTime;
        // Widened window: Codex sometimes writes session_meta.timestamp well
        // after actual spawn (observed +37s lag on slow starts). Allow up to
        // 5 minutes forward drift, 10s backward for clock skew.
        if (delta < -10000 || delta > 300000) continue;
        if (!best || Math.abs(delta) < Math.abs(best.delta)) {
          best = { hubSessionId, delta };
        }
      } else if (!best) {
        best = { hubSessionId, delta: 0 };
      }
    }
    if (!best) {
      // Rollout outside any pending window — mark seen to skip on future scans.
      this._seen.add(rolloutPath);
      return;
    }

    this._seen.add(rolloutPath);
    this._pending.delete(best.hubSessionId);
    const hubSessionId = best.hubSessionId;

    // Emit session-bound so main.js can persist codexSid for future resume.
    const codexSid = extractCodexSidFromRolloutPath(rolloutPath);
    this.emit('session-bound', { hubSessionId, kind: 'codex', codexSid, rolloutPath });

    // Stage 2 P2-1：Codex 多 turn 加固 — task_complete 后 3s debounce 防误判。
    //   场景：codex 一次 prompt 内可能跑多个 task（think → search → think 再 task_complete），
    //   每个 task 都会写一条 task_complete 事件。我们要的是"全部 task 完成后的最终消息"。
    //   策略：task_complete 触发后启动 3s timer 暂存 pendingText；
    //         若 3s 内观察到新的 task_started 事件（明确表示又起新 task），
    //         取消 pending 并丢弃旧 text，等下一次 task_complete；
    //         3s 静默后才真 emit 'turn-complete'。
    const TASK_COMPLETE_DEBOUNCE_MS = 3000;
    const onLine = (obj) => {
      if (obj?.type !== 'event_msg' || !obj.payload) return;
      const entry = this._bound.get(hubSessionId);
      if (!entry) return;
      const eventType = obj.payload.type;

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
            completedAt: Date.now(),
            durationMs: finalDuration,
            signalSource: 'task_complete',
          });
        }, TASK_COMPLETE_DEBOUNCE_MS);
      }
    };

    const tail = new JsonlTail(rolloutPath, onLine);
    this._bound.set(hubSessionId, {
      rolloutPath, tail, lastText: null,
      _pendingEmitTimer: null, _pendingText: null, _pendingDurationMs: null,
    });
    await tail.start();
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
  constructor() {
    super();
    this._pending = new Map(); // hubSessionId → { cwd, spawnTime, projectDir }
    this._bound = new Map();   // hubSessionId → { sessionPath, tail, lastText, isJsonl, debounceTimer }
    this._pollTimer = null;
    this._seen = new Set();    // session file paths we've already bound
    this._scanning = false;    // re-entry guard (see CodexTap for rationale)
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
  //   _rtWaitTurnComplete 在 watcher settle 时调 this.getLastTokens(sid) 拿到最新值，
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
  //   返回数组 Array<Block> | null，与 ClaudeTap 同形（main.js _rtExtractStreamingText 统一处理）。
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
      const ts = typeof obj.timestamp === 'number' ? obj.timestamp
              : typeof obj.ts === 'number' ? obj.ts
              : null;
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
    this._scanOnce().catch(() => {});
    this._pollTimer = setInterval(() => this._scanOnce().catch(() => {}), 1000);
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
      try { tmpDirs = await fs.promises.readdir(GEMINI_TMP_ROOT); } catch { return; }

      // Phase 1: resolve projectDir for pending entries without one
      for (const [, entry] of this._pending) {
        if (entry.projectDir) continue;
        for (const sub of tmpDirs) {
          const projectRootFile = path.join(GEMINI_TMP_ROOT, sub, '.project_root');
          let content;
          try { content = await fs.promises.readFile(projectRootFile, 'utf8'); }
          catch { continue; }
          if (normalizePathForCompare(content.trim()) === entry.cwd) {
            entry.projectDir = path.join(GEMINI_TMP_ROOT, sub);
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
    // Card optimization Task 2（2026-05-01）— streamingBuf 累积流式 chunk，让 main.js _rtExtractStreamingText
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
    //   向后兼容——既有调用方（main.js _rtWaitTurnComplete）忽略此字段不影响。
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
          // Card redesign（2026-05-01）：缓存最新 token 计数，让 _rtWaitTurnComplete 在 settle
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
      const tail = new JsonlTail(sessionPath, onLine);
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
// TranscriptTap — 外部入口，组合三个后端
// ---------------------------------------------------------------------------

class TranscriptTap extends EventEmitter {
  constructor() {
    super();
    this._claude = new ClaudeTap();
    this._codex = new CodexTap();
    this._gemini = new GeminiTap();
    for (const b of [this._claude, this._codex, this._gemini]) {
      b.on('turn-complete', (ev) => this.emit('turn-complete', ev));
      b.on('session-bound', (ev) => this.emit('session-bound', ev));
    }
  }

  // kind: 'claude' | 'claude-resume' | 'codex' | 'gemini'
  // ctx: { cwd }
  registerSession(hubSessionId, kind, ctx = {}) {
    if (!hubSessionId || !kind) return;
    const backend = this._backendFor(kind);
    if (!backend) return;
    try { backend.registerSession(hubSessionId, ctx); }
    catch (e) { console.warn(`[transcript-tap] registerSession(${kind}) failed:`, e.message); }
  }

  unregisterSession(hubSessionId) {
    for (const b of [this._claude, this._codex, this._gemini]) {
      try { b.unregisterSession(hubSessionId); } catch {}
    }
  }

  getLastAssistantText(hubSessionId) {
    return (
      this._claude.getLastAssistantText(hubSessionId) ||
      this._codex.getLastAssistantText(hubSessionId) ||
      this._gemini.getLastAssistantText(hubSessionId) ||
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
      (this._codex.getStreamingText ? this._codex.getStreamingText(hubSessionId) : null) ||
      null
    );
  }

  clearStreamingBuf(hubSessionId) {
    for (const b of [this._claude, this._gemini, this._codex]) {
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
  //   Claude/DeepSeek/GLM → ClaudeTap.extractLatestTurn（读 transcript 末 last assistant）
  //   Codex               → CodexTap.extractLatestTurn（读 rollout 末 task_complete）
  //   Gemini              → GeminiTap.extractLatestGeminiTurn（既有实现，过滤 sincePromptTs）
  //   旧 IPC handler 只调 extractLatestGeminiTurn，对 Claude/DeepSeek/GLM/Codex 永远返回 null
  //   → 用户报告"提取按钮假的"。统一入口后所有 backend 都能真正工作。
  //   返回 { text, source } 或 null。调用方应顺序尝试三个 backend，因为同一 sid 只在一个里。
  async extractLatestTurn(hubSessionId, sincePromptTs = 0) {
    // 三个 backend 的 _bound 互斥（一个 sid 只在一个 tap 里），按概率序尝试
    let r = null;
    try { r = await this._claude.extractLatestTurn(hubSessionId, sincePromptTs); } catch {}
    if (r && r.text) return r;
    try { r = await this._gemini.extractLatestGeminiTurn(hubSessionId, sincePromptTs); } catch {}
    if (r && r.text) return r;
    try { r = await this._codex.extractLatestTurn(hubSessionId, sincePromptTs); } catch {}
    if (r && r.text) return r;
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

  _backendFor(kind) {
    // DeepSeek / GLM 跑在 Claude Code CLI 上（CLAUDE_CONFIG_DIR 隔离），transcript JSONL
    // 与 Claude 同 shape（spike 验证：tests/_spike-deepseek-stop-hook-result.md），
    // 直接复用 ClaudeTap 即让圆桌 timeline + streaming preview 自动接入。
    if (kind === 'claude' || kind === 'claude-resume' || kind === 'deepseek' || kind === 'glm') {
      return this._claude;
    }
    if (kind === 'codex') return this._codex;
    if (kind === 'gemini') return this._gemini;
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
  JsonlTail,
  readLastAssistantMessageFromClaudeTranscript,
  extractCodexSidFromRolloutPath,
  extractGeminiChatIdFromSessionPath,
  extractGeminiProjectHashFromDir,
};
