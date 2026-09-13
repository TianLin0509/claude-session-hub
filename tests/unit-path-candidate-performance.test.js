'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {spawnSync}=require('node:child_process');
// Run outside the test process: a quadratic regexp must fail within a bounded
// time instead of freezing the whole test runner like it freezes Renderer.
test('long ordinary prose is scanned without retrying a path at every character',()=>{
  const root=path.resolve(__dirname,'..');
  const script=`const {performance}=require('node:perf_hooks');
    const guard=require('./renderer/markdown-local-path-guard').guardMarkdownLocalPaths;
    const collect=require('./renderer/path-candidates').collectPathCandidates;
    const paths=require('./renderer/path-link');
    const assert=require('node:assert/strict');
    const samples=['旧'.repeat(200000),'x'.repeat(200000),'旧.'.repeat(100000),'x/'.repeat(100000),'文本'.repeat(100000)+' docs/a.md'];
    const start=performance.now();
    for(const source of samples){const g=guard(source);assert.equal(g.entries.length,source.endsWith('docs/a.md')?1:0);collect(source,process.cwd());paths.extractPathLinks(source+String.fromCharCode(10)+source);}
    console.log(JSON.stringify({elapsedMs:performance.now()-start}));`;
  const result=spawnSync(process.execPath,['-e',script],{cwd:root,encoding:'utf8',windowsHide:true,timeout:3000});
  assert.ifError(result.error);
  assert.equal(result.status,0,result.stderr);
});
