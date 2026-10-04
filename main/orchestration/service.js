'use strict';
// AI 编排模式（2026-10-04）：群里的编排员是一个真实 CLI 会话，通过 hub_orchestrator MCP 工具
// 组队、启动交付工作流、单独提问、汇报。Hub 在这里执行硬规矩（计划确认、额度、无进展、结项证据），
// 并把工作流结果、成员回答、田哥的操作排队后在编排员空闲时投递给它。
// 底层复用：交付工作流引擎（delivery-engine）、群聊派发（dispatcher）、成员创建（addMeetingSubInternal）。
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Ledger = require('../../core/orchestration/ledger');
const Store = require('../../core/orchestration/store');
const Prompt = require('../../core/orchestration/prompt');
const BudgetIntent = require('../../core/orchestration/budget-intent');
const Settings = require('../../core/workflow-settings');
const Delivery = require('../../core/delivery-workflow');
const profiles = require('../../core/hub-assistant/profiles');
const { AssistantBridge } = require('../../core/hub-assistant/bridge');

const PURPOSE = 'hub-orchestrator';
const MCP_NAME = 'hub_orchestrator';
const TOOL_NAMES = ['orch_status', 'orch_propose_plan', 'orch_start_workflow', 'orch_control_workflow', 'orch_ask_member', 'orch_report'];
const MEMBER_KINDS = ['claude', 'codex'];
const TICK_MS = 3000;
const SAVE_TIME_EVERY_MS = 30000;
const QUIET_AFTER_USER_MS = 5000;
const CONFIRM_WORDS = /^\s*(确认|开工|确认开工|同意|可以|没问题|按计划|好的?|ok|yes)[\s，。!！,.]*$/i;

function enabled(meeting) { return !!(meeting && meeting.groupChat && meeting.orchestration && meeting.orchestration.enabled === true); }
const terminalRun = run => !run || ['done', 'cancelled'].includes(run.status);

function createOrchestrationService(deps) {
  const {
    meetingManager, sessionManager, getHubDataDir, getDispatcher, getDeliveryEngine,
    ensureMemberReady = async () => {},
    getMembers = m => getDispatcher().groupMembersForMeeting(m, { includeDormant: true }),
    sendToRenderer = () => {}, logger = console, now = () => Date.now(), nodeExecutable = 'node',
  } = deps;
  const ledgers = new Map();
  const inflight = new Map();          // meetingId → { ids, at }
  const lastUserAt = new Map();
  const lastTimeSave = new Map();
  const idleSince = new Map();          // `${stepId}:${memberId}` → 首次看到「回合已结束仍未交付」的时间
  const IDLE_GRACE_MS = 90000;
  const reconcileTimers = new Map();
  let bridge = null, timer = null, frozen = false;
  // 构造时就定好：start() 之前创建/恢复的编排员会话也拿到正确的工具地址。
  const endpointFile = path.join(getHubDataDir(), 'orchestration', 'bridge-endpoint.json');
  const lastEmitted = new Map();

  const dataDir = () => getHubDataDir();
  const meeting = id => meetingManager.getMeeting(id);
  const dispatcher = () => getDispatcher();
  const engine = () => getDeliveryEngine();

  // ---- 账本 ----
  function ledgerFor(meetingId) {
    if (ledgers.has(meetingId)) return ledgers.get(meetingId);
    const m = meeting(meetingId);
    if (!enabled(m)) return null;
    let ledger = Store.load(dataDir(), meetingId);
    if (!ledger) ledger = Ledger.create(meetingId, m.orchestration.settings, now());
    ledgers.set(meetingId, ledger);
    return ledger;
  }
  function persist(meetingId, ledger = ledgerFor(meetingId)) {
    if (!ledger) return;
    Store.save(dataDir(), ledger, now());
    lastTimeSave.set(meetingId, now());
    const view = viewFor(meetingId, ledger);
    const { updatedAt, ...shape } = view || {};
    const signature = JSON.stringify(shape);
    if (lastEmitted.get(meetingId) === signature) return;   // 只有内容变了才让界面重绘
    lastEmitted.set(meetingId, signature);
    sendToRenderer('orchestration:changed', { meetingId, view });
  }
  function viewFor(meetingId, ledger = ledgerFor(meetingId)) {
    const v = Ledger.view(ledger);
    if (!v) return null;
    const m = meeting(meetingId);
    v.orchestratorMemberId = m?.orchestration?.memberId || '';
    v.orchestratorSessionId = m?.orchestration?.sessionId || '';
    v.ledgerFile = Store.files(dataDir(), meetingId).md;
    const run = readRun(meetingId);
    v.run = run && !terminalRun(run) ? { status: run.status, stage: run.stages?.[run.steps?.at(-1)?.index]?.name || '', error: run.error || '' } : null;
    v.orchestratorBusy = orchestratorBusy(meetingId);
    return v;
  }

  function readRun(meetingId) {
    try { return JSON.parse(fs.readFileSync(path.join(Delivery.directory(dataDir(), meetingId), 'run.json'), 'utf8')); }
    catch { return null; }
  }

  // ---- 会话与成员 ----
  function orchestratorOf(meetingId) {
    const m = meeting(meetingId);
    if (!enabled(m)) return null;
    const { sessionId, memberId } = m.orchestration;
    return sessionId && memberId ? { sessionId, memberId } : null;
  }
  function members(meetingId) {
    const m = meeting(meetingId);
    const ledger = ledgerFor(meetingId);
    const orch = orchestratorOf(meetingId);
    return getMembers(m).map(x => {
      const s = sessionManager.getSession(x.sid) || {};
      const isOrch = orch && x.sid === orch.sessionId;
      return {
        memberId: x.memberId, name: x.displayName, sid: x.sid, kind: x.kind, model: x.model || s.currentModel?.id || null,
        role: isOrch ? '编排员' : (ledger?.roles?.[x.memberId]?.role || ''), orchestrator: !!isOrch,
        state: s.status || 'unknown', busy: sessionManager.isAgentTurnActive(x.sid),
      };
    });
  }
  function orchestratorBusy(meetingId) {
    const orch = orchestratorOf(meetingId);
    if (!orch) return false;
    return sessionManager.isAgentTurnActive(orch.sessionId) || inflight.has(meetingId);
  }
  function findMeetingBySession(sessionId) {
    if (!sessionId) return null;
    return meetingManager.getAllMeetings().find(m => enabled(m) && m.orchestration.sessionId === sessionId) || null;
  }

  // ---- 编排员会话的 MCP 挂载 ----
  function mcpEntry(sessionId) {
    return {
      name: MCP_NAME, command: nodeExecutable, args: [path.resolve(__dirname, '../../scripts/orchestrator-mcp.js')],
      env: { HUB_ORCH_ENDPOINT_FILE: endpointFile, HUB_ORCH_SESSION_ID: sessionId },
      toolApprovalModes: Object.fromEntries(TOOL_NAMES.map(name => [name, 'approve'])),
      toolOutputTokenLimits: { orch_status: 20000 },
    };
  }
  function launchOptions(kind, sessionId = randomUUID()) {
    const base = String(kind || '').replace(/-resume$/, '');
    if (!MEMBER_KINDS.includes(base)) throw new Error('编排员目前支持 Claude 或 Codex');
    const entry = mcpEntry(sessionId);
    if (base === 'codex') return { id: sessionId, purpose: PURPOSE, mcpProfile: 'lean', codexMcpEntries: [entry] };
    const dir = path.join(dataDir(), 'orchestration');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `claude-${sessionId}-mcp.json`);
    fs.writeFileSync(file + '.tmp', JSON.stringify({ mcpServers: { [MCP_NAME]: { command: entry.command, args: entry.args, env: entry.env } } }), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
    return { id: sessionId, purpose: PURPOSE, mcpProfile: 'lean', mcpConfigFile: file };
  }
  // Hub 重启或休眠唤醒时重新挂上工具（会话身份不变）。
  function resumeOptions(meta) {
    if (!meta || meta.purpose !== PURPOSE) return null;
    const { id, ...opts } = launchOptions(meta.kind, meta.hubId || meta.id);
    return opts;
  }

  // 建群后登记编排员身份并建账本；收件人默认只选编排员。
  function onMeetingCreated(meetingId) {
    const m = meeting(meetingId);
    if (!m || !m.orchestration || m.orchestration.enabled !== true) return null;
    const index = (m.subSessions || []).findIndex(sid => sessionManager.getSession(sid)?.purpose === PURPOSE);
    if (index < 0) throw new Error('编排员会话没有创建成功');
    const memberId = m.slotSpecs?.[index]?.memberId || `m${index + 1}`;
    const settings = Ledger.normalizeSettings(m.orchestration.settings);
    meetingManager.updateMeeting(meetingId, { orchestration: { enabled: true, memberId, sessionId: m.subSessions[index], settings, createdAt: now() } });
    meetingManager.setParticipants?.(meetingId, [index]);
    const ledger = Ledger.create(meetingId, settings, now());
    ledgers.set(meetingId, ledger);
    recovered.add(meetingId);
    persist(meetingId, ledger);
    return meeting(meetingId);
  }

  // ---- 通知 ----
  function notify(meetingId, key, text) {
    const ledger = ledgerFor(meetingId);
    if (!ledger) return false;
    const added = Ledger.enqueue(ledger, key || `${now()}:${text}`, text, now());
    if (added) { persist(meetingId, ledger); setImmediate(() => deliver(meetingId)); }
    return added;
  }
  async function deliver(meetingId) {
    if (frozen) return false;
    const ledger = ledgerFor(meetingId);
    const orch = orchestratorOf(meetingId);
    if (!ledger || !orch || ledger.status === 'ended') return false;
    if (!Ledger.pendingNotices(ledger).length || orchestratorBusy(meetingId)) return false;
    if (now() - (lastUserAt.get(meetingId) || 0) < QUIET_AFTER_USER_MS) return false;
    try{await ensureMemberReady(meeting(meetingId), orch.memberId);}
    catch(error){logger.warn?.('[orchestration] cannot wake orchestrator:',error.message);return false;}
    const session = sessionManager.getSession(orch.sessionId);
    if (!session) return false;
    let items = Ledger.pendingNotices(ledger);
    // 只有带新内容的投递才算一次「唤醒」；失败重试不计入「没进展」。
    const stalls = items.some(n => !n.attempts) ? Ledger.noteWake(ledger) : ledger.wakesWithoutProgress;
    let halted = ledger.status === 'halted' ? (ledger.halt && Ledger.HALT_LABELS[ledger.halt.reason]) : null;
    if (stalls >= 2 && ledger.status === 'running') {
      haltRun(meetingId, ledger, 'no_progress', '连续两次唤醒都没有新进展');
      halted = Ledger.HALT_LABELS.no_progress;
      items = Ledger.pendingNotices(ledger);
    }
    const ids = items.map(n => n.id);
    const text = Prompt.noticeText(items, { halted });   // 先成文：markSending 会改掉「可能已送达」标记
    Ledger.markSending(ledger, ids, now());
    inflight.set(meetingId, { ids, at: now() });
    persist(meetingId, ledger);
    try {
      const result = await dispatcher().dispatchGroupChatTurn(meetingId, {
        userInput: text, targetMemberIds: [orch.memberId], appendUserMessage: false,
        workflowRun: { kind: 'orch-notice', runId: 'notice-' + ids[0], stepIndex: 0, attempt: 1 },
        fileHandoff: true, turnTimeoutMs: 0,
      });
      const failed = !result || ['error', 'no_sent', 'no_subs'].includes(result.status)
        || (Array.isArray(result.results) && result.results.some(r => ['errored', 'absent', 'failed', 'not_sent'].includes(r.status)));
      const current = ledgerFor(meetingId);
      if (failed) { Ledger.markRetry(current, ids); logger.warn?.('[orchestration] notice not delivered:', meetingId, result && (result.reason || result.status)); }
      else Ledger.markSent(current, ids);
      persist(meetingId, current);
    } catch (error) {
      const current = ledgerFor(meetingId);
      if (current) { Ledger.markRetry(current, ids); persist(meetingId, current); }
      logger.warn?.('[orchestration] notice dispatch failed:', meetingId, error.message);
    } finally { inflight.delete(meetingId); }
    return true;
  }

  // ---- 工作流状态 → 账本 ----
  function haltRun(meetingId, ledger, reason, message) {
    Ledger.halt(ledger, reason, message, now());
    const run = readRun(meetingId);
    if (run && run.status === 'running') {
      try { engine().stop(meetingId); } catch (error) { logger.warn?.('[orchestration] pause workflow failed:', error.message); }
    }
  }
  function bindStartingSegment(ledger, run) {
    if (!run?.id || ledger.segments.some(s => s.runId === run.id)) return;
    const seg = [...ledger.segments].reverse().find(s => s.status === 'starting' && !s.runId);
    if (seg && (run.createdAt || 0) >= seg.startedAt - 5000) seg.runId = run.id;
  }
  function reconcile(meetingId) {
    const ledger = ledgerFor(meetingId);
    if (!ledger) return;
    const run = readRun(meetingId);
    if (run) bindStartingSegment(ledger, run);
    const notices = run ? Ledger.applyRun(ledger, run, now()) : [];
    for (const n of notices) Ledger.enqueue(ledger, n.key, n.text, now());
    if(run?.status==='paused' && ledger.status==='running' && !/已完成 \d+ 轮审查仍需返工|用户已暂停|额度/.test(run.error||'')){
      Ledger.halt(ledger,'runtime_error',run.error||'工作流运行暂停，需核对现场',now());
      Ledger.enqueue(ledger,`runtime:${run.id}:${run.steps?.at(-1)?.id}`,`运行故障：${run.error||'原因未知'}。请用 orch_status 核对失败步骤、派工回执和保留交付，仅向田哥提供处理建议，等待明确恢复。`,now());
    }
    checkBudget(meetingId, ledger, run);
    persist(meetingId, ledger);
    if (notices.length) setImmediate(() => deliver(meetingId));
  }
  function checkBudget(meetingId, ledger, run = readRun(meetingId)) {
    const reason = Ledger.overBudget(ledger);
    if (!reason) return false;
    const runActive = run && !terminalRun(run);
    // 工作流已结束且没有在途工作时不打断；下一次派活会被额度拦下。
    if (!runActive && !ledger.asks.some(a => a.status === 'pending')) return false;
    const label = reason === 'budget_rounds'
      ? `已用 ${ledger.budget.roundsUsed}/${ledger.budget.roundCap} 轮`
      : `已用 ${Math.round(ledger.budget.activeMs / 60000)}/${Math.round(ledger.budget.timeCapMs / 60000)} 分钟`;
    haltRun(meetingId, ledger, reason, label);
    Ledger.enqueue(ledger, `halt:${reason}:${ledger.budget.grants}`, `额度用满（${label}），Hub 已暂停工作流。`, now());
    return true;
  }
  function onDeliveryStatus(meetingId) {
    if (!enabled(meeting(meetingId))) return;
    clearTimeout(reconcileTimers.get(meetingId));
    const t = setTimeout(() => { reconcileTimers.delete(meetingId); try { reconcile(meetingId); } catch (error) { logger.warn?.('[orchestration] reconcile failed:', error.message); } }, 250);
    t.unref?.();
    reconcileTimers.set(meetingId, t);
  }
  // 单独提问的回答文件到了 → 记账并通知编排员。
  function onAnswersChanged(meetingId, orch) {
    const ledger = ledgerFor(meetingId);
    if (!ledger || !orch?.state?.messages) return;
    let changed = false;
    for (const ask of ledger.asks.filter(a => a.status === 'pending')) {
      const dispatchMsg = orch.state.messages.find(m => m.dispatch && m.dispatch.runId === ask.id);
      if (!dispatchMsg) continue;
      ask.turnNum = dispatchMsg.turnNum;
      const answer = orch.state.messages.find(m => m.role === 'assistant' && m.turnNum === ask.turnNum && m.memberId === ask.memberId && m.answer?.state === 'delivered');
      if (!answer) continue;
      ask.status = 'answered';
      ask.answeredAt = now();
      ask.answerPath = orch.answerFileFor(ask.turnNum, answer.sid)?.ready || '';
      ledger.progressSeq += 1; ledger.wakesWithoutProgress = 0;
      Ledger.event(ledger, `${ask.memberId} 回答了单独提问`, now());
      Ledger.enqueue(ledger, `ask:${ask.id}`, `${ask.memberId} 已回答你的单独提问 ${ask.id}：${ask.answerPath}`, now());
      changed = true;
    }
    if (changed) { persist(meetingId, ledger); setImmediate(() => deliver(meetingId)); }
  }

  // ---- 周期巡检：计时、卡住、额度、投递 ----
  // Hub 启动后第一次见到某个编排群：发送中没回执的通知标为「可能已送达」，在途工作段告诉编排员。
  const recovered = new Set();
  function recoverOnce(meetingId, ledger) {
    if (recovered.has(meetingId)) return;
    recovered.add(meetingId);
    const uncertain = Ledger.recoverAfterRestart(ledger);
    const run = readRun(meetingId);
    if (run) { bindStartingSegment(ledger, run); Ledger.applyRun(ledger, run, now()); }
    const seg = Ledger.activeSegment(ledger);
    if (seg && run && !terminalRun(run) && ledger.status !== 'ended') {
      Ledger.enqueue(ledger, `restart:${process.pid}:${seg.id}`, `Hub 已重启。工作段「${seg.name}」当前${run.status === 'paused' ? '已暂停' + (run.error ? '（' + run.error + '）' : '') : '状态为 ' + run.status}；需要时用 orch_control_workflow(continue) 续跑。`, now());
    }
    if (uncertain || seg) persist(meetingId, ledger);
  }
  function tickMeeting(meetingId) {
    const ledger = ledgerFor(meetingId);
    if (!ledger) return;
    recoverOnce(meetingId, ledger);
    const run = readRun(meetingId);
    const working = (run && run.status === 'running') || ledger.asks.some(a => a.status === 'pending') || orchestratorBusy(meetingId);
    const before = ledger.status;
    Ledger.tick(ledger, now(), { working });
    let dirty = checkBudget(meetingId, ledger, run) || before !== ledger.status;
    const stuckMs = ledger.settings.stuckMin * 60000;
    const seg = Ledger.activeSegment(ledger);
    const step = run && run.status === 'running' ? run.steps?.at(-1) : null;
    if (seg && step && seg.runId === run.id && now() - (step.createdAt || now()) > stuckMs) {
      const missing = (step.members || []).filter(m => !step.deliveries?.[m]);
      if (missing.length && seg.stuckNotified !== step.id) {
        seg.stuckNotified = step.id;
        Ledger.enqueue(ledger, `stuck:${step.id}`, `工作段「${seg.name}」的「${run.stages?.[step.index]?.name || '当前步骤'}」已超过 ${ledger.settings.stuckMin} 分钟没有交付（待交付：${missing.join('、')}），成员可能卡住。可以 orch_control_workflow(remind) 提醒，或向田哥说明。`, now());
        dirty = true;
      }
    }
    // 成员这一轮已经结束、空闲一段时间仍没交付：不等「卡住」上限，尽快告诉编排员去提醒。
    if (seg && step && seg.runId === run.id && (step.dispatches || []).length && step.dispatches.every(d => d.state === 'settled')) {
      const roster = members(meetingId);
      for (const memberId of (step.members || []).filter(m => !step.deliveries?.[m])) {
        const key = `${step.id}:${memberId}`;
        const member = roster.find(x => x.memberId === memberId);
        if (!member || sessionManager.isAgentTurnActive(member.sid)) { idleSince.delete(key); continue; }
        if (!idleSince.has(key)) idleSince.set(key, now());
        if (now() - idleSince.get(key) >= IDLE_GRACE_MS && Ledger.enqueue(ledger, `idle:${key}`, `${memberId}（${member.role || member.name}）在「${run.stages?.[step.index]?.name || '当前步骤'}」这一轮已经结束，但没有交付文件（仍是草稿）。可以用 orch_control_workflow(remind) 提醒它补交，必要时带上 note 说明它这一步该交什么。`, now())) dirty = true;
      }
    }
    for (const ask of ledger.asks.filter(a => a.status === 'pending' && !a.stuckNotified && now() - a.at > stuckMs)) {
      ask.stuckNotified = true;
      Ledger.enqueue(ledger, `ask-stuck:${ask.id}`, `${ask.memberId} 超过 ${ledger.settings.stuckMin} 分钟没有回答单独提问 ${ask.id}，可能卡住。`, now());
      dirty = true;
    }
    if (dirty || now() - (lastTimeSave.get(meetingId) || 0) > SAVE_TIME_EVERY_MS) persist(meetingId, ledger);
    void deliver(meetingId);
  }
  function tickAll() {
    if (frozen) return;
    for (const m of meetingManager.getAllMeetings()) {
      if (!enabled(m) || m.status === 'closed') continue;
      try { tickMeeting(m.id); } catch (error) { logger.warn?.('[orchestration] tick failed:', m.id, error.message); }
    }
  }

  // ---- 工具 ----
  function requireDispatch(ledger) {
    const gate = Ledger.canDispatch(ledger);
    if (!gate.ok) throw new Error(gate.reason);
  }
  function statusResult(meetingId) {
    const ledger = ledgerFor(meetingId);
    const v = viewFor(meetingId, ledger);
    const m = meeting(meetingId);
    const run = readRun(meetingId);
    const step = run?.steps?.at(-1);
    return {
      meeting: { title: m.title, scene: m.scene, workspace: m.workspace },
      status: v.status, halt: v.halt, budget: v.budget, settings: v.settings,
      requestedBudget: ledger.budgetIntent || null, budgetError: ledger.budgetError || null,
      plan: ledger.plan, members: members(meetingId), segments: v.segments,
      currentRun: run && !terminalRun(run) ? {
        status: run.status, error: run.error || '', stage: run.stages?.[step?.index]?.name || '',
        stepMembers: step?.members || [], missing: (step?.members || []).filter(id => !step?.deliveries?.[id]),
        deliveries: Object.values(step?.deliveries || {}).map(d => ({ memberId: d.memberId, outcome: d.outcome, path: d.path })),
        dispatches: step?.dispatches || [],
        recovery: Object.values(step?.deliveries || {}).some(d=>d.outcome==='blocked')
          ? { resumeAllowed:false, advice:'本轮已有阻塞交付，结果不可覆盖或原地续跑。请田哥处理阻塞后保留记录，结束本次任务并新建任务。' }
          : { resumeAllowed:true, advice:'先请田哥处理并核对故障现场，得到明确恢复授权后才能续跑。' },
        runDir: path.join(Delivery.directory(dataDir(), meetingId), run.id),
      } : null,
      asks: ledger.asks.slice(-8), lastReport: ledger.reports.at(-1) || null,
      ledgerFile: Store.files(dataDir(), meetingId).md,
      canDispatch: Ledger.canDispatch(ledger),
    };
  }
  function draftFor(meetingId, args, memberList) {
    const preset = args.preset;
    if (preset === 'custom') {
      const rounds = (Array.isArray(args.rounds) ? args.rounds : []).map((r, i, all) => ({
        name: String(r.name || `第 ${i + 1} 轮`).slice(0, 80), prompt: String(r.prompt || '').trim(),
        members: Array.isArray(r.members) && r.members.length ? r.members : args.members,
        after: i === all.length - 1 ? 'end' : (r.after === 'end' ? 'end' : 'next'),
      }));
      if (!rounds.length) throw new Error('custom 模板要用 rounds 写清每一轮');
      return { enabled: true, presetId: 'custom', kind: 'serial', rounds };
    }
    const named = args.members.map(id => ({ memberId: id, displayName: memberList.find(x => x.memberId === id)?.name || id }));
    return Settings.createPreset(preset, named);
  }
  async function startWorkflow(meetingId, ledger, args) {
    requireDispatch(ledger);
    const planned=ledger.plan?.segments.find(s=>s.name===String(args.name||'').trim());
    if(!planned || ['preset','goal','acceptance'].some(k=>String(planned[k]||'').trim()!==String(args[k]||'').trim()))throw Error('派工必须匹配当前确认计划工作段的名称、模板、目标和验收标准');
    if (Ledger.overBudget(ledger)) { checkBudget(meetingId, ledger); persist(meetingId, ledger); throw new Error('额度已用满，已暂停；请用 orch_report(need_decision) 汇报'); }
    if (ledger.budget.roundsUsed >= ledger.budget.roundCap) throw new Error('迭代额度已用满；请用 orch_report(need_decision) 汇报');
    if (!Ledger.PRESETS.includes(args.preset)) throw new Error('preset 只能是 development / research / roundtable / custom');
    const run = readRun(meetingId);
    if (run && !terminalRun(run)) throw new Error('已有工作段在进行（同一时间只能跑一段）；先用 orch_control_workflow 处理当前段');
    const list = members(meetingId);
    const ids = Array.isArray(args.members) ? args.members.map(String) : [];
    if (!ids.length || new Set(ids).size !== ids.length) throw new Error('members 要列出参与成员编号，不能重复');
    for (const id of ids) {
      const member = list.find(x => x.memberId === id);
      if (!member) throw new Error(`没有已有成员 ${id}；请田哥调整成员配置`);
      if (member.orchestrator) throw new Error('编排员不参与工作流，members 里不能有自己');
    }
    if (args.preset === 'development') {
      if (ids.length !== 2) throw new Error('development 需要 members=[开发位, 审核位] 两位');
    }
    const draft = draftFor(meetingId, args, list);
    const workerIds = list.filter(x => !x.orchestrator).map(x => x.memberId);
    const m = meeting(meetingId);
    const config = Settings.toDeliveryConfig(m.serialWorkflow || null, draft, workerIds);
    config.taskArmed = false;
    meetingManager.updateMeeting(meetingId, { serialWorkflow: config });
    sendToRenderer('meeting-updated', { meeting: meeting(meetingId) });
    const seg = Ledger.startSegment(ledger, { name: args.name, preset: args.preset, goal: args.goal, acceptance: args.acceptance, members: ids, planSegmentId:planned.id }, now());
    persist(meetingId, ledger);
    const started = engine().start(meetingId, Prompt.goalText({ goal: args.goal, acceptance: args.acceptance, preset: args.preset }));
    started.then(() => onDeliveryStatus(meetingId), error => {
      const l = ledgerFor(meetingId);
      const s = l?.segments.find(x => x.id === seg.id);
      if (s && s.status === 'starting') { s.status = 'failed'; s.error = String(error.message || error).slice(0, 600); s.endedAt = now(); }
      if (l) { haltRun(meetingId,l,'runtime_error',String(error.message||error)); Ledger.enqueue(l, `start-failed:${seg.id}`, `工作段「${seg.name}」启动失败：${error.message}。仅提供处理建议，等待田哥恢复。`, now()); persist(meetingId, l); }
    });
    // 首次派工可能要唤醒成员，较慢；最多等几秒拿到运行编号，不阻塞工具调用。
    await Promise.race([started.catch(() => {}), new Promise(resolve => { const t = setTimeout(resolve, 8000); t.unref?.(); })]);
    reconcile(meetingId);
    const latest = ledgerFor(meetingId).segments.find(x => x.id === seg.id);
    if (latest.status === 'failed') throw new Error('工作段启动失败：' + latest.error);
    return { segmentId: seg.id, status: latest.status, runId: latest.runId, note: '工作流结果会由 Hub 通知你，不用轮询。' };
  }
  async function controlWorkflow(meetingId, ledger, args) {
    const run = readRun(meetingId);
    if (!run || terminalRun(run)) throw new Error('当前没有进行中的工作段');
    const e = engine();
    if (args.action === 'pause') { await e.stop(meetingId); return { ok: true }; }
    if (args.action === 'cancel') { await e.cancel(meetingId); reconcile(meetingId); return { ok: true }; }
    requireDispatch(ledger);
    if (Ledger.overBudget(ledger)) { checkBudget(meetingId, ledger, run); persist(meetingId, ledger); throw new Error('额度已用满，已暂停；请用 orch_report(need_decision) 汇报'); }
    if (args.action === 'continue') { const s = await e.resume(meetingId); reconcile(meetingId); return { ok: true, status: s?.status || null }; }
    if (args.action === 'remind') { const s = await e.continueWork(meetingId, String(args.note || '').trim() || undefined); return { ok: true, status: s?.status || null }; }
    throw new Error('action 只能是 continue / remind / pause / cancel');
  }
  async function askMember(meetingId, ledger, args) {
    requireDispatch(ledger);
    const memberId = String(args.memberId || '');
    const question = String(args.question || '').trim();
    if (!question) throw new Error('question 不能为空');
    const member = members(meetingId).find(x => x.memberId === memberId);
    if (!member) throw new Error(`没有成员 ${memberId}`);
    if (member.orchestrator) throw new Error('不能问自己');
    if (ledger.asks.some(a => a.memberId === memberId && a.status === 'pending')) throw new Error(`${memberId} 还有一个没回答的提问，等回答后再问`);
    const run = readRun(meetingId);
    const step = run && run.status === 'running' ? run.steps?.at(-1) : null;
    if (step && (step.members || []).includes(memberId) && !step.deliveries?.[memberId]) throw new Error(`${memberId} 正在工作流里干活，不能打断；等它交付后再问`);
    const ask = { id: Ledger.newId('ask'), memberId, question: question.slice(0, 4000), status: 'pending', at: now() };
    ledger.asks.push(ask);
    if (ledger.asks.length > 60) ledger.asks.splice(0, ledger.asks.length - 60);
    Ledger.event(ledger, `编排员单独问 ${memberId}`, now());
    persist(meetingId, ledger);
    // 发送失败时把提问标为失败：不留挂起记录，不再计入在途工作与时长。
    const fail = (reason, notify) => {
      const l = ledgerFor(meetingId);
      const a = l?.asks.find(x => x.id === ask.id);
      if (!a || a.status !== 'pending') return;
      a.status = 'failed'; a.error = String(reason || '发送失败').slice(0, 300);
      if (notify) Ledger.enqueue(l, `ask-failed:${a.id}`, `单独提问 ${a.id} 没有送达 ${a.memberId}：${a.error}`, now());
      persist(meetingId, l);
    };
    let promise;
    try {
      await ensureMemberReady(meeting(meetingId), memberId);
      promise = dispatcher().dispatchGroupChatTurn(meetingId, {
        userInput: Prompt.askText({ question, askId: ask.id }), targetMemberIds: [memberId], appendUserMessage: false,
        workflowRun: { kind: 'orchestration', runId: ask.id, stepIndex: 0, attempt: 1 }, fileHandoff: true, turnTimeoutMs: 0,
      });
    } catch (error) { fail(error.message, false); throw new Error(`没能把问题发给 ${memberId}：${error.message}`); }
    Promise.resolve(promise).then(result => {
      const a = ledgerFor(meetingId)?.asks.find(x => x.id === ask.id);
      if (a && result?.turnNum) a.turnNum = result.turnNum;
      if (!result || ['error', 'no_sent', 'no_subs'].includes(result.status)) fail(result?.reason || result?.status, true);
    }, error => fail(error.message, true));
    return { askId: ask.id, note: '成员回答后 Hub 会通知你，并给出回答文件路径。' };
  }
  function report(meetingId, ledger, args) {
    const kind = args.kind;
    const summary = String(args.summary || '').trim();
    if (!['progress', 'need_decision', 'final'].includes(kind)) throw new Error('kind 只能是 progress / need_decision / final');
    if (!summary) throw new Error('summary 不能为空');
    if (kind === 'final') {
      const gate = Ledger.finalGate(ledger);
      if (!gate.ok) throw new Error('不能结项：' + gate.reason);
    }
    Ledger.addReport(ledger, kind, summary, now());
    if (kind === 'final') { ledger.status = 'finished'; Ledger.event(ledger, '编排员结项', now()); }
    if (kind === 'need_decision' && ledger.status === 'running') {
      haltRun(meetingId, ledger, 'need_decision', summary.slice(0, 300));
      ledger.halt.reported = true;
    }
    ledger.progressSeq += 1;
    persist(meetingId, ledger);
    return { ok: true, status: ledger.status, note: kind === 'progress' ? '已记录' : '界面已请田哥决定；在回答里把汇报讲给田哥。' };
  }
  async function invokeTool(request = {}) {
    const m = findMeetingBySession(request.callerSessionId);
    if (!m) throw new Error('只有编排群里的编排员可以调用这些工具');
    const ledger = ledgerFor(m.id);
    const args = request.arguments || {};
    switch (request.name) {
      case 'orch_status': return statusResult(m.id);
      case 'orch_propose_plan': {
        const workers=members(m.id).filter(x=>!x.orchestrator);
        const team=Array.isArray(args.team)?args.team:[];
        if(new Set(team.map(x=>x.memberId)).size!==team.length || team.some(x=>!workers.some(w=>w.memberId===x.memberId)))throw Error('team 只能指定不同的已有成员 memberId 与角色');
        const plan = Ledger.proposePlan(ledger, {...args,budget:BudgetIntent.forPlan(ledger,args.budget)}, now());
        if(!ledger.settings.requireConfirm)Ledger.confirmPlan(ledger,now());
        persist(m.id, ledger);
        return { version: plan.version, status: ledger.status, budget:plan.budget, segments:plan.segments, note: ledger.status === 'awaiting_confirm' ? '计划与额度已交给田哥确认；确认后使用已有成员派工。' : '计划已记录，可以使用已有成员派工。' };
      }
      case 'orch_add_member': throw Error('编排员只使用固定的已有成员；新建成员由田哥操作');
      case 'orch_start_workflow': return startWorkflow(m.id, ledger, args);
      case 'orch_control_workflow': return controlWorkflow(m.id, ledger, args);
      case 'orch_ask_member': return askMember(m.id, ledger, args);
      case 'orch_report': return report(m.id, ledger, args);
      default: throw new Error('未知工具');
    }
  }

  // 结束编排后房间回到普通群聊：关掉工作流的消息路由（配置保留），恢复编排时再打开。
  function setWorkflowEnabled(meetingId, on) {
    const sw = meeting(meetingId)?.serialWorkflow;
    if (!sw || sw.deliveryVersion !== 1 || !!sw.enabled === on) return;
    meetingManager.updateMeeting(meetingId, { serialWorkflow: { ...sw, enabled: on } });
    sendToRenderer('meeting-updated', { meeting: meeting(meetingId) });
  }

  // ---- 田哥的操作 ----
  async function userAction(meetingId, action, payload = {}) {
    const ledger = ledgerFor(meetingId);
    if (!ledger) throw new Error('这个群不是编排群');
    switch (action) {
      case 'confirm': {
        if (Ledger.confirmPlan(ledger, now())) Ledger.enqueue(ledger, `confirm:${ledger.plan.version}`, `田哥已确认计划 v${ledger.plan.version}，可以组队并启动工作流。`, now());
        break;
      }
      case 'grant': {
        const rounds = Number(payload.rounds) || 0, minutes = Number(payload.minutes) || 0;
        if (!rounds && !minutes) throw new Error('请给出追加的轮次或分钟');
        Ledger.grant(ledger, { rounds, minutes }, now());
        Ledger.enqueue(ledger, `grant:${ledger.budget.grants}`, `田哥追加了额度（${rounds ? rounds + ' 轮' : ''}${rounds && minutes ? '、' : ''}${minutes ? minutes + ' 分钟' : ''}），现在 ${ledger.budget.roundsUsed}/${ledger.budget.roundCap} 轮。追加额度即表示田哥同意按你最近的建议继续推进，不必再问；工作流仍处于暂停，用 orch_control_workflow(continue) 续跑。`, now());
        break;
      }
      case 'pause': {
        if (ledger.status === 'running') haltRun(meetingId, ledger, 'user_pause', '田哥暂停');
        break;
      }
      case 'resume': {
        if (ledger.status === 'halted') {
          const reason = ledger.halt?.reason;
          if (reason === 'budget_rounds' || reason === 'budget_time') throw new Error('额度已用满，请追加额度');
          Ledger.resume(ledger, now());
          Ledger.enqueue(ledger, `resume:${ledger.progressSeq}`, '田哥恢复了编排，可以继续推进（工作流若仍暂停，用 orch_control_workflow(continue) 续跑）。', now());
        } else if (ledger.status === 'ended') {
          setWorkflowEnabled(meetingId, true);
          ledger.status = ledger.plan && ledger.plan.confirmedVersion ? 'running' : (ledger.settings.requireConfirm ? 'planning' : 'running');
          Ledger.event(ledger, '田哥恢复编排', now());
        }
        break;
      }
      case 'end': {
        const run = readRun(meetingId);
        if (run && run.status === 'running') { try { await engine().stop(meetingId); } catch (error) { logger.warn?.('[orchestration] stop on end failed:', error.message); } }
        ledger.status = 'ended';
        ledger.halt = null;
        setWorkflowEnabled(meetingId, false);
        Ledger.event(ledger, '田哥结束编排，回到普通群聊', now());
        break;
      }
      default: throw new Error('未知操作');
    }
    persist(meetingId, ledger);
    setImmediate(() => deliver(meetingId));
    return viewFor(meetingId, ledger);
  }
  // 田哥亲自发言：重置「没进展」计数；回答「需要你决定」视为已决定；点名成员时抄送编排员。
  function userMessage(meetingId, { text = '', direct = [] } = {}) {
    const ledger = ledgerFor(meetingId);
    if (!ledger) return null;
    lastUserAt.set(meetingId, now());
    Ledger.noteUserMessage(ledger);
    if(!direct.length){
      if(ledger.status==='finished'){
        ledger.taskHistory=[...(ledger.taskHistory||[]),{plan:ledger.plan,segments:ledger.segments,budget:ledger.budget,asks:ledger.asks,reports:ledger.reports,endedAt:now()}];
        ledger.budget=Ledger.create(meetingId,ledger.settings,now()).budget;
        ledger.plan=null;ledger.segments=[];ledger.asks=[];ledger.reports=[];
        ledger.budgetIntent=null;ledger.budgetError=null;
      }
      ledger.userMessages=[...(ledger.userMessages||[]),String(text)].slice(-8);
      try{
        if(/按默认额度|使用默认额度|恢复默认额度/.test(String(text))){ledger.budgetIntent={roundCap:ledger.settings.roundCap,timeCapMin:ledger.settings.timeCapMin};ledger.budgetError=null;}
        else{const intent=BudgetIntent.extract(text);if(intent){ledger.budgetIntent={...ledger.budgetIntent,...intent};ledger.budgetError=null;}}
      }
      catch(error){ledger.budgetError=error.message;Ledger.enqueue(ledger,`budget-invalid:${now()}`,error.message,now());}
    }
    if (ledger.status === 'awaiting_confirm' && CONFIRM_WORDS.test(String(text))) Ledger.confirmPlan(ledger, now());
    // 结项后田哥提出新要求：重新开放编排（新计划仍需确认）。
    if (ledger.status === 'finished' && !direct.length) { ledger.status = 'running'; Ledger.event(ledger, '田哥在结项后提出新要求，重新开放编排', now()); }
    if (ledger.status === 'halted' && !/^budget_/.test(ledger.halt?.reason||'') && !direct.length && /^\s*(继续|恢复编排|按建议继续|按计划继续|同意继续)[\s。！!]*$/.test(String(text))) {
      Ledger.resume(ledger, now());
    }
    if (Array.isArray(direct) && direct.length) {
      Ledger.enqueue(ledger, `direct:${now()}`, `田哥直接对 ${direct.join('、')} 说：${String(text).slice(0, 600)}`, now());
    }
    persist(meetingId, ledger);
    return viewFor(meetingId, ledger);
  }

  // ---- 生命周期 ----
  async function start() {
    bridge = new AssistantBridge(request => invokeTool(request), { identityHeader: 'x-hub-orchestrator-session' });
    await bridge.start();
    fs.mkdirSync(path.dirname(endpointFile), { recursive: true });
    const tmp = `${endpointFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ url: bridge.url, token: bridge.secret }), { mode: 0o600 });
    fs.renameSync(tmp, endpointFile);
    timer = setInterval(tickAll, TICK_MS);
    timer.unref?.();
    return { endpointFile };
  }
  function stop() { clearInterval(timer); timer = null; bridge?.close(); bridge = null; }
  // 关机排空期间不再唤醒编排员、不再派活；关机取消时恢复。
  function freeze() { frozen = true; }
  function unfreeze() { frozen = false; }

  return {
    start, stop, freeze, unfreeze, enabled, launchOptions, resumeOptions, onMeetingCreated, onDeliveryStatus, onAnswersChanged,
    invokeTool, userAction, userMessage, view: id => viewFor(id), statusResult, reconcile, tickMeeting, deliver,
    ledgerFor, members, PURPOSE,
  };
}

module.exports = { createOrchestrationService, enabled, PURPOSE, TOOL_NAMES };
