const path = require('path');
const HUB = path.resolve(__dirname, '..');

const aiKinds = require(path.join(HUB, 'core/ai-kinds.js'));
const scenes  = require(path.join(HUB, 'core/roundtable-scenes.js'));
const free    = require(path.join(HUB, 'core/roundtable-free.js'));

const out = (label, value) => console.log('=== ' + label + ' ===\n' + value + '\n');

out('1. getSlotPromptName(0/charmander/2)',
  [aiKinds.getSlotPromptName(0), aiKinds.getSlotPromptName('charmander'), aiKinds.getSlotPromptName(2)].join(' | '));

out('2. BASE_RULES "圆桌最多" 行',
  scenes.BASE_RULES.split('\n').find(l => l.includes('圆桌最多')));

out('3. research preset "UI 槽位" 行',
  scenes.buildSystemPrompt('research', null, 'pikachu').split('\n').find(l => l.includes('UI 槽位')));

const fan = free.buildFreeFanoutPrompt({
  meeting: { scene: 'general', subSessions: ['a','b','c'], participants: [0,1,2] },
  selfSlot: 0, participants: [0,1,2], userInput: '测试问题',
  lastTurnInjection: null, turnNum: 1, sceneName: '通用圆桌',
});
out('4. free.fanout 调度上下文 (selfSlot=0)',
  fan.split('\n').filter(l => l.startsWith('- 你是:') || l.startsWith('- 参与者:') || l.startsWith('- 模式:')).join('\n'));

const sum = free.buildFreeSummaryPrompt({
  meeting: { scene: 'general', subSessions: ['a','b','c'], participants: [0,1,2] },
  summarizerSlot: 'pikachu',
  userInput: '', lastTurnInjection: null, turnNum: 5, sceneName: '通用圆桌',
});
out('5. summary prompt 第一行 (summarizerSlot=pikachu)',
  sum.split('\n')[0]);

out('6. research SLOT_BIASES headers (三派)',
  ['pikachu','charmander','squirtle'].map(slot =>
    scenes.buildSystemPrompt('research', null, slot).split('\n').find(l => l.startsWith('## [') && l.includes('偏置]'))
  ).join('\n'));

// @id 兼容性
const re = new RegExp('@(' + aiKinds.slotIdRegexAlternation() + ')\b', 'i');
out('7. @<id> 正则兼容', JSON.stringify({
  regex: aiKinds.slotIdRegexAlternation(),
  '@pikachu':  re.test('@pikachu 看看'),
  '@charmander': re.test('@charmander 评一下'),
  '@squirtle': re.test('@squirtle 你呢'),
}, null, 2));
