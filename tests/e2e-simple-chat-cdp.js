'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { ALL_AI_KINDS } = require('../core/ai-kinds');
const root = path.resolve(__dirname, '..'), j = JSON.stringify;
const port = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-simple-chat-'));
  const out = path.join(root, 'artifacts/20261002-cel-sticker-chat-codex1', 'gui-' + Date.now());
  const home = path.join(temp, 'codex'), cwd = path.join(temp, 'workspace');
  for (const dir of [out, home, cwd]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "low"\n');
  fs.writeFileSync(path.join(cwd, 'card-delivery.html'), '<!doctype html><meta charset="utf-8"><p>隔离验收产物</p>');
  let hub, cdp;
  const evidence = { passed: false, out, checks: [], boundary: '真实隔离 Electron + 本地 App Server 协议夹具；未调用云端模型' };
  const check = (ok, label) => { assert(ok, label); evidence.checks.push(label); };
  const until = async (expr, label = expr) => {
    const end = Date.now() + 30000;
    while (Date.now() < end) { if (await cdp.eval(expr)) return; await _waitMs(100); }
    throw Error('timeout: ' + label);
  };
  const click = async selector => {
    const p = await cdp.eval(`(() => { const e = document.querySelector(${j(selector)}); if (!e) throw Error('missing ' + ${j(selector)});
      e.scrollIntoView({block:'center',behavior:'instant'}); const r=e.getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height}; })()`);
    assert(p.width && p.height, 'visible ' + selector);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x:p.x, y:p.y, button:'left', clickCount:1 });
  };
  const shot = async name => { const png=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    const file=path.join(out,name+'.png'); fs.writeFileSync(file,Buffer.from(png.data,'base64')); return file; };
  const send = async text => { await click('.floating-input-box'); await cdp.send('Input.insertText', {text}); await click('.floating-input-send'); };
  try {
    hub = await launchIsolatedHub({dataDir:path.join(temp,'data'),port:await port(),label:'simple-chat',extraEnv:{
      CODEX_HOME:home, CLAUDE_CONFIG_DIR:path.join(temp,'claude'), CLAUDE_HUB_AGENT_RUNTIME:'native',
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(__dirname,'fixtures/codex-app-server.js'),
      CLAUDE_HUB_NATIVE_FIXTURE_STORE:path.join(temp,'native-store.json') }});
    evidence.pid=hub.pid; cdp=await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:0,mobile:false});
    await until('typeof sessions!=="undefined" && typeof ipcRenderer!=="undefined"');
    const session=await cdp.eval(`ipcRenderer.invoke('create-session',${j({kind:'codex',opts:{cwd,model:'gpt-6-astra',effort:'low',mcpProfile:'none',codexSpeedTier:'inherit'}})})`);
    const sid=j(session.id); evidence.sessionId=session.id;
    await until(`sessions.get(${sid})?.nativeRuntime?.state==='idle'`);
    await click(`.session-item[data-session-id="${session.id}"]`);
    if(!await cdp.eval('document.querySelector("#terminal-panel").classList.contains("card-view-active")')) await click('#btn-backstage');
    const prompt='fixture:conversation\n请保留完整输入与完整回复';
    await send(prompt);
    await until('document.querySelector("#msg-overlay .turn-card[data-phase=commentary]")');
    await cdp.eval('window.__replyHost=document.querySelector("#msg-overlay .turn-card.assistant")');
    check(await cdp.eval('document.querySelectorAll("#msg-overlay .turn-card.assistant").length===1'),'过程中仅一张 AI 消息');
    await until(`sessions.get(${sid}).nativeRuntime.state==='completed'`);
    const final='#msg-overlay .turn-card[data-phase="final_answer"]';
    await until(`document.querySelector('${final} .chat-process')`);
    check(await cdp.eval('document.querySelectorAll("#msg-overlay .turn-card.assistant").length===1 && document.querySelectorAll("#msg-overlay .turn-card.user").length===1'),'完成后你一条、AI 一条');
    check(await cdp.eval(`window.__replyHost===document.querySelector('${final}')`),'过程中同一消息节点持续更新到最终回复');
    check(await cdp.eval(`!document.querySelector('${final} .chat-process').open`),'过程默认收起');
    check(await cdp.eval(`document.querySelector('${final} .turn-head .chat-process') && document.querySelector('#msg-overlay .turn-card.user .turn-head .chat-word-count') && !document.querySelector('#msg-overlay .turn-card.user .chat-message-bubble .turn-meta-pills')`),'字数与过程合入信息行，不再占用正文底部');
    check(await cdp.eval(`document.querySelector('${final} .chat-process-body').textContent.includes('已定位问题')`),'原过程消息保留可展开');
    const copy=await cdp.eval(`require('./visible-card-text').extractVisibleCardText(document.querySelector('${final} .turn-body'))`);
    check((copy.match(/这是同一条长回答/g)||[]).length===36 && !copy.includes('已定位问题') && !copy.includes('展开全文'),'复制完整最终回复且不混过程与控件');
    evidence.longCopy={length:copy.length,paragraphs:36};
    check(await cdp.eval(`document.querySelector('${final} .av-character img').naturalWidth>0 && document.querySelector('#msg-overlay .av-user img').naturalWidth>0`),'Codex 女生头像与 Hub 橙色头像实际加载');
    await cdp.eval('document.getElementById("msg-overlay").scrollTop=0'); evidence.longScreenshot=await shot('long-reply');
    await click(final+' .chat-process > summary');
    await cdp.eval(`_loadSessionHistoryToOverlay(${sid},{incremental:true})`);
    check(await cdp.eval(`document.querySelector('${final} .chat-process').open`),'历史增量刷新保留手选展开状态');
    await click(final+' .chat-process > summary');
    await send(prompt);
    await until('document.querySelectorAll("#msg-overlay .turn-card[data-phase=final_answer]").length===2');
    check(await cdp.eval('document.querySelectorAll("#msg-overlay .turn-card.user").length===2'),'有意重复发送的第二条消息完整保留');
    await cdp.send('Page.reload');
    await _waitMs(500);
    await cdp.close(); cdp=await connectFirstPage(hub);
    await until(`typeof sessions!=='undefined' && sessions.has(${sid})`);
    await click(`.session-item[data-session-id="${session.id}"]`);
    await until('document.querySelectorAll("#msg-overlay .turn-card[data-phase=final_answer]").length===2');
    check(await cdp.eval('document.querySelectorAll("#msg-overlay .turn-card.assistant").length===2'),'重载历史仍每轮一张 AI 消息');
    await send('fixture:card-details\n请展示本轮结果');
    await until('document.querySelectorAll("#msg-overlay .turn-card[data-phase=final_answer]").length===3');
    // Use a stable selector instead of relying on indicator/pager sibling order.
    await cdp.eval('document.querySelectorAll("#msg-overlay .turn-card[data-phase=final_answer]")[2].id="verified-result"');
    const card='#verified-result';
    await until(`document.querySelector('${card} .turn-delivery-summary')`);
    check(await cdp.eval(`!document.querySelector('${card} .turn-result-glance') && !document.querySelector('${card} .turn-delivery-summary').open`),'结果不再使用统计面板，交付明细默认收起');
    check(await cdp.eval(`document.querySelector('${card} .chat-process-warning').textContent.includes('2 项失败')`),'失败计数覆盖本轮全部活动，含最近 24 项之前的记录');
    await cdp.eval(`document.querySelector('${card}').scrollIntoView({block:'center',behavior:'instant'})`);
    evidence.chatScreenshot=await shot('simple-chat');
    await click(card+' .turn-delivery-summary > summary');
    check(await cdp.eval(`document.querySelectorAll('${card} .turn-delivery-check.status-failed').length===1 && document.querySelectorAll('${card} .turn-delivery-file').length===2 && document.querySelectorAll('${card} .turn-delivery-artifact').length===1`),'文件、失败检查与产物链接全部保留');
    evidence.deliveryScreenshot=await shot('delivery-open');
    await click(card+' .turn-delivery-summary > summary'); await click(card+' .chat-process > summary');
    await click(card+' .tc-cluster > summary');
    const longRow=card+' [data-activity-id^="long-"]';
    await click(longRow+' > summary'); await click(longRow+' [data-action="tc-open-full-result"]');
    await until('document.querySelector(".card-detail-dialog[open] pre")');
    check(await cdp.eval('document.querySelector(".card-detail-dialog pre").textContent.length===50000'),'工具全文按需读取第一段');
    await click('.card-detail-dialog-tools button:nth-of-type(2)');
    check(await cdp.eval('document.querySelector(".card-detail-dialog pre").textContent.endsWith("END-OF-FULL-OUTPUT")'),'工具完整结果末尾仍可追溯');
    await click('.card-detail-dialog [aria-label="关闭详情"]');
    evidence.processScreenshot=await shot('process-open');
    await click(card+' .chat-process > summary');
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:900,height:700,deviceScaleFactor:0,mobile:false}); await _waitMs(200);
    check(await cdp.eval(`(()=>{const e=document.querySelector('${card}'),o=document.getElementById('msg-overlay');return e.getBoundingClientRect().right<=o.getBoundingClientRect().right+1 && o.scrollWidth<=o.clientWidth+1 && document.documentElement.scrollWidth<=innerWidth})()`),'窄窗口消息没有横向溢出');
    await cdp.eval(`document.querySelector('${card}').scrollIntoView({block:'center',behavior:'instant'})`); evidence.narrowScreenshot=await shot('narrow-chat');
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:0,mobile:false});
    // Check actual assets in the renderer without launching seven cloud sessions.
    evidence.avatars=await cdp.eval(`(async()=>{const a=require('./chat-avatar'); const kinds=${j(ALL_AI_KINDS)};
      const entries=[...kinds.map(k=>[k,a.chatAvatarSrc(k)]),['你',a.USER_AVATAR_SRC],['助理',a.ASSISTANT_AVATAR_SRC]];
      return Promise.all(entries.map(([kind,src])=>new Promise(resolve=>{const img=new Image();img.onload=()=>resolve({kind,src,width:img.naturalWidth});img.onerror=()=>resolve({kind,src,width:0});img.src=src;})));})()`);
    check(evidence.avatars.every(a=>a.width>0),'全部 AI 头像、橙色用户头像与企鹅原图在实际窗口加载');
    check(evidence.avatars.filter(a=>!['你','助理'].includes(a.kind)).every(a=>a.src.includes('/cel-v2/')),'所有 AI 与恢复别名统一为日系精灵');
    const assistantHTML=await cdp.eval(`(()=>{const container=document.createElement('div');return turnCardRenderer.mountSessionTurnCard(${sid},{id:'assistant-avatar',role:'assistant',kind:'codex',text:'助理消息'},{session:{purpose:'hub-assistant'},container}).outerHTML})()`);
    check(assistantHTML.includes('assets/assistant/penguin.png') && !assistantHTML.includes('ai-avatars/cel-v2/codex'),'助理身份优先使用企鹅');
    const fresh=await cdp.eval(`ipcRenderer.invoke('create-session',${j({kind:'codex',opts:{cwd,model:'gpt-6-astra',effort:'low',mcpProfile:'none'}})})`);
    await until(`sessions.get(${j(fresh.id)})?.nativeRuntime?.state==='idle'`);
    await click(`.session-item[data-session-id="${fresh.id}"]`);
    await send('fixture:card-details\n请展示本轮结果');
    await until('document.querySelector("#msg-overlay .turn-card[data-phase=final_answer] .turn-delivery-summary")');
    await cdp.eval('document.getElementById("msg-overlay").scrollTop=0');
    evidence.cleanScreenshot=await shot('one-pair-chat');
    check(await cdp.eval('document.querySelectorAll("#msg-overlay .turn-card").length===2'),'新会话从第一轮即呈现一对消息');
    evidence.passed=true;
  } catch(error) { evidence.error=error.stack; process.exitCode=1; if(cdp) evidence.failureScreenshot=await shot('failure').catch(()=>null); }
  finally { if(cdp) { evidence.ui=await cdp.eval('document.body.innerText.slice(-8000)').catch(()=>null); await cdp.close(); }
    if(hub) { fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n')); evidence.exit=await gracefulQuit(hub); }
    fs.writeFileSync(path.join(out,'evidence.json'),j(evidence,null,2)); console.log(j({out,passed:evidence.passed,checks:evidence.checks,error:evidence.error},null,2)); }
})();
