'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {open}=require('../core/web-roundtable/cdp'),adapters=require('../core/web-roundtable/providers');
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-web-dom-'));const prior=process.env.AI_HUB_WEB_DATA_DIR;process.env.AI_HUB_WEB_DATA_DIR=root;
  let browser;
  try{
    browser=await open('deepseek','about:blank');assert.equal(browser.owned,true,'must own only the isolated test browser');assert.equal(browser.headless,true);
    const frame=(await browser.page.call('Page.getFrameTree')).frameTree.frame.id;
    const set=html=>browser.page.call('Page.setDocumentContent',{frameId:frame,html:'<!doctype html><meta charset="utf-8">'+html});
    const inspect=(p,prompt='测试问题')=>browser.page.evaluate(adapters.expression(p,prompt));
    await set('<textarea placeholder="Message DeepSeek"></textarea><div><span>测试问题</span></div><div data-virtual-list-item-key="2"><div class="ds-assistant-message-main-content">最终回答</div><button aria-label="Read aloud">朗读</button></div>');
    let s=await inspect('deepseek');assert.equal(s.echo,1);assert.equal(s.answers[0].done,true);
    await browser.page.evaluate('document.querySelector("[aria-label]").remove()');assert.equal((await inspect('deepseek')).answers[0].done,false);
    await set('<div class="chat-input-editor" contenteditable="true"></div><button data-testid="sidebar-user-menu-trigger"><span class="user-name">Fixture account</span></button><span>测试问题</span><div class="segment-assistant"><div class="thinking-container"><div class="markdown">不能收集的思考内容</div></div><div class="markdown">最终回答</div><div class="segment-assistant-actions"><span class="icon-button">复制</span></div></div>');
    s=await inspect('kimi');assert.equal(s.ready,true);assert.deepEqual(s.answers.map(a=>a.text),['最终回答']);assert.equal(s.answers[0].done,true);
    await browser.page.evaluate('document.querySelector(".user-name").remove()');assert.equal((await inspect('kimi')).ready,false,'composer must not race account hydration');
    await set('<div role="textbox" data-slate-editor="true" contenteditable="true"><p><span data-slate-zero-width="n">\uFEFF</span><span data-slate-placeholder="true" contenteditable="false">向千问提问</span></p></div><div class="answer-common-card"><div class="qk-markdown">流式内容</div></div><button aria-label="发送消息">发送</button>');
    s=await inspect('qwen');assert.equal(s.composerText,'');assert.equal(s.answers[0].done,false);
    await browser.page.evaluate('document.querySelector(".qk-markdown").classList.add("qk-markdown-complete")');assert.equal((await inspect('qwen')).answers[0].done,true);
    const probe=require('../core/account-browser').PROBE;
    for(const [host,html] of [
      ['chat.deepseek.com','<div class="ede5bc47"><img class="fdf01f38" width="32" height="32"></div>'],
      ['www.kimi.com','<button data-testid="sidebar-user-menu-trigger"><span class="user-name">Fixture account</span></button>'],
      ['www.qianwen.com','<div class="bg-pc-sidebar pt-3"><button class="text-left">Fixture account</button></div>']
    ]){
      const check=()=>browser.page.evaluate(`((location)=>${probe})({hostname:${JSON.stringify(host)}})`);
      await set('<textarea placeholder="Message DeepSeek"></textarea>');assert.equal((await check()).profile,false,'guest composer is never auth proof');
      await set(html);assert.equal((await check()).profile,true,host+' account evidence');
      await set(html+'<button>登录</button>');assert.equal((await check()).login,true,'login evidence takes precedence over stale avatar');
    }
    console.log('PASS: real isolated headless Chrome, 3 DOM adapter contracts, thought exclusion, completion controls, auth hydration, placeholder handling');
  }finally{if(browser)await browser.close();if(prior===undefined)delete process.env.AI_HUB_WEB_DATA_DIR;else process.env.AI_HUB_WEB_DATA_DIR=prior;fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
