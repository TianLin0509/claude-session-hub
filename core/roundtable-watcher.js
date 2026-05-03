'use strict';
// core/roundtable-watcher.js
// 圆桌 PTY 通信工具集（2026-05-03 道雪 阶段丙）。
// 从 main.js 抽出 5 个 helper：waitCliReady / sendToPty / extractStreamingText /
//   cleanBufLen / checkHostShellTakeover。
//
// 不抽：_rtWaitTurnComplete + _activeWatchers Map + dispatchRoundtableTurn。
//   它们闭包依赖太深（meetingManager/scenes/orchestrator/rtTimeline/rtInjection/
//   rtArchive/sendToRenderer/_computeDispatchSpec...），一次性抽风险高，
//   留下次专项做（backlog）。
//
// 依赖注入（init）：sessionManager / cliReadyDetector
//   transcriptTap 不在 deps —— 因为本模块的 5 个 helper 都不用。

const { detectHostShellTakeover } = require('./host-shell-detector.js');

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
  if (afterEnter === lastSeen) {
    console.warn(`[roundtable] post-Enter still zero-echo for ${kind}(${sid.slice(0, 8)}) — watcher will detect via host-shell heartbeat or 5min hard timeout`);
  }
  return true;
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
};
