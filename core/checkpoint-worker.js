#!/usr/bin/env node
// 圆桌记忆 · checkpoint-worker.js（plan §5.2）
//
// 由主进程 `child_process.fork` 拉起，独立进程跑 ~3-5s，0 阻塞圆桌主流程。
//
// 职责：
//   1. 读 timeline.md 末 200 行（圆桌上下文）
//   2. 读三家 individual .md (store.loadEntries)
//   3. 读当前 _profile.md
//   4. 调 DeepSeek v4-pro / chat（带反固化约束 prompt §5.5）
//   5. 解析 JSON 响应 → keep/evict/add 三清单 + 三家 pending 候选
//   6. 应用到 _profile.md（profile.applyTrioUpdate）
//   7. 写 pending-{slot}.json（inbox.appendCandidates）
//   8. reconcile（根据个体 .md 把 pending 标 accepted/expired）
//   9. 更新 checkpoint-state.json（markCheckpoint / markFailure）
//   10. 删 .checkpoint.lock + exit
//
// 启动参数（env）：
//   ARENA_CHECKPOINT_PROJECT_CWD
//   ARENA_CHECKPOINT_SCENE
//   ARENA_CHECKPOINT_TURN
//   ARENA_CHECKPOINT_IDENTITIES  (Phase 3：逗号分隔 identity 列表，如 'claude-opus-4-7,gemini-3-pro,codex-gpt-5-2'；
//                                 缺省时由 store.listAllIdentities 扫 memDir 派生 — 兼容路径)
//   DEEPSEEK_API_KEY (从父进程透传)
//
// stdout 输出 progress JSON line，主进程可监听（IPC fork 时直接走 process.send）

'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_CWD = process.env.ARENA_CHECKPOINT_PROJECT_CWD || '';
const SCENE = process.env.ARENA_CHECKPOINT_SCENE || 'general';
const TURN = process.env.ARENA_CHECKPOINT_TURN || null;
// Phase 3：env 优先；否则空（main.main 里会调 listAllIdentities 扫 memDir）
const IDENTITIES_FROM_ENV = (process.env.ARENA_CHECKPOINT_IDENTITIES || '').split(',').map(s => s.trim()).filter(Boolean);

const memoryStore = require('./roundtable-memory/store.js');
const profile = require('./roundtable-memory/profile.js');
const inbox = require('./roundtable-memory/inbox.js');
const ckptState = require('./roundtable-memory/checkpoint-state.js');
const { DeepSeekProvider } = require('./summary-providers/deepseek-api.js');
const { loadConfig: loadDsConfig } = require('./deep-summary-config.js');
const { getConfig: getHubConfig } = require('./hub-config.js');

function log(level, msg, extra = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, level, msg, ...extra });
  if (process.send) {
    try { process.send({ type: 'log', level, msg, ...extra }); } catch {}
  }
  process.stderr.write(line + '\n');
}

// [Bug 10 fix · v2 P1 + Bug 12 fix · v3 P1] 通过 IPC 让主进程串行化写 state。
// Bug 12 修复：process.send 后必须等 callback（消息送达 IPC 通道才安全 exit）；
// 否则 worker 立即 exit 可能让 IPC buffer 内消息丢失，主进程错过 markCheckpoint
// → state 永不重置 → cooldown 阻止后续触发 → checkpoint 永久卡死。
function reportCheckpointDone(turn, startCount) {
  return new Promise((resolve) => {
    if (process.send) {
      try {
        process.send({ type: 'markCheckpoint', turn, startCount }, (err) => {
          if (err) {
            // IPC 发送失败 → 本地写（fallback；race 概率极低 + 已知降级）
            try { ckptState.markCheckpoint(PROJECT_CWD, SCENE, turn, { startCount }); } catch {}
          }
          resolve();
        });
        return;
      } catch (e) {
        // process.send throw（罕见，IPC 已断）→ fallback
      }
    }
    try { ckptState.markCheckpoint(PROJECT_CWD, SCENE, turn, { startCount }); } catch {}
    resolve();
  });
}
// [Bug 19 fix · v4 P2 · Codex] IPC callback err fallback 路径会被主进程 exit handler 又
// markFailure 一次（双倍累加）。修复：worker 本地写后再写 sidecar marker，主进程 exit handler
// 检查 sidecar 决定是否兜底。
function _failureSidecarPath() {
  return path.join(PROJECT_CWD, '.arena', 'rooms', SCENE, '.checkpoint.failure-reported');
}

// worker 启动时清旧 sidecar（防上次失败的 sidecar 被本次 worker 误用）
(function _cleanupStaleSidecar() {
  try {
    const fp = _failureSidecarPath();
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch {}
})();
// [Bug 20 fix · v5 P1] sidecar 内容含 lockToken；主进程 exit handler 读取时校验 token
//   匹配本次 run 才认（防上次残留）。此外 sidecar 用 tmp+rename 原子写防硬件异常空文件。
function _writeSidecarAtomic(content) {
  const fp = _failureSidecarPath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = fp + '.tmp.' + process.pid + '.' + Date.now();
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, fp);
}
function reportCheckpointFailure(reason) {
  return new Promise((resolve) => {
    const sidecarPayload = JSON.stringify({ reason, at: new Date().toISOString(), token: LOCK_TOKEN });
    if (process.send) {
      try {
        process.send({ type: 'markFailure', reason }, (err) => {
          if (err) {
            // IPC callback 报错（罕见：主进程 IPC 已断）→ 本地 fallback + 写 sidecar 通知 exit handler
            try { ckptState.markFailure(PROJECT_CWD, SCENE, reason); } catch {}
            try { _writeSidecarAtomic(sidecarPayload); } catch {}
          }
          resolve();
        });
        return;
      } catch (e) {}
    }
    // 完全没 IPC（直接 node 跑测试场景）— 本地写 + sidecar 也写（一致性）
    try { ckptState.markFailure(PROJECT_CWD, SCENE, reason); } catch {}
    try { _writeSidecarAtomic(sidecarPayload); } catch {}
    resolve();
  });
}

function lockFilePath() {
  return path.join(PROJECT_CWD, '.arena', 'rooms', SCENE, '.checkpoint.lock');
}

// [Bug 6 fix · 多路评审 P2] worker 通过 ARENA_CHECKPOINT_LOCK_TOKEN env 拿到 owner token，
// 释放 lock 前比对 token，只删自己的（防 stale worker 误删新 worker 锁）。
const LOCK_TOKEN = process.env.ARENA_CHECKPOINT_LOCK_TOKEN || '';
function removeLock() {
  const fp = lockFilePath();
  try {
    if (!fs.existsSync(fp)) return;
    if (LOCK_TOKEN) {
      try {
        const content = JSON.parse(fs.readFileSync(fp, 'utf-8'));
        if (content && content.token && content.token !== LOCK_TOKEN) return; // 不是我的 lock
      } catch { /* parse 失败就直接删（旧格式兼容） */ }
    }
    fs.unlinkSync(fp);
  } catch {}
}

// ---- Timeline 末 200 行（圆桌共享上下文）----
function readTimelineTail(meetingProjectCwd) {
  // timeline 文件名形如 timeline-<meetingId>.md，但 worker 只知道 projectCwd 不知道 meetingId
  // 读 .arena/timeline-*.md 中最新修改的那个
  const arenaDir = path.join(meetingProjectCwd, '.arena');
  if (!fs.existsSync(arenaDir)) return '';
  const candidates = fs.readdirSync(arenaDir)
    .filter(f => /^timeline-.*\.md$/.test(f) && !/-archive\.md$/.test(f))
    .map(f => ({ f, mtime: fs.statSync(path.join(arenaDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) return '';
  const fp = path.join(arenaDir, candidates[0].f);
  const text = fs.readFileSync(fp, 'utf-8');
  const lines = text.split(/\r?\n/);
  return lines.slice(-200).join('\n');
}

// ---- DeepSeek 派生 prompt（plan §5.5 + 反固化约束 + Phase 3 identity）----
// Phase 3：参与者按 identity 而非 slot 标识（同一 AI 跨 meeting 延续，跨模型隔离）
function buildDerivePrompt({ timelineTail, individualByIdentity, profileEntries }) {
  const identities = Object.keys(individualByIdentity || {});
  const pendingExample = identities.slice(0, 3).map(id =>
    `    "${id}": [{ "kind": "preference", "key": "...", "content": "...", "reason": "..." }]`
  ).join(',\n');

  const system = `你是圆桌共识层提炼器。下面是 N 家 AI（每家是独立模型身份）对同一用户的最新记忆 + 圆桌讨论上下文。

任务：
1. 找出至少 2 家共现的稳定偏好/规则 → 输出 _profile.md 更新
2. 检测每家的"漏记"（在多家行为/讨论中出现但该家自己没记） → 输出 pending 候选

【严格禁止纳入 _profile / pending 的内容】
- 单轮讨论结论（如"今天倾向方案 A"、"看好茅台估值"）
- 临时投资立场或市场判断
- 具体话题的具体决策
- 仅出现 1 次的观察

【允许纳入的内容】
- 协作偏好（"喜欢结论先行"、"不喜欢复读"）
- 稳定表达偏好（"用户喜欢被反对"）
- 多次重复的长期画像（"用户偏务实"）
- 场景规则（"通用 vs 投研记忆隔离"）

输出严格 JSON（pending 的 key 必须严格匹配下面"AI 身份"列表中的 identity 字符串）：
{
  "profile_keep":  ["preference:foo", "fact:bar"],
  "profile_evict": ["observation:obsolete"],
  "profile_add":   [
    { "key": "preference:conclusion-first", "content": "用户喜欢结论先行", "persisted": false }
  ],
  "pending": {
${pendingExample || '    "<identity>": []'}
  }
}

注意：
- profile_add 的 key 必须含 "kind:" 前缀（如 "preference:foo"），与 keep/evict 保持一致
- pending key 是 AI 身份字符串（如 'claude-opus-4-7'），**不是 'pikachu/charmander/squirtle'**
- pending.<identity>.kind 必须是 preference|fact|observation|persisted 之一
- 候选只针对该 identity 自己漏记的内容
- 不确定就少输出，宁缺毋滥`;

  const profileText = profileEntries.length > 0
    ? profileEntries.map(e => `${e.persisted ? '[persisted] ' : ''}${e.key}: ${e.content} (recall:${e.recall || 0})`).join('\n')
    : '(空)';
  const identitySections = Object.entries(individualByIdentity).map(([identity, entries]) => {
    const list = entries.length > 0
      ? entries.map(e => `- ${e.key}: ${e.content}`).join('\n')
      : '(无 entry)';
    return `### ${identity}\n${list}`;
  }).join('\n\n');

  const user = `## 当前 _profile.md（共识层）
${profileText}

## 各家 AI 个体记忆（按 identity）
${identitySections}

## 圆桌讨论上下文（timeline 末 200 行）
${timelineTail || '(无 timeline)'}

请按上述要求输出 JSON。`;

  return { system, user };
}

// ---- DeepSeek JSON 鲁棒解析（Bug 3 fix · 多路评审 P1）----
// LLM 偶尔输出 ```json {...} ``` 或前后含解释文字。
// 1) 去掉 code fence；2) 提取最外层 {...}；3) JSON.parse；失败抛
function parseDeepSeekJson(raw) {
  if (typeof raw !== 'string') throw new Error('raw not string');
  let s = raw.trim();
  // 去 markdown code fence
  s = s.replace(/^```(?:json|JSON)?\s*/, '').replace(/\s*```\s*$/, '');
  // 直接尝试解析
  try { return JSON.parse(s); } catch {}
  // 提取最外层 {...}（最早 { 到最晚 }）
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const candidate = s.slice(first, last + 1);
    try { return JSON.parse(candidate); }
    catch (e) { throw new Error(`outer-brace extract failed: ${e.message}`); }
  }
  throw new Error('no JSON object found in DeepSeek output');
}

// pending 候选 schema 校验：返回过滤后只含 valid 项的数组
const VALID_KINDS = new Set(['preference', 'fact', 'observation', 'persisted']);
function sanitizePendingCandidates(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(c => {
    if (!c || typeof c !== 'object') return false;
    if (typeof c.key !== 'string' || !c.key.trim()) return false;
    if (typeof c.content !== 'string' || !c.content.trim()) return false;
    // kind 缺省为 preference；越界值丢弃
    if (c.kind != null && !VALID_KINDS.has(c.kind)) return false;
    return true;
  });
}

// ---- DeepSeek 调用 ----
async function callDeepSeek(prompts) {
  const dsConfig = loadDsConfig();
  const hubConfig = getHubConfig();
  const apiKey = hubConfig.deepseekApiKey || process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY missing (env or hub-config)');
  // 临时写 secrets 到 tmpfile（DeepSeekProvider 用 readSecret 模式）
  // 简化：构造一个无 secrets_file 的版本，直接 patch readSecret 不可行——
  // DeepSeekProvider 调 readSecret(secrets_file, secrets_key)。我们 mock 一个 secrets file。
  const tmpSecrets = path.join(require('os').tmpdir(), `arena-ckpt-secrets-${process.pid}.txt`);
  fs.writeFileSync(tmpSecrets, `DEEPSEEK_API_KEY = "${apiKey}"\n`, { mode: 0o600 });
  try {
    const provider = new DeepSeekProvider({
      model: dsConfig.deepseek_api.model,
      endpoint: dsConfig.deepseek_api.endpoint,
      timeout_ms: dsConfig.deepseek_api.timeout_ms || 60000,
      max_retries: 1,
      secrets_file: tmpSecrets,
      secrets_key: 'DEEPSEEK_API_KEY',
    });
    const r = await provider.call({ system: prompts.system, user: prompts.user });
    return r.raw;
  } finally {
    try { fs.unlinkSync(tmpSecrets); } catch {}
  }
}

// ---- 主流程 ----
async function main() {
  if (!PROJECT_CWD) {
    log('error', 'ARENA_CHECKPOINT_PROJECT_CWD missing, abort');
    removeLock();
    process.exit(2);
  }

  log('info', 'worker start', { projectCwd: PROJECT_CWD, scene: SCENE, turn: TURN });

  // [Bug 2 fix · 多路评审 P0] 记 worker 启动时 user_msg_count 快照，markCheckpoint 时减它
  //   保留主进程在 worker 跑期间 bump 的部分，避免计数丢失。
  const startState = ckptState.readState(PROJECT_CWD, SCENE);
  const startUserMsgCount = startState.last_user_msg_count || 0;

  // Phase 3：identity 列表 — env 优先（main.js 注入当前 meeting 三家），否则扫 memDir
  let IDENTITIES = IDENTITIES_FROM_ENV.slice();
  if (IDENTITIES.length === 0) {
    IDENTITIES = memoryStore.listAllIdentities(PROJECT_CWD, SCENE);
  }
  if (IDENTITIES.length === 0) {
    log('warn', 'no identities found in memDir; deepseek will get empty individual sections');
  }

  // 1. 读 N 家 individual（按 identity）
  const individualByIdentity = {};
  for (const id of IDENTITIES) {
    individualByIdentity[id] = memoryStore.loadEntries(PROJECT_CWD, SCENE, id);
  }
  // 2. 读 _profile.md
  const profileData = profile.readProfile(PROJECT_CWD, SCENE);
  // 3. 读 timeline tail
  const timelineTail = readTimelineTail(PROJECT_CWD);
  log('info', 'inputs loaded', {
    timelineTailChars: timelineTail.length,
    individualEntries: Object.fromEntries(IDENTITIES.map(id => [id, individualByIdentity[id].length])),
    profileEntries: profileData.entries.length,
  });

  // 4. 调 DeepSeek
  const prompts = buildDerivePrompt({ timelineTail, individualByIdentity, profileEntries: profileData.entries });
  let rawJson;
  try {
    rawJson = await callDeepSeek(prompts);
  } catch (e) {
    log('error', 'DeepSeek call failed', { error: e.message });
    await reportCheckpointFailure('deepseek: ' + e.message);
    removeLock();
    process.exit(3);
  }

  // 5. 解析 JSON（Bug 3 fix · 多路评审 P1）
  //   strip 三种 fence: ```json ... ``` / ``` ... ``` / 前后裸 garble；
  //   再提取最外层 {...}（防 LLM 在 JSON 前后多嘴）。
  let parsed;
  try {
    parsed = parseDeepSeekJson(rawJson);
  } catch (e) {
    log('error', 'DeepSeek raw not JSON after sanitize', { raw: rawJson.slice(0, 300), error: e.message });
    await reportCheckpointFailure('parse: ' + e.message);
    removeLock();
    process.exit(4);
  }

  // 6. 应用 profile 更新（schema 校验 + 坏项过滤，Bug 3 fix 续）
  const trio = {
    keep:  Array.isArray(parsed.profile_keep)  ? parsed.profile_keep.filter(k => typeof k === 'string' && k.includes(':')) : [],
    evict: Array.isArray(parsed.profile_evict) ? parsed.profile_evict.filter(k => typeof k === 'string' && k.includes(':')) : [],
    add:   Array.isArray(parsed.profile_add)   ? parsed.profile_add
      .filter(e => e && typeof e === 'object' && typeof e.key === 'string' && e.key.includes(':') && typeof e.content === 'string' && e.content.trim())
      .map(e => ({ ...e, persisted: !!e.persisted, content: String(e.content).trim() }))
      : [],
  };
  let profileResult;
  try {
    profileResult = profile.applyTrioUpdate(PROJECT_CWD, SCENE, trio, TURN);
    log('info', 'profile updated', { entryCount: profileResult.finalEntries.length, file: profileResult.filePath });
  } catch (e) {
    log('error', 'profile.applyTrioUpdate failed', { error: e.message });
    await reportCheckpointFailure('profile: ' + e.message);
    removeLock();
    process.exit(5);
  }

  // 7. 写 pending（每家 identity，schema 校验后，Bug 3 fix 续）
  // Phase 3：pending 的 key 按 identity 索引（DeepSeek 输出已要求按 identity 字符串）
  const pendingByIdentity = (parsed.pending && typeof parsed.pending === 'object' && !Array.isArray(parsed.pending)) ? parsed.pending : {};
  // [Phase 3 silent-failure-hunt] LLM 偶尔会用旧 slot 名（pikachu/charmander/squirtle）做 pending key。
  //   不警告会让所有候选 silent drop（lookup miss → []，无 dropped 日志）。
  const unknownKeys = Object.keys(pendingByIdentity).filter(k => !IDENTITIES.includes(k));
  if (unknownKeys.length > 0) {
    log('warn', 'pending keys do not match any identity — LLM may have used old slot names or unknown identity strings', {
      unknownKeys, identities: IDENTITIES,
    });
  }
  let totalAdded = 0, totalMerged = 0, totalDropped = 0;
  for (const identity of IDENTITIES) {
    const rawCandidates = Array.isArray(pendingByIdentity[identity]) ? pendingByIdentity[identity] : [];
    const candidates = sanitizePendingCandidates(rawCandidates);
    const dropped = rawCandidates.length - candidates.length;
    if (dropped > 0) {
      log('warn', 'pending candidates dropped (schema invalid)', { identity, dropped, kept: candidates.length });
      totalDropped += dropped;
    }
    if (candidates.length === 0) continue;
    const r = inbox.appendCandidates(PROJECT_CWD, SCENE, identity, candidates, TURN);
    totalAdded += r.added;
    totalMerged += r.merged;
    log('info', 'pending appended', { identity, added: r.added, merged: r.merged });
  }

  // 8. Reconcile（基于当前个体 .md 标 accepted/expired）
  // [Bug 5 fix · 多路评审 P2] 重新 loadEntries（worker 跑 5s 期间 AI 可能调 memory_write 写新 entry）
  for (const identity of IDENTITIES) {
    const freshEntries = memoryStore.loadEntries(PROJECT_CWD, SCENE, identity);
    const r = inbox.reconcile(PROJECT_CWD, SCENE, identity, freshEntries);
    if (r.accepted || r.expired) log('info', 'reconcile', { identity, ...r });
  }

  // 9. 标记 checkpoint（[Bug 10+12 fix · v2/v3 P1] IPC 上报让主进程串行化写 state；
  //    必须 await 等 IPC callback 才能 process.exit，否则消息会丢失）
  await reportCheckpointDone(TURN, startUserMsgCount);

  // 10. 清 lock + exit
  removeLock();
  log('info', 'worker done', { totalAdded, totalMerged, profileEntries: profileResult.finalEntries.length });
  process.exit(0);
}

// 暴露 pure helpers 供单测使用（require 时不跑 main）
module.exports = {
  buildDerivePrompt,
  readTimelineTail,
  parseDeepSeekJson,
  sanitizePendingCandidates,
  VALID_KINDS,
};

// 直接 node core/checkpoint-worker.js 时跑（fork 时也走此路径）
if (require.main === module) {
  main().catch(async e => {
    log('error', 'unhandled', { error: e.stack || e.message });
    try { await reportCheckpointFailure('unhandled: ' + e.message); } catch {}
    removeLock();
    process.exit(1);
  });
}
