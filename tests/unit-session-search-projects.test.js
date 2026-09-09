'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projectPathKey, projectForCwd, projectFilterFor, matchesProjectFilter, normalizeProjectFilter, readProjectSearchRoots } = require('../core/session-search-projects');
const { listPreparedProjects } = require('../core/prepared-project-library');
const { filterSearchEntries } = require('../renderer/global-session-search');
const { normalizeRequest } = require('../core/session-search-query');
const { SqliteSessionSearchIndex } = require('../core/session-search-sqlite-index');

const projects = [
  {name:'同名项目',path:'C:\\Repos\\App',searchRoots:['C:\\Tasks\\app-branch']},
  {name:'子项目',path:'C:\\Repos\\App\\nested'},
  {name:'同名项目',path:'D:\\Repos\\App'},
];

test('project identity handles boundaries, nested projects, same names and worktrees', () => {
  const filter = projectFilterFor(projects, 'c:/repos/app/');
  for (const cwd of ['C:/Repos/App', 'c:\\repos\\APP\\src', 'C:/Tasks/app-branch/lib']) {
    assert.equal(matchesProjectFilter(cwd, filter), true, cwd);
    assert.equal(projectForCwd(projects, cwd), projects[0]);
  }
  for (const cwd of ['', 'C:/Repos/App2', 'C:/Repos/App/nested/src', 'D:/Repos/App', 'C:/AIWork/random']) {
    assert.equal(matchesProjectFilter(cwd, filter), false, cwd);
  }
  assert.equal(projectForCwd(projects, 'C:/Repos/App/nested/src'), projects[1]);
  assert.equal(projectPathKey('\\\\server\\share\\app\\'), '//server/share/app');
  assert.equal(matchesProjectFilter('C:/App',normalizeProjectFilter({roots:['C:/']})),true);
  assert.equal(matchesProjectFilter('\\\\?\\C:\\Repos\\App\\src',filter),true);
  assert.equal(projectPathKey('\\\\?\\UNC\\server\\share\\app'),'//server/share/app');
  assert.equal(matchesProjectFilter('C:/Repos/App', projectFilterFor(projects,'C:/missing')), false);
  assert.equal(matchesProjectFilter('C:/Repos/App', normalizeProjectFilter({roots:[]})), false);
  assert.throws(()=>normalizeProjectFilter({roots:['relative']}), /项目目录/);
});

test('worktree metadata enriches the existing library without adding worktrees or random directories', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'search-projects-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const root=path.join(dir,'repo'), wt=path.join(dir,'wt'), deleted=path.join(dir,'deleted');
  fs.mkdirSync(path.join(root,'.agents'),{recursive:true});
  fs.writeFileSync(path.join(root,'.agents','project.json'),JSON.stringify({name:'正式项目'}));
  for (const [name, target] of [['live',wt],['deleted',deleted]]) {
    const admin=path.join(root,'.git','worktrees',name);
    fs.mkdirSync(admin,{recursive:true});
    fs.writeFileSync(path.join(admin,'gitdir'),path.join(target,'.git')+'\n');
    fs.writeFileSync(path.join(admin,'commondir'),'../..\n');
    if(name==='live') {
      fs.mkdirSync(target,{recursive:true});
      fs.writeFileSync(path.join(target,'.git'),'gitdir: '+admin+'\n');
    }
  }
  const plain=path.join(dir,'random');fs.mkdirSync(plain);
  const candidates=[{path:root},{path:wt},{path:plain}];
  const ordinary=listPreparedProjects(candidates), enriched=listPreparedProjects(candidates,{}, {searchRoots:true});
  assert.deepEqual(enriched.map(({searchRoots,searchWarnings,...item})=>item),ordinary);
  assert.deepEqual(new Set(enriched[0].searchRoots),new Set([root,wt,deleted]));
  assert.deepEqual(enriched[0].searchWarnings,[]);
  fs.writeFileSync(path.join(wt,'.git'),'gitdir: C:/other/.git/worktrees/x');
  const changed=readProjectSearchRoots(root);
  assert.equal(changed.roots.includes(wt),false);
  assert.equal(changed.warnings.length,1);
  fs.unlinkSync(path.join(wt,'.git'));
  const reused=readProjectSearchRoots(root);
  assert.equal(reused.roots.includes(wt),false);
  assert.equal(reused.warnings.length,1);
});

test('title and SQLite project filters agree before candidate limits and survive paging', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'search-membership-'));
  const index=new SqliteSessionSearchIndex(path.join(dir,'index.sqlite'),{maxQueryDocs:2});
  t.after(()=>{index.close();fs.rmSync(dir,{recursive:true,force:true});});
  const entries=[
    ...Array.from({length:24},(_,i)=>({key:'noise'+i,cwd:'C:/Repos/App2'})),
    {key:'root',cwd:'C:/Repos/App'},{key:'subdir',cwd:'C:/Repos/App/src'},
    {key:'worktree',cwd:'C:/Tasks/app-branch/src'},
    {key:'nested',cwd:'C:/Repos/App/nested/src'},{key:'same-name',cwd:'D:/Repos/App'},
  ];
  for(const entry of entries) index.replaceSource({key:entry.key,signature:entry.key,session:{...entry,title:'needle',provider:'codex',projectLabel:'同名项目'},
    docs:[{eventId:'answer',ordinal:0,scope:'assistant',role:'assistant',timestamp:Date.now(),text:'needle'}]});
  const projectFilter=projectFilterFor(projects,projects[0].path),request={query:'needle',projectFilter,limit:1,sort:'title'};
  assert.deepEqual(filterSearchEntries(entries,{projectFilter}).map(e=>e.key),['root','subdir','worktree']);
  let response=index.search(request);
  for(let i=0;response.continuationCursor && i<100;i++) response=index.search({...request,cursor:response.continuationCursor});
  assert.equal(response.state,'complete');assert.equal(response.totalSessions,3);
  const ids=response.results.map(r=>r.key),cursor=response.nextPageCursor;
  while(response.nextPageCursor) {response=index.search({...request,cursor:response.nextPageCursor});ids.push(...response.results.map(r=>r.key));}
  assert.deepEqual(new Set(ids),new Set(['root','subdir','worktree']));
  assert.equal(index.search({...request,projectFilter:{roots:[]},cursor}).state,'error');
  assert.equal(index.search({query:'',projectFilter:{roots:[]}}).totalSessions,0);
});

test('24h and 3d use rolling message time with exact inclusive boundaries', t => {
  const now=Date.parse('2026-09-09T15:00:00Z'),hour=3600000;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'search-short-time-'));
  const index=new SqliteSessionSearchIndex(path.join(dir,'index.sqlite'));
  t.after(()=>{index.close();fs.rmSync(dir,{recursive:true,force:true});});
  const times={inside:now-hour,day:now-24*hour,dayBefore:now-24*hour-1,threeDays:now-72*hour,tooOld:now-72*hour-1,future:now+1,unknown:0};
  for(const [key,timestamp] of Object.entries(times)) index.replaceSource({key,signature:key,
    session:{key,title:'archive',provider:'claude',updatedAt:now},docs:[{eventId:'answer',ordinal:0,scope:'assistant',role:'assistant',timestamp,text:'needle'}]});
  for(const [range,hours,expected] of [['24h',24,['inside','day']],['3d',72,['inside','day','dayBefore','threeDays']]]) {
    const normalized=normalizeRequest({query:'needle',timeRange:range},now);
    assert.equal(normalized.time.from,now-hours*hour);assert.equal(normalized.time.to,now);
    const result=index.search({query:'needle',timeRange:range,time:normalized.time});
    assert.equal(result.state,'complete');assert.deepEqual(new Set(result.results.map(r=>r.key)),new Set(expected));
    const entries=Object.entries(times).map(([key,updatedAt])=>({key,updatedAt}));
    assert.deepEqual(new Set(filterSearchEntries(entries,{timeRange:range,now}).map(r=>r.key)),new Set(expected));
  }
});
