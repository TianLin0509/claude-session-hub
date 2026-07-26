'use strict';
/**
 * 投委会五幕编排状态机（task#3）。
 *
 * 叠加在现有 research 群聊之上，固定五幕：
 *   立会(主席派活) → 建库(委员并行调研) → 点评(委员并行三面打分,两段式)
 *   → 辩论(委员并行交锋 + 主席串行收口,迭代) → 收敛(主席换帽子总指挥)。
 *
 * 每幕调注入的 dispatchTurn(=dispatcher.dispatchGroupChatTurn, silent:true) 程序化驱动委员发言，
 * 复用 Hub 现成的并行发言/超时跳过/PTY 收集；conductor 只管「幕次编排」，
 * 抽取/双榜聚合委托 core/committee-extract.js（task#4，纯数据层）。
 *
 * 设计要点：
 * - 全员幕用同一 userInput（真并行），prompt 内含**分工映射表**，委员按身份对号入座
 *   （不改 dispatcher，不依赖逐委员定制 prompt）。
 * - 主席幕（立会/收口/收敛）单独发，targetMemberIds=[主席]。
 * - 战法纪律已由 orchestrator 注入 system prompt 底色（task#2），幕 prompt 只给幕次指令。
 */

const { extractReviews, mergeReviews, buildBoards, parseChair, parseLastJson, _norm6, idOf, labelOf } = require('../../core/committee-extract');

const ACTS = { CONVENE: '立会', BUILD: '建库', REVIEW: '点评', DEBATE: '辩论', CONVERGE: '收敛' };

// 委员面分工默认按 kind（claude 兼主席+基本面 / deepseek 技术面 / codex 消息面）
const FACE_BY_KIND = {
  deepseek: '技术面', claude: '基本面', codex: '消息面',
  kimi: '消息面', qwen: '技术面', glm: '基本面', gemini: '消息面',
};
const CHAIR_PRIORITY = ['claude', 'codex', 'deepseek', 'qwen', 'kimi', 'glm', 'gemini'];

// 各幕硬超时（卡住的委员到点 skip，不阻塞整场）。建库/点评/辩论委员要调 MCP，给足。
const TIMEOUT = { convene: 90000, build: 240000, review: 240000, debate: 200000, close: 90000, converge: 180000 };

function _kind(m) { return String(m.kind || '').toLowerCase(); }

function pickChair(members) {
  for (const k of CHAIR_PRIORITY) {
    const m = members.find(x => _kind(x) === k);
    if (m) return m;
  }
  return members[0];
}

function assignRoles(members) {
  const chair = pickChair(members);
  return members.map(m => ({
    memberId: m.memberId, kind: m.kind, displayName: m.displayName || m.kind,
    face: FACE_BY_KIND[_kind(m)] || '综合',
    isChair: m.memberId === chair.memberId,
  }));
}

function stocklistText(stocks) {
  // labelOf 去重：输名字（无代码）时只显示名字，不再「长川科技 长川科技」重复。
  return stocks.map(s => labelOf(s) || s.code || s.name || '').join('、');
}
function dutyTable(members) {
  return members.map(m => `${m.displayName}→${m.face}${m.isChair ? '(兼主席)' : ''}`).join('、');
}

// ───────────────────────── 幕 prompt ─────────────────────────
function convenePrompt(stocks, rounds, members) {
  return [
    `【投委会开庭 · 立会】本场标的：${stocklistText(stocks)}；辩论 ${rounds} 轮。`,
    '你是本场主席。请：',
    `1) 宣布分工：${dutyTable(members)}。`,
    '2) 点出本场要重点验证的 2-3 个关键问题（题材正宗性 / 趋势阶段·主升 or 回调 / 预期差 / RS 板块强度），并指出哪只最该警惕。战法纪律已在系统底色，无需重申。',
    '简洁定调，本幕不调工具，≤180 字。',
  ].join('\n');
}
function buildPrompt(stocks, members) {
  return [
    `【投委会 · 建库】标的：${stocklistText(stocks)}。`,
    `分工：${dutyTable(members)}——各调各的面、系统自动聚合三面（只管把你这面调透，不必复述别人的面）：`,
    '· 技术面：把标的名换成 6 位代码（你认得，如沪电股份=002463），调 screener_score(代码) 拿追涨/蓄势量化分 + 形态，stock_market 看实时趋势/均线/量价，kline_similarity 对照历史。重点给 RS 板块强度 + 趋势阶段（主升 / 回调企稳）。',
    '· 基本面：调 stock_static 看财务/估值/质押/股东，判断基本面够不够硬、业绩是否兑现。',
    '· 消息面：调 stock_news（+必要时 stock_sentiment）找催化与预期差，催化标时间窗（已兑现 / 进行中 / 预期）；判题材正宗度（蹭概念 vs 相关营收占比）。',
    '⚠ 当场把数据调完再发言：直接用 MCP 工具同步取数，**不要**起后台子任务 / Agent 异步调取后只回「稍候 / 数据回传中」——下一幕点评全靠你这条发言里的真实数字，发「稍候」会让队友拿到空数据、整场作废。数据量大就在工具调用里只提取能改判断的关键字段。',
    '只报你这一面、能改变判断的关键数字+来源，≤300 字。',
  ].join('\n');
}
function reviewPrompt(stocks, members) {
  const ids = stocks.map(idOf);
  return [
    '【投委会 · 点评】上方「新增发言」里已有三位委员的建库调研全文——请**通读队友另外两面的调研**，结合你自己负责的面，对每只标的做**综合三面**的判断（不是只评自己那面、其余面瞎猜）。',
    '两段式输出：先自然语言点评（每只股 2-4 句，落到数字），再在**末尾附一段 JSON**（供系统聚合双榜，不可省）：',
    '```json',
    '{"stocks":{"<标的标识>":{"faces":{"基本面":0-100,"技术面":0-100,"消息面":0-100},"chase":0-100,"ambush":0-100,"rs":0-100,"lean":"追涨|低吸|观望","catalyst":"催化+时间窗(已兑现/进行中/预期)","veto":false,"top_bull":["看多理由[追涨向|低吸向|通用]"],"top_bear":["看空理由"]}}}',
    '```',
    'faces 三面分：你负责的面给亲自调研的分，**另两面引用队友建库结论给分**（队友全文就在上方，别再标「参考估计」凭空猜）。',
    'chase=追涨适配度、ambush=低吸适配度、rs=板块内相对强度（强者恒强，RS 高优先）；catalyst 写清催化与预期差。',
    'veto=true 仅命中**真**否决线（趋势破位 / 题材不正宗·蹭概念 / 量价背离假强势 / 基本面证伪 / 睡不着的妖股纯情绪）；**单纯高位或过热不否决**——强者恒强，过热是强度信号，温度只用于择时不用于剔除。',
    `⚠ JSON 里每只股的 key **必须逐字照抄**下列标的标识（系统按它对齐双榜，写成别的代码/简称会导致你这一份打分被整段丢弃）：${ids.join('、')}。`,
  ].join('\n');
}
// [全量注入] 辩论幕不再喂压缩的分数摘要（旧 reviewsDigest 把 1875 字技术分析压成一行、丢光论据）——
//   改由 buildDelta 把上一轮点评/辩论全文注入 prompt（committeeMid），委员看到队友完整分析后带依据交锋。
//   reviews 参数保留以兼容 conductor 调用方（现已不使用）。
function debatePrompt(stocks, reviews, round) {
  return [
    `【投委会 · 辩论 第${round}轮】上方「新增发言」里是各委员上一轮的完整发言（首轮即三家点评全文，含各自三面分析与打分）——通读后带依据交锋：`,
    '质疑你不认同的打分（点名委员 + 给反例/具体数字），或补强自己的判断；被说服就改分。尽量引入一个队友没提的新信号（龙虎榜/北向/基金调研/研报评级变化/筹码集中度），别只复述已有结论。',
    `两段式：自然语言辩论 + 末尾更新后的 JSON（同点评格式，key 仍逐字照抄标的标识 ${stocks.map(idOf).join('、')}，只含你改动的标的）。≤300 字。`,
  ].join('\n');
}
function debateClosePrompt(stocks, reviews, round) {
  return [
    `【投委会 · 主席收口 第${round}轮】你是主席，收口本轮：`,
    '1) 1-2 句总结本轮共识与仍存分歧。',
    '2) 点名下一轮要重点厘清的 1 个矛盾（如某股 chase 分分歧）；若分歧已基本收敛，宣布可进入收敛幕。',
    '本幕不调工具，≤150 字。',
  ].join('\n');
}
function convergePrompt(stocks, reviews) {
  return [
    '【投委会 · 收敛】你是主席，现在**换帽子**：从自己的委员立场抽离，以中立总指挥身份综合全场。',
    '三道保险：①中立综合不偏袒 ②涉及你自己（基本面）的判断按更严标准复核 ③结论须可被玻璃房/矛盾探针复核。',
    '套笼头：只综合委员已有结论 + 轻量裁决，**不要重新大规模调研**。',
    '产出两段式：自然语言报告 + 末尾 JSON：',
    '```json',
    '{"chase_buys":[{"code":"","name":"","rank":1,"reason":""}],"ambush_buys":[{"code":"","name":"","rank":1,"reason":""}],"cross_advice":"跨策略总建议(资金有限先做哪只)","conflict_rulings":[{"topic":"","ruling":"","evidence":""}],"isolated":[{"code":"","name":"","reason":"否决/隔离原因"}],"appendix":"主笔附言(一句话风险提示)"}',
    '```',
    '综合时落到用户偏好：①资金利用效率——给资金分配建议，闲置现金(≥20 万)提示配短期工具别空置；②主轴加分——标的若属 AI+国产算力+华为昇腾(H2 爆发预期)作正向加分；③强者恒强——RS 强的优先，温度只择时。',
    `标的：${stocklistText(stocks)}。`,
  ].join('\n');
}

// ───────────────────────── conductor ─────────────────────────
function createCommitteeConductor(deps) {
  const { dispatchTurn, getGroupMembers, emitProgress, log, persistHistory, appendSpeeches } = deps;
  const _log = typeof log === 'function' ? log : () => {};

  function emit(meetingId, type, payload) {
    try { emitProgress && emitProgress(meetingId, { type, ...payload }); } catch (e) { _log('[committee] emit threw: ' + (e && e.message)); }
  }

  // collect 可选 {acts, act, round, sub}：收集本幕各委员发言原文 + emit 'act-detail'
  // （点4：前端按幕看每个 AI 的具体表现；同步进 record.acts 供「过往投委会」回看）。
  function _detail(meetingId, collect, results) {
    if (!collect) return;
    const speeches = (results || []).map(r => ({ label: (r && r.label) || '?', text: (r && r.text) || '' })).filter(s => s.text.trim());
    if (collect.acts) collect.acts.push({ act: collect.act, round: collect.round, sub: collect.sub, speeches });
    emit(meetingId, 'act-detail', { act: collect.act, round: collect.round, sub: collect.sub, speeches });
    // 阶段二：发言进群聊 messages（气泡卡片，按时间排列）；末轮/收敛标 outcome→回归自由聊喂回 AI（点6）。
    if (typeof appendSpeeches === 'function') {
      const items = (results || []).filter(r => r && (r.text || '').trim()).map(r => ({ sid: r.sid, speaker: r.label, content: r.text, prompt: r.sourcePrompt || '' }));
      if (items.length) appendSpeeches(meetingId, items, { act: collect.act, round: collect.round, sub: collect.sub, outcome: collect.outcome });
    }
  }
  async function oneAct(meetingId, ids, prompt, timeoutMs, actLabel, collect) {
    try {
      const res = await dispatchTurn(meetingId, { userInput: prompt, targetMemberIds: ids, silent: true, turnTimeoutMs: timeoutMs });
      if (!res || !Array.isArray(res.results)) { _log(`[committee] ${actLabel}: 无 results (status=${res && res.status})`); _detail(meetingId, collect, []); return { status: 'error', results: [] }; }
      _log(`[committee] ${actLabel}: ${res.results.length} 回复, text长度=[${res.results.map(r => (r.text || '').length).join(',')}]`);
      _detail(meetingId, collect, res.results);
      return res;
    } catch (e) {
      _log(`[committee] act ${actLabel} dispatchTurn threw: ` + (e && e.message));
      _detail(meetingId, collect, []);
      return { status: 'error', results: [] };
    }
  }

  async function run(meetingId, opts = {}) {
    const startedAt = Date.now();
    const stocks = (opts.stocks || []).filter(s => s && (s.code || s.name)).map(s => ({ code: _norm6(s.code || ''), name: s.name || '' }));
    const rounds = Math.max(1, Math.min(6, Number(opts.rounds) || 4)); // rounds = 辩论轮数（立会/建库/点评/收敛是固定幕，不计入轮数）
    if (stocks.length === 0) { emit(meetingId, 'error', { reason: '未指定标的' }); return { status: 'error', reason: 'no stocks' }; }
    const rawMembers = getGroupMembers(meetingId) || [];
    if (rawMembers.length === 0) { emit(meetingId, 'error', { reason: '房间无委员' }); return { status: 'error', reason: 'no members' }; }

    const members = assignRoles(rawMembers);
    const chair = members.find(m => m.isChair) || members[0];
    const allIds = members.map(m => m.memberId);
    const chairIds = [chair.memberId];
    const state = { stocks, rounds, members: members.map(m => ({ label: m.displayName, face: m.face, isChair: m.isChair })), reviews: [], boards: null, chair: null, acts: [] };

    emit(meetingId, 'start', { stocks, rounds, chair: chair.displayName, members: state.members });

    // 幕1 立会（主席）
    emit(meetingId, 'act', { act: ACTS.CONVENE });
    await oneAct(meetingId, chairIds, convenePrompt(stocks, rounds, members), TIMEOUT.convene, ACTS.CONVENE, { acts: state.acts, act: ACTS.CONVENE });

    // 幕2 建库（全员并行）
    emit(meetingId, 'act', { act: ACTS.BUILD });
    await oneAct(meetingId, allIds, buildPrompt(stocks, members), TIMEOUT.build, ACTS.BUILD, { acts: state.acts, act: ACTS.BUILD });

    // 幕3 点评（全员并行，两段式）
    emit(meetingId, 'act', { act: ACTS.REVIEW });
    const review = await oneAct(meetingId, allIds, reviewPrompt(stocks, members), TIMEOUT.review, ACTS.REVIEW, { acts: state.acts, act: ACTS.REVIEW });
    state.reviews = extractReviews(review.results, stocks);
    state.boards = buildBoards(state.reviews, stocks);
    emit(meetingId, 'board', { boards: state.boards });

    // 幕4 辩论（委员并行交锋 + 主席串行收口，迭代）
    const debateRounds = rounds; // 用户指定几轮 = 几轮辩论（rounds 已 clamp 到 1..6）
    for (let r = 1; r <= debateRounds; r++) {
      emit(meetingId, 'act', { act: ACTS.DEBATE, round: r, total: debateRounds });
      const deb = await oneAct(meetingId, allIds, debatePrompt(stocks, state.reviews, r), TIMEOUT.debate, ACTS.DEBATE, { acts: state.acts, act: ACTS.DEBATE, round: r, sub: '交锋', outcome: (r === debateRounds) });
      state.reviews = mergeReviews(state.reviews, extractReviews(deb.results, stocks));
      state.boards = buildBoards(state.reviews, stocks);
      emit(meetingId, 'board', { boards: state.boards });
      // 主席串行收口（最后一轮跳过——紧接收敛幕会再叫主席，连续叫易致主席 PTY busy 空回）
      if (r < debateRounds) {
        await oneAct(meetingId, chairIds, debateClosePrompt(stocks, state.reviews, r), TIMEOUT.close, ACTS.DEBATE + '收口', { acts: state.acts, act: ACTS.DEBATE, round: r, sub: '收口' });
      }
    }

    // 幕5 收敛（主席换帽子）。主席可能因前幕连续被叫致首次空回 → 空则短暂等待重试一次。
    emit(meetingId, 'act', { act: ACTS.CONVERGE });
    let conv = await oneAct(meetingId, chairIds, convergePrompt(stocks, state.reviews), TIMEOUT.converge, ACTS.CONVERGE, { acts: state.acts, act: ACTS.CONVERGE, outcome: true });
    let chairText = ((conv.results || [])[0] || {}).text || '';
    if (!chairText.trim()) {
      _log('[committee] 收敛幕主席首次空回，3s 后重试一次');
      await new Promise(r => setTimeout(r, 3000));
      conv = await oneAct(meetingId, chairIds, convergePrompt(stocks, state.reviews), TIMEOUT.converge, ACTS.CONVERGE + '重试', { acts: state.acts, act: ACTS.CONVERGE, sub: '重试', outcome: true });
      chairText = ((conv.results || [])[0] || {}).text || '';
    }
    state.chair = parseChair(chairText);
    emit(meetingId, 'chair', { chair: state.chair });

    // 点6 已由 _detail→appendSpeeches 实现：末轮辩论 + 收敛幕发言已标 committeeOutcome 落进 messages，
    // 回归自由聊时 buildDelta 自动带给没看到的 AI（中间幕跳过省 token）。无需再单独收集 outcome。

    // 点3a：闭庭后持久化整场 record（含五幕 speeches）→「过往投委会」历史可回看。
    try {
      if (typeof persistHistory === 'function') {
        const id = persistHistory({
          meetingId, startedAt, endedAt: Date.now(),
          stocks, rounds, chair: chair.displayName, members: state.members,
          acts: state.acts, boards: state.boards, chairReport: state.chair,
        });
        if (id) _log(`[committee] 已存历史 ${id}（${state.acts.length} 幕）`);
      }
    } catch (e) { _log('[committee] persistHistory threw: ' + (e && e.message)); }

    emit(meetingId, 'done', { boards: state.boards, chair: state.chair, reviews: state.reviews });
    return { status: 'completed', ...state };
  }

  return { run };
}

module.exports = {
  createCommitteeConductor,
  ACTS,
  // 暴露纯函数给单测（prompt/角色为本地，extract 系列 re-export 自 committee-extract）
  _test: {
    assignRoles, pickChair, dutyTable, stocklistText,
    convenePrompt, buildPrompt, reviewPrompt, debatePrompt, debateClosePrompt, convergePrompt,
    parseLastJson, extractReviews, mergeReviews, buildBoards, parseChair,
  },
};
