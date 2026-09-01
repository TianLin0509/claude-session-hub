'use strict';
// core/study-store.js
//
// 学习 Tab 的状态存储（2026-09-01）。
//
// 存两类东西：
//   1) 两位常驻 Agent 与 Hub Session 的绑定关系（Claude 主笔 / Codex 审阅兼插画）
//   2) 每日 run 的阶段推进记录（哪一棒、什么时候开始、成没成、失败原因）
//
// 学习材料本身（.src.html / .html / review.md / 图片）**不进这里**，
// 它们是文件，住在学习项目目录里。这里只存「谁在什么时候跑了哪一棒」。
// 这样即使状态文件丢了，材料还在；材料重生成时状态也能重建。
//
// 写盘规矩沿用 Agent 联赛那套已经在生产里跑住的做法：
//   先写临时文件 → fsync → 原子 rename，写前留一份 .bak。
// 理由是这个文件会被主进程定时器在半夜写，机器休眠/掉电时不能留下半截 JSON。

const fs = require('fs');
const path = require('path');

const STATE_VERSION = 1;
const AGENT_ROLES = Object.freeze(['author', 'reviewer']);

// 角色 → CLI 种类。写死而不是让用户配：这套工作流的两棒分工是按能力边界定的
// （Codex 有生图能力，Claude 没有），换成两个 Claude 就没有意义了。
const ROLE_KIND = Object.freeze({ author: 'claude', reviewer: 'codex' });
const ROLE_LABEL = Object.freeze({ author: '主笔 · Claude', reviewer: '审阅与插画 · Codex' });

function defaultState() {
  return {
    version: STATE_VERSION,
    studyRoot: '',
    agents: {
      author: { role: 'author', kind: 'claude', sessionId: '', nativeSession: null, status: 'unbound' },
      reviewer: { role: 'reviewer', kind: 'codex', sessionId: '', nativeSession: null, status: 'unbound' },
    },
    schedule: { enabled: true, hour: 0, minute: 0, catchUpOnOpen: true },
    runs: {},           // date → run 记录
    lastRunDate: '',
    updatedAt: '',
  };
}

function emptyRun(date, lessonId) {
  return {
    date,
    lessonId,
    trigger: '',
    startedAt: '',
    finishedAt: '',
    status: 'pending',           // pending | running | done | failed
    currentStage: '',
    stages: {},                  // stage → { status, actor, sessionId, startedAt, finishedAt, error, note }
  };
}

function emptyStage(stage, actor) {
  return {
    stage, actor,
    status: 'pending',           // pending | running | done | failed | skipped
    sessionId: '',
    startedAt: '',
    finishedAt: '',
    error: '',
    note: '',
  };
}

/* ───────────────────────── 落盘 ───────────────────────── */

function atomicWriteJson(file, obj) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(file)) {
    try { fs.copyFileSync(file, file + '.bak'); } catch { /* 备份失败不该挡住写入 */ }
  }
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(obj, null, 2), 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    // 主文件坏了就退到 .bak；两个都坏就重建。宁可丢状态也不要让面板打不开——
    // 材料在文件系统里，状态是可重建的派生物。
    try {
      if (fs.existsSync(file + '.bak')) return JSON.parse(fs.readFileSync(file + '.bak', 'utf8'));
    } catch { /* ignore */ }
    return fallback;
  }
}

/* ───────────────────────── Store ───────────────────────── */

function createStudyStore(options = {}) {
  const stateFile = options.stateFile;
  if (!stateFile) throw new Error('createStudyStore: 需要 stateFile');

  let state = null;

  function load() {
    if (state) return state;
    const raw = readJsonSafe(stateFile, null);
    state = raw && raw.version === STATE_VERSION ? raw : defaultState();
    // 老版本或缺字段时补齐，避免下游到处判空
    const base = defaultState();
    state.agents = Object.assign({}, base.agents, state.agents || {});
    for (const role of AGENT_ROLES) {
      state.agents[role] = Object.assign({}, base.agents[role], state.agents[role] || {});
      state.agents[role].kind = ROLE_KIND[role];   // 分工写死，不接受被改坏的旧状态
    }
    state.schedule = Object.assign({}, base.schedule, state.schedule || {});
    state.runs = state.runs || {};
    if (options.studyRoot && !state.studyRoot) state.studyRoot = options.studyRoot;
    return state;
  }

  function save() {
    const s = load();
    s.updatedAt = new Date().toISOString();
    atomicWriteJson(stateFile, s);
    return s;
  }

  function snapshot() {
    return JSON.parse(JSON.stringify(load()));
  }

  /* ── Agent / Session 绑定 ── */

  function getAgent(role) {
    if (!AGENT_ROLES.includes(role)) throw new Error(`未知角色：${role}`);
    return load().agents[role];
  }

  function bindSession(role, meta = {}) {
    const agent = getAgent(role);
    if ('sessionId' in meta) agent.sessionId = String(meta.sessionId || '');
    if ('nativeSession' in meta) agent.nativeSession = meta.nativeSession || null;
    if ('status' in meta) agent.status = String(meta.status || 'unbound');
    save();
    return agent;
  }

  function unbindSession(role) {
    return bindSession(role, { sessionId: '', nativeSession: null, status: 'unbound' });
  }

  function agentBySessionId(sessionId) {
    if (!sessionId) return null;
    const s = load();
    for (const role of AGENT_ROLES) {
      if (s.agents[role].sessionId === sessionId) return s.agents[role];
    }
    return null;
  }

  /* ── 每日 run ── */

  function getRun(date) {
    return load().runs[date] || null;
  }

  function listRuns(limit = 30) {
    const s = load();
    return Object.keys(s.runs).sort().slice(-limit).reverse().map((d) => s.runs[d]);
  }

  function startRun(date, lessonId, trigger, stages) {
    const s = load();
    const run = s.runs[date] && s.runs[date].lessonId === lessonId ? s.runs[date] : emptyRun(date, lessonId);
    run.trigger = trigger || 'manual';
    run.status = 'running';
    run.startedAt = run.startedAt || new Date().toISOString();
    run.finishedAt = '';
    for (const [stage, actor] of stages) {
      // 已经 done 的棒不重置——补跑时只补没跑成的那几棒，
      // 否则半夜跑了一半重跑会把 Codex 画好的图白白重画一遍。
      if (!run.stages[stage] || run.stages[stage].status !== 'done') {
        run.stages[stage] = emptyStage(stage, actor);
      }
    }
    s.runs[date] = run;
    s.lastRunDate = date;
    save();
    return run;
  }

  function markStage(date, stage, patch = {}) {
    const s = load();
    const run = s.runs[date];
    if (!run) return null;
    const st = run.stages[stage] || (run.stages[stage] = emptyStage(stage, patch.actor || ''));
    Object.assign(st, patch);
    if (patch.status === 'running') {
      st.startedAt = new Date().toISOString();
      run.currentStage = stage;
    }
    if (patch.status === 'done' || patch.status === 'failed') {
      st.finishedAt = new Date().toISOString();
    }
    save();
    return st;
  }

  function finishRun(date, status, note = '') {
    const s = load();
    const run = s.runs[date];
    if (!run) return null;
    run.status = status;
    run.finishedAt = new Date().toISOString();
    run.currentStage = '';
    if (note) run.note = note;
    save();
    return run;
  }

  /* ── 调度 ── */

  function getSchedule() {
    return Object.assign({}, load().schedule);
  }

  function setSchedule(patch = {}) {
    const s = load();
    s.schedule = Object.assign({}, s.schedule, patch);
    save();
    return Object.assign({}, s.schedule);
  }

  function getStudyRoot() {
    return load().studyRoot || options.studyRoot || '';
  }

  function setStudyRoot(root) {
    const s = load();
    s.studyRoot = String(root || '');
    save();
    return s.studyRoot;
  }

  return {
    load, save, snapshot,
    getAgent, bindSession, unbindSession, agentBySessionId,
    getRun, listRuns, startRun, markStage, finishRun,
    getSchedule, setSchedule,
    getStudyRoot, setStudyRoot,
    _paths: { stateFile },
  };
}

module.exports = {
  createStudyStore,
  STATE_VERSION,
  AGENT_ROLES,
  ROLE_KIND,
  ROLE_LABEL,
};
