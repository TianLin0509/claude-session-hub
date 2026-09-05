'use strict';
/**
 * 绑定用的 prompt 必须是「原样」的那一份。
 *
 * 这是「codex 答完了、Hub 一直转」的真正根因（B2→B10 十次实测才挖到底）：
 *
 *   main.js 给所有群聊会话开了 requirePromptMatch（`!!session.meetingId`）。
 *   notePrompt 记下的是**实际发给 CLI 的整条 prompt**（含「## 规则 / ## 输出 /
 *   ## 用户」外壳和结尾的「请发言。」）。
 *   而 _tryBind 比对时走的是语义解析服务，它会把外壳剥掉只留内层任务文本。
 *
 *   同一个真实 rollout 实测：原样解析 647 字符、语义解析 406 字符。
 *   两边永远不相等 → **每一个 codex 群聊会话都必然绑不上** → 转录收不到 →
 *   dispatcher 判定没送到 → 整条 prompt 重发（rollout 里两条一模一样的用户消息）→
 *   那一轮的答案 Hub 仍然拿不到，循环挂死。
 *
 * 原始 bug 报告把「指纹匹配失败」列为已排除，依据是「离线重放能 BOUND」——
 * 但离线走的正是本地原样解析这条路，所以那个排除结论是错的。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CodexTap } = require('../core/transcript-tap.js');

let pass = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

console.log('codex-bind-prompt-fidelity');

const ROOT = path.join(os.tmpdir(), 'bind-fidelity-' + Date.now());
const DAY = path.join(ROOT, '2026', '09', '05');
fs.mkdirSync(DAY, { recursive: true });

const CWD = 'C:\\some\\sandbox';
// 真实形态：外壳 + 内层任务
const INNER = '## 角色：执行者\n总目标：修一个空列表崩溃的函数。\n输出：改动、验证、剩余风险。';
const WRAPPED = '## 规则\n- 这里是AI群聊，你是Codex 1。\n\n## 输出\n简单问题直答。\n\n## 用户\n'
  + INNER + '\n\n请发言。';

function writeRollout(name, tsIgnored, userText) {
  // 时间戳必须用当前时刻：绑定有 [-10s, +300s] 的时间窗，写死的日期会直接落窗外
  const ts = new Date().toISOString();
  const p = path.join(DAY, name);
  const lines = [
    JSON.stringify({
      type: 'session_meta',
      payload: { id: name, session_id: name, cwd: CWD, timestamp: ts, source: 'cli', thread_source: 'user' },
    }),
    JSON.stringify({
      timestamp: ts, type: 'event_msg',
      payload: { type: 'user_message', text: userText },
    }),
  ];
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf-8');
  return p;
}

test('原样解析读到的就是发出去的那条（含外壳）', async () => {
  const p = writeRollout('rollout-2026-09-05T10-00-00-fid1.jsonl', '2026-09-05T10:00:00.000Z', WRAPPED);
  const tap = new CodexTap({ pollIntervalMs: 100000 });
  const raw = await tap._readUserMessageEvents(p, { raw: true });
  const texts = raw.map(e => String(e.text || '').trim());
  assert(texts.some(t => t === WRAPPED.trim()),
    '原样解析必须逐字还原发出去的 prompt，实得：' + JSON.stringify(texts.map(t => t.length)));
  tap._stopWatcher();
});

test('语义解析剥掉外壳是它的正常行为，但不能拿来做绑定判据', async () => {
  // 用一个假的解析服务模拟真实那条：只吐内层文本
  const p = writeRollout('rollout-2026-09-05T10-01-00-fid2.jsonl', '2026-09-05T10:01:00.000Z', WRAPPED);
  const tap = new CodexTap({ pollIntervalMs: 100000 });
  tap._parserService = {
    parse: async () => ({ turns: [{ role: 'user', text: INNER, ts: Date.now() }] }),
  };
  const semantic = await tap._readUserMessageEvents(p);
  assert.strictEqual(String(semantic[0].text).trim(), INNER.trim(), '语义解析确实只给内层');
  const raw = await tap._readUserMessageEvents(p, { raw: true });
  assert(String(raw[0].text).trim().length > String(semantic[0].text).trim().length,
    '两者长度必须不同，否则这条测试没意义');
  tap._stopWatcher();
});

test('即使语义解析剥了壳，带外壳的 prompt 仍能绑上（根因回归）', async () => {
  const p = writeRollout('rollout-2026-09-05T10-02-00-fid3.jsonl', '2026-09-05T10:02:00.000Z', WRAPPED);
  const tap = new CodexTap({ pollIntervalMs: 100000 });
  tap._candidateDirs = () => [DAY];
  // 复刻线上：解析服务只吐内层
  tap._parserService = {
    parse: async () => ({ turns: [{ role: 'user', text: INNER, ts: Date.now() }] }),
  };

  let boundTo = null;
  tap._bindRolloutToHubSession = async (sid, rolloutPath) => { boundTo = { sid, rolloutPath }; return true; };

  // 群聊会话：requirePromptMatch 为真（main.js 对所有 meeting 会话都这么设）
  tap.registerSession('sess-1', { cwd: CWD, requirePromptMatch: true });
  // Hub 记下的是**实际发出去的整条**，带外壳
  tap.notePrompt('sess-1', WRAPPED);

  await tap._tryBind(p);
  assert(boundTo, '带外壳的 prompt 必须能绑上 —— 修之前这里必然失败');
  assert.strictEqual(boundTo.sid, 'sess-1');
  tap._stopWatcher();
});

test('指纹校验没被削弱：不相干的 prompt 仍然绑不上', async () => {
  const p = writeRollout('rollout-2026-09-05T10-03-00-fid4.jsonl', '2026-09-05T10:03:00.000Z',
    '## 规则\n完全不相干的另一条 prompt，长度也够长，不该被误绑上去。'.repeat(4));
  const tap = new CodexTap({ pollIntervalMs: 100000 });
  tap._candidateDirs = () => [DAY];
  let boundTo = null;
  tap._bindRolloutToHubSession = async (sid) => { boundTo = sid; return true; };
  tap.registerSession('sess-2', { cwd: CWD, requirePromptMatch: true });
  tap.notePrompt('sess-2', WRAPPED);

  await tap._tryBind(p);
  assert.strictEqual(boundTo, null, '不匹配的 rollout 不能被绑上 —— 放宽保真度不等于放弃校验');
  tap._stopWatcher();
});

(async () => {
  for (const { name, fn } of queue) { await fn(); pass++; console.log('  ✓ ' + name); }
  try { require('child_process').execSync(`cmd /c rmdir /S /Q "${ROOT}"`, { stdio: 'ignore' }); } catch (e) {}
  console.log('\n──────────────');
  console.log('通过 ' + pass + ' / 失败 0');
})().catch((e) => {
  console.error('失败：' + (e && e.stack || e));
  try { require('child_process').execSync(`cmd /c rmdir /S /Q "${ROOT}"`, { stdio: 'ignore' }); } catch (x) {}
  process.exit(1);
});
