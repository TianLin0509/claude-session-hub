'use strict';
// core/group-chat-watcher.js
// 群聊 PTY 通信工具集（2026-05-03 道雪 阶段丙）。
// 从 main.js 抽出 5 个 helper：waitCliReady / sendToPty / extractStreamingText /
//   cleanBufLen / checkHostShellTakeover。
//
// 不抽：_gcWaitTurnComplete + _activeWatchers Map + dispatchGroupChatTurn。
//   它们闭包依赖太深（meetingManager/scenes/orchestrator/rtTimeline/rtInjection/
//   sendToRenderer...），一次性抽风险高，
//   留下次专项做（backlog）。
//
// 依赖注入（init）：sessionManager / cliReadyDetector / transcriptTap

const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectHostShellTakeover } = require('./host-shell-detector.js');
const { isClaudeFamily, isCodexCliKind } = require('./ai-kinds.js');
const { stripAnsi } = require('./ansi-utils.js');
const {
  RUNTIME_RUNNING,
  advanceRunningAnimationCandidate,
  classifyTerminalRuntime,
} = require('./terminal-runtime-state.js');

// xterm bracketed paste mode markers（标准协议，claude code TUI 完整识别）。
//   marker 之间的内容被 CLI 视作"一次粘贴"整体处理，无需 paste-detect timing 探测，
//   BP_END 之后的 \r 直接作为提交信号被识别。
//   Claude family 与当前 Codex 都支持；DeepSeek 迁移到 Codex 后也走 Codex 分支。
//   marker 常量与分块/settle 原语都在 core/pty-prompt-submit.js，普通会话走同一套。
//   本文件不再直接拼 BP 帧（writeBracketedPaste 负责），所以只引原语不引常量。
const {
  computeSettleMs,
  writeBracketedPaste,
  waitForPasteSettled,
  snapshotPasteMarker,
  pasteStillInInputBox,
} = require('./pty-prompt-submit.js');

let _deps = null;

function init(deps) {
  _deps = deps;
}

function resolveRuntimeKind(sessionManager, sid, fallbackKind) {
  if (!sessionManager || typeof sessionManager.getSession !== 'function') return fallbackKind;
  const session = sessionManager.getSession(sid);
  return (session && session.transcriptKind) || fallbackKind;
}

function writeCodexPromptFile(sessionManager, sid, text) {
  const session = typeof sessionManager.getSession === 'function' ? sessionManager.getSession(sid) : null;
  const baseDir = session && session.cwd ? session.cwd : os.tmpdir();
  const dir = path.join(baseDir, '.hub-codex-prompts');
  fs.mkdirSync(dir, { recursive: true });
  const safeSid = String(sid || 'session').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'session';
  const fp = path.join(dir, `groupchat-${safeSid}-${Date.now()}.md`);
  fs.writeFileSync(fp, text, 'utf8');
  return fp;
}

async function writePromptToSession(sessionManager, sid, prompt, kind) {
  const text = String(prompt || '');
  if (!isCodexCliKind(kind)) {
    sessionManager.writeToSession(sid, text);
    return text;
  }
  if (/[^\x00-\x7F]/.test(text)) {
    try {
      const fp = writeCodexPromptFile(sessionManager, sid, text);
      const pointerPrompt = [
        `A UTF-8 group-chat prompt has been saved to this file: ${fp}.`,
        'Read that file, follow its instructions exactly, and answer in the language/schema requested inside it.',
        'If it asks for JSON, include the required JSON block exactly.',
        'Do not summarize the prompt file; execute the prompt.',
      ].join(' ');
      sessionManager.writeToSession(sid, pointerPrompt);
      return pointerPrompt;
    } catch (e) {
      console.warn(`[group-chat] failed to write Codex prompt file for ${sid}:`, e && e.message);
    }
  }
  if (text.length <= 8000) {
    sessionManager.writeToSession(sid, text);
    return text;
  }
  const chunkSize = 2048;
  for (let i = 0; i < text.length; i += chunkSize) {
    sessionManager.writeToSession(sid, text.slice(i, i + chunkSize));
    await new Promise(r => setTimeout(r, 12));
  }
  return text;
}

function noteSubmittedPrompt(sid, kind, actualPrompt) {
  if (!isCodexCliKind(kind)) return;
  const tap = _deps && _deps.transcriptTap;
  if (!tap || typeof tap.notePrompt !== 'function') return;
  try { tap.notePrompt(sid, kind, actualPrompt); }
  catch (e) { console.warn(`[group-chat] transcriptTap.notePrompt failed for ${kind}(${String(sid).slice(0, 8)}):`, e && e.message); }
}

function observeAgentTurnStart(sessionManager, sid, kind) {
  if (!isCodexCliKind(kind) && !isClaudeFamily(kind)) return null;
  const tap = _deps && _deps.transcriptTap;
  const canObserveSession = sessionManager
    && typeof sessionManager.on === 'function'
    && typeof sessionManager.removeListener === 'function';
  const canObserveTap = isCodexCliKind(kind)
    && tap && typeof tap.on === 'function' && typeof tap.removeListener === 'function';
  if (!canObserveSession && !canObserveTap) return null;
  const baselineSeq = typeof sessionManager.getAgentTurnStartSeq === 'function'
    ? sessionManager.getAgentTurnStartSeq(sid)
    : 0;
  let started = false;
  let acknowledgement = null;
  let resolveStarted = null;
  const startedPromise = new Promise((resolve) => { resolveStarted = resolve; });
  const settle = (event, source) => {
    if (started) return;
    started = true;
    acknowledgement = {
      source: event.signalSource || source,
      observedAt: Number(event.observedAt || event.startedAt) || Date.now(),
      turnId: event.turnId || null,
    };
    resolveStarted(acknowledgement);
  };
  const sessionListener = (event = {}) => {
    if (event.sessionId !== sid) return;
    if (Number(event.seq) && Number(event.seq) <= baselineSeq) return;
    settle(event, 'agent-turn-started');
  };
  const tapListener = (event = {}) => {
    if (event.hubSessionId !== sid) return;
    settle(event, 'task_started');
  };
  if (canObserveSession) sessionManager.on('agent-turn-started', sessionListener);
  if (canObserveTap) tap.on('turn-started', tapListener);
  return {
    get started() { return started; },
    get acknowledgement() { return acknowledgement; },
    async wait(timeoutMs) {
      if (started) return acknowledgement;
      return Promise.race([
        startedPromise,
        new Promise(resolve => setTimeout(() => resolve(null), Math.max(0, Number(timeoutMs) || 0))),
      ]);
    },
    dispose() {
      if (canObserveSession) sessionManager.removeListener('agent-turn-started', sessionListener);
      if (canObserveTap) tap.removeListener('turn-started', tapListener);
    },
  };
}

function probeStrongPtyWorkStart(sessionManager, sid, kind, probeState) {
  if (!sessionManager || typeof sessionManager.getSessionBuffer !== 'function') return null;
  const raw = String(sessionManager.getSessionBuffer(sid) || '');
  const baselineLength = Math.max(0, Number(probeState.baselineLength) || 0);
  // Prefer bytes produced after this send. Ring truncation/reset falls back to
  // the available buffer rather than silently disabling the probe.
  const current = raw.length >= baselineLength ? raw.slice(baselineLength) : raw;
  const clean = stripAnsi(current).replace(/\r/g, '\n');
  const runtime = classifyTerminalRuntime(kind, clean.split(/\n/));
  probeState.lastRingRuntime = runtime;
  probeState.lastRingTail = clean.slice(-1200);
  const advanced = advanceRunningAnimationCandidate(probeState.ringCandidate, runtime, Date.now());
  probeState.ringCandidate = advanced.candidate;
  if (!advanced.confirmed || runtime.state !== RUNTIME_RUNNING) return null;
  return {
    source: `pty-${runtime.reason || 'strong-running'}`,
    observedAt: Date.now(),
    turnId: null,
    evidence: runtime.evidence || null,
  };
}

function createLivePtyRuntimeObserver(sessionManager, sid, kind) {
  if (!sessionManager || typeof sessionManager.on !== 'function' || typeof sessionManager.removeListener !== 'function') return null;
  let Terminal;
  try { ({ Terminal } = require('@xterm/headless')); } catch { return null; }
  let terminal;
  try {
    terminal = new Terminal({
      cols: 120,
      rows: 30,
      scrollback: 2000,
      allowProposedApi: true,
      ...(process.platform === 'win32' ? {
        windowsPty: { backend: 'conpty', buildNumber: parseInt(os.release().split('.').pop(), 10) || 0 },
      } : {}),
    });
  } catch { return null; }
  let queue = Promise.resolve();
  let disposed = false;
  let writeErrorLogged = false;
  const enqueue = (data) => {
    if (disposed || !data) return;
    queue = queue.then(() => new Promise(resolve => terminal.write(String(data), resolve))).catch(error => {
      if (!writeErrorLogged) {
        writeErrorLogged = true;
        console.warn('[group-chat] live PTY runtime probe write failed:', error && error.message);
      }
    });
  };
  const listener = (event = {}) => {
    if (event.sessionId === sid) enqueue(event.data);
  };
  sessionManager.on('output', listener);
  enqueue(sessionManager.getSessionBuffer(sid) || '');
  return {
    async probe(probeState) {
      if (disposed) return null;
      await queue;
      const buffer = terminal.buffer && terminal.buffer.active;
      if (!buffer) return null;
      const lines = [];
      const start = Math.max(0, Number(buffer.viewportY) || 0);
      for (let y = start; y < Math.min(buffer.length, start + terminal.rows); y += 1) {
        const line = buffer.getLine(y);
        if (line) lines.push(line.translateToString(true));
      }
      const runtime = classifyTerminalRuntime(kind, lines);
      probeState.lastLiveRuntime = runtime;
      probeState.lastLiveLines = lines.slice(-12);
      const advanced = advanceRunningAnimationCandidate(probeState.liveCandidate, runtime, Date.now());
      probeState.liveCandidate = advanced.candidate;
      if (!advanced.confirmed || runtime.state !== RUNTIME_RUNNING) return null;
      return {
        source: `pty-${runtime.reason || 'strong-running'}`,
        observedAt: Date.now(),
        turnId: null,
        evidence: runtime.evidence || null,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      sessionManager.removeListener('output', listener);
      try { terminal.dispose(); } catch {}
    },
  };
}

// 最近一次探针是否已经把屏幕读成「正在跑」。这里刻意不要求动画确认帧：
//   waitForAgentWorkStart 只在 confirmed 时才返回，而「未确认但确实在跑」正是
//   最不该补回车的状态。用作补 Enter 的否决条件，而不是开工的肯定证据。
function looksAlreadyRunning(probeState) {
  if (!probeState) return false;
  return (probeState.lastLiveRuntime && probeState.lastLiveRuntime.state === RUNTIME_RUNNING)
    || (probeState.lastRingRuntime && probeState.lastRingRuntime.state === RUNTIME_RUNNING);
}

async function waitForAgentWorkStart(observer, sessionManager, sid, kind, timeoutMs, probeState, livePtyObserver) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() < deadline) {
    if (observer && observer.started) return observer.acknowledgement;
    const pty = (livePtyObserver && await livePtyObserver.probe(probeState))
      || probeStrongPtyWorkStart(sessionManager, sid, kind, probeState);
    if (pty) return pty;
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
  }
  if (observer && observer.started) return observer.acknowledgement;
  return (livePtyObserver && await livePtyObserver.probe(probeState))
    || probeStrongPtyWorkStart(sessionManager, sid, kind, probeState);
}

async function clearCodexInputLine(sessionManager, sid, kind) {
  if (!isCodexCliKind(kind)) return false;
  // Codex can keep an unsubmitted prompt in the input box after zero-echo /
  // timeout. Clear the line before an automatic rewrite so the next prompt
  // does not concatenate with the previous file-pointer prompt.
  sessionManager.writeToSession(sid, '\x15'); // Ctrl+U
  await new Promise(r => setTimeout(r, 80));
  return true;
}

function writeSubmitSignal(sessionManager, sid, kind, attempt = 0) {
  if (!isCodexCliKind(kind)) {
    sessionManager.writeToSession(sid, '\r');
    return 'cr';
  }
  const variants = ['\r', '\n', '\r\n'];
  const signal = variants[Math.max(0, Number(attempt) || 0) % variants.length];
  sessionManager.writeToSession(sid, signal);
  if (signal === '\n') return 'lf';
  if (signal === '\r\n') return 'crlf';
  return 'cr';
}

async function writeSubmitFallbackSignals(sessionManager, sid, kind, tries = 1, gapMs = 150) {
  const total = isCodexCliKind(kind) ? Math.max(1, Number(tries) || 1) : 1;
  for (let i = 0; i < total; i += 1) {
    writeSubmitSignal(sessionManager, sid, kind, i);
    if (i < total - 1) {
      await new Promise(r => setTimeout(r, gapMs));
    }
  }
}

// ---------------------------------------------------------------------------
// waitCliReady — 群聊发送 prompt 前的等待轮询。判定逻辑独立到
//   core/group-chat-cli-ready-detector.js（marker + buffer 静默双门 + monotonic guard）。
//   timeout 提到 60s 兜底（Claude Opus 1M 启动 + 配置加载在慢机可能 30s+）。
async function waitCliReady(sid, kind, maxMs = 60000) {
  const { sessionManager, cliReadyDetector } = _deps;
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const buf = sessionManager.getSessionBuffer(sid) || '';
    if (cliReadyDetector.isReady(sid, kind, buf)) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

// ---------------------------------------------------------------------------
// sendToPty — 发送 prompt 到 PTY 并回车。
// 设计：CLI 初始化是持久状态，只需做一次。session-manager 的 groupChatReady 缓存
//       让第 2-N 轮跳过冷启动等待，直接走快路径。
// **关键约束（历史 bug 重现于 2026-04-30）**：Claude/Gemini/Codex 三家都是 TUI alt-screen 程序，
//   把紧贴到达的字符当"粘贴"事件 → 粘贴里的 '\r' 被当文本换行符而不是 Enter 提交。
//   所以 prompt 和 '\r' **必须分两次 write**，中间留 TUI 消化窗口；不能合并 `prompt + '\r'`。
// options.requireReady=false：跳过冷启动 waitCliReady（2026-09-03）。
//   普通会话的输入框就摆在用户面前，CLI 显然已经在跑；再等一次 60s 的 ready 轮询
//   只会把"打完字立刻发出去"变成有时要等几十秒。群聊派发默认仍为 true。
async function sendToPty(sid, prompt, kind, options = {}) {
  const { sessionManager } = _deps;
  const requireReady = options.requireReady !== false;
  kind = resolveRuntimeKind(sessionManager, sid, kind);
  const FAST_PATH_QUIET_MS = 250;       // 连续 250ms 无 PTY 数据 → 视为 paste 接收完
  const FAST_PATH_MAX_WAIT_MS = 3000;   // 上限：极大 prompt 也不无限等
  const FAST_PATH_POLL_MS = 50;
  const ENTER_RETRY_TRIES = 3;          // legacy 非协议路径的有界提交兜底
  const ENTER_RETRY_GAP_MS = 150;       // 兜底 \r 之间间隔
  const POST_ENTER_VERIFY_MS = 500;     // 提交后再观察一次活性，确认没卡
  // bug A 修复（2026-05-03 道雪）：turn 间 race condition
  //   stop_hook / stop_reason 触发时 Claude 逻辑层已结束本轮，但 PTY 终端
  //   仍在异步喷收尾字符（清 spinner / 重画 prompt /TUI 装饰）。Hub 立刻 type
  //   下一轮 prompt 会撞上 PTY 余响，prompt 被 throbbing 状态吃掉、单个 \r
  //   不触发提交 → sub 表面"sent"但 jsonl 没收到 user msg → 5min 硬超时
  //   才标 absent。修：写 prompt 前等 PTY 真正静默 N ms。
  const PRE_PROMPT_QUIET_MS = 1500;     // 至少 1.5s PTY 无新字符
  const PRE_PROMPT_MAX_WAIT_MS = 8000;  // 上限：避免持续 spinner 死等

  // 冷启动：仅首次或 ready 被重置后（requireReady=false 的调用方整段跳过）
  if (requireReady && !sessionManager.getGroupChatReady(sid)) {
    const ready = await waitCliReady(sid, kind, 60000);
    // CLI 完全没启动 → prompt 都没写，可以正当放弃
    if (!ready) {
      const buf = sessionManager.getSessionBuffer(sid) || '';
      console.warn(`[group-chat] cli not ready for ${kind}(${sid.slice(0, 8)}) after 60s; bufLen=${buf.length}; tail=${JSON.stringify(buf.slice(-160))}`);
      return false;
    }
    sessionManager.setGroupChatReady(sid, true);
  }

  // ===========================================================================
  // 1A fast-path：claude family 走 xterm bracketed paste，跳过 PRE_PROMPT_QUIET
  // / paste-detect 静默等待（最多省 4-5s）。
  //   旧主路径用 timing 探测（PTY 静默 1.5s + paste-detect 静默 250ms）来近似
  //   "CLI paste 缓冲已收完"，但 Ink TUI 持续重渲染（spinner/cursor blink）让静默
  //   信号失真，timing 经常上限超时硬冲、\r 被吃掉、prompt 留输入框没提交。
  //   bracketed paste markers 是显式协议，CLI 一看到 BP_END 就明确"粘贴结束"，
  //   无需任何 timing 探测。claude family 实测稳定通过。
  //   2026-06-18 道雪 实测：codex 0.137 也已支持 BP 协议（BP 包裹中文立即提交、不进
  //     [Pasted Content] 粘贴态、不卡输入框）→ codex 改走此 fast-path，一并解决"卡输入框
  //     未提交"(Bug B) + "中文走 .md 文件中转嵌入"(Bug C：BP 直接发中文，不再经 writePromptToSession)。
  //   gemini 协议仍不识别（marker 被吃但 \r 不提交），保留旧主路径。
  if (isClaudeFamily(kind) || isCodexCliKind(kind)) {
    // Capture the provider lifecycle cursor before typing.  Claude
    // UserPromptSubmit and Codex task_started are the same authoritative
    // "agent really began work" signal that drives ordinary-session status.
    const turnStart = observeAgentTurnStart(sessionManager, sid, kind);
    const livePtyObserver = createLivePtyRuntimeObserver(sessionManager, sid, kind);
    try {
    await clearCodexInputLine(sessionManager, sid, kind); // codex 清输入框残留，防与上次未提交内容拼接（claude no-op）
    const beforeBufferLength = String(sessionManager.getSessionBuffer(sid) || '').length;
    const beforeWrite = sessionManager.getGroupChatLastActivity(sid);
    // 分块投喂（2026-09-03）：单次 write 几十 KB 会把 node-pty 的 inSocket 队列灌满，
    //   随后那个 \r 被追加进同一条队列，很可能与 BP_END 落进 CLI 的同一个 stdin chunk
    //   被当粘贴尾巴吃掉。分片写让队列在最后一片写完时接近空，\r 才可能独立成块。
    const baselineMarker = snapshotPasteMarker(sessionManager, sid);
    await writeBracketedPaste(sessionManager, sid, prompt, {
      chunkSize: Number(_deps && _deps.bracketedPasteChunkSize) || undefined,
      gapMs: Number(_deps && _deps.bracketedPasteChunkGapMs) || undefined,
    });
    noteSubmittedPrompt(sid, kind, prompt); // codex 记录原始 prompt 供 transcript 提交校验（claude no-op）
    // BP_END 紧贴 \r 时 Ink 把 \r 当 paste 尾巴忽略，所以必须隔开再发。
    //   隔多久以前写死 500ms —— 短 prompt 够用，长 prompt 必然还在消化窗口内，
    //   于是"输入越长越容易卡输入框"。改成两条：
    //     1) settle 上限随体积走（computeSettleMs）
    //     2) 屏幕上出现新的折叠标记就提前收工（正向信号，不再干等）
    //   bracketedPasteSettleMs 显式配置时仍按固定值走，保留测试与应急旁路。
    const configuredSettleMs = Number(_deps && _deps.bracketedPasteSettleMs);
    const pasteSettleMs = Number.isFinite(configuredSettleMs) && configuredSettleMs > 0
      ? configuredSettleMs
      : computeSettleMs(String(prompt || '').length, {
        minMs: Number(_deps && _deps.bracketedPasteSettleMinMs) || undefined,
        maxMs: Number(_deps && _deps.bracketedPasteSettleMaxMs) || undefined,
      });
    await waitForPasteSettled({ sessionManager, sid, settleMs: pasteSettleMs, baselineMarker });
    // One Enter first.  Extra Enters are conditional on the absence of a
    // semantic work-start acknowledgement, rather than being fired blindly.
    // This mirrors the normal-session runtime truth and avoids accidental
    // empty submissions after a prompt already started.
    sessionManager.writeToSession(sid, '\r');
    let enterAttempts = 1;

    // 2026-05-05 fix（虚警 bug）：单点 500ms 后查一次 lastActivity 变化，对 claude
    //   慢启动场景误判 stuck（实测：\r 后 claude TUI 渲染 user message + 启 streaming
    //   延迟在 200-1500ms 间，500ms 单点窗口边缘 case 失败率高 → 卡片显示"输入卡顿"
    //   但实际 25s 内已输出 750 字）。改成轮询窗口：activity 一变就早 break，
    //   仅真 stuck 时跑满 1500ms 才标。正常情况 dispatch 净延迟仍 < 1s。
    let sendStatus = 'ok';
    let acknowledgement = null;
    let probeState = null;
    if (turnStart) {
      // Large bracketed pastes need time to leave the TUI input state.
      // 实测（20260831，Codex CLI 0.151.0，222 行 / 14,061 字）：从提交到 task_started
      //   稳定落在 4708-4847ms。窗口若取 4000ms，这条"有条件"的补 Enter 就变成每次必发，
      //   3 次试验里还多打出过一个 Codex turn。取 9s 留约 2 倍余量：宁可晚 5 秒报 stuck，
      //   也不要在 agent 已经开工后再补一次回车。
      const firstAckMs = Math.max(20, Number(_deps && (_deps.agentTurnStartAckMs || _deps.codexTurnStartAckMs) || 9000));
      const recoveryAckMs = Math.max(20, Number(_deps && (_deps.agentTurnStartRecoveryMs || _deps.codexTurnStartRecoveryMs) || 6000));
      const configuredRetryMax = Number(_deps && _deps.agentTurnStartRetryMax);
      const retryMax = Number.isFinite(configuredRetryMax)
        ? Math.max(0, Math.min(2, configuredRetryMax))
        : 1;
      probeState = { baselineLength: beforeBufferLength, liveCandidate: null, ringCandidate: null };
      acknowledgement = await waitForAgentWorkStart(turnStart, sessionManager, sid, kind, firstAckMs, probeState, livePtyObserver);
      let recoveryAttempts = 0;
      // PTY activity alone is not proof of submission: Codex redraws the input
      // box while a `[Pasted Content …]` block is still waiting for Enter. A
      // provider lifecycle event is the semantic acknowledgement. If absent,
      // send a late isolated Enter only then, exactly as the user would.
      // 「屏幕在跑」到底该不该补回车，取决于**输入框里还有没有没提交的粘贴内容**
      //   （2026-09-03，实测逼出来的）。
      //   旧写法只看 looksAlreadyRunning：命中就 continue，而 retryMax=1 时那个 continue
      //   直接把 attempt 推到上限、循环结束 —— **补发回车一次都没发**却报了 stuck。
      //   实测现场（Codex 普通会话 220 行）正是如此：上一轮答案还在收尾，屏幕被读成"在跑"，
      //   于是 220 行 prompt 以 `› [Pasted Content 10377 chars]` 永远留在输入框里，
      //   enterAttempts 停在 1，用户干等。
      //
      //   两种情形都真实存在，区分它们的不是预算而是正向证据：
      //     - 屏幕末尾还挂着折叠标记 → 这次粘贴**没提交**，补回车是唯一救援，必须发；
      //     - 屏幕在跑且输入框是空的 → prompt 已经进去了，确认只是慢，补回车才会多起一轮
      //       （那正是 unit-groupchat-redundant-enter-guard 锁住的实测教训）。
      //   注意只看可见屏幕末尾行：ring buffer 是只增历史，提交成功后标记依然留在里面。
      const maxRunningExtends = Math.max(0, Number(_deps && _deps.agentTurnStartRunningExtends) || 2);
      let runningExtends = 0;
      // 记下「看到屏幕在跑、且输入框里没有未提交的折叠粘贴」这个观察，
      //   循环结束后用它把"确认迟到"和"真的卡住"分开。
      let observedRunningWithClearInput = false;
      for (let attempt = 0; !acknowledgement && attempt < retryMax;) {
        const pasteStillPending = pasteStillInInputBox(probeState);
        if (!pasteStillPending && looksAlreadyRunning(probeState)) {
          observedRunningWithClearInput = true;
          if (runningExtends >= maxRunningExtends) {
            console.warn(`[group-chat] ${kind} work-start still unconfirmed for ${sid.slice(0, 8)}, but the input box is clear and the screen reads running; not pressing Enter`);
            break;
          }
          runningExtends += 1;
          console.warn(`[group-chat] ${kind} work-start unconfirmed for ${sid.slice(0, 8)} but the screen already reads running; extending the wait ${runningExtends}/${maxRunningExtends} instead of pressing Enter`);
          acknowledgement = await waitForAgentWorkStart(turnStart, sessionManager, sid, kind, recoveryAckMs, probeState, livePtyObserver);
          continue;
        }
        attempt += 1;
        recoveryAttempts += 1;
        enterAttempts += 1;
        console.warn(`[group-chat] ${kind} prompt has no agent work-start acknowledgement for ${sid.slice(0, 8)}${pasteStillPending ? ' and a collapsed paste is still sitting in the input box' : ''}; sending late Enter recovery ${attempt}/${retryMax}`);
        sessionManager.writeToSession(sid, '\r');
        acknowledgement = await waitForAgentWorkStart(turnStart, sessionManager, sid, kind, recoveryAckMs, probeState, livePtyObserver);
      }
      // 「屏幕跑过 + 输入框是空的」本身就是提交成功的证据（2026-09-03）。
      //   实测现场：新建 Codex 会话的**第一轮**，rollout 还没绑定所以 task_started 迟到，
      //   而答案又短到 running footer 没撑够确认帧 —— 于是没有任何 lifecycle 确认。
      //   但屏幕上答案已经打出来了、输入框空着。此时报 stuck 是自相矛盾的：
      //   stuck 的含义是「prompt 还躺在输入框里没提交」，而我们明明观察到它离开了输入框。
      //   照报不误的话，用户会在一次完全正常的发送上看到「⚠ 消息可能没提交」。
      //   注意这只在**从未按过补发回车**的路径上成立；真正卡住的那条路输入框里有折叠标记，
      //   走的是上面补回车的分支，拿不到确认仍然如实报 stuck。
      if (!acknowledgement && observedRunningWithClearInput) {
        console.warn(`[group-chat] ${kind} prompt has no lifecycle acknowledgement for ${sid.slice(0, 8)}, but the screen ran with a clear input box; treating it as submitted`);
        acknowledgement = { source: 'pty-running-input-clear', observedAt: Date.now(), turnId: null };
      }
      if (!acknowledgement) {
        console.warn(`[group-chat] ${kind} prompt submission not acknowledged for ${sid.slice(0, 8)} after late Enter recovery`);
        sendStatus = 'stuck';
      } else if (recoveryAttempts > 0) {
        sendStatus = 'auto_recovered';
      }
    } else {
      // Compatibility fallback for lightweight test/mocked managers without a
      // lifecycle event bus.  A repaint is weaker evidence, but still better
      // than reporting success after total silence.
      await new Promise(r => setTimeout(r, 1500));
      if (sessionManager.getGroupChatLastActivity(sid) === beforeWrite) sendStatus = 'stuck';
    }
    return {
      ok: true,
      sendStatus,
      acknowledgementSource: acknowledgement && acknowledgement.source || null,
      enterAttempts,
      ...(_deps && _deps.enableSendDiagnostics ? {
        probeDiagnostics: {
          lastLiveRuntime: probeState && probeState.lastLiveRuntime || null,
          lastLiveLines: probeState && probeState.lastLiveLines || null,
          lastRingRuntime: probeState && probeState.lastRingRuntime || null,
          lastRingTail: probeState && probeState.lastRingTail || null,
        },
      } : {}),
    };
    } finally {
      // PTY writes and transcript readers are external boundaries. Any throw
      // along the path must still release the semantic acknowledgement hook.
      if (turnStart) turnStart.dispose();
      if (livePtyObserver) livePtyObserver.dispose();
    }
  }
  // ===========================================================================

  // bug A 修复：发 prompt 前等 PTY 静默（不依赖 cold-start 路径）。
  //   语义层信号（stop_hook/stop_reason）触发 ≠ 设备层 PTY 静止；前者是
  //   "Claude 答完最后一个字"，后者是"终端扩音器关掉"。
  {
    const startQuiet = Date.now();
    let lastSeenPre = sessionManager.getGroupChatLastActivity(sid);
    let lastChangePre = Date.now();
    while (Date.now() - startQuiet < PRE_PROMPT_MAX_WAIT_MS) {
      await new Promise(r => setTimeout(r, FAST_PATH_POLL_MS));
      const cur = sessionManager.getGroupChatLastActivity(sid);
      if (cur !== lastSeenPre) {
        lastSeenPre = cur;
        lastChangePre = Date.now();
      }
      if (Date.now() - lastChangePre >= PRE_PROMPT_QUIET_MS) break;
    }
    const totalWait = Date.now() - startQuiet;
    if (totalWait >= PRE_PROMPT_MAX_WAIT_MS) {
      console.warn(`[group-chat] pre-prompt PTY never quiet for ${kind}(${sid.slice(0,8)}); proceeded after ${totalWait}ms ceiling`);
    }
  }

  // 第 1 次 write：仅 prompt（不带 '\r'）
  const beforeWrite = sessionManager.getGroupChatLastActivity(sid);
  await clearCodexInputLine(sessionManager, sid, kind);
  const actualPrompt = await writePromptToSession(sessionManager, sid, prompt, kind);
  noteSubmittedPrompt(sid, kind, actualPrompt);

  // 自适应安静期等待：每 50ms 检查 lastActivity，
  //   连续 250ms 无变化 → CLI paste-detect timer 已 fire，安全发 Enter
  //   一直在抖动 → 等到 MAX，仍发 \r（best effort，与老 300ms 行为同等保守）
  const startWait = Date.now();
  let lastSeen = beforeWrite;
  let lastChange = Date.now();
  while (Date.now() - startWait < FAST_PATH_MAX_WAIT_MS) {
    await new Promise(r => setTimeout(r, FAST_PATH_POLL_MS));
    const cur = sessionManager.getGroupChatLastActivity(sid);
    if (cur !== lastSeen) {
      lastSeen = cur;
      lastChange = Date.now();
    }
    if (Date.now() - lastChange >= FAST_PATH_QUIET_MS) break;
  }

  // 关键修复（2026-05-02 血泪教训第 N 次）：prompt 字符已经在 PTY stdin 里，
  //   **`\r` 必须发出去**。旧逻辑在零 echo 时直接 return false 不发 \r，导致用户的
  //   prompt 卡在 CLI 输入框需要手按 Enter — 这是用户反复反馈的核心 bug。
  //
  // 为什么 \r 多发是安全的（与"prompt 不能重发"对比）：
  //   - prompt 重发 → 输入框出现 prompt+prompt → 提交后内容污染（旧注释正确警告了这点）
  //   - \r 多发    → 输入框有 prompt 时首个 \r 触发提交，后续 \r 落入空输入框被
  //                  CLI 忽略（PowerShell 也只是显示空提示符）；不污染 prompt 内容
  //
  // 决策：echo 正常 → 发 1 次 \r；零 echo → 发 3 次 \r（间隔 150ms），让 paste-end
  //   状态机被卡在 throbbing/工具调用中的 CLI 也能"看见" Enter。
  const echoSeen = lastSeen !== beforeWrite;
  if (isCodexCliKind(kind)) {
    await writeSubmitFallbackSignals(sessionManager, sid, kind, ENTER_RETRY_TRIES, ENTER_RETRY_GAP_MS);
  } else if (echoSeen) {
    writeSubmitSignal(sessionManager, sid, kind, 0);
  } else {
    console.warn(`[group-chat] zero-echo for ${kind}(${sid.slice(0, 8)}) — sending ${ENTER_RETRY_TRIES} submit fallback signals (prompt already in PTY stdin, MUST commit)`);
    for (let i = 0; i < ENTER_RETRY_TRIES; i++) {
      writeSubmitSignal(sessionManager, sid, kind, i);
      if (i < ENTER_RETRY_TRIES - 1) {
        await new Promise(r => setTimeout(r, ENTER_RETRY_GAP_MS));
      }
    }
    // ready 重置：下轮走冷启动重新 align（本轮 prompt 已经尽力提交了）
    sessionManager.setGroupChatReady(sid, false);
  }

  // 提交后活性二次确认：再等 500ms 看 PTY 有无新输出。
  //   有 → 正常被 CLI 接住；无 → 标记 suspect（仅日志，不阻塞 turn-completion-watcher）。
  //   不在这里 return false：prompt 已发，应让 watcher 走完整流程（含 host-shell 心跳兜底）。
  await new Promise(r => setTimeout(r, POST_ENTER_VERIFY_MS));
  const afterEnter = sessionManager.getGroupChatLastActivity(sid);
  let sendStatus = 'ok';
  if (afterEnter === lastSeen) {
    console.warn(`[group-chat] post-Enter still zero-echo for ${kind}(${sid.slice(0, 8)}) — trying _autoRecoverSend`);
    const recovered = await _autoRecoverSend({
      sid, kind, prompt, echoSeen,
      timing: { ENTER_RETRY_GAP_MS, POST_ENTER_VERIFY_MS },
    });
    if (recovered) {
      console.log(`[group-chat] _autoRecoverSend recovered ${kind}(${sid.slice(0, 8)}) mode=${echoSeen ? 'enter_only' : 'rewrite_full'}`);
      sendStatus = 'auto_recovered';
    } else {
      console.warn(`[group-chat] _autoRecoverSend failed for ${kind}(${sid.slice(0, 8)}); upgrading to send_stuck`);
      sendStatus = 'stuck';
    }
  }
  return { ok: true, sendStatus };  // 兼容老调用方（boolean truthy）
}

// ---------------------------------------------------------------------------
// extractStreamingText — Card optimization Task 5+6+12（2026-05-01）
//   流式预览净化（方案 C：tap 优先 + placeholder 兜底）。
//   v1（T5/T6）：tap 没数据时退到 PTY ringBuffer + ANSI 剥离 + 行级黑名单。
//   v2（fix）：用户多方审查反馈——PTY 流式期本质不可信（Claude TUI throbbing
//             "thinking with xhigh effort"/"Waddling..." 装饰行 + Codex prompt echo
//             残片 "W/Wo/or" 都进过 preview）。三家审查（Gemini/Codex/DeepSeek V4-pro）
//             一致推荐方案 C：放弃 PTY 兜底，没 tap 数据就显示空 + renderer 端"💭 思考中…"
//             占位，承认 streaming 阶段 PTY 内容不可信。
//   返回 { source: 'tap'|'placeholder', blocks: Array<Block>, text: string }
//   kind 参数保留为 API 稳定性（未使用）。
function extractStreamingText(sid, _kind) {
  const { transcriptTap } = _deps;
  const tapBlocks = transcriptTap.getStreamingText(sid);
  if (Array.isArray(tapBlocks) && tapBlocks.length > 0) {
    const text = tapBlocks
      .filter(b => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('')
      .slice(-500);
    return { source: 'tap', blocks: tapBlocks, text };
  }

  // 没有结构化 tap 数据（Claude streaming 期 Stop hook 未触发 / Codex spike FAIL 永远走兜底）
  //   → 返回空，renderer 显示"💭 思考中…"占位。**不再回退 PTY ringBuffer。**
  return { source: 'placeholder', blocks: [], text: '' };
}

// ---------------------------------------------------------------------------
// cleanBufLen — 心跳指示器 - PTY buffer 剥 ANSI/spinner 后的"可读字符数"
//   用途：streaming 期间推 partial.cleanBufLen，卡片显示"已输出约 N 字"心跳
//   精度：含 CLI 自身状态条文案（"Computing..." "Brewed for 1m"），是活跃度近似值
function cleanBufLen(buf) {
  if (!buf) return 0;
  const cleaned = String(buf)
    .replace(/\[[0-9;?]*[A-Za-z]/g, '')   // ANSI CSI
    .replace(/\][^]*/g, '')   // OSC
    .replace(/[()][\w]/g, '')              // charset
    .replace(/[\b\r]/g, '')                       // backspace + CR
    .replace(/[✻✶✽✢●·*⏺⠁⠂⠄⠈⠐⠠⡀⢀]/g, '');     // spinner symbols
  return cleaned.length;
}

// ---------------------------------------------------------------------------
// _autoRecoverSend — sendToPty verify 失败时的单次自动恢复（2026-05-03）
// 决策依据：echoSeen 物理标志位（不依赖任何字符串匹配/魔数）
//   echoSeen=true  → prompt 已在输入框，仅 \r 没生效 → 补 1x \r
//   echoSeen=false → prompt 完全未进 PTY        → 重写 prompt + 1x \r
// 返回 true=verify 通过；false=仍未恢复，调用方应升级 send_stuck。
async function _autoRecoverSend({ sid, kind, prompt, echoSeen, timing }) {
  const { sessionManager } = _deps;
  const before = sessionManager.getGroupChatLastActivity(sid);
  if (echoSeen) {
    writeSubmitSignal(sessionManager, sid, kind, 1);
  } else {
    await clearCodexInputLine(sessionManager, sid, kind);
    const actualPrompt = await writePromptToSession(sessionManager, sid, prompt, kind);
    noteSubmittedPrompt(sid, kind, actualPrompt);
    await new Promise(r => setTimeout(r, (timing && timing.ENTER_RETRY_GAP_MS) || 150));
    writeSubmitSignal(sessionManager, sid, kind, 1);
  }
  await new Promise(r => setTimeout(r, (timing && timing.POST_ENTER_VERIFY_MS) || 500));
  const after = sessionManager.getGroupChatLastActivity(sid);
  // void kind: 保留参数名以便日志使用
  void kind;
  return after !== before;
}

// ---------------------------------------------------------------------------
// resendCurrentPrompt — 手动 [📤 发送] 按钮的后端入口（2026-05-03）
// 与 _autoRecoverSend 不同的是：手动按钮 caller 没有 dispatchPromptToSub 当时的
// echoSeen 上下文（dispatch 已经结束很久了），所以用 ring-buffer 末尾 grep prompt
// 第一行（promptHeader 指纹）来判定输入框是否还含 prompt。
// 返回 { ok, mode, reason? }，mode ∈ 'enter_only' | 'rewrite_full'。
async function resendCurrentPrompt({ sid, kind, prompt, promptHeader, timing }) {
  const { sessionManager } = _deps;
  kind = resolveRuntimeKind(sessionManager, sid, kind);
  if (!prompt) return { ok: false, reason: 'no_prompt' };
  const buf = sessionManager.getSessionBuffer(sid) || '';
  // 仅取最近 ~1024 字符（约一屏 PTY 输出，覆盖 CLI 输入框；
  //   太大会包含上一轮 Claude 回答里复述的 promptHeader → 误判 enter_only 发空 \r）
  const tail = buf.slice(-1024);
  const inInputBox = !!(promptHeader && promptHeader.length > 0 && tail.includes(promptHeader));

  const before = sessionManager.getGroupChatLastActivity(sid);
  let mode;
  const submitTries = isCodexCliKind(kind) ? 3 : 1;
  const rewriteSettleMs = isCodexCliKind(kind) ? 500 : ((timing && timing.ENTER_RETRY_GAP_MS) || 150);
  if (inInputBox) {
    mode = 'enter_only';
    await writeSubmitFallbackSignals(sessionManager, sid, kind, submitTries, (timing && timing.ENTER_RETRY_GAP_MS) || 150);
  } else {
    mode = 'rewrite_full';
    await clearCodexInputLine(sessionManager, sid, kind);
    if (isClaudeFamily(kind) || isCodexCliKind(kind)) {
      // 2026-09-03：这条以前走 writePromptToSession —— 对 Claude 就是"裸写整段 +
      //   150ms + \r"，正是本次要修掉的那套开环时序。补发是这个 bug 的**恢复路径**，
      //   它自己再踩一次同一个坑就毫无意义，所以改走与主路径同一套分块 + 自适应 settle。
      const baselineMarker = snapshotPasteMarker(sessionManager, sid);
      await writeBracketedPaste(sessionManager, sid, prompt);
      noteSubmittedPrompt(sid, kind, prompt);
      await waitForPasteSettled({
        sessionManager,
        sid,
        settleMs: computeSettleMs(String(prompt || '').length),
        baselineMarker,
      });
    } else {
      const actualPrompt = await writePromptToSession(sessionManager, sid, prompt, kind);
      noteSubmittedPrompt(sid, kind, actualPrompt);
      await new Promise(r => setTimeout(r, rewriteSettleMs));
    }
    await writeSubmitFallbackSignals(sessionManager, sid, kind, submitTries, (timing && timing.ENTER_RETRY_GAP_MS) || 150);
  }
  await new Promise(r => setTimeout(r, isCodexCliKind(kind) ? 1500 : ((timing && timing.POST_ENTER_VERIFY_MS) || 500)));
  const after = sessionManager.getGroupChatLastActivity(sid);
  const verified = after !== before;
  void kind;
  return { ok: verified, mode, ...(verified ? {} : { reason: 'verify_failed' }) };
}

// ---------------------------------------------------------------------------
// checkHostShellTakeover — host-shell prompt 心跳检测
//   FIX-D（2026-05-01）：CLI 自我退出（Codex 自动更新 / Gemini OAuth 异常 /
//     Claude 内部 panic 等）后 PTY 控制权回到宿主 shell（PowerShell / bash），但 PTY 进程
//     本身没退，markProcessExit 不会触发。watcher 因此只能等 5min 硬 timeout。
//   解决：每 10s 检查 PTY ring buffer 末尾是否回到宿主 shell prompt，连续 2 次命中视为
//     CLI 已死，立即 markProcessExit。核心检测函数已抽到 core/host-shell-detector.js
//     方便单测。
function checkHostShellTakeover(sid) {
  const { sessionManager } = _deps;
  return detectHostShellTakeover(sessionManager.getSessionBuffer(sid));
}

module.exports = {
  init,
  waitCliReady,
  sendToPty,
  extractStreamingText,
  cleanBufLen,
  checkHostShellTakeover,
  _private: { writePromptToSession, writeSubmitSignal, clearCodexInputLine },
  _autoRecoverSend,           // 新增（测试 + 同模块调用）
  resendCurrentPrompt,         // 新增（main.js IPC handler 调用）
};
