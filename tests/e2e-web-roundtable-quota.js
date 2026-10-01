'use strict';
const assert=require('node:assert/strict');
const {chromium}=require('C:/DevTools/playwright-cli-0.1.19/node_modules/playwright');
const {chromeExecutable}=require('../core/hub-chrome');
const {expression}=require('../core/web-roundtable/providers');
(async()=>{const b=await chromium.launch({executablePath:chromeExecutable(),headless:true});try{
 const p=await b.newPage();
 const quota='Your free quota is used up. Refreshes at 10-19.';
 for(const [html,expected] of [
  ['<div class="chat-input-bar-content">'+quota+'</div>',quota],
  ['<div class="chat-input-bar-content" hidden>'+quota+'</div>',null],
  ['<div class="segment-assistant"><div class="chat-input-bar-content">'+quota+'</div></div>',null],
  ['<div contenteditable="true"><div class="chat-input-bar-content">'+quota+'</div></div>',null],
  ['<div class="chat-input-bar-content">额度已用完，请稍后再试</div>','额度已用完，请稍后再试'],
  ['<div class="chat-input-bar-content">Upgrade your plan</div>',null],
 ]){await p.setContent(html);assert.equal((await p.evaluate(expression('kimi'))).quotaMessage,expected);}
 console.log('PASS: 6 real Chromium quota DOM fixtures, including hidden and quoted notices');
}finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
