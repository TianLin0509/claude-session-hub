'use strict';

// Codex 的两个速度旋钮 —— service_tier（对标 Claude fast）与 model_reasoning_effort。
// 这些常量是 2026-08-16 从 codex-cli 0.144.0 实测出来的，不是凭印象写的：
//   * ~/.codex/models_cache.json 给出每个模型的 supported_reasoning_levels
//     （gpt-5.6-sol 到 ultra，gpt-5.5 只到 xhigh）与 additional_speed_tiers=["fast"]；
//     service_tiers=[{id:"priority", name:"Fast", description:"1.5x speed, increased usage"}]
//   * `codex doctor --summary -c <k>=<v>` 的退出码证明配置层对枚举的松紧：
//       approval_policy="banana" → exit 1（严格）
//       sandbox_mode="banana"    → exit 1（严格）
//       service_tier="banana"    → exit 0（不校验）
//       model_reasoning_effort="banana" → exit 0（不校验）
//     —— 正因为不校验，Hub 这一侧必须自己把关，不能把乱值拼进命令行。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DEFAULT_CODEX_SPEED_TIER,
  buildCodexSpeedTierArg,
  normalizeCodexSpeedTier,
  readCodexConfiguredServiceTier,
} = require('../core/codex-speed-tier.js');
const {
  buildCodexTuningSnapshot,
  describeCodexModelTuning,
  isEffortSupported,
} = require('../core/codex-model-catalog.js');
const { _private } = require('../core/session-manager.js');

function makeCodexHome({ configToml = '', modelsCache = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codex-tuning-'));
  if (configToml) fs.writeFileSync(path.join(home, 'config.toml'), configToml, 'utf8');
  if (modelsCache) fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify(modelsCache), 'utf8');
  return { home, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

const CATALOG = {
  models: [
    {
      slug: 'gpt-5.6-sol',
      default_reasoning_level: 'low',
      supported_reasoning_levels: [
        { effort: 'low' }, { effort: 'medium' }, { effort: 'high' },
        { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' },
      ],
      additional_speed_tiers: ['fast'],
      service_tiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }],
    },
    {
      slug: 'gpt-5.5',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [
        { effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' },
      ],
      additional_speed_tiers: ['fast'],
    },
    {
      slug: 'gpt-5.4-mini',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }],
      additional_speed_tiers: [],
    },
  ],
};

test('service_tier 只认实测有效的值，inherit 表示完全不覆盖', () => {
  assert.equal(normalizeCodexSpeedTier(undefined), DEFAULT_CODEX_SPEED_TIER);
  assert.equal(DEFAULT_CODEX_SPEED_TIER, 'inherit');
  assert.equal(normalizeCodexSpeedTier('FAST'), 'fast');
  assert.equal(normalizeCodexSpeedTier('flex'), 'flex');
  // priority 是模型目录里的 tier id，配置里写的是 fast；不在白名单就当没选，
  // 宁可不覆盖也不要拼一个可能被 API 拒绝的值进命令行。
  assert.equal(normalizeCodexSpeedTier('priority'), 'inherit');
  assert.equal(normalizeCodexSpeedTier('banana'), 'inherit');
});

test('inherit 不产生任何 flag —— 等于改动前的行为', () => {
  assert.equal(buildCodexSpeedTierArg('inherit'), '');
  assert.equal(buildCodexSpeedTierArg(undefined), '');
  assert.equal(buildCodexSpeedTierArg('banana'), '');
});

test('fast / flex 拼出与其它 -c 同款引号风格的片段', () => {
  // 整条命令是写进 PowerShell PTY 的，外层单引号 + TOML 内层双引号是本仓库
  // 其它 5 个 -c 已经验证过的写法，别改成别的引号组合。
  assert.equal(buildCodexSpeedTierArg('fast'), ` -c 'service_tier="fast"'`);
  assert.equal(buildCodexSpeedTierArg('flex'), ` -c 'service_tier="flex"'`);
});

test('读用户全局 service_tier 只认顶层键，不会把 profile 里的当成全局', () => {
  const a = makeCodexHome({ configToml: 'model = "gpt-5.6-sol"\nservice_tier = "fast"\n\n[features]\napps = false\n' });
  try {
    assert.equal(readCodexConfiguredServiceTier(a.home), 'fast');
  } finally { a.cleanup(); }

  const b = makeCodexHome({ configToml: 'model = "gpt-5.6-sol"\n\n[profiles.slow]\nservice_tier = "flex"\n' });
  try {
    assert.equal(readCodexConfiguredServiceTier(b.home), null, 'profile 里的值不是全局值');
  } finally { b.cleanup(); }

  const c = makeCodexHome({ configToml: '# service_tier = "fast"\nmodel = "x"\n' });
  try {
    assert.equal(readCodexConfiguredServiceTier(c.home), null, '注释掉的不算');
  } finally { c.cleanup(); }

  assert.equal(readCodexConfiguredServiceTier(path.join(os.tmpdir(), 'definitely-not-here')), null);
});

test('思考强度档位按模型来，不是一份写死的表', () => {
  const h = makeCodexHome({ modelsCache: CATALOG });
  try {
    const sol = describeCodexModelTuning('gpt-5.6-sol', { configDir: h.home });
    assert.deepEqual(sol.efforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    assert.equal(sol.supportsFast, true);
    assert.equal(sol.fromCache, true);

    const g55 = describeCodexModelTuning('gpt-5.5', { configDir: h.home });
    assert.deepEqual(g55.efforts, ['low', 'medium', 'high', 'xhigh']);
    // 关键回归：给 5.5 显示 ultra 就会拼出它不认识的值。
    assert.equal(g55.efforts.includes('ultra'), false);
    assert.equal(g55.efforts.includes('max'), false);

    // xhigh 不是 Claude 专属 —— 每个 Codex 模型都支持，上一版把它从选项里去掉是错的。
    assert.equal(isEffortSupported('gpt-5.5', 'xhigh', { configDir: h.home }), true);
    assert.equal(isEffortSupported('gpt-5.5', 'ultra', { configDir: h.home }), false);

    const mini = describeCodexModelTuning('gpt-5.4-mini', { configDir: h.home });
    assert.equal(mini.supportsFast, false, '没有 fast 速度通道的模型不该显示 fast 档');
  } finally { h.cleanup(); }
});

test('模型目录读不到时回落保守档位，并如实标 fromCache=false', () => {
  const h = makeCodexHome();
  try {
    const t = describeCodexModelTuning('gpt-5.6-sol', { configDir: h.home });
    assert.deepEqual(t.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.equal(t.fromCache, false);
    // 不敢断言"这个模型没有 fast"，按有处理 —— 藏掉一个真实存在的功能比多给一档更糟。
    assert.equal(t.supportsFast, true);
  } finally { h.cleanup(); }
});

test('目录里没有的模型（如 gpt-5.3-codex）也走回落而不是空档位', () => {
  const h = makeCodexHome({ modelsCache: CATALOG });
  try {
    const t = describeCodexModelTuning('gpt-5.3-codex', { configDir: h.home });
    assert.ok(t.efforts.length > 0);
    assert.equal(t.fromCache, false);
  } finally { h.cleanup(); }
});

test('弹窗用的快照一次性给齐所有 codex 模型 + 全局 service_tier', () => {
  const h = makeCodexHome({ configToml: 'service_tier = "fast"\n', modelsCache: CATALOG });
  try {
    const snap = buildCodexTuningSnapshot(['gpt-5.6-sol', 'gpt-5.5'], { configDir: h.home });
    assert.equal(snap.catalogLoaded, true);
    assert.deepEqual(Object.keys(snap.byModel).sort(), ['gpt-5.5', 'gpt-5.6-sol']);
    assert.equal(snap.byModel['gpt-5.6-sol'].efforts.includes('ultra'), true);
    assert.equal(snap.effortDescriptions.ultra, '最大推理 + 自动任务分派');
  } finally { h.cleanup(); }
});

test('session-manager 侧的 effort 白名单已经收下 xhigh 与 ultra', () => {
  const { normalizeCodexEffort } = _private;
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    assert.equal(normalizeCodexEffort(level), level, `${level} 必须原样通过`);
  }
  // 语法层白名单之外的仍然回落 max，不把乱字符串拼进命令行。
  assert.equal(normalizeCodexEffort('banana'), 'max');
  assert.equal(normalizeCodexEffort(''), 'max');
});
