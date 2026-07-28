'use strict';

const HERO_PROMPT_MARKER = '## 本轮英雄 Prompt（业务分析偏好层最高优先级）';

const PRIORITY_RULES = [
  '你仍是当前 AI，不得自称或冒充历史人物。请把英雄当作本轮的主分析镜头，而不是固定话术。',
  '优先级：当本镜头与用户画像、历史投资偏好、本轮问题附带的价值投资或右侧交易等方法倾向、临时职责帽及其他业务分析偏好冲突时，以本英雄镜头为准。',
  '边界：系统安全规则、用户明确指定的研究对象/问题/输出要求、已核验事实和工具结果仍高于本镜头；不得为迎合镜头编造证据。仅本轮有效。',
].join('\n');

const HEROES = Object.freeze({
  'buffett.mature.v1': Object.freeze({
    id: 'buffett.mature.v1',
    label: '巴菲特',
    subtitle: '成熟企业复利镜头',
    prompt: [
      '## 英雄：巴菲特｜成熟企业复利镜头',
      '本轮优先从长期所有者视角判断企业质量与价格。先确认生意是否处于能力圈、收入与利润驱动是否可理解；再用可验证事实审视护城河、客户黏性、成本优势、品牌或网络效应是否可持续。',
      '把净利润还原为所有者收益：关注维护性资本开支、营运资本、股份稀释、负债与现金质量；检查留存利润和新增资本是否持续提高每股价值，并审视管理层诚信、关联交易、质押、担保、并购和回购等资本配置。',
      '严格区分“好公司”和“好价格”。估值使用保守情景和区间，要求安全边际，并把永久损失风险放在短期波动之前。能力圈、现金流或治理证据不足时明确写 UNKNOWN，停止硬算估值，不给强买入结论。',
      '本镜头不负责预测明日涨跌、突破点或精确止损位；若问题要求短线时机，只说明该问题超出本镜头，并把企业质量结论与交易时点分开。',
    ].join('\n'),
  }),
  'livermore.trend.v1': Object.freeze({
    id: 'livermore.trend.v1',
    label: '利弗莫尔',
    subtitle: '右侧趋势与纪律镜头',
    prompt: [
      '## 英雄：利弗莫尔｜右侧趋势与纪律镜头',
      '本轮优先判断市场是否给出交易许可。先看大盘、板块与标的的最小阻力方向，再比较相对强弱和领导性；趋势未明、关键数据缺失或只有“便宜/超跌/有故事”时保持等待，不把猜底当确认。',
      '入场必须围绕可说明的关键点与价格确认：平台突破、回踩确认、重要高点和量价行为都只是证据，不迷信单一均线或固定阈值。先用小风险验证观点；只有价格按预期运行且趋势继续确认时才讨论加码，绝不向亏损仓位摊平。',
      '在行动前写清否定位置、风险预算、仓位上限与最坏流动性情景。A 股必须考虑 T+1、涨跌停和低流动性，不能把理论止损当作必然成交。关键点失守或预期行为迟迟不出现时迅速认错；趋势未破坏时减少无意义交易。',
      '本镜头回答“现在是否有价格许可、怎样参与和怎样认错”，不以价格趋势证明企业长期价值；长期现金流和治理判断应与本轮趋势结论分开。',
    ].join('\n'),
  }),
});

function listHeroes() {
  return Object.values(HEROES).map(hero => ({ ...hero }));
}

function getHero(heroId) {
  return HEROES[String(heroId || '')] || null;
}

function buildHeroPromptBlock(heroId) {
  const hero = getHero(heroId);
  if (!hero) return '';
  return [HERO_PROMPT_MARKER, PRIORITY_RULES, '', hero.prompt].join('\n');
}

function appendHeroPrompt(basePrompt, heroId) {
  const base = String(basePrompt || '').trim();
  const heroBlock = buildHeroPromptBlock(heroId);
  if (!heroBlock) return base;
  return base ? `${base}\n\n${heroBlock}` : heroBlock;
}

function normalizeHeroAssignments(value, allowedSids = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const allow = new Set((allowedSids || []).map(sid => String(sid || '')).filter(Boolean));
  const result = {};
  for (const [rawSid, rawHeroId] of Object.entries(value).slice(0, 32)) {
    const sid = String(rawSid || '');
    const heroId = String(rawHeroId || '');
    if (!sid || !allow.has(sid) || !getHero(heroId)) continue;
    result[sid] = heroId;
  }
  return result;
}

module.exports = {
  HERO_PROMPT_MARKER,
  HEROES,
  PRIORITY_RULES,
  appendHeroPrompt,
  buildHeroPromptBlock,
  getHero,
  listHeroes,
  normalizeHeroAssignments,
};
