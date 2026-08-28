'use strict';

// session-manager 里 spawn Claude 的那两处信任处理，都是「改错了就静默把用户会话
// 关掉」的代码，所以在源码层面把契约钉住。行为层面的证据在
// unit-claude-trust-dialog / unit-claude-project-trust，以及 2026-08-28 对真
// Claude Code v2.1.251 的端到端实测（预写 → 框不出现；兜底 → 选中 Yes 并进提示符）。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');

// --- 预写：所有 Claude 会话都要走，不只是 deepseek-legacy ---
assert.match(src, /require\('\.\/claude-project-trust\.js'\)/);
assert.match(
  src,
  /else if \(isClaude\) \{[\s\S]{0,600}?ensureClaudeProjectTrusted\(spawnCwd, \{ configDir: sessionEnv\.CLAUDE_CONFIG_DIR \|\| null \}\)/,
  '主桌 Claude（共享 ~/.claude.json，没有 CLAUDE_CONFIG_DIR）也必须预写信任',
);

// --- PTY 兜底 ---
const fallback = src.slice(src.indexOf('const TRUST_SETTLE_MS'));
const block = fallback.slice(0, fallback.indexOf('\n    let currentModel'));
assert.ok(block.length > 100 && block.length < 3000, '没定位到信任框兜底代码块');

assert.match(block, /detectClaudeTrustDialog/);
// 绝不能再出现「检测到就直接回车」：v2.1.251 默认高亮项是 "No, exit"。
assert.doesNotMatch(
  block, /ptyProcess\.write\('\\r'\)/,
  '不得盲发回车 —— 新版信任框默认选中的是 No, exit',
);
assert.match(block, /ptyProcess\.write\(key\)/, '只能发 detectClaudeTrustDialog 算出来的按键序列');
// 首帧发按键会被 ink 丢掉，必须先攒一拍。
assert.match(block, /TRUST_SETTLE_MS/);
// 攒完这一拍必须重新确认框还在（用户可能已经自己答了）。
const settleBody = block.slice(block.indexOf('_trustTimer = setTimeout'));
assert.match(settleBody, /const dialog = detectClaudeTrustDialog\(_trustBuf\);\s*\r?\n\s*if \(!dialog\) return;/);
// 缓冲不能再是 4000：整帧带 SGR 的信任框会被截断。
assert.match(block, /slice\(-16000\)/);
assert.doesNotMatch(block, /slice\(-4000\)/);
// 45s 超时要连排好队的定时器一起清掉，别在会话结束后还往 PTY 里写按键。
assert.match(block, /if \(_trustTimer\) \{ clearTimeout\(_trustTimer\); _trustTimer = null; \}/);

const settleMs = Number(/const TRUST_SETTLE_MS = (\d+)/.exec(block)[1]);
assert.ok(settleMs >= 800 && settleMs <= 3000, `settle 时间 ${settleMs}ms 超出实测可用区间`);

console.log('unit-session-manager-claude-trust: OK');
