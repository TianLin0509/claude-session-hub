'use strict';

/**
 * Codex 的思考强度档位是**按模型**不同的，不能写死一份。
 *
 * codex-cli 会把服务端下发的模型目录缓存在 `~/.codex/models_cache.json`，
 * 每个模型带 `supported_reasoning_levels` / `default_reasoning_level` /
 * `additional_speed_tiers` / `service_tiers`。2026-08-16 实测这台机器上的内容：
 *
 *   gpt-5.6-sol         default=low     levels=[low medium high xhigh max ultra]  speed=[fast]
 *   gpt-5.6-terra       default=medium  levels=[low medium high xhigh max ultra]  speed=[fast]
 *   gpt-5.6-luna        default=medium  levels=[low medium high xhigh max]        speed=[fast]
 *   gpt-5.5 / gpt-5.4   default=medium  levels=[low medium high xhigh]            speed=[fast]
 *   gpt-5.4-mini        default=medium  levels=[low medium high xhigh]            speed=[]
 *   gpt-5.3-codex-spark default=high    levels=[low medium high xhigh]            speed=[]
 *
 * 两个之前搞错的点：
 *   - `xhigh` 不是 Claude 专属，Codex 每个模型都支持；
 *   - `ultra` 存在（"Maximum reasoning with automatic task delegation"），比 max 还高，
 *     只有 5.6 sol/terra 有。
 * 所以档位列表必须跟着模型走，写死一份必然给某些模型多出或少掉档位。
 *
 * 缓存读不到时回落到一份保守静态表（low/medium/high/xhigh/max），不至于让 UI 空掉。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// 缓存缺失时的兜底：这五档在实测的每个模型上都合法（ultra 例外，故意不放）。
const FALLBACK_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const FALLBACK_DEFAULT_EFFORT = 'max';

// Hub 一直显式覆盖成 max（用户偏好），与模型目录的 default_reasoning_level 无关。
const HUB_DEFAULT_REASONING_EFFORT = 'max';

const EFFORT_DESCRIPTIONS = {
  low: '最快，推理最浅',
  medium: '速度与深度平衡',
  high: '更深的推理',
  xhigh: '超高推理深度',
  max: '最大推理深度',
  ultra: '最大推理 + 自动任务分派',
};

function codexHomeOrDefault(configDir) {
  return configDir || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function readModelsCache(configDir, fsModule = fs) {
  try {
    const raw = fsModule.readFileSync(path.join(codexHomeOrDefault(configDir), 'models_cache.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed && parsed.models) ? parsed.models : [];
  } catch {
    return [];
  }
}

function findModel(models, slug) {
  const wanted = String(slug || '').trim().toLowerCase();
  if (!wanted) return null;
  return models.find(m => String(m && m.slug || '').toLowerCase() === wanted) || null;
}

/**
 * @returns {{ efforts: string[], defaultEffort: string, supportsFast: boolean, fromCache: boolean }}
 */
function describeCodexModelTuning(slug, { configDir, fsModule = fs, models = null } = {}) {
  const catalog = Array.isArray(models) ? models : readModelsCache(configDir, fsModule);
  const model = findModel(catalog, slug);
  if (!model) {
    return {
      efforts: [...FALLBACK_REASONING_EFFORTS],
      defaultEffort: FALLBACK_DEFAULT_EFFORT,
      // 缓存缺失时不敢断言这个模型没有 fast 通道；按"有"处理，
      // 让开关照常出现（传下去最多是个无效覆盖，比藏起功能好）。
      supportsFast: true,
      fromCache: false,
    };
  }
  const efforts = (Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [])
    .map(item => String(item && item.effort || '').trim().toLowerCase())
    .filter(Boolean);
  const speedTiers = (Array.isArray(model.additional_speed_tiers) ? model.additional_speed_tiers : [])
    .map(item => String(item || '').trim().toLowerCase());
  return {
    efforts: efforts.length ? efforts : [...FALLBACK_REASONING_EFFORTS],
    defaultEffort: String(model.default_reasoning_level || FALLBACK_DEFAULT_EFFORT).toLowerCase(),
    supportsFast: speedTiers.includes('fast'),
    fromCache: true,
  };
}

/** 某个模型是否认识这个档位。用来在切模型时把非法档位回落掉。 */
function isEffortSupported(slug, effort, options = {}) {
  const normalized = String(effort || '').trim().toLowerCase();
  if (!normalized) return false;
  return describeCodexModelTuning(slug, options).efforts.includes(normalized);
}

/**
 * 给新建会话弹窗用的一次性快照：所有 Codex 模型各自的档位 + fast 支持情况，
 * 外加用户全局配的 service_tier（只为显示"跟随全局（当前：fast）"）。
 */
function buildCodexTuningSnapshot(slugs, { configDir, fsModule = fs } = {}) {
  const models = readModelsCache(configDir, fsModule);
  const byModel = {};
  for (const slug of Array.isArray(slugs) ? slugs : []) {
    byModel[slug] = describeCodexModelTuning(slug, { configDir, fsModule, models });
  }
  return { byModel, effortDescriptions: { ...EFFORT_DESCRIPTIONS }, catalogLoaded: models.length > 0 };
}

module.exports = {
  EFFORT_DESCRIPTIONS,
  FALLBACK_DEFAULT_EFFORT,
  FALLBACK_REASONING_EFFORTS,
  HUB_DEFAULT_REASONING_EFFORT,
  buildCodexTuningSnapshot,
  describeCodexModelTuning,
  isEffortSupported,
  readModelsCache,
};
