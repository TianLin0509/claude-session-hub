'use strict';

// 新建会话弹窗的三档新选项（fast / 思考强度 / MCP）+ 底部输入框的卡片视图遮挡修复，
// 都在真实 Hub renderer 里量一遍：CSS 变量、实测几何、原生撤销栈，单测替代不了。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

function canListen(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function availablePort(preferred) {
  for (let port = preferred; port < preferred + 50; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error('no free CDP port');
}

(async () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const dataDir = path.join(os.tmpdir(), `claude-session-hub-create-options-${stamp}`);
  const workspaceRoot = path.join(dataDir, 'workspaces');
  const fakeBin = path.join(dataDir, 'fake-bin');
  const codexHome = path.join(dataDir, 'codex-home');
  const invocationLog = path.join(dataDir, 'codex-invocations.jsonl');
  const port = await availablePort(Number(process.env.HUB_CREATE_OPTIONS_E2E_PORT || 19781));
  let hub = null;
  let client = null;
  try {
    for (const directory of [dataDir, workspaceRoot, fakeBin, codexHome]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    const fakeCodex = path.join(fakeBin, 'fake-codex.js');
    fs.writeFileSync(fakeCodex, `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
fs.appendFileSync(process.env.HUB_CREATE_OPTIONS_LOG, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
const now = new Date();
const sid = crypto.randomUUID();
const sessionsDir = path.join(process.env.CODEX_HOME, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
fs.mkdirSync(sessionsDir, { recursive: true });
const rolloutPath = path.join(sessionsDir, 'rollout-' + now.toISOString().replace(/[:.]/g, '-') + '-' + sid + '.jsonl');
const lines = [
  { timestamp: now.toISOString(), type: 'session_meta', payload: { id: sid, timestamp: now.toISOString(), cwd: process.cwd() } },
  { timestamp: now.toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { model_context_window: 828400, last_token_usage: { input_tokens: 1, output_tokens: 1 } } } },
];
fs.writeFileSync(rolloutPath, lines.map(line => JSON.stringify(line)).join('\\n') + '\\n', 'utf8');
process.stdout.write('FAKE_CODEX_READY\\r\\n');
setInterval(() => {}, 1000);
`, 'utf8');
    fs.writeFileSync(
      path.join(fakeBin, 'codex.cmd'),
      `@echo off\r\n"${process.execPath}" "${fakeCodex}" %*\r\n`,
      'utf8',
    );
    fs.writeFileSync(path.join(codexHome, 'config.toml'), [
      'approval_policy = "never"',
      'service_tier = "fast"',
      '',
      '[features]',
      'fast_mode = true',
      '',
      '[mcp_servers.playwright]',
      'command = "npx"',
      '',
      '[mcp_servers.superran]',
      'command = "python"',
      '',
      '[mcp_servers.misc]',
      'command = "node"',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({
      models: [
        {
          slug: 'gpt-5.6-sol',
          default_reasoning_level: 'low',
          supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(effort => ({ effort })),
          additional_speed_tiers: ['fast'],
          context_window: 272000,
          max_context_window: 872000,
          effective_context_window_percent: 95,
        },
        {
          slug: 'gpt-5.5',
          default_reasoning_level: 'medium',
          supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'].map(effort => ({ effort })),
          additional_speed_tiers: ['fast'],
        },
      ],
    }), 'utf8');
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
      providers: {
        codex: {
          backend: 'subscription',
          subscription_profile: 'e2e',
          subscription_profiles: [{ id: 'e2e', label: 'E2E', home: codexHome }],
        },
      },
    }, null, 2), 'utf8');
    const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path';
    hub = await launchIsolatedHub({
      dataDir,
      port,
      label: 'create-options',
      windowMode: 'hidden',
      extraEnv: {
        AI_HUB_WORKSPACE_ROOT: workspaceRoot,
        CODEX_HOME: codexHome,
        HUB_CODEX_PROFILE: 'e2e',
        HUB_CREATE_OPTIONS_LOG: invocationLog,
        [pathKey]: `${fakeBin}${path.delimiter}${process.env[pathKey] || ''}`,
      },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''));

    const readyDeadline = Date.now() + 25000;
    while (Date.now() < readyDeadline) {
      if (await client.eval("!!(window.WorkspaceController && window.FloatingInputHistory && typeof observeTerminalPanelChrome === 'function')")) break;
      await _waitMs(200);
    }

    // ---- 1. 弹窗档位：Claude 与 Codex 各自看到什么 ----
    const tuning = await client.eval(`(async () => {
      const wc = window.WorkspaceController;
      wc.openNewSessionModal();
      // renderer 启动早期 IPC 偶尔超过固定 120ms；显式等模型目录，避免把 fallback
      // 误判成 gpt-5.6-sol 不支持 ultra 的产品回归。
      await wc.loadCodexTuningCatalog();
      await new Promise(r => setTimeout(r, 120));
      const read = () => {
        const opts = id => Array.from(document.getElementById(id).options).map(o => o.value);
        return {
          fastVisible: !document.getElementById('new-session-fast-field').hidden,
          fastChecked: document.getElementById('new-session-fast').checked,
          effortVisible: !document.getElementById('new-session-effort-field').hidden,
          effortValue: document.getElementById('new-session-effort').value,
          effortOptions: opts('new-session-effort'),
          mcpVisible: !document.getElementById('new-session-mcp-field').hidden,
          mcpValue: document.getElementById('new-session-mcp').value,
          mcpOptions: opts('new-session-mcp'),
          codexTierVisible: !document.getElementById('new-session-codex-tier-field').hidden,
          codexTierValue: document.getElementById('new-session-codex-tier').value,
          codexTierOptions: opts('new-session-codex-tier'),
          model: document.getElementById('new-session-model').value,
          note: document.getElementById('new-session-tuning-note').textContent,
        };
      };
      const claude = read();

      // 取消 fast 勾选 → tuningOpts 应带 fastMode:false
      const fast = document.getElementById('new-session-fast');
      fast.checked = false;
      fast.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 60));
      const claudeFastOff = read();

      document.querySelector('.new-session-option[data-kind="codex"]').click();
      await new Promise(r => setTimeout(r, 200));
      const codex = read();

      // 换到只支持到 xhigh 的旧模型，档位表必须跟着缩短。
      const modelSelect = document.getElementById('new-session-model');
      modelSelect.value = 'gpt-5.5';
      modelSelect.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 120));
      const codexOldModel = read();
      modelSelect.value = 'gpt-5.6-sol';
      modelSelect.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 120));
      // 上面的 5.5 兼容性探针会把 max 合法回落成 xhigh；恢复 Sol 后把测试状态
      // 也恢复到默认 max，避免后续“默认 payload”被刻意的模型切换污染。
      const effortSelect = document.getElementById('new-session-effort');
      effortSelect.value = 'max';
      effortSelect.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 60));

      document.querySelector('.new-session-option[data-kind="powershell"]').click();
      await new Promise(r => setTimeout(r, 120));
      const powershell = read();

      document.querySelector('.new-session-option[data-kind="claude"]').click();
      await new Promise(r => setTimeout(r, 120));
      const backToClaude = read();

      wc.closeNewSessionModal();
      return { claude, claudeFastOff, codex, codexOldModel, powershell, backToClaude };
    })()`, { awaitPromise: true });

    if (process.env.HUB_E2E_DEBUG === '1') console.error(JSON.stringify(tuning, null, 2));

    // Claude：fast 开关在、默认勾上；MCP 默认 full（= 改动前的全量继承）
    assert.equal(tuning.claude.fastVisible, true, 'Claude 应显示 fast 开关');
    assert.equal(tuning.claude.fastChecked, true, 'fast 默认开');
    assert.equal(tuning.claude.mcpVisible, true, 'Claude 现在也有 MCP 档位');
    assert.equal(tuning.claude.mcpValue, 'full', 'Claude 默认必须是 full，不能静默改成 lean');
    assert.deepEqual(tuning.claude.effortOptions, ['max', 'xhigh', 'high', 'medium', 'low']);
    assert.equal(tuning.claude.effortValue, 'max');

    // Codex：Claude 那个 fastMode 复选框不出现（机制不同），但必须有自己的
    // service_tier 速度通道 —— 这正是"创建 codex 会话时没有 fast 选项"的修复。
    assert.equal(tuning.codex.fastVisible, false, 'Claude 的 fastMode 复选框不适用于 Codex');
    assert.equal(tuning.codex.codexTierVisible, true, 'Codex 必须有自己的 fast（service_tier）选项');
    assert.equal(tuning.codex.codexTierValue, 'fast', 'Codex 默认必须显式使用 Fast');
    assert.deepEqual(tuning.codex.codexTierOptions, ['standard', 'inherit', 'fast', 'flex']);
    // 思考强度按模型来，档位来自 codex-cli 自己的 models_cache.json。
    assert.equal(tuning.codex.model, 'gpt-5.6-sol');
    assert.equal(tuning.codex.effortOptions.includes('xhigh'), true, 'xhigh 不是 Claude 专属，Codex 每个模型都支持');
    assert.equal(tuning.codex.effortOptions.includes('ultra'), true, 'gpt-5.6-sol 支持比 max 更高的 ultra');
    assert.equal(tuning.codex.effortValue, 'max', 'Codex 默认仍是 max，不静默降精度');
    assert.equal(tuning.codex.mcpValue, 'none', 'Codex 默认不能加载任何 MCP');
    assert.deepEqual(tuning.codex.mcpOptions, ['none', 'lean', 'browser', 'wireless', 'full']);
    assert.match(tuning.codex.note, /Fast/);
    assert.match(tuning.codex.note, /群聊通信/);
    assert.match(tuning.codex.note, /872,000/);
    assert.match(tuning.codex.note, /828,400/);
    // 换成只到 xhigh 的模型，ultra 必须消失，否则会拼出 CLI 不认识的档位。
    assert.equal(tuning.codexOldModel.model, 'gpt-5.5');
    assert.equal(tuning.codexOldModel.effortOptions.includes('ultra'), false, 'gpt-5.5 不支持 ultra');
    assert.equal(tuning.codexOldModel.effortOptions.includes('xhigh'), true);
    assert.equal(
      tuning.codexOldModel.effortValue,
      'xhigh',
      '原来选的 max 在 5.5 上不存在，应回落到该模型支持的最高档而不是拼非法值',
    );

    // PowerShell：三档全部隐藏
    assert.equal(tuning.powershell.fastVisible, false);
    assert.equal(tuning.powershell.effortVisible, false);
    assert.equal(tuning.powershell.mcpVisible, false);
    assert.equal(tuning.powershell.codexTierVisible, false);

    // 切走再切回来要记住上一次的选择（老行为是每次都重置回默认，反复调很烦）
    assert.equal(tuning.backToClaude.fastChecked, false, '切走再切回来应记住用户关过 fast');
    assert.equal(tuning.backToClaude.mcpValue, 'full', 'Claude 的档位不该被 Codex 的 lean 串味');

    // fast 勾着时提示要讲清代价
    assert.match(tuning.claude.note, /transcript/);

    // ---- 2. 真实创建普通 Codex Session：从 GUI 一路量到 PTY argv ----
    const ordinaryCreatePayload = await client.eval(`(() => {
      const wc = window.WorkspaceController;
      wc.openNewSessionModal({ kind: 'codex' });
      const payload = wc.tuningOpts();
      document.getElementById('new-session-submit').click();
      return payload;
    })()`);
    assert.deepEqual(ordinaryCreatePayload, {
      model: 'gpt-5.6-sol',
      effort: 'max',
      mcpProfile: 'none',
      codexSpeedTier: 'fast',
      contextMax: 1_000_000,
    });
    let ordinarySession = null;
    const ordinaryDeadline = Date.now() + 30000;
    while (Date.now() < ordinaryDeadline) {
      ordinarySession = await client.eval(`(async () => {
        const sessions = await require('electron').ipcRenderer.invoke('get-sessions');
        return sessions.find(session => !session.meetingId && session.kind === 'codex') || null;
      })()`, { awaitPromise: true });
      if (ordinarySession && ordinarySession.contextEffectiveMax === 828_400 && fs.existsSync(invocationLog)) break;
      await _waitMs(150);
    }
    assert.ok(ordinarySession, '普通 Codex Session 应由真实创建按钮生成');
    assert.equal(ordinarySession.currentModel.id, 'gpt-5.6-sol');
    assert.equal(ordinarySession.effort, 'max');
    assert.equal(ordinarySession.mcpProfile, 'none');
    assert.equal(ordinarySession.codexSpeedTier, 'fast');
    assert.equal(ordinarySession.contextMax, 1_000_000);
    assert.equal(ordinarySession.contextEffectiveMax, 828_400);
    assert.equal(typeof ordinarySession.contextEffectiveObservedAt, 'number');
    const ordinaryInvocation = fs.readFileSync(invocationLog, 'utf8')
      .trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))[0];
    const ordinaryArgs = ordinaryInvocation.args.join(' ');
    assert.match(ordinaryArgs, /--model gpt-5\.6-sol/);
    assert.match(ordinaryArgs, /model_reasoning_effort=.*max/);
    assert.match(ordinaryArgs, /model_context_window=1000000/);
    assert.match(ordinaryArgs, /features\.fast_mode=true/);
    assert.match(ordinaryArgs, /service_tier=.*fast/);
    assert.doesNotMatch(ordinaryArgs, /service_tier=.*default/);
    for (const name of ['playwright', 'superran', 'misc']) {
      assert.match(ordinaryArgs, new RegExp(`mcp_servers\\.${name}\\.enabled=false`));
    }
    const launchAudit = await client.eval(`require('electron').ipcRenderer.invoke('debug:get-managed-launch-audit', {
      sessionId: ${JSON.stringify(ordinarySession.id)}, limit: 10,
    })`, { awaitPromise: true });
    assert.equal(launchAudit.auditHealth.exists, true);
    assert.equal(launchAudit.auditHealth.malformedLines, 0);
    assert.equal(launchAudit.auditHealth.readError, null);
    assert.ok(launchAudit.persisted.length >= 1, '受管启动必须留下可跨重启取证的脱敏记录');
    const audited = launchAudit.persisted.at(-1);
    assert.match(audited.trigger, /^create-(?:pty-ready|safety-timeout)$/);
    assert.equal(audited.contextRequested, 1_000_000);
    assert.equal(audited.mcpProfile, 'none');
    assert.equal(audited.mcpDisabled, true);
    assert.match(audited.commandSha256, /^[0-9a-f]{64}$/);
    assert.equal(Object.prototype.hasOwnProperty.call(audited, 'command'), false);
    const contextUi = await client.eval(`(() => {
      const el = document.querySelector('.metric-context-window');
      return el ? { text: el.textContent, title: el.title } : null;
    })()`);
    assert.ok(contextUi, '活动 Codex 顶栏必须显示运行时有效窗口');
    assert.match(contextUi.text, /828\.4K/);
    assert.match(contextUi.title, /运行时有效窗口：828,400/);
    assert.match(contextUi.title, /启动请求：1,000,000/);

    // ---- 3. tuningOpts 真正送出去的字段 ----
    const payloads = await client.eval(`(async () => {
      const wc = window.WorkspaceController;
      const grab = async (kind, mutate) => {
        wc.openNewSessionModal({ kind });
        await new Promise(r => setTimeout(r, 120));
        if (mutate) { mutate(); await new Promise(r => setTimeout(r, 60)); }
        const out = wc.tuningOpts();
        wc.closeNewSessionModal();
        return out;
      };
      return {
        // 上一段特意把 fast 关掉过，弹窗会记住 —— 这里先勾回来再验"默认形态"。
        claudeDefault: await grab('claude', () => {
          const f = document.getElementById('new-session-fast');
          f.checked = true; f.dispatchEvent(new Event('change'));
        }),
        claudeFastOff: await grab('claude', () => {
          const f = document.getElementById('new-session-fast');
          f.checked = false; f.dispatchEvent(new Event('change'));
        }),
        claudeLean: await grab('claude', () => {
          const m = document.getElementById('new-session-mcp');
          m.value = 'lean'; m.dispatchEvent(new Event('change'));
        }),
        codexDefault: await grab('codex'),
        codexLowEffort: await grab('codex', () => {
          const e = document.getElementById('new-session-effort');
          e.value = 'low'; e.dispatchEvent(new Event('change'));
        }),
        codexFastTier: await grab('codex', () => {
          const t = document.getElementById('new-session-codex-tier');
          t.value = 'fast'; t.dispatchEvent(new Event('change'));
        }),
        codexInheritTier: await grab('codex', () => {
          const t = document.getElementById('new-session-codex-tier');
          t.value = 'inherit'; t.dispatchEvent(new Event('change'));
        }),
      };
    })()`, { awaitPromise: true });

    // 默认不传 fastMode = 沿用 session-manager 的"默认开"，与改动前逐字一致
    assert.equal('fastMode' in payloads.claudeDefault, false, '默认不该显式传 fastMode');
    assert.equal(payloads.claudeDefault.mcpProfile, 'full');
    assert.equal(payloads.claudeFastOff.fastMode, false);
    assert.equal(payloads.claudeLean.mcpProfile, 'lean');
    assert.deepEqual(payloads.codexDefault, {
      model: 'gpt-5.6-sol',
      effort: 'max',
      mcpProfile: 'none',
      codexSpeedTier: 'fast',
      contextMax: 1_000_000,
    });
    assert.equal(payloads.codexLowEffort.effort, 'low');
    assert.equal(payloads.codexLowEffort.contextMax, 1_000_000);
    assert.equal(payloads.codexFastTier.codexSpeedTier, 'fast', 'Codex 的 fast 要真的送到 create-session');
    // inherit = 不覆盖 ~/.codex/config.toml，等于改动前行为，所以不传这个字段。
    assert.equal('codexSpeedTier' in payloads.codexInheritTier, false);

    // ---- 4. 卡片视图不再遮挡底部输入框 ----
    const layout = await client.eval(`(() => {
      const panel = document.createElement('div');
      panel.className = 'terminal-panel';
      Object.assign(panel.style, { position: 'relative', height: '600px', width: '800px', display: 'flex', flexDirection: 'column' });
      const header = document.createElement('div');
      header.className = 'terminal-header';
      header.textContent = 'header';
      const overlay = document.createElement('div');
      overlay.className = 'msg-overlay';
      // 真实结构里 .terminal-container 是 flex:1，把输入栏顶到面板最底下。
      // 少了它输入栏会贴在 header 下面，几何断言就测不到"是否遮挡"。
      const container = document.createElement('div');
      container.className = 'terminal-container';
      container.style.flex = '1';
      container.style.minHeight = '0';
      const bar = document.createElement('div');
      bar.className = 'floating-input-bar visible';
      // 复刻真实构成：任务预设 chips + 输入框 + 预设预览，能把栏顶到 60px 以上
      const toolbar = document.createElement('div');
      toolbar.className = 'fi-preset-toolbar';
      toolbar.textContent = '任务预设';
      const row = document.createElement('div');
      row.className = 'fi-composer-row';
      const box = document.createElement('div');
      box.className = 'floating-input-box';
      box.contentEditable = 'true';
      box.textContent = ['1','2','3','4','5','6','7','8'].join('\\n');
      row.appendChild(box);
      bar.append(toolbar, row);
      panel.append(header, overlay, container, bar);
      document.body.appendChild(panel);

      const observer = observeTerminalPanelChrome(panel, bar);
      const measure = () => ({
        overlayBottom: Math.round(overlay.getBoundingClientRect().bottom),
        barTop: Math.round(bar.getBoundingClientRect().top),
      });
      const barHeight = Math.round(bar.getBoundingClientRect().height);
      const cssVarBar = panel.style.getPropertyValue('--fi-bar-h');
      const after = measure();

      // 对照组：把变量按回原来写死的 60px，量一下当年被盖住多少。
      panel.style.setProperty('--fi-bar-h', '60px');
      const before = measure();
      if (observer && observer.disconnect) observer.disconnect();

      const result = {
        barHeight,
        cssVarBar,
        cssVarHeader: getComputedStyle(overlay).top,
        after,
        before,
        occludedBefore: before.overlayBottom - before.barTop,
        occludedAfter: after.overlayBottom - after.barTop,
        overlayZ: getComputedStyle(overlay).zIndex,
        barZ: getComputedStyle(bar).zIndex,
        barPosition: getComputedStyle(bar).position,
        boxVisibleHeight: Math.round(box.getBoundingClientRect().height),
      };
      panel.remove();
      return result;
    })()`);

    if (process.env.HUB_E2E_DEBUG === '1') console.error(JSON.stringify(layout, null, 2));

    // 输入栏实测远超原来写死的 60px —— 超出的那部分正是被盖住的
    assert.ok(layout.barHeight > 60, `输入栏实测 ${layout.barHeight}px，应远超写死的 60px`);
    assert.equal(layout.cssVarBar, `${layout.barHeight}px`, 'ResizeObserver 要把实测高度写进 --fi-bar-h');
    assert.ok(Number(layout.cssVarHeader.replace('px', '')) > 0, 'header 高度也要写回变量（overlay.top）');
    // 对照：按老的写死值，卡片层会盖住输入栏上百像素
    assert.ok(layout.occludedBefore > 90,
      `写死 60px 时应有明显遮挡，实测只有 ${layout.occludedBefore}px`);
    // 修复后：卡片层底边不得越过输入栏顶边
    assert.ok(layout.occludedAfter <= 1,
      `修复后不该再有遮挡，实测 ${layout.occludedAfter}px（卡片层底边 ${layout.after.overlayBottom} / 输入栏顶边 ${layout.after.barTop}）`);
    // 保险层：即使变量没跟上，输入栏也得在卡片层之上
    assert.equal(layout.barPosition, 'relative');
    assert.ok(Number(layout.barZ) > Number(layout.overlayZ), '输入栏 z-index 要压过卡片层');
    // 输入框能长到 max-height 而不是被压到两行（13px × 1.5 = 19.5px/行）
    assert.ok(layout.boxVisibleHeight >= 100, `输入框可见高度 ${layout.boxVisibleHeight}px，应接近 max-height 120px`);

    // ---- 5. 撤销栈 + ↑ 历史 ----
    const editing = await client.eval(`(() => {
      const box = document.createElement('div');
      box.className = 'floating-input-box';
      box.contentEditable = 'true';
      document.body.appendChild(box);
      box.focus();

      // 模拟用户打字（execCommand 走原生撤销栈）
      document.execCommand('insertText', false, '要发出去的话');
      const typed = readContenteditablePlainText(box);

      // 发送时的清空必须也走 execCommand，否则撤销栈被清掉
      replaceContenteditableText(box, '');
      const cleared = readContenteditablePlainText(box);

      box.focus();
      document.execCommand('undo');
      const undone = readContenteditablePlainText(box);

      // 光标位置判定：内容非空且光标在末尾 → 不该抢 ↑
      const atStartWhenEmpty = (() => {
        replaceContenteditableText(box, '');
        return isCaretAtContenteditableStart(box);
      })();
      const atStartAfterTyping = (() => {
        box.focus();
        document.execCommand('insertText', false, 'abc');
        placeCaretAtContenteditableEnd(box);
        return isCaretAtContenteditableStart(box);
      })();

      box.remove();
      return { typed, cleared, undone, atStartWhenEmpty, atStartAfterTyping };
    })()`);

    assert.equal(editing.typed, '要发出去的话');
    assert.equal(editing.cleared, '', '发送后必须真的清空，否则下一次回车会重发');
    assert.equal(editing.undone, '要发出去的话', 'Ctrl+Z 要能把刚发出去的原文找回来');
    assert.equal(editing.atStartWhenEmpty, true);
    assert.equal(editing.atStartAfterTyping, false, '光标在末尾时 ↑ 应保持原生上移一行');

    const history = await client.eval(`(() => {
      const h = window.FloatingInputHistory.createFloatingInputHistory({ storage: window.localStorage, storageKey: 'e2e-fi-history' });
      h.clear('e2e');
      h.push('e2e', '第一条');
      h.push('e2e', '第二条');
      const c = h.createCursor('e2e');
      const up1 = c.older('草稿');
      const up2 = c.older('草稿');
      const up3 = c.older('草稿');
      const down1 = c.newer();
      const down2 = c.newer();
      h.clear('e2e');
      return { up1: up1 && up1.text, up2: up2 && up2.text, up3, down1: down1 && down1.text, down2 };
    })()`);

    // ↑ 从最新往回翻，↓ 再往新的方向走回来，最后一格还原草稿。
    assert.equal(history.up1, '第二条');
    assert.equal(history.up2, '第一条');
    assert.equal(history.up3, null, '到顶后不该继续吃 ↑');
    assert.equal(history.down1, '第二条');
    assert.equal(history.down2.text, '草稿', '翻回底部要还原草稿');
    assert.equal(history.down2.restoredDraft, true);

    console.log(JSON.stringify({ ok: true, pid: hub.pid, port, layout, tuning: tuning.codex }, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    if (hub) console.error(hub.log().slice(-60).join('\n'));
    process.exitCode = 1;
  } finally {
    if (client) { try { client.ws.close(); } catch {} }
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(dataDir);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
        && path.basename(resolved).startsWith('claude-session-hub-create-options-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
})();
