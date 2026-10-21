'use strict';
// core/writing/antigravity-writing-home.js
//
// 写作成员专用的 Antigravity 用户目录（2026-10-22 田哥要求：写作 Tab 里也能加 Antigravity）。
//
// agy 会无条件加载 %USERPROFILE%\.gemini\GEMINI.md（田哥的个人协作约定：结论先行、交付模板、
// 白话解读……）以及 .gemini\config、.gemini\antigravity-cli 下的技能与配置，命令行没有关掉它们的开关。
// 写作成员要的上下文只有文章目录里的 AGENTS.md（写作须知，core/writing/voice-pack.js），
// 所以把 agy 的 USERPROFILE 换到一个只为写作准备的目录：
//   - 目录里只建 .gemini\antigravity-cli 与 .gemini\config，不放 GEMINI.md / AGENTS.md / 技能 / hooks 正文
//   - hook、信任目录、会话记录仍由 Hub 照常写进这个目录（core/antigravity-config.js 按 sessionEnv 解析）
//   - 登录凭据在 Windows 凭据管理器（keyring）里，与用户目录无关；2026-10-22 实测把 USERPROFILE 指到
//     空目录后 keyringAuth 仍能读到 token，所以换目录不影响登录
//
// 与 Codex 写作目录一样是全局一份（core/writing/codex-writing-home.js）：Antigravity 一次只有一个 Google
// 账号，不必按账号分开；文章之间的隔离靠各自的文章目录和会话记录。

const fs = require('node:fs');
const path = require('node:path');

const DIR_NAME = 'writing-antigravity-home';
// agy 的「新手引导已完成」状态。空目录里没有它，成员一启动就会停在欢迎/使用方式/添加工作区那几屏，
// 而群聊成员是无人值守的。只搬这一步的状态，不搬 settings、技能、MCP 与 GEMINI.md。
const ONBOARDING_STATE = 'jetski_state.pbtxt';

function writingHomePath(hubDataDir) {
  return path.join(hubDataDir || require('../data-dir').getHubDataDir(), DIR_NAME);
}

/** 建好目录骨架（幂等）。只建空目录 + 新手引导状态，绝不往这里放全局指令。返回用作 USERPROFILE 的路径。 */
function prepareWritingHome(hubDataDir, env = process.env) {
  const home = writingHomePath(hubDataDir);
  const configDir = path.join(home, '.gemini', 'antigravity-cli');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
  // 与 agy 找配置目录的规则一致：隔离 Hub 用 CLAUDE_HUB_HOME_DIR，否则用 USERPROFILE（core/antigravity-config.js）。
  const sourceHome = require('../antigravity-config').home(env);
  const source = path.join(sourceHome, '.gemini', 'antigravity-cli', ONBOARDING_STATE);
  const target = path.join(configDir, ONBOARDING_STATE);
  if (!fs.existsSync(target) && fs.existsSync(source)) {
    try { fs.copyFileSync(source, target); } catch (error) { console.warn('[writing] Antigravity 引导状态没搬过来：', error.message); }
  }
  return home;
}

module.exports = { DIR_NAME, ONBOARDING_STATE, writingHomePath, prepareWritingHome };
