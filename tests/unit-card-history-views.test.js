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

test('first transcript binding preserves the sent card and hydrated view',()=>{
  for (const kind of ['claude','codex','deepseek','gemini','kimi']) {
    const h=harness(),fresh={id:kind,kind,runtimeBackend:'pty'};
    h.views.activate(fresh);
    const card=h.fill(fresh,'first prompt');
    // Native IDs and paths arrive separately, after the local card is visible.
    const binding=kind==='claude'?{ccSessionId:'native-id'}
      :kind==='codex'||kind==='deepseek'?{codexSid:'native-id'}:{};
    const bound={...fresh,...binding};
    assert.equal(h.views.ready(bound),true,kind+' remains ready during first binding');
    assert.deepEqual(h.views.activate(bound),{changed:false,hydrated:true});
    const withPath={...bound,transcriptPath:'first.jsonl'};
    assert.deepEqual(h.views.activate(withPath),{changed:false,hydrated:true});
    assert.equal(h.el.children[0],card);
    assert.deepEqual([...h.turns().keys()],['first prompt']);
  }
});

test('late first binding also restores a detached view without losing its pending card',()=>{
  const h=harness(),fresh={id:'a',kind:'codex'},other={id:'b',kind:'claude'};
  h.views.activate(fresh);const card=h.fill(fresh,'pending');
  h.views.activate(other);h.fill(other);
  assert.equal(h.views.activate({...fresh,codexSid:'native',transcriptPath:'rollout.jsonl'}).hydrated,true);
  assert.equal(h.el.children[0],card);
});

test('first binding does not mark an unfinished history load as hydrated',()=>{
  const h=harness(),fresh={id:'a',kind:'codex'};
  h.views.activate(fresh);
  assert.deepEqual(h.views.activate({...fresh,codexSid:'native'}),{changed:false,hydrated:false});
});

test('replacing or clearing a known transcript, provider or backend still invalidates the view',()=>{
  const base={id:'a',kind:'codex',runtimeBackend:'pty',codexSid:'native',transcriptPath:'first.jsonl'};
  for(const change of [{codexSid:'different'},{codexSid:null},{transcriptPath:'different.jsonl'},
    {transcriptPath:null},{kind:'claude'},{runtimeBackend:'codex-app-server'}]) {
    const h=harness();h.views.activate(base);h.fill(base);
    assert.equal(h.views.ready({...base,...change}),false);
    assert.equal(h.views.activate({...base,...change}).hydrated,false);
    assert.equal(h.el.children.length,0);
  }
});
test('the extended and plain spellings of one transcript keep the same cards',()=>{
  const path=['C:','s','rollout-T.jsonl'].join('\\');
  const h=harness(),plain={id:'a',codexSid:'T',transcriptPath:path};
  h.views.activate(plain);const node=h.fill(plain);
  assert.equal(h.views.activate({...plain,transcriptPath:'\\\\?\\'+path}).hydrated,true);assert.equal(h.el.children[0],node);
  assert.equal(h.views.activate({...plain,transcriptPath:path.replace('T.jsonl','OTHER.jsonl')}).hydrated,false);
});
