'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {nativeTranscriptTurns}=require('../core/codex-native-transcript');
const {displayTurns}=require('../core/conversation-display');
const {buildTurnPresentation,normalizeToolActivity}=require('../core/turn-presentation');
const {createTurnCardRenderer}=require('../renderer/turn-card-renderer');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function renderer(){return createTurnCardRenderer({document:{addEventListener(){}},window:{},navigator:{},escapeHtml:esc,
 marked:{parse:s=>'<p>'+esc(s)+'</p>'},DOMPurify:{sanitize:s=>s},formatAbsoluteTime:()=>'',normalizeMarkdownPathBreaks:s=>s});}
function native(exitCode=0,status='completed'){
 return nativeTranscriptTurns('thread',[{id:'turn',status,items:[
  {id:'u',type:'userMessage',content:[{type:'text',text:'任务'}]},
  {id:'p',type:'agentMessage',phase:'commentary',text:'正在检查'},
  {id:'change',type:'fileChange',status:'completed',changes:[{path:'C:\\fixture\\feature.js',kind:{type:'update'}}]},
  {id:'tool',type:'commandExecution',command:'node --test card.test.js',status:'completed',aggregatedOutput:exitCode===0?'2 tests passed':'1 test failed',exitCode,durationMs:1200},
  {id:'final',type:'agentMessage',phase:'final_answer',text:'检查已结束'},
 ]}]);}
test('native tool output, zero/nonzero exit and duration survive ordinary presentation',()=>{
 for(const code of [0,1,-1,-1073741510,null]){
  const t=native(code).find(t=>t.role==='assistant');
  const a=buildTurnPresentation(t).activities.find(a=>a.id==='tool');
  assert.equal(a.result,code===0?'2 tests passed':'1 test failed');
  assert.equal(a.exitCode,code);assert.equal(a.durationMs,1200);
  assert.equal(a.status,code!==null && code!==0?'failed':'completed');
 }
 assert.equal(normalizeToolActivity({name:'mcp',output:{ok:true,count:0}}).result,'{\n  "ok": true,\n  "count": 0\n}');
 assert.equal(normalizeToolActivity({name:'mcp',output:0}).result,'0');
 assert.equal(normalizeToolActivity({name:'mcp',result:'',output:'must not override explicit empty result'}).result,'');
});
test('failed file attempts remain explicit; later success does not erase failure evidence',()=>{
 const turn={source:'codex-app-server',nativeOutcome:'completed',toolCalls:[
  {id:'f1',name:'Delete',status:'failed',input:{path:'C:\\fixture\\a.js'}},
 ]};
 const first=buildTurnPresentation(turn).delivery;
 assert.equal(first.changedFiles[0].status,'failed');
 const html=renderer().renderTurnCard({...turn,role:'assistant',text:'检查完成',presentation:{delivery:first,activities:[]}});
 assert.match(html,/失败 · 变更未确认/);
 assert.match(html,/1 个文件记录/);
 turn.toolCalls.push({id:'f2',name:'fileChange',status:'completed',input:{changes:[{path:'C:\\fixture\\a.js'}]}});
 const retried=buildTurnPresentation(turn).delivery;
 assert.equal(retried.changedFiles.length,1);
 assert.equal(retried.changedFiles[0].status,'completed');
 assert.equal(retried.changedFiles[0].kind,'edit');
 assert.equal(retried.changedFiles[0].failedAttempts,1);
 assert.match(renderer().renderTurnCard({...turn,role:'assistant',text:'重试完成',presentation:{delivery:retried,activities:[]}}),/已修改 · 另有 1 次失败/);
});
test('long result source is complete while DOM is only an explicitly labelled preview',()=>{
 const full='中'.repeat(60001)+'END';
 const a=normalizeToolActivity({id:'large',name:'Bash',result:full,status:'completed'});
 assert.equal(a.result.length,full.length);assert(a.result.endsWith('END'));
 const html=renderer().renderToolCluster('t',[a]);
 assert(html.includes('60004'));assert(html.includes('预览'));
 assert(!html.includes(full));assert(html.includes('tc-open-full-result'));assert(html.includes('tc-copy-result'));
});
test('only one final display message owns whole-turn delivery, progress never becomes completed',()=>{
 const cards=displayTurns(native());
 const results=cards.filter(c=>c.role==='assistant').map(c=>({card:c,p:buildTurnPresentation(c)}));
 assert.equal(results.filter(r=>r.p.delivery.hasContent).length,1);
 const last=results.find(r=>r.card.phase==='final_answer');
 assert.equal(last.p.delivery.complete,true);
 assert.equal(last.p.delivery.checks[0].exitCode,0);assert.equal(last.p.delivery.changedFiles.length,1);
 assert.equal(results.find(r=>r.card.phase==='commentary').card.nativeOutcome,null);
 assert.equal(results.find(r=>r.card.phase==='activity').p.delivery.hasContent,false);
});
test('multiple final items have one delivery owner; failed or interrupted turns never claim delivery success',()=>{
 for(const status of ['failed','interrupted','inProgress']){
  assert(displayTurns(native(1,status)).every(t=>!buildTurnPresentation(t).delivery.complete));
 }
 const base=native().find(t=>t.role==='assistant');
 base.displayMessages.push({id:'another-final',phase:'final_answer',text:'补充结果',itemOrder:20});
 const owners=displayTurns([base]).filter(t=>buildTurnPresentation(t).delivery.hasContent);
 assert.deepEqual(owners.map(t=>t.id),['another-final']);
});
test('activity and restored delivery both default closed, retain existing UI components',()=>{
 const r=renderer(),final=displayTurns(native()).find(t=>t.phase==='final_answer');
 const html=r.renderTurnCard(final);
 assert(html.includes('turn-delivery-summary'));
 assert(!/<details[^>]*class="turn-delivery-summary"[^>]*\sopen(?:\s|>)/.test(html));
 assert(!/<details[^>]*class="[^"]*tc-cluster[^"]*"[^>]*\sopen(?:\s|>)/.test(r.renderToolCluster('t',[{name:'Bash',result:'ok'}])));
});
test('message-specific actions retain existing functions without regenerate on progress/activity',()=>{
 const r=renderer(),cards=displayTurns(native());
 for(const phase of ['commentary','activity']){
  const html=r.renderTurnCard(cards.find(t=>t.phase===phase));
  assert(!html.includes('data-action="regen"'));assert(html.includes('card-actions-menu'));
 }
 const result=r.renderTurnCard(cards.find(t=>t.phase==='final_answer'));
 assert(result.includes('data-action="regen"'));assert(result.includes('card-actions-menu'));
 const user=r.renderTurnCard(cards.find(t=>t.role==='user'));
 for(const action of ['copy','multi-select','resend','edit-resend','prompt-inspect'])assert(user.includes('data-action="'+action+'"'));
});
test('image references render small lazy thumbnails, unsafe URLs never become image sources',()=>{
 const r=renderer(),html=r.renderTurnCard({id:'image',role:'user',text:'图片',attachments:[
  {path:'C:\\fixture\\图 A.png'}, {url:'https://example.test/image.png'}, {url:'javascript:alert(1)'}]});
 assert(html.includes('conversation-image-thumb'));assert(html.includes('loading="lazy"'));
 assert(html.includes('file:///C:/fixture/'));assert(html.includes('https://example.test/image.png'));
 assert(!html.includes('src="javascript:'));assert(html.includes('图片暂不可用'));
});
test('delivery-only changes participate in render signature',()=>{
 const r=renderer(),a=displayTurns(native(0)).find(t=>t.phase==='final_answer');
 const b=displayTurns(native(1)).find(t=>t.phase==='final_answer');
 assert.equal(a.text,b.text);assert.notEqual(r.turnRenderSignature(a),r.turnRenderSignature(b));
});
