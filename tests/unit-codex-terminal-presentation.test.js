'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CodexTerminalPresentation, MarkdownStream } = require('../core/codex-terminal-presentation');
const { classifyOpeningOutput } = require('../renderer/terminal-presentation');
const plain = text => text.replace(/\x1b\[[0-9;]*m/g, '');

test('streaming headings and fenced code survive every chunk boundary without lost text', () => {
  const source = '## 标题\n\n即时正文😀\n```javascript\nconst text = "你好";\nreturn text;\n```\n末尾';
  const render = chunks => { let out=''; const s=new MarkdownStream(x=>out+=x);for(const c of chunks)s.feed(c);s.flush();return plain(out); };
  const baseline=render([source]);
  for(let i=0;i<=source.length;i++)assert.equal(render([source.slice(0,i),source.slice(i)]),baseline,`split ${i}`);
  assert.equal(render([...source]),baseline);
  assert.match(baseline,/标题\n\n即时正文😀/);
  assert.match(baseline,/const text = "你好";/);
  assert.doesNotMatch(baseline,/```|## /);
});
test('prose remains live and unterminated code is bounded and flushed', () => {
  let out='';const s=new MarkdownStream(x=>out+=x);
  s.feed('现在');assert.match(plain(out),/现在/);
  s.feed('\n```js\n'+'x'.repeat(5000));assert.equal((plain(out).match(/x/g)||[]).length,4096);
  s.flush();assert.equal((plain(out).match(/x/g)||[]).length,5000);
});
test('started prefix, deltas and completed replay print each agent message once', () => {
  let out='';const f=new CodexTerminalPresentation(x=>out+=x);
  f.prompt('检查项目');
  f.agent({id:'a',phase:'commentary',text:'已定位'});
  f.agent({id:'a',phase:'commentary',text:'已定位问题'});
  f.agent({id:'a',phase:'commentary',text:'已定位问题'});
  f.agent({id:'b',phase:'final_answer',text:'最终回答'});
  f.finish('completed');
  assert.equal((plain(out).match(/已定位问题/g)||[]).length,1);
  assert.equal((plain(out).match(/最终回答/g)||[]).length,1);
  assert.match(plain(out),/你[\s\S]*Codex · 进展[\s\S]*Codex · 回答[\s\S]*✓ 已完成/);
});
test('tool replay does not duplicate output; failures keep code and diagnostics', () => {
  let out='';const f=new CodexTerminalPresentation(x=>out+=x);
  const item={id:'t',type:'commandExecution',command:'node check.js'};
  f.tool(item);f.toolDelta('t','PART A\n');
  f.tool({...item,aggregatedOutput:'PART A\nPART B\n',status:'completed',exitCode:2,error:'bad input'},true);
  f.tool({...item,aggregatedOutput:'PART A\nPART B\n',status:'completed',exitCode:2},true);
  assert.equal((plain(out).match(/PART A/g)||[]).length,1);
  assert.equal((plain(out).match(/PART B/g)||[]).length,1);
  assert.match(plain(out),/失败 · exit 2[\s\S]*bad input/);
});
test('steering keeps item identity and provider controls never become terminal escapes', () => {
  let out='';const f=new CodexTerminalPresentation(x=>out+=x);
  f.agent({id:'a',text:'first'});f.prompt('continue',{reset:false});f.agent({id:'a',text:'first second'});
  f.agent({id:'b',text:'\x1b[2J\x1b]52;c;secret\x07'});
  assert.equal((plain(out).match(/first/g)||[]).length,1);
  assert.doesNotMatch(out,/\x1b\[2J|\x1b\]52|\x07/);
});
test('welcome only replaces exact native opening banner; errors and hidden lower lines stay visible', () => {
  const term=(lines,extra={})=>({buffer:{active:{type:'normal',baseY:0,cursorY:1,length:lines.length,getLine:i=>({translateToString:()=>lines[i]}),...extra}}});
  assert.equal(classifyOpeningOutput(term(['','Codex 已连接。请使用 Hub 输入框发送消息。'])),'welcome');
  assert.equal(classifyOpeningOutput(term(['','Codex 已连接。请使用 Hub','输入框发送消息。'])),'welcome');
  assert.equal(classifyOpeningOutput(term(['Error: disconnected'])),'output');
  assert.equal(classifyOpeningOutput(term([''],{cursorY:9})),'output');
  assert.equal(classifyOpeningOutput(term([''],{baseY:1})),'output');
  assert.equal(classifyOpeningOutput(term([''],{type:'alternate'})),'output');
  assert.equal(classifyOpeningOutput(term([''])),'pending');
});
