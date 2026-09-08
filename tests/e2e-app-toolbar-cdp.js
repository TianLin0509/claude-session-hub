'use strict';
// T6 冷杉 v2 · 统一工具栏的真实验证。
//
// 单测守的是源码契约（节点顺序、drag 标记、逃生口写没写）。这条守的是**跑起来
// 之后**是不是真那样，而且守的都是单测证明不了的东西：
//   - 窗口到底还有没有原生标题栏（BrowserWindow 的实际状态，不是源码里的字面量）
//   - 工具栏是不是真顶到窗口第 0 行、右端有没有给系统按钮留出空位
//   - 拖动区：可点的东西必须全在 no-drag 里，少一个就是「点了没反应」
//   - 切到主页 / 开发视图时面包屑变视图名、动作区收起来
//   - 双击工具栏空白处能最大化 / 还原；最大化时顶部有没有那条 8px 空隙
//   - 换皮肤时窗口按钮区颜色跟着走
//   - CLAUDE_HUB_NATIVE_TITLEBAR=1 起一个第二实例，确认原生标题栏真回来了
//
// 跑法：node tests/e2e-app-toolbar-cdp.js
// 起的是隔离实例（CLAUDE_HUB_DATA_DIR + CLAUDE_HUB_HOME_DIR），不碰生产 Hub。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');
const { hitTestScreenPoint, hitName } = require('./helpers/native-hit-test.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-app-toolbar-${RUN_ID}`);
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'app-toolbar');
const NORMAL_SHOT = path.join(ARTIFACT_DIR, 'T6-toolbar-normal.png');
const MAXIMIZED_SHOT = path.join(ARTIFACT_DIR, 'T6-toolbar-maximized.png');
const HOME_SHOT = path.join(ARTIFACT_DIR, 'T6-toolbar-home.png');
const RESULT_PATH = path.join(ARTIFACT_DIR, `result-${RUN_ID}.json`);

const SESSION_ID = 'app-toolbar-e2e';
const SESSION_CWD = path.join(TEMP_ROOT, 'workspaces', '冷杉工具栏验证');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitFor(label, fn, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { lastError = error; }
    await _waitMs(120);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function screenshot(client, target) {
  const image = await client.send('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: false,
  });
  fs.writeFileSync(target, Buffer.from(image.data, 'base64'));
}

// 工具栏在页面坐标系里的实况。刻意**不**用 CDP 改设备尺寸：这条用例量的是
// 窗口几何（工具栏顶不顶到第 0 行、右端留了多宽），模拟视口会让页面坐标和
// 真实窗口对不上，量出来的就不是用户看到的那个布局。
const TOOLBAR_PROBE = `(() => {
  const toolbar = document.getElementById('app-toolbar');
  const container = document.getElementById('app-container');
  const crumb = document.getElementById('toolbar-crumb');
  const actions = document.getElementById('toolbar-actions');
  const controls = document.getElementById('toolbar-window-controls');
  const rectOf = el => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  };
  const visible = el => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const dragOf = el => el ? getComputedStyle(el).webkitAppRegion : '';
  return {
    present: !!toolbar,
    rect: rectOf(toolbar),
    // 工具栏必须是窗口第 0 行：上面再压任何东西，「隐藏标题栏」就白做了。
    atWindowTop: !!toolbar && Math.round(toolbar.getBoundingClientRect().top) === 0,
    height: toolbar ? Math.round(toolbar.getBoundingClientRect().height) : 0,
    order: toolbar ? Array.from(toolbar.children).map(c => c.id || c.className) : [],
    drag: {
      toolbar: dragOf(toolbar),
      buttons: toolbar
        ? Array.from(toolbar.querySelectorAll('button')).filter(visible).map(b => ({
            cls: b.className, region: dragOf(b),
          }))
        : [],
      viewToggle: dragOf(toolbar && toolbar.querySelector('.view-toggle')),
      // 只查 button 是不够的（2026-09-08 评审逮到的洞）：会话标题是个可点击的
      // <span>，漏在拖动区里之后 Windows 把它判成标题栏，真鼠标点下去是拖窗口，
      // 重命名永远打不开；而 DOM 的 .click() 不走命中测试，照样能打开重命名，
      // 所以只用 dispatchEvent 的断言看不见它。
      // 判据换成「看起来可不可点」：cursor:pointer 的元素，往上找到第一个
      // 声明了拖动区的祖先，那个祖先必须是 no-drag。
      clickableInDragRegion: toolbar
        ? Array.from(toolbar.querySelectorAll('*')).filter(el => {
            if (!visible(el)) return false;
            if (getComputedStyle(el).cursor !== 'pointer') return false;
            for (let node = el; node && node !== toolbar.parentElement; node = node.parentElement) {
              const region = getComputedStyle(node).webkitAppRegion;
              if (region === 'no-drag') return false;
              if (region === 'drag') return true;
            }
            return true;
          }).map(el => el.tagName + '.' + (typeof el.className === 'string' ? el.className : el.id))
        : [],
    },
    windowControls: {
      width: Math.round((rectOf(controls) || { width: 0 }).width),
      // 留位必须真的空着：任何可见控件伸进这一段，就会被系统三键压住。
      clearOfActions: (() => {
        const a = rectOf(actions);
        const c = rectOf(controls);
        return !a || !c || a.right <= c.left + 1;
      })(),
      flushToRight: (() => {
        const c = rectOf(controls);
        const t = rectOf(toolbar);
        return !!c && !!t && Math.round(t.right - c.right) <= 12;
      })(),
      _rects: { controls: rectOf(controls), toolbar: rectOf(toolbar), actions: rectOf(actions) },
    },
    crumb: {
      mode: crumb ? crumb.dataset.mode : '',
      text: crumb ? crumb.textContent.replace(/\\s+/g, ' ').trim() : '',
      viewName: crumb ? (crumb.querySelector('.crumb-view-name')?.textContent || '') : '',
    },
    actionsHidden: !!actions && actions.hidden,
    // 只数顶层四个：⋯ 的溢出菜单也在这个容器里，连菜单项一起数就成了 8。
    actionButtons: actions ? actions.children.length : 0,
    sidebarToggleVisible: visible(document.getElementById('btn-expand-sidebar')),
    sidebarCollapsed: !!container && container.classList.contains('sidebar-collapsed'),
    maximized: !!container && container.classList.contains('window-maximized'),
    nativeTitleBarClass: !!container && container.classList.contains('native-titlebar'),
    // 舞台里不许再有头部；终端体自己就是卡的上沿。
    stageHeader: document.querySelectorAll('#terminal-panel .terminal-header').length,
    termHeaderVar: getComputedStyle(document.getElementById('terminal-panel'))
      .getPropertyValue('--term-header-h').trim(),
    theme: document.documentElement.getAttribute('data-theme') || '',
  };
})()`;

async function main() {
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  fs.mkdirSync(SESSION_CWD, { recursive: true });
  fs.writeFileSync(path.join(SESSION_CWD, 'README.md'), '# 冷杉工具栏验证\n');
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const port = await reservePort();
  let hub = null;
  let client = null;
  let nativeHub = null;
  let nativeClient = null;
  const result = {
    runId: RUN_ID,
    port,
    screenshots: { normal: NORMAL_SHOT, maximized: MAXIMIZED_SHOT, home: HOME_SHOT },
  };

  try {
    hub = await launchIsolatedHub({
      dataDir: path.join(TEMP_ROOT, 'data'),
      port,
      extraEnv: {
        CLAUDE_HUB_E2E: '1',
        CLAUDE_HUB_HOME_DIR: path.join(TEMP_ROOT, 'home'),
        AI_HUB_WORKSPACE_ROOT: path.join(TEMP_ROOT, 'workspaces'),
        DEEPSEEK_API_KEY: '',
      },
    });
    client = await connectFirstPage(
      hub,
      target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url || ''),
    );
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Page.bringToFront');
    await waitFor('renderer shell', () => client.eval('!!(window.__hubE2E && window.LaunchCenter)'));

    // ── 验收 1：窗口真的没有原生标题栏 ────────────────────────────────
    // 这条只能问主进程：页面里看不出自己上面有没有一条系统标题栏。
    result.windowShape = await client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const remote = await ipcRenderer.invoke('debug:window-shape').catch(() => null);
      return remote;
    })()`);

    // ── 验收 2：主页状态 ─────────────────────────────────────────────
    result.home = await client.eval(TOOLBAR_PROBE);
    await screenshot(client, HOME_SHOT);
    assert.equal(result.home.present, true, '#app-toolbar 必须存在');
    assert.equal(result.home.atWindowTop, true, '工具栏必须是窗口第 0 行');
    assert.equal(result.home.height, 44, '工具栏 44px，实际 ' + result.home.height);
    assert.deepEqual(result.home.order, [
      'btn-expand-sidebar', 'toolbar-crumb', 'view-toggle', 'toolbar-actions', 'toolbar-window-controls',
    ], JSON.stringify(result.home.order));
    assert.equal(result.home.crumb.viewName, '主页', '主页视图下面包屑显示视图名');
    assert.equal(result.home.crumb.mode, 'view');
    assert.equal(result.home.actionsHidden, true, '主页没有会话可操作，动作区必须收起');
    assert.equal(result.home.sidebarToggleVisible, true, '侧栏开关常驻');
    assert.equal(result.home.nativeTitleBarClass, false, '默认不是原生标题栏模式');

    // ── 验收 3：拖动区 ──────────────────────────────────────────────
    assert.equal(result.home.drag.toolbar, 'drag', '整条工具栏可拖窗口');
    const draggableButtons = result.home.drag.buttons.filter(b => b.region !== 'no-drag');
    assert.deepEqual(draggableButtons, [],
      '工具栏里的按钮必须全是 no-drag，否则它连 click 都收不到：' + JSON.stringify(draggableButtons));
    assert.equal(result.home.drag.viewToggle, 'no-drag');
    assert.deepEqual(result.home.drag.clickableInDragRegion, [],
      '这些元素看起来可点却落在拖动区里，真鼠标点下去会变成拖窗口：'
      + JSON.stringify(result.home.drag.clickableInDragRegion));

    // ── 验收 4：右端给系统窗口按钮留位 ────────────────────────────────
    // 常量默认 138px；WCO 报得出真值时按真值走（本机实测 136px，随 DPI 和
    // Windows 版本会差几像素）。所以断言的是「落在合理区间」而不是某个定值 ——
    // 钉死一个数只会在换台机器时红，而那时红的并不是这条设计。
    assert.ok(result.home.windowControls.width >= 100 && result.home.windowControls.width <= 220,
      '系统按钮留位要在合理区间，实际 ' + result.home.windowControls.width);
    assert.equal(result.home.windowControls.flushToRight, true,
      '留位必须贴在工具栏最右端：' + JSON.stringify(result.home.windowControls._rects));
    assert.equal(result.home.windowControls.clearOfActions, true, '留位里不许伸进任何可见控件');

    // ── 验收 5：开一个会话，面包屑与动作区跟着换 ──────────────────────
    await client.eval(`(() => {
      const id = ${JSON.stringify(SESSION_ID)};
      sessions.set(id, {
        id, kind: 'codex', title: '工具栏会话验证', status: 'idle',
        createdAt: Date.now(), lastMessageTime: Date.now(), unreadCount: 0,
        cwd: ${JSON.stringify(SESSION_CWD)}, workspaceLabel: '冷杉工具栏验证',
        currentModel: { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-SOL' },
        effort: 'max', codexSpeedTier: 'fast', contextPct: 23, contextUsed: 74000, apiMs: 61000,
        lastCompletedAt: Date.now() - 45000,
      });
      activeMeetingId = null;
      activeSessionId = id;
      currentView = 'pty';
      showTerminal(id, { focus: false });
      _cardHistoryHydratedSid = id;
      applyViewMode('card');
      updateFloatingBarState();
      return true;
    })()`);
    await _waitMs(600);
    result.session = await client.eval(TOOLBAR_PROBE);
    await screenshot(client, NORMAL_SHOT);
    assert.equal(result.session.crumb.mode, 'session');
    assert.match(result.session.crumb.text, /^冷杉工具栏验证›工具栏会话验证/,
      '面包屑是「工作区 › 会话标题」；间距由 CSS gap 给，textContent 里本来就没空格');
    assert.equal(result.session.actionsHidden, false, '会话视图下动作区必须出现');
    assert.equal(result.session.actionButtons, 4, '文件 / 记忆 / ⋯ / 关闭会话');
    assert.equal(result.session.stageHeader, 0, '舞台里不许再有头部');
    assert.equal(result.session.termHeaderVar, '0px',
      '舞台没有头部了，卡片层的让位量必须是 0，实际 ' + result.session.termHeaderVar);
    assert.equal(result.session.atWindowTop, true);
    assert.equal(result.session.height, 44);
    assert.equal(result.session.windowControls.clearOfActions, true,
      '动作区不许伸进系统按钮那一段');
    // 会话标题只在会话视图下才存在，所以这条必须在这里再查一遍 ——
    // 只在主页查等于永远查不到它。
    assert.deepEqual(result.session.drag.clickableInDragRegion, [],
      '会话视图下这些元素看起来可点却落在拖动区里：'
      + JSON.stringify(result.session.drag.clickableInDragRegion));

    // ── 验收 5b：原生命中测试 ────────────────────────────────────────
    // 这是本轮评审逮到的洞：CDP 的 element.click() 绕过 Windows 命中测试，
    // 一个漏标 no-drag 的可点元素在 DOM 测试里表现完全正常，真鼠标点下去
    // 却是「按住标题栏拖窗口」。所以可点元素必须问 Windows 要答案：
    // 标题、工作区按钮、动作按钮都得答 HTCLIENT(1)，工具栏空白处答 HTCAPTION(2)。
    result.nativeHits = {};
    const probePoints = await client.eval(`(() => {
      const pick = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return null;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      };
      const toolbar = document.getElementById('app-toolbar').getBoundingClientRect();
      const crumb = document.getElementById('toolbar-crumb').getBoundingClientRect();
      const controls = document.getElementById('toolbar-window-controls').getBoundingClientRect();
      return {
        // 页面坐标 → 屏幕坐标：window.screenX/Y 是窗口左上角在屏幕上的位置，
        // 加上页面视口相对窗口的偏移（outerHeight - innerHeight 就是被隐藏的
        // 标题栏 + 边框；隐藏标题栏之后这个值很小，但不能假设它是 0）。
        origin: {
          x: window.screenX + (window.outerWidth - window.innerWidth) / 2,
          y: window.screenY + (window.outerHeight - window.innerHeight),
        },
        title: pick('#toolbar-crumb .terminal-title'),
        workspace: pick('#toolbar-crumb .crumb-workspace'),
        closeBtn: pick('#toolbar-actions .btn-close-session'),
        // 空白处：面包屑右边、居中视图切换左边那一段，它**应该**是可拖的标题栏。
        blank: (() => {
          const toggle = document.querySelector('#app-toolbar .view-toggle').getBoundingClientRect();
          return { x: (crumb.right + toggle.left) / 2, y: toolbar.top + toolbar.height / 2 };
        })(),
      };
    })()`);
    const hubWindowTitle = result.windowShape && result.windowShape.title;
    for (const [name, point] of Object.entries(probePoints)) {
      if (name === 'origin' || !point) continue;
      const code = hitTestScreenPoint(
        hubWindowTitle,
        probePoints.origin.x + point.x,
        probePoints.origin.y + point.y,
      );
      result.nativeHits[name] = { code, name: hitName(code) };
    }
    // 拿不到窗口句柄（窗口被隐藏之类）时如实跳过，不假装验过。
    if (result.nativeHits.title && result.nativeHits.title.code !== null) {
      assert.equal(result.nativeHits.title.code, 1,
        '会话标题必须落在客户区（HTCLIENT=1），落进标题栏就点不开重命名了，实际 '
        + result.nativeHits.title.name);
      assert.equal(result.nativeHits.workspace.code, 1,
        '面包屑工作区按钮同上，实际 ' + result.nativeHits.workspace.name);
      assert.equal(result.nativeHits.closeBtn.code, 1,
        '关闭会话按钮同上，实际 ' + result.nativeHits.closeBtn.name);
      assert.equal(result.nativeHits.blank.code, 2,
        '工具栏空白处必须仍然是可拖的标题栏（HTCAPTION=2），实际 '
        + result.nativeHits.blank.name);
    } else {
      result.nativeHits.skipped = '拿不到窗口句柄，本次没有做原生命中测试';
    }

    // 原生命中测试要起 PowerShell 子进程，前台焦点会被抢走；窗口一旦被压到
    // 后台，requestAnimationFrame 就会被节流甚至暂停，而工具栏的重画正是挂在
    // rAF 上的。这里把窗口拉回前台再往下走 —— 这是测试环境的副作用，
    // 不是产品缺陷（用户看不见的时候不重画，切回来自然会补上）。
    await client.send('Page.bringToFront');
    await _waitMs(300);

    // ── 验收 6：切回主页，面包屑与动作区收回去 ────────────────────────
    await client.eval(`(() => { document.getElementById('btn-home').click(); return true; })()`);
    result.backHome = await waitFor('back to home', async () => {
      const state = await client.eval(TOOLBAR_PROBE);
      return state.crumb.mode === 'view' ? state : null;
    });
    assert.equal(result.backHome.crumb.viewName, '主页');
    assert.equal(result.backHome.actionsHidden, true);

    // ── 验收 7：切到开发视图显示视图名 ───────────────────────────────
    await client.eval(`(() => {
      const btn = document.getElementById('btn-ran') || document.querySelector('[data-view-target="ran"]');
      if (btn) { btn.click(); return true; }
      // 没有按钮就直接把面板显出来 —— 这条验收要的是「面板可见时面包屑说什么」。
      const panel = document.getElementById('ran-panel');
      if (panel) { panel.style.display = 'flex'; panel.style.minHeight = '200px'; }
      return true;
    })()`);
    result.devView = await waitFor('dev view crumb', async () => {
      const state = await client.eval(TOOLBAR_PROBE);
      return state.crumb.viewName === '开发' ? state : null;
    }, 8000);
    assert.equal(result.devView.actionsHidden, true, '开发视图下动作区必须收起');

    // ── 验收 8：侧栏开关两个方向都点得动 ──────────────────────────────
    const before = await client.eval(TOOLBAR_PROBE);
    await client.eval(`document.getElementById('btn-expand-sidebar').click()`);
    await _waitMs(400);
    const after = await client.eval(TOOLBAR_PROBE);
    assert.notEqual(after.sidebarCollapsed, before.sidebarCollapsed, '侧栏开关要真能切换');
    await client.eval(`document.getElementById('btn-expand-sidebar').click()`);
    await _waitMs(400);
    result.sidebar = { before: before.sidebarCollapsed, after: after.sidebarCollapsed };

    // ── 验收 9：双击工具栏空白处最大化 / 还原 ─────────────────────────
    // 双击是个**开关**，所以先读初始状态再断言它翻转 —— 隔离实例起来时窗口
    // 可能本来就是最大化的（本机实测就是），假设它从「非最大化」开始，
    // 测出来的会是「双击没反应」，而实际上它老老实实地还原了一次。
    await client.eval(`(() => { document.getElementById('btn-home').click(); return true; })()`);
    await _waitMs(400);
    const dblclickToolbar = `(() => {
      const toolbar = document.getElementById('app-toolbar');
      const rect = toolbar.getBoundingClientRect();
      // 空白处 = 面包屑右边、居中的视图切换左边那一段。
      const x = rect.left + rect.width * 0.32;
      const y = rect.top + rect.height / 2;
      toolbar.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true, clientX: x, clientY: y, detail: 2,
      }));
      return true;
    })()`;
    const readMaximized = async () => (await client.eval(TOOLBAR_PROBE)).maximized;

    const startedMaximized = await readMaximized();
    await client.eval(dblclickToolbar);
    result.toggledOnce = await waitFor('双击工具栏翻转窗口状态', async () => {
      const now = await readMaximized();
      return now !== startedMaximized ? { from: startedMaximized, to: now } : null;
    }, 8000);

    // 走到「最大化」这一态，量顶部有没有那条 8px 空隙并截图。
    if (!(await readMaximized())) {
      await client.eval(dblclickToolbar);
      await waitFor('再双击一次进入最大化', async () => (await readMaximized()) === true, 8000);
    }
    result.maximized = await client.eval(TOOLBAR_PROBE);
    await screenshot(client, MAXIMIZED_SHOT);
    // 「最大化时工具栏顶部无 8px 空隙」量的就是这一条。
    assert.equal(result.maximized.atWindowTop, true,
      '最大化时工具栏仍要顶到第 0 行（Windows 边框补偿），实际 '
      + JSON.stringify(result.maximized.rect));
    assert.equal(result.maximized.height, 44, '最大化不该让工具栏变高');
    assert.equal(result.maximized.windowControls.flushToRight, true);

    // 还原，别把窗口留在最大化态影响后面的用例。
    await client.eval(dblclickToolbar);
    result.restored = await waitFor('还原', async () => {
      const state = await client.eval(TOOLBAR_PROBE);
      return state.maximized === false ? state : null;
    }, 8000);
    assert.equal(result.restored.atWindowTop, true, '还原后工具栏仍顶到第 0 行');

    // ── 验收 10：换皮肤时窗口按钮区颜色跟着走 ─────────────────────────
    result.themeSync = await client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const seen = [];
      for (const theme of ['claude', 'dark']) {
        document.documentElement.setAttribute('data-theme', theme);
        await new Promise(r => setTimeout(r, 250));
        const shape = await ipcRenderer.invoke('debug:window-shape').catch(() => null);
        seen.push({ theme, overlay: shape && shape.overlay });
      }
      return seen;
    })()`);
    assert.equal(result.themeSync.length, 2);
    const [light, dark] = result.themeSync;
    assert.ok(light.overlay && dark.overlay, '主进程要记下自己最后应用的 overlay 颜色');
    assert.notEqual(light.overlay.color, dark.overlay.color,
      '换皮肤时窗口按钮区底色必须跟着变：' + JSON.stringify(result.themeSync));

    result.errors = await client.eval('window.__appToolbarErrors || []');

    // ── 验收 11：逃生口 ──────────────────────────────────────────────
    // 单独起一个实例，CLAUDE_HUB_NATIVE_TITLEBAR=1，确认原生标题栏真回来了，
    // 而且工具栏本身照常工作（它不依赖无边框窗口）。
    const nativePort = await reservePort();
    nativeHub = await launchIsolatedHub({
      dataDir: path.join(TEMP_ROOT, 'data-native'),
      port: nativePort,
      extraEnv: {
        CLAUDE_HUB_E2E: '1',
        CLAUDE_HUB_NATIVE_TITLEBAR: '1',
        CLAUDE_HUB_HOME_DIR: path.join(TEMP_ROOT, 'home-native'),
        AI_HUB_WORKSPACE_ROOT: path.join(TEMP_ROOT, 'workspaces'),
        DEEPSEEK_API_KEY: '',
      },
    });
    nativeClient = await connectFirstPage(
      nativeHub,
      target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url || ''),
    );
    await nativeClient.send('Runtime.enable');
    await waitFor('native shell', () => nativeClient.eval('!!(window.__hubE2E && window.LaunchCenter)'));
    result.native = await nativeClient.eval(TOOLBAR_PROBE);
    result.nativeShape = await nativeClient.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('debug:window-shape').catch(() => null);
    })()`);
    assert.equal(result.native.present, true, '逃生口打开时工具栏仍在');
    assert.equal(result.native.nativeTitleBarClass, true, '渲染层要知道自己在原生标题栏模式');
    assert.equal(result.native.height, 44);
    assert.equal(result.native.windowControls.width, 0,
      '原生模式下系统按钮在真标题栏里，顶栏不该再留位');
    assert.equal(result.native.drag.toolbar, 'no-drag',
      '原生模式下拖动交给真标题栏');
    assert.equal(result.nativeShape && result.nativeShape.nativeTitleBar, true);

    // ── 窗口标题：任务栏与 PID 识别依赖它，一个字都不许变 ─────────────
    for (const [label, shape] of [['默认', result.windowShape], ['逃生口', result.nativeShape]]) {
      assert.ok(shape, `${label}模式拿不到窗口信息`);
      assert.match(shape.title, /^AI 群聊 Hub：PID \d+ v\d+\.\d+\.\d+$/,
        `${label}模式的窗口标题被改了：${shape.title}`);
    }
    assert.equal(result.windowShape.nativeTitleBar, false);

    assert.deepEqual(result.errors, [], '渲染过程不许有未捕获错误');
    result.ok = true;
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify({
      ok: true,
      toolbarHeight: result.home.height,
      order: result.home.order,
      windowControlsW: result.home.windowControls.width,
      homeCrumb: result.home.crumb.viewName,
      sessionCrumb: result.session.crumb.text,
      devCrumb: result.devView.crumb.viewName,
      maximizedTop: result.maximized.rect.top,
      themeOverlay: result.themeSync.map(t => `${t.theme}:${t.overlay && t.overlay.color}`),
      nativeEscape: {
        toolbar: result.native.present,
        controlsWidth: result.native.windowControls.width,
        nativeTitleBar: result.nativeShape.nativeTitleBar,
      },
      title: result.windowShape.title,
      nativeHits: result.nativeHits,
      screenshots: result.screenshots,
    }, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    if (hub) console.error(hub.log().slice(-40).join('\n'));
    process.exitCode = 1;
  } finally {
    if (nativeClient) { try { await nativeClient.close(); } catch {} }
    if (nativeHub) { try { await gracefulQuit(nativeHub); } catch {} }
    if (client) { try { await client.close(); } catch {} }
    if (hub) { try { await gracefulQuit(hub); } catch {} }
  }
}

main();
