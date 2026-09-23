'use strict';
// core/default-model-preference.js 的单测。
// 跑：node --test tests/unit-default-model-preference.test.js

const test = require('node:test');
const assert = require('node:assert');

const {
  isDefaultModel,
  isModelValidForKind,
  isSafeModelId,
  readDefaultModels,
  resolveDefaultModel,
  withDefaultModelInJson,
} = require('../core/default-model-preference.js');
const { DEFAULT_MODEL_BY_KIND } = require('../core/model-options.js');

test('模型 id 白名单挡住能改变命令语义的字符', () => {
  assert.ok(isSafeModelId('claude-opus-5-5'));
  assert.ok(isSafeModelId('claude-opus-5-5[1m]'));
  assert.ok(isSafeModelId('gpt-6-astra'));
  assert.ok(isSafeModelId('kimi-code/k3'));
  // 这些一旦落盘就会被拼进 --model，必须全部拒绝。
  for (const bad of [
    'claude-opus-5; rm -rf /',
    'claude-opus-5 && whoami',
    'claude-opus-5`id`',
    'claude-opus-5 | tee x',
    '--dangerous-flag',
    '',
    '  ',
  ]) {
    assert.strictEqual(isSafeModelId(bad), false, `应拒绝：${JSON.stringify(bad)}`);
  }
});

test('跨 CLI 的模型不能设成别家的默认值', () => {
  assert.ok(isModelValidForKind('claude', 'claude-opus-5-5[1m]'));
  assert.ok(isModelValidForKind('codex', 'gpt-6-astra'));
  // Codex 的模型设成 Claude 默认值会让会话起不来，必须挡住。
  assert.strictEqual(isModelValidForKind('claude', 'gpt-6-astra'), false);
  assert.strictEqual(isModelValidForKind('codex', 'claude-opus-5-5'), false);
});

test('claude 认得静态清单里还没有的新模型（官方目录刚发现的那种）', () => {
  // 这条是和模型自动发现配套的：下拉里能出现的新模型，就应该能被设成默认。
  assert.ok(isModelValidForKind('claude', 'claude-opus-9-9[1m]'));
});

test('ACP 类 kind：清单内的必然放行，清单外按「不是别家 CLI 的」放行', () => {
  assert.ok(isModelValidForKind('qwen', require('../core/model-options.js').MODEL_OPTIONS_BY_KIND.qwen[0].id));
  // 有意的权衡：ACP 的下拉会追加用户自配模型，core 侧无法区分「用户自配」和
  // 「打错字」，所以这里放行，由 UI 那一层的 availableIds 兜底（打错字的模型
  // 根本不会出现在下拉里，也就点不到「设为默认」）。安全白名单不受影响。
  assert.ok(isModelValidForKind('qwen', 'qwen-some-new-preview'));
  assert.strictEqual(isModelValidForKind('qwen', 'qwen-x; rm -rf /'), false);
  assert.strictEqual(isModelValidForKind('', 'claude-opus-5'), false);
});

test('readDefaultModels 扔掉 config.json 里被手改坏的条目', () => {
  const models = readDefaultModels({
    defaultModels: {
      claude: 'claude-opus-5-5[1m]',
      codex: 'claude-opus-5',        // 跨 CLI，丢弃
      qwen: 'rm -rf /',              // 不安全，丢弃
    },
  });
  assert.deepStrictEqual(models, { claude: 'claude-opus-5-5[1m]' });
  // 结构本身不对时也不能抛。
  assert.deepStrictEqual(readDefaultModels(null), {});
  assert.deepStrictEqual(readDefaultModels({ defaultModels: 'nope' }), {});
  assert.deepStrictEqual(readDefaultModels({ defaultModels: ['a'] }), {});
});

test('没设过默认值时沿用出厂默认', () => {
  assert.strictEqual(resolveDefaultModel('claude', {}), DEFAULT_MODEL_BY_KIND.claude);
  assert.strictEqual(resolveDefaultModel('codex', {}), DEFAULT_MODEL_BY_KIND.codex);
});

test('设过默认值就优先用它，且 -resume 变体同样生效', () => {
  const config = { defaultModels: { claude: 'claude-opus-5-5[1m]' } };
  assert.strictEqual(resolveDefaultModel('claude', config), 'claude-opus-5-5[1m]');
  assert.strictEqual(resolveDefaultModel('claude-resume', config), 'claude-opus-5-5[1m]');
});

test('默认值不在当前可选清单里时不会预选出一个空白项', () => {
  const config = { defaultModels: { claude: 'claude-opus-5-5[1m]' } };
  // 清单里没有它（比如 CLI 版本不够被过滤掉了）→ 回落出厂默认。
  assert.strictEqual(
    resolveDefaultModel('claude', config, ['claude-opus-5[1m]', 'claude-sonnet-5']),
    'claude-opus-5[1m]',
  );
  // 出厂默认也不在清单里 → 取第一项，而不是返回一个列表外的值。
  assert.strictEqual(
    resolveDefaultModel('claude', config, ['claude-sonnet-5']),
    'claude-sonnet-5',
  );
});

test('写入落在 config.json 的 models.defaults，其它字段原样保留', () => {
  const before = {
    proxy: { http: 'http://127.0.0.1:7890' },
    providers: { claude: { backend: 'subscription' } },
    models: { somethingElse: 1 },
  };
  const after = withDefaultModelInJson(before, 'claude', 'claude-opus-5-5[1m]');
  assert.deepStrictEqual(after.models.defaults, { claude: 'claude-opus-5-5[1m]' });
  // 别的字段一个都不能丢 —— 这个函数的结果会被整份写回 config.json。
  assert.deepStrictEqual(after.proxy, before.proxy);
  assert.deepStrictEqual(after.providers, before.providers);
  assert.strictEqual(after.models.somethingElse, 1);
  // 不可变：不得就地改调用方传进来的对象。
  assert.strictEqual(before.models.defaults, undefined);
});

test('传空 model 表示恢复出厂默认，只删自己那一项', () => {
  const before = { models: { defaults: { claude: 'claude-opus-5-5[1m]', codex: 'gpt-6-astra' } } };
  const after = withDefaultModelInJson(before, 'claude', '');
  assert.deepStrictEqual(after.models.defaults, { codex: 'gpt-6-astra' });
  assert.strictEqual(resolveDefaultModel('claude', { defaultModels: after.models.defaults }),
    DEFAULT_MODEL_BY_KIND.claude);
});

test('非法写入被拒绝且不产生部分写入', () => {
  const before = { models: { defaults: { claude: 'claude-opus-5-5[1m]' } } };
  assert.throws(() => withDefaultModelInJson(before, 'claude', 'gpt-6-astra'), /不是 claude 可用的模型/);
  assert.throws(() => withDefaultModelInJson(before, 'claude', 'claude-opus-5; rm -rf /'), /不是 claude 可用的模型/);
  assert.throws(() => withDefaultModelInJson(before, '', 'claude-opus-5'), /未指定 CLI 类型/);
  // 原对象不受影响。
  assert.deepStrictEqual(before.models.defaults, { claude: 'claude-opus-5-5[1m]' });
});

test('首次写入（config.json 还不存在，传空对象）也能建出结构', () => {
  const after = withDefaultModelInJson({}, 'claude', 'claude-opus-5-5[1m]');
  assert.deepStrictEqual(after.models.defaults, { claude: 'claude-opus-5-5[1m]' });
  assert.deepStrictEqual(withDefaultModelInJson(undefined, 'codex', 'gpt-6-astra').models.defaults,
    { codex: 'gpt-6-astra' });
});

// —— 审查发现的回归用例 ——

test('ACP 用户自配模型：下拉里选得到，就必须存得进去也读得回来', () => {
  // acpModelOptions(kind, configuredModel) 会把用户配置里的模型追加进下拉，
  // 静态清单认不出它。只按静态清单校验会出现「选得到却存不进去」的死路。
  const custom = 'qwen3.9-max-preview';
  assert.ok(isModelValidForKind('qwen', custom), '自配 ACP 模型应被接受');
  // 存得进去
  const after = withDefaultModelInJson({}, 'qwen', custom);
  assert.strictEqual(after.models.defaults.qwen, custom);
  // 读得回来（否则存了也白存）
  assert.deepStrictEqual(readDefaultModels({ defaultModels: { qwen: custom } }), { qwen: custom });
  assert.strictEqual(resolveDefaultModel('qwen', { defaultModels: { qwen: custom } }), custom);
  // 放行的边界仍然是「不能是别家 CLI 的模型」
  assert.strictEqual(isModelValidForKind('qwen', 'claude-opus-5-5'), false);
  assert.strictEqual(isModelValidForKind('qwen', 'gpt-6-astra'), false);
  // 没有模型概念的 kind 不受影响
  assert.strictEqual(isModelValidForKind('powershell', 'anything'), false);
});

test('availableIds 放行调用方清单内的模型，但安全白名单仍独立把关', () => {
  const custom = 'glm-custom-build-7';
  // 不给清单时静态校验也会放行（上一条已覆盖），这里验证给了清单的路径。
  assert.strictEqual(
    withDefaultModelInJson({}, 'glm', custom, { availableIds: [custom] }).models.defaults.glm,
    custom,
  );
  // 不在清单里 → 拒绝
  assert.throws(
    () => withDefaultModelInJson({}, 'glm', 'not-offered', { availableIds: [custom] }),
    /不是 glm 可用的模型/,
  );
  // 清单里混进危险串也不得放行 —— 清单只负责放行，不负责安全。
  const evil = 'glm-4; rm -rf /';
  assert.throws(
    () => withDefaultModelInJson({}, 'glm', evil, { availableIds: [evil] }),
    /不是 glm 可用的模型/,
  );
});

test('isDefaultModel 驱动按钮的「默认 ✓ / 设为默认」两态', () => {
  const config = { defaultModels: { claude: 'claude-opus-5-5[1m]' } };
  assert.strictEqual(isDefaultModel('claude', 'claude-opus-5-5[1m]', config), true);
  assert.strictEqual(isDefaultModel('claude', 'claude-sonnet-5', config), false);
  // 没设过默认时，出厂默认那一项也应显示成「默认 ✓」。
  assert.strictEqual(isDefaultModel('claude', DEFAULT_MODEL_BY_KIND.claude, {}), true);
  assert.strictEqual(isDefaultModel('claude', '', config), false);
});
