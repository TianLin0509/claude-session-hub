'use strict';
// FIX-D（2026-05-01）：检测 PTY ring buffer 末尾是否回到宿主 shell prompt（PowerShell / bash / cmd）。
//   命中 → 视为 CLI 自我退出（Codex 自动更新 / Gemini OAuth refresh / Claude panic 等）。
//   配合 main.js _rtWaitTurnComplete 里的 10s 心跳 + 连续 2 次命中机制使用，让 watcher 在
//   ~10-20s 内 settle errored，而不是等 5min 硬 timeout。
//
// 误判防护：
//   1. 严格只看 buffer tail（最后 500 字符）— 避免命中历史 prompt
//   2. 调用方需要"连续 N 次命中"才确认（main.js 里 N=2）
//   3. 去 ANSI / 控制字符后再匹配 — CLI alt-screen 渲染不会在 tail 留下干净的 PS prompt 字串

// 匹配模式：
//   - PowerShell: `PS C:\Users\xxx>`、`PS C:\Users\xxx\>`
//   - cmd:       `C:\Users\xxx>`
//   - bash:      `user@host:~$`、`$`
//   都要求出现在行首、tail 末尾结束（^/(?:\n|^) 锚 + $\s*$ 锚）
const HOST_SHELL_PROMPT_RE = /(?:^|\n)\s*(?:PS [A-Za-z]:\\[^\n]*?>\s*$|[\w-]+@[^\s]+:[^\s]*?\$\s*$|\$\s*$|[A-Za-z]:\\[^\n]*?>\s*$)/;

function stripAnsi(buf) {
  return String(buf || '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r/g, '');
}

function detectHostShellTakeover(rawBuffer) {
  if (!rawBuffer) return false;
  const clean = stripAnsi(rawBuffer);
  const tail = clean.slice(-500);
  return HOST_SHELL_PROMPT_RE.test(tail);
}

module.exports = {
  HOST_SHELL_PROMPT_RE,
  stripAnsi,
  detectHostShellTakeover,
};
