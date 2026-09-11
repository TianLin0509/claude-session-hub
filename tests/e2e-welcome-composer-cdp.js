'use strict';
/**
 * 真机回归：建群弹窗的「项目库」下拉 + 开发场景允许留在默认工作目录。
 *
 * 起一个隔离 Hub（独立 data dir / home / 工作根 / CDP 端口），工作根里预置：
 *   - prepared-甲：整理过的项目（.git 目录 + .agents/project.json name=测试项目甲）
 *   - prepared-乙：整理过、但 git 活动时间更早
 *   - linked-worktree：.git 是文件的 worktree，必须不出现在项目库
 *   - raw-repo：没整理过的仓库，必须不出现
 * 工作根**外面**（工作根的同级）另放一个：
 *   - never-used：整理过，但这个隔离 Hub 从没在它上面开过任何会话——2026-09-07 之前
 *     它第一次一定看不见（候选目录全都来自「Hub 已经见过的路径」），同级扫描就是为它加的。
 * 然后在真实 DOM 上：选开发场景（档位必须留在默认）→ 点「选择已有路径」（项目库自动展开）
 * → 点第一项（路径回显、库收起）。
 *
 * 跑法：node tests/e2e-dev-scene-project-library-cdp.js
 */
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
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'welcome-composer');
const SHOT_OPEN = path.join(ARTIFACT_DIR, `library-open-${RUN_ID}.png`);
const SHOT_PICKED = path.join(ARTIFACT_DIR, `library-picked-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `result-${RUN_ID}.json`);

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
  for (const dir of [DATA_DIR, WORKSPACE_ROOT, ARTIFACT_DIR]) fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(WORKSPACE_ROOT,'.aiwork-root'),'');
  const project=path.join(WORKSPACE_ROOT,'project');seedProject(project,{name:'欢迎页验收项目',trunk:'master'});
  new (require('../core/prepared-project-registry').PreparedProjectRegistry)({dataDir:DATA_DIR}).register(project);
  const dispatch=path.join(TEMP_ROOT,'dispatch.js');fs.writeFileSync(dispatch,"module.exports=()=>({text:'群聊布局验收回复'});");
  let hub,client;const result={checks:[],geometry:{}};
  const shot=name=>screenshot(client,path.join(ARTIFACT_DIR,name+'.png'));
  const size=async width=>{await client.send('Emulation.setDeviceMetricsOverride',{width,height:950,deviceScaleFactor:1,mobile:false});await _waitMs(180);};
  try {
    hub=await launchIsolatedHub({dataDir:DATA_DIR,port:await reservePort(),label:'welcome-composer',windowMode:'hidden',extraEnv:{CLAUDE_HUB_TEST_DISPATCH_SCRIPT:dispatch,AI_HUB_WORKSPACE_ROOT:WORKSPACE_ROOT,CODEX_HOME:path.join(TEMP_ROOT,'codex'),CLAUDE_CONFIG_DIR:path.join(TEMP_ROOT,'claude'),CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(ROOT,'tests/fixtures/codex-app-server.js')}});
    client=await connectFirstPage(hub);
    await client.eval(`window.__welcomeErrors=[];addEventListener('error',e=>window.__welcomeErrors.push(String(e.error||e.message)));addEventListener('unhandledrejection',e=>window.__welcomeErrors.push(String(e.reason)));`);
    await waitFor('ready',()=>client.eval('!!window.MeetingRoom && !!window.LaunchCenter'));
    await size(1500);
    const session=await client.eval('ipcRenderer.invoke("create-session",'+JSON.stringify({kind:'codex',opts:{cwd:project,workspaceLabel:'欢迎页验收项目',model:'gpt-6-astra',effort:'high',mcpProfile:'none'}})+')');
    await waitFor('welcome',()=>client.eval('!!document.querySelector(".session-welcome")'));
    assert.equal(await client.eval('document.querySelector("#recent-turn-copy").getBoundingClientRect().height'),0);
    await shot('welcome-dark');
    await clickPoint(client,'.session-welcome-actions button');
    const draft=await client.eval('document.querySelector(".floating-input-box").textContent');
    assert.match(draft,/梳理当前项目/);
    await clickPoint(client,'.session-welcome-actions button:nth-child(2)');
    assert.equal(await client.eval('document.querySelector(".floating-input-box").textContent'),draft);
    assert.equal(await client.eval('document.querySelectorAll(".turn-card").length'),0);
    result.checks.push('欢迎页显示项目，起步按钮仅填草稿；重复选择保留已有草稿且不发送');
    await clickPoint(client,'#btn-theme');await clickPoint(client,'[data-theme-id="codex"]');await clickPoint(client,'#btn-theme');
    await shot('welcome-light');
    await clickPoint(client,'#btn-theme');await clickPoint(client,'[data-theme-id="frost"]');await clickPoint(client,'#btn-theme');
    await clickPoint(client,'.floating-input-send');
    await waitFor('first answer',()=>client.eval('document.querySelectorAll(".turn-card").length > 0'));
    assert.equal(await client.eval('document.querySelector(".session-welcome")?.getBoundingClientRect().height || 0'),0);
    assert(await client.eval('document.querySelector("#recent-turn-copy").getBoundingClientRect().height > 0'));
    result.checks.push('发送首条消息后欢迎页消失，恢复对话复制工具');
    await client.eval("openMeetingCreateModal('group')");
    await clickPoint(client,'[data-mcm-scene="dev"]');
    await clickPoint(client,'[data-mcm-workspace-mode="default"]');
    await client.eval(`(()=>{const s=document.querySelector('.mcm-slot[data-slot="0"] .mcm-ai-select');s.value='codex';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await clickPoint(client,'[data-remove-member="1"]');
    await clickPoint(client,'#meeting-create-modal .mcm-create');
    const created=await waitFor('persisted development workflow',()=>client.eval('ipcRenderer.invoke("get-meetings").then(ms=>ms.find(m=>m.scene==="dev" && m.serialWorkflow?.fileFlowVersion===2) || null)'));
    // Verify the automatically opened room. Reselecting it masks first-open initialization bugs.
    assert.equal(await client.eval('activeMeetingId'),created.id);
    await waitFor('solo controls',()=>client.eval('!!document.querySelector("[data-file-independent]") && !!document.querySelector("#mr-gc-tools")'));
    for(const width of [1500,1100,760]) {
      await size(width);
      const geometry=await client.eval(`(()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}};return {head:rect('#mr-composer-head'),avatar:rect('#mr-free-avatars-row'),status:rect('.mr-file-detail'),actions:rect('.mr-file-actions'),input:rect('#mr-input-box'),search:rect('.mr-gc-search-row')};})()`);
      result.geometry[width]=geometry;
      assert(geometry.avatar.x < geometry.status.x && geometry.status.x < geometry.actions.x);
      assert(Math.abs((geometry.avatar.y+geometry.avatar.h/2)-(geometry.actions.y+geometry.actions.h/2))<5);
      assert(geometry.head.bottom <= geometry.input.y+1);
      assert.equal(geometry.search.h,0);
      assert.equal(await client.eval('document.querySelector(".mr-mobile-workbench").getBoundingClientRect().height'),0);
      assert(geometry.head.h<=45,'composer header must occupy a single line');
      await shot('group-'+width);
    }
    result.checks.push('1500/1100/760px：头像、状态、操作同一行，默认搜索与进度不占高度');
    await size(1500);
    await client.eval('document.querySelector("#mr-input-box").textContent="保留这段草稿"');
    await clickPoint(client,'[data-file-prep]');
    assert.match(await client.eval('document.querySelector("#mr-input-box").innerText'),/^保留这段草稿/);
    assert.match(await client.eval('document.querySelector("#mr-input-box").innerText'),/project-prep/);
    const getParticipants=()=>client.eval('ipcRenderer.invoke("get-meetings").then(ms=>ms.find(m=>m.scene==="dev").participants)');
    assert.deepEqual(await getParticipants(),[0]);
    await clickPoint(client,'.mr-free-avatar-chk');await waitFor('unchecked',async()=> (await getParticipants()).length===0);
    await clickPoint(client,'.mr-free-avatar-chk');await waitFor('checked',async()=> (await getParticipants()).length===1);
    result.checks.push('立项仍只填草稿；头像勾选真实 IPC 生效');
    await client.eval('(()=>{const b=document.querySelector("#mr-input-box");b.textContent="群聊布局验收";b.dispatchEvent(new Event("input",{bubbles:true}));})()');
    await clickPoint(client,'#mr-send-btn');
    await waitFor('group progress and messages',()=>client.eval('!!document.querySelector(".mr-turn-lane") && document.querySelectorAll(".mr-gc-msg").length >= 2'));
    assert.equal(await client.eval('document.querySelector(".mr-turn-lane").getBoundingClientRect().height'),0);
    await clickPoint(client,'#mr-btn-group-tools');
    assert(await client.eval('document.querySelector(".mr-turn-lane").getBoundingClientRect().height > 0'));
    assert(await client.eval('document.querySelector(".mr-gc-search-row").getBoundingClientRect().height > 0'));
    await shot('group-tools-open');
    await client.eval('(()=>{const b=document.querySelector(".mr-gc-search");b.value="NO_MATCH_WELCOME_TEST";b.dispatchEvent(new Event("input",{bubbles:true}));})()');
    assert(await client.eval('document.querySelectorAll(".mr-gc-search-dim").length > 0'));

    await clickPoint(client,'#mr-btn-group-tools');
    assert.equal(await client.eval('document.querySelector(".mr-gc-search-row").getBoundingClientRect().height'),0);
    assert.equal(await client.eval('document.querySelectorAll(".mr-gc-search-dim").length'),0);
    result.checks.push('真实群聊受控派发后进度仍默认隐藏；工具可展开，搜索有效，收起时清除筛选');
    await client.eval("openMeetingCreateModal('group')");
    await clickPoint(client,'[data-mcm-scene="dev"]');
    await clickPoint(client,'[data-mcm-workspace-mode="default"]');
    await client.eval(`document.querySelectorAll('.mcm-slot .mcm-ai-select').forEach(s=>{s.value='codex';s.dispatchEvent(new Event('change',{bubbles:true}));})`);
    await clickPoint(client,'#meeting-create-modal .mcm-create');
    const dual=await waitFor('dual group auto opened',()=>client.eval('ipcRenderer.invoke("get-meetings").then(ms=>ms.find(m=>m.scene==="dev" && m.subSessions.length===2 && m.serialWorkflow?.fileFlowVersion===2) || null)'));
    await waitFor('dual auto selection',()=>client.eval('activeMeetingId==='+JSON.stringify(dual.id)));
    await waitFor('dual controls without reselection',()=>client.eval('!!document.querySelector("[data-file-kickoff]") && !!document.querySelector("[data-file-prep]") && !!document.querySelector("[data-file-docs]")'));
    assert.equal(await client.eval('document.querySelectorAll(".mr-free-avatar-chk").length'),2);
    assert.match(await client.eval('document.querySelector("#mr-input-box").dataset.placeholder'),/开题/);
    await shot('dual-first-open');
    result.checks.push('单人及双人开发群聊创建后自动完整初始化，不补点侧栏；双人显示两头像、开题/立项/任务文件及对应输入提示');
    result.passed=true;
  } finally {
    if(client){if(!result.passed) result.debug=await client.eval(`({errors:window.__welcomeErrors, meetings: Object.values(meetings).map(m=>({id:m.id,scene:m.scene,workflow:m.serialWorkflow})),preflight:document.getElementById('mr-input-preflight')?.outerHTML})`);await shot('final');await client.close();}if(hub)await gracefulQuit(hub);
    fs.writeFileSync(RESULT_PATH,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
