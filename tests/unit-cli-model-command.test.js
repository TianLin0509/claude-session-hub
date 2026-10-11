'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {modelCommandAcknowledged,parseClaudeModelSwitchConfirmation}=require('../core/cli-model-command');
// Captured from real Claude Code during the assistant model-switch test.
const actual='Switch model?\nYour next response will be slower and use more tokens\nThis conversation is cached for the current model.\n❯ 1. Yes, switch to Sonnet 4.5\n  2. No, go back\n';
test('native Claude confirmation acknowledges only the command, with a matching target for selection',()=>{
  assert.equal(modelCommandAcknowledged('claude-inline',actual,''),true);
  assert.deepEqual(parseClaudeModelSwitchConfirmation(actual,'claude-sonnet-4-5'),{target:'Sonnet 4.5',number:1,cursor:1});
  assert.equal(parseClaudeModelSwitchConfirmation(actual,'claude-sonnet-5'),null);
  assert.equal(parseClaudeModelSwitchConfirmation(actual,'claude-haiku-4-5'),null);
  assert.equal(parseClaudeModelSwitchConfirmation(actual.replace('❯ 1.','  1.')),null);
  assert.equal(parseClaudeModelSwitchConfirmation(actual.replace('Switch model?','Delete files?')),null);
  assert.equal(modelCommandAcknowledged('codex-picker',actual,''),false);
  assert.equal(modelCommandAcknowledged('claude-inline','',actual.replace(/\n/g,' ')),true,'ConPTY cursor positioning can replace row line feeds');
  assert.equal(parseClaudeModelSwitchConfirmation(actual,'claude-sonnet-4'),null);
});
test('confirmation navigation follows the native highlight instead of a fixed Enter',()=>{
  const moved=actual.replace('❯ 1.','  1.').replace('  2.','❯ 2.');
  assert.equal(parseClaudeModelSwitchConfirmation(moved,'sonnet').cursor,2);
});
test('Antigravity /model <id> is an in-place switch confirmed only by fresh agy output',()=>{
  const {modelCommandType}=require('../core/cli-model-command');
  assert.equal(modelCommandType('gemini','/model gemini-3.8-flash-medium'),'agy-inline');
  assert.equal(modelCommandType('gemini-resume',' /model claude-sonnet-4-6 '),'agy-inline');
  assert.equal(modelCommandType('gemini','/model'),null,'the bare picker is not driven from Hub');
  // Real agy 1.3.3 output after Enter.
  assert.equal(modelCommandAcknowledged('agy-inline','',"> /model\n  ⎿  Model set to Gemini 3.8 Flash (Medium)"),true);
  assert.equal(modelCommandAcknowledged('agy-inline','  ⎿  Model set to Gemini 3.8 Flash (Low)',''),false,'an earlier switch on screen is not a receipt');
  assert.equal(require('../core/model-options').modelSwitchStrategy('gemini'),'agy-inline');
});
