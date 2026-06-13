'use strict';
// 投委会场景：席位 persona / 三幕 prompt / 发言 schema 校验 / 质询触发逻辑。
// 设计：C:\Users\lintian\Desktop\claude-artifacts\investment-committee-final-v3.html + 附录一/二/三
// 编排状态机在 main/groupchat/committee-conductor.js；本文件只做纯函数（可单测）。

// ---------------------------------------------------------------- 席位定义
// kind → 席位。五席五厂商：主席与所有分析席异族（附录一硬约束）。
const SEATS = {
  fund: {
    key: 'fund', kind: 'deepseek', label: '基本面官', emoji: '🛡️',
    whitelist: 'stock_static（financial/valuation/holders/pledge 域）+ 案卷红旗面板',
  },
  news: {
    key: 'news', kind: 'claude', label: '消息面官', emoji: '📡',
    whitelist: 'stock_news + stock_sentiment + scan_sector_flow + 案卷板块对照卡',
  },
  tech: {
    key: 'tech', kind: 'codex', label: '技术面官', emoji: '📈',
    whitelist: 'stock_market + kline_similarity + 案卷技术面客观分（不需要联网）',
  },
  challenger: {
    key: 'challenger', kind: 'codex', label: '质询官', emoji: '⚔️',
    whitelist: '全部报告 + 案卷 + 全部 MCP 工具（攻击用）',
  },
  chair: {
    key: 'chair', kind: 'claude', label: '主席', emoji: '⚖️',
    whitelist: '全部材料 + 机构记忆',
  },
};

const ANALYST_KEYS = ['fund', 'news', 'tech'];
const SEAT_ORDER = ['fund', 'news', 'tech', 'challenger', 'chair'];

// 反空话禁用词（UZI 模式：命中即退回重写）
const BANNED_PHRASES = ['基本面良好', '前景广阔', '值得关注', '拭目以待', '综合来看值得', '具有投资价值'];

// ---------------------------------------------------------------- persona
const PERSONAS = {
  fund: [
    '## 你的席位：🛡️ 基本面官（投委会）',
    '职责：**不选股，只排雷 + 定支撑等级**。你是全场唯一负责回答"这是不是纯讲故事"的人。',
    '纪律：',
    '- 案卷里的【红旗预检面板】逐项必答：triggered 项必须给 ≥20 字含数字的解读；clear 项一句话确认；no_data 项说明影响。',
    '- 必须给出"故事含量评级"四档之一：纯故事（无业绩路径）/ 弱支撑（有逻辑无兑现）/ 有支撑（在手订单或产能落地中）/ 兑现中（已进财报）。',
    '- 你持一票限制权：评"纯故事"时全场最高只能评 A 级（短线打野且强制限仓），在 JSON 的 story_level 字段表达。',
    '- 只看你的数据白名单（财务/估值/股东/质押），不要评论技术面和题材热度——那是别人的席位。',
    '- 实控人质押率>50%、财务造假信号（存贷双高等）= 一票否决信号，必须显著标出。',
  ].join('\n'),
  news: [
    '## 你的席位：📡 消息面官（投委会）',
    '职责：叙事 + 催化双查。',
    '纪律：',
    '- **叙事组必答**：故事级别四档（国家叙事/产业叙事/公司叙事/蹭热点）+ 板块卡位四选一（龙头/中军/跟风补涨/独立行情）。跟风补涨身份必须压低你的 confidence。',
    '- **催化组必答**：未来 1-3 个月**带日期**的催化剂清单（业绩窗口/发布会/招标/解禁/政策会议）。没有日期的"长期利好"不算催化剂。',
    '- **预期差必答**：市场已定价什么（参考研报一致预期+股价位置）vs 可能发生什么，差值在哪。说不清预期差就承认没有。',
    '- 消息事实只来自 stock_news / stock_sentiment / scan_sector_flow 工具返回与案卷；凭记忆的价格/公告断言禁止，查不到就明说"未查到"。',
    '- 案卷里的板块对照卡若提示有卡位更好的同行，必须如实在 sector_position 里写明。',
  ].join('\n'),
  tech: [
    '## 你的席位：📈 技术面官（投委会）',
    '职责：趋势阶段 + 资金 + 关键位。',
    '纪律：',
    '- 必答：趋势阶段四档（启动/主升/末段/破位震荡）+ 关键支撑位/压力位/建议止损位（必须给数字和计算依据，如"前低 42.0 下方 3%"）。',
    '- 优先用案卷里的技术面客观分组件 + stock_market(symbol)；可调 kline_similarity(symbol) 查历史相似形态的前向收益并如实引用（哪怕对结论不利）。',
    '- ADX/趋势不明朗的震荡市，你的 signal 应倾向"中性"而不是硬给方向。',
    '- 你不需要联网，不要评论基本面与消息面——那是别人的席位。',
    '- 涨跌幅、量比等数字必须来自工具返回或案卷，禁止凭记忆。',
  ].join('\n'),
  challenger: [
    '## 你的席位：⚔️ 质询官（投委会·常设魔鬼代言人）',
    '职责：**不持立场，只攻击**。无论三位分析官共识看多还是看空，你永远站对立面。',
    '纪律：',
    '- 从三份报告的 assumptions 里挑出全场最脆弱的 2-3 条，逐条给出具体反驳（要数据/事实，不要"我觉得风险大"）。',
    '- 特别职责【预期差打假】：检查所谓催化剂是否早已 price-in（看股价近期是否已抢跑、研报是否已集中上调）。这是本投委会风格里最容易亏钱的点。',
    '- 可以调任何 MCP 工具核查报告里的数字；发现报告数字与工具返回不符必须点名。',
    '- 输出格式：自由文本质询，但结尾必须附一个 ```json 块：{"targets":[{"seat":"fund|news|tech","assumption":"原文","attack":"你的反驳"}],"priced_in_risk":"high|medium|low","summary":"一句话"}。',
  ].join('\n'),
  chair: [
    '## 你的席位：⚖️ 主席（投委会·终审裁判 + 记忆管理人）',
    '职责：综合三份报告 + 质询记录 + 案卷 + 机构记忆，输出最终决议。',
    '纪律：',
    '- 你必须按用户的"价值投机"风格裁决：基本面决定下限，题材正宗性/预期差/资金弹性/技术节奏决定是否值得短中线出手。',
    '- 防和稀法铁律：**B（观察池）仅限双方证据真正势均力敌时使用**，三面数据有倾斜就必须表态。',
    '- 尊重覆盖度门控：案卷标注"本场最高可评级 B"时不得给 S/A。',
    '- 尊重基本面官一票限制权：story_level=纯故事 → 最高 A 级且必须注明限仓。',
    '- S/A 级必须给清楚仓位角色、仓位上限、加仓条件、减仓条件；基本面托底弱或题材蹭热点时不得给 S。',
    '- 替代标的检查必答：对照板块对照卡回答"为什么是它而不是同板块的 X"，或建议改研 X。',
    '- 记忆回执必答：引用过的决议/教训必须带真实 ID（案卷机构记忆区给出的），没引用就留空数组，禁止编造 ID。',
    '- 校准期外，参考案卷里的席位记分牌对各席位报告做置信度折扣。',
    '- 决议正文用简洁中文（先结论后论据），结尾必须附符合 schema 的 ```json 块。',
  ].join('\n'),
};

function buildCommitteePersona(keyOrKind) {
  const legacyByKind = {
    deepseek: 'fund',
    kimi: 'news',
    qwen: 'tech',
    codex: 'challenger',
    claude: 'chair',
  };
  const key = legacyByKind[keyOrKind] || keyOrKind;
  return PERSONAS[key] || null;
}

// ---------------------------------------------------------------- 三幕 prompt
const ANALYST_JSON_SPEC = [
  '```json',
  '{',
  '  "seat": "fund|news|tech",',
  '  "signal": "看多|中性|看空|skip",',
  '  "confidence": 0-100 的整数,',
  '  "core_thesis": "一句话核心论点（禁空话）",',
  '  "assumptions": ["核心假设 2-5 条，显式可被攻击"],',
  '  "evidence": [{"claim": "论据", "source": "工具名/案卷区块/URL", "strength": "strong|medium|weak"}],',
  '  "kill_switch": "什么情况说明我错了（必填）",',
  '  "extras": { 席位专属字段，见你的席位纪律：',
  '    fund → "story_level": "纯故事|弱支撑|有支撑|兑现中", "red_flag_review": [{"name":"红旗名","comment":"解读"}]',
  '    news → "story_grade": "国家叙事|产业叙事|公司叙事|蹭热点", "sector_position": "龙头|中军|跟风补涨|独立行情", "catalysts": [{"date":"YYYY-MM-DD 或月份","event":"...","expectation_gap":"市场以为X，可能是Y"}]',
  '    tech → "trend_stage": "启动|主升|末段|破位震荡", "support": 数字, "resistance": 数字, "stop_suggest": 数字 }',
  '}',
  '```',
].join('\n');

function buildAct1Prompt(mentions, caseMarkdown) {
  return [
    `【投委会 · 幕一 · 独立研判】 ${mentions}`,
    '',
    '三位分析官请基于下方案卷 + 各自席位的数据白名单独立研判。**互不参考队友本轮发言**（你们是并行作答）。',
    '要求：先 3-6 句口头要点（给用户看），然后必须输出一个 ```json 块，schema 如下：',
    '',
    ANALYST_JSON_SPEC,
    '',
    '证据分级标准：strong=交易所公告/财报/中标文件；medium=权威媒体/研报/工具返回的行情数据；weak=股吧帖/传闻/无来源。weak 证据不得单独支撑 confidence>60。',
    `禁用词（出现即退回重写）：${BANNED_PHRASES.join('、')}。`,
    '',
    '---',
    '',
    caseMarkdown,
  ].join('\n');
}

function buildAct2ChallengePrompt(mention) {
  return [
    `【投委会 · 幕二 · 质询】 ${mention}`,
    '',
    '三位分析官的报告已在上文。请按你的席位纪律发起攻击：',
    '1. 挑出最脆弱的 2-3 条 assumptions 逐条反驳（用工具核查数字）；',
    '2. 预期差打假：催化剂是否已 price-in？',
    '3. 结尾附 ```json 块（targets/priced_in_risk/summary）。',
  ].join('\n');
}

function buildAct2DefensePrompt(mentions, attackSummary) {
  return [
    `【投委会 · 幕二 · 答辩】 ${mentions}`,
    '',
    '质询官针对你的假设发起了攻击（见上文）。请逐条回应：承认、反驳（带数据）或修正。',
    '如果你修正了 signal / confidence / assumptions，**必须重新输出完整的 ```json 块**（同幕一 schema）；维持原判则只需文字回应+一句"维持原判"。',
    attackSummary ? `\n质询要点：${attackSummary}` : '',
  ].join('\n');
}

const VERDICT_JSON_SPEC = [
  '```json',
  '{',
  '  "rating": "S|A|B|C",',
  '  "position_type": "中线主仓候选|短线打野|观察池|回避",',
  '  "core_thesis": "一句话决议",',
  '  "faces": {"fundamental": {"score": -100到100, "comment": ""}, "news": {"score": ..., "comment": ""}, "technical": {"score": ..., "comment": ""}},',
  '  "value_speculation": {"fundamental_floor": "强|中|弱|无", "theme_purity": "正宗|沾边|蹭热点|无", "expectation_gap": "明确|一般|弱|无", "flow_elasticity": "强|中|弱|未知", "timing_window": "1-3个月窗口说明", "composite_score": 0-100, "vetoes": ["一票否决项，无则空数组"]},',
  '  "portfolio": {"role": "核心仓|弹性仓|观察仓|禁入", "suggested_cap_pct": 0-100 的仓位上限数字, "add_rule": "什么情况下加仓", "trim_rule": "什么情况下减仓/退出"},',
  '  "entry": {"zone": "介入区间（S/A 必填，带计算逻辑）", "logic": ""},',
  '  "stop": "止损位（S/A 必填）",',
  '  "position_cap": "仓位上限说明（story_level=纯故事时必填限仓）",',
  '  "catalysts": [{"date": "", "event": ""}],',
  '  "disagreements": ["分歧清单：谁在哪个格子上不同意，可为空数组"],',
  '  "alt_check": "替代标的检查：为什么是它而不是同板块的 X / 或建议改研 X（必填）",',
  '  "assumptions": ["决议依赖的核心假设汇总 2-5 条"],',
  '  "kill_switch_summary": ["全盘推翻条件 1-3 条"],',
  '  "upgrade_trigger": "B 级必填：满足什么条件升级",',
  '  "if_holding": "若已持有的动作建议",',
  '  "if_not_holding": "若未持有的动作建议",',
  '  "memory_read": ["引用过的 V-/L- ID，没有则空数组"],',
  '  "lesson_suggest": null 或 {"text": "建议沉淀的教训", "tags": ["板块/形态标签"]}',
  '}',
  '```',
].join('\n');

function buildAct3ChairPrompt(mention, opts = {}) {
  const { maxRating, challengeHeld, calibrationActive, baseline } = opts;
  const baselineLine = baseline && baseline.n
    ? `机器加权基线（按各官 confidence 加权，程序化锚）：方向 **${baseline.direction}** · 净分 ${baseline.net_score} · 共识强度 ${baseline.consensus}%（多 ${Math.round(baseline.bull)}/空 ${Math.round(baseline.bear)}/中 ${Math.round(baseline.neutral)}）。**若你的最终评级方向与该基线相悖，必须在决议正文明确说明为何偏离**（防单席强叙事带偏）。`
    : null;
  return [
    `【投委会 · 幕三 · 主席裁决】 ${mention}`,
    '',
    '全部材料已在上文（案卷 + 三官报告' + (challengeHeld ? ' + 质询与答辩' : '，本场未触发质询') + '）。请按席位纪律裁决。',
    `本场覆盖度门控：最高可评级 **${maxRating || 'S'}**。`,
    baselineLine,
    calibrationActive ? '当前为校准期：记分牌不参与置信度折扣。' : '请参考案卷记分牌做置信度折扣。',
    '先输出简洁的决议正文（结论→价值投机四格→三面共振→分歧→操作建议），结尾必须附 ```json 块：',
    '',
    VERDICT_JSON_SPEC,
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------- JSON 提取与校验
// 扫描所有括号配平的 {...} 子串（忽略字符串内的括号），按出现顺序返回。
function balancedObjects(s) {
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { if (inStr) esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') { if (depth === 0) start = i; depth += 1; }
    else if (c === '}') {
      if (depth > 0) { depth -= 1; if (depth === 0 && start >= 0) { out.push(s.slice(start, i + 1)); start = -1; } }
    }
  }
  return out;
}

function extractJsonBlock(text) {
  if (!text) return null;
  // 优先 ```json 围栏（取最后一个能解析的）
  const re = /```json\s*([\s\S]*?)```/g;
  let m;
  const fenced = [];
  while ((m = re.exec(text)) !== null) fenced.push(m[1]);
  for (let i = fenced.length - 1; i >= 0; i -= 1) {
    const p = parseJsonLoose(fenced[i]);
    if (p && typeof p === 'object') return p;
  }
  // 兜底：括号配平扫描（修复 2026-06-13 审计：原版 lastIndexOf('\n{') 不配平，
  // 模型不用围栏 / JSON 不以换行+{ 开头 / JSON 后还跟解释 时都会截错起止点）。
  const objs = balancedObjects(text);
  for (let i = objs.length - 1; i >= 0; i -= 1) {
    const p = parseJsonLoose(objs[i]);
    if (p && typeof p === 'object') return p;
  }
  return null;
}

function escapeBareQuotesInJsonStrings(src) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j += 1;
      const next = src[j];
      if (next === ':' || next === ',' || next === '}' || next === ']' || next === undefined) {
        inString = false;
        out += ch;
      } else {
        out += '\\"';
      }
      continue;
    }
    out += ch;
  }
  return out;
}

function parseJsonLoose(raw) {
  const trimmed = String(raw || '').trim();
  const noTrailingComma = trimmed.replace(/,\s*([}\]])/g, '$1');
  const candidates = [
    trimmed,
    noTrailingComma,
    escapeBareQuotesInJsonStrings(trimmed),
    escapeBareQuotesInJsonStrings(noTrailingComma),
  ];
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* try next */ }
  }
  return null;
}

const SIGNALS = ['看多', '中性', '看空', 'skip'];
const STRENGTHS = ['strong', 'medium', 'weak'];

function validateAnalystReport(obj, seatKey) {
  const errors = [];
  if (!obj || typeof obj !== 'object') return { ok: false, errors: ['未找到合法 JSON 块'] };
  if (!SIGNALS.includes(obj.signal)) errors.push(`signal 必须是 ${SIGNALS.join('/')}`);
  const conf = Number(obj.confidence);
  if (!(conf >= 0 && conf <= 100)) errors.push('confidence 必须是 0-100');
  if (!obj.core_thesis || String(obj.core_thesis).trim().length < 4) errors.push('core_thesis 缺失');
  const banned = BANNED_PHRASES.filter(p => String(obj.core_thesis || '').includes(p));
  if (banned.length) errors.push(`core_thesis 命中禁用词: ${banned.join('、')}`);
  if (!Array.isArray(obj.assumptions) || obj.assumptions.length < 1) errors.push('assumptions 至少 1 条');
  if (!Array.isArray(obj.evidence) || obj.evidence.length < 1) {
    if (obj.signal !== 'skip') errors.push('evidence 至少 1 条');
  } else {
    obj.evidence.forEach((e, i) => {
      if (!e || !e.claim) errors.push(`evidence[${i}] 缺 claim`);
      if (!e || !e.source) errors.push(`evidence[${i}] 缺 source（工具名/案卷区块/URL）`);
      if (!e || !STRENGTHS.includes(e.strength)) errors.push(`evidence[${i}].strength 必须是 strong/medium/weak`);
    });
    const hasNonWeak = obj.evidence.some(e => e && (e.strength === 'strong' || e.strength === 'medium'));
    if (!hasNonWeak && conf > 60) errors.push('全部证据为 weak 时 confidence 不得超过 60');
  }
  if (!obj.kill_switch || String(obj.kill_switch).trim().length < 4) errors.push('kill_switch 必填');
  const extras = obj.extras || {};
  if (seatKey === 'fund') {
    if (!['纯故事', '弱支撑', '有支撑', '兑现中'].includes(extras.story_level)) {
      errors.push('extras.story_level 必须是 纯故事/弱支撑/有支撑/兑现中');
    }
    if (!Array.isArray(extras.red_flag_review) || extras.red_flag_review.length < 1) {
      errors.push('extras.red_flag_review 必填（红旗面板逐项必答）');
    }
  }
  if (seatKey === 'news') {
    if (!['龙头', '中军', '跟风补涨', '独立行情'].includes(extras.sector_position)) {
      errors.push('extras.sector_position 必须是 龙头/中军/跟风补涨/独立行情');
    }
    if (!Array.isArray(extras.catalysts)) errors.push('extras.catalysts 必填（可为空数组但要给出）');
  }
  if (seatKey === 'tech') {
    if (!['启动', '主升', '末段', '破位震荡'].includes(extras.trend_stage)) {
      errors.push('extras.trend_stage 必须是 启动/主升/末段/破位震荡');
    }
  }
  return { ok: errors.length === 0, errors };
}

const RATING_ORDER = { S: 4, A: 3, B: 2, C: 1 };
const POSITION_TYPES = ['中线主仓候选', '短线打野', '观察池', '回避'];
const VALUE_SPEC_ENUMS = {
  fundamental_floor: ['强', '中', '弱', '无'],
  theme_purity: ['正宗', '沾边', '蹭热点', '无'],
  expectation_gap: ['明确', '一般', '弱', '无'],
  flow_elasticity: ['强', '中', '弱', '未知'],
};
const PORTFOLIO_ROLES = ['核心仓', '弹性仓', '观察仓', '禁入'];

function validateVerdict(obj, opts = {}) {
  const errors = [];
  if (!obj || typeof obj !== 'object') return { ok: false, errors: ['未找到合法 JSON 块'] };
  if (!RATING_ORDER[obj.rating]) errors.push('rating 必须是 S/A/B/C');
  if (!POSITION_TYPES.includes(obj.position_type)) errors.push(`position_type 必须是 ${POSITION_TYPES.join('/')}`);
  const maxRating = opts.maxRating || 'S';
  if (RATING_ORDER[obj.rating] > RATING_ORDER[maxRating]) {
    errors.push(`覆盖度门控限制本场最高 ${maxRating}，不得评 ${obj.rating}`);
  }
  if (opts.storyLevelPure && (obj.rating === 'S')) {
    errors.push('基本面官判定"纯故事"，一票限制权生效：最高只能评 A');
  }
  if (!obj.core_thesis) errors.push('core_thesis 必填');
  if ((obj.rating === 'S' || obj.rating === 'A')) {
    if (!obj.entry || !obj.entry.zone) errors.push('S/A 级必须给 entry.zone');
    if (!obj.stop) errors.push('S/A 级必须给 stop');
  }
  if (obj.rating === 'B' && !obj.upgrade_trigger) errors.push('B 级必须给 upgrade_trigger');
  if (!obj.alt_check) errors.push('alt_check（替代标的检查）必填');
  if (!Array.isArray(obj.disagreements)) errors.push('disagreements 必须是数组（可为空）');
  const vs = obj.value_speculation;
  if (!vs || typeof vs !== 'object') {
    errors.push('value_speculation 必填（价值投机四格）');
  } else {
    for (const [k, allowed] of Object.entries(VALUE_SPEC_ENUMS)) {
      if (!allowed.includes(vs[k])) errors.push(`value_speculation.${k} 必须是 ${allowed.join('/')}`);
    }
    const score = Number(vs.composite_score);
    if (!(score >= 0 && score <= 100)) errors.push('value_speculation.composite_score 必须是 0-100');
    if (!vs.timing_window) errors.push('value_speculation.timing_window 必填');
    if (!Array.isArray(vs.vetoes)) errors.push('value_speculation.vetoes 必须是数组（可为空）');
    if (obj.rating === 'S' && ['弱', '无'].includes(vs.fundamental_floor)) {
      errors.push('S 级必须有基本面托底（fundamental_floor 不能是 弱/无）');
    }
    if (obj.rating === 'S' && ['蹭热点', '无'].includes(vs.theme_purity)) {
      errors.push('S 级题材必须正宗或至少沾边（theme_purity 不能是 蹭热点/无）');
    }
  }
  const pf = obj.portfolio;
  if (!pf || typeof pf !== 'object') {
    errors.push('portfolio 必填（组合仓位角色）');
  } else {
    if (!PORTFOLIO_ROLES.includes(pf.role)) errors.push(`portfolio.role 必须是 ${PORTFOLIO_ROLES.join('/')}`);
    const cap = Number(pf.suggested_cap_pct);
    if (!(cap >= 0 && cap <= 100)) errors.push('portfolio.suggested_cap_pct 必须是 0-100');
    if (!pf.add_rule) errors.push('portfolio.add_rule 必填');
    if (!pf.trim_rule) errors.push('portfolio.trim_rule 必填');
    if (obj.rating === 'C' && cap > 0) errors.push('C 级回避票 portfolio.suggested_cap_pct 必须为 0');
  }
  if (!Array.isArray(obj.memory_read)) errors.push('memory_read 必须是数组（可为空）');
  if (Array.isArray(obj.memory_read) && Array.isArray(opts.validMemoryIds)) {
    const valid = new Set(opts.validMemoryIds);
    const fake = obj.memory_read.filter(id => !valid.has(id));
    if (fake.length) errors.push(`memory_read 含案卷中不存在的 ID（禁止编造记忆）: ${fake.join(', ')}`);
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------- 质询触发
// 反直觉规则（v3 §4.2）：三官越一致越要质询；已有实质分歧则跳过直接裁决。
function decideChallenge(reports, mode) {
  // 反直觉规则量化版（2026-06-13）：用机器加权共识度替代二元"全同向"，
  // 并修审计 bug——avgConf 只对"有效且有方向"的报告求均值（旧版把 errored conf=null→0
  // 计入拉低均值、样本集与 signal 判定不一致）。
  const directional = ANALYST_KEYS
    .map(k => reports && reports[k])
    .filter(r => r && r.valid !== false && r.json && r.json.signal !== 'skip' && r.json.signal !== '中性' && Number(r.json.confidence) >= 0)
    .map(r => ({ signal: r.json.signal, conf: Number(r.json.confidence) }));
  const avgConf = directional.length ? directional.reduce((a, b) => a + b.conf, 0) / directional.length : 0;
  const allSame = directional.length >= 2 && directional.every(d => d.signal === directional[0].signal);
  const agg = aggregateSignals(reports);

  if (mode === 'full') return { challenge: true, reason: '全量模式必质询' };
  // 高一致（同向 + 共识强度高 + 平均信心高）→ 越一致越要质询防 groupthink
  if (allSame && avgConf > 70) {
    return { challenge: true, reason: `三官同向（${directional[0].signal}）平均 confidence ${Math.round(avgConf)}>70、机器共识 ${agg.consensus}% —— 一致性越高越要质询（防 groupthink）` };
  }
  // 次高一致：未全同向但加权共识很强（≥80%）且方向明确，仍触发——分歧很小等同 groupthink 风险
  if (agg.consensus >= 80 && agg.direction !== '中性' && directional.length >= 2 && avgConf > 60) {
    return { challenge: true, reason: `加权共识高度集中（${agg.direction} ${agg.consensus}%）—— 实质分歧过小，触发质询防一致性陷阱` };
  }
  return { challenge: false, reason: allSame ? '同向但信心不足，主席直接裁决' : `三官已有实质分歧（加权共识 ${agg.consensus}%），分歧本身就是裁判需要的信息` };
}

// 机器加权基线（ai-hedge-fund/TradingAgents 范式）：按各官 confidence 加权聚合方向，
// 作为主席裁决的程序化锚——主席若偏离须说明理由，对冲单席强叙事带偏（反 sycophancy）。
// 纯程序化、零额外 AI 调用。返回 {direction, net_score, consensus, bull, bear, neutral, n}。
function aggregateSignals(reports) {
  let bull = 0, bear = 0, neutral = 0, n = 0;
  for (const key of ANALYST_KEYS) {
    const r = reports && reports[key];
    const j = r && r.valid !== false && r.json;
    if (!j || j.signal === 'skip') continue;
    const conf = Number(j.confidence);
    if (!(conf >= 0)) continue;
    n += 1;
    if (j.signal === '看多') bull += conf;
    else if (j.signal === '看空') bear += conf;
    else neutral += conf;
  }
  const total = bull + bear + neutral;
  if (!total) return { direction: '中性', net_score: 0, consensus: 0, bull, bear, neutral, n };
  const netScore = Math.round(((bull - bear) / total) * 100);
  const direction = netScore > 10 ? '看多' : (netScore < -10 ? '看空' : '中性');
  const consensus = Math.round((Math.max(bull, bear) / total) * 100);
  return { direction, net_score: netScore, consensus, bull, bear, neutral, n };
}

// 输入解析：6 位代码 + 可选模式词
function parseCommitteeCommand(userInput) {
  const text = String(userInput || '').trim();
  if (parseCheckupCommand(text)) return null; // 体检命令优先级更高，避免误判立项
  const m = text.match(/\b(\d{6})(\.(SZ|SH|BJ))?\b/i);
  if (!m) return null;
  const full = /全量|深度|full/i.test(text);
  return { symbol: m[1] + (m[2] || ''), mode: full ? 'full' : 'quick' };
}

// 持仓体检命令：'体检' + 持仓截图路径（Hub 粘贴图片自动落 images/ 并把路径写进消息）。
// 也支持无图纯文本：'体检 002230 成本41.5 600519 成本1500'
function parseCheckupCommand(userInput) {
  const text = String(userInput || '').trim();
  const img = text.match(/([A-Za-z]:\\[^\s"'<>|?*]+\.(?:png|jpg|jpeg|webp|bmp))/i);
  if (img) return { imagePath: img[1] };
  if (!/体检|健诊|持仓检查/.test(text)) return null;
  const positions = [];
  const re = /(\d{6})(?:[^\d]{0,6}(?:成本|cost)[^\d]{0,3}([\d.]+))?/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    positions.push({ symbol: m[1], cost: m[2] ? Number(m[2]) : null });
  }
  if (!positions.length) return null;
  return { positions };
}

// ── 持仓体检三段 prompt ─────────────────────────────────────────────────────

function buildCheckupOcrPrompt(mention, imagePath) {
  return [
    `【投委会 · 持仓体检 · 识别】 ${mention}`,
    `请用 Read 工具读取持仓截图：${imagePath}`,
    '逐行实际识别（禁止凭记忆或上下文猜测任何一行），输出 ```json 块：',
    '```json',
    '{ "positions": [{ "name": "股票名", "symbol": "6位代码（截图无代码则按名称推断并标注 inferred:true）",',
    '    "shares": 持仓数量, "cost": 成本价, "price": 现价, "pnl_pct": 盈亏百分比数字 }],',
    '  "total_asset": 总资产数字或null, "position_pct": 仓位百分比数字或null }',
    '```',
    '识别不清的字段填 null 并在 JSON 后说明；不要漏行、不要编造截图里没有的持仓。',
  ].join('\n');
}

function buildCheckupAnalystPrompt(mentions, positionsBrief, casesMarkdown) {
  return [
    `【投委会 · 持仓体检 · 研判】 ${mentions}`,
    '对下列持仓逐只体检。这是"该不该继续持有"的审查，不是新票立项。',
    '',
    '**卖出正反双清单（裁决标尺，逐只过）：**',
    '该走的理由（命中任一须明示）：①核心持有逻辑被证伪 ②催化剂已落空/已兑现 ③所在板块整体退潮 ④触发前次决议的 kill_switch；',
    '不许走的理由（仅命中这些时禁止建议清仓）：①单日大跌 ②大盘恐慌 ③单家评级下调 ④催化剂日期未到。',
    '',
    '基本面官：逐只给红旗复核 + 故事含量是否恶化；技术面官：逐只给趋势健康度（完好/转弱/破位）+ 关键止损位。',
    '每人输出一个 ```json 块：',
    '```json',
    '{ "seat": "fund|tech", "checks": [{ "symbol": "6位代码", "signal": "健康|警惕|危险",',
    '    "sell_reasons_hit": ["命中的该走理由，无则空数组"], "hold_guards_hit": ["命中的不许走理由"],',
    '    "comment": "≥20字含具体数字", "stop_suggest": 技术面官必填止损数字 }] }',
    '```',
    '',
    `**持仓：**\n${positionsBrief}`,
    '',
    '---',
    casesMarkdown,
  ].join('\n');
}

function buildCheckupChairPrompt(mention) {
  return [
    `【投委会 · 持仓体检 · 裁决】 ${mention}`,
    '两位官的体检报告已在上文。逐只裁决，纪律：',
    '- 动作四选一：持有 / 加仓 / 减仓 / 清仓；"减仓/清仓"必须引用命中的"该走理由"；只命中"不许走理由"时禁止减清。',
    '- 每只必给：止损位（采纳或修正技术面官建议）+ 下次复检触发条件。',
    '- 组合层必须回答：集中度是否过高、是否同题材拥挤、明天最先处理哪一只。',
    '结尾输出 ```json 块：',
    '```json',
    '{ "checkups": [{ "symbol": "6位代码", "name": "名", "action": "持有|加仓|减仓|清仓",',
    '    "reason": "一句话", "stop": 止损数字, "recheck_trigger": "什么情况要再开体检" }],',
    '  "portfolio_note": "组合层一句话（仓位/集中度）",',
    '  "portfolio_risk": {"concentration": "高|中|低", "theme_crowding": "高|中|低|未知", "first_action": "明天最先处理的股票/动作"} }',
    '```',
  ].join('\n');
}

// OCR 输出字段归一化：模型可能自由发挥字段名（holding/shares、"215.27%"/数字），
// 2026-06-12 真实截图测试观察到的变体在此统一。
function normalizeCheckupPositions(obj) {
  const toNum = (v) => {
    if (v === null || v === undefined) return null;
    const n = Number(String(v).replace(/[%,，\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const positions = (obj && Array.isArray(obj.positions) ? obj.positions : []).map(p => ({
    name: p.name || null,
    symbol: String(p.symbol || '').replace(/\D/g, '').slice(0, 6),
    shares: toNum(p.shares ?? p.holding ?? p.quantity),
    cost: toNum(p.cost),
    price: toNum(p.price ?? p.current_price),
    pnl_pct: toNum(p.pnl_pct ?? p.pnlPercent),
  }));
  return {
    positions,
    total_asset: toNum(obj && (obj.total_asset ?? obj.total_assets)),
    position_pct: toNum(obj && (obj.position_pct ?? obj.position_ratio)),
  };
}

function validateCheckupOcr(obj) {
  const errors = [];
  if (!obj || !Array.isArray(obj.positions) || obj.positions.length === 0) {
    return { ok: false, errors: ['未识别出 positions'] };
  }
  obj.positions.forEach((p, i) => {
    if (!p || !p.name) errors.push(`positions[${i}] 缺 name`);
    if (!p || !/^\d{6}$/.test(String(p.symbol || ''))) errors.push(`positions[${i}].symbol 须为6位代码`);
  });
  return { ok: errors.length === 0, errors };
}

function validateCheckupVerdict(obj, expectedSymbols = []) {
  const errors = [];
  if (!obj || !Array.isArray(obj.checkups) || obj.checkups.length === 0) {
    return { ok: false, errors: ['未找到 checkups'] };
  }
  const actions = ['持有', '加仓', '减仓', '清仓'];
  const seen = new Set();
  obj.checkups.forEach((c, i) => {
    if (!c || !actions.includes(c.action)) errors.push(`checkups[${i}].action 必须是 ${actions.join('/')}`);
    if (!c || !c.reason) errors.push(`checkups[${i}] 缺 reason`);
    const stop = Number(c && c.stop);
    if (!(stop > 0)) errors.push(`checkups[${i}] 缺有效 stop`);
    if (!c || !c.recheck_trigger) errors.push(`checkups[${i}] 缺 recheck_trigger`);
    if (c && c.symbol) seen.add(String(c.symbol));
  });
  const missing = expectedSymbols.filter(s => !seen.has(String(s)));
  if (missing.length) errors.push(`漏裁持仓: ${missing.join(',')}`);
  if (!obj.portfolio_note) errors.push('portfolio_note 必填');
  const pr = obj.portfolio_risk;
  if (!pr || typeof pr !== 'object') {
    errors.push('portfolio_risk 必填');
  } else {
    if (!['高', '中', '低'].includes(pr.concentration)) errors.push('portfolio_risk.concentration 必须是 高/中/低');
    if (!['高', '中', '低', '未知'].includes(pr.theme_crowding)) errors.push('portfolio_risk.theme_crowding 必须是 高/中/低/未知');
    if (!pr.first_action) errors.push('portfolio_risk.first_action 必填');
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  SEATS,
  ANALYST_KEYS,
  SEAT_ORDER,
  BANNED_PHRASES,
  buildCommitteePersona,
  buildAct1Prompt,
  buildAct2ChallengePrompt,
  buildAct2DefensePrompt,
  buildAct3ChairPrompt,
  extractJsonBlock,
  validateAnalystReport,
  validateVerdict,
  decideChallenge,
  aggregateSignals,
  parseCommitteeCommand,
  // 持仓体检场景
  parseCheckupCommand,
  buildCheckupOcrPrompt,
  buildCheckupAnalystPrompt,
  buildCheckupChairPrompt,
  normalizeCheckupPositions,
  validateCheckupOcr,
  validateCheckupVerdict,
  RATING_ORDER,
};
