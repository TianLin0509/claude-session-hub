'use strict';

/**
 * Codex 的速度通道与 model_reasoning_effort 是两套独立设置。
 * Codex CLI 0.147 的官方配置把 Fast 同时表示为 features.fast_mode=true 与
 * service_tier="fast"；因此 Hub 要同时覆盖 feature 与 service tier，才能在用户
 * 全局配置为 Fast 时可靠地回到 Standard，而不必改写 ~/.codex/config.toml。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// standard / inherit 是 Hub 侧语义；fast / flex 会落到 Codex service_tier。
const CODEX_SPEED_TIERS = new Set(['standard', 'inherit', 'fast', 'flex']);
const DEFAULT_CODEX_SPEED_TIER = 'fast';

function normalizeCodexSpeedTier(value) {
  const normalized = String(value || DEFAULT_CODEX_SPEED_TIER).trim().toLowerCase();
  return CODEX_SPEED_TIERS.has(normalized) ? normalized : DEFAULT_CODEX_SPEED_TIER;
}

/**
 * 拼给 codex 的单次启动覆盖。inherit 返回空串（完全不干预）。
 *
 * 用 TOML 双引号字符串：整条命令行是写进 PowerShell PTY 的，外层已经是单引号包裹
 * 的模式（见 session-manager 的其它 -c），这里保持同一套引号风格。
 */
function buildCodexSpeedTierArg(value) {
  const tier = normalizeCodexSpeedTier(value);
  if (tier === 'inherit') return '';
  if (tier === 'standard') return ` -c 'features.fast_mode=false' -c 'service_tier="default"'`;
  if (tier === 'fast') return ` -c 'features.fast_mode=true' -c 'service_tier="fast"'`;
  return ` -c 'features.fast_mode=false' -c 'service_tier="flex"'`;
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
