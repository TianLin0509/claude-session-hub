'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SqliteSessionSearchIndex } = require('../core/session-search-sqlite-index');
const now = Date.now(), day = 86400000;
function source(key, title, docs, provider = 'codex') {
  return { key, signature: key, searchable: true,
    session: { key, title, provider, updatedAt: now, hubSessionId: key, projectLabel: provider },
    docs: docs.map((d, i) => ({ id: `${key}-${i}`, eventId: `${key}-${i}`, ordinal: i,
      scope: 'assistant', role: 'assistant', timestamp: now - day, ...d })) };
}
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-yesterday-a-'));
  const index = new SqliteSessionSearchIndex(path.join(dir, 'index.sqlite'));
  t.after(() => { index.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return index;
}
function complete(index, request) {
  let response = index.search(request), count = 0;
  while (response.continuationCursor) {
    assert.ok(++count < 100, 'bounded fixture must finish');
    response = index.search({ ...request, cursor: response.continuationCursor });
  }
  assert.equal(response.state, 'complete');
  return response;
}
test('filters cover recent/provider/project hits beyond the former 6000-row window', t => {
  const index = setup(t);
  index.replaceSource(source('old', 'archive', Array.from({length:6002}, () => ({text:'HUB_MARKER', timestamp:now-40*day})), 'claude'));
  index.replaceSource(source('new', 'current', [{text:'HUB_MARKER latest'}]));
  for (const filter of [{timeRange:'7d'}, {providers:['codex']}, {project:'codex'}]) {
    const response = index.search({query:'HUB_MARKER', ...filter});
    assert.deepEqual(response.results.map(r=>r.sessionKey), ['new']);
    assert.equal(response.state, 'complete');
  }
});
test('relevance uses a unified title/phrase/episode order and deduplicated query terms', t => {
  const index = setup(t);
  index.replaceSource(source('exact', 'alpha beta', [{text:'old answer',timestamp:now-90*day}]));
  index.replaceSource(source('phrase', 'notes', [{text:'the alpha beta answer'}]));
  index.replaceSource(source('same', 'notes', [{text:'beta then alpha'}]));
  index.replaceSource(source('pair', 'notes', [{scope:'user',role:'user',text:'alpha'}, {text:'beta'}]));
  index.replaceSource(source('scattered', 'notes', [{scope:'user',role:'user',text:'alpha'}, {text:'no'}, {scope:'user',role:'user',text:'another'}, {text:'beta'}]));
  const r = complete(index,{query:'alpha beta'});
  assert.deepEqual(r.results.map(x=>x.sessionKey),['exact','phrase','same','pair','scattered']);
  assert.deepEqual(r.results.map(x=>x.rank.tier),[0,1,2,3,4]);
  assert.equal(complete(index,{query:'alpha alpha'}).totalSessions,5);
});
test('message time, conversation time and title-only time are distinct', t => {
  const index = setup(t);
  index.replaceSource(source('active', 'needle', [{text:'needle old',timestamp:now-30*day},{text:'new activity',timestamp:now-1000}]));
  index.replaceSource(source('hit', 'notes', [{text:'needle',timestamp:now-day}]));
  const r = complete(index,{query:'needle',timeRange:'7d',sort:'matchTime'});
  assert.deepEqual(r.results.map(x=>x.sessionKey),['hit','active']);
  assert.equal(r.results[1].newestMatchedEventAt,null);
  assert.equal(r.results[1].titleOnly,true);
  const scope = complete(index,{query:'needle',timeRange:'7d',scopes:['assistant']});
  assert.deepEqual(scope.results.map(x=>x.sessionKey),['hit']);
  assert.equal(complete(index,{query:'needle',sort:'conversationTime'}).results[0].sessionKey,'active');
});
test('scan continuation and result pagination retain a snapshot while the index changes', t => {
  const index = setup(t);
  for(let i=0;i<5;i++) index.replaceSource(source('s'+i,'needle '+i,[{text:'needle '+i}]));
  let r = complete(index,{query:'needle',limit:2,sort:'title'});
  assert.equal(r.total.relation,'exact');
  const ids = r.results.map(x=>x.sessionKey), cursor = r.nextPageCursor;
  index.replaceSource(source('s0','changed',[{text:'removed query'}]));
  r=index.search({query:'needle',limit:2,sort:'title',cursor});
  ids.push(...r.results.map(x=>x.sessionKey));
  r=index.search({query:'needle',limit:2,sort:'title',cursor:r.nextPageCursor});
  ids.push(...r.results.map(x=>x.sessionKey));
  assert.deepEqual(ids,['s0','s1','s2','s3','s4']);
  assert.ok(index.search({query:'different',cursor}).error, 'cursor cannot silently ignore changed filters');
});
test('explicit all-content searches include short tool text, and previews return related Q/A', t => {
  const index=setup(t);
  index.replaceSource(source('qa','索引更新',[
    {scope:'user',role:'user',text:'保存之后还要重建吗？'},
    ...Array.from({length:8},()=>({scope:'tool',role:'tool',text:'后台索引工具日志'})),
    {text:'## 自动更新\n保存后增量处理。'},
  ]));
  assert.equal(complete(index,{query:'工具',scopes:['title','user','assistant','tool']}).totalSessions,1);
  const preview=index.preview({sessionKey:'qa',eventId:'qa-8',query:'工具'});
  assert.ok(preview.context.some(x=>x.role==='user'));
  assert.ok(preview.context.some(x=>x.role==='assistant'));
});

test('winning episode controls both rank and preview anchor', t => {
  const index=setup(t);
  index.replaceSource(source('episode','notes',[
    {scope:'user',role:'user',text:'alpha old question'}, {text:'irrelevant'},
    {scope:'user',role:'user',text:'alpha new question'}, {text:'beta new answer'}]));
  const hit=complete(index,{query:'alpha beta'}).results[0];
  assert.equal(hit.rank.tier,3);
  assert.match(hit.questionExcerpt,/new question/);
  const preview=index.preview({sessionKey:hit.sessionKey,eventId:hit.bestMatch.eventId});
  assert.ok(preview.context.some(d=>d.text==='beta new answer'));
  assert.ok(!preview.context.some(d=>d.text==='alpha old question'));
});

test('synthetic preview timestamps never become recent conversation evidence', t => {
  const index=setup(t);
  index.replaceSource(source('synthetic','needle',[
    {text:'needle old',timestamp:now-30*day},
    {id:'last-output-preview',eventId:'last-output-preview',text:'needle cached',timestamp:now}]));
  assert.equal(complete(index,{query:'needle',timeRange:'7d'}).totalSessions,0);
  const hit=complete(index,{query:'needle'}).results[0];
  assert.equal(hit.lastConversationAt,now-30*day);
  assert.equal(hit.newestMatchedEventAt,now-30*day);
});

test('exact ID lookup respects content and time scopes', t => {
  const index=setup(t);
  index.replaceSource(source('hub-exact-001','A useful title',[{text:'unrelated'}]));
  const hit=complete(index,{query:'hub-exact-001'}).results[0];
  assert.equal(hit.rank.tier,0);
  assert.match(hit.matchReasons.join(' '),/ID/);
  assert.equal(complete(index,{query:'hub-exact-001',scopes:['assistant']}).totalSessions,0);
  assert.equal(index.search({query:'\u0000\u0007'}).state,'error');
});

test('long original text remains readable across bounded expansion pages', t => {
  const index=setup(t), raw='A'.repeat(140000)+'END_OF_ORIGINAL';
  index.replaceSource(source('long','notes',[{scope:'user',role:'user',text:'question'},{text:raw}]));
  let offset=0,joined='';
  do {
    const p=index.preview({sessionKey:'long',eventId:'long-1',expandEventId:'long-1',textOffset:offset});
    const d=p.context.find(d=>d.eventId==='long-1');joined+=d.text;offset=d.nextTextOffset;
  } while(offset);
  assert.equal(joined,raw);
});

test('writer ownership is shared across index instances and released by its owner only', t => {
  const a=setup(t), b=new SqliteSessionSearchIndex(a.databasePath);t.after(()=>b.close());
  const token=a.acquireWriterLease();assert.ok(token);
  assert.equal(b.acquireWriterLease(),null);
  b.releaseWriterLease('wrong-token');assert.equal(b.acquireWriterLease(),null);
  a.releaseWriterLease(token);const next=b.acquireWriterLease();assert.ok(next);b.releaseWriterLease(next);b.close();
});

test('empty-query time filtering applies to the selected message scope',t=>{
  const index=setup(t);
  index.replaceSource(source('old-answer','notes',[{text:'old',timestamp:now-100*day},{scope:'user',text:'today',timestamp:now}]));
  index.replaceSource(source('new-tool','notes',[{scope:'tool',text:'today',timestamp:now}]));
  assert.equal(complete(index,{query:'',timeRange:'7d',scopes:['assistant']}).totalSessions,0);
  assert.deepEqual(complete(index,{query:'',timeRange:'7d',scopes:['tool']}).results.map(r=>r.key),['new-tool']);
});

test('CJK completion flag selects the auxiliary index and short scans seek by rowid',t=>{
  const index=setup(t);
  index.replaceSource(source('cjk','索引优化',[{text:'索引正文'}]));
  const {QuerySnapshot,normalizeRequest}=require('../core/session-search-query');
  let s=new QuerySnapshot(index,normalizeRequest({query:'索引'}));
  try {assert.match(s.makeStatement().statement.sourceSQL,/NOT INDEXED/);} finally {s.close();}
  while(!index.backfillCjkAux({budgetMs:100}).done) {}
  s=new QuerySnapshot(index,normalizeRequest({query:'索引'}));
  try {
    assert.equal(s.auxReady,true);
    const {statement,args}=s.makeStatement();
    const plan=s.db.prepare('EXPLAIN QUERY PLAN '+statement.sourceSQL).all(...args,32);
    assert.match(plan.find(p=>/SCAN|SEARCH/.test(p.detail)).detail,/docs_cjk VIRTUAL TABLE/);
    assert.match(statement.sourceSQL,/docs_cjk\.rowid>\?/);
  } finally {s.close();}
});

test('preview hit positions keep scope/time filters and report missing anchors',t=>{
  const index=setup(t);
  index.replaceSource(source('positions','notes',[
    {scope:'user',text:'needle old question',timestamp:now-100*day},
    {scope:'tool',text:'needle old log',timestamp:now-100*day},
    {text:'needle new answer',timestamp:now}]));
  const preview=index.preview({sessionKey:'positions',eventId:'positions-2',query:'needle',mode:'hits',
    filters:{scopes:['assistant'],time:{field:'eventTime',from:now-7*day,to:now}}});
  assert.deepEqual(preview.context.map(d=>d.eventId),['positions-2']);
  assert.equal(index.preview({sessionKey:'positions',eventId:'deleted-event'}).state,'stale');
  assert.equal(index.preview({sessionKey:'positions',mode:'conversation',afterEventId:'deleted-page'}).state,'stale');
});
