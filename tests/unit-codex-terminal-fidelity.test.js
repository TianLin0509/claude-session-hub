'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { _private } = require('../core/session-manager');

test('xterm advertises truecolor while explicit monochrome/force-color intent survives', () => {
  const env = {TERM:'dumb'};
  _private.applyInteractiveTerminalEnv(env,{truecolor:true});
  assert.equal(env.COLORTERM,'truecolor');
  if(process.platform==='win32') assert.equal(env.FORCE_COLOR,'3');
  for(const override of [{NO_COLOR:'1'},{FORCE_COLOR:'0'},{FORCE_COLOR:'2'}]){
    const e={...override};_private.applyInteractiveTerminalEnv(e,{truecolor:true});
    for(const k of Object.keys(override))assert.equal(e[k],override[k]);
    if(override.NO_COLOR)assert.equal(e.FORCE_COLOR,undefined);
  }
});

test('Codex text and native cursor escapes reach xterm unaltered in every packet boundary', () => {
  const source=fs.readFileSync(require.resolve('../renderer/renderer.js'),'utf8');
  const body=source.slice(source.indexOf('function writeTerminalChunk('),source.indexOf('// Meeting-room used to switch'));
  const sandbox={sessions:new Map([['s',{kind:'codex'}]]),isCodexKind:()=>true,
    shouldAutoPinCodexTerminal:()=>false,scheduleCodexBottomPin:()=>{throw Error('must preserve manual scroll');}};
  vm.createContext(sandbox);vm.runInContext(body,sandbox);
  const bytes='› Improve documentation in @filename\r\n\x1b[?25lNative frame\x1b[?25h';
  for(const size of [1,7,bytes.length]){
    const writes=[],cached={terminal:{write:data=>writes.push(data)}};
    for(let i=0;i<bytes.length;i+=size)sandbox.writeTerminalChunk('s',cached,bytes.slice(i,i+size));
    assert.equal(writes.join(''),bytes);
  }
});
