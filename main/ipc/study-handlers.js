'use strict';
// main/ipc/study-handlers.js
//
// 学习 Tab 的编排器（2026-09-01）。
//
// 职责：把 core/study-workflow.js 定义的三棒串行工作流，落到两个**真实的 Hub Session**上。
//
//   T1 draft    → Claude Session
//   T2 review   → Codex  Session
//   T3 finalize → Claude Session（同一个）
//
// ── 架构边界（用户明确要求，不能破）────────────────────────────
// Claude **不去调用** Codex。两个都是普通 Hub Session：有卡片、有 PTY、有历史、
// 可恢复、可休眠、可随时插话，与 Agent 联赛的参赛 Agent 完全同构。
// 编排器住在这里（主进程），按棒次分别向两个 Session 的 PTY 写 prompt，
// 等各自的 transcript 级 turn-complete，再把上一棒的产出交给下一棒。
// 用 `codex exec` 之类的子进程调用是错的：那样 Codex 没有会话实体，用户碰不到。
// ──────────────────────────────────────────────────────────────
//
// Session 生命周期、CLI 就绪判定和 Codex 的启动兜底，都照抄
// main/ipc/agent-league-handlers.js 里已经在生产跑住的做法（见各处注释标注）。
// 刻意复制而不是抽公共模块：今晚要的是不出回归，改动生产代码风险更大。

const fs = require('fs');
const path = require('path');

const { createStudyStore, AGENT_ROLES, ROLE_KIND, ROLE_LABEL } = require('../../core/study-store.js');
const workflow = require('../../core/study-workflow.js');
const { waitCliReady, sendToPty } = require('../../core/group-chat-watcher.js');
const { DEFAULT_MODEL_BY_KIND } = require('../../core/model-options.js');
const { stripAnsi } = require('../../core/ansi-utils.js');

const DEFAULT_STUDY_ROOT = process.env.AGENT_STUDY_DIR || 'C:\\Vibe\\AI\\agent-study';
const SESSION_PURPOSE = 'study-companion';
const SESSION_TITLE_PREFIX = '学习';

// 与联赛同源：冷启动 Codex + 忙碌 Windows 主机可能超过单个 60s 窗口。
// 前三个短探测命中就快速返回，不会拖慢正常路径。
const CLI_READY_WINDOWS_MS = [10000, 18000, 32000, 60000];

// turn-complete 到了但产物没齐时，允许推一次「继续」。
// 只推一次：推两次以上通常说明它卡在一个它自己解不开的问题上，
// 继续推只是烧 token，不如失败掉让人看 PTY。
const NUDGE_LIMIT = 1;
const NUDGE_TEXT = '上一步似乎没有完成（约定的完成口令和产物文件都没检测到）。请继续完成剩余工作，完成后按要求回复完成口令。';

function registerStudyIpc(ipcMain, deps = {}) {
  const {
    sessionManager,
    transcriptTap,
    registerSessionForTap = () => {},
    sendToRenderer = () => {},
    getHubDataDir = () => '',
    logger = console,
  } = deps;

  const waitReady = deps.waitCliReady || waitCliReady;
  const sendPrompt = deps.sendToPty || sendToPty;
  const clock = deps.clock || (() => new Date());

  const stateFile = deps.stateFile
    || path.join(getHubDataDir() || process.cwd(), 'study', 'study-state.json');
  const store = createStudyStore({ stateFile, studyRoot: deps.studyRoot || DEFAULT_STUDY_ROOT });

  /** hubSessionId → { role, stage, date, lessonId, startedAt, timer, nudges, processing } */
  const pendingByHubSession = new Map();
  // 每个会话收到过多少次 transcript 级 turn-complete。
  // 用途是验证「这个 Agent 真的跑过一轮」——PTY 缓冲里全是 TUI 重绘序列，
  // 靠抓回令文本判断很不可靠（2026-09-01 实测踩过）。
  const turnCounts = new Map();
  let currentRun = null;      // { date, lessonId, trigger, stage }
  let running = false;        // 单飞：同一时刻只允许一个 run

  const emit = (type, payload) => {
    try { sendToRenderer('study-event', { type, ...payload }); } catch { /* 渲染进程可能还没起来 */ }
  };

  /* ─────────────────────── 课程解析 ─────────────────────── */

  function studyRoot() {
    return store.getStudyRoot() || DEFAULT_STUDY_ROOT;
  }

  /** 从 PLAN.md 表格里按顺序取出课程号。格式我们自己定的，容忍 **L5** 这种加粗写法。 */
  function planLessonIds() {
    const planFile = path.join(studyRoot(), 'PLAN.md');
    if (!fs.existsSync(planFile)) return [];
    const ids = [];
    const seen = new Set();
    for (const line of fs.readFileSync(planFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\|\s*\*{0,2}(L\d+)\*{0,2}\s*\|/);
      if (m && !seen.has(m[1])) { seen.add(m[1]); ids.push(m[1]); }
    }
    return ids;
  }

  /** 已经出过成品的课程号（只认最终 HTML，不认 .src.html）。 */
  function builtLessonIds() {
    const daysDir = path.join(studyRoot(), 'days');
    if (!fs.existsSync(daysDir)) return new Set();
    const out = new Set();
    for (const f of fs.readdirSync(daysDir)) {
      if (!f.endsWith('.html') || f.endsWith('.src.html')) continue;
      const m = f.match(/-(L\d+)\.html$/);
      if (m) out.add(m[1]);
    }
    return out;
  }

  function nextLessonId() {
    const built = builtLessonIds();
    return planLessonIds().find((id) => !built.has(id)) || null;
  }

  function todayDate(now = clock()) {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
    const r = Object.fromEntries(p.map((x) => [x.type, x.value]));
    return `${r.year}-${r.month}-${r.day}`;
  }

  function localMinutes(now = clock()) {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now);
    const r = Object.fromEntries(p.map((x) => [x.type, x.value]));
    return Number(r.hour) * 60 + Number(r.minute);
  }

  /* ─────────────────────── Session 生命周期 ───────────────────────
   * 照抄 agent-league-handlers.js 的 createNativeSession / ensureAgentSession。
   * 两个要点必须保留：
   *   1) Claude 必须 autonomous=true —— 它同时关掉 fast 模式。fast 可能不落
   *      transcript jsonl，transcript-tap 收不到 turn-complete，编排器会直接挂死。
   *   2) 已持久化 Hub ID 但从未拿到 provider-native SID 时，原地 fresh start，
   *      绝不走通用 resume——否则 Codex 会退化成 picker，自动 prompt 全落进选择器。
   */

  function runtimeOptions(kind) {
    if (kind === 'claude') {
      // autonomous 一并落实：权限旁路 + 关 fast + plugin 隔离 + strict MCP
      return { autonomous: true, mcpProfile: 'none' };
    }
    if (kind === 'codex') {
      // 学习 Agent 不需要投研 MCP，用 none 把工具面收到最小，少一个失败点。
      // 生图是 Codex 内置能力，不受 mcpProfile 影响。
      return { codexBypassApprovals: true, mcpProfile: 'none' };
    }
    return {};
  }

  function nativeSessionMeta(session) {
    if (!session) return null;
    return {
      hubSessionId: session.id,
      kind: session.kind || '',
      claudeSid: session.claudeSid || '',
      codexSid: session.codexSid || '',
      cwd: session.cwd || '',
      title: session.title || '',
    };
  }

  function createRoleSession(role) {
    if (!sessionManager) throw new Error('session-manager-unavailable');
    const agent = store.getAgent(role);
    const kind = ROLE_KIND[role];
    const existingHubId = String(agent.sessionId || '');
    const options = {
      ...(existingHubId ? { id: existingHubId } : {}),
      cwd: studyRoot(),
      title: `${SESSION_TITLE_PREFIX} · ${ROLE_LABEL[role]}`,
      model: DEFAULT_MODEL_BY_KIND[kind],
      userRenamed: true,
      purpose: SESSION_PURPOSE,
      hiddenFromSidebar: false,
      ...runtimeOptions(kind),
    };
    const session = sessionManager.createSession(kind, options);
    registerSessionForTap(session);
    sendToRenderer('session-created', { session });
    store.bindSession(role, { sessionId: session.id, status: 'active', nativeSession: nativeSessionMeta(session) });
    emit('session-updated', { role, session: nativeSessionMeta(session) });
    return session;
  }

  function ensureRoleSession(role) {
    const agent = store.getAgent(role);
    const hubId = String(agent.sessionId || '');
    const live = hubId && sessionManager ? sessionManager.getSession(hubId) : null;
    if (live) {
      // 从未完成过原生 turn 的会话，通用 resume 会把 Codex 降级成 picker。
      const pickerLikeUnbound = live.codexAllowMtimeFallback === true || /-resume$/.test(String(live.kind || ''));
      if (pickerLikeUnbound && !live.codexSid && !live.claudeSid) {
        sessionManager.closeSession(hubId);
        return createRoleSession(role);
      }
      store.bindSession(role, { status: live.status || 'active', nativeSession: nativeSessionMeta(live) });
      return live;
    }
    return createRoleSession(role);
  }

  /**
   * CLI 就绪等待。Codex 专属兜底：Hub 写入了很长的启动命令，但 PowerShell 的
   * 粘贴处理把结尾换行吞了，于是命令停在提示符上没执行。只在**还没有 native SID**
   * 时补一个孤立的 CR/LF——一旦 Codex 已经起来，这个 Enter 只会干扰 TUI。
   * （现象与修法来自 agent-league-handlers.js，原样保留。）
   */
  async function waitForCliReady(sessionId, kind, label) {
    const codexRuntime = kind === 'codex' || kind === 'deepseek';
    const windows = codexRuntime ? CLI_READY_WINDOWS_MS : [...CLI_READY_WINDOWS_MS, 60000];
    for (let i = 0; i < windows.length; i += 1) {
      if (await waitReady(sessionId, kind, windows[i])) return true;
      if (!codexRuntime || i >= windows.length - 1) continue;
      if (!sessionManager || typeof sessionManager.writeToSession !== 'function') continue;
      const live = typeof sessionManager.getSession === 'function' ? sessionManager.getSession(sessionId) : null;
      if (live && live.codexSid) continue;   // 已起来了，别捣乱
      const signal = i === 0 ? '\r' : '\n';
      logger.warn(`[study] ${label} CLI 未就绪，补发孤立 ${signal === '\r' ? 'CR' : 'LF'}（${String(sessionId).slice(0, 8)}）`);
      sessionManager.writeToSession(sessionId, signal);
    }
    return false;
  }

  function promptWasSubmitted(result) {
    return !!result && result.ok !== false && result.sendStatus !== 'stuck';
  }

  /* ─────────────────────── 棒次推进 ─────────────────────── */

  function clearPending(sessionId) {
    const p = pendingByHubSession.get(sessionId);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    pendingByHubSession.delete(sessionId);
  }

  function clearAllPending() {
    for (const sid of [...pendingByHubSession.keys()]) clearPending(sid);
  }

  function failRun(stage, message) {
    if (currentRun) {
      store.markStage(currentRun.date, stage, { status: 'failed', error: message });
      store.finishRun(currentRun.date, 'failed', message);
      emit('stage-failed', { date: currentRun.date, stage, message });
      logger.warn(`[study] ${currentRun.date} ${stage} 失败：${message}`);
    }
    clearAllPending();
    currentRun = null;
    running = false;
  }

  /** 这一棒的产物齐了吗？turn-complete 只说明「话说完了」，不说明「活干完了」。 */
  function artifactsReady(stage) {
    if (!currentRun) return false;
    const root = studyRoot();
    const files = workflow.stageArtifacts(stage, root, currentRun.date, currentRun.lessonId);
    const missing = files.filter((f) => !fs.existsSync(f));

    // review 棒还要校验图片是不是真画出来了。
    // 需要哪些图**以 .src.html 里的 @@IMG:name@@ 占位为准**，不以 figures.json 为准——
    // 占位符才是 build-lesson.js 构建时的真实依据；任务单只是给 Codex 看的说明，
    // 万一它被写成对象而不是数组，按任务单校验会空过，等构建时才炸。
    // 不查的话「写了审阅但没画图」会被算作成功，失败归因错位到 finalize 头上。
    if (stage === 'review') {
      const p = workflow.lessonPaths(root, currentRun.date, currentRun.lessonId);
      try {
        if (fs.existsSync(p.srcHtml)) {
          const src = fs.readFileSync(p.srcHtml, 'utf8');
          const names = [...new Set([...src.matchAll(/@@IMG:([A-Za-z0-9_-]+)@@/g)].map((m) => m[1]))];
          for (const name of names) {
            const png = path.join(p.assetDir, `${name}.png`);
            if (!fs.existsSync(png)) missing.push(png);
          }
        }
      } catch (e) {
        missing.push(`${p.srcHtml}（读取失败：${e && e.message}）`);
      }
    }
    return { ok: missing.length === 0, missing };
  }

  async function startStage(stage) {
    if (!currentRun) return;
    const meta = workflow.STAGE_META[stage];
    const role = meta.actor === 'claude' ? 'author' : 'reviewer';
    const kind = ROLE_KIND[role];

    const session = ensureRoleSession(role);
    currentRun.stage = stage;
    store.markStage(currentRun.date, stage, { status: 'running', actor: meta.actor, sessionId: session.id });
    emit('stage-started', { date: currentRun.date, lessonId: currentRun.lessonId, stage, role, sessionId: session.id });

    const pending = {
      role, stage,
      date: currentRun.date,
      lessonId: currentRun.lessonId,
      startedAt: Date.now(),
      nudges: 0,
      processing: false,
      timer: null,
      // 竞态防护：CLI 就绪等待可能长达数分钟，这期间会话可能因为别的原因
      // （启动回显、用户自己插了一句）冒出 turn-complete。prompt 真正提交之前
      // 到达的完成事件一律不算数，否则会在还没派活时就误判「这一棒没干完」并去推它。
      promptSent: false,
    };
    // 先登记再发送：turn-complete 可能在 await 返回前就到（短任务）。
    pendingByHubSession.set(session.id, pending);
    pending.timer = setTimeout(() => {
      if (pendingByHubSession.get(session.id) !== pending) return;
      failRun(stage, `${meta.label} 超过 ${Math.round(meta.timeoutMs / 60000)} 分钟未完成；Session 已保留，可打开 PTY 检查后重跑。`);
    }, meta.timeoutMs);

    const ready = await waitForCliReady(session.id, kind, meta.label);
    if (!ready) {
      clearPending(session.id);
      failRun(stage, `${kind} CLI 未在就绪窗口内启动`);
      return;
    }

    const prompt = workflow.buildStagePrompt(stage, {
      studyRoot: studyRoot(), date: currentRun.date, lessonId: currentRun.lessonId,
    });
    // sendToPty 内部已处理 Codex 的非 ASCII prompt（落文件 + 发指针）
    // 以及 paste/Enter 必须分两次写的历史坑，这里不要自己拼 prompt + '\r'。
    const sent = await sendPrompt(session.id, prompt, kind);
    if (!promptWasSubmitted(sent)) {
      clearPending(session.id);
      failRun(stage, `${meta.label} 的 prompt 写入 PTY 后未确认 turn 启动`);
      return;
    }
    // 派活成功之后才开始认这条会话的 turn-complete
    if (pendingByHubSession.get(session.id) === pending) pending.promptSent = true;
  }

  function advanceOrFinish(stage) {
    const next = workflow.stageAfter(stage);
    if (!next) {
      const date = currentRun.date;
      const lessonId = currentRun.lessonId;
      store.finishRun(date, 'done');
      emit('run-finished', { date, lessonId, status: 'done' });
      logger.log(`[study] ${date} ${lessonId} 三棒完成`);
      clearAllPending();
      currentRun = null;
      running = false;
      return;
    }
    startStage(next).catch((e) => failRun(next, e && e.message ? e.message : String(e)));
  }

  // replyText 直接取自 turn-complete 事件的 text 字段——transcript-tap 已经做了
  // 终态过滤（只接受 stop_reason 终止的消息，不会把 tool_use 中间的「我先读取…」
  // 当成本轮答案），比自己再去读一遍 transcript 更准也更省事。
  async function handleTurnComplete(hubSessionId, replyText = '') {
    const pending = pendingByHubSession.get(hubSessionId);
    if (!pending || pending.processing) return;
    if (!pending.promptSent) return;   // prompt 还没发出去，这条完成事件不是我们的
    if (!currentRun || pending.date !== currentRun.date || pending.stage !== currentRun.stage) return;
    pending.processing = true;

    const { stage } = pending;
    const reply = String(replyText || '');

    const signalled = workflow.detectStageDone(stage, reply);
    const artifacts = artifactsReady(stage);

    // 双重判定：完成口令 + 产物文件。任一缺失都不算干完。
    // 只有口令没产物 → 它以为做完了但文件没落盘，属于真失败，别放过。
    if (signalled && artifacts.ok) {
      clearPending(hubSessionId);
      store.markStage(pending.date, stage, { status: 'done' });
      emit('stage-done', { date: pending.date, stage });
      advanceOrFinish(stage);
      return;
    }

    if (pending.nudges < NUDGE_LIMIT) {
      pending.nudges += 1;
      pending.processing = false;
      const why = !signalled ? '未见完成口令' : `缺产物：${artifacts.missing.map((f) => path.basename(f)).join('、')}`;
      logger.warn(`[study] ${stage} ${why}，推一次继续（第 ${pending.nudges} 次）`);
      emit('stage-nudged', { date: pending.date, stage, reason: why, attempt: pending.nudges });
      const kind = ROLE_KIND[pending.role];
      const nudge = `${NUDGE_TEXT}\n（检测到的问题：${why}）`;
      sendPrompt(hubSessionId, nudge, kind).catch((e) => {
        failRun(stage, `推进提示发送失败：${e && e.message}`);
      });
      return;
    }

    const why = !signalled ? '未见完成口令' : `缺产物：${artifacts.missing.map((f) => path.basename(f)).join('、')}`;
    clearPending(hubSessionId);
    failRun(stage, `${workflow.STAGE_META[stage].label} 推进一次后仍未完成（${why}）`);
  }

  /* ─────────────────────── run 入口 ─────────────────────── */

  async function runToday(options = {}) {
    if (running) return { ok: false, error: 'already-running', stage: currentRun && currentRun.stage };
    const date = options.date || todayDate();
    const lessonId = options.lessonId || nextLessonId();
    if (!lessonId) return { ok: false, error: 'no-lesson-left', message: '20 课已全部生成完毕' };

    const root = studyRoot();
    if (!fs.existsSync(root)) return { ok: false, error: 'study-root-missing', message: `学习项目目录不存在：${root}` };

    running = true;
    const stages = workflow.STAGES.map((s) => [s, workflow.STAGE_META[s].actor]);
    const run = store.startRun(date, lessonId, options.trigger || 'manual', stages);
    currentRun = { date, lessonId, trigger: options.trigger || 'manual', stage: '' };
    emit('run-started', { date, lessonId, trigger: currentRun.trigger });

    // 补跑时跳过已经 done 的棒（例如半夜画好了图但定稿失败）
    const firstPending = workflow.STAGES.find((s) => !run.stages[s] || run.stages[s].status !== 'done');
    if (!firstPending) {
      store.finishRun(date, 'done');
      currentRun = null; running = false;
      return { ok: true, date, lessonId, alreadyDone: true };
    }
    try {
      await startStage(firstPending);
    } catch (e) {
      failRun(firstPending, e && e.message ? e.message : String(e));
      return { ok: false, error: 'stage-start-failed', message: e && e.message };
    }
    return { ok: true, date, lessonId, stage: firstPending };
  }

  /* ─────────────────────── 调度 ─────────────────────── */

  function shouldRunNow(now = clock()) {
    const sch = store.getSchedule();
    if (!sch.enabled) return false;
    const date = todayDate(now);
    const run = store.getRun(date);
    if (run && (run.status === 'done' || run.status === 'running')) return false;
    if (!nextLessonId()) return false;
    return localMinutes(now) >= (Number(sch.hour) * 60 + Number(sch.minute));
  }

  async function schedulerTick(now = clock()) {
    if (running) return { ok: true, skipped: 'running' };
    if (!shouldRunNow(now)) return { ok: true, skipped: 'not-due' };
    return runToday({ trigger: 'scheduler' });
  }

  // 60 秒 tick，与联赛同频。0 点没开 Hub 时，早上第一次 tick 就会补跑
  // （shouldRunNow 只看「今天这一课有没有出」，不看是不是刚好 0 点）。
  const schedulerTimer = setInterval(() => {
    schedulerTick().catch((e) => logger.warn('[study] scheduler tick failed:', e && e.message));
  }, 60 * 1000);
  if (schedulerTimer.unref) schedulerTimer.unref();

  /* ─────────────────────── transcript 事件 ─────────────────────── */

  if (transcriptTap && typeof transcriptTap.on === 'function') {
    transcriptTap.on('turn-complete', (event = {}) => {
      const sid = event.hubSessionId || event.sessionId;
      if (sid) turnCounts.set(sid, (turnCounts.get(sid) || 0) + 1);
      if (!sid || !pendingByHubSession.has(sid)) return;
      handleTurnComplete(sid, event.text).catch((e) => logger.warn('[study] turn-complete 处理失败:', e && e.message));
    });
    transcriptTap.on('turn-error', (event = {}) => {
      const sid = event.hubSessionId || event.sessionId;
      const pending = sid && pendingByHubSession.get(sid);
      if (!pending) return;
      clearPending(sid);
      failRun(pending.stage, `${ROLE_LABEL[pending.role]} 这一轮报错：${event.message || 'turn-error'}`);
    });
  }

  // Session 在半途退出（用户关了、CLI 崩了）时，pending 会永远等到超时才失败。
  // 显式接住它：立刻失败并说清原因，比让人等 40 分钟强。
  if (sessionManager && typeof sessionManager.on === 'function') {
    sessionManager.on('session-exited', (event = {}) => {
      const sid = event.sessionId;
      const pending = sid && pendingByHubSession.get(sid);
      if (!pending) return;
      clearPending(sid);
      store.bindSession(pending.role, { status: 'restorable' });
      failRun(pending.stage, `${ROLE_LABEL[pending.role]} 的 Session 在这一棒完成前退出；恢复后可重跑当日生成。`);
    });
  }

  /* ─────────────────────── 对外读接口 ─────────────────────── */

  /** 从成品 HTML 的 <h1> 取标题，取不到就退回文件名——面板要显示人话，不是 L2.html。 */
  function lessonTitle(file) {
    try {
      const head = fs.readFileSync(file, 'utf8').slice(0, 60000);
      const m = head.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
      if (!m) return '';
      return m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    } catch { return ''; }
  }

  /** 数 review.md 里的意见条数：约定每条是一个 `## N. 标题` 二级标题。 */
  function reviewCount(file) {
    try {
      if (!fs.existsSync(file)) return 0;
      const txt = fs.readFileSync(file, 'utf8');
      return (txt.match(/^##\s+\d+\./gm) || []).length;
    } catch { return 0; }
  }

  function lessonFiles() {
    const daysDir = path.join(studyRoot(), 'days');
    if (!fs.existsSync(daysDir)) return [];
    return fs.readdirSync(daysDir)
      .filter((f) => f.endsWith('.html') && !f.endsWith('.src.html'))
      .sort().reverse()
      .map((f) => {
        const m = f.match(/^(\d{4}-\d{2}-\d{2})-(L\d+)\.html$/);
        const full = path.join(daysDir, f);
        const review = m ? path.join(daysDir, `${m[1]}-${m[2]}-review.md`) : '';
        return {
          file: f, path: full,
          date: m ? m[1] : '', lessonId: m ? m[2] : '',
          title: lessonTitle(full),
          size: fs.statSync(full).size,
          reviewPath: review,
          reviewCount: review ? reviewCount(review) : 0,
        };
      });
  }

  /**
   * 术语掌握状态。数据源是 terms-state.json（定稿那一棒写），不是 LEARNER.md——
   * 后者是给人读的散文，面板解析不了。
   *
   * 关键口径：**「出过题」不等于「已掌握」**。答题结果目前靠人工把卡片底部的
   * 汇总复制给教练，没回流之前 correct 一律是 0。面板必须如实分开显示这两个数，
   * 不能拿出题数冒充掌握数（这是 LEARNER.md 里已经写死的纪律）。
   */
  function termsState() {
    const file = path.join(studyRoot(), 'terms-state.json');
    const bankFile = path.join(studyRoot(), 'TERMS.json');
    let total = 0;
    try { total = JSON.parse(fs.readFileSync(bankFile, 'utf8')).count || 0; } catch { total = 0; }
    const empty = { total, asked: 0, mastered: 0, wrong: 0, pendingReport: 0, hasData: false };
    try {
      if (!fs.existsSync(file)) return empty;
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      const terms = (j && j.terms) || {};
      let asked = 0; let mastered = 0; let wrong = 0;
      for (const k of Object.keys(terms)) {
        const t = terms[k] || {};
        if (Number(t.asked) > 0) asked += 1;
        if (Number(t.correct) > 0) mastered += 1;
        if (Number(t.wrong) > 0) wrong += 1;
      }
      // reportedLessons 记的是「哪几课的答题结果已经回流」，用来算待回流份数。
      const reported = Array.isArray(j.reportedLessons) ? j.reportedLessons.length : 0;
      return { total, asked, mastered, wrong, reportedLessons: reported, hasData: true, updatedAt: j.updatedAt || '' };
    } catch { return empty; }
  }

  function countLines(file, re) {
    try {
      if (!fs.existsSync(file)) return 0;
      return (fs.readFileSync(file, 'utf8').match(re) || []).length;
    } catch { return 0; }
  }

  function publicState() {
    const s = store.snapshot();
    const agents = AGENT_ROLES.map((role) => {
      const a = s.agents[role];
      const live = a.sessionId && sessionManager ? sessionManager.getSession(a.sessionId) : null;
      return {
        role, kind: a.kind, label: ROLE_LABEL[role],
        sessionId: a.sessionId,
        alive: !!live,
        status: live ? (live.status || 'active') : (a.sessionId ? 'dormant' : 'unbound'),
        title: live ? live.title : '',
      };
    });
    const lessons = lessonFiles();
    const root = studyRoot();
    const plan = planLessonIds();
    const terms = termsState();
    return {
      ok: true,
      studyRoot: root,
      schedule: s.schedule,
      agents,
      running,
      currentRun: currentRun ? { ...currentRun } : null,
      todayDate: todayDate(),
      nextLessonId: nextLessonId(),
      runs: store.listRuns(20),
      lessons,
      planTotal: plan.length,
      terms,
      reviewTotal: lessons.reduce((n, L) => n + (L.reviewCount || 0), 0),
      // 「待回流」= 已出的课里还没拿到答题结果的份数。答题结果靠人工复制转发，
      // 所以这个数字只会因为你把结果发给教练而下降——它就是提醒你去做这件事的。
      pendingReports: Math.max(0, lessons.length - (terms.reportedLessons || 0)),
      insightsCount: countLines(path.join(root, 'INSIGHTS.md'), /^###\s+\d{4}-\d{2}-\d{2}\s+·/gm),
      decisionsCount: countLines(path.join(root, 'DECISIONS.md'), /^###\s+\d{4}-\d{2}-\d{2}\s+·/gm),
    };
  }

  /* ─────────────────────── IPC ─────────────────────── */

  ipcMain.handle('study:state', () => publicState());

  // 只读诊断：每个角色收到过几次 turn-complete。给 E2E 用，也方便排查「派活了但没动静」。
  ipcMain.handle('study:turn-counts', () => {
    const out = {};
    for (const role of AGENT_ROLES) {
      const sid = store.getAgent(role).sessionId;
      out[role] = { sessionId: sid, turns: (sid && turnCounts.get(sid)) || 0 };
    }
    return { ok: true, counts: out };
  });

  ipcMain.handle('study:run-now', async (_e, input = {}) => {
    const r = await runToday({ trigger: 'manual', ...input });
    return { ...r, state: publicState() };
  });

  ipcMain.handle('study:read-lesson', (_e, input = {}) => {
    const target = String(input.path || '');
    const daysDir = path.join(studyRoot(), 'days');
    // 路径守卫：只允许读学习项目 days/ 下的文件
    const resolved = path.resolve(target);
    if (!resolved.startsWith(path.resolve(daysDir) + path.sep)) {
      return { ok: false, error: 'path-outside-days' };
    }
    if (!fs.existsSync(resolved)) return { ok: false, error: 'not-found' };
    return { ok: true, html: fs.readFileSync(resolved, 'utf8'), path: resolved };
  });

  // 右栏输出预览。
  // 刻意不用 'get-session-buffer-snapshot'：那条路径走 terminalSnapshot 压缩进程，
  // 在**没有挂载终端**时返回空串——面板里表现为输出区永远空白（2026-09-01 实测确认：
  // 同一会话 raw ringBuffer 有 12292 字符，snapshot 返回 0）。这里直接读 ringBuffer
  // 并去掉 ANSI 控制序列，作为只读预览足够。真要看完整 TUI 请点「打开完整 PTY」。
  ipcMain.handle('study:agent-output', (_e, input = {}) => {
    const role = String(input.role || '');
    if (!AGENT_ROLES.includes(role)) return { ok: false, error: 'bad-role' };
    const agent = store.getAgent(role);
    if (!agent.sessionId || !sessionManager) return { ok: true, text: '', bound: false };
    const raw = (typeof sessionManager.getSessionBuffer === 'function'
      ? sessionManager.getSessionBuffer(agent.sessionId) : '') || '';
    const tail = String(raw).slice(-20000);
    // TUI 全屏重绘会留下大量空行，压掉连续空行让预览可读
    const text = stripAnsi(tail).replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
    return { ok: true, text, bound: true, rawLength: String(raw).length };
  });

  ipcMain.handle('study:ensure-session', (_e, input = {}) => {
    const role = String(input.role || '');
    if (!AGENT_ROLES.includes(role)) return { ok: false, error: 'bad-role' };
    try {
      const session = ensureRoleSession(role);
      return { ok: true, sessionId: session.id, state: publicState() };
    } catch (e) {
      return { ok: false, error: 'ensure-failed', message: e && e.message };
    }
  });

  // 面板里向某个 Agent 提问。刻意不用裸 'terminal-input'：
  // sendToPty 才处理了 Codex 非 ASCII prompt 落文件、以及 paste 与 Enter 必须
  // 分两次写这两个历史坑，中文提问走裸输入会被 TUI 当粘贴吞掉换行。
  ipcMain.handle('study:ask', async (_e, input = {}) => {
    const role = String(input.role || '');
    const text = String(input.text || '').trim();
    if (!AGENT_ROLES.includes(role)) return { ok: false, error: 'bad-role' };
    if (!text) return { ok: false, error: 'empty' };
    if (running) {
      // 跑棒期间插话会和自动 prompt 抢同一个 PTY，轮次会串。
      const busyRole = currentRun && workflow.STAGE_META[currentRun.stage]
        ? (workflow.STAGE_META[currentRun.stage].actor === 'claude' ? 'author' : 'reviewer')
        : '';
      if (busyRole === role) {
        return { ok: false, error: 'agent-busy', message: `${ROLE_LABEL[role]} 正在跑「${workflow.STAGE_META[currentRun.stage].label}」，等这一棒结束再问。` };
      }
    }
    try {
      const session = ensureRoleSession(role);
      const kind = ROLE_KIND[role];
      const ready = await waitForCliReady(session.id, kind, '提问');
      if (!ready) return { ok: false, error: 'cli-not-ready', message: `${kind} CLI 未就绪` };
      const sent = await sendPrompt(session.id, text, kind);
      if (!promptWasSubmitted(sent)) return { ok: false, error: 'send-failed', message: 'prompt 写入 PTY 后未确认 turn 启动' };
      return { ok: true, sessionId: session.id };
    } catch (e) {
      return { ok: false, error: 'ask-failed', message: e && e.message };
    }
  });

  ipcMain.handle('study:set-schedule', (_e, input = {}) => {
    const patch = {};
    if ('enabled' in input) patch.enabled = !!input.enabled;
    if ('hour' in input) patch.hour = Math.max(0, Math.min(23, Number(input.hour) || 0));
    if ('minute' in input) patch.minute = Math.max(0, Math.min(59, Number(input.minute) || 0));
    store.setSchedule(patch);
    return { ok: true, state: publicState() };
  });

  return {
    store,
    publicState,
    runToday,
    schedulerTick,
    shouldRunNow,
    nextLessonId,
    planLessonIds,
    ensureRoleSession,
    // 跑棒期间保护会话不被自动休眠收走
    getProtectedSessionIds: () => new Set(pendingByHubSession.keys()),
    _test: { pendingByHubSession, handleTurnComplete, artifactsReady, todayDate, localMinutes },
    dispose: () => { clearInterval(schedulerTimer); clearAllPending(); },
  };
}

module.exports = { registerStudyIpc, DEFAULT_STUDY_ROOT, SESSION_PURPOSE };
