/* 开发场景 · 人话通道与看板的数据层。
 *
 * 维护者不看代码。他要的是两样东西：
 *   ① 这个任务现在走到哪了（看板）
 *   ② 这一步到底干了什么（人话卡）
 *
 * 设计原则 —— 推导优先，申报兜底：
 *   能从 Hub 自己的数据算出来的（第几轮、跑没跑、停多久、判没判 PASS），一律推导；
 *   推导不出来的（干了什么、有什么风险），才读 Agent 申报的那四行。
 *   Agent 会忘记写，但群聊和循环状态是客观存在的 —— 所以推导那部分永远不会撒谎。
 *
 * 一个群聊 = 一个任务，所以「看板的一行」就是「一个开发群聊」，不需要另外维护台账。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window === 'object') window.DevProgress = api;
}(this, function () {
  'use strict';

  // 工作位的四行。标签是机器约定，值是人话。
  // 和 .agents/AUTHOR.md、project-prep skill 里教的必须逐字一致 ——
  // unit-dev-scene-contract.test.js 守着这个对齐。
  const CARD_FIELDS = [
    ['progress', /(?:^|\n)\s*PROGRESS\s*[:：]\s*([^\n]*)/i],
    ['verified', /(?:^|\n)\s*VERIFIED\s*[:：]\s*([^\n]*)/i],
    ['risk', /(?:^|\n)\s*RISK\s*[:：]\s*([^\n]*)/i],
    ['report', /(?:^|\n)\s*REPORT\s*[:：]\s*([^\n]*)/i],
  ];

  const EMPTY_WORDS = /^(无|none|n\/a|-|—|null)$/i;

  function clean(v) {
    const s = String(v == null ? '' : v).trim();
    return EMPTY_WORDS.test(s) ? '' : s;
  }

  /**
   * 从一段 Agent 输出里抠出人话卡。
   * 至少要有 PROGRESS 才算一张卡 —— 只写了 RISK 之类的残缺输出不认，
   * 免得在看板上显示半张卡让人误以为这一步已经完成。
   */
  function parseProgressCard(text) {
    const s = String(text == null ? '' : text);
    if (!s) return null;
    const out = {};
    for (const [key, re] of CARD_FIELDS) {
      const m = s.match(re);
      out[key] = m ? clean(m[1]) : '';
    }
    if (!out.progress) return null;
    return out;
  }

  /** 合并位的判定。与 loop-workflow 的 parseVerdict 同源，这里只取需要的部分。 */
  function parseReviewCard(text) {
    const s = String(text == null ? '' : text);
    const m = s.match(/(?:^|\n)\s*RESULT\s*[:：]\s*(PASS|FAIL)\b/i);
    if (!m) return null;
    const grab = (name) => {
      const r = s.match(new RegExp('(?:^|\\n)\\s*' + name + '\\s*[:：]\\s*([^\\n]*)', 'i'));
      return r ? clean(r[1]) : '';
    };
    return {
      decision: m[1].toLowerCase(),
      blockers: grab('BLOCKERS'),
      verified: grab('VERIFIED'),
      next: grab('NEXT'),
    };
  }

  const STAGE = {
    idle: { label: '未开始', tone: 'idle' },
    working: { label: '工作位实现中', tone: 'run' },
    reviewing: { label: '合并位审查中', tone: 'run' },
    rework: { label: '打回重改', tone: 'warn' },
    passed: { label: '已通过', tone: 'ok' },
    stopped: { label: '已停止', tone: 'idle' },
    exhausted: { label: '返工用尽，等你决定', tone: 'bad' },
  };

  /**
   * 一个开发群聊现在处于哪一步 —— 全部从 Hub 自己的数据推导，不问 Agent。
   *
   * loopState 的层级是 meeting.serialWorkflow.loopState（不是 meeting.status，
   * 也不是 meeting.state）—— 之前写 E2E 时在这儿栽过一次，取错层级会永远拿到空串。
   */
  function deriveStage(meeting) {
    const wf = (meeting && meeting.serialWorkflow) || {};
    const ls = wf.loopState || {};
    const running = !!(ls.running || wf.serialRunState && wf.serialRunState.running);
    const status = String(ls.status || '');
    const round = Number(ls.round) || 0;
    const maxRounds = Number(wf.loop && wf.loop.maxRounds) || 3;
    const history = Array.isArray(ls.history) ? ls.history : [];
    const passes = history.filter(h => h && h.pass).length;

    let key = 'idle';
    if (status === 'done' || passes > 0) key = 'passed';
    else if (running) key = (Number(ls.stepIndex) === 1) ? 'reviewing' : 'working';
    else if (status && status !== 'done') {
      key = (round >= maxRounds) ? 'exhausted' : 'stopped';
    } else if (round > 0) key = 'rework';

    return {
      key,
      label: STAGE[key].label,
      tone: STAGE[key].tone,
      round,
      maxRounds,
      passes,
      running,
    };
  }

  /** 从群聊消息里挑出最新的人话卡和最新的判定，给看板一行用。 */
  function latestCards(messages) {
    const list = Array.isArray(messages) ? messages : [];
    let card = null;
    let review = null;
    for (let i = list.length - 1; i >= 0; i--) {
      const text = (list[i] && (list[i].text || list[i].content)) || '';
      if (!card) card = parseProgressCard(text);
      if (!review) review = parseReviewCard(text);
      if (card && review) break;
    }
    return { card, review };
  }

  /** 距今多久 —— 卡住的 Agent 不会主动说自己卡住了，所以这个必须推导。 */
  function idleFor(meeting) {
    const ts = Number(meeting && (meeting.lastActiveTs || meeting.updatedAt || meeting.createdAt)) || 0;
    if (!ts) return '';
    const mins = Math.floor((Date.now() - ts) / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return mins + ' 分钟前';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + ' 小时前';
    return Math.floor(hrs / 24) + ' 天前';
  }

  /** 看板一行。meeting 来自 Hub 自己的会议列表，不扫任何仓库。 */
  function boardRow(meeting, messages) {
    const stage = deriveStage(meeting);
    const { card, review } = latestCards(messages);
    return {
      id: meeting && meeting.id,
      title: (meeting && meeting.title) || '(未命名任务)',
      workspace: (meeting && (meeting.workspaceLabel || meeting.workspace)) || '',
      stage,
      idle: idleFor(meeting),
      // 人话层：推导不出来的才读 Agent 申报的
      progress: card ? card.progress : '',
      verified: card ? card.verified : '',
      risk: card ? card.risk : '',
      report: card ? card.report : '',
      blockers: review && review.decision === 'fail' ? review.blockers : '',
    };
  }

  function isDevMeeting(meeting) {
    return !!(meeting && meeting.groupChat && meeting.scene === 'dev');
  }

  return {
    parseProgressCard,
    parseReviewCard,
    deriveStage,
    latestCards,
    idleFor,
    boardRow,
    isDevMeeting,
    STAGE,
  };
}));
