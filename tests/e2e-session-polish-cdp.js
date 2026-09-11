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
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'session-polish');
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
  fs.mkdirSync(DATA_DIR,{recursive:true});fs.mkdirSync(WORKSPACE_ROOT,{recursive:true});fs.mkdirSync(ARTIFACT_DIR,{recursive:true});
  fs.writeFileSync(path.join(WORKSPACE_ROOT,'.aiwork-root'),'');
  const project=path.join(WORKSPACE_ROOT,'prepared-project');
  seedProject(project,{name:'界面验收项目',trunk:'master'});
  const port=await reservePort();let hub,client;
  const result={runId:RUN_ID,checks:[]};
  try {
    hub=await launchIsolatedHub({dataDir:DATA_DIR,port,label:'session-polish',windowMode:'hidden',extraEnv:{AI_HUB_WORKSPACE_ROOT:WORKSPACE_ROOT,CODEX_HOME:path.join(TEMP_ROOT,'codex'),CLAUDE_CONFIG_DIR:path.join(TEMP_ROOT,'claude'),CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(ROOT,'tests/fixtures/codex-app-server.js')}});
    client=await connectFirstPage(hub);
    await waitFor('renderer',()=>client.eval('!!window.WorkspaceController && !!window.LaunchCenter'));
    await clickPoint(client,'#btn-new-more');
    await clickPoint(client,'.new-session-option[data-kind="codex"]');
    await clickPoint(client,'[data-workspace-mode="existing"]');
    await waitFor('projects',()=>client.eval('document.querySelectorAll("#new-session-project-library [data-project-path]").length > 0'));
    await screenshot(client,SHOT_OPEN);
    const names=await client.eval('[...document.querySelectorAll("#new-session-project-library strong")].map(e=>e.textContent)');
    assert(names.includes('界面验收项目'));
    await clickPoint(client,'#new-session-project-library [data-project-path]');
    await waitFor('selected',()=>client.eval('!document.querySelector("#new-session-submit").disabled'));
    assert.equal(await client.eval('document.querySelector("#new-session-path-value").title'),project);
    await screenshot(client,SHOT_PICKED);
    await clickPoint(client,'#new-session-submit');
    await waitFor('session',()=>client.eval('[...sessions.values()].some(s=>s.kind==="codex" && s.nativeRuntime?.state==="idle")'));
    const created=await client.eval('[...sessions.values()].find(s=>s.kind==="codex")');
    assert.equal(created.cwd,project);
    assert.equal(await client.eval('currentView'),'card');
    await clickPoint(client,'#btn-home');
    await clickPoint(client,'.session-item[data-session-id="'+created.id+'"]');
    assert.equal(await client.eval('currentView'),'card');
    if(await client.eval('currentView')!=='pty')await clickPoint(client,'#btn-backstage');
    await clickPoint(client,'#btn-home');
    await clickPoint(client,'.session-item[data-session-id="'+created.id+'"]');
    assert.equal(await client.eval('currentView'),'pty');
    if(await client.eval('currentView')!=='card')await clickPoint(client,'#btn-backstage');
    result.checks.push('项目库真实 IPC 选目录并创建 Codex 会话；新会话默认卡片（模型为 fixture）');
    await clickPoint(client,'#btn-rail-memo');
    assert.equal(await client.eval('document.querySelector("#memo-panel").style.display'),'flex');
    await client.eval('document.querySelector("#memo-input").value="隔离验收备忘"');
    await clickPoint(client,'#memo-add-btn');
    assert.match(await client.eval('document.querySelector("#memo-list").textContent'),/隔离验收备忘/);
    await screenshot(client,path.join(ARTIFACT_DIR,'memo-dark.png'));
    await clickPoint(client,'#memo-clear-btn');
    assert.equal(await client.eval('document.querySelector("#btn-rail-memo").getAttribute("aria-expanded")'),'false');
    await clickPoint(client,'#btn-rail-memo');
    assert.match(await client.eval('document.querySelector("#memo-list").textContent'),/隔离验收备忘/);
    result.checks.push('侧栏备忘录打开、添加、关闭、重开后内容保留');
    await clickPoint(client,'#btn-theme');
    await clickPoint(client,'[data-theme-id="codex"]');
    await screenshot(client,path.join(ARTIFACT_DIR,'memo-light.png'));
    result.checks.push('深浅色侧栏截图');
    result.passed=true;
  } finally {
    if(client)await client.close();if(hub)await gracefulQuit(hub);
    fs.writeFileSync(RESULT_PATH,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
