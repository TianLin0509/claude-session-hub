'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-projlib-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const HOME_DIR = path.join(TEMP_ROOT, 'home');
const WORKSPACE_ROOT = path.join(TEMP_ROOT, 'AIWork');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'sidebar-project-filter');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(label, fn, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { last = error; }
    await _waitMs(120);
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

async function clickPoint(client, selector) {
  await client.eval(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:"center"})`);
  const point = await client.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { found: false };
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { found: true, x, y, visible: rect.width > 0 && rect.height > 0, topmost: hit === el || el.contains(hit), hit: hit && (hit.tagName + '.' + hit.className) };
  })()`);
  assert.equal(point.found, true, `${selector} should exist`);
  assert.equal(point.visible, true, `${selector} should be visible`);
  assert.equal(point.topmost, true, `${selector} should be topmost; hit=${point.hit}`);
  await client.send('Page.bringToFront');
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function screenshot(client, target) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
}

function seedProject(dir, cfg, { linked = false, gitTime = null } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  if (linked) {
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: ../prepared-jia/.git/worktrees/x\n', 'utf-8');
  } else {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/master\n', 'utf-8');
    if (gitTime) fs.utimesSync(path.join(dir, '.git', 'HEAD'), gitTime, gitTime);
  }
  if (cfg) {
    fs.mkdirSync(path.join(dir, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.agents', 'project.json'), JSON.stringify(cfg), 'utf-8');
  }
}


async function main() {
  const baseline=process.argv.includes('--baseline');
  for(const dir of [DATA_DIR,WORKSPACE_ROOT,ARTIFACT_DIR])fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(WORKSPACE_ROOT,'.aiwork-root'),'');
  const project=path.join(WORKSPACE_ROOT,'alpha'),second=path.join(WORKSPACE_ROOT,'beta'),random=path.join(WORKSPACE_ROOT,'alpha-other');
  seedProject(project,{name:'项目甲',trunk:'master'});seedProject(second,{name:'项目乙',trunk:'master'});fs.mkdirSync(random);
  const child=path.join(project,'src');fs.mkdirSync(child);
  const linked=path.join(WORKSPACE_ROOT,'alpha-worktree'),admin=path.join(project,'.git','worktrees','test');
  fs.mkdirSync(linked);fs.mkdirSync(admin,{recursive:true});
  fs.writeFileSync(path.join(admin,'commondir'),'../..');fs.writeFileSync(path.join(admin,'gitdir'),path.join(linked,'.git'));
  fs.writeFileSync(path.join(linked,'.git'),'gitdir: '+admin);
  const registry = new (require('../core/prepared-project-registry').PreparedProjectRegistry)({ dataDir: DATA_DIR });
  registry.register(project);registry.register(second);
  let hub,client;const result={checks:[],baseline};
  const shot=name=>screenshot(client,path.join(ARTIFACT_DIR,name+'.png'));
  const size=width=>client.send('Emulation.setDeviceMetricsOverride',{width,height:950,deviceScaleFactor:0,mobile:false});
  const invoke=(channel,payload)=>client.eval('ipcRenderer.invoke('+JSON.stringify(channel)+','+JSON.stringify(payload)+')');
  const select=async(selector,value)=>{await client.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await _waitMs(180);};
  const visible=()=>client.eval(`Array.from(document.querySelectorAll('#session-list .session-item')).filter(e=>e.getBoundingClientRect().height>0).map(e=>e.dataset.meetingId||e.dataset.sessionId)`);
  const model={kind:'codex',model:'gpt-6-astra',effort:'high',mcpProfile:'none'};
  try {
    hub=await launchIsolatedHub({dataDir:DATA_DIR,port:await reservePort(),label:'sidebar-project-filter',windowMode:'hidden',extraEnv:{AI_HUB_WORKSPACE_ROOT:WORKSPACE_ROOT,CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(ROOT,'tests/fixtures/codex-app-server.js')}});
    client=await connectFirstPage(hub);await size(1500);
    await waitFor('ready',()=>client.eval('!!window.MeetingRoom && !!window.LaunchCenter'));
    const group=await invoke('create-meeting',{title:'项目甲群聊',scene:'general',workspace:project,slots:[model]});
    await client.eval('selectMeeting('+JSON.stringify(group.id)+')');
    await waitFor('avatar',()=>client.eval('!!document.querySelector(".mr-free-avatar-chk")'));
    const rect=await client.eval(`(()=>{const r=document.querySelector('.mr-free-avatar-chk').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await client.send('Input.dispatchMouseEvent',{type:'mouseMoved',...rect});await _waitMs(250);
    result.hover=await client.eval(`(()=>{const a=document.querySelector('.mr-free-avatar-chk'),r=a.parentElement,c=getComputedStyle(r);return {transform:getComputedStyle(a).transform,overflowX:c.overflowX,overflowY:c.overflowY,scrollbar:c.scrollbarWidth,width:r.clientWidth,scrollWidth:r.scrollWidth,height:r.clientHeight,scrollHeight:r.scrollHeight}})()`);
    await shot(baseline?'hover-before':'hover-after');
    if(baseline){assert.notEqual(result.hover.transform,'none');result.passed=true;return;}
    assert.equal(result.hover.transform,'none');assert.equal(result.hover.scrollbar,'none');
    assert(result.hover.scrollHeight<=result.hover.height+1,'avatar badge must fit vertically');
    const participants=()=>client.eval('ipcRenderer.invoke("get-meetings").then(ms=>ms.find(m=>m.id==='+JSON.stringify(group.id)+').participants)');
    await clickPoint(client,'.mr-free-avatar-chk');await waitFor('unchecked',async()=>!(await participants()).length);
    await clickPoint(client,'.mr-free-avatar-chk');await waitFor('checked',async()=>(await participants()).length===1);
    result.checks.push('真实 hover 无放大或滚动条；头像选择通过实际 IPC 保持有效');
    const groupRandom=await invoke('create-meeting',{title:'随机群聊',scene:'general',workspace:random,slots:[model]});
    const make=(cwd,kind='codex')=>invoke('create-session',{kind,opts:{...model,cwd}});
    const a=await make(project),sub=await make(child),worktree=await make(linked),b=await make(second),r=await make(random),shell=await make(project,'powershell');
    await waitFor('all sidebar sessions',async()=>{const ids=await visible();return [group.id,groupRandom.id,a.id,sub.id,worktree.id,b.id,r.id,shell.id].every(id=>ids.includes(id));});
    await client.eval('document.querySelector("#session-project-filter").focus()');
    await waitFor('project library',()=>client.eval('document.querySelector("#session-project-filter").options.length>=4 && !document.querySelector("#session-project-filter").hasAttribute("aria-busy")'));
    result.options=await client.eval('Array.from(document.querySelector("#session-project-filter").options).map(o=>({value:o.value,text:o.textContent}))');
    assert.equal(result.options[0].value,'random');assert.equal(result.options[0].text,'随机');
    const key=p=>p.replace(/\\/g,'/').toLowerCase();
    await clickPoint(client,'#session-project-filter');
    for(const [key,code] of [['Home',36],['Enter',13]]) {
      await client.send('Input.dispatchKeyEvent',{type:'keyDown',key,windowsVirtualKeyCode:code});
      await client.send('Input.dispatchKeyEvent',{type:'keyUp',key,windowsVirtualKeyCode:code});
    }
    await waitFor('native select random',()=>client.eval('document.querySelector("#session-project-filter").value==="random"'));
    let ids=await visible();
    for(const id of [r.id,groupRandom.id])assert(ids.includes(id));
    for(const id of [group.id,a.id,sub.id,worktree.id,b.id,shell.id])assert(!ids.includes(id));
    result.checks.push('随机第一项，仅显示项目库以外的普通会话和群聊，路径前缀同名不误归属');
    await shot('random');
    await select('#session-project-filter',key(project));ids=await visible();
    for(const id of [group.id,a.id,sub.id,worktree.id,shell.id])assert(ids.includes(id));
    for(const id of [r.id,groupRandom.id,b.id])assert(!ids.includes(id));
    await select('#session-model-filter','other');ids=await visible();assert(ids.includes(shell.id));assert(!ids.includes(a.id));assert(!ids.includes(group.id));
    await select('#session-model-filter','all');
    result.checks.push('项目路径涵盖根目录、子目录、Git worktree 和群聊；模型与项目交叉筛选');
    await shot('project');
    await clickPoint(client,'#btn-theme');await clickPoint(client,'[data-theme-id="codex"]');await clickPoint(client,'#btn-theme');await shot('project-light');
    await clickPoint(client,'#btn-theme');await clickPoint(client,'[data-theme-id="frost"]');await clickPoint(client,'#btn-theme');
    for(const width of [1500,760]){
      await size(width);await _waitMs(150);
      const g=await client.eval(`(()=>{const r=s=>{const e=document.querySelector(s),r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,right:r.right}};return {details:r('#btn-session-details'),model:r('#session-model-filter'),project:r('#session-project-filter'),bar:r('.session-detail-bar')}})()`);
      assert(Math.abs(g.model.y-g.project.y)<3,'filters remain one line');assert(g.project.right<=g.bar.right+1);result['layout'+width]=g;
    }
    await shot('narrow');
    // Refresh on re-entry, including a library project added while Hub is open.
    const third=path.join(WORKSPACE_ROOT,'gamma');seedProject(third,{name:'项目丙',trunk:'master'});registry.register(third);
    await client.eval('document.querySelector("#session-project-filter").blur();document.querySelector("#session-project-filter").focus()');
    await waitFor('fresh library',()=>client.eval('Array.from(document.querySelector("#session-project-filter").options).some(o=>o.textContent==="项目丙")'));
    await client.send('Page.reload');await waitFor('reload',()=>client.eval('!!window.LaunchCenter && !!document.querySelector("#session-project-filter") && document.querySelector("#session-project-filter").value==='+JSON.stringify(key(project))));
    await waitFor('restored filter',async()=>{const ids=await visible();return ids.includes(a.id)&&!ids.includes(r.id)});
    result.checks.push('筛选记忆在刷新后恢复，重新聚焦读取新加入的项目库项目；窄屏单行无溢出');
    result.passed=true;
  } finally {
    if(client){if(!result.passed)await shot('failure');await client.close();}if(hub)await gracefulQuit(hub);
    fs.writeFileSync(path.join(ARTIFACT_DIR,baseline?'baseline.json':'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
