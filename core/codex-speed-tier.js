'use strict';

/**
 * Codex 的「fast」到底是什么 —— 以及为什么它不是 Claude 那套 fastMode。
 *
 * Codex CLI 有两个独立的速度旋钮，之前 Hub 一个都没暴露：
 *
 *   1. `service_tier`  —— 真正对标 Claude fast 的那个。模型目录里写着
 *      `service_tiers: [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }]`
 *      `additional_speed_tiers: ["fast"]`。用户 ~/.codex/config.toml 里已经全局
 *      写了 `service_tier = "fast"`。Codex TUI 的状态行就叫 "Fast on" / "Fast off"。
 *   2. `model_reasoning_effort` —— 思考深度，见 core/codex-model-catalog.js。
 *
 * ## 为什么没有「关闭 fast」这一档
 *
 * 2026-08-16 实测（codex-cli 0.144.0，`codex doctor --summary -c <k>=<v>` 的退出码）：
 *   approval_policy="banana"        → exit 1（严格枚举，被拒）
 *   sandbox_mode="banana"           → exit 1（严格枚举，被拒）
 *   service_tier="banana"           → exit 0（**配置层不校验**）
 *   model_reasoning_effort="banana" → exit 0（同上）
 * 二进制里对 service_tier 的字符串匹配只有 `fast` / `flex` / `priority` 三支，
 * 模型目录的 `default_service_tier` 是 null —— 也就是说"不 fast"在 Codex 里的表示
 * 是**这个键不存在**，而不是某个字面量。
 *
 * `-c` 只能覆盖、不能删除（TOML 没有 null）。用户全局已经写死 fast 的情况下，
 * 没有任何**可证实**的字面量能在单次启动里把它关掉。所以这里只提供三档：
 * 跟随全局 / fast / flex —— 三个值都是实测可用的，不猜。
 * 想全局关掉 fast，改 ~/.codex/config.toml 一次即可，那才是 Codex 给的机制。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// 'inherit' 不是 Codex 的值，是 Hub 侧的"不要覆盖"语义。
const CODEX_SPEED_TIERS = new Set(['inherit', 'fast', 'flex']);
const DEFAULT_CODEX_SPEED_TIER = 'inherit';

function normalizeCodexSpeedTier(value) {
  const normalized = String(value || DEFAULT_CODEX_SPEED_TIER).trim().toLowerCase();
  return CODEX_SPEED_TIERS.has(normalized) ? normalized : DEFAULT_CODEX_SPEED_TIER;
}

/**
 * 拼给 codex 的 `-c service_tier=...`。inherit 返回空串（完全不干预）。
 *
 * 用 TOML 双引号字符串：整条命令行是写进 PowerShell PTY 的，外层已经是单引号包裹
 * 的模式（见 session-manager 的其它 -c），这里保持同一套引号风格。
 */
function buildCodexSpeedTierArg(value) {
  const tier = normalizeCodexSpeedTier(value);
  if (tier === 'inherit') return '';
  return ` -c 'service_tier="${tier}"'`;
}

function codexHomeOrDefault(configDir) {
  return configDir || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/**
 * 读用户 config.toml 顶层的 service_tier，只为了在 UI 上显示"跟随全局（当前：fast）"。
 * 读不到就返回 null —— 显示退化成"跟随全局"，不影响任何功能。
 *
 * 故意只扫到第一个 `[section]` 为止：顶层键必须出现在任何 table 之前，
 * 否则 `[profiles.x] service_tier=...` 会被误当成全局值。
 */
function readCodexConfiguredServiceTier(configDir, fsModule = fs) {
  try {
    const text = fsModule.readFileSync(path.join(codexHomeOrDefault(configDir), 'config.toml'), 'utf8');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('[')) break;
      const match = line.match(/^service_tier\s*=\s*["']([^"']*)["']/);
      if (match) return match[1] || null;
    }
    return null;
  } catch {
    return null;
  }
}

module.exports = {
  CODEX_SPEED_TIERS,
  DEFAULT_CODEX_SPEED_TIER,
  buildCodexSpeedTierArg,
  normalizeCodexSpeedTier,
  readCodexConfiguredServiceTier,
};
