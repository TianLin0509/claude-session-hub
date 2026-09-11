'use strict';
// Real isolated Hub and real native tools. No mocked renderer/session state.
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert/strict'),crypto=require('crypto');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const {realAcpConfig}=require('./helpers/acp-real-env');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const port=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
async function main(){
  delete process.env.ELECTRON_RUN_AS_NODE;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-acp-real-gui-')),dataDir=path.join(root,'data');fs.mkdirSync(dataDir);
  const out=path.resolve('artifacts/acp/gui-'+Date.now());fs.mkdirSync(out,{recursive:true});
  const config=realAcpConfig();fs.writeFileSync(path.join(dataDir,'config.json'),JSON.stringify(config));
  let codexOptions;
  if(process.env.ACP_GUI_GROUP==='1') {
    const source=process.env.CODEX_HOME || path.join(os.homedir(),'.codex'),home=path.join(root,'codex');fs.mkdirSync(home);
    const raw=fs.readFileSync(path.join(source,'config.toml'),'utf8'),read=k=>raw.match(new RegExp('^'+k+'\\s*=\\s*"([^"]+)"','m'))?.[1];
    const model=read('model'),effort=read('model_reasoning_effort');assert(model&&effort);
    fs.copyFileSync(path.join(source,'auth.json'),path.join(home,'auth.json'));
    fs.writeFileSync(path.join(home,'config.toml'),'model = '+JSON.stringify(model)+'\nmodel_reasoning_effort = '+JSON.stringify(effort)+'\n');
    codexOptions={kind:'codex',model,effort,mcpProfile:'none',codexSpeedTier:'inherit'};
  }
  const result={root,out,checks:[],passed:false};let hub,cdp;
  const until=async(expr,label,ms=100000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await cdp.eval(expr))return;
    if(result.currentId){const s=await cdp.eval('typeof sessions!=="undefined" ? sessions.get('+JSON.stringify(result.currentId)+') : null');if(s?.status!=='dormant' && s?.nativeRuntime?.connection==='disconnected' && !s.nativeRuntime.reason?.startsWith('Hub 已重新启动'))throw Error(s.nativeRuntime.reason);}
    await sleep(150);}throw Error('timeout: '+label);};
  const snap=async name=>{const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(shot.data,'base64'));};
  try {
    hub=await launchIsolatedHub({dataDir,port:await port(),label:'acp-real',extraEnv:{CODEX_HOME:path.join(root,'codex'),CLAUDE_CONFIG_DIR:path.join(root,'claude')}});
    result.pid=hub.pid;cdp=await connectFirstPage(hub);await until('typeof sessions!=="undefined"','renderer');
    await cdp.eval('document.getElementById("acp-settings-open").click()');await until('document.querySelector("#acp-settings-dialog")','settings');
    assert.equal(await cdp.eval('document.querySelector("#acp-settings-dialog input[type=password]").value'),'');
    await cdp.eval('[...document.querySelectorAll("#acp-settings-dialog button")].find(b=>b.textContent==="保存套餐配置").click()');
    await until('document.querySelector("#acp-settings-dialog [role=status]").textContent.includes("已保存")','settings saved');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir,'config.json'),'utf8')).acp.apiKey,config.acp.apiKey);
    await snap('settings');await cdp.eval('document.getElementById("acp-settings-dialog").close()');
    result.checks.push('real settings opens and saves; blank password preserves key without exposing it');
    for(const kind of process.argv.includes('--group-only')?[]:process.argv.slice(2).length?process.argv.slice(2):Object.keys(config.acp.providers)) {
      const cwd=path.join(root,kind);fs.mkdirSync(cwd);const nonce=crypto.randomUUID();fs.writeFileSync(path.join(cwd,'probe.txt'),nonce);
      const s=await cdp.eval('ipcRenderer.invoke("create-session",'+JSON.stringify({kind,opts:{cwd,model:config.acp.providers[kind].model}})+')');
      assert(s.id,JSON.stringify(s));result.currentId=s.id;const sid=JSON.stringify(s.id);
      await until('sessions.get('+sid+')?.nativeRuntime?.state==="idle"','native connected');
      await cdp.eval('document.querySelector(\'.session-item[data-session-id="'+s.id+'"]\').click()');
      await until('document.querySelector(".floating-input-box")','composer');
      await until('currentView === "card"','default conversation view');
      const send=async text=>cdp.eval('(()=>{const box=document.querySelector(".floating-input-box");box.textContent='+JSON.stringify(text)+';box.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector(".floating-input-send").click();})()');
      await until('sessions.get('+sid+').acpConfigOptions?.some(o=>o.category==="mode")','native settings bound');
      const settings=await cdp.eval('sessions.get('+sid+').acpConfigOptions');
      result.settings ||= {};result.settings[kind]=settings;
      for(const setting of settings.filter(o=>['mode','thought_level'].includes(o.category))) {
        const choices=setting.options.flatMap(o=>o.options || [o]);
        const alternate=choices.find(o=>o.value!==setting.currentValue);if(!alternate)continue;
        for(const value of [alternate.value,setting.currentValue]) {
          await cdp.eval('(()=>{const d=[...document.querySelectorAll(".codex-native-controls details")].find(d=>d.querySelector("summary")?.textContent==="原生执行设置");d.open=true;const select=[...d.querySelectorAll("label")].find(l=>l.firstChild.textContent==='+JSON.stringify(setting.name || setting.id)+').querySelector("select");select.value='+JSON.stringify(value)+';select.dispatchEvent(new Event("change",{bubbles:true}));})()');
          await until('sessions.get('+sid+').acpConfigOptions.find(o=>o.id==='+JSON.stringify(setting.id)+')?.currentValue==='+JSON.stringify(value),'native setting confirmation');
        }
      }
      await snap(kind+'-settings');
      result.checks.push(kind+': native mode/thought controls roundtrip confirmed by Harness');
      if(process.env.ACP_GUI_SETTINGS_ONLY==='1') {
        assert(!(await cdp.eval('document.querySelector(".session-welcome-eyebrow").innerText')).includes('Claude'));
        result.checks.push(kind+': new-session welcome shows actual native provider');continue;
      }
      await send('请使用原生工具读取 probe.txt，返回完整内容。不要修改文件。');
      await until('sessions.get('+sid+').nativeRuntime.state==="completed"','real GUI complete');
      await until('[...document.querySelectorAll(".turn-card .turn-body")].some(e=>e.innerText.includes('+JSON.stringify(nonce)+'))','real answer card');
      assert.equal(await cdp.eval('document.querySelectorAll(".fi-stuck").length'),0);
      await snap(kind+'-answer');result.checks.push(kind+': composer -> native tool -> answer card');
      if(process.env.ACP_GUI_RECOVERY==='1') {
        const nativeId=await cdp.eval('sessions.get('+sid+').acpSid');
        await cdp.send('Page.reload');await until('typeof sessions!=="undefined" && sessions.has('+sid+')','renderer reloaded');
        const select=async()=>{await cdp.eval('document.querySelector(\'.session-item[data-session-id="'+s.id+'"]\').click()');
          await until('sessions.get('+sid+')?.nativeRuntime?.connection==="connected" && sessions.get('+sid+')?.acpSid==='+JSON.stringify(nativeId)+' && document.querySelector(".floating-input-box")','reopened composer');};
        await select();await until('[...document.querySelectorAll(".turn-card .turn-body")].some(e=>e.innerText.includes('+JSON.stringify(nonce)+'))','history after renderer reload');
        await cdp.eval('document.querySelector(".fi-bridge-fork").click()');
        await until('[...sessions.values()].some(s=>s.branchSourceSessionId==='+sid+' && s.nativeRuntime?.state==="idle")','fork button creates native branch');
        const child=await cdp.eval('[...sessions.values()].find(s=>s.branchSourceSessionId==='+sid+')');
        assert.notEqual(child.acpSid,nativeId);result.currentId=child.id;
        await cdp.eval('document.querySelector(\'.session-item[data-session-id="'+child.id+'"]\').click()');
        await until('document.querySelector(".floating-input-box")','child composer');
        await send('不使用任何工具，原样回复我们前面读取文件得到的完整随机标记。');
        await until('sessions.get('+JSON.stringify(child.id)+').nativeRuntime.state==="completed"','fork reply');
        await until('[...document.querySelectorAll(".turn-card.assistant .turn-body")].filter(e=>e.innerText.trim()).at(-1)?.innerText.includes('+JSON.stringify(nonce)+')','fork native context');
        assert(await cdp.eval('(()=>{const c=[...document.querySelectorAll(".turn-card")];const u=c.findLastIndex(e=>e.classList.contains("user"));return c.slice(u+1).some(e=>e.classList.contains("assistant") && e.innerText.includes('+JSON.stringify(nonce)+'));})()'),'user card precedes native reply');
        await snap(kind+'-fork');await cdp.eval('ipcRenderer.invoke("close-session",'+JSON.stringify(child.id)+')');result.currentId=s.id;
        const closed=await cdp.eval('ipcRenderer.invoke("close-session",'+sid+')');assert(closed.ok);
        await until('sessions.get('+sid+')?.status==="dormant"','parent dormant');await select();
        assert.equal(await cdp.eval('sessions.get('+sid+').acpSid'),nativeId);
        await until('sessions.get('+sid+').acpConfigOptions?.some(o=>o.category==="mode")','restored native settings bound');
        const restoredSettings=await cdp.eval('sessions.get('+sid+').acpConfigOptions');
        for(const setting of settings.filter(o=>['mode','thought_level'].includes(o.category)))assert.equal(restoredSettings.find(o=>o.id===setting.id)?.currentValue,setting.currentValue);
        await send('不使用任何工具，原样回复我们前面读取文件得到的完整随机标记。');
        await until('sessions.get('+sid+').nativeRuntime.state==="completed"','resume answer');
        await until('[...document.querySelectorAll(".turn-card.assistant .turn-body")].filter(e=>e.innerText.trim()).at(-1)?.innerText.includes('+JSON.stringify(nonce)+')','resume context');
        fs.writeFileSync(path.join(out,kind+'-before-restart.log'),hub.log().join('\n').split(config.acp.apiKey).join('[REDACTED]'));
        await cdp.close();cdp=null;assert.equal((await gracefulQuit(hub)).exitCode,0);hub=null;
        hub=await launchIsolatedHub({dataDir,port:await port(),label:'acp-restart',extraEnv:{CODEX_HOME:path.join(root,'codex'),CLAUDE_CONFIG_DIR:path.join(root,'claude')}});
        cdp=await connectFirstPage(hub);await until('typeof sessions!=="undefined" && sessions.has('+sid+')','Hub restart sessions');await select();
        assert.equal(await cdp.eval('sessions.get('+sid+').acpSid'),nativeId);
        await send('不使用任何工具，原样回复我们前面读取文件得到的完整随机标记。');
        await until('sessions.get('+sid+').nativeRuntime.state==="completed"','Hub restart answer');
        await until('[...document.querySelectorAll(".turn-card.assistant .turn-body")].filter(e=>e.innerText.trim()).at(-1)?.innerText.includes('+JSON.stringify(nonce)+')','Hub restart context');
        await snap(kind+'-restart');result.checks.push(kind+': actual branch button, close/reopen, renderer and isolated Hub restart preserve native context and history');
      }
      if(process.env.ACP_GUI_IMAGES==='1') {
        const files=[];
        for(const [i,color] of ['red','blue'].entries()) {
          const image=await cdp.eval('(()=>{const c=document.createElement("canvas");c.width=200;c.height=200;const x=c.getContext("2d");x.fillStyle='+JSON.stringify(color)+';x.fillRect(0,0,200,200);return c.toDataURL("image/png");})()');
          const file=path.join(cwd,'image '+i+'.png');fs.writeFileSync(file,Buffer.from(image.split(',')[1],'base64'));files.push(file);
        }
        const text='不使用工具。按图片顺序用中文说出两张图中纯色色块的颜色。\n'+files.map(f=>'"'+f+'"').join('\n');
        const before=await cdp.eval('sessions.get('+sid+').nativeRuntime.turnId');await send(text);
        if(kind==='qwen') {
          await until('sessions.get('+sid+').nativeRuntime.turnId!=='+JSON.stringify(before)+' && sessions.get('+sid+').nativeRuntime.state==="completed"','actual image response');
          await until('[...document.querySelectorAll(".turn-card.assistant .turn-body")].filter(e=>e.innerText.trim()).at(-1)?.innerText.includes("红") && [...document.querySelectorAll(".turn-card.assistant .turn-body")].filter(e=>e.innerText.trim()).at(-1)?.innerText.includes("蓝")','image contents recognized');
          await until('document.querySelectorAll(".conversation-image-list img").length>=2','two image attachments in history');
          result.checks.push('qwen: two real images delivered and recognized, image cards retained');
        }else {
          await until('document.body.innerText.includes("当前模型或 Harness 不支持图片")','image preflight explanation');
          assert.equal(await cdp.eval('sessions.get('+sid+').nativeRuntime.turnId'),before);
          assert.equal(await cdp.eval('document.querySelector(".floating-input-box").innerText'),text);
          result.checks.push(kind+': unsupported images blocked before send and draft preserved');
        }
        await snap(kind+'-images');
      }
      if(process.env.ACP_GUI_INTERACTIONS==='1') {
        await send('Use your built-in ask_user_question or AskUserQuestion tool to ask me which color I prefer: blue or red. Invoke that tool, not plain text. Then acknowledge my answer.');
        await until('document.querySelector(".codex-native-request button[type=submit]")','native question form');
        await snap(kind+'-question');
        await cdp.eval(`(()=>{const f=document.querySelector('.codex-native-request');for(const el of f.querySelectorAll('textarea,input,select')){
          if(el.tagName==='SELECT'){const options=[...el.options].filter(o=>o.value);el.value=(options.find(o=>/blue/i.test(o.textContent)) || options[0]).value;}
          else if(el.type==='checkbox')el.checked=true;else el.value='blue';
        }f.querySelector('button[type=submit]').click();})()`);
        await until('sessions.get('+sid+').nativeRuntime.state==="completed"','question answered');
        result.checks.push(kind+': real native question answered using rendered form');
        for(const allow of [false,true]) {
          // DSH explicitly permits OS temporary directories in workspace-write.
          // This owned evidence directory is outside both cwd and OS temp.
          const target=path.join(out,kind+'-'+(allow?'allowed':'denied')+'.txt');
          await send('Use your native tool to write the exact text ACP_APPROVED into '+target+'. This path is outside your workspace. If the user denies permission, stop immediately and do not try another tool or path.');
          await until('sessions.get('+sid+').nativeRuntime.requests?.some(r=>r.method==="session/request_permission" && !r.params.toolCall?._meta?.qwenQuestions)','file permission');
          const request=await cdp.eval('sessions.get('+sid+').nativeRuntime.requests.find(r=>r.method==="session/request_permission")');
          const choice=request.params.options.find(o=>o.kind===(allow?'allow_once':'reject_once'));
          assert(choice,'native permission option missing');await snap(kind+'-'+(allow?'allow':'deny'));
          await cdp.eval('[...document.querySelectorAll(".codex-native-request button")].find(b=>b.textContent==='+JSON.stringify(choice.name || choice.optionId)+').click()');
          const permissionDeadline=Date.now()+100000;const replied=new Set([request.id]);
          while(Date.now()<permissionDeadline) {
            const runtime=await cdp.eval('sessions.get('+sid+').nativeRuntime');
            if(runtime.state==='completed')break;
            for(const next of runtime.requests || []) {
              if(replied.has(next.id))continue;replied.add(next.id);
              const option=next.params.options?.find(o=>o.kind===(allow?'allow_once':'reject_once'));assert(option);
              await until('document.querySelector('+JSON.stringify('.codex-native-request[data-request-id="'+next.id+'"]')+')','next permission form');
              await cdp.eval('[...document.querySelector('+JSON.stringify('.codex-native-request[data-request-id="'+next.id+'"]')+').querySelectorAll("button")].find(b=>b.textContent==='+JSON.stringify(option.name || option.optionId)+').click()');
            }
            await sleep(150);
          }
          assert.equal(await cdp.eval('sessions.get('+sid+').nativeRuntime.state'),'completed');
          assert.equal(fs.existsSync(target),allow,'permission must govern actual filesystem side effect');
          if(allow)assert.equal(fs.readFileSync(target,'utf8').trim(),'ACP_APPROVED');
          result.checks.push(kind+': '+(allow?'allow creates file':'deny prevents write')+' through real native permission button');
        }
      }
      const prior=await cdp.eval('sessions.get('+sid+').nativeRuntime.turnId');
      await send('请详细写一篇长文，分十节解释 ACP 会话恢复和权限交互，每节至少 300 字。');
      await until('sessions.get('+sid+').nativeRuntime.state==="running" && sessions.get('+sid+').nativeRuntime.turnId!=='+JSON.stringify(prior),'running');
      await cdp.eval('document.querySelector(".floating-input-stop").click()');
      await until('sessions.get('+sid+').nativeRuntime.state==="interrupted"','cancelled');
      await snap(kind+'-stopped');result.checks.push(kind+': stop button -> confirmed native cancellation');
    }
    if(codexOptions) {
      result.currentId=null;
      const cwd=path.join(root,'mixed-group');fs.mkdirSync(cwd);
      const slots=[...Object.entries(config.acp.providers).map(([kind,p])=>({kind,model:p.model})),codexOptions];
      const group=await cdp.eval('ipcRenderer.invoke("create-meeting",'+JSON.stringify({title:'原生 ACP 混合群聊验收',scene:'general',workspace:cwd,slots})+')');
      result.meetingId=group.id;assert.equal(group.subSessions.length,4);
      await until(JSON.stringify(group.subSessions)+'.every(id=>sessions.get(id)?.nativeRuntime?.state==="idle")','four native members');
      await cdp.eval('window.MeetingRoom.openMeeting('+JSON.stringify(group.id)+','+JSON.stringify(group)+')');
      await until('document.getElementById("mr-input-box")','group composer');
      await cdp.eval('(()=>{const box=document.getElementById("mr-input-box");box.textContent="只回复 ACP_GROUP_OK 与你的群聊角色名字，不调用工具。";box.dispatchEvent(new Event("input",{bubbles:true}));document.getElementById("mr-send-btn").click();})()');
      const expr='ipcRenderer.invoke("groupchat:get-state",{meetingId:'+JSON.stringify(group.id)+'})';
      await until('(async()=>{const s=await '+expr+';return s?.messages?.filter(m=>m.role==="assistant" && m.content?.includes("ACP_GROUP_OK")).length===4;})()','four real group answers',180000);
      result.group=await cdp.eval(expr);await snap('mixed-group');result.checks.push('three native ACP and real Codex mixed group, actual composer and dispatcher');
    }
    result.passed=true;
  }catch(e){result.error=e.message;result.logTail=e.logTail;throw e;}
  finally {
    if(cdp){try{result.sessions=await cdp.eval('[...sessions.values()]');await snap('final');}catch(e){result.captureError=e.message;}await cdp.close();}
    if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n').split(config.acp.apiKey).join('[REDACTED]'));
      try{result.exit=await gracefulQuit(hub);}catch(e){result.exitError=e.message;result.passed=false;process.exitCode=1;}}
    if(codexOptions)fs.rmSync(path.join(root,'codex/auth.json'),{force:true});
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2).split(config.acp.apiKey).join('[REDACTED]'));
    console.log(JSON.stringify({out,checks:result.checks,passed:result.passed,error:result.error}));
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
