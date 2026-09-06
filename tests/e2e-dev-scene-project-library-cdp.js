'use strict';
/**
 * 真机回归：建群弹窗的「项目库」下拉 + 开发场景允许留在默认工作目录。
 *
 * 起一个隔离 Hub（独立 data dir / home / 工作根 / CDP 端口），工作根里预置：
 *   - prepared-甲：整理过的项目（.git 目录 + .agents/project.json name=测试项目甲）
 *   - prepared-乙：整理过、但 git 活动时间更早
 *   - linked-worktree：.git 是文件的 worktree，必须不出现在项目库
 *   - raw-repo：没整理过的仓库，必须不出现
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
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'dev-scene-project-library');
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
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  // 平铺工作根标记：让「默认工作目录」= 工作根本身（flat）
  fs.writeFileSync(path.join(WORKSPACE_ROOT, '.aiwork-root'), '', 'utf-8');
  const JIA = path.join(WORKSPACE_ROOT, 'prepared-jia');
  const YI = path.join(WORKSPACE_ROOT, 'prepared-yi');
  seedProject(JIA, { name: '测试项目甲', trunk: 'master' });
  seedProject(YI, { name: '测试项目乙', trunk: 'main' }, { gitTime: new Date(2021, 0, 1) });
  seedProject(path.join(WORKSPACE_ROOT, 'linked-worktree'), { name: '测试项目甲' }, { linked: true });
  seedProject(path.join(WORKSPACE_ROOT, 'raw-repo'), null);

  const port = await reservePort();
  let hub = null;
  let client = null;
  const result = { runId: RUN_ID, port, screenshots: { open: SHOT_OPEN, picked: SHOT_PICKED } };

  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'dev-scene-project-library',
      windowMode: 'hidden',
      extraEnv: {
        AI_HUB_WORKSPACE_ROOT: WORKSPACE_ROOT,
        CLAUDE_HUB_E2E: '1',
        CLAUDE_HUB_HOME_DIR: HOME_DIR,
        DEEPSEEK_API_KEY: '',
      },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url || ''));
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
    await waitFor('launch center shell', () => client.eval(`Boolean(window.LaunchCenter && window.WorkspaceController && window.openMeetingCreateModal)`));
    await client.eval(`(() => {
      window.__errs = [];
      window.addEventListener('error', e => window.__errs.push(String(e.error || e.message)));
      window.addEventListener('unhandledrejection', e => window.__errs.push(String(e.reason)));
    })()`);

    // 0. 主进程接口本身：只列整理过的主工作树，甲（刚建）排在乙（2021）前面
    result.ipc = await client.eval(`(async () => await require('electron').ipcRenderer.invoke('workspace:prepared-projects'))()`);
    const names = result.ipc.items.map(i => i.name);
    assert.deepEqual(names, ['测试项目甲', '测试项目乙'], `项目库应只含两个整理过的项目且按活跃排序，实得 ${JSON.stringify(names)}`);
    assert.ok(!result.ipc.items.some(i => /linked-worktree|raw-repo/.test(i.path)), 'worktree / 未整理仓库不能混入');

    // 1. 打开群聊建群面板
    await clickPoint(client, '#btn-new');
    await clickPoint(client, '[data-launch-intent="group"]');
    await waitFor('group panel', () => client.eval(`document.querySelector('#launch-center-group-host .mcm-embedded .mcm-slots')?.children.length === 2`));

    // 2. 选开发场景：档位必须留在「默认工作目录」，说明要提到两条路
    await clickPoint(client, '[data-mcm-scene="dev"]');
    await _waitMs(150);
    result.afterDev = await client.eval(`(() => ({
      scene: document.querySelector('input[name="mcm-scene"]:checked')?.value,
      workspaceMode: document.querySelector('#meeting-create-modal .mcm-workspace-choice.selected')?.dataset.mcmWorkspaceMode,
      hint: document.getElementById('mcm-scene-hint')?.textContent || '',
      existingHidden: document.getElementById('mcm-workspace-existing')?.hidden,
    }))()`);
    assert.equal(result.afterDev.scene, 'dev');
    assert.equal(result.afterDev.workspaceMode, 'default', '开发场景不再强制切到「选择已有路径」');
    assert.equal(result.afterDev.existingHidden, true);
    assert.match(result.afterDev.hint, /默认工作目录/);
    assert.match(result.afterDev.hint, /项目库/);

    // 3. 点「选择已有路径」：项目库自动展开，列出中文名 + 路径，且没有弹系统对话框
    await clickPoint(client, '[data-mcm-workspace-mode="existing"]');
    result.libraryOpen = await waitFor('project library expanded', () => client.eval(`(() => {
      const list = document.getElementById('mcm-project-library');
      if (!list || list.hidden) return null;
      const items = [...list.querySelectorAll('[data-mcm-project-path]')];
      if (!items.length) return null;
      return {
        expanded: document.getElementById('mcm-project-library-button')?.getAttribute('aria-expanded'),
        buttonText: document.getElementById('mcm-project-library-button')?.textContent,
        items: items.map(b => ({ name: b.querySelector('strong')?.textContent, path: b.dataset.mcmProjectPath, when: b.querySelector('span')?.textContent || '' })),
        pathText: document.getElementById('mcm-workspace-path')?.textContent,
      };
    })()`));
    assert.equal(result.libraryOpen.expanded, 'true');
    assert.deepEqual(result.libraryOpen.items.map(i => i.name), ['测试项目甲', '测试项目乙']);
    assert.equal(result.libraryOpen.pathText, '尚未选择', '展开列表本身不应改变选择');
    await screenshot(client, SHOT_OPEN);

    // 4. 点第一项：路径回显，库收起，档位是 existing
    await clickPoint(client, '#mcm-project-library [data-mcm-project-path]');
    result.picked = await waitFor('project picked', () => client.eval(`(() => {
      const pathEl = document.getElementById('mcm-workspace-path');
      if (!pathEl || pathEl.textContent === '尚未选择') return null;
      return {
        pathText: pathEl.textContent,
        title: pathEl.title,
        libraryHidden: document.getElementById('mcm-project-library')?.hidden,
        expanded: document.getElementById('mcm-project-library-button')?.getAttribute('aria-expanded'),
        workspaceMode: document.querySelector('#meeting-create-modal .mcm-workspace-choice.selected')?.dataset.mcmWorkspaceMode,
        error: document.querySelector('#meeting-create-modal .mcm-error')?.textContent || '',
      };
    })()`));
    assert.equal(result.picked.workspaceMode, 'existing');
    assert.equal(result.picked.libraryHidden, true, '点选后列表要收起');
    assert.equal(result.picked.expanded, 'false');
    assert.equal(path.resolve(result.picked.title).toLowerCase(), path.resolve(JIA).toLowerCase(), '回显的完整路径要是甲的项目根');
    assert.equal(result.picked.error, '');
    await screenshot(client, SHOT_PICKED);

    // 5. 再点「项目库」按钮：重新展开，且当前项高亮
    await clickPoint(client, '#mcm-project-library-button');
    result.reopen = await waitFor('library reopened', () => client.eval(`(() => {
      const list = document.getElementById('mcm-project-library');
      if (!list || list.hidden) return null;
      const sel = list.querySelector('[data-mcm-project-path].selected strong')?.textContent;
      return { selected: sel };
    })()`));
    assert.equal(result.reopen.selected, '测试项目甲');

    result.rendererErrors = await client.eval(`window.__errs`);
    assert.deepEqual(result.rendererErrors, [], '过程中不许有 renderer 错误');

    result.ok = true;
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf-8');
    console.log('[e2e-dev-scene-project-library] PASS');
    console.log(JSON.stringify({ items: result.libraryOpen.items, picked: result.picked.pathText, screenshots: result.screenshots }, null, 2));
  } finally {
    if (client) { try { await client.close(); } catch (e) { /* ignore */ } }
    if (hub) await gracefulQuit(hub, { allowAlreadyExited: true });
  }
}

main().catch(error => {
  console.error('[e2e-dev-scene-project-library] FAIL', error && error.stack || error);
  process.exit(1);
});
