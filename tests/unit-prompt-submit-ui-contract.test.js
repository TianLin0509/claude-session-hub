'use strict';
// 长 prompt 提交可靠性契约（2026-09-03）
//
// 行为在 unit-pty-prompt-submit / unit-prompt-submit-ipc-contract 里真跑；
// 这里锁住**不能被悄悄改回去**的源码契约。每一条都对应一次真实的用户损失：
// 「按了回车，内容进了 CLI 输入框折叠成 [Pasted text +N lines]，就是不提交，
//   也没有任何提示，人在那干等几十秒」。
//
// 反面模式的共同特征是「盲发回车」：写完 payload 后按固定毫秒数发 \r，发完不验证。
// 只要 payload 还在 node-pty 的 socket 队列里没排空，那个 \r 就会被并进 BP_END
// 所在的 stdin chunk 当粘贴尾巴吃掉 —— 输入越长越必然。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

const rendererSrc = read('renderer', 'renderer.js');
const meetingSrc = read('renderer', 'meeting-room.js');
const mainSrc = read('main.js');
const watcherSrc = read('core', 'group-chat-watcher.js');
const submitSrc = read('core', 'pty-prompt-submit.js');
const handlerSrc = read('main', 'ipc', 'prompt-submit-handlers.js');
const cssSrc = read('renderer', 'styles', 'task-presets.css');

function sliceFn(src, startMarker, endMarker, label) {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `${label}: 定位不到 ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  assert.ok(end > start, `${label}: 定位不到 ${endMarker}`);
  const body = src.slice(start, end);
  assert.ok(body.length > 200, `${label}: 片段定位失败（太短）`);
  return body;
}

// --- 1. 浮动输入框：闭环，不许盲发回车 ---------------------------------------
const sendInputBody = sliceFn(rendererSrc,
  '  function sendInput() {', "  inputBox.addEventListener('keydown'", 'sendInput');

assert.ok(/ipcRenderer\.invoke\('session:send-prompt'/.test(sendInputBody),
  '浮动输入框必须走 session:send-prompt 闭环，不得裸写 terminal-input');
assert.ok(!/setTimeout\([^)]*'\\r'/.test(sendInputBody),
  "浮动输入框不得再按固定毫秒盲发 '\\r'（长 prompt 时三次全会被吞）");
assert.ok(!/data:\s*text\s*\+\s*'\\r'/.test(sendInputBody),
  '浮动输入框不得把正文和回车合并成一次 write');
assert.ok(/markFloatingInputStuck/.test(sendInputBody),
  'sendStatus=stuck 必须在 UI 上可见 —— 失败得无声无息正是这个 bug 最伤的部分');

// --- 2. 卡片「↺ 重发」：同一条闭环 --------------------------------------------
assert.ok(!/data:\s*promptText\s*\+\s*'\\r'/.test(rendererSrc),
  "卡片重发不得用 `promptText + '\\r'` 单次写完（连延迟都没有，稍长必被吞）");
assert.ok(/session:send-prompt'[^)]*sessionId:\s*sid,\s*text:\s*promptText/.test(rendererSrc.replace(/\s+/g, ' '))
  || /invoke\('session:send-prompt', \{ sessionId: sid, text: promptText \}\)/.test(rendererSrc),
  '卡片重发必须走 session:send-prompt');

// --- 3. 会议普通模式发送：同一条闭环 ------------------------------------------
assert.ok(/ipcRenderer\.invoke\('session:send-prompt'/.test(meetingSrc),
  '会议普通模式发送必须走 session:send-prompt 闭环');
assert.ok(!/baseDelay \+ sizeDelay/.test(meetingSrc),
  '会议发送不得再用 baseDelay+sizeDelay 盲发回车（sizeDelay 封顶 500ms，长 payload 等于没等）');

// --- 4. 主进程注册 ------------------------------------------------------------
assert.ok(/registerPromptSubmitIpc\(ipcMain/.test(mainSrc),
  'main.js 必须注册 prompt-submit IPC，否则渲染进程 invoke 会 no handler');
assert.ok(mainSrc.indexOf('registerPromptSubmitIpc(ipcMain') > mainSrc.indexOf('registerSessionIpc(ipcMain'),
  'prompt-submit 注册必须排在 registerSessionIpc 之后（依赖群聊 dispatcher 已 init 的 watcher _deps）');

// --- 5. settle 必须自适应，不许写死 -------------------------------------------
const fastPath = sliceFn(watcherSrc,
  'const beforeBufferLength', 'let enterAttempts = 1;', 'BP fast-path');
assert.ok(/computeSettleMs\(/.test(fastPath),
  'BP 快路径的 settle 必须随 payload 体积走');
assert.ok(/waitForPasteSettled\(/.test(fastPath),
  '必须等折叠标记这个正向信号，而不是纯计时');
assert.ok(/writeBracketedPaste\(/.test(fastPath),
  'payload 必须分块投喂，否则 socket 队列积压时 \\r 会与 BP_END 同块');
assert.ok(!/setTimeout\(r, [^)]*\?\s*pasteSettleMs\s*:\s*500\)/.test(fastPath),
  '不得回退到写死 500ms 的 settle');

// --- 6. 补发路径自己不许踩同一个坑 --------------------------------------------
const resendBody = sliceFn(watcherSrc,
  'async function resendCurrentPrompt', 'checkHostShellTakeover —', 'resendCurrentPrompt');
assert.ok(/writeBracketedPaste\(/.test(resendBody),
  '补发的 rewrite_full 必须走分块 + BP，不得退回 writePromptToSession 的裸写时序');

// --- 7. 分块不得劈开代理对 ----------------------------------------------------
assert.ok(/0xd800/.test(submitSrc) && /0xdbff/.test(submitSrc),
  '分块必须处理 UTF-16 代理对边界，否则 emoji 会被切成两段无效 UTF-8');

// --- 8. 并发写必须串行化 ------------------------------------------------------
assert.ok(/_queues/.test(handlerSrc) && /function enqueue/.test(handlerSrc),
  '同一会话的并发发送必须串行 —— 分块投喂下两条 payload 并发会交错成乱码');

// --- 9. 折叠标记正则必须认得现版 Claude 格式 ----------------------------------
const { PASTE_MARKER_REGEX } = require('../core/paste-trapped-detector.js');
for (const [sample, expected] of [
  ['[Pasted text #1 +120 lines]', '120'],      // 现版 Claude Code（带粘贴槽位号）
  ['[Pasted text +120 lines]', '120'],         // 旧版 Claude
  ['[[Pasted Content 4834 chars]]', '4834'],   // Codex
  ['[Pasted +30 lines]', '30'],                // Gemini
]) {
  const m = PASTE_MARKER_REGEX.exec(sample);
  assert.ok(m, `折叠标记正则漏掉真实格式：${sample}`);
  assert.strictEqual(m[1], expected,
    `捕获组必须落在体积数字上而不是粘贴槽位号（${sample}）—— tick() 靠它判断是不是同一条 marker`);
}
assert.ok(!PASTE_MARKER_REGEX.test('Context 100% left · gpt-5.5'),
  '折叠标记正则不得误命中普通状态栏');

// --- 10. stuck 提示条的样式必须在 -------------------------------------------
for (const cls of ['.fi-stuck', '.fi-stuck-label', '.fi-stuck-resend', '.fi-stuck-dismiss']) {
  assert.ok(cssSrc.includes(cls), `stuck 提示条缺样式：${cls}（没样式等于没提示）`);
}

console.log('Prompt submit reliability contract: ok');
