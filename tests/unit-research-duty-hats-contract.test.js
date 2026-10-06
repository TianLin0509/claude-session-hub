'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const orchestrator = require(path.join(root, 'core', 'group-chat-orchestrator.js'));
const { buildSystemPromptText, RESEARCH_SCENE_PROMPT } = orchestrator._private;

assert.ok(RESEARCH_SCENE_PROMPT.includes('关键事实怎样改变判断'), 'research prompt requires evidence-based conclusions');
assert.ok(RESEARCH_SCENE_PROMPT.includes('无可靠量化时明确证据与限制'), 'uncertainty must not force invented numbers');

const sysResearch = buildSystemPromptText('test researcher', 'research');
assert.ok(sysResearch.includes('关键事实怎样改变判断'), 'research system prompt retains evidence requirement');

const sysGeneral = buildSystemPromptText('test', 'general');
assert.ok(!sysGeneral.includes('关键事实怎样改变判断'), 'research instructions stay in the research scene');

const mrSrc = fs.readFileSync(path.join(root, 'renderer', 'meeting-room.js'), 'utf8');
const startIdx = mrSrc.indexOf('research: [');
assert.ok(startIdx > 0, 'research duty hats definition not found');
const endIdx = mrSrc.indexOf('\n    ],', startIdx);
assert.ok(endIdx > startIdx, 'research duty hats definition end not found');
const researchBlock = mrSrc.slice(startIdx, endIdx);

for (const id of ['data', 'technical', 'catalyst', 'bear', 'bull', 'judge']) {
  assert.ok(researchBlock.includes(`id: '${id}'`), `research duty hat missing: ${id}`);
}

for (const tool of ['stock_static(symbol)', 'stock_news(symbol)', 'stock_market(symbol)']) {
  assert.ok(researchBlock.includes(tool), `research duty hats missing tool call: ${tool}`);
}

const dutyById = {};
const re = /id:\s*'([^']+)'[\s\S]*?duty:\s*'([^']*)'/g;
let m;
while ((m = re.exec(researchBlock)) !== null) dutyById[m[1]] = m[2];

assert.ok(dutyById.data && dutyById.data.includes('stock_static'), 'data duty must bind stock_static');
assert.ok(dutyById.technical && dutyById.technical.includes('stock_market'), 'technical duty must bind stock_market');
assert.ok(dutyById.technical && dutyById.technical.includes('kline_similarity'), 'technical duty must bind kline_similarity');
assert.ok(dutyById.catalyst && dutyById.catalyst.includes('stock_news'), 'catalyst duty must bind stock_news');
assert.ok(dutyById.catalyst && dutyById.catalyst.includes('stock_sentiment'), 'catalyst duty must bind stock_sentiment');
assert.ok(dutyById.bear && dutyById.bear.includes('stock_static'), 'bear duty must bind stock_static');
assert.ok(dutyById.bull && dutyById.bull.includes('stock_static'), 'bull duty must bind stock_static');

console.log('research duty-hats contract ok');
