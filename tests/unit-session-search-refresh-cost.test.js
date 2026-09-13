'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SessionSearchEngine } = require('../core/session-search-engine');
const { SqliteSessionSearchIndex } = require('../core/session-search-sqlite-index');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-search-refresh-cost-'));
  const options = { databasePath:path.join(root,'search.sqlite'), claudeRoots:[], codexRoots:[], kimiRoots:[], geminiRoots:[], meetingDir:path.join(root,'meetings') };
  const engines = [];
  t.after(async () => {
    for (const engine of engines) await engine.close();
    fs.rmSync(root, { recursive:true, force:true });
  });
  return { root, options, engine() { const engine = new SessionSearchEngine(options); engines.push(engine); return engine; } };
}
const snapshot = () => ({sessions:[{hubId:'title-one',kind:'claude',title:'TITLE_ONLY_MARKER',lastOutputPreview:'PREVIEW_BEFORE_MARKER',lastMessageTime:1700000000000}],meetings:[]});
const rows = engine => engine.index.db.prepare('SELECT id,session_key,event_id,text,timestamp FROM docs ORDER BY id').all();
const refresh = (engine,state) => engine.refresh(state,{immediate:true});

test('opening a legacy index adds the cascade lookup index without rebuilding searchable history', t => {
  const f = fixture(t);
  let index = new SqliteSessionSearchIndex(f.options.databasePath);
  index.replaceSource({key:'legacy',signature:'sig',searchable:true,session:{key:'legacy',provider:'claude',title:'LEGACY_MARKER'},docs:[{id:'answer',scope:'assistant',text:'LEGACY_ANSWER_MARKER'}]});
  const before = index.db.prepare('SELECT id,text FROM docs ORDER BY id').all();
  index.db.exec('DROP INDEX IF EXISTS idx_docs_source');
  index.close();
  index = new SqliteSessionSearchIndex(f.options.databasePath);
  try {
    const plan = index.db.prepare('EXPLAIN QUERY PLAN DELETE FROM sources WHERE key=?').all('legacy').map(row=>row.detail).join('\n');
    assert.match(plan,/SEARCH docs USING COVERING INDEX idx_docs_source/);
    assert.doesNotMatch(plan,/SCAN docs/);
    assert.deepEqual(index.db.prepare('SELECT id,text FROM docs ORDER BY id').all(),before);
    assert.equal(index.search({query:'LEGACY_ANSWER_MARKER'}).totalSessions,1);
    assert.equal(index.db.prepare('PRAGMA user_version').get().user_version,1);
  } finally { index.close(); }
});

test('two Hub index readers retain unchanged title rows and content revision across repeated refreshes', async t => {
  const f=fixture(t), a=f.engine(), state=snapshot();
  await refresh(a,state);
  const original=rows(a), revision=a.index.getMeta('contentUpdatedAt');
  const b=f.engine();
  for (const engine of [b,a,b,a]) {
    await refresh(engine,state);
    assert.deepEqual(rows(engine),original,'unchanged fallback rows must not be deleted or reinserted');
    assert.equal(engine.index.getMeta('contentUpdatedAt'),revision);
    assert.equal((await engine.search({query:'TITLE_ONLY_MARKER'})).totalSessions,1);
  }
});

test('title fallback fingerprints include preview text and the effective displayed timestamp', async t => {
  const f=fixture(t), engine=f.engine(), state=snapshot();
  await refresh(engine,state);
  state.sessions[0].lastOutputPreview='PREVIEW_AFTER_MARKER';
  await refresh(engine,state);
  assert.equal((await engine.search({query:'PREVIEW_BEFORE_MARKER'})).totalSessions,0);
  assert.equal((await engine.search({query:'PREVIEW_AFTER_MARKER'})).totalSessions,1);
  state.sessions[0].title='RENAMED_TITLE_MARKER';
  state.sessions[0].lastMessageTime=1700000001000;
  await refresh(engine,state);
  assert.equal((await engine.search({query:'RENAMED_TITLE_MARKER'})).totalSessions,1);
  assert.equal(engine.index.db.prepare('SELECT updated_at FROM sessions').get().updated_at,1700000001000);
  const stable=rows(engine);
  await refresh(engine,state);
  assert.deepEqual(rows(engine),stable);
});

test('a title fallback promotes to transcript and returns on removal without duplicating or flickering', async t => {
  const f=fixture(t), engine=f.engine(), state=snapshot();
  const claudeRoot=path.join(f.root,'claude'), directory=path.join(claudeRoot,'project');
  fs.mkdirSync(directory,{recursive:true});
  engine.options.claudeRoots=[claudeRoot];
  const file=path.join(directory,'native-one.jsonl');
  Object.assign(state.sessions[0],{ccSessionId:'native-one',transcriptPath:file});
  await refresh(engine,state);
  fs.writeFileSync(file,JSON.stringify({type:'user',uuid:'u1',message:{content:'TRANSCRIPT_CONTENT_MARKER'}})+'\n');
  await refresh(engine,state);
  assert.equal((await engine.search({query:'TRANSCRIPT_CONTENT_MARKER'})).totalSessions,1);
  assert.equal(engine.index.getStats().sessions,1);
  assert.equal(engine.index.getSourceStates().has('hub:title-one'),false);
  fs.unlinkSync(file);
  for(let i=0;i<3;i++) {
    await refresh(engine,state);
    assert.equal((await engine.search({query:'TITLE_ONLY_MARKER'})).totalSessions,1);
    assert.equal(engine.index.getStats().sessions,1);
  }
  await refresh(engine,{sessions:[],meetings:[]});
  assert.equal(engine.index.getStats().sessions,0);
});

test('meeting metadata sharing a transcript source key remains stable and retains an offline transcript', async t => {
  const f=fixture(t), engine=f.engine();
  fs.mkdirSync(f.options.meetingDir);
  const state={sessions:[],meetings:[{id:'m1',title:'MEETING_TITLE_MARKER',lastMessageTime:1700000000000}]};
  await refresh(engine,state);
  const original=rows(engine);
  await refresh(engine,state);
  assert.deepEqual(rows(engine),original);
  const file=path.join(f.options.meetingDir,'m1.json');
  fs.writeFileSync(file,JSON.stringify({id:'m1',_timeline:[{sid:'user',idx:0,ts:1700000000001,text:'MEETING_TRANSCRIPT_MARKER'}]}));
  await refresh(engine,state);
  assert.equal((await engine.search({query:'MEETING_TRANSCRIPT_MARKER'})).totalSessions,1);
  const offline=path.join(f.root,'offline');
  assert.ok([f.options.meetingDir,offline].every(p=>path.resolve(p).startsWith(fs.realpathSync(f.root)+path.sep)));
  fs.renameSync(f.options.meetingDir,offline);
  for(let i=0;i<2;i++) {
    const result=await refresh(engine,state);
    assert.equal(result.phase,'ready_with_errors');
    assert.equal((await engine.search({query:'MEETING_TRANSCRIPT_MARKER'})).totalSessions,1);
  }
});

test('legacy fallback signatures still update while an unrelated transcript root is offline', async t => {
  const f=fixture(t), engine=f.engine(), state=snapshot();
  const claudeRoot=path.join(f.root,'claude'), directory=path.join(claudeRoot,'project');
  fs.mkdirSync(directory,{recursive:true});
  engine.options.claudeRoots=[claudeRoot];
  fs.writeFileSync(path.join(directory,'retained.jsonl'),JSON.stringify({type:'user',uuid:'u1',message:{content:'RETAINED_OFFLINE_MARKER'}})+'\n');
  await refresh(engine,state);
  engine.index.db.prepare('UPDATE sources SET signature=? WHERE key=?').run('meta:old-signature','hub:title-one');
  const offline=path.join(f.root,'offline');
  assert.ok([claudeRoot,offline].every(p=>path.resolve(p).startsWith(fs.realpathSync(f.root)+path.sep)));
  fs.renameSync(claudeRoot,offline);
  state.sessions[0].lastOutputPreview='OFFLINE_NEW_PREVIEW_MARKER';
  await refresh(engine,state);
  assert.equal((await engine.search({query:'OFFLINE_NEW_PREVIEW_MARKER'})).totalSessions,1);
  assert.equal((await engine.search({query:'RETAINED_OFFLINE_MARKER'})).totalSessions,1);
  const unchanged=rows(engine);
  await refresh(engine,state);
  assert.deepEqual(rows(engine),unchanged);
});
