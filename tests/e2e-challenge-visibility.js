'use strict';
const assert=require('assert/strict');
const {chromium}=require('C:/DevTools/playwright-cli-0.1.19/node_modules/playwright');
const {chromeExecutable}=require('../core/hub-chrome');
const {CHALLENGE_PROBE}=require('../core/web-risk-guard');
const {PROBE}=require('../core/account-browser');
(async()=>{
  const browser=await chromium.launch({executablePath:chromeExecutable(),headless:true});
  try {
    const page=await browser.newPage();await page.route('**/*',r=>r.abort());
    const results=[];
    for (const [name,html,expected] of [
      ['hidden hcaptcha','<p>Ready</p><div hidden><iframe src="https://hcaptcha.com/widget"></iframe></div>',false],
      ['hidden Cloudflare','<p>Ready</p><div style="display:none"><iframe src="https://challenges.cloudflare.com/widget"></iframe></div>',false],
      ['hidden slider','<p>Ready</p><div class="geetest_panel" style="visibility:hidden;width:300px;height:120px">check</div>',false],
      ['visible check after hidden placeholder','<iframe hidden src="https://hcaptcha.com/widget"></iframe><iframe src="https://hcaptcha.com/widget"></iframe>',true],
      ['visible Cloudflare','<iframe src="https://challenges.cloudflare.com/widget"></iframe>',true],
      ['top-level localized Cloudflare','<title>请稍候…</title><script>window._cf_chl_opt={}</script><p>Checking</p>',true],
      ['normal page mentioning verification','<title>ChatGPT</title><main><article>请解释人机验证</article><textarea></textarea></main>',false],
      ['quoted Google traffic warning','<article>Our systems have detected unusual traffic from your computer</article>',false],
    ]) {
      await page.setContent(html);
      const tool=(await page.evaluate(CHALLENGE_PROBE)).challenge;
      const account=(await page.evaluate(PROBE)).challenge;
      results.push({name,tool,account,expected});
    }
    console.log(JSON.stringify(results,null,2));
    for(const r of results) {
      assert.equal(r.tool,r.expected,r.name+' tool');
      assert.equal(r.account,r.expected,r.name+' account');
    }
    console.log('e2e-challenge-visibility: PASS');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
