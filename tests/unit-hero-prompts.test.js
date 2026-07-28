'use strict';

const assert = require('assert');
const {
  HERO_PROMPT_MARKER,
  appendHeroPrompt,
  buildHeroPromptBlock,
  getHero,
  listHeroes,
  normalizeHeroAssignments,
} = require('../core/hero-prompts.js');

const heroes = listHeroes();
assert.deepStrictEqual(heroes.map(hero => hero.id), [
  'buffett.mature.v1',
  'livermore.trend.v1',
]);

for (const hero of heroes) {
  const block = buildHeroPromptBlock(hero.id);
  assert.ok(block.startsWith(HERO_PROMPT_MARKER), `${hero.id} must start with the priority marker`);
  assert.ok(block.includes('仅本轮有效'), `${hero.id} must be one-shot`);
  assert.ok(block.includes('本轮问题附带的价值投资或右侧交易等方法倾向'), `${hero.id} must override the user's competing analysis preference`);
  assert.ok(block.includes('不得为迎合镜头编造证据'), `${hero.id} must preserve evidence truth`);
  assert.ok(block.length >= 300 && block.length <= 2400, `${hero.id} should stay inside the lightweight prompt budget`);
}

assert.ok(getHero('buffett.mature.v1').prompt.includes('安全边际'));
assert.ok(getHero('livermore.trend.v1').prompt.includes('关键点'));
assert.strictEqual(getHero('unknown.hero'), null);

const basePrompt = '## 用户\n比较两家公司。\n\n请发言。';
const injected = appendHeroPrompt(basePrompt, 'buffett.mature.v1');
assert.ok(injected.startsWith(basePrompt), 'hero injection must preserve the exact groupchat base prompt');
assert.ok(injected.indexOf(HERO_PROMPT_MARKER) > injected.indexOf('请发言。'), 'hero block must be appended last for business-preference precedence');
assert.strictEqual(appendHeroPrompt(basePrompt, 'unknown.hero'), basePrompt, 'unknown hero ids must be ignored');

assert.deepStrictEqual(normalizeHeroAssignments({
  s1: 'buffett.mature.v1',
  s2: 'livermore.trend.v1',
  s3: 'arbitrary.raw.prompt',
  outsider: 'buffett.mature.v1',
}, ['s1', 's2', 's3']), {
  s1: 'buffett.mature.v1',
  s2: 'livermore.trend.v1',
}, 'only built-in hero ids for current meeting members may cross the main-process boundary');

console.log('hero prompts unit: ok');
