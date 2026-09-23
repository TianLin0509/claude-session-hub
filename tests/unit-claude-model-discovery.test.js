'use strict';
// core/claude-model-discovery.js 的单测。
// 跑：node --test tests/unit-claude-model-discovery.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  cliUpdateNotice,
  compareCliVersions,
  noteSessionStart,
  discoveredModelOptions,
  isCacheFresh,
  isValidCliVersion,
  normalizeCatalogModels,
  readClaudeModelDiscovery,
  readDiscoveryCache,
  refreshClaudeModelDiscovery,
  writeDiscoveryCache,
} = require('../core/claude-model-discovery.js');

// 2026-09-23 从 downloads.claude.ai/model-catalog/v1/catalog.json 取回的真实形状，
// 只保留断言用得到的字段。Opus 5.5 的 min_claude_code_version 是这次事故的核心。
const CATALOG_FIXTURE = {
  schema_version: 1,
  version: 1033,
  issued_at: '2026-09-23T14:24:37Z',
  expires_at: '2026-09-30T14:24:37Z',
  surfaces: {
    cc: {
      model_selector_config: [{
        id: 'cc',
        models: [
          {
            id: 'claude-opus-5-5',
            name: 'Opus 5.5',
            description: 'Most capable for ambitious work',
            section: 'main',
            quick_select: true,
            min_claude_code_version: '2.1.280',
            runtime: { max_input_tokens: 1000000, family: 'opus' },
            offered_on: ['first_party', 'bedrock'],
          },
          {
            id: 'claude-sonnet-5',
            name: 'Sonnet 5',
            description: 'Most efficient for everyday tasks',
            section: 'main',
            quick_select: true,
            runtime: { max_input_tokens: 1000000, family: 'sonnet' },
            offered_on: ['first_party'],
          },
          {
            id: 'claude-haiku-4-5-20251001',
            name: 'Haiku 4.5',
            description: 'Fastest',
            section: 'main',
            quick_select: true,
            runtime: { max_input_tokens: 200000, family: 'haiku' },
            offered_on: ['first_party'],
          },
          {
            id: 'claude-opus-4-6',
            name: 'Opus 4.6',
            description: '',
            section: 'overflow',
            runtime: { max_input_tokens: 1000000, family: 'opus' },
            offered_on: ['first_party'],
          },
          {
            // 非第一方：Hub 走订阅登录，列出来也选不了，必须被过滤掉。
            id: 'claude-opus-4-1-20250805',
            name: 'Opus 4.1',
            section: 'overflow',
            runtime: { max_input_tokens: 200000, family: 'opus' },
            offered_on: ['bedrock', 'vertex'],
          },
        ],
      }],
    },
    chat: { model_selector_config: [{ id: 'chat', models: [{ id: 'claude-chat-only' }] }] },
  },
};

function tempCachePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-model-discovery-')), 'cache.json');
}

test('compareCliVersions 按数字段比较，不退化成字符串序', () => {
  assert.strictEqual(compareCliVersions('2.1.269', '2.1.280'), -1);
  assert.strictEqual(compareCliVersions('2.1.280', '2.1.269'), 1);
  assert.strictEqual(compareCliVersions('2.1.280', '2.1.280'), 0);
  // 字符串序会判成 "2.1.9" > "2.1.280"，这里必须是小于。
  assert.strictEqual(compareCliVersions('2.1.9', '2.1.280'), -1);
  // 段数不同时短的补 0。
  assert.strictEqual(compareCliVersions('2.2', '2.1.999'), 1);
  assert.strictEqual(compareCliVersions('2.1', '2.1.0'), 0);
});

test('isValidCliVersion 拒绝非版本号字符串', () => {
  assert.ok(isValidCliVersion('2.1.280'));
  assert.ok(!isValidCliVersion(''));
  assert.ok(!isValidCliVersion('cc-update-required-1'));
  assert.ok(!isValidCliVersion('latest'));
});

test('normalizeCatalogModels 只取 cc surface 且只留第一方模型', () => {
  const models = normalizeCatalogModels(CATALOG_FIXTURE);
  const ids = models.map(model => model.id);
  assert.ok(ids.includes('claude-opus-5-5'));
  assert.ok(ids.includes('claude-sonnet-5'));
  // chat surface 的模型不能漏进来。
  assert.ok(!ids.includes('claude-chat-only'));
  // 非第一方条目必须被过滤。
  assert.ok(!ids.includes('claude-opus-4-1-20250805'));
  const opus55 = models.find(model => model.id === 'claude-opus-5-5');
  assert.strictEqual(opus55.minCliVersion, '2.1.280');
  assert.strictEqual(opus55.maxInputTokens, 1000000);
  assert.strictEqual(opus55.quickSelect, true);
});

test('normalizeCatalogModels 对畸形输入返回空数组而不是抛', () => {
  assert.deepStrictEqual(normalizeCatalogModels(null), []);
  assert.deepStrictEqual(normalizeCatalogModels({}), []);
  assert.deepStrictEqual(normalizeCatalogModels({ surfaces: { cc: {} } }), []);
});

test('1M 模型生成 [1m] 与裸 id 两个变体，200k 模型只生成一个', () => {
  const options = discoveredModelOptions(normalizeCatalogModels(CATALOG_FIXTURE), {
    localVersion: '2.1.280',
  });
  const ids = options.map(option => option.id);
  assert.ok(ids.includes('claude-sonnet-5[1m]'));
  assert.ok(ids.includes('claude-sonnet-5'));
  assert.strictEqual(
    options.find(option => option.id === 'claude-sonnet-5[1m]').label,
    'Sonnet 5 (1M context)',
  );
  assert.strictEqual(options.find(option => option.id === 'claude-sonnet-5').label, 'Sonnet 5');
  // Haiku 只有 200k，不该有 [1m] 变体。
  assert.ok(ids.includes('claude-haiku-4-5-20251001'));
  assert.ok(!ids.includes('claude-haiku-4-5-20251001[1m]'));
});

// —— 这次事故的回归用例 ——
// 2026-09-23：本机 CLI 2.1.269，Opus 5.5 要求 2.1.280+。旧实现把这条信息整个
// 丢掉，用户既看不到新模型也不知道要升级。下面两条断言就是防它复发。
test('CLI 版本不够时，新模型仍然出现在选项里并标注要升到哪个版本', () => {
  const options = discoveredModelOptions(normalizeCatalogModels(CATALOG_FIXTURE), {
    localVersion: '2.1.269',
  });
  const opus55 = options.find(option => option.id === 'claude-opus-5-5[1m]');
  assert.ok(opus55, 'Opus 5.5 不能因为版本不够就从列表里消失');
  assert.strictEqual(opus55.disabled, true);
  assert.strictEqual(opus55.upgradeTo, '2.1.280');
  // 版本够的模型不该被误标。
  const sonnet = options.find(option => option.id === 'claude-sonnet-5[1m]');
  assert.strictEqual(sonnet.disabled, undefined);
});

test('CLI 版本够时，同一个模型不再标 disabled', () => {
  const options = discoveredModelOptions(normalizeCatalogModels(CATALOG_FIXTURE), {
    localVersion: '2.1.280',
  });
  const opus55 = options.find(option => option.id === 'claude-opus-5-5[1m]');
  assert.ok(opus55);
  assert.strictEqual(opus55.disabled, undefined);
  assert.strictEqual(opus55.upgradeTo, undefined);
});

test('cliUpdateNotice 优先报「有新模型被版本挡住」，并给出可操作的目标版本', () => {
  const notice = cliUpdateNotice({
    localVersion: '2.1.269',
    latestVersion: '2.1.280',
    models: normalizeCatalogModels(CATALOG_FIXTURE),
  });
  assert.ok(notice);
  assert.strictEqual(notice.kind, 'model-blocked');
  assert.strictEqual(notice.targetVersion, '2.1.280');
  assert.deepStrictEqual(notice.blockedModels, ['claude-opus-5-5']);
  assert.match(notice.message, /Opus 5\.5/);
  assert.match(notice.message, /2\.1\.280/);
});

test('没有被挡住的模型、但有更新版本时，退而报「有新版可升」', () => {
  const notice = cliUpdateNotice({
    localVersion: '2.1.280',
    latestVersion: '2.1.300',
    models: normalizeCatalogModels(CATALOG_FIXTURE),
  });
  assert.ok(notice);
  assert.strictEqual(notice.kind, 'update-available');
  assert.strictEqual(notice.targetVersion, '2.1.300');
});

test('已是最新时不产生任何提醒', () => {
  assert.strictEqual(cliUpdateNotice({
    localVersion: '2.1.280',
    latestVersion: '2.1.280',
    models: normalizeCatalogModels(CATALOG_FIXTURE),
  }), null);
  // 本地比 latest 还新（刚升级、通道还没更新）也不该提醒。
  assert.strictEqual(cliUpdateNotice({
    localVersion: '2.1.300',
    latestVersion: '2.1.280',
    models: normalizeCatalogModels(CATALOG_FIXTURE),
  }), null);
});

test('拿不到本地版本号时不瞎提醒', () => {
  assert.strictEqual(cliUpdateNotice({ localVersion: '', latestVersion: '2.1.280', models: [] }), null);
});

test('缓存读写走原子替换，损坏的缓存按「没有」处理而不是抛', () => {
  const cachePath = tempCachePath();
  assert.strictEqual(readDiscoveryCache({ cachePath }), null);
  const payload = { fetchedAt: Date.now(), models: [{ id: 'claude-opus-5-5' }] };
  assert.strictEqual(writeDiscoveryCache(payload, { cachePath }), true);
  assert.deepStrictEqual(readDiscoveryCache({ cachePath }).models, payload.models);
  fs.writeFileSync(cachePath, '{ 这不是 JSON', 'utf8');
  assert.strictEqual(readDiscoveryCache({ cachePath }), null);
});

test('isCacheFresh 按 TTL 判定', () => {
  assert.ok(isCacheFresh({ fetchedAt: Date.now() }, { ttlMs: 1000 }));
  assert.ok(!isCacheFresh({ fetchedAt: Date.now() - 5000 }, { ttlMs: 1000 }));
  assert.ok(!isCacheFresh(null, { ttlMs: 1000 }));
  assert.ok(!isCacheFresh({}, { ttlMs: 1000 }));
});

test('refreshClaudeModelDiscovery 网络失败时返回 ok:false 而不是抛', async () => {
  const result = await refreshClaudeModelDiscovery({
    cachePath: tempCachePath(),
    fetchImpl: async () => { throw new Error('ENOTFOUND downloads.claude.ai'); },
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /ENOTFOUND/);
});

test('refreshClaudeModelDiscovery 成功时写缓存，readClaudeModelDiscovery 随后同步可读', async () => {
  const cachePath = tempCachePath();
  const fetchImpl = async url => {
    if (String(url).includes('catalog.json')) {
      return { ok: true, status: 200, json: async () => CATALOG_FIXTURE };
    }
    if (String(url).endsWith('/latest')) {
      return { ok: true, status: 200, text: async () => '2.1.280\n' };
    }
    return { ok: true, status: 200, text: async () => '2.1.267\n' };
  };
  const refreshed = await refreshClaudeModelDiscovery({ cachePath, fetchImpl });
  assert.strictEqual(refreshed.ok, true);
  assert.strictEqual(refreshed.catalogVersion, 1033);
  assert.strictEqual(refreshed.releases.latest, '2.1.280');
  assert.strictEqual(refreshed.releases.stable, '2.1.267');

  const snapshot = readClaudeModelDiscovery({ cachePath, localVersion: '2.1.269' });
  assert.strictEqual(snapshot.loaded, true);
  assert.strictEqual(snapshot.stale, false);
  assert.ok(snapshot.options.some(option => option.id === 'claude-opus-5-5[1m]'));
  assert.strictEqual(snapshot.notice.kind, 'model-blocked');
});

test('没有缓存时 readClaudeModelDiscovery 安全降级：loaded=false、stale=true、无提醒', () => {
  const snapshot = readClaudeModelDiscovery({ cachePath: tempCachePath(), localVersion: '2.1.280' });
  assert.strictEqual(snapshot.loaded, false);
  assert.strictEqual(snapshot.stale, true);
  assert.deepStrictEqual(snapshot.options, []);
  assert.strictEqual(snapshot.notice, null);
});

test('记下的 CLI 版本会被后续读取当作默认 localVersion', () => {
  const cachePath = tempCachePath();
  writeDiscoveryCache({
    fetchedAt: Date.now(),
    models: normalizeCatalogModels(CATALOG_FIXTURE),
  }, { cachePath });
  // 没记版本之前，无从判断谁被挡住，不该瞎标 disabled。
  const before = readClaudeModelDiscovery({ cachePath });
  assert.strictEqual(before.notice, null);
  assert.strictEqual(
    before.options.find(option => option.id === 'claude-opus-5-5[1m]').disabled,
    undefined,
  );
  // init 帧报上来之后，同一份缓存就能得出正确结论。
  noteSessionStart('2.1.269', { cachePath });
  const after = readClaudeModelDiscovery({ cachePath });
  assert.strictEqual(after.notice.kind, 'model-blocked');
  assert.strictEqual(
    after.options.find(option => option.id === 'claude-opus-5-5[1m]').upgradeTo,
    '2.1.280',
  );
});

test('noteSessionStart 在缓存新鲜时不打网络', () => {
  const cachePath = tempCachePath();
  writeDiscoveryCache({ fetchedAt: Date.now(), models: [] }, { cachePath });
  let called = 0;
  noteSessionStart('2.1.280', { cachePath, fetchImpl: async () => { called += 1; throw new Error('不该被调用'); } });
  assert.strictEqual(called, 0, '缓存还新鲜就不该触发刷新');
});

test('noteSessionStart 同步返回、不抛，且网络失败不会冒出未捕获拒绝', async () => {
  const cachePath = tempCachePath();
  let called = 0;
  // 缓存过期 → 应触发后台刷新；刷新必然失败，但绝不能抛到调用方。
  writeDiscoveryCache({ fetchedAt: Date.now() - 24 * 60 * 60 * 1000, models: [] }, { cachePath });
  assert.strictEqual(noteSessionStart('2.1.280', {
    cachePath,
    fetchImpl: async () => { called += 1; throw new Error('ENOTFOUND'); },
  }), undefined);
  // 版本号非法也必须安全吞掉（init 帧字段缺失时会走到这里）。
  assert.doesNotThrow(() => noteSessionStart('', { cachePath }));
  assert.doesNotThrow(() => noteSessionStart(undefined, { cachePath }));
  // 给后台 Promise 一个 tick 去 reject，验证没有 unhandled rejection 逃逸。
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(called > 0, '缓存过期时应当触发过刷新');
});
