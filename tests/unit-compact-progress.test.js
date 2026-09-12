'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {sameResponse,renderMessageSequence}=require('../renderer/conversation-message-view');
const {displayTurns}=require('../core/conversation-display');
test('identity grouping requires a known logical turn and the same agent/session; user steering breaks the group',()=>{
  const a={role:'assistant',logicalTurnId:'turn',sessionId:'s',agent:'codex'};
  assert(sameResponse(a,{...a}));
  for(const change of [{role:'user'},{logicalTurnId:'other'},{logicalTurnId:''},{sessionId:'other'},{agent:'claude'},{inherited:'1'}]){
    assert.equal(sameResponse(a,{...a,...change}),false);
    assert.equal(sameResponse({...a,...change},a),false);
  }
  assert.equal(sameResponse(null,a),false);
  // Steering preserves logical ownership but inserts a user boundary in order.
  const cards=displayTurns([{id:'turn',role:'assistant',displayTurnKey:'k',displayMessages:[
    {id:'p1',text:'first',phase:'commentary',itemOrder:1},{id:'p2',text:'second',phase:'commentary',itemOrder:3}]},
    {id:'u',role:'user',text:'steering',displayTurnKey:'k',itemOrder:2}]);
  assert.deepEqual(cards.map(c=>c.id),['p1','u','p2']);
  assert(!sameResponse(cards[1],cards[2]));
});
test('group progress grid preserves every source item, paragraphs and distinct final/activity records',()=>{
  const messages=[{id:'one',phase:'commentary',text:'first\n\nsecond',ts:'2026-09-12T01:02:03Z'},
    {id:'two',phase:'commentary',text:'first\n\nsecond'},
    {id:'final',phase:'final_answer',text:'answer'},
    {id:'tool',phase:'activity',toolCalls:[{name:'test',input:'run',output:'PASS'}]}];
  const html=renderMessageSequence(messages,{escapeHtml:s=>String(s),renderMarkdown:s=>'<p>'+s+'</p>'});
  assert.equal((html.match(/<section /g)||[]).length,4);
  assert.equal((html.match(/class="conversation-entry conversation-progress-row"/g)||[]).length,2);
  assert.equal((html.match(/first\n\nsecond/g)||[]).length,2);
  assert(html.includes('09:02</time>'));assert(html.includes('data-phase="final_answer"'));
  assert(html.includes('conversation-activity'));assert(html.includes('PASS'));
});
