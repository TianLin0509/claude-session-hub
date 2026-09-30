'use strict';

// Community edition: the per-turn analysis lens feature ships without built-in
// lenses. The API is unchanged so group chat code paths keep working; with an
// empty catalogue no lens selector is offered and no prompt block is added.

const HERO_PROMPT_MARKER = '## 本轮分析镜头';
const PRIORITY_RULES = '';
const HEROES = Object.freeze({});

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
