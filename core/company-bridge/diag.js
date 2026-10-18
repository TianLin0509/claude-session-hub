'use strict';
// 直查通道（2026-10-18 田哥：「AI HUB 信息、电脑信息等，是否也可以不通过 codeagent，而直接通过脚本读取 + 压缩来完成？……减少排队，给出另一种通道」）。
// 对端发 hub-admin op:'diag'（带 sections），这台 Hub 的主进程直接用系统接口和自己的状态收集信息，
// JSON → gzip → base64url 放进一条 hub-admin-status（phase:'diag'）报回：不开 CodeAgent 会话、不占并行名额、不排队。
//
// 段落（各自 try/catch，一段失败只在该段写原因）：
//   machine   内存总量/可用/占用率、CPU 占用（一次 0.5 秒采样）、开机时长、C/D 盘剩余；
//   processes 按内存排前 20 的进程；CodeAgent 进程数与总内存、Hub 自身（主进程 + 渲染进程 + 隐藏窗口）总内存、
//             不在当前 Hub 进程树里的 CodeAgent / node / electron（重启残留嫌疑）单列；
//   hub       版本、启动时间、并行状态、通道队列快照、Hub 里的会话（用途、状态、最后活动、PID 与内存）；
//   pool      号池各号状态与模型，只用「个人 / 号 1 / 号 2」代称；
//   logs      通道日志、会话收放日志、Hub 窗口事件日志的最后 N 行（脱敏）。
// 底线：只读；不读源码，不回传文件内容（日志尾部除外，已脱敏）；sections 只认白名单，不执行对端传来的任何命令。
// 回报整条消息（HTTP 正文 {to,mid,blob}）严格小于 60000 字节：超了按段降级（先截日志，再把进程截到前 10……），始终一条发完。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const SECTIONS = ['machine', 'processes', 'hub', 'pool', 'logs'];
const SECTION_LABEL = { machine: '电脑', processes: '进程', hub: 'Hub 状态与队列', pool: '号池', logs: '日志' };
const MIN_INTERVAL_MS = 30000;
const MESSAGE_LIMIT = 60000;
const MESSAGE_MARGIN = 400; // 量的是发前那一份，真正发出时编号、时间戳的位数可能略有不同
const PROCESS_TIMEOUT_MS = 15000;
const DEFAULT_LOG_LINES = 80;
const MAX_LOG_LINES = 200;
const LOG_LINE_CHARS = 400;
const LOG_TAIL_BYTES = 256 * 1024;
const TOP_N = 20;
const MAX_LEFTOVERS = 30;
const MAX_SESSIONS = 60;
const DECODE_LIMIT = 4 * 1024 * 1024;
const LOGS = [
  { key: 'bridge', label: '通道日志', file: 'company-bridge.log' },
  { key: 'care', label: '会话收放日志', file: 'company-session-care.log' },
  { key: 'window', label: 'Hub 主日志（窗口事件）', file: 'window-events.log' },
];
const POOL_STATE = { ready: '可用', 'login-required': '需登录', expired: '登录过期', unreadable: '凭证读不到' };

const mb = bytes => Math.round((Number(bytes) || 0) / 1048576);
const gb = bytes => Math.round((Number(bytes) || 0) / 1073741824 * 10) / 10;
const short = (s, n = 60) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const errText = error => short(error && error.message || error, 200);

// ---- 段落白名单 ----
function parseSections(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' && raw.trim() ? raw.split(/[,，\s]+/) : [];
  const picked = [], ignored = [];
  for (const item of list) {
    const s = String(item || '').trim().toLowerCase();
    if (!s) continue;
    if (SECTIONS.includes(s)) { if (!picked.includes(s)) picked.push(s); } else if (ignored.length < 10) ignored.push(short(s, 20));
  }
  return { sections: picked.length ? SECTIONS.filter(s => picked.includes(s)) : [...SECTIONS], ignored };
}
function parseLines(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? Math.min(MAX_LOG_LINES, n) : DEFAULT_LOG_LINES;
}

// ---- 编解码 ----
function encode(obj) { return zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf8'), { level: 9 }).toString('base64url'); }
function decode(text, { maxBytes = DECODE_LIMIT } = {}) {
  const raw = Buffer.from(String(text || ''), 'base64url');
  if (!raw.length) throw new Error('回报内容为空');
  return JSON.parse(zlib.gunzipSync(raw, { maxOutputLength: maxBytes }).toString('utf8'));
}

// ---- 脱敏：号身份（复用 company.js scrubText）、口令/令牌样式、配对码、网址、本机用户名与用户目录 ----
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function makeRedactor({ scrub = s => s, home = os.homedir(), user = safeUser(), extra = [] } = {}) {
  const words = [...new Set(extra.map(String).filter(s => s.length >= 4))].sort((a, b) => b.length - a.length);
  return text => {
    let s = String(text ?? '');
    try { s = scrub(s); } catch { /* 号身份读不到时按下面的样式规则换 */ }
    for (const w of words) s = s.split(w).join('<已隐去>');
    s = s.replace(/AIHUB-LINK-1\.[A-Za-z0-9_-]+/g, 'AIHUB-LINK-1.<已隐去>')
      .replace(/https?:\/\/[^\s'"<>]+/gi, '<网址>')
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <已隐去>')
      .replace(/((?:pass(?:word|wd)?|pwd|token|secret|api[_-]?key|access[_-]?key|authorization|cookie|credential|口令|密码|密钥|令牌)["']?\s*[:=：]\s*["']?)[^\s"',;，；]+/gi, '$1<已隐去>')
      .replace(/\b(?:sk|ghp|gho|ghs|github_pat|xox[abpr])[-_][A-Za-z0-9_-]{10,}/g, '<已隐去>')
      .replace(/[A-Za-z0-9_+-]{32,}={0,2}/g, m => (UUID.test(m) || !/[0-9]/.test(m) || !/[A-Za-z]/.test(m)) ? m : '<已隐去>');
    if (home && home.length > 3) s = s.split(home).join('%USERPROFILE%').split(home.replace(/\\/g, '/')).join('%USERPROFILE%');
    if (user && user.length >= 4) s =s.replace(new RegExp(user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<USER>');
    return s;
  };
}
function safeUser() { try { return os.userInfo().username || ''; } catch { return ''; } }
// 结果里所有字符串都过一遍（标题、说明、日志）；数字和布尔原样。
function deepRedact(value, redact, depth = 0) {
  if (typeof value === 'string') return redact(value);
  if (!value || typeof value !== 'object' || depth > 12) return value;
  if (Array.isArray(value)) return value.map(v => deepRedact(v, redact, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = deepRedact(v, redact, depth + 1);
  return out;
}

// ---- 系统接口（测试换成夹具）----
function defaultSys() {
  return {
    os,
    statfs: dir => fs.statfsSync(dir),
    processSnapshot: () => require('../process-inspector').createProcessInspector({ timeoutMs: PROCESS_TIMEOUT_MS, ttlMs: 2000, logger: { warn() {} } }).snapshot({ force: true }),
    tail: (file, bytes) => {
      const fd = fs.openSync(file, 'r');
      try {
        const size = fs.fstatSync(fd).size, len = Math.min(size, bytes), buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        return { text: buf.toString('utf8'), size, mtimeMs: fs.fstatSync(fd).mtimeMs };
      } finally { fs.closeSync(fd); }
    },
    mtime: file => fs.statSync(file).mtimeMs,
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    drives: () => process.platform === 'win32' ? ['C:\\', 'D:\\'] : ['/'],
    clock: () => Date.now(),
  };
}

// ---- machine ----
function cpuTimes(cpus) {
  let idle = 0, total = 0;
  for (const c of cpus || []) { const t = c.times || {}; idle += t.idle || 0; total += (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.irq || 0) + (t.idle || 0); }
  return { idle, total };
}
async function machine(sys) {
  const total = sys.os.totalmem(), free = sys.os.freemem();
  const before = cpuTimes(sys.os.cpus());
  await sys.sleep(500);
  const cpus = sys.os.cpus(), after = cpuTimes(cpus);
  const dt = after.total - before.total;
  const disks = [];
  for (const dir of sys.drives()) {
    const drive = dir.replace(/[\\/]+$/, '') || dir;
    try {
      const st = sys.statfs(dir), size = Number(st.blocks) * Number(st.bsize), avail = Number(st.bavail) * Number(st.bsize);
      disks.push({ drive, totalGB: gb(size), freeGB: gb(avail), freePct: size > 0 ? Math.round(avail / size * 100) : null });
    } catch (error) { disks.push({ drive, error: error.code === 'ENOENT' ? '没有这个盘' : errText(error) }); }
  }
  return {
    memory: { totalMB: mb(total), freeMB: mb(free), usedPct: total > 0 ? Math.round((1 - free / total) * 100) : null, freePct: total > 0 ? Math.round(free / total * 100) : null },
    cpu: { cores: cpus.length, model: short(cpus[0]?.model || '', 60), busyPct: dt > 0 ? Math.round((1 - (after.idle - before.idle) / dt) * 100) : null, sampleMs: 500 },
    uptimeHours: Math.round(sys.os.uptime() / 360) / 10,
    os: `${sys.os.platform()} ${sys.os.release()}`,
    disks,
  };
}

// ---- processes ----
const CODEAGENT = /codeagent/i;
function processHint(cmd) {
  const c = String(cmd || '');
  if (CODEAGENT.test(c)) return /\bserve\b/i.test(c) ? 'CodeAgent（serve）' : 'CodeAgent';
  if (/claude-session-hub|aigroupchathub|ai hub/i.test(c)) return 'AI Hub';
  if (/[\\/]_npx[\\/]/i.test(c)) return 'npx 临时工具';
  if (/\bmcp\b|mcp[-_]/i.test(c)) return 'MCP 服务';
  if (/--type=/.test(c)) return 'Electron 子进程';
  return '';
}
// 进程快照 + 会话 PTY 的 PID → 分类与汇总。纯函数，单测直接喂夹具。
function analyzeProcesses(snap, { hubPid, hubExe, sessionPids = [], top = TOP_N, now = Date.now() } = {}) {
  const { realParent, subtreePids } = require('../process-reclaim');
  const { buildChildrenMap } = require('../process-inspector');
  const list = (snap.processes || []).filter(p => p && p.pid > 0);
  const byPid = new Map(list.map(p => [p.pid, p]));
  const children = snap.childrenMap || buildChildrenMap(list);
  const hubTree = byPid.has(hubPid) ? subtreePids(hubPid, children, byPid) : new Set();
  const exe = String(hubExe || '').toLowerCase();
  const isHubCore = p => p.pid === hubPid || (hubTree.has(p.pid) && String(p.name || '').toLowerCase() === exe);
  const isCodeAgent = p => !isHubCore(p) && (CODEAGENT.test(p.name || '') || CODEAGENT.test(p.cmd || ''));
  // 每个会话的 PTY 进程树：会话编号、内存
  const owner = new Map(), sessions = new Map();
  for (const { id, pid } of sessionPids) {
    if (!id || !byPid.has(Number(pid))) continue;
    const tree = subtreePids(Number(pid), children, byPid);
    let ws = 0, count = 0, codeAgent = 0;
    for (const x of tree) { const p = byPid.get(x); if (!p || owner.has(x)) continue; owner.set(x, id); ws += p.wsBytes || 0; count += 1; if (isCodeAgent(p)) codeAgent += 1; }
    sessions.set(id, { pid: Number(pid), memMB: mb(ws), processes: count, codeAgent });
  }
  const family = p => {
    const n = String(p.name || '').toLowerCase();
    if (isCodeAgent(p)) return 'codeagent';
    if (n === exe || n === 'aigroupchathub.exe') return 'hub';
    if (n === 'electron.exe') return 'electron';
    if (n === 'node.exe' || n === 'node') return 'node';
    return null;
  };
  const sum = arr => arr.reduce((a, p) => a + (p.wsBytes || 0), 0);
  const hubCore = list.filter(isHubCore), codeAgents = list.filter(isCodeAgent);
  const sessionProcs = list.filter(p => owner.has(p.pid));
  // 另一个还活着的 Hub 主进程（树外、不是 --type= 子进程）：它下面的进程归它，不算残留；它自己单列（另一个实例，或重启时没退出的旧主进程）。
  const { isHubProcess } = require('../process-reclaim');
  const isHubMain = p => !hubTree.has(p.pid) && !/--type=/.test(String(p.cmd || '')) && (String(p.name || '').toLowerCase() === exe || isHubProcess(p));
  const { ancestorChain } = require('../process-reclaim');
  const otherHubOf = p => ancestorChain(p, byPid).find(isHubMain) || null;
  const otherHub = new Map(); // 主进程 PID → 子进程数与内存
  for (const p of list) {
    if (hubTree.has(p.pid)) continue;
    const root = otherHubOf(p);
    if (!root) continue;
    const o = otherHub.get(root.pid) || { count: 0, ws: 0 };
    o.count += 1; o.ws += p.wsBytes || 0; otherHub.set(root.pid, o);
  }
  // CodeAgent 残留最可疑，排最前；同类按内存。
  const rank = { codeagent: 0, hub: 1, electron: 2, node: 3 };
  const leftovers = list.filter(p => !hubTree.has(p.pid) && family(p) && !otherHubOf(p)).sort((a, b) => (rank[family(a)] - rank[family(b)]) || ((b.wsBytes || 0) - (a.wsBytes || 0)));
  const row = p => ({ name: p.name, pid: p.pid, ppid: p.ppid || 0, memMB: mb(p.wsBytes), privMB: mb(p.privBytes), startedAt: p.startedAt || null,
    hub: hubTree.has(p.pid), hubCore: isHubCore(p), codeAgent: isCodeAgent(p), session: owner.has(p.pid) ? String(owner.get(p.pid)).slice(0, 8) : null,
    leftover: !hubTree.has(p.pid) && !!family(p) });
  return {
    sampledAt: snap.sampledAt || now, total: list.length, hubPid, hubFound: byPid.has(hubPid),
    summary: {
      codeAgent: { count: codeAgents.length, memMB: mb(sum(codeAgents)), inHub: codeAgents.filter(p => hubTree.has(p.pid)).length, outside: codeAgents.filter(p => !hubTree.has(p.pid)).length },
      hubSelf: { count: hubCore.length, memMB: mb(sum(hubCore)) },
      hubSessions: { sessions: sessions.size, processes: sessionProcs.length, memMB: mb(sum(sessionProcs)) },
      hubTree: { count: hubTree.size, memMB: mb(sum(list.filter(p => hubTree.has(p.pid)))) },
      leftovers: { count: leftovers.length, memMB: mb(sum(leftovers)) },
      otherHubs: { count: otherHub.size, processes: [...otherHub.values()].reduce((a, o) => a + o.count, 0), memMB: mb([...otherHub.values()].reduce((a, o) => a + o.ws, 0)) },
    },
    top: [...list].sort((a, b) => (b.wsBytes || 0) - (a.wsBytes || 0)).slice(0, top).map(row),
    leftovers: leftovers.slice(0, MAX_LEFTOVERS).map(p => ({ name: p.name, pid: p.pid, ppid: p.ppid || 0, memMB: mb(p.wsBytes), startedAt: p.startedAt || null,
      ageMin: p.startedAt ? Math.max(0, Math.round((now - p.startedAt) / 60000)) : null, kind: family(p), parentAlive: !!realParent(p, byPid),
      hint: isHubMain(p) ? `AI Hub 主进程（另一个实例或没退出的旧进程${otherHub.get(p.pid) ? `，下面还有 ${otherHub.get(p.pid).count} 个进程共 ${mb(otherHub.get(p.pid).ws)} MB` : ''}）` : processHint(p.cmd) })),
    sessions,
  };
}

// ---- 号池代称：个人 / 号 1 / 号 2（号池登记顺序），不带编号、工号掩码、备注 ----
function poolAliases(raw) {
  const map = new Map([['personal', '个人']]);
  (raw?.accounts || []).forEach((a, i) => { if (a && a.id) map.set(a.id, `号 ${i + 1}`); });
  return map;
}
function pool(raw, extra = {}) {
  if (!raw) throw new Error('这台 Hub 读不到号池');
  const aliases = poolAliases(raw);
  const pick = (a, alias) => ({ alias, state: POOL_STATE[a.state] || String(a.state || '未知'), ready: a.state === 'ready',
    activeSessions: Number(a.activeSessions) || 0, defaultModel: a.defaultModel ? String(a.defaultModel) : '', models: (Array.isArray(a.models) ? a.models : []).map(String).slice(0, 20),
    ...(a.modelsProbedAt ? { modelsProbedAt: a.modelsProbedAt } : {}), ...(a.duplicateOf ? { duplicate: true } : {}), ...(a.sameAsPersonal ? { sameAsPersonal: true } : {}),
    ...(a.routeSwitched ? { routeSwitched: true } : {}) });
  const accounts = [];
  if (raw.personal) accounts.push(pick(raw.personal, '个人'));
  for (const a of raw.accounts || []) accounts.push(pick(a, aliases.get(a.id)));
  return { accounts, ready: accounts.filter(a => a.ready).length, ...extra };
}

// ---- logs ----
function logs(sys, dir, lines) {
  const out = [];
  for (const spec of LOGS) {
    try {
      const { text, size, mtimeMs } = sys.tail(path.join(dir, spec.file), LOG_TAIL_BYTES);
      const all = String(text).split(/\r?\n/).filter(Boolean);
      if (size > LOG_TAIL_BYTES) all.shift(); // 从中间截的第一行不完整
      out.push({ key: spec.key, label: spec.label, file: spec.file, sizeKB: Math.round(size / 1024), mtime: mtimeMs || null, totalLines: all.length,
        lines: all.slice(-lines).map(l => l.length > LOG_LINE_CHARS ? l.slice(0, LOG_LINE_CHARS) + '…' : l) });
    } catch (error) { out.push({ key: spec.key, label: spec.label, file: spec.file, error: error.code === 'ENOENT' ? '还没有这份日志' : errText(error) }); }
  }
  return { linesPerLog: lines, files: out };
}

// ---- hub ----
function roundPhase(r) { return r.reply ? 'replied' : r.error ? 'failed' : r.sentAt ? 'running' : 'queued'; }
function hub(bridge, deps, sys, ctx) {
  const now = bridge.now();
  const aliases = ctx.aliases || new Map([['personal', '个人']]);
  const transcriptAt = meta => { try { return meta?.transcriptPath ? Math.round(sys.mtime(meta.transcriptPath)) : null; } catch { return null; } };
  const queue = bridge.openThreads().map(t => {
    const r = t.rounds.find(x => roundPhase(x) === 'running') || t.rounds.find(x => roundPhase(x) === 'queued') || t.rounds[t.rounds.length - 1] || {};
    const meta = t.sessionId ? (deps.getSession?.(t.sessionId) || deps.getSessionMetadata?.(t.sessionId)) : null;
    const phase = roundPhase(r);
    return { thread: t.id, title: short(t.title, 40), rounds: t.rounds.length, round: r.round ?? null, phase, model: t.model || null,
      receivedAt: r.receivedAt || null, sentAt: r.sentAt || null, waitedSec: phase === 'queued' && r.receivedAt ? Math.round((now - r.receivedAt) / 1000) : null,
      runningSec: phase === 'running' && r.sentAt ? Math.round((now - r.sentAt) / 1000) : null,
      queueNote: r.queueNote || null, retryAt: r.retryAt || null, resumePending: !!r.resumePending, receiptIssue: r.receiptIssue || null,
      session: t.sessionId ? String(t.sessionId).slice(0, 8) : null, sessionAlive: !!(t.sessionId && deps.getSession?.(t.sessionId)),
      sessionBusy: !!(t.sessionId && bridge.sessionBusy(t.sessionId)), working: (() => { try { return !!bridge.roundWorking(t); } catch { return null; } })(),
      transcriptAt: transcriptAt(meta) };
  });
  const sessions = [];
  const ids = deps.listSessionIds?.() || [];
  for (const id of ids) {
    const s = deps.getSession?.(id);
    if (!s) continue;
    const mem = ctx.sessionMem?.get(id);
    const lastActiveAt = Math.max(Number(s.lastMessageTime) || 0, Number(s.lastCompletedAt) || 0, Number(s.lastRunStartedAt) || 0, Number(deps.sessionInputAt?.(id)) || 0) || null;
    sessions.push({ id: String(id).slice(0, 8), title: short(s.title, 40), kind: String(s.kind || ''), purpose: s.purpose || null,
      state: s.status === 'dormant' ? 'dormant' : s.status === 'closed' ? 'closed' : 'active', status: s.status || null, busy: !!bridge.sessionBusy(id),
      lastActiveAt, pid: mem?.pid ?? ctx.ptyPids?.get(id) ?? null, memMB: mem ? mem.memMB : null, processes: mem ? mem.processes : null,
      account: s.codeagentPoolAccount ? (aliases.get(s.codeagentPoolAccount) || '号池') : /^codeagent/.test(String(s.kind || '')) ? '个人' : null });
  }
  sessions.sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
  const byState = sessions.reduce((m, s) => ({ ...m, [s.state]: (m[s.state] || 0) + 1 }), {});
  const job = bridge.hubAdmin?.job?.();
  return {
    version: bridge.hubAdmin?.current?.() || deps.currentVersion || null, pid: ctx.hubPid, startedAt: ctx.hubStartedAt || null,
    uptimeMin: ctx.hubStartedAt ? Math.round((now - ctx.hubStartedAt) / 60000) : null, uptimeSec: ctx.hubStartedAt ? Math.round((now - ctx.hubStartedAt) / 1000) : null,
    parallel: bridge.parallelLimitSafe(),
    care: bridge.careState ? { keepWarmMinutes: bridge.careState.keepWarmMinutes, freePercent: bridge.careState.freePercent, warm: bridge.careState.warm, at: bridge.careState.at } : null,
    holdingDispatch: (() => { try { return !!bridge.hubAdmin.holdingDispatch(); } catch { return null; } })(),
    adminJob: job ? { id: job.id, op: job.op, phase: job.phase, note: short(job.note, 120) } : null,
    queue: { running: queue.filter(q => q.phase === 'running').length, queued: queue.filter(q => q.phase === 'queued').length, threads: queue },
    sessions: { total: sessions.length, byState, list: sessions.slice(0, MAX_SESSIONS) },
  };
}

// ---- 汇总 ----
async function collect({ bridge, deps = bridge.deps, sections, lines = DEFAULT_LOG_LINES, sys = { ...defaultSys(), ...(deps.diagSys || {}) } }) {
  const t0 = sys.clock();
  const hubPid = Number(deps.hubPid) || process.pid;
  const ctx = { hubPid, hubStartedAt: Number(deps.hubStartedAt) || Math.round(Date.now() - process.uptime() * 1000) };
  const ptyPids = (() => { try { return (deps.sessionPtyPids?.() || []).filter(x => x && x.id && Number(x.pid) > 0); } catch { return []; } })();
  ctx.ptyPids = new Map(ptyPids.map(x => [x.id, Number(x.pid)]));
  let poolRaw = null, poolError = null;
  if (sections.includes('pool') || sections.includes('hub')) { try { poolRaw = deps.poolDiag ? deps.poolDiag() : null; } catch (error) { poolError = error; } }
  ctx.aliases = poolAliases(poolRaw);
  const out = { schema: 1, sections, at: bridge.now(), timings: {} };
  const run = async (name, fn) => {
    const s = sys.clock();
    try { out[name] = await fn(); } catch (error) { out[name] = { error: errText(error) }; }
    out.timings[name] = sys.clock() - s;
  };
  // 进程先采：hub 段要用会话的 PID 与内存
  const jobs = [];
  if (sections.includes('machine')) jobs.push(run('machine', () => machine(sys)));
  if (sections.includes('processes') || sections.includes('hub')) {
    jobs.push((async () => {
      const s = sys.clock();
      let analyzed = null, error = null;
      try {
        const snap = await Promise.race([sys.processSnapshot(), new Promise((_, reject) => setTimeout(() => reject(new Error(`进程枚举超过 ${PROCESS_TIMEOUT_MS / 1000} 秒没返回`)), PROCESS_TIMEOUT_MS + 1000).unref?.())]);
        analyzed = analyzeProcesses(snap, { hubPid, hubExe: path.basename(String(deps.hubExecPath || process.execPath)), sessionPids: ptyPids, now: bridge.now() });
      } catch (e) { error = e; }
      if (analyzed) ctx.sessionMem = analyzed.sessions;
      if (error) ctx.processError = errText(error);
      if (sections.includes('processes')) {
        if (analyzed) { const { sessions: _s, ...rest } = analyzed; out.processes = rest; } else out.processes = { error: errText(error) };
        out.timings.processes = sys.clock() - s;
      }
    })());
  }
  await Promise.all(jobs);
  if (sections.includes('hub')) await run('hub', () => { const h = hub(bridge, deps, sys, ctx); if (ctx.processError) h.processNote = '会话内存没算出来：' + ctx.processError; return h; });
  if (sections.includes('pool')) await run('pool', () => { if (poolError) throw poolError; return pool(poolRaw, { usePool: !!bridge.settings().usePool, models: bridge.modelTableSafe?.() || null }); });
  if (sections.includes('logs')) await run('logs', () => logs(sys, path.join(deps.dataDir, 'logs'), lines));
  out.elapsedMs = sys.clock() - t0;
  return out;
}

// ---- 一句话摘要（老版本对端只看得到它；新版对端放在卡片顶上）----
function summarize(d) {
  const parts = [];
  const m = d.machine;
  if (m && !m.error) parts.push(`内存可用 ${m.memory.freePct}%（${gb(m.memory.freeMB * 1048576)}/${gb(m.memory.totalMB * 1048576)} GB）`);
  const p = d.processes;
  if (p && !p.error && p.summary) {
    parts.push(`CodeAgent ${p.summary.codeAgent.count} 个共 ${gb(p.summary.codeAgent.memMB * 1048576)} GB`);
    parts.push(`Hub 自身 ${gb(p.summary.hubSelf.memMB * 1048576)} GB`);
    if (p.summary.leftovers.count) parts.push(`树外残留嫌疑 ${p.summary.leftovers.count} 个（${gb(p.summary.leftovers.memMB * 1048576)} GB）`);
  }
  const h = d.hub;
  if (h && !h.error) {
    const par = h.parallel;
    parts.push(`通道 ${h.queue.running} 个在跑、${h.queue.queued} 个排队${par ? `（上限 ${par.cap}，受${par.limitedBy}限制）` : ''}`);
  }
  const failed = SECTIONS.filter(s => d[s] && d[s].error);
  if (failed.length) parts.push(`没采到：${failed.map(s => SECTION_LABEL[s]).join('、')}`);
  if (d.degraded?.length) parts.push('超长已精简：' + d.degraded[d.degraded.length - 1]);
  parts.push(`采集 ${(d.elapsedMs / 1000).toFixed(1)} 秒`);
  return '这台电脑的状态：' + parts.join(' · ');
}

// ---- 塞进一条消息：先截日志，再把进程截到前 10，再精简会话列表……始终能发出去 ----
const STEPS = [
  ['日志每份截到 40 行', d => { if (d.logs?.files) for (const f of d.logs.files) if (f.lines) f.lines = f.lines.slice(-40); }],
  ['日志每份截到 15 行', d => { if (d.logs?.files) for (const f of d.logs.files) if (f.lines) f.lines = f.lines.slice(-15); }],
  ['进程只留前 10，残留嫌疑只留前 15', d => { if (d.processes?.top) d.processes.top = d.processes.top.slice(0, 10); if (d.processes?.leftovers) d.processes.leftovers = d.processes.leftovers.slice(0, 15); }],
  ['日志省略', d => { if (d.logs?.files) d.logs = { omitted: true, note: '回报超过单条消息上限，日志省略；可以只查 logs 段', files: d.logs.files.map(f => ({ key: f.key, label: f.label, file: f.file, sizeKB: f.sizeKB, mtime: f.mtime })) }; }],
  ['会话列表只留 20 个', d => { if (d.hub?.sessions?.list) d.hub.sessions.list = d.hub.sessions.list.slice(0, 20); }],
  ['进程只留前 5，残留嫌疑只留前 5，会话列表省略', d => {
    if (d.processes?.top) d.processes.top = d.processes.top.slice(0, 5);
    if (d.processes?.leftovers) d.processes.leftovers = d.processes.leftovers.slice(0, 5);
    if (d.hub?.sessions?.list) d.hub.sessions.list = [];
  }],
  ['只留各段汇总', d => {
    if (d.processes && !d.processes.error) { delete d.processes.top; delete d.processes.leftovers; }
    if (d.hub?.queue?.threads) d.hub.queue.threads = d.hub.queue.threads.slice(0, 10).map(q => ({ thread: q.thread, phase: q.phase, round: q.round, queueNote: q.queueNote }));
    if (d.pool?.accounts) d.pool.accounts = d.pool.accounts.map(a => ({ alias: a.alias, state: a.state, activeSessions: a.activeSessions }));
    if (d.pool) delete d.pool.models;
  }],
];
// measure(encoded) → 整条消息的字节数。返回 { data(编码后), result, degraded, bytes }。
function fit(result, measure, limit = MESSAGE_LIMIT - MESSAGE_MARGIN) {
  const d = JSON.parse(JSON.stringify(result));
  d.degraded = [];
  let data = encode(d), bytes = measure(data);
  for (const [label, step] of STEPS) {
    if (bytes < limit) break;
    step(d); d.degraded.push(label);
    data = encode(d); bytes = measure(data);
  }
  if (bytes >= limit) {
    const tiny = { schema: 1, sections: d.sections, at: d.at, elapsedMs: d.elapsedMs, degraded: [...d.degraded, '全部省略'], note: '回报仍超过单条消息上限，只留摘要；请少选几段再查', summary: summarize(d) };
    data = encode(tiny); bytes = measure(data);
    return { data, result: tiny, degraded: tiny.degraded, bytes };
  }
  return { data, result: d, degraded: d.degraded, bytes };
}

module.exports = {
  SECTIONS, SECTION_LABEL, MIN_INTERVAL_MS, MESSAGE_LIMIT, PROCESS_TIMEOUT_MS, DEFAULT_LOG_LINES, MAX_LOG_LINES, LOGS,
  parseSections, parseLines, encode, decode, makeRedactor, deepRedact, analyzeProcesses, poolAliases, pool, machine, logs, hub, collect, summarize, fit, defaultSys,
};
