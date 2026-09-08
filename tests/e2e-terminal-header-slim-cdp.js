'use strict';
// T2 冷杉 v2 · 舞台头部瘦身的真实渲染验证。
//
// 单测守的是源码契约（哪些节点不许再出现），这条守的是**画出来之后**是不是真那样：
//   - 头部里到底剩几个可见控件，DOM 里还有没有那三个被删的类
//   - 面包屑点工作区能不能真打开文件面板，点标题能不能真进重命名
//   - 状态点的颜色是不是跟着 runtime truth 走（就绪 → 工作中）
//   - ⋯ 菜单里的完成通知开关切完之后，隐藏的浮层节点状态跟着变
//   - 卡片视图与 PTY 视图下，模型名与工作目录在舞台上各出现几次（必须是 0）
//
// 跑法：node tests/e2e-terminal-header-slim-cdp.js
// 起的是隔离实例（CLAUDE_HUB_DATA_DIR + CLAUDE_HUB_HOME_DIR），不碰生产 Hub。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-header-slim-${RUN_ID}`);
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'header-slim');
const CARD_SHOT = path.join(ARTIFACT_DIR, 'T2-header-slim-card.png');
const PTY_SHOT = path.join(ARTIFACT_DIR, 'T2-header-slim-pty.png');
const MENU_SHOT = path.join(ARTIFACT_DIR, 'T2-more-menu.png');
const RESULT_PATH = path.join(ARTIFACT_DIR, `result-${RUN_ID}.json`);

const SESSION_ID = 'header-slim-e2e';
const SESSION_CWD = path.join(TEMP_ROOT, 'workspaces', '冷杉舞台验证');
const MODEL_ID = 'gpt-5.6-sol';
const MODEL_NAME = 'GPT-5.6-SOL';

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

// 舞台上「模型名 / 工作目录出现几次」要连 title、aria-label 一起数 —— 只看
// textContent 会漏掉 tooltip 里那一份，而 tooltip 也是用户看得见的。
// 面包屑的 cwd tooltip 是本卡刻意保留的一处，所以按节点分类计数而不是一刀切。
const STAGE_PROBE = `(() => {
  const panel = document.getElementById('terminal-panel');
  const header = panel.querySelector('.terminal-header');
  const crumb = panel.querySelector('.terminal-crumb');
  const dot = panel.querySelector('.terminal-crumb-dot');
  const metrics = panel.querySelector('.terminal-metrics');
  const footer = document.getElementById('card-session-status');
  const rectOf = element => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  };
  const visible = element => {
    if (!element) return false;
    const r = element.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(element).visibility !== 'hidden';
  };
  const modelNeedle = ${JSON.stringify(MODEL_NAME)};
  const cwdNeedle = ${JSON.stringify(SESSION_CWD)};
  const countIn = (needle, nodes) => nodes.reduce((total, node) => {
    if (!node) return total;
    const haystack = [node.textContent || '', node.title || '', node.getAttribute('aria-label') || ''].join('\\u0000');
    return total + (haystack.includes(needle) ? 1 : 0);
  }, 0);
  // 状态行 + 覆盖层 + 头部动作区：这三处不许再出现模型名或目录。
  const stageNodes = [footer, metrics, panel.querySelector('.terminal-header-actions')];
  return {
    headerHeight: header ? Math.round(header.getBoundingClientRect().height) : 0,
    headerChildren: header ? Array.from(header.children).map(child => child.className) : [],
    headerControls: header
      ? Array.from(header.querySelectorAll('button')).filter(visible).map(b => b.className)
      : [],
    removed: {
      status: document.querySelectorAll('.terminal-status').length,
      modelBadge: document.querySelectorAll('.terminal-model-badge').length,
      metricCwd: document.querySelectorAll('.metric-cwd').length,
      metricsRow: document.querySelectorAll('.terminal-metrics-row').length,
    },
    crumb: {
      workspaceText: crumb?.querySelector('.crumb-workspace')?.textContent || '',
      workspaceTitle: crumb?.querySelector('.crumb-workspace')?.title || '',
      sep: crumb?.querySelector('.crumb-sep')?.textContent || '',
      titleText: crumb?.querySelector('.terminal-title')?.textContent || '',
      crumbTitle: crumb?.title || '',
      order: crumb ? Array.from(crumb.children).map(child => child.className.split(' ')[0]) : [],
    },
    dot: {
      state: dot?.dataset.runtimeState || null,
      title: dot?.title || '',
      size: Math.round(dot?.getBoundingClientRect().width || 0),
      color: dot ? getComputedStyle(dot).backgroundColor : '',
    },
    metrics: {
      text: metrics?.textContent || '',
      visible: visible(metrics),
      insideStage: (() => {
        const m = rectOf(metrics); const p = rectOf(panel);
        return !!m && !!p && m.right <= p.right + 1 && m.top >= p.top;
      })(),
    },
    viewToggle: {
      inHeader: !!header?.querySelector(':scope > .view-toggle'),
      visible: visible(panel.querySelector('.view-toggle')),
      active: panel.querySelector('.view-toggle-btn.active')?.dataset.view || '',
      // 「中央」= 分段控件的中线对齐头部的中线，允许 1px 取整误差。
      centerOffset: (() => {
        const t = rectOf(panel.querySelector('.view-toggle'));
        const h = rectOf(header);
        return !t || !h ? null : Math.round((t.left + t.right) / 2 - (h.left + h.right) / 2);
      })(),
      overlapsCrumb: (() => {
        const t = rectOf(panel.querySelector('.view-toggle'));
        const c = rectOf(crumb);
        return !!t && !!c && c.right > t.left;
      })(),
      overlapsActions: (() => {
        const t = rectOf(panel.querySelector('.view-toggle'));
        const a = rectOf(panel.querySelector('.terminal-header-actions'));
        return !!t && !!a && a.left < t.right;
      })(),
    },
    // 动作区必须贴着头部右边缘，不能跟在面包屑后面。
    actionsFlushRight: (() => {
      const a = rectOf(panel.querySelector('.terminal-header-actions'));
      const h = rectOf(header);
      return !!a && !!h && Math.round(h.right - a.right) <= 12;
    })(),
    // 头部 band 里不许再有别的浮层压着（「复制对话」原来就压在这条 band 上）。
    headerBandIntruders: (() => {
      const h = rectOf(header);
      if (!h) return [];
      return ['recent-turn-copy', 'card-multi-select-bar', 'completion-notification-toggle']
        .map(id => document.getElementById(id))
        .filter(node => {
          if (!node || !visible(node)) return false;
          const r = rectOf(node);
          return r.top < h.bottom && r.bottom > h.top;
        })
        .map(node => node.id);
    })(),
    notification: {
      hiddenOnStage: getComputedStyle(document.getElementById('completion-notification-toggle')).display === 'none',
      state: document.getElementById('completion-notification-toggle')?.dataset.state || '',
    },
    footerText: footer?.textContent?.replace(/\\s+/g, ' ').trim() || '',
    modelMentions: countIn(modelNeedle, stageNodes),
    cwdMentions: countIn(cwdNeedle, stageNodes),
    // 面包屑那一处 cwd tooltip 是本卡明确要保留的，单独报出来。
    crumbCwdTooltip: (crumb?.title || '') === cwdNeedle,
    composerModel: document.querySelector('.floating-input-bar .composer-model .composer-chip-label')?.textContent || '',
    stageCard: (() => {
      const p = rectOf(panel);
      const host = document.getElementById('app-container');
      const h = rectOf(host);
      const style = getComputedStyle(panel);
      return {
        marginTop: style.marginTop,
        marginRight: style.marginRight,
        headerRadius: header ? getComputedStyle(header).borderTopLeftRadius : '',
        containerRadius: getComputedStyle(panel.querySelector('.terminal-container')).borderBottomLeftRadius,
        insideHost: !!p && !!h && p.right <= h.right && p.top >= h.top,
      };
    })(),
  };
})()`;

async function main() {
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  fs.mkdirSync(SESSION_CWD, { recursive: true });
  fs.writeFileSync(path.join(SESSION_CWD, 'README.md'), '# 冷杉舞台验证\n');
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const port = await reservePort();
  let hub = null;
  let client = null;
  const result = { runId: RUN_ID, port, screenshots: { card: CARD_SHOT, pty: PTY_SHOT, menu: MENU_SHOT } };
  let lastShellProbe = null;

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
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await waitFor('renderer shell', async () => {
      const probe = await client.eval(`(() => ({
        hubE2E: !!window.__hubE2E,
        launchCenter: !!window.LaunchCenter,
        showTerminal: typeof showTerminal,
        bootError: window.__bootError || null,
      }))()`);
      if (!probe.hubE2E || !probe.launchCenter) {
        lastShellProbe = probe;
        throw new Error('shell not ready: ' + JSON.stringify(probe));
      }
      return probe;
    });
    await client.eval(`(() => {
      window.__headerSlimErrors = [];
      window.addEventListener('error', e => window.__headerSlimErrors.push(String(e.error || e.message)));
      window.addEventListener('unhandledrejection', e => window.__headerSlimErrors.push(String(e.reason)));
    })()`);

    // 一个"已就绪"的 Codex 会话：模型、思考档、上下文、API 用时都给齐，
    // 这样头部该显示什么、不该显示什么才有得可看。
    await client.eval(`(() => {
      const id = ${JSON.stringify(SESSION_ID)};
      const completedAt = Date.now() - 90 * 1000;
      sessions.set(id, {
        id,
        kind: 'codex',
        title: '冷杉舞台头部验证',
        status: 'idle',
        createdAt: completedAt - 60000,
        lastMessageTime: completedAt,
        unreadCount: 0,
        cwd: ${JSON.stringify(SESSION_CWD)},
        workspaceLabel: '冷杉舞台验证',
        currentModel: { id: ${JSON.stringify(MODEL_ID)}, displayName: ${JSON.stringify(MODEL_NAME)} },
        effort: 'max',
        codexSpeedTier: 'fast',
        contextPct: 41,
        contextUsed: 128400,
        apiMs: 154000,
        lastCompletedAt: completedAt,
      });
      observeSessionRuntime(id, {
        state: 'completed',
        source: 'codex-turn-complete',
        confidence: 'authoritative',
        observedAt: completedAt,
        completedAt,
        startedAt: completedAt - 30000,
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

    result.card = await client.eval(STAGE_PROBE);
    await screenshot(client, CARD_SHOT);

    // ── 验收 1：头部只剩面包屑 + 视图切换 + 四个动作 ──────────────────
    assert.deepEqual(result.card.removed, { status: 0, modelBadge: 0, metricCwd: 0, metricsRow: 0 },
      '被删的三个节点不许还在 DOM 里：' + JSON.stringify(result.card.removed));
    assert.equal(result.card.headerChildren.length, 3,
      '头部只能有三块：面包屑 / 视图切换 / 动作区，实际 ' + JSON.stringify(result.card.headerChildren));
    assert.ok(result.card.headerChildren[0].includes('terminal-crumb'));
    assert.ok(result.card.headerChildren[1].includes('view-toggle'));
    assert.ok(result.card.headerChildren[2].includes('terminal-header-actions'));
    assert.equal(result.card.headerHeight, 44, '头部单行 44px，实际 ' + result.card.headerHeight);
    assert.equal(Math.abs(result.card.viewToggle.centerOffset) <= 1, true,
      '视图切换要落在头部中线上，偏移 ' + result.card.viewToggle.centerOffset);
    assert.equal(result.card.viewToggle.overlapsCrumb, false, '面包屑不许顶到视图切换上');
    assert.equal(result.card.viewToggle.overlapsActions, false, '动作区不许压在视图切换上');
    assert.equal(result.card.actionsFlushRight, true, '动作区必须贴头部右边缘');
    assert.deepEqual(result.card.headerBandIntruders, [],
      '头部那条 44px band 里不许还有别的浮层：' + JSON.stringify(result.card.headerBandIntruders));
    // 可见按钮 = 卡片 / PTY 两个切换 + 文件 / 记忆 / ⋯ / × 四个动作 + 面包屑工作区
    assert.equal(result.card.headerControls.length, 7, JSON.stringify(result.card.headerControls));

    // ── 验收 2：面包屑结构 ────────────────────────────────────────────
    assert.deepEqual(result.card.crumb.order, ['crumb-workspace', 'crumb-sep', 'terminal-title', 'terminal-crumb-dot']);
    assert.equal(result.card.crumb.workspaceText, '冷杉舞台验证');
    assert.equal(result.card.crumb.titleText, '冷杉舞台头部验证');
    assert.equal(result.card.crumb.sep, '›');
    assert.equal(result.card.crumbCwdTooltip, true, '整条面包屑 hover 要给完整 cwd');
    assert.match(result.card.crumb.workspaceTitle, /^文件管理 · /);

    // ── 验收 3：模型名与工作目录在舞台上出现 0 次 ─────────────────────
    assert.equal(result.card.modelMentions, 0, '卡片视图下模型名不许出现在状态行/覆盖层/动作区');
    assert.equal(result.card.cwdMentions, 0, '卡片视图下工作目录同上');
    assert.equal(result.card.composerModel, MODEL_NAME, '模型名的唯一落点是 composer 的 chip');
    assert.doesNotMatch(result.card.footerText, /gpt-5\.6-sol/i);
    assert.match(result.card.footerText, /^max·fast·Context 59% left$/);

    // ── 验收 4：实时量覆盖层 ──────────────────────────────────────────
    assert.equal(result.card.metrics.visible, true, '卡片视图下覆盖层必须可见');
    assert.equal(result.card.metrics.text, 'ctx 41% · 128k tok · ⏱ 2m34s');
    assert.equal(result.card.metrics.insideStage, true);

    // ── 验收 5：舞台卡 ────────────────────────────────────────────────
    assert.equal(result.card.stageCard.marginTop, '10px');
    assert.equal(result.card.stageCard.marginRight, '12px');
    assert.equal(result.card.stageCard.headerRadius, '12px');
    assert.equal(result.card.stageCard.containerRadius, '12px');
    assert.equal(result.card.stageCard.insideHost, true);
    assert.equal(result.card.notification.hiddenOnStage, true, '完成通知浮层在舞台上必须隐藏');

    // ── 验收 6：状态点跟着 runtime truth 变色（就绪 → 工作中）────────
    assert.equal(result.card.dot.state, 'completed');
    assert.equal(result.card.dot.size, 6, '状态点 6px');
    assert.match(result.card.dot.title, /^已完成/);
    const readyColor = result.card.dot.color;
    await client.eval(`(() => {
      observeSessionRuntime(${JSON.stringify(SESSION_ID)}, {
        state: 'running',
        source: 'pty-codex-interrupt-footer',
        confidence: 'strong',
        observedAt: Date.now(),
        startedAt: Date.now() - 38000,
        evidence: '• Working (0m 38s • esc to interrupt)',
      });
      updateFloatingBarState();
      return true;
    })()`);
    result.working = await waitFor('dot turns to running', async () => {
      const state = await client.eval(STAGE_PROBE);
      return state.dot.state === 'running' ? state : null;
    });
    assert.notEqual(result.working.dot.color, readyColor, '就绪 → 工作中 必须换颜色');
    assert.match(result.working.dot.title, /^工作中/);

    // ── 验收 7：面包屑点工作区打开文件面板 ────────────────────────────
    await client.eval(`document.querySelector('.terminal-crumb .crumb-workspace').click()`);
    result.filePanel = await waitFor('crumb opens file panel', () => client.eval(`(() => {
      const panel = document.getElementById('file-manager-panel');
      if (!panel || panel.style.display !== 'flex') return null;
      return { display: panel.style.display, root: document.getElementById('file-manager-root-path')?.textContent || '' };
    })()`));
    assert.equal(result.filePanel.root, SESSION_CWD);
    await client.eval(`document.querySelector('.terminal-crumb .crumb-workspace').click()`);
    await _waitMs(250);

    // ── 验收 8：面包屑点标题进重命名 ──────────────────────────────────
    await client.eval(`document.querySelector('.terminal-crumb .terminal-title').click()`);
    result.rename = await waitFor('title click starts rename', () => client.eval(
      `!!document.querySelector('.terminal-crumb .terminal-title-input') || !!document.querySelector('.terminal-title-input')`,
    ));
    await client.eval(`(() => {
      const input = document.querySelector('.terminal-title-input');
      if (input) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return true;
    })()`);
    await _waitMs(250);

    // ── 验收 9：⋯ 菜单能切完成通知，状态与隐藏浮层一致 ────────────────
    await client.eval(`document.querySelector('.terminal-header-actions .header-overflow-wrap .btn-zoom').click()`);
    await _waitMs(200);
    result.menu = await client.eval(`(() => {
      const menu = document.querySelector('.terminal-header .header-overflow-menu');
      const notify = menu?.querySelector('.ho-notify');
      return {
        open: !!menu && menu.style.display === 'block',
        items: menu ? Array.from(menu.children).map(b => b.textContent) : [],
        notifyState: notify?.dataset.state || '',
        notifyChecked: notify?.getAttribute('aria-checked') || '',
        notifyMirrorsToggle:
          notify?.dataset.state === document.getElementById('completion-notification-toggle').dataset.state,
      };
    })()`);
    assert.equal(result.menu.open, true);
    assert.equal(result.menu.items.length, 4, JSON.stringify(result.menu.items));
    assert.ok(result.menu.items.some(text => text.startsWith('完成通知')), JSON.stringify(result.menu.items));
    assert.equal(result.menu.notifyMirrorsToggle, true, '菜单项必须镜像浮层节点的状态');
    await screenshot(client, MENU_SHOT);

    // ── 验收 10：PTY 视图下同样成立 ──────────────────────────────────
    await client.eval(`(() => {
      document.body.click();
      applyViewMode('pty');
      return true;
    })()`);
    await _waitMs(500);
    result.pty = await client.eval(STAGE_PROBE);
    await screenshot(client, PTY_SHOT);
    assert.equal(result.pty.viewToggle.active, 'pty');
    assert.equal(result.pty.viewToggle.inHeader, true, 'PTY 视图下视图切换仍在头部里');
    assert.deepEqual(result.pty.removed, { status: 0, modelBadge: 0, metricCwd: 0, metricsRow: 0 });
    assert.equal(result.pty.metrics.visible, true, 'PTY 视图下覆盖层同样显示');
    assert.equal(result.pty.metrics.text, result.card.metrics.text);
    assert.equal(result.pty.modelMentions, 0);
    assert.equal(result.pty.cwdMentions, 0);
    assert.equal(result.pty.headerHeight, 44);

    // ── 验收 11：菜单项只转发点击 ────────────────────────────────────
    // 未配置飞书时 completion-notification-toggle 的既有行为就是打开设置弹窗，
    // 菜单项走的是同一条路 —— 所以这一步放在最后做，免得弹窗盖住前面的截图。
    await client.eval(`document.querySelector('.terminal-header-actions .header-overflow-wrap .btn-zoom').click()`);
    await _waitMs(200);
    await client.eval(`document.querySelector('.terminal-header .header-overflow-menu .ho-notify').click()`);
    await _waitMs(500);
    result.notifyClick = await client.eval(`(() => ({
      menuClosed: document.querySelector('.terminal-header .header-overflow-menu')?.style.display === 'none',
      toggleState: document.getElementById('completion-notification-toggle').dataset.state,
      // 设置弹窗就是 #config-modal，关掉时挂 .hidden。
      anyModalOpen: !document.getElementById('config-modal')?.classList.contains('hidden'),
    }))()`);
    assert.equal(result.notifyClick.menuClosed, true, '点完菜单项要收起菜单');
    assert.equal(result.notifyClick.anyModalOpen, true,
      '未配置飞书时应转发到设置弹窗（与原浮层按钮行为一致）');

    // ── 回归 A：主进程改了 workspaceLabel，面包屑要跟着变 ──────────────
    // 首轮结束后 main 会给会话起一个真实的工作区标签（原来在临时区叫别的名字），
    // 通过 session-updated 推下来。T2 之前这个标签长在 metrics 的目录 chip 上，
    // 由 updateActiveMetricsRow 刷新；搬进面包屑之后必须有人刷新面包屑，
    // 否则用户看到的一直是首轮之前那个旧名字。
    await client.eval(`(() => {
      const { ipcRenderer } = require('electron');
      ipcRenderer.emit('session-updated', {}, {
        session: {
          id: ${JSON.stringify(SESSION_ID)},
          workspaceLabel: '归档后的正式项目',
        },
      });
      return true;
    })()`);
    await _waitMs(400);
    result.labelRefresh = await client.eval(STAGE_PROBE);
    assert.equal(result.labelRefresh.crumb.workspaceText, '归档后的正式项目',
      '主进程更新工作区标签后，面包屑必须跟着刷新');

    // ── 回归 B：上下文未知时不许说 ctx 0% ────────────────────────────
    // 会话刚起来、或者 CLI 状态栏还没读到占比时，contextPct 是 null。
    // Number(null) === 0，一不小心就把「不知道」显示成一个确定的零 —— 那是
    // 比不显示更糟的错误：用户会以为上下文还空着。
    await client.eval(`(() => {
      const session = sessions.get(${JSON.stringify(SESSION_ID)});
      session.contextPct = null;
      session.contextUsed = null;
      updateActiveMetricsRow();
      return true;
    })()`);
    await _waitMs(250);
    result.unknownContext = await client.eval(STAGE_PROBE);
    assert.doesNotMatch(result.unknownContext.metrics.text, /ctx/,
      '上下文未知时覆盖层不许出现 ctx 字样，实际：' + result.unknownContext.metrics.text);
    assert.match(result.unknownContext.metrics.text, /^⏱ /,
      '其它实时量照常显示，实际：' + result.unknownContext.metrics.text);
    // 把状态还原，后面的用例仍按原来的数据跑。
    await client.eval(`(() => {
      const session = sessions.get(${JSON.stringify(SESSION_ID)});
      session.contextPct = 41;
      session.contextUsed = 128400;
      updateActiveMetricsRow();
      return true;
    })()`);

    // ── 验收 12：切会话之后视图切换还在头部里 ────────────────────────
    // 这个节点是 index.html 里静态声明的那一个，showTerminal 每次都要把它从
    // preserveAndClearTerminalPanel 手里接过来重新挂进新头部。历史上 spec 1/2
    // 的浮层就是在这条路径上「关一次会话就永远消失」的。
    await client.eval(`(() => {
      const id = 'header-slim-e2e-2';
      sessions.set(id, {
        id, kind: 'claude', title: '第二个会话', status: 'idle',
        createdAt: Date.now(), lastMessageTime: Date.now(), unreadCount: 0,
        cwd: ${JSON.stringify(ROOT)}, workspaceLabel: '第二工作区',
        currentModel: { id: 'claude-opus-5', displayName: 'Opus 5' },
        effort: 'max', contextPct: 12,
      });
      activeSessionId = id;
      showTerminal(id, { focus: false });
      applyViewMode('card');
      updateFloatingBarState();
      return true;
    })()`);
    await _waitMs(500);
    result.switched = await client.eval(STAGE_PROBE);
    assert.equal(result.switched.viewToggle.inHeader, true, '切会话后视图切换必须还在头部里');
    assert.equal(result.switched.viewToggle.visible, true);
    assert.equal(result.switched.crumb.workspaceText, '第二工作区');
    assert.equal(result.switched.crumb.titleText, '第二个会话');
    assert.deepEqual(result.switched.headerBandIntruders, []);
    assert.equal(result.switched.headerChildren.length, 3);

    // ── 验收 13：回主页不受影响 ─────────────────────────────────────
    // 舞台卡的外距与「隐藏完成通知」两条规则都刻意排除了 .home-active。
    // 主页用的是同一个通知节点（homeWorkbench.render 会把它搬进 #home-notification-slot），
    // 规则写宽一格就会让它在主页上凭空消失。
    await client.eval(`(() => {
      const modal = document.getElementById('config-modal');
      if (modal) modal.classList.add('hidden');
      document.getElementById('btn-home').click();
      return true;
    })()`);
    await _waitMs(700);
    result.home = await client.eval(`(() => {
      const panel = document.getElementById('terminal-panel');
      const toggle = document.getElementById('completion-notification-toggle');
      const style = getComputedStyle(panel);
      return {
        homeActive: panel.classList.contains('home-active'),
        marginTop: style.marginTop,
        marginRight: style.marginRight,
        toggleVisible: getComputedStyle(toggle).display !== 'none',
        toggleInHomeSlot: toggle.parentElement?.id === 'home-notification-slot',
      };
    })()`);
    assert.equal(result.home.homeActive, true);
    assert.equal(result.home.marginTop, '0px', '主页不套舞台卡外距');
    assert.equal(result.home.marginRight, '0px');
    assert.equal(result.home.toggleVisible, true, '主页的完成通知开关必须还看得见');

    result.errors = await client.eval('window.__headerSlimErrors || []');
    assert.deepEqual(result.errors, [], '渲染过程不许有未捕获错误');

    result.ok = true;
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify({
      ok: true,
      headerHeight: result.card.headerHeight,
      headerControls: result.card.headerControls.length,
      metrics: result.card.metrics.text,
      footer: result.card.footerText,
      dotReady: result.card.dot.color,
      dotWorking: result.working.dot.color,
      menuItems: result.menu.items,
      screenshots: result.screenshots,
    }, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    if (hub) console.error(hub.log().slice(-60).join('\n'));
    process.exitCode = 1;
  } finally {
    if (client) { try { await client.close(); } catch {} }
    if (hub) { try { await gracefulQuit(hub); } catch {} }
  }
}

main();
