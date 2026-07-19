'use strict';
// 投委会编排状态机（三幕制）。
//
// 复用 dispatchGroupChatTurn 做每一幕的派发：
//   幕一 = 一次 @三官 并行 turn（同轮并行天然互不可见）
//   幕二 = @质询官 turn → @被点名席位 答辩 turn（delta 机制自动携带前幕发言）
//   幕三 = @主席 turn（首次 delta 含全部历史）
// Python 侧：幕〇备料 prep_case / 决议落盘 committee_memory（spawn，raw_decode 容忍横幅污染）。

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scene = require('../../core/committee-scene.js');
const intentRouter = require('../../core/committee-intent-router.js');

const LINDANG_DIR = process.env.LINDANG_DIR || 'C:\\LinDangAgent';
const PYTHON_BIN = process.env.LINDANG_PYTHON || 'python';
const PREP_TIMEOUT_MS = { quick: 5 * 60 * 1000, full: 10 * 60 * 1000 };
const MEMORY_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_VALIDATION_RETRIES = 2;
const SESSION_DEADLINE_MS = 40 * 60 * 1000; // 整场硬上限（防卡死铁律：全局 deadline）
const ACT_TIMEOUT_MS = 12 * 60 * 1000;      // 单幕硬超时：卡住的席位强制 skip 按"缺席"处理
const RETRY_TIMEOUT_MS = 4 * 60 * 1000;     // 定向重试轮更短
const CHECKUP_OCR_TIMEOUT_MS = 60 * 1000;   // 图片识别只做入口提取，失败要快速返回可见错误
const ROLLCALL_TIMEOUT_MS = 4 * 60 * 1000;  // 点名只预热非 Codex 关键席位；Codex 首启交给主轮长预算承接
const ROLLCALL_ENABLED = process.env.COMMITTEE_ENABLE_ROLLCALL === '1';
const SUSPECT_RETRY_TIMEOUT_MS = 3 * 60 * 1000; // 点名缺席席位的降级重试预算（防一个死席位吃掉全场时间）
const CHAIR_DISPATCH_ATTEMPTS = 2;          // 主席派发失败（no_sent 等）重试次数——主席是唯一关键路径
const ROUTER_TIMEOUT_MS = 30 * 1000;        // 立项路由只做 JSON 翻译，必须短预算失败回退

class CommitteeAbortError extends Error {
  constructor(status, detail) {
    super(detail || `committee ${status}`);
    this.name = 'CommitteeAbortError';
    this.committeeAbort = true;
    this.status = status;
  }
}

function isCommitteeAbort(error) {
  return !!(error && error.committeeAbort === true &&
    (error.status === 'interrupted' || error.status === 'superseded'));
}

function runPython(args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    try {
      child = spawn(PYTHON_BIN, ['-X', 'utf8', ...args], {
        cwd: LINDANG_DIR, windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
    } catch (e) {
      return finish({ ok: false, error: 'spawn failed: ' + e.message });
    }
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; if (err.length > 20000) err = err.slice(-20000); });
    const timer = setTimeout(() => {
      try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch {}
      finish({ ok: false, error: `python timeout ${Math.round(timeoutMs / 1000)}s`, stderr_tail: err.slice(-500) });
    }, timeoutMs);
    child.on('close', () => {
      clearTimeout(timer);
      const start = out.indexOf('{');
      if (start < 0) return finish({ ok: false, error: 'no JSON in python stdout', stderr_tail: err.slice(-500) });
      try {
        // raw_decode 等价：截取首个完整 JSON（防 xtquant 横幅污染）
        const obj = JSON.parse(balancedJson(out.slice(start)));
        finish(obj);
      } catch (e) {
        finish({ ok: false, error: 'python JSON parse: ' + e.message, stdout_head: out.slice(0, 200) });
      }
    });
    child.on('error', e => { clearTimeout(timer); finish({ ok: false, error: e.message }); });
  });
}

// 取首个括号配平的 JSON 对象子串（容忍尾部横幅/日志）
function balancedJson(s) {
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { if (inStr) esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return s.slice(0, i + 1); }
  }
  return s;
}

function createCommitteeConductor(deps) {
  const {
    dispatchGroupChatTurn,
    meetingManager,
    sessionManager,
    logger = console,
    sendToRenderer = () => {},
  } = deps;

  const inProgress = new Set();
  const cancellationByMeeting = new Map();
  const routeCache = new Map();

  function log(...a) { try { logger.log('[committee]', ...a); } catch {} }
  function warn(...a) { try { logger.warn('[committee]', ...a); } catch {} }

  function cancelCommitteeSession(meetingId, status = 'interrupted') {
    if (!inProgress.has(meetingId)) return false;
    const normalized = status === 'superseded' ? 'superseded' : 'interrupted';
    cancellationByMeeting.set(meetingId, normalized);
    return true;
  }

  function throwIfCommitteeCancelled(meetingId) {
    const status = cancellationByMeeting.get(meetingId);
    if (status) throw new CommitteeAbortError(status, status === 'interrupted'
      ? '用户已中断投委会编排'
      : '投委会编排已被新提问覆盖');
  }

  function waitWithCommitteeCancellation(meetingId, ms) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        try {
          throwIfCommitteeCancelled(meetingId);
          if (Date.now() - startedAt >= ms) {
            clearInterval(timer);
            resolve();
          }
        } catch (error) {
          clearInterval(timer);
          reject(error);
        }
      }, Math.min(100, Math.max(10, ms)));
    });
  }

  // 投委会允许重复 kind（例如消息面官/主席都可用 Claude，技术面官/质询官都可用 Codex）。
  // 因此优先按预设 slot 顺序绑定席位；再用 kind 做旧会议兜底。
  function resolveSeats(meeting) {
    const subSids = Array.isArray(meeting.subSessions) ? meeting.subSessions : [];
    const seatKeys = [...scene.ANALYST_KEYS, 'challenger', 'chair'];
    const seats = {};
    const used = new Set();
    seatKeys.forEach((key, idx) => {
      const sid = subSids[idx];
      const def = scene.SEATS[key];
      const s = sid ? sessionManager.getSession(sid) : null;
      if (!def || !s || s.status === 'dormant') return;
      if (s.kind !== def.kind) return;
      seats[key] = { sid, memberId: `m${idx + 1}`, kind: s.kind, seat: key, def };
      used.add(sid);
    });
    const byKind = {};
    subSids.forEach((sid, idx) => {
      if (used.has(sid)) return;
      const s = sessionManager.getSession(sid);
      if (!s || s.status === 'dormant') return;
      if (!byKind[s.kind]) byKind[s.kind] = [];
      byKind[s.kind].push({ sid, memberId: `m${idx + 1}`, kind: s.kind });
    });
    for (const def of Object.values(scene.SEATS)) {
      if (seats[def.key]) continue;
      const queue = byKind[def.kind] || [];
      const next = queue.shift();
      if (next) {
        seats[def.key] = { ...next, seat: def.key, def };
        used.add(next.sid);
      }
    }
    return seats;
  }

  function routeCacheKey(meetingId, userInput) {
    return `${meetingId || ''}\n${String(userInput || '')}`;
  }

  async function isCommitteeCommand(meetingId, userInput) {
    const meeting = meetingManager.getMeeting(meetingId);
    if (!meeting || meeting.scene !== 'committee') return false;
    const route = await resolveCommitteeRoute(meetingId, userInput, { allowLlm: true });
    return !!route && route.intent !== 'non_committee_chat';
  }

  async function dispatch(meetingId, userInput, timeoutMs = ACT_TIMEOUT_MS, extra = {}) {
    throwIfCommitteeCancelled(meetingId);
    const r = await dispatchGroupChatTurn(meetingId, { userInput, turnTimeoutMs: timeoutMs, ...extra });
    throwIfCommitteeCancelled(meetingId);
    if (r && r.superseded) {
      throw new CommitteeAbortError('superseded', '投委会本幕已被新提问覆盖');
    }
    if (r && r.status === 'interrupted') {
      throw new CommitteeAbortError('interrupted', '用户已中断投委会本幕');
    }
    if (!r || r.status !== 'completed') {
      throw new Error(`dispatch failed: ${(r && (r.reason || r.status)) || 'unknown'}`);
    }
    return r;
  }

  function resultText(turnResult, sid) {
    const hit = (turnResult.results || []).find(x => x.sid === sid);
    return hit ? (hit.text || '') : '';
  }

  // 进度事件可携带结构化 data（沉浸式实时渲染用）。text 永远保留——
  // renderer 旧的文本分类逻辑不变，data 仅作增量富渲染，向后兼容。
  function progress(meetingId, text, data) {
    log(text);
    try {
      sendToRenderer('committee-progress', data ? { meetingId, text, data } : { meetingId, text });
    } catch {}
  }

  // 把已校验的分析官报告抽成精简结构（供实时卡片 + transcript 持久化）。
  function reportToCard(r) {
    const j = (r && r.json) || null;
    return {
      seat: r.seat, kind: r.kind, valid: !!(r && r.valid),
      signal: j ? j.signal : null,
      confidence: j ? j.confidence : null,
      core_thesis: j ? j.core_thesis : null,
      assumptions: j ? (j.assumptions || []) : [],
      evidence: j ? (j.evidence || []) : [],
      extras: j ? (j.extras || {}) : {},
      kill_switch: j ? j.kill_switch : null,
    };
  }

  async function runLlmCommitteeRoute(meetingId, userInput, seats) {
    if (process.env.COMMITTEE_DISABLE_LLM_ROUTER === '1') return null;
    if (!seats || !seats.chair) return null;
    const candidates = intentRouter.findStockCandidates(userInput);
    const prompt = intentRouter.buildLlmRouterPrompt(userInput, candidates);
    progress(meetingId, `立项路由：主席识别自然语言意图${candidates.length ? `（候选 ${candidates.map(c => `${c.name}${c.symbol}`).join('、')}）` : ''}...`);
    try {
      const routed = await dispatch(meetingId, prompt, ROUTER_TIMEOUT_MS, {
        targetMemberIds: [seats.chair.memberId],
        silent: true,
      });
      const text = resultText(routed, seats.chair.sid);
      const json = intentRouter.parseJsonObject(text);
      const route = intentRouter.validateLlmRoute(json, userInput);
      if (route) {
        route.source = 'llm';
        return route;
      }
      warn('立项路由 JSON 未通过校验，回退确定性解析：', String(text || '').slice(0, 200));
    } catch (e) {
      if (isCommitteeAbort(e)) throw e;
      warn('立项路由异常，回退确定性解析：', e && e.message);
    }
    return null;
  }

  async function resolveCommitteeRoute(meetingId, userInput, opts = {}) {
    const key = routeCacheKey(meetingId, userInput);
    if (routeCache.has(key)) return routeCache.get(key);

    const text = String(userInput || '').trim();
    const checkup = scene.parseCheckupCommand(text);
    if (checkup) {
      const route = {
        intent: 'portfolio_checkup',
        mode: 'quick',
        symbols: [],
        needs_clarification: false,
        checkup,
        source: 'deterministic',
        raw_input: text,
      };
      routeCache.set(key, route);
      return route;
    }

    const meeting = meetingManager.getMeeting(meetingId);
    const seats = meeting ? resolveSeats(meeting) : {};
    const deterministic = intentRouter.routeDeterministic(text, { parseCheckupCommand: scene.parseCheckupCommand });
    const candidates = intentRouter.findStockCandidates(text);
    const singleCode = scene.parseCommitteeCommand(text);
    const codeCount = (text.match(/\b\d{6}(?:\.(?:SZ|SH|BJ))?\b/ig) || []).length;

    let route = null;
    if (deterministic) {
      route = deterministic;
    }

    if (!route && opts.allowLlm && !singleCode && (candidates.length || /股票|个股|A股|投委会|公司|怎么样|如何|深挖|对比|相比|比较/.test(text))) {
      route = await runLlmCommitteeRoute(meetingId, text, seats);
    }

    if (!route && singleCode && codeCount === 1) {
      route = {
        intent: 'single_stock',
        mode: singleCode.mode,
        symbols: [{ symbol: singleCode.symbol.replace(/\..*$/, ''), name: singleCode.symbol.replace(/\..*$/, '') }],
        needs_clarification: false,
        source: 'legacy',
        raw_input: text,
      };
    }

    // 只缓存"识别成功"的正向结果。
    // 修复（2026-06-13 审计 HIGH）：原版无条件 routeCache.set(key, route) 会把 null/失败
    // 永久固化——用户首次识别失败后，后续补全信息或改席位也永远拿同一个失败缓存；
    // 且 isCommitteeCommand(allowLlm:true) 写的负缓存会污染 runCommitteeSession(allowLlm:false)。
    // 失败不写缓存：下次重新评估（确定性解析很便宜），席位补齐后立即生效。
    if (route && route.intent) routeCache.set(key, route);
    return route;
  }

  // 幕一发言解析 + 校验 + 定向重试。
  // 缺席席位（paste-trapped 被 skip，CLI 从未收到案卷）→ 整卷重发；
  // 格式错误席位 → 只发修正指令。
  // 鲁棒性兜底：疑似不可用席位可传入 suspectKeys 后只给 1 次降级重试
  // （更短超时），防止一个死席位的重试链吃掉全场时间——单席卡死永不拖死流程。
  async function collectValidatedReports(meetingId, seats, turnResult, caseMarkdown, suspectKeys = new Set()) {
    const reports = {};
    for (const key of scene.ANALYST_KEYS) {
      const seat = seats[key];
      if (!seat) continue;
      const suspect = suspectKeys.has(key);
      const maxRetries = suspect ? 1 : MAX_VALIDATION_RETRIES;
      const retryTimeout = suspect ? SUSPECT_RETRY_TIMEOUT_MS : RETRY_TIMEOUT_MS;
      let text = resultText(turnResult, seat.sid);
      let json = scene.extractJsonBlock(text);
      let v = scene.validateAnalystReport(json, key);
      let retries = 0;
      while (!v.ok && retries < maxRetries) {
        retries += 1;
        const absent = !text || text.trim().length < 20;
        progress(meetingId, `${seat.def.label} ${absent ? '本轮缺席（发送可能被卡）' : 'JSON 校验未过（' + v.errors.join('；') + '）'}，定向重试 #${retries}`);
        // 重试 prompt 显式带 persona：首发被卡的席位连自己的席位纪律都没收到过
        // （persona 在首条 delta 的 system prompt 里，已被 lastDeliveredIdx 标记消费）。
        const persona = scene.buildCommitteePersona(seat.seat || key) || scene.buildCommitteePersona(seat.kind) || '';
        const fixPrompt = absent
          ? persona + '\n\n' + scene.buildAct1Prompt(`@${seat.memberId}`, caseMarkdown)
          : [
              `【投委会 · 幕一 · 退回重写】 @${seat.memberId}`,
              persona,
              `你的 JSON 校验失败：${v.errors.join('；')}。`,
              '请按你的席位纪律（含 extras 专属字段），仅基于你自己的判断重新输出**完整的** ```json 块（不要重复案卷，不要长篇解释）。',
            ].join('\n');
        try {
          const retry = await dispatch(meetingId, fixPrompt, retryTimeout);
          text = resultText(retry, seat.sid) || text;
          json = scene.extractJsonBlock(text) || json;
          v = scene.validateAnalystReport(json, key);
        } catch (e) {
          if (isCommitteeAbort(e)) throw e;
          warn(`retry dispatch failed for ${key}:`, e.message);
          break;
        }
      }
      reports[key] = {
        seat: key, kind: seat.kind, memberId: seat.memberId,
        json: v.ok ? json : null,
        valid: v.ok, errors: v.ok ? [] : v.errors,
        text,
      };
      if (!v.ok) progress(meetingId, `${seat.def.label} 两次重写仍未过校验，本场记为"缺席"（主席将在决议中声明）`);
    }
    return reports;
  }

  async function runCommitteeSession(meetingId, userInput) {
    if (inProgress.has(meetingId)) return { status: 'busy', reason: '本会议已有投委会在进行', turnNum: null };
    const route = await resolveCommitteeRoute(meetingId, userInput, { allowLlm: false });
    if (!route || route.intent === 'non_committee_chat') {
      return { status: 'error', reason: '未识别投委会立项意图', turnNum: null };
    }
    if (route.intent === 'clarify') {
      const candidates = (route.symbols || []).map(s => `${s.name} ${s.symbol}`).join('、') || '无候选';
      return {
        status: 'error',
        reason: `${route.question || '标的存在歧义，请确认。'} 候选：${candidates}`,
        turnNum: null,
      };
    }
    if (route.intent === 'compare_stocks') {
      const pairs = (route.symbols || []).map(s => `${s.name} ${s.symbol}`).join(' vs ');
      return {
        status: 'error',
        reason: `已识别为多票对比：${pairs}。当前已完成自然语言识别与防误跑保护，完整“对比投委会”编排还未接入；请先单票运行，或下一步接 compare_stocks 流程。`,
        turnNum: null,
        meta: { committee: { kind: 'compare_stocks', symbols: route.symbols || [], mode: route.mode } },
      };
    }
    const checkup = route.checkup || scene.parseCheckupCommand(userInput);
    if (checkup) return runCheckupSession(meetingId, checkup);
    const cmd = route.intent === 'single_stock' && route.symbols && route.symbols[0]
      ? { symbol: route.symbols[0].symbol, mode: route.mode || 'quick', name: route.symbols[0].name }
      : scene.parseCommitteeCommand(userInput);
    if (!cmd) return { status: 'error', reason: '未识别股票代码', turnNum: null };
    const meeting = meetingManager.getMeeting(meetingId);
    const seats = resolveSeats(meeting);

    const missing = [];
    for (const key of [...scene.ANALYST_KEYS, 'chair']) {
      if (!seats[key]) missing.push(`${scene.SEATS[key].label}(${scene.SEATS[key].kind})`);
    }
    const analystCount = scene.ANALYST_KEYS.filter(k => seats[k]).length;
    if (!seats.chair || analystCount < 2) {
      return {
        status: 'error', turnNum: null,
        reason: `投委会席位不全（缺 ${missing.join('、')}）。请按预设创建：DeepSeek+Claude+Codex+Codex+Claude 五席。`,
      };
    }

    cancellationByMeeting.delete(meetingId);
    inProgress.add(meetingId);
    const deadline = Date.now() + SESSION_DEADLINE_MS;
    const checkDeadline = (stage) => {
      throwIfCommitteeCancelled(meetingId);
      if (Date.now() > deadline) throw new Error(`投委会整场超时（40min 硬上限）于 ${stage}`);
    };

    try {
      // ---- 开场点名（微型 prompt 暖关键路径席位：建立 groupChatReady + 暖 paste 通道） ----
      // 根因（2026-06-11 E2E 实测）：①冷 CLI 收大段粘贴易卡；②迟到席位（主席/质询官）
      // 首次被点名时 waitCliReady 因 boot 标记过期而 60s 超时 → no_sent。
      // 点名 prompt 极小（<100 字），首粘成功率高。质询官是条件路径，未触发幕二时不应
      // 为它消耗开场预算或制造降级记录；需要质询时再按非关键路径即时派发。
      const rollcallKeys = [...scene.ANALYST_KEYS]
        .filter(k => seats[k] && seats[k].kind !== 'codex');
      const suspectKeys = new Set();
      if (ROLLCALL_ENABLED && rollcallKeys.length) {
        const allMentions = rollcallKeys.map(k => `@${seats[k].memberId}`).join(' ');
        progress(meetingId, `开场点名：${allMentions}`);
        try {
          const roll = await dispatch(meetingId,
            `【投委会 · 点名】 ${allMentions} 投委会即将开始，请各自只回复两个字：就位。不要调用任何工具。`,
            ROLLCALL_TIMEOUT_MS);
          // 点名只是预热，不作为降级依据。2026-06-12 full live matrix 证明：
          // Claude Opus 消息面官可能点名 4min false negative，但主轮/定向轮能正常产出合格 JSON。
          const warmupMissKeys = [];
          for (const key of rollcallKeys) {
            const seat = seats[key];
            const t = resultText(roll, seat.sid);
            if (!t || t.trim().length === 0) warmupMissKeys.push(key);
          }
          if (warmupMissKeys.length) {
            progress(meetingId, `点名预热未返回：${warmupMissKeys.map(k => scene.SEATS[k].label).join('、')}（继续主轮全预算，不计降级）`);
          }
        } catch (e) {
          if (isCommitteeAbort(e)) throw e;
          warn('点名轮异常（不阻塞）：', e.message);
        }
      }

      // ---- 幕〇 备料（纯脚本） ----
      progress(meetingId, `幕〇备料中：${cmd.name ? `${cmd.name} ` : ''}${cmd.symbol}（${cmd.mode === 'full' ? '全量' : '快评'}模式，约 1-4 分钟）...`);
      const prep = await runPython(
        ['-m', 'committee.prep_case', cmd.symbol, ...(cmd.mode === 'quick' ? ['--fast'] : [])],
        PREP_TIMEOUT_MS[cmd.mode]);
      throwIfCommitteeCancelled(meetingId);
      if (!prep.ok) {
        return { status: 'error', turnNum: null, reason: `幕〇备料失败：${prep.error || '未知'}` };
      }
      const maxRating = (prep.coverage_gate && prep.coverage_gate.max_rating) || 'S';
      const validMemoryIds = extractMemoryIds(prep.markdown);
      // 沉浸式实时渲染 + transcript 持久化所需的结构化态
      let attackJson = null;
      const defenseBySeat = {};
      progress(meetingId, `幕〇备料完成：红旗触发 ${(prep.red_flags_summary && prep.red_flags_summary.triggered) || 0} 项，覆盖度门控最高 ${maxRating}`, {
        stage: 'prep', symbol: prep.symbol, name: prep.name, mode: cmd.mode,
        red_flags: prep.red_flags || [], coverage_gate: prep.coverage_gate || null,
        objective: prep.objective || null,
      });

      // ---- 幕一 三官并行 ----
      checkDeadline('幕一');
      const analystKeys = scene.ANALYST_KEYS.filter(k => seats[k]);
      let primaryAnalystKeys = analystKeys.filter(k => !suspectKeys.has(k));
      let act1Timeout = ACT_TIMEOUT_MS;
      if (!primaryAnalystKeys.length) {
        primaryAnalystKeys = analystKeys;
        act1Timeout = SUSPECT_RETRY_TIMEOUT_MS;
      }
      const deferredAnalystKeys = analystKeys.filter(k => !primaryAnalystKeys.includes(k));
      const analystMentions = primaryAnalystKeys.map(k => `@${seats[k].memberId}`).join(' ');
      if (deferredAnalystKeys.length) {
        progress(meetingId, `幕一：${deferredAnalystKeys.map(k => scene.SEATS[k].label).join('、')} 点名未应答，先跳过主轮并走定向短预算重试`);
      }
      progress(meetingId, `幕一：${analystMentions} 独立研判中...`);
      const act1 = await dispatch(meetingId, scene.buildAct1Prompt(analystMentions, prep.markdown), act1Timeout);
      const reports = await collectValidatedReports(meetingId, seats, act1, prep.markdown, suspectKeys);
      // 逐席发结构化研判卡——renderer 据此实时长出"看多72/一句论点"的卡片（不再只显示"研判中"）
      for (const key of scene.ANALYST_KEYS) {
        if (!reports[key]) continue;
        const card = reportToCard(reports[key]);
        progress(meetingId,
          `${scene.SEATS[key].label} 研判完成：${card.valid ? `${card.signal || '—'} / 信心 ${card.confidence ?? '—'}` : '本场缺席（未过校验）'}`,
          { stage: 'analyst', seat: key, label: scene.SEATS[key].label, report: card });
      }

      // ---- 幕二 条件质询 ----
      checkDeadline('幕二');
      const decision = scene.decideChallenge(reports, cmd.mode);
      let challengeHeld = false;
      // 鲁棒性兜底：整个幕二非关键路径——质询官/答辩任何失败都只记录、不终止全场
      if (decision.challenge && seats.challenger && !suspectKeys.has('challenger')) {
        try {
          challengeHeld = true;
          progress(meetingId, `幕二触发质询：${decision.reason}`);
          const act2a = await dispatch(meetingId, scene.buildAct2ChallengePrompt(`@${seats.challenger.memberId}`));
          const attackText = resultText(act2a, seats.challenger.sid);
          attackJson = scene.extractJsonBlock(attackText);
          if (!attackText || attackText.trim().length < 20) {
            challengeHeld = false;
            progress(meetingId, '质询官本轮缺席（超时），跳过质询直接裁决');
          } else {
            const targets = [...new Set(((attackJson && attackJson.targets) || [])
              .map(t => t && t.seat).filter(k => scene.ANALYST_KEYS.includes(k) && seats[k]))];
            const defendKeys = targets.length ? targets : scene.ANALYST_KEYS.filter(k => seats[k] && reports[k] && reports[k].valid);
            const activeDefendKeys = defendKeys.filter(k => seats[k] && seats[k].kind !== 'codex');
            const compressedDefendKeys = defendKeys.filter(k => seats[k] && seats[k].kind === 'codex');
            if (compressedDefendKeys.length) {
              progress(meetingId, `幕二答辩压缩：${compressedDefendKeys.map(k => scene.SEATS[k].label).join('、')} 已有幕一主报告，本轮不二次唤醒 Codex，主席按原报告+质询裁决`);
            }
            if (activeDefendKeys.length) {
              checkDeadline('幕二答辩');
              const mentions = activeDefendKeys.map(k => `@${seats[k].memberId}`).join(' ');
              const act2b = await dispatch(meetingId, scene.buildAct2DefensePrompt(
                mentions, attackJson && attackJson.summary), RETRY_TIMEOUT_MS);
              // 答辩中允许修正 JSON
              for (const k of activeDefendKeys) {
                const t = resultText(act2b, seats[k].sid);
                if (t && t.trim()) defenseBySeat[k] = t.trim().slice(0, 600);
                const updated = scene.extractJsonBlock(t);
                if (updated) {
                  const v = scene.validateAnalystReport(updated, k);
                  if (v.ok) {
                    reports[k] = { ...reports[k], json: updated, valid: true, errors: [] };
                    // 答辩修正了 JSON → 重发该席研判卡，实时刷新
                    progress(meetingId, `${scene.SEATS[k].label} 答辩后修正：${updated.signal || '—'} / 信心 ${updated.confidence ?? '—'}`,
                      { stage: 'analyst', seat: k, label: scene.SEATS[k].label, report: reportToCard(reports[k]) });
                  }
                }
              }
            }
          }
          if (challengeHeld) {
            progress(meetingId, `幕二质询完成：${(attackJson && attackJson.summary) || '已质询'}`, {
              stage: 'challenge', held: true, reason: decision.reason,
              priced_in_risk: (attackJson && attackJson.priced_in_risk) || null,
              attack: attackJson || null,
              defenses: defenseBySeat,
            });
          }
        } catch (e) {
          if (isCommitteeAbort(e)) throw e;
          challengeHeld = false;
          warn('幕二异常（不阻塞，直接进裁决）：', e.message);
          progress(meetingId, `幕二异常已跳过（${e.message}），直接进入主席裁决`);
        }
      } else {
        progress(meetingId, `幕二跳过：${decision.reason}${seats.challenger ? (suspectKeys.has('challenger') ? '（质询官点名未应答）' : '') : '（且质询官席位缺席）'}`);
      }

      // ---- 幕三 主席裁决 ----
      checkDeadline('幕三');
      const storyLevelPure = !!(reports.fund && reports.fund.json &&
        reports.fund.json.extras && reports.fund.json.extras.story_level === '纯故事');
      // 机器加权基线（反 sycophancy 锚）：注入主席 prompt，偏离须说明
      const baseline = scene.aggregateSignals(reports);
      progress(meetingId, `机器加权基线：${baseline.direction}（净分 ${baseline.net_score}，共识 ${baseline.consensus}%）`, {
        stage: 'baseline', baseline,
      });
      progress(meetingId, '幕三：主席裁决中...');
      let verdict = null;
      let chairText = '';
      let v = { ok: false, errors: ['未开始'] };
      for (let attempt = 0; attempt <= MAX_VALIDATION_RETRIES; attempt++) {
        const prompt = attempt === 0
          ? scene.buildAct3ChairPrompt(`@${seats.chair.memberId}`, {
              maxRating, challengeHeld, baseline,
              calibrationActive: /校准期进行中/.test(prep.markdown),
            })
          : [`【投委会 · 幕三 · 裁决退回】 @${seats.chair.memberId}`,
             '决议 JSON 校验失败：' + v.errors.join('；') + '。请只重新输出修正后的 ```json 块。'].join('\n');
        // 鲁棒性兜底：主席是唯一关键路径——派发失败（no_sent/busy 等瞬态）等 20s 重试一次再放弃
        let act3 = null;
        for (let d = 1; d <= CHAIR_DISPATCH_ATTEMPTS; d++) {
          try { act3 = await dispatch(meetingId, prompt); break; }
          catch (e) {
            if (isCommitteeAbort(e)) throw e;
            warn(`幕三派发失败 #${d}：`, e.message);
            if (d === CHAIR_DISPATCH_ATTEMPTS) throw e;
            progress(meetingId, `主席派发失败（${e.message}），20s 后重试...`);
            await waitWithCommitteeCancellation(meetingId, 20000);
          }
        }
        chairText = resultText(act3, seats.chair.sid) || chairText;
        verdict = scene.extractJsonBlock(chairText) || verdict;
        v = scene.validateVerdict(verdict, { maxRating, storyLevelPure, validMemoryIds });
        if (v.ok) break;
        progress(meetingId, `主席决议校验未过：${v.errors.join('；')}`);
        checkDeadline('幕三重试');
      }

      // 裁决完成 → 发结构化英雄卡事件（实时呈现评级/价值投机四格，无需等落盘）
      if (v.ok && verdict) {
        progress(meetingId, `幕三裁决完成：${verdict.rating} 级 ${verdict.core_thesis || ''}`,
          { stage: 'verdict', verdict });
      }

      // ---- 落盘 + 回执 ----
      let saved = { ok: false, error: '决议未通过校验，未落盘' };
      if (v.ok && verdict) {
        throwIfCommitteeCancelled(meetingId);
        const record = {
          symbol: prep.symbol, name: prep.name, mode: cmd.mode,
          rating: verdict.rating, core_thesis: verdict.core_thesis,
          faces: verdict.faces, entry: verdict.entry, stop: verdict.stop,
          value_speculation: verdict.value_speculation,
          portfolio: verdict.portfolio,
          position_cap: verdict.position_cap || null,
          catalysts: verdict.catalysts || [],
          disagreements: verdict.disagreements || [],
          alt_check: verdict.alt_check,
          assumptions: verdict.assumptions || [],
          kill_switch_summary: verdict.kill_switch_summary || [],
          upgrade_trigger: verdict.upgrade_trigger || null,
          if_holding: verdict.if_holding || null,
          if_not_holding: verdict.if_not_holding || null,
          memory_read: verdict.memory_read || [],
          challenge_held: challengeHeld,
          objective: prep.objective,
          coverage_gate: prep.coverage_gate,
          seats: Object.fromEntries(Object.entries(reports).map(([k, r]) => [k, {
            kind: r.kind,
            signal: r.json ? r.json.signal : 'errored',
            confidence: r.json ? r.json.confidence : null,
            story_level: (r.json && r.json.extras && r.json.extras.story_level) || undefined,
          }])),
        };
        const tmp = path.join(os.tmpdir(), `committee-verdict-${Date.now()}.json`);
        fs.writeFileSync(tmp, JSON.stringify(record), 'utf-8');
        saved = await runPython(['-m', 'committee.committee_memory', 'append-verdict', '--file', tmp], MEMORY_TIMEOUT_MS);
        throwIfCommitteeCancelled(meetingId);
        try { fs.unlinkSync(tmp); } catch {}
        if (verdict.lesson_suggest && verdict.lesson_suggest.text && saved.ok) {
          const ltmp = path.join(os.tmpdir(), `committee-lesson-${Date.now()}.json`);
          fs.writeFileSync(ltmp, JSON.stringify({
            ...verdict.lesson_suggest, src_verdicts: [saved.id],
          }), 'utf-8');
          await runPython(['-m', 'committee.committee_memory', 'add-lesson', '--file', ltmp], MEMORY_TIMEOUT_MS);
          throwIfCommitteeCancelled(meetingId);
          try { fs.unlinkSync(ltmp); } catch {}
        }
      }

      // ---- 生成沉浸式单场复盘 HTML（失败不影响会议；用真实 verdict id 命名） ----
      let replayPath = null;
      if (saved.ok && v.ok && verdict) {
        try {
          const transcript = {
            id: saved.id, symbol: prep.symbol, name: prep.name, mode: cmd.mode,
            ts: new Date().toISOString(),
            coverage_gate: prep.coverage_gate || null,
            red_flags: prep.red_flags || [],
            objective: prep.objective || null,
            analysts: Object.fromEntries(scene.ANALYST_KEYS
              .filter(k => reports[k]).map(k => [k, reportToCard(reports[k])])),
            challenge: {
              held: challengeHeld, reason: decision.reason,
              priced_in_risk: (attackJson && attackJson.priced_in_risk) || null,
              pairs: ((attackJson && attackJson.targets) || [])
                .filter(t => t && t.seat)
                .map(t => ({ seat: t.seat, q: t.attack || t.assumption || '', a: defenseBySeat[t.seat] || '' })),
            },
            baseline,
            verdict,
            seats: Object.fromEntries(Object.entries(reports).map(([k, r]) => [k, {
              kind: r.kind, signal: r.json ? r.json.signal : null, confidence: r.json ? r.json.confidence : null,
            }])),
          };
          const ttmp = path.join(os.tmpdir(), `committee-transcript-${Date.now()}.json`);
          fs.writeFileSync(ttmp, JSON.stringify(transcript), 'utf-8');
          const rep = await runPython(['-m', 'committee.replay_gen', 'save', '--file', ttmp], MEMORY_TIMEOUT_MS);
          throwIfCommitteeCancelled(meetingId);
          try { fs.unlinkSync(ttmp); } catch {}
          if (rep && rep.ok) replayPath = rep.html;
        } catch (e) {
          if (isCommitteeAbort(e)) throw e;
          warn('replay 生成失败（不影响会议）：', e.message);
        }
      }

      const receipt = [
        `📥 决议落盘：${saved.ok ? saved.id : '❌ ' + (saved.error || '失败')}`,
        replayPath ? `🎬 沉浸式复盘：${replayPath}` : null,
        `📊 Dashboard：C:\\LinDangAgent\\data\\knowledge\\committee\\dashboard.html`,
        `🗂️ 案卷：${prep.case_path}`,
        `⚔️ 质询：${challengeHeld ? '已触发（' + decision.reason + '）' : '未触发（' + decision.reason + '）'}`,
      ].filter(Boolean).join('\n');
      progress(meetingId, receipt, { stage: 'save', replayPath, dashboardPath: 'C:\\LinDangAgent\\data\\knowledge\\committee\\dashboard.html', casePath: prep.case_path });

      return {
        status: 'completed', turnNum: null,
        meta: {
          committee: {
            symbol: prep.symbol, name: prep.name, mode: cmd.mode,
            rating: v.ok && verdict ? verdict.rating : null,
            verdictId: saved.ok ? saved.id : null,
            challengeHeld,
            verdictValid: v.ok,
            replayPath,
            receipt,
          },
        },
      };
    } catch (e) {
      warn('session failed:', e.message);
      if (isCommitteeAbort(e)) {
        return { status: e.status, turnNum: null, reason: e.message, superseded: e.status === 'superseded' };
      }
      return { status: 'error', turnNum: null, reason: `投委会中断：${e.message}` };
    } finally {
      inProgress.delete(meetingId);
      cancellationByMeeting.delete(meetingId);
    }
  }

  // ── 持仓体检会（2026-06-12）────────────────────────────────────────────────
  // 流程：主席 Read 截图提取持仓 → 逐票快速备料（并行）→ 基本面官+技术面官
  // 跑卖出正反双清单 → 主席逐票裁 持有/加/减/清 → 落盘 checkup 记录。
  async function runCheckupSession(meetingId, checkup) {
    if (inProgress.has(meetingId)) return { status: 'busy', reason: '本会议已有投委会在进行', turnNum: null };
    const meeting = meetingManager.getMeeting(meetingId);
    const seats = resolveSeats(meeting);
    if (!seats.chair || !seats.fund || !seats.tech) {
      return { status: 'error', turnNum: null, reason: '体检需要 基本面官(deepseek)+技术面官(codex)+主席(claude) 三席在场' };
    }
    cancellationByMeeting.delete(meetingId);
    inProgress.add(meetingId);
    const deadline = Date.now() + SESSION_DEADLINE_MS;
    const checkDeadline = (stage) => {
      throwIfCommitteeCancelled(meetingId);
      if (Date.now() > deadline) throw new Error(`体检整场超时（40min）于 ${stage}`);
    };
    try {
      // ── 识别：截图 → 持仓 JSON（主席有 Read+视觉；纯文本命令则跳过此步） ──
      let positions = checkup.positions || null;
      if (checkup.imagePath) {
        progress(meetingId, `持仓识别：主席 Read ${checkup.imagePath}`);
        let ocr = null, v = { ok: false, errors: ['未开始'] };
        for (let attempt = 0; attempt <= 1; attempt++) {
          const prompt = attempt === 0
            ? scene.buildCheckupOcrPrompt(`@${seats.chair.memberId}`, checkup.imagePath)
            : [`【投委会 · 持仓体检 · 识别重试】 @${seats.chair.memberId}`,
               'JSON 校验失败：' + v.errors.join('；') + '。请重新只输出修正后的 ```json 块。'].join('\n');
          const r = await dispatch(meetingId, prompt, CHECKUP_OCR_TIMEOUT_MS, {
            targetMemberIds: [seats.chair.memberId],
            silent: true,
            allowActiveExtend: false,
          });
          ocr = scene.extractJsonBlock(resultText(r, seats.chair.sid)) || ocr;
          v = scene.validateCheckupOcr(ocr);
          if (v.ok) break;
        }
        if (!v.ok) return { status: 'error', turnNum: null, reason: `持仓识别失败：${v.errors.join('；')}` };
        positions = scene.normalizeCheckupPositions(ocr).positions;
      }
      if (!positions || !positions.length) {
        return { status: 'error', turnNum: null, reason: '没有可体检的持仓' };
      }

      // ── 逐票快速备料（并行 spawn python，--fast） ──
      checkDeadline('备料');
      progress(meetingId, `逐票备料：${positions.map(p => p.symbol).join(' ')}（快评模式并行）`);
      const preps = await Promise.all(positions.map(p =>
        runPython(['-m', 'committee.prep_case', String(p.symbol), '--fast'], PREP_TIMEOUT_MS.quick)
          .then(r => ({ symbol: p.symbol, prep: r }))));
      throwIfCommitteeCancelled(meetingId);
      const casesMarkdown = preps
        .map(x => x.prep && x.prep.ok ? x.prep.markdown : `# ${x.symbol} 案卷生成失败：${(x.prep && x.prep.error) || '未知'}`)
        .join('\n\n---\n\n');
      const positionsBrief = positions.map(p =>
        `- ${p.name || ''} ${p.symbol}：持仓 ${p.shares ?? '?'} 股，成本 ${p.cost ?? '?'}，现价 ${p.price ?? '?'}，盈亏 ${p.pnl_pct ?? '?'}%`).join('\n');

      // ── 双官体检（并行一轮） ──
      checkDeadline('研判');
      const mentions = `@${seats.fund.memberId} @${seats.tech.memberId}`;
      progress(meetingId, `体检研判：${mentions}`);
      const act = await dispatch(meetingId, scene.buildCheckupAnalystPrompt(mentions, positionsBrief, casesMarkdown));
      // 体检报告轻校验：拿得到 JSON 就给主席，缺席由主席声明（体检容错优先）
      const fundJson = scene.extractJsonBlock(resultText(act, seats.fund.sid));
      const techJson = scene.extractJsonBlock(resultText(act, seats.tech.sid));

      // ── 主席裁决 ──
      checkDeadline('裁决');
      progress(meetingId, '体检裁决：主席逐票定动作...');
      const expected = positions.map(p => String(p.symbol));
      let verdict = null, v2 = { ok: false, errors: ['未开始'] };
      for (let attempt = 0; attempt <= MAX_VALIDATION_RETRIES; attempt++) {
        const prompt = attempt === 0
          ? scene.buildCheckupChairPrompt(`@${seats.chair.memberId}`)
          : [`【投委会 · 持仓体检 · 裁决退回】 @${seats.chair.memberId}`,
             '校验失败：' + v2.errors.join('；') + '。请只重新输出修正后的 ```json 块。'].join('\n');
        const r = await dispatch(meetingId, prompt);
        verdict = scene.extractJsonBlock(resultText(r, seats.chair.sid)) || verdict;
        v2 = scene.validateCheckupVerdict(verdict, expected);
        if (v2.ok) break;
        progress(meetingId, `体检裁决校验未过：${v2.errors.join('；')}`);
      }

      // ── 落盘（type=checkup 行，append-only；dashboard 单列体检区由 report 渲染） ──
      let saved = { ok: false, error: '裁决未过校验，未落盘' };
      if (v2.ok && verdict) {
        const record = {
          type: 'checkup',
          ts_hint: 'committee_memory 会补 ts',
          positions,
          checkups: verdict.checkups,
          portfolio_note: verdict.portfolio_note || null,
          portfolio_risk: verdict.portfolio_risk || null,
          seats_present: { fund: !!fundJson, tech: !!techJson },
        };
        const tmp = path.join(os.tmpdir(), `committee-checkup-${Date.now()}.json`);
        fs.writeFileSync(tmp, JSON.stringify(record), 'utf-8');
        saved = await runPython(['-m', 'committee.committee_memory', 'append-checkup', '--file', tmp], MEMORY_TIMEOUT_MS);
        throwIfCommitteeCancelled(meetingId);
        try { fs.unlinkSync(tmp); } catch {}
      }
      progress(meetingId, `📥 体检落盘：${saved.ok ? saved.id : '❌ ' + (saved.error || '失败')}\n📊 Dashboard：C:\\LinDangAgent\\data\\knowledge\\committee\\dashboard.html`);
      return {
        status: 'completed', turnNum: null,
        meta: { committee: { kind: 'checkup', n: positions.length, verdictValid: v2.ok, checkupId: saved.ok ? saved.id : null } },
      };
    } catch (e) {
      warn('checkup failed:', e.message);
      if (isCommitteeAbort(e)) {
        return { status: e.status, turnNum: null, reason: e.message, superseded: e.status === 'superseded' };
      }
      return { status: 'error', turnNum: null, reason: `体检中断：${e.message}` };
    } finally {
      inProgress.delete(meetingId);
      cancellationByMeeting.delete(meetingId);
    }
  }

  return {
    isCommitteeCommand,
    runCommitteeSession,
    cancelCommitteeSession,
    _dispatchForTest: dispatch,
    _resolveSeats: resolveSeats,
    _resolveCommitteeRoute: resolveCommitteeRoute,
  };
}

// 从案卷 markdown 提取合法记忆 ID（主席 memory_read 防编造）
function extractMemoryIds(markdown) {
  const ids = new Set();
  const re = /\b([VLT]-[0-9A-Za-z\-]+)\b/g;
  let m;
  while ((m = re.exec(markdown || '')) !== null) ids.add(m[1]);
  return [...ids];
}

module.exports = { createCommitteeConductor, _extractMemoryIds: extractMemoryIds };
