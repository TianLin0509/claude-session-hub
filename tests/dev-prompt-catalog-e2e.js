'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {pathToFileURL}=require('node:url');
const {connectFirstPage}=require('./helpers/cdp-client');
const {spawn}=require('node:child_process');
const report=process.argv[2];
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-prompt-report-'));
const art=path.resolve(__dirname,'../output/playwright',`prompt-catalog-${Date.now()}`);fs.mkdirSync(art,{recursive:true});
const freePort=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function run(){let hub,cdp;const checks=[];const ok=(name,yes)=>{assert(yes,name);checks.push(name);console.log('PASS '+name)};
try{
  const port=await freePort();
  const child=spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${port}`,`--user-data-dir=${path.join(root,'chrome')}`,pathToFileURL(report).href],{windowsHide:true,stdio:'ignore'});
  hub={child,cdpHttpBase:`http://127.0.0.1:${port}`,label:'isolated report Chrome'};
  for(let i=0;i<80;i++){try{cdp=await connectFirstPage(hub,t=>t.type==='page');break}catch(e){if(i===79)throw e;await sleep(100)}}
  const browser=cdp;
  try{
    for(let i=0;i<40;i++){if(await browser.eval("document.querySelectorAll('article').length===9"))break;await sleep(100)}
    ok('中文页面加载且主流程 9 项',await browser.eval("document.title.includes('开发 prompt') && document.querySelectorAll('article').length===9"));
    await browser.send('Emulation.setDeviceMetricsOverride',{width:1500,height:1100,deviceScaleFactor:1,mobile:false});
    await sleep(400);
    let s=await browser.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(art,'20260910-prompt-editor-wide.png'),Buffer.from(s.data,'base64'));
    await browser.eval(`(()=>{const t=document.querySelector('[data-id="independent"] [data-edit="text"]');t.value='完成需求，自测后按项目入口合并。';t.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await browser.send('Page.reload');await sleep(250);
    ok('修改在刷新后恢复',await browser.eval(`document.querySelector('[data-id="independent"] [data-edit="text"]').value==='完成需求，自测后按项目入口合并。'`));
    ok('导出快照包含原文、修改稿和基线',await browser.eval(`snapshot().entries.find(e=>e.id==='independent').changed && snapshot().base.length===40`));
    await browser.eval(`window.__downloads=[];URL.createObjectURL=b=>{window.__downloads.push(b);return 'blob:controlled'};HTMLAnchorElement.prototype.click=function(){};document.getElementById('exportJson').click();document.getElementById('exportMd').click();document.getElementById('saveHtml').click();`);
    ok('JSON、Markdown、HTML 导出内容可读取',await browser.eval(`(async()=>{const t=await Promise.all(window.__downloads.map(b=>b.text()));return JSON.parse(t[0]).entries.length===58 && t[1].includes('完成需求，自测后按项目入口合并。') && t[2].includes('embedded-drafts')&&t[2].includes('完成需求，自测后按项目入口合并。')})()`));
    await browser.eval(`document.getElementById('filter').value='旧版兼容';document.getElementById('filter').dispatchEvent(new Event('change'));`);
    ok('旧版兼容筛选 12 项',await browser.eval("document.querySelectorAll('article').length===12"));
    await browser.eval(`document.getElementById('filter').value='只看修改';document.getElementById('filter').dispatchEvent(new Event('change'));`);
    ok('只看修改筛选正常',await browser.eval("document.querySelectorAll('article').length===1"));
    await browser.send('Emulation.setDeviceMetricsOverride',{width:760,height:1100,deviceScaleFactor:1,mobile:false});
    ok('窄屏无横向溢出',await browser.eval('document.documentElement.scrollWidth<=innerWidth'));
    await sleep(300);
    s=await browser.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(art,'20260910-prompt-editor-narrow.png'),Buffer.from(s.data,'base64'));
    await browser.eval(`document.querySelector('[data-action="reset"]').click()`);
    ok('恢复原文清除修改',await browser.eval('DATA.entries.filter(changed).length===0'));
    await browser.eval(`(async()=>{const d=snapshot();d.entries[0].text='导入的立项修改';const dt=new DataTransfer();dt.items.add(new File([JSON.stringify(d)],'review.json',{type:'application/json'}));document.getElementById('file').files=dt.files;await document.getElementById('file').onchange()})()`);
    ok('JSON 导入恢复对应修改项',await browser.eval("value(DATA.entries[0])==='导入的立项修改'"));
  }finally{ /* The owned page is closed by gracefulQuit below. */ }
}finally{if(cdp){await cdp.send('Browser.close');await cdp.close()}if(hub){for(let i=0;i<50&&hub.child.exitCode===null;i++)await sleep(100);assert.equal(hub.child.exitCode,0,'owned Chrome exits cleanly')}fs.writeFileSync(path.join(art,'20260910-prompt-editor-checks.json'),JSON.stringify({checks},null,2));console.log('ARTIFACT_ROOT '+art)}
}run().catch(e=>{console.error(e);process.exitCode=1});
