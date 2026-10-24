'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const {getFreePort,waitFor,click}=require('./helpers/usage-refresh-fixture');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-dual-claude-'));
const data=path.join(root,'data'),home=path.join(root,'home'),cwd=path.join(root,'workspaces','task');
const out=path.resolve('artifacts','20261023-claude-dual-account-codex');
for(const dir of [data,home,cwd,out])fs.mkdirSync(dir,{recursive:true});
for(const [dir,email] of [[path.join(home,'.claude'),'account-a@example.test'],[path.join(home,'.claude-profiles','second'),'account-b@example.test']]) {
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'.claude.json'),JSON.stringify({oauthAccount:{emailAddress:email}}));
}
fs.writeFileSync(path.join(data,'prepared-projects.json'),JSON.stringify({schemaVersion:1,projects:[],migrations:[]}));
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({providers:{claude:{backend:'subscription'}}}));
const j=JSON.stringify,checks=[];
async function main(){
  let hub,c;
  try {
    hub=await launchIsolatedHub({dataDir:data,port:await getFreePort(),windowMode:'background',label:'claude-dual-account',extraEnv:{
      CLAUDE_HUB_HOME_DIR:home,CLAUDE_CONFIG_DIR:path.join(home,'.claude'),CODEX_HOME:path.join(home,'.codex'),
      CLAUDE_HUB_AGENT_RUNTIME:'native',HUB_CLAUDE_PROFILE:'',CLAUDE_HUB_E2E:'1',AI_HUB_WORKSPACE_ROOT:path.dirname(cwd),
      CLAUDE_HUB_ACCOUNT_FIXTURE:path.resolve('tests/fixtures/account-center-cli.js'),
      CLAUDE_HUB_CLAUDE_STREAM_FIXTURE:path.resolve('tests/fixtures/claude-stream.js'),DEEPSEEK_API_KEY:'',
      CLAUDE_HUB_FIXTURE_CONFIG_DIR:path.join(root,'captures'),
      HUB_SESSION_SEARCH_CLAUDE_ROOTS:path.join(home,'empty'),HUB_SESSION_SEARCH_CODEX_ROOTS:path.join(home,'empty'),
    }});
    c=await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:1,mobile:false});
    await waitFor(c,'!!window.LaunchCenter',30000);
    await click(c,'#btn-new');
    await click(c,'.new-session-option[data-kind="claude"]');
    await waitFor(c,'!document.getElementById("new-session-account-field").hidden && document.getElementById("new-session-account").options.length===2',15000);
    const choose=async id=>{
      await c.eval(`(()=>{const e=document.getElementById('new-session-account');e.value=${j(id)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await waitFor(c,`!document.getElementById('new-session-account').disabled && document.getElementById('new-session-account').value===${j(id)}`,15000);
    };
    await choose('second');
    const config=await c.eval("ipcRenderer.invoke('get-hub-config')");assert.equal(config.claudeSubscriptionProfile,'second');
    checks.push('真实启动中心显示两个 Claude 账号，下拉选择持久化为 second');
    const screenshot=await c.send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(out,'20261023-launch-center-codex.png'),Buffer.from(screenshot.data,'base64'));
    const create=opts=>c.eval(`ipcRenderer.invoke('create-session',${j({kind:'claude',opts:{cwd,mcpProfile:'none',...opts}})})`);
    const b=await create({claudeProfile:'second',title:'夹具 B'});assert.equal(b.claudeProfile,'second');
    assert.equal(b.claudeConfigDir,path.join(home,'.claude-profiles','second'));
    await choose('default');
    const a=await create({claudeProfile:'default',title:'夹具 A'});assert.equal(a.claudeProfile,'default');
    const list=await c.eval("ipcRenderer.invoke('get-sessions')");assert.equal(list.find(s=>s.id===b.id).claudeProfile,'second');
    checks.push('A/B 两条原生会话目录各自独立，切回 A 后 B 的身份保留');
    const restarted=await c.eval(`ipcRenderer.invoke('restart-session',${j(b.id)})`);
    assert.equal(restarted.claudeProfile,'second');
    const captures=fs.readdirSync(path.join(root,'captures')).map(f=>JSON.parse(fs.readFileSync(path.join(root,'captures',f),'utf8')));
    assert.ok(captures.some(x=>x.claudeProfile==='second' && x.configDir===path.join(home,'.claude-profiles','second')));
    assert.ok(captures.filter(x=>x.claudeProfile==='second').length>=2);
    checks.push('原生 CLI 夹具实际收到 B 独立目录，切回 A 后重启 B 仍使用 B');
    const accounts=await c.eval("ipcRenderer.invoke('accounts:snapshot')");
    assert.ok(accounts.ok);assert.ok(accounts.data.connections.some(x=>x.id==='claude-second'));
    checks.push('账号页模型包含 Claude 主账号及独立第二账号登录连接');
    const cache=await c.eval("ipcRenderer.invoke('get-usage-cache')");assert.ok(cache.claude.claudeScope.startsWith('default:'));
    await choose('second');
    const cacheB=await c.eval("ipcRenderer.invoke('get-usage-cache')");assert.ok(cacheB.claude.claudeScope.startsWith('second:'));
    assert.equal(cacheB.claude.usage5h,null);
    checks.push('切换账号后用量 scope 切换，B 缺额度时保持空值');
    await click(c,'#new-session-close');
    await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:5,y:250});
    await click(c,'#btn-rail-accounts');
    await waitFor(c,'document.querySelectorAll("[data-ac=claude-quota]").length===2',15000);
    assert.ok(await c.eval(`document.querySelector('[aria-label="Claude 用量账号"]').textContent.includes('已有会话恢复、重启仍用原账号')`));
    await click(c,'[data-ac="claude-quota"][data-profile="default"]');
    await waitFor(c,'document.querySelector("[data-ac=claude-quota][data-profile=default]").disabled',10000);
    assert.equal((await c.eval("ipcRenderer.invoke('get-hub-config')")).claudeSubscriptionProfile,'default');
    const accountShot=await c.send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(out,'20261023-account-center-codex.png'),Buffer.from(accountShot.data,'base64'));
    checks.push('账号页真实显示两账号，点击使用主账号与启动中心配置同步');
    console.log('PASS',checks.length,'checks',out);
  } finally {
    fs.writeFileSync(path.join(out,'20261023-evidence-codex.json'),JSON.stringify({checks,root},null,2));
    if(c)await c.close();if(hub)await gracefulQuit(hub);
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
