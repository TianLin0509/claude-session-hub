'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createCardHistoryViews,loadingMarkup}=require('../renderer/card-history-views');
// Small DOM ownership model; real browser coverage verifies rendering/state.
function harness(options={}) {
  let turns=new Map();
  const el={children:[],replaceChildren(...nodes){this.children=[];for(const n of nodes)this.children.push(...(n.children || [n]));}};
  const document={getElementById:()=>el,createDocumentFragment:()=>({children:[],append(...nodes){this.children.push(...nodes);el.children=el.children.filter(n=>!nodes.includes(n));}})};
  const views=createCardHistoryViews({document,getTurns:()=>turns,setTurns:value=>{turns=value;},clearSignatures(){},...options});
  const fill=(s,label='answer')=>{el.children=[{label,matches:()=>false,querySelectorAll:()=>[]}];turns.set(label,{text:label});views.markHydrated(s);return el.children[0];};
  return {views,el,fill,turns:()=>turns};
}
test('restores exact nodes and turn ownership, rejects a changed provider identity',()=>{
  const h=harness(),a={id:'a',codexSid:'first'},b={id:'b'};
  h.views.activate(a);const node=h.fill(a);node.open=true;
  h.views.activate(b);h.fill(b,'other');
  assert.equal(h.views.activate(a).hydrated,true);assert.equal(h.el.children[0],node);assert.equal(node.open,true);
  assert.deepEqual([...h.turns().keys()],['answer']);
  assert.equal(h.views.activate({...a,codexSid:'replacement'}).hydrated,false);assert.equal(h.el.children.length,0);
});
test('partial hydration is never cached and closed sessions are discarded',()=>{
  const h=harness(),a={id:'a'},b={id:'b'};
  h.views.activate(a);h.el.children=[{label:'partial'}];h.views.activate(b);h.fill(b);
  assert.equal(h.views.activate(a).hydrated,false);
  h.fill(a);h.views.activate(b);h.views.drop('a');assert.equal(h.views.activate(a).hydrated,false);
});
test('cache has entry, source-size, node and age bounds',()=>{
  let time=0;const h=harness({maxEntries:1,now:()=>time});
  for(const id of ['a','b','c']){const s={id};h.views.activate(s);h.fill(s);}
  assert.equal(h.views.stats().cached,1);assert.equal(h.views.activate({id:'a'}).hydrated,false);
  h.fill({id:'a'});h.views.activate({id:'b'});time=300001;
  assert.equal(h.views.activate({id:'a'}).hydrated,false);
  const large=harness({maxBytes:5});large.views.activate({id:'x'});large.fill({id:'x'});large.views.activate({id:'y'});
  assert.equal(large.views.stats().cached,0);
  const crowded=harness({maxNodes:0});crowded.views.activate({id:'x'});crowded.fill({id:'x'});crowded.views.activate({id:'y'});
  assert.equal(crowded.views.stats().cached,0);
});
test('loading uses an accessible structural placeholder without a fabricated percentage',()=>{
  assert.match(loadingMarkup(),/role="status"/);assert.match(loadingMarkup(),/aria-hidden="true"/);
  assert.doesNotMatch(loadingMarkup(),/%|正在加载历史卡片/);
});
