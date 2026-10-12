'use strict';
// Token Plan 额度用完 → DeepSeek API 改道：判断、启动参数、会话控制器、群聊失败分类、写作成员。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const fallback = require('../core/token-plan-fallback');
const { buildAcpOptions } = require('../core/acp-profiles');
const { createTokenPlanFallbackController, CONTINUATION_NOTE } = require('../main/token-plan-fallback-controller');
const { classifyProviderFailure } = require('../core/groupchat-attempt-protocol');

// 2026-10-12 真实报文（套餐月额度 100% 时三家外壳各自的样子）。
const RAW = 'Your token-plan 1-month quota has been exhausted. The quota will reset at 10-12 16:00:00 UTC.';
const QWEN_ANSWER = 'Quota exhausted: ' + RAW + '\n\nPlease retry after the reset time, or switch to another API key / auth method. (cause: insufficient_quota: 429 ' + RAW + ')';
const DSH_ERROR = 'QUOTA: 429: {"message":"' + RAW + '","type":"insufficient_quota","code":"insufficient_quota"}';
const NOW = Date.UTC(2026, 9, 12, 1, 0, 0);
const RESET = Date.UTC(2026, 9, 12, 16, 0, 0);

function tmp(t, prefix = 'hub-tp-fallback-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('recognises the three real quota shapes and parses the UTC reset time', () => {
  for (const text of [QWEN_ANSWER, DSH_ERROR, 'providerCode: insufficient_quota']) assert.equal(fallback.isTokenPlanQuotaText(text), true);
  // 正常回答通道只认 Qwen 那条短原文；在回答里讨论这个错误码不算撞墙。
  assert.equal(fallback.isTokenPlanQuotaAnswer(QWEN_ANSWER), true);
  assert.equal(fallback.isTokenPlanQuotaAnswer('这个 429 insufficient_quota 是说 ' + RAW + ' 处理办法如下……'), false);
  assert.equal(fallback.isTokenPlanQuotaAnswer('Quota exhausted: ' + RAW + ' 详细说明'.repeat(300)), false);
  // 引用旧日志的「reset at」不能把状态锁到一年后。
  assert.equal(fallback.parseResetAt('will reset at 01-01 00:00:00 UTC', NOW), null);
  assert.equal(fallback.isTokenPlanQuotaText('我们来讨论一下 quota 的设计'), false);
  assert.equal(fallback.parseResetAt(RAW, NOW), RESET);
  // 12-31 撞墙、01-01 重置：年份进到下一年。
  assert.equal(fallback.parseResetAt('will reset at 01-01 00:00:00 UTC', Date.UTC(2026, 11, 31, 20)), Date.UTC(2027, 0, 1));
  assert.equal(fallback.parseResetAt('no time here', NOW), null);
  assert.equal(fallback.formatReset(RESET), '10-13 00:00');
  // 同一会话换计费线路后，显示历史仍属于它；换了外壳或别的配置域则不行。
  assert.equal(fallback.sameProfileDomain('aliyun-token-plan:deepseek-acp', 'deepseek-api:deepseek-acp'), true);
  assert.equal(fallback.sameProfileDomain('aliyun-token-plan:qwen', 'deepseek-api:glm'), false);
  assert.equal(fallback.sameProfileDomain('other:qwen', 'deepseek-api:qwen'), false);
});

test('exhaustion state expires at reset, follows usage readings and needs a DeepSeek key to reroute', t => {
  const dir = tmp(t);
  assert.equal(fallback.exhaustedUntil(dir, NOW), 0);
  assert.equal(fallback.markExhausted(dir, { resetsAt: RESET, now: NOW }), true);
  assert.equal(fallback.markExhausted(dir, { resetsAt: RESET, now: NOW + 1 }), false, 'same reset is not a new event');
  assert.equal(fallback.exhaustedUntil(dir, NOW), RESET);
  assert.equal(fallback.exhaustedUntil(dir, RESET + 1), 0, 'state lapses by itself at the reset time');
  assert.equal(fallback.resolveRoute({ config: {}, dataDir: dir, now: NOW }).missingKey, true);
  const route = fallback.resolveRoute({ config: { deepseekApiKey: 'ds-key' }, dataDir: dir, now: NOW });
  assert.deepEqual([route.route, route.apiKey, route.baseURL], ['deepseek', 'ds-key', 'https://api.deepseek.com/v1']);
  // 用量回落（比如续了套餐）才撤销；99% 不算恢复。
  const LATER = NOW + 11 * 60_000;
  assert.equal(fallback.observeUsage(dir, { usage30d: { pct: 40 }, observedAt: NOW + 120_000 }, NOW + 120_000), null, 'reading right after a real 429 may lag');
  assert.equal(fallback.observeUsage(dir, { usage30d: { pct: 99 }, observedAt: LATER }, LATER), null);
  assert.equal(fallback.observeUsage(dir, { usage30d: { pct: 40 }, observedAt: LATER }, LATER), 'recovered');
  assert.equal(fallback.exhaustedUntil(dir, LATER), 0);
  assert.equal(fallback.observeUsage(dir, { usage30d: { pct: 100, resetsAt: RESET } }, NOW), 'exhausted');
  assert.equal(fallback.exhaustedUntil(dir, NOW), RESET);
  // 读不出重置时间：先按 1 小时算。
  const other = tmp(t);
  fallback.markExhausted(other, { now: NOW });
  assert.equal(fallback.exhaustedUntil(other, NOW), NOW + 3600_000);
  assert.deepEqual(['qwen3.8-max', 'qwen3.8-flash', 'glm-5.2', 'deepseek-v4-flash-0731', 'deepseek-v4-pro'].map(fallback.fallbackModel),
    ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-pro']);
});

test('only the DeepSeek harness moves to the DeepSeek API; Qwen and GLM stay on the plan and wait', t => {
  const root = tmp(t, 'hub-tp-acp-');
  const entry = path.join(root, 'cli.js'); fs.writeFileSync(entry, '');
  const bridge = path.join(root, 'bridge'); fs.mkdirSync(bridge); fs.writeFileSync(path.join(bridge, 'package.json'), '{}');
  const config = { deepseekApiKey: 'ds-secret', acp: { nodePath: process.execPath, apiKey: 'plan-secret', providers: {
    qwen: { entryPath: entry, model: 'qwen3.8-max' },
    'deepseek-acp': { entryPath: entry, bridgePath: bridge, model: 'deepseek-v4-flash-0731' },
    glm: { entryPath: entry, backendPath: entry, model: 'glm-5.2' } } } };
  const env = { PATH: process.env.PATH };
  const dropLink = built => {
    const link = path.join(built.launch.env.DSH_HOME, 'profiles/acp/node_modules/@openma/deepseek-harness-acp');
    if (process.platform === 'win32') fs.rmdirSync(link); else fs.unlinkSync(link);
  };
  const before = buildAcpOptions('deepseek-acp', { id: 'd0', cwd: root, effort: 'low' }, config, root, env);
  assert.deepEqual([before.profileId, before.tokenPlanRoute, before.tokenPlanWait, before.effort], ['aliyun-token-plan:deepseek-acp', 'token-plan', null, 'low']);
  dropLink(before);

  fallback.markExhausted(root, { resetsAt: Date.now() + 3600_000 });
  const dsh = buildAcpOptions('deepseek-acp', { id: 'd1', cwd: root, effort: 'low' }, config, root, env);
  assert.equal(dsh.profileId, 'deepseek-api:deepseek-acp');
  assert.equal(dsh.model, 'deepseek-v4-flash');
  assert.equal(dsh.effort, undefined, 'low is not offered on the DeepSeek route');
  assert.equal(dsh.launch.env.BAILIAN_API_KEY, 'ds-secret');
  assert.equal(dsh.authMeta['api-key'].apiKey, 'ds-secret');
  assert.deepEqual(dsh.launch.secrets, ['ds-secret']);
  assert(!JSON.stringify(dsh.launch).includes('plan-secret'), 'plan key never reaches the DeepSeek host');
  const patches = JSON.parse(fs.readFileSync(dsh.launch.args[dsh.launch.args.indexOf('--patch') + 1], 'utf8'));
  const provider = patches.find(p => p.id === 'llm-pi-ai').config.providers['bailian-tpp'];
  assert.equal(provider.baseURL, 'https://api.deepseek.com/v1');
  assert.deepEqual(provider.models.map(m => m.id), ['deepseek-v4-pro', 'deepseek-v4-flash']);
  dropLink(dsh);

  // 千问 / GLM：照旧挂在套餐上，带上「等重置」标记，绝不拿 DeepSeek Key。
  for (const kind of ['qwen', 'glm']) {
    const built = buildAcpOptions(kind, { id: kind + '1', cwd: root }, config, root, env);
    assert.deepEqual([built.profileId, built.tokenPlanRoute, built.tokenPlanWait], ['aliyun-token-plan:' + kind, 'token-plan', { missingKey: false }]);
    assert(!JSON.stringify(built.launch).includes('ds-secret'), kind + ' never receives the DeepSeek key');
  }
  // DeepSeek 旧 Harness 没有 DeepSeek Key：留在套餐上，提示里说清楚缺 Key。
  const noKey = buildAcpOptions('deepseek-acp', { id: 'd2', cwd: root }, { ...config, deepseekApiKey: '' }, root, env);
  assert.deepEqual([noKey.profileId, noKey.tokenPlanWait], ['aliyun-token-plan:deepseek-acp', { missingKey: true }]);
  dropLink(noKey);
  // 重置以后：回到套餐，备用期间记下的 DeepSeek 模型换回配置模型；旧版本切过去的千问也换回自己的模型。
  fallback.clearExhausted(root);
  const back = buildAcpOptions('deepseek-acp', { id: 'd3', cwd: root, model: 'deepseek-v4-flash' }, config, root, env);
  assert.deepEqual([back.profileId, back.model, back.tokenPlanWait], ['aliyun-token-plan:deepseek-acp', 'deepseek-v4-flash-0731', null]);
  dropLink(back);
  assert.equal(buildAcpOptions('qwen', { id: 'q4', cwd: root, model: 'deepseek-v4-pro' }, config, root, env).model, 'qwen3.8-max');
});

function harness(t, { kind = 'deepseek-acp', meetingId = null, deepseekApiKey = 'ds-key' } = {}) {
  const dataDir = tmp(t, 'hub-tp-ctl-');
  const session = { id: 's1', kind, acpProfileId: 'aliyun-token-plan:' + kind, meetingId, currentModel: { id: 'deepseek-v4-pro' } };
  const notices = [], restarts = [], sends = [];
  const native = { emit: (name, message) => notices.push([name, message]), start: async () => {} };
  const sessionManager = { getSession: id => (id === 's1' ? session : null), getNativeSession: () => native };
  const controller = createTokenPlanFallbackController({
    sessionManager, dataDir, settleMs: 0, logger: { log() {}, warn() {} },
    getConfig: () => ({ deepseekApiKey }),
    restartSession: async (id, overrides, options) => {
      restarts.push([id, overrides, options]);
      // 与 buildAcpOptions 一致：按当前套餐状态和外壳决定重启后的线路。
      const route = fallback.resolveRoute({ config: { deepseekApiKey }, dataDir, kind }).route;
      Object.assign(session, { acpProfileId: (route === 'deepseek' ? 'deepseek-api:' : 'aliyun-token-plan:') + kind });
      return { id };
    },
    sendToPty: async (id, text, sendKind, options) => { sends.push({ id, text, kind: sendKind, options }); return { ok: true }; },
  });
  return { controller, session, notices, restarts, sends, dataDir };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test('DeepSeek harness: quota wall reroutes to the DeepSeek API and resends the blocked prompt once', async t => {
  const h = harness(t);
  h.controller.filterLifecycle({ type: 'prompt-submitted', hubSessionId: 's1', text: '帮我总结 README' });
  const out = h.controller.filterLifecycle({ type: 'turn-error', hubSessionId: 's1', turnId: 't1', message: DSH_ERROR });
  assert.equal(out.errorInfo, 'token_plan_quota_rerouted');
  const failure = classifyProviderFailure({ message: out.message, errorInfo: out.errorInfo });
  assert.deepEqual([failure.code, failure.autoRetry], ['token_plan_quota_rerouted', true]);
  // 同一轮的重复事件不再触发第二次改道。
  h.controller.filterLifecycle({ type: 'turn-error', hubSessionId: 's1', turnId: 't1', message: DSH_ERROR });
  await settle();
  assert.deepEqual(h.restarts, [['s1', null, { relaunch: true }]]);
  assert.equal(h.sends.length, 1);
  assert(h.sends[0].text.startsWith(CONTINUATION_NOTE) && h.sends[0].text.endsWith('帮我总结 README'));
  assert.equal(h.sends[0].options.requireReady, false);
  assert.match(h.notices.at(-1)[1], /暂用 DeepSeek API · deepseek-v4-pro（按量计费/);
  assert.match(h.notices.at(-1)[1], /北京时间 10-13 00:00 重置/);
  assert.equal(fallback.exhaustedUntil(h.dataDir, NOW), RESET);
  // 已在 DeepSeek 上的会话不再被拦截。
  assert.equal(h.controller.filterLifecycle({ type: 'turn-error', hubSessionId: 's1', message: DSH_ERROR }).errorInfo, undefined);
});

test('Qwen and GLM wait for the reset: no restart, no resend, sends refused with the reset time', async t => {
  const qwen = harness(t, { kind: 'qwen' });
  qwen.controller.filterLifecycle({ type: 'prompt-submitted', hubSessionId: 's1', text: '帮我总结 README' });
  // Qwen 把额度墙当普通回答交回：改判为失败（群聊不会当答卷），但不改道、不自动重试。
  const out = qwen.controller.filterLifecycle({ type: 'turn-complete', hubSessionId: 's1', turnId: 'q1', text: QWEN_ANSWER, completedAt: 5, signalSource: 'qwen-cli' });
  // 群聊对原生成员只采信 acp 来源：这条权威的额度失败要能让这一轮收尾。
  assert.deepEqual([out.type, out.errorInfo, out.signalSource], ['turn-error', 'token_plan_quota', 'acp']);
  const { GroupChatProviderAdapter } = require('../core/groupchat-provider-adapter');
  const settled = new GroupChatProviderAdapter('qwen', { nativeOnly: true }).error({ sid: 's1', kind: 'qwen', startedAt: 1 }, out);
  assert.deepEqual([settled.accepted, settled.reason], [true, 'token_plan_quota']);
  const failure = classifyProviderFailure({ message: out.message, errorInfo: out.errorInfo });
  assert.deepEqual([failure.code, failure.autoRetry], ['token_plan_quota', false]);
  await settle();
  assert.deepEqual([qwen.restarts.length, qwen.sends.length], [0, 0]);
  assert.match(qwen.notices.at(-1)[1], /北京时间 10-13 00:00 重置）。本会话不改走 API，重置后再发即可/);
  // 已知用完：再发直接拦下，消息不发。
  await assert.rejects(qwen.controller.beforeSend('s1'), e => e.notSent === true && /重置后再发即可/.test(e.message));
  assert.equal(qwen.restarts.length, 0);
  // 到了重置时间就放行。
  fallback.clearExhausted(qwen.dataDir);
  assert.equal(await qwen.controller.beforeSend('s1'), false);

  const glm = harness(t, { kind: 'glm' });
  glm.controller.filterLifecycle({ type: 'turn-error', hubSessionId: 's1', turnId: 'g1', message: 'ZCode turn failed: Throttling.AllocationQuota ' + RAW });
  await settle();
  assert.equal(glm.restarts.length, 0);
  await assert.rejects(glm.controller.beforeSend('s1'), e => e.notSent === true);

  // 旧版本曾把千问切到 DeepSeek：下一条消息前切回套餐（套餐仍用完则切回后拦下）。
  const legacy = harness(t, { kind: 'qwen' });
  legacy.session.acpProfileId = 'deepseek-api:qwen';
  assert.equal(await legacy.controller.beforeSend('s1'), true);
  assert.equal(legacy.session.acpProfileId, 'aliyun-token-plan:qwen');
});

test('group members reroute without an automatic resend; missing DeepSeek key leaves a visible notice', async t => {
  const member = harness(t, { meetingId: 'm1' });
  member.controller.filterLifecycle({ type: 'prompt-submitted', hubSessionId: 's1', text: '第 1 轮问题' });
  member.controller.filterLifecycle({ type: 'turn-error', hubSessionId: 's1', turnId: 't2', message: DSH_ERROR });
  await settle();
  assert.equal(member.restarts.length, 1);
  assert.equal(member.sends.length, 0, 'the group round already closed this attempt; retry goes through the group');

  const noKey = harness(t, { deepseekApiKey: '' });
  const out = noKey.controller.filterLifecycle({ type: 'turn-error', hubSessionId: 's1', turnId: 't3', message: DSH_ERROR });
  assert.equal(out.errorInfo, 'token_plan_quota');
  await settle();
  assert.equal(noKey.restarts.length, 0);
  assert.match(noKey.notices.at(-1)[1], /没有配置 DeepSeek API Key/);
});

test('DeepSeek harness: sends reroute first after exhaustion and switch back after the reset', async t => {
  const h = harness(t);
  assert.equal(await h.controller.beforeSend('s1'), false, 'quota not known: no restart');
  fallback.markExhausted(h.dataDir, { resetsAt: Date.now() + 3600_000 });
  const [a] = await Promise.all([h.controller.beforeSend('s1'), h.controller.beforeSend('s1')]);
  assert.deepEqual([a, h.restarts.length], [true, 1], 'concurrent sends share one reroute');
  assert.equal(await h.controller.beforeSend('s1'), false);
  fallback.clearExhausted(h.dataDir);
  assert.equal(await h.controller.beforeSend('s1'), true);
  assert.equal(h.session.acpProfileId, 'aliyun-token-plan:deepseek-acp');
  assert.match(h.notices.at(-1)[1], /额度已恢复，本会话已切回套餐/);
  assert.equal(h.restarts.length, 2);

  const failingDir = tmp(t);
  const failing = createTokenPlanFallbackController({
    sessionManager: { getSession: () => ({ id: 's1', kind: 'deepseek-acp', acpProfileId: 'aliyun-token-plan:deepseek-acp' }), getNativeSession: () => null },
    dataDir: failingDir, settleMs: 0, logger: { log() {}, warn() {} }, getConfig: () => ({ deepseekApiKey: 'k' }),
    restartSession: async () => ({ ok: false, message: '旧进程迟迟未退出' }),
  });
  fallback.markExhausted(failingDir, { resetsAt: Date.now() + 3600_000 });
  await assert.rejects(failing.beforeSend('s1'), e => e.notSent === true && /切到 DeepSeek API 失败：旧进程迟迟未退出/.test(e.message));

  let reads = 0;
  const usage = createTokenPlanFallbackController({
    sessionManager: { getSession: () => ({ id: 's1', kind: 'glm', acpProfileId: 'aliyun-token-plan:glm' }), getNativeSession: () => null },
    dataDir: tmp(t), settleMs: 0, logger: { log() {}, warn() {} }, getConfig: () => ({}),
    restartSession: async () => ({}), readUsage: async () => { reads++; return { usage30d: { pct: 37 } }; },
  });
  const passthrough = usage.filterLifecycle({ type: 'turn-error', hubSessionId: 's1', turnId: 'x', message: 'Turn execution failed' });
  assert.equal(passthrough.type, 'turn-error');
  await settle();
  assert.equal(reads, 1);
});

test('writing member falls back from an exhausted Token Plan to the DeepSeek API in the same call', async t => {
  const { runDeepseek, readDeepseekConfig } = require('../core/writing/draft-runner');
  const dataDir = tmp(t, 'hub-tp-writing-');
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ acp: { apiKey: 'plan-secret' }, providers: { deepseek: { api_key: 'ds-secret' } } }));
  const env = { CLAUDE_HUB_HOME_DIR: dataDir };
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push([url, init.headers.Authorization, body.model]);
    if (url.startsWith('https://token-plan')) return { ok: false, status: 429, json: async () => ({ error: { message: RAW, type: 'insufficient_quota', code: 'insufficient_quota' } }) };
    return { ok: true, status: 200, json: async () => ({ model: body.model, choices: [{ message: { content: '正文' } }], usage: { prompt_tokens: 3 } }) };
  };
  const result = await runDeepseek({ system: 's', user: 'u', model: 'deepseek-v4-pro', hubDataDir: dataDir, env, fetchImpl });
  assert.equal(result.text, '正文');
  assert.equal(result.meta.via, 'deepseek-api');
  assert.deepEqual(calls.map(c => [c[0].split('/')[2], c[1], c[2]]),
    [['token-plan.cn-beijing.maas.aliyuncs.com', 'Bearer plan-secret', 'deepseek-v4-pro'], ['api.deepseek.com', 'Bearer ds-secret', 'deepseek-v4-pro']]);
  assert(fallback.exhaustedUntil(dataDir) > 0, 'writing shares the exhaustion state with sessions');
  // 之后的调用直接走 DeepSeek，不再先撞一次套餐。
  assert.equal(readDeepseekConfig(dataDir, dataDir, env).via, 'deepseek-api');
  fallback.clearExhausted(dataDir);
  assert.equal(readDeepseekConfig(dataDir, dataDir, env).via, 'token-plan');
});

test('long answers about quota stay answers; a reroute done meanwhile is not repeated; busy turns are not interrupted', async t => {
  const h = harness(t, { kind: 'qwen' });
  const talk = '关于 insufficient_quota：' + RAW + ' 这类报错的处理建议如下……'.repeat(5);
  const out = h.controller.filterLifecycle({ type: 'turn-complete', hubSessionId: 's1', turnId: 'k1', text: talk });
  assert.equal(out.type, 'turn-complete');
  await settle();
  assert.equal(h.notices.length, 0);
  assert.equal(fallback.exhaustedUntil(h.dataDir), 0);
  // 其他供应商的 insufficient_quota 不归到 Token Plan。
  const other = classifyProviderFailure({ message: 'insufficient_quota: billing hard limit', fromAssistantText: false });
  assert(!/token_plan/.test(other && other.code || ''));

  const slow = harness(t);
  const ctl = createTokenPlanFallbackController({
    sessionManager: { getSession: id => (id === 's1' ? slow.session : null), getNativeSession: () => ({ emit() {}, start: async () => {} }) },
    dataDir: slow.dataDir, settleMs: 30, logger: { log() {}, warn() {} }, getConfig: () => ({ deepseekApiKey: 'k' }),
    restartSession: async () => { slow.restarts.push(1); Object.assign(slow.session, { acpProfileId: 'deepseek-api:deepseek-acp' }); return {}; },
    sendToPty: async () => { slow.sends.push(1); return { ok: true }; },
  });
  ctl.filterLifecycle({ type: 'prompt-submitted', hubSessionId: 's1', text: '问题' });
  ctl.filterLifecycle({ type: 'turn-error', hubSessionId: 's1', turnId: 'k2', message: DSH_ERROR });
  // 等待收尾期间，用户的下一条消息已经先把会话切走。
  await ctl.beforeSend('s1');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual([slow.restarts.length, slow.sends.length], [1, 0]);

  const busy = harness(t);
  fallback.markExhausted(busy.dataDir, { resetsAt: Date.now() + 3600_000 });
  const busyCtl = createTokenPlanFallbackController({
    sessionManager: { getSession: () => busy.session, getNativeSession: () => ({ runtime: { state: 'running', connection: 'connected' } }) },
    dataDir: busy.dataDir, settleMs: 0, logger: { log() {}, warn() {} }, getConfig: () => ({ deepseekApiKey: 'k' }),
    restartSession: async () => { throw new Error('must not restart a running turn'); },
  });
  // 正在答上一轮的 DeepSeek 旧 Harness：不打断；这条留在原线路的队列，下一条再切。
  assert.equal(await busyCtl.beforeSend('s1'), false);
});
