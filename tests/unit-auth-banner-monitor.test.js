'use strict';
// 2026-07-12 道雪：登录失效横幅检测收紧回归测试。
//   血泪场景：Codex 回答 GitHub push/release 问题时，gh CLI 输出 "You are not logged
//   into any GitHub hosts"，旧实现对整个 ring buffer 裸测 → 10s 心跳直接
//   markErrored('auth_required') → PTY 正常回答但群聊 UI 显示「发送失败」+ 空气泡。
//   新契约（createAuthBannerMonitor）：
//     1. 只看 stripAnsi 后 buffer 尾部
//     2. 连续 2 次命中
//     3. 两次命中之间 PTY 零新输出（activityStamp 不变）
//   三门全过才 'confirmed'。

const assert = require('assert');
const { createAuthBannerMonitor, AUTH_FAILURE_RE } = require('../core/host-shell-detector.js');

console.log('Running auth banner monitor tests...');

// --- 1. 真登录失效：横幅停在尾部 + PTY 静止 → 第 2 次心跳 confirmed ---
{
  const m = createAuthBannerMonitor();
  const banner = 'Welcome to Claude Code\nPlease run /login to authenticate\n';
  assert.strictEqual(m.tick(banner, 1000), 'suspect', '第 1 次命中只标 suspect');
  assert.strictEqual(m.tick(banner, 1000), 'confirmed', '横幅未变 + PTY 静止 → 第 2 次 confirmed');
}

// --- 2. 误杀防护：AI 回答里提到 auth 字样但 PTY 持续输出 → 永不 confirmed ---
{
  const m = createAuthBannerMonitor();
  const answering = '检查结果：gh 显示 You are not logged into any GitHub hosts，需要先配置 token。\n';
  assert.strictEqual(m.tick(answering, 1000), 'suspect');
  // PTY 活跃（activityStamp 每次心跳都变）→ 不确认
  assert.strictEqual(m.tick(answering + '继续执行推送脚本…\n', 2000), 'suspect', 'PTY 活跃时不 confirmed');
  assert.strictEqual(m.tick(answering + '推送完成。\n', 3000), 'suspect', 'PTY 持续活跃始终不 confirmed');
}

// --- 3. 误杀防护：auth 字样只在 buffer 头部历史（尾部已滚走）→ none ---
{
  const m = createAuthBannerMonitor();
  const history = 'gh: not logged in\n' + 'x'.repeat(3000) + '\n正常回答的最后一段。\n';
  assert.strictEqual(m.tick(history, 1000), 'none', '尾部窗口外的历史字样不触发');
}

// --- 4. 命中断续（中间一次未命中）→ 计数复位 ---
{
  const m = createAuthBannerMonitor();
  assert.strictEqual(m.tick('please run /login\n', 1000), 'suspect');
  assert.strictEqual(m.tick('正常输出滚动把横幅顶走了……\n' + 'y'.repeat(1500), 2000), 'none');
  assert.strictEqual(m.tick('please run /login\n', 2000), 'suspect', '复位后重新从 suspect 开始');
}

// --- 5. ANSI 包裹的真横幅照样识别（stripAnsi 后匹配）---
{
  const m = createAuthBannerMonitor();
  const ansiBanner = '\x1b[31mAuthentication required\x1b[0m — run \x1b[1m/login\x1b[0m\n';
  assert.strictEqual(m.tick(ansiBanner, 500), 'suspect');
  assert.strictEqual(m.tick(ansiBanner, 500), 'confirmed');
}

// --- 6. 正则本体仍导出（其它调用方/测试可复用）---
assert.ok(AUTH_FAILURE_RE.test('not logged in'), 'AUTH_FAILURE_RE 导出且语义不变');
assert.ok(!AUTH_FAILURE_RE.test('登录成功'), '无关文本不命中');

// --- 7. activityStamp 缺失（null/undefined）不得当作"静默"确认 ---
{
  const m = createAuthBannerMonitor();
  assert.strictEqual(m.tick('please run /login\n', undefined), 'suspect');
  assert.strictEqual(m.tick('please run /login\n', undefined), 'suspect', 'activity 缺失时宁可漏报不误杀');
  assert.strictEqual(m.tick('please run /login\n', null), 'suspect');
}

// --- 8. dispatcher 侧契约：auth 检测只在轮次早期窗口内做（真横幅在 prompt 提交后立刻出现；
//        晚出现的 auth 字样必是回答内容，检测窗口外不再误杀）---
{
  const fs = require('fs');
  const path = require('path');
  const dispatcherSrc = fs.readFileSync(path.join(__dirname, '..', 'main', 'groupchat', 'dispatcher.js'), 'utf8');
  assert.ok(/const AUTH_DETECT_WINDOW_MS = 120 \* 1000;/.test(dispatcherSrc), 'auth 检测窗口常量存在');
  assert.ok(/Date\.now\(\) - startTs < AUTH_DETECT_WINDOW_MS\s*\n\s*&& authBannerMonitor\.tick\(/.test(dispatcherSrc),
    'auth tick 必须被轮次早期窗口守卫包裹');
}

console.log('Auth banner monitor: ok');
