'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {QwenCliSession}=require('../core/qwen-cli-session');
function setup(t){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-model-switch-')),file=path.join(home,'.qwen/settings.json');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify({modelProviders:{openai:[{id:'qwen3.8-flash'},{id:'qwen3.7-plus'}]},model:{name:'qwen3.7-plus'}}));
  const s=new QwenCliSession({id:'s',home,cwd:home,model:'qwen3.8-flash',launch:{command:process.execPath,args:[]}});
  s.start=async()=>{};s.runtime={connection:'connected',state:'idle'};s.currentModel='qwen3.8-flash';
  t.after(()=>{s.dispose();fs.rmSync(home,{recursive:true,force:true});});return{s,file};
}
test('an old native model preference cannot acknowledge a new switch',async t=>{
  const {s}=setup(t);await assert.rejects(s.configure({model:'qwen3.7-plus'},{timeoutMs:60}),/未确认/);
  assert.equal(s.currentModel,'qwen3.8-flash');assert.equal(s.configurePending,false);
});
test('native settings write confirms a configured model after the CLI command',async t=>{
  const {s,file}=setup(t);let command;
  s.send=async text=>{command=text;await new Promise(r=>setTimeout(r,10));const settings=JSON.parse(fs.readFileSync(file,'utf8'));settings.model={name:'qwen3.7-plus'};fs.writeFileSync(file,JSON.stringify(settings));};
  assert.equal((await s.configure({model:'qwen3.7-plus'})).confirmationSource,'native-settings-write');
  assert.equal(command,'/model qwen3.7-plus');assert.equal(s.currentModel,'qwen3.7-plus');
  await assert.rejects(s.configure({model:'unconfigured-provider/model'}),/不在/);
  s.runtime.state='running';await assert.rejects(s.configure({model:'qwen3.8-flash'}),/当前轮/);
});
