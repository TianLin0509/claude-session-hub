'use strict';
// CodeAgent 屏幕右侧 Stats 面板的上下文占用（2026-10-16 公司真机画面，Q-1016-01 第 2 轮）。
// 公司 GLM 写进记录的 token 用量全是 0，上下文圆环改读屏幕上的「Context 32.7k (16%)」。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseCodeAgentContext } = require('../core/codeagent-screen-stats');

// 真机画面：左边是回答正文，右边是 Stats 面板，同处一行。
const SCREEN = [
  ' Study Shell Scripting   C:/Users/x/Workspaces            8 mcp · 24 hooks   ? help   Overview  Messages  ⚙',
  ' ↑ 你帮我跑                                                   ▾ Stats',
  '                                                               Context 32.7k (16%)',
  ' - Python 中用 os.environ.getenv                               ────────────────',
  '                                                               Credit 1,954.7 (78.2%)',
  ' 7. 注意事项                                                   Runtime 00:00:00',
  ' ╭──────────────────────────────────────────────╮  SESSION 74f77421-42b1-486c-b',
  ' │ > Anything I can assist you with? (Ctrl+J 换行 · esc×2 清空 · ↑↓ 历史) │  ff2-e676a8115a76',
  ' Bypass (Cycle shift+tab) | GLM-5.2-WX-Auto                     VERSION 1.2615.02.01',
  ' Alt+P switch model | Ctrl+G editor',
];

test('读出真机面板：32.7k 已用、16%，上限约 20 万', () => {
  assert.deepEqual(parseCodeAgentContext(SCREEN), { contextUsed: 32700, contextPct: 16, contextEffectiveMax: 204375 });
});

test('额度那一行（Credit 1,954.7 (78.2%)）不会被当成上下文；没有面板时返回 null', () => {
  assert.equal(parseCodeAgentContext(SCREEN.filter(l => !/Context/.test(l))), null);
  assert.equal(parseCodeAgentContext([]), null);
  assert.equal(parseCodeAgentContext(['Context 0 (0%)']), null);
});

test('多处出现时取最靠下的一处；支持 m、千分位和小数百分比', () => {
  assert.equal(parseCodeAgentContext(['Context 10k (5%)', 'Context 120.5k (60.2%)']).contextUsed, 120500);
  assert.equal(parseCodeAgentContext(['Context 1.2m (60%)']).contextUsed, 1200000);
  assert.equal(parseCodeAgentContext(['Context 12,345 (6.2%)']).contextPct, 6.2);
});

test('界面在每轮结束时对 CodeAgent 会话读一次面板', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.match(src, /if \(\/\^codeagent\/\.test\(String\(session\.kind \|\| ''\)\)\) applyCodeAgentScreenContext\(session, sessionId\);/);
  assert.match(src, /const stats = require\('\.\.\/core\/codeagent-screen-stats'\);\s*context = stats\.parseCodeAgentContext\(lines\)/);
});
