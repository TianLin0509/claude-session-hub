'use strict';
// core/roundtable-watcher.js
// 圆桌 PTY 通信工具集（2026-05-03 道雪 阶段丙）。
// 从 main.js 抽出 5 个 helper：waitCliReady / sendToPty / extractStreamingText /
//   cleanBufLen / checkHostShellTakeover。
//
// 不抽：_rtWaitTurnComplete + _activeWatchers Map + dispatchRoundtableTurn。
//   它们闭包依赖太深（meetingManager/scenes/orchestrator/rtTimeline/rtInjection/
//   sendToRenderer/_computeDispatchSpec...），一次性抽风险高，
//   留下次专项做（backlog）。
//
// 依赖注入（init）：sessionManager / cliReadyDetector
//   transcriptTap 不在 deps —— 因为本模块的 5 个 helper 都不用。

const { detectHostShellTakeover } = require('./host-shell-detector.js');
const { isClaudeFamily } = require('./ai-kinds.js');

// xterm bracketed paste mode markers（标准协议，claude code TUI 完整识别）。
//   marker 之间的内容被 CLI 视作"一次粘贴"整体处理，无需 paste-detect timing 探测，
//   BP_END 之后的 \r 直接作为提交信号被识别。
//   2026-05-05 实测：claude family（claude/deepseek/glm/gpt/kimi/qwen 都跑在 claude CLI 上）
//   全部识别；codex/gemini 协议层不识别 → 仍走旧主路径。
const BP_START = '\x1b[200~';
const BP_END = '\x1b[201~';

let _deps = null;

function init(deps) {
  _deps = deps;
}

// ---------------------------------------------------------------------------
// waitCliReady — 圆桌发送 prompt 前的等待轮询。判定逻辑独立到
//   core/roundtable-cli-ready-detector.js（marker + buffer 静默双门 + monotonic guard）。
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
// 设计：CLI 初始化是持久状态，只需做一次。session-manager 的 roundtableReady 缓存
//       让第 2-N 轮跳过冷启动等待，直接走快路径。
// **关键约束（历史 bug 重现于 2026-04-30）**：Claude/Gemini/Codex 三家都是 TUI alt-screen 程序，
//   把紧贴到达的字符当"粘贴"事件 → 粘贴里的 '\r' 被当文本换行符而不是 Enter 提交。
//   所以 prompt 和 '\r' **必须分两次 write**，中间留 TUI 消化窗口；不能合并 `prompt + '\r'`。
async function sendToPty(sid, prompt, kind) {
  const { sessionManager } = _deps;
  const FAST_PATH_QUIET_MS = 250;       // 连续 250ms 无 PTY 数据 → 视为 paste 接收完
  const FAST_PATH_MAX_WAIT_MS = 3000;   // 上限：极大 prompt 也不无限等
  const FAST_PATH_POLL_MS = 50;
  const ENTER_RETRY_TRIES = 3;          // 零 echo 兜底：分多次发 \r 提升提交成功率
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

  // 冷启动：仅首次或 ready 被重置后
  if (!sessionManager.getRoundtableReady(sid)) {
    const ready = await waitCliReady(sid, kind, 60000);
    // CLI 完全没启动 → prompt 都没写，可以正当放弃
    if (!ready) return false;
    sessionManager.setRoundtableReady(sid, true);
  }

  // ===========================================================================
  // 1A fast-path：claude family 走 xterm bracketed paste，跳过 PRE_PROMPT_QUIET
  // / paste-detect 静默等待（最多省 4-5s）。
  //   旧主路径用 timing 探测（PTY 静默 1.5s + paste-detect 静默 250ms）来近似
  //   "CLI paste 缓冲已收完"，但 Ink TUI 持续重渲染（spinner/cursor blink）让静默
  //   信号失真，timing 经常上限超时硬冲、\r 被吃掉、prompt 留输入框没提交。
  //   bracketed paste markers 是显式协议，CLI 一看到 BP_END 就明确"粘贴结束"，
  //   无需任何 timing 探测。claude family 实测稳定通过。
  //   codex / gemini 协议不识别（marker 被吃但 \r 不提交），保留旧主路径。
  if (isClaudeFamily(kind)) {
    const beforeWrite = sessionManager.getRoundtableLastActivity(sid);
    sessionManager.writeToSession(sid, BP_START + prompt + BP_END);
    // 500ms 给 Ink useEffect 消化 paste 块，BP_END 紧贴 \r 时 Ink 把 \r 当 paste
    //   尾巴在内部某些版本下被忽略；间隔 500ms 后 \r 是干净提交信号。
    await new Promise(r => setTimeout(r, 500));
    sessionManager.writeToSession(sid, '\r');

    // 2026-05-05 fix（虚警 bug）：单点 500ms 后查一次 lastActivity 变化，对 claude
    //   慢启动场景误判 stuck（实测：\r 后 claude TUI 渲染 user message + 启 streaming
    //   延迟在 200-1500ms 间，500ms 单点窗口边缘 case 失败率高 → 卡片显示"输入卡顿"
    //   但实际 25s 内已输出 750 字）。改成轮询窗口：activity 一变就早 break，
    //   仅真 stuck 时跑满 1500ms 才标。正常情况 dispatch 净延迟仍 < 1s。
    const VERIFY_MAX_MS = 1500;
    const VERIFY_POLL_MS = 50;
    const verifyT0 = Date.now();
    let activityChanged = false;
    while (Date.now() - verifyT0 < VERIFY_MAX_MS) {
      await new Promise(r => setTimeout(r, VERIFY_POLL_MS));
      if (sessionManager.getRoundtableLastActivity(sid) !== beforeWrite) {
        activityChanged = true;
        break;
      }
    }
    let sendStatus = 'ok';
    if (!activityChanged) {
      // 极少：1500ms 内仍零 echo。不走 _autoRecoverSend（它基于 prompt+\r 模式与
      //   1A 协议不兼容），直接标 stuck 让 paste-trapped-detector + UI [📤 发送] 接管。
      console.warn(`[roundtable] 1A bracketed-paste verify failed for ${kind}(${sid.slice(0,8)}) after ${VERIFY_MAX_MS}ms; marking stuck`);
      sendStatus = 'stuck';
    }
    return { ok: true, sendStatus };
  }
  // ===========================================================================

  // bug A 修复：发 prompt 前等 PTY 静默（不依赖 cold-start 路径）。
  //   语义层信号（stop_hook/stop_reason）触发 ≠ 设备层 PTY 静止；前者是
  //   "Claude 答完最后一个字"，后者是"终端扩音器关掉"。
  {
    const startQuiet = Date.now();
    let lastSeenPre = sessionManager.getRoundtableLastActivity(sid);
    let lastChangePre = Date.now();
    while (Date.now() - startQuiet < PRE_PROMPT_MAX_WAIT_MS) {
      await new Promise(r => setTimeout(r, FAST_PATH_POLL_MS));
      const cur = sessionManager.getRoundtableLastActivity(sid);
      if (cur !== lastSeenPre) {
        lastSeenPre = cur;
        lastChangePre = Date.now();
      }
      if (Date.now() - lastChangePre >= PRE_PROMPT_QUIET_MS) break;
    }
    const totalWait = Date.now() - startQuiet;
    if (totalWait >= PRE_PROMPT_MAX_WAIT_MS) {
      console.warn(`[roundtable] pre-prompt PTY never quiet for ${kind}(${sid.slice(0,8)}); proceeded after ${totalWait}ms ceiling`);
    }
  }

  // 第 1 次 write：仅 prompt（不带 '\r'）
  const beforeWrite = sessionManager.getRoundtableLastActivity(sid);
  sessionManager.writeToSession(sid, prompt);

  // 自适应安静期等待：每 50ms 检查 lastActivity，
  //   连续 250ms 无变化 → CLI paste-detect timer 已 fire，安全发 Enter
  //   一直在抖动 → 等到 MAX，仍发 \r（best effort，与老 300ms 行为同等保守）
  const startWait = Date.now();
  let lastSeen = beforeWrite;
  let lastChange = Date.now();
  while (Date.now() - startWait < FAST_PATH_MAX_WAIT_MS) {
    await new Promise(r => setTimeout(r, FAST_PATH_POLL_MS));
    const cur = sessionManager.getRoundtableLastActivity(sid);
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
  if (echoSeen) {
    sessionManager.writeToSession(sid, '\r');
  } else {
    console.warn(`[roundtable] zero-echo for ${kind}(${sid.slice(0, 8)}) — sending ${ENTER_RETRY_TRIES}x \\r as belt-and-suspenders submit (prompt already in PTY stdin, MUST commit)`);
    for (let i = 0; i < ENTER_RETRY_TRIES; i++) {
      sessionManager.writeToSession(sid, '\r');
      if (i < ENTER_RETRY_TRIES - 1) {
        await new Promise(r => setTimeout(r, ENTER_RETRY_GAP_MS));
      }
    }
    // ready 重置：下轮走冷启动重新 align（本轮 prompt 已经尽力提交了）
    sessionManager.setRoundtableReady(sid, false);
  }

  // 提交后活性二次确认：再等 500ms 看 PTY 有无新输出。
  //   有 → 正常被 CLI 接住；无 → 标记 suspect（仅日志，不阻塞 turn-completion-watcher）。
  //   不在这里 return false：prompt 已发，应让 watcher 走完整流程（含 host-shell 心跳兜底）。
  await new Promise(r => setTimeout(r, POST_ENTER_VERIFY_MS));
  const afterEnter = sessionManager.getRoundtableLastActivity(sid);
  let sendStatus = 'ok';
  if (afterEnter === lastSeen) {
    console.warn(`[roundtable] post-Enter still zero-echo for ${kind}(${sid.slice(0, 8)}) — trying _autoRecoverSend`);
    const recovered = await _autoRecoverSend({
      sid, kind, prompt, echoSeen,
      timing: { ENTER_RETRY_GAP_MS, POST_ENTER_VERIFY_MS },
    });
    if (recovered) {
      console.log(`[roundtable] _autoRecoverSend recovered ${kind}(${sid.slice(0, 8)}) mode=${echoSeen ? 'enter_only' : 'rewrite_full'}`);
      sendStatus = 'auto_recovered';
    } else {
      console.warn(`[roundtable] _autoRecoverSend failed for ${kind}(${sid.slice(0, 8)}); upgrading to send_stuck`);
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
  const before = sessionManager.getRoundtableLastActivity(sid);
  if (echoSeen) {
    sessionManager.writeToSession(sid, '\r');
  } else {
    sessionManager.writeToSession(sid, prompt);
    await new Promise(r => setTimeout(r, (timing && timing.ENTER_RETRY_GAP_MS) || 150));
    sessionManager.writeToSession(sid, '\r');
  }
  await new Promise(r => setTimeout(r, (timing && timing.POST_ENTER_VERIFY_MS) || 500));
  const after = sessionManager.getRoundtableLastActivity(sid);
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
  if (!prompt) return { ok: false, reason: 'no_prompt' };
  const buf = sessionManager.getSessionBuffer(sid) || '';
  // 仅取最近 ~1024 字符（约一屏 PTY 输出，覆盖 CLI 输入框；
  //   太大会包含上一轮 Claude 回答里复述的 promptHeader → 误判 enter_only 发空 \r）
  const tail = buf.slice(-1024);
  const inInputBox = !!(promptHeader && promptHeader.length > 0 && tail.includes(promptHeader));

  const before = sessionManager.getRoundtableLastActivity(sid);
  let mode;
  if (inInputBox) {
    mode = 'enter_only';
    sessionManager.writeToSession(sid, '\r');
  } else {
    mode = 'rewrite_full';
    sessionManager.writeToSession(sid, prompt);
    await new Promise(r => setTimeout(r, (timing && timing.ENTER_RETRY_GAP_MS) || 150));
    sessionManager.writeToSession(sid, '\r');
  }
  await new Promise(r => setTimeout(r, (timing && timing.POST_ENTER_VERIFY_MS) || 500));
  const after = sessionManager.getRoundtableLastActivity(sid);
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
  _autoRecoverSend,           // 新增（测试 + 同模块调用）
  resendCurrentPrompt,         // 新增（main.js IPC handler 调用）
};
