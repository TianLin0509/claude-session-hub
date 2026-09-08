'use strict';
// Composer 四态 + 真实发送闭环 + 真实改模型/改档（T1 冷杉 v2）。
//
// 2026-09-07 第一轮评审的两条实证意见改变了这个脚本的写法：
//   - 四态截图当时是脚本注入字段生成的，证明不了真实交互；
//   - 「等你回答」和「断开」在真实会话上根本走不到。
// 所以现在：Part A 只做纯 DOM/状态断言（快、确定），**四张交付截图全部来自
// 真实会话**（Part B），并且额外记录一条真实 PTY 被杀之后到底发生了什么。
//
// 用法：node tests/e2e-composer-states-cdp.js   （--no-codex 跳过真实 Codex 段）

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const execFileAsync = promisify(execFile);
const HUB_ROOT = path.resolve(__dirname, '..');
const SHOT_DIR = path.join(HUB_ROOT, 'artifacts', '20260907-frost-v2');
const WORK_DIR = 'C:\\Vibe\\_scratch\\frost-t1-composer';
const RUN_CODEX = !process.argv.includes('--no-codex');

function canListen(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function availablePort(preferred) {
  for (let port = preferred; port < preferred + 60; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error('no free CDP port');
}

async function waitFor(client, expression, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await client.eval(expression);
    if (last) return last;
    await _waitMs(150);
  }
  throw new Error(`timeout waiting for ${label} (last=${JSON.stringify(last)})`);
}

async function shootComposer(client, file) {
  const clip = await client.eval(`(() => {
    const bar = document.querySelector('.terminal-panel .floating-input-bar .composer');
    if (!bar) return null;
    const r = bar.getBoundingClientRect();
    const pad = 18;
    return { x: Math.max(0, r.left - pad), y: Math.max(0, r.top - pad),
      width: r.width + pad * 2, height: r.height + pad * 2, scale: 1 };
  })()`);
  if (!clip) return null;
  const shot = await client.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false });
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const target = path.join(SHOT_DIR, file);
  fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
  return target;
}

// 整窗截图：用来记录「PTY 被杀之后用户实际看到什么」——那一刻 composer 已经不在了，
// 只截 composer 会得到 null，说明不了问题。
async function shootWindow(client, file) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const target = path.join(SHOT_DIR, file);
  fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
  return target;
}

function saveReport(report) {
  try {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(SHOT_DIR, 'T1-verification.json'),
      JSON.stringify(report, null, 2), 'utf8');
  } catch (error) {
    console.warn('report write failed:', error && error.message);
  }
}

async function composerProbe(client) {
  return client.eval(`(() => {
    const c = document.querySelector('.terminal-panel .floating-input-bar .composer');
    if (!c) return { present: false };
    const stop = c.querySelector('.floating-input-stop');
    const send = c.querySelector('.floating-input-send');
    const ctx = c.querySelector('.composer-ctx');
    const action = c.querySelector('.composer-status-action');
    return {
      present: true,
      state: c.dataset.state,
      text: c.querySelector('.composer-status-text').textContent,
      detail: c.querySelector('.composer-status-detail').textContent,
      action: action.hidden ? null : action.textContent,
      quickReplies: [...c.querySelectorAll('.composer-quick-reply')].map(e => e.textContent),
      stopVisible: stop.classList.contains('visible'),
      sendHidden: !!send.hidden,
      ctxLevel: ctx.hidden ? null : ctx.dataset.level,
      ctxPct: ctx.hidden ? null : ctx.style.getPropertyValue('--composer-ctx-pct'),
    };
  })()`);
}

// 只在本 Hub 的进程子树里找 PTY —— 绝不按名字全盘杀进程。
async function descendantPids(rootPid) {
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress';
  const { stdout } = await execFileAsync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const rows = JSON.parse(stdout);
  const byParent = new Map();
  for (const row of rows) {
    const parent = Number(row.ParentProcessId);
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push({ pid: Number(row.ProcessId), name: String(row.Name || '') });
  }
  const out = [];
  const queue = [Number(rootPid)];
  const seen = new Set(queue);
  while (queue.length) {
    const current = queue.shift();
    for (const child of byParent.get(current) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push({ ...child, parent: current });
      queue.push(child.pid);
    }
  }
  return out;
}

(async () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const dataDir = path.join(os.tmpdir(), `hub-frost-t1-${stamp}`);
  const port = await availablePort(Number(process.env.HUB_FROST_T1_PORT || 19831));
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const report = { screenshots: {}, synthetic: {}, rail: null, picker: null, sends: {}, real: {} };
  let hub = null;
  let client = null;
  try {
    // 评审实测（2026-09-07）：学习模块的根目录是独立的 AGENT_STUDY_DIR，
    // 只设 CLAUDE_HUB_DATA_DIR 拦不住它，定时计划会在测试实例里自己开会话并切走当前会话，
    // 把一次真实验证搞成无效证据。指向临时空目录。
    const studyDir = path.join(dataDir, 'isolated-study');
    fs.mkdirSync(studyDir, { recursive: true });
    hub = await launchIsolatedHub({
      dataDir, port, label: 'frost-t1-composer',
      extraEnv: { AGENT_STUDY_DIR: studyDir },
    });
    client = await connectFirstPage(
      hub,
      target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''),
    );
    await waitFor(client, "typeof showTerminal === 'function' && typeof updateFloatingBarState === 'function'", 'renderer ready');
    const meetings = await client.eval("require('electron').ipcRenderer.invoke('get-meetings')");
    assert.deepEqual(meetings, [], `隔离实例读到了生产数据：${JSON.stringify(meetings)}`);

    // ── A. 四态的 DOM 断言（注入字段，只为把四条分支都走一遍，不产出交付截图）──
    const FAKE_ID = 'frost-t1-composer-states';
    await client.eval(`(() => {
      sessions.set(${JSON.stringify(FAKE_ID)}, {
        id: ${JSON.stringify(FAKE_ID)}, kind: 'codex', title: 'Composer 四态', status: 'idle',
        createdAt: Date.now(), lastMessageTime: Date.now(), unreadCount: 0,
        cwd: ${JSON.stringify(WORK_DIR)},
        currentModel: { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' }, effort: 'xhigh',
        contextPct: 12, contextMax: 272000, contextEffectiveMax: 200000,
      });
      activeMeetingId = null; activeSessionId = ${JSON.stringify(FAKE_ID)}; currentView = 'pty';
      showTerminal(${JSON.stringify(FAKE_ID)}, { focus: false });
      renderSessionList();
      return true;
    })()`);
    await waitFor(client, "!!document.querySelector('.terminal-panel .floating-input-bar .composer')", 'composer mounted');

    const STATES = {
      ready: `Object.assign(s, { status: 'idle', lastCompletedAt: Date.now() - 120000, contextPct: 12 });`,
      working: `Object.assign(s, { status: 'running', _runSource: 'semantic', runStartedAt: Date.now() - 38000,
        currentCardActivity: { label: '正在读取 renderer.js' }, contextPct: 76 });
        s.runtimeTruth = { state: 'running', source: 'codex-task-started', confidence: 'authoritative',
          observedAt: Date.now(), startedAt: Date.now() - 38000, sequence: 1 };`,
      waiting: `Object.assign(s, { status: 'idle', attentionState: 'needs-input', needsUserInput: true,
        isWaiting: true, waitingText: '是否要我直接修改 index.html？\\n1. 是，继续\\n2. 先看 diff\\n3. 换个方案',
        contextPct: 93 }); s.runtimeTruth = null;`,
      dead: `Object.assign(s, { status: 'error', lastError: 'PTY 退出码 1', contextPct: 41 }); s.runtimeTruth = null;`,
    };
    for (const [name, patch] of Object.entries(STATES)) {
      await client.eval(`(() => { const s = sessions.get(${JSON.stringify(FAKE_ID)}); ${patch} updateFloatingBarState(); return true; })()`);
      await _waitMs(300);
      const probe = await composerProbe(client);
      assert.equal(probe.state, name, `${name} 状态不对：${JSON.stringify(probe)}`);
      report.synthetic[name] = probe;
    }
    assert.equal(report.synthetic.working.stopVisible, true, '工作中必须露出停止键');
    assert.equal(report.synthetic.working.sendHidden, true, '工作中发送键必须让位给停止键');
    assert.equal(report.synthetic.ready.stopVisible, false, '就绪不该有停止键');
    assert.deepEqual(report.synthetic.waiting.quickReplies, ['是，继续', '先看 diff', '换个方案']);
    assert.equal(report.synthetic.ready.ctxLevel, 'ok');
    assert.equal(report.synthetic.working.ctxLevel, 'warn');
    assert.equal(report.synthetic.waiting.ctxLevel, 'danger');

    report.rail = await client.eval(`(() => {
      const c = document.querySelector('.terminal-panel .floating-input-bar .composer');
      const rail = c.querySelector('.composer-rail');
      return {
        order: [...rail.children].filter(e => !e.hidden).map(e => e.className.split(' ')[0]),
        model: c.querySelector('.composer-model').hidden ? null : c.querySelector('.composer-model .composer-chip-label').textContent,
        thinking: c.querySelector('.composer-thinking').hidden ? null : c.querySelector('.composer-thinking .composer-chip-label').textContent,
        thinkingInteractive: c.querySelector('.composer-thinking').dataset.interactive,
        attachHidden: !!c.querySelector('.composer-attach').hidden,
        pull: !!c.querySelector('.composer-rail .fi-bridge-pull'),
        fork: !!c.querySelector('.composer-rail .fi-bridge-fork'),
      };
    })()`);
    assert.equal(report.rail.model, 'GPT-5.6 Sol');
    assert.equal(report.rail.thinking, 'xhigh');
    assert.equal(report.rail.thinkingInteractive, '1');

    const geminiChip = await client.eval(`(() => {
      const s = sessions.get(${JSON.stringify(FAKE_ID)});
      const kept = { kind: s.kind, model: s.currentModel, effort: s.effort };
      s.kind = 'gemini'; s.currentModel = { id: 'gemini-3-pro', displayName: 'Gemini 3 Pro' }; s.effort = 'max';
      updateFloatingBarState();
      const c = document.querySelector('.terminal-panel .floating-input-bar .composer');
      const out = { thinkingHidden: !!c.querySelector('.composer-thinking').hidden };
      Object.assign(s, { kind: kept.kind, currentModel: kept.model, effort: kept.effort });
      updateFloatingBarState();
      return out;
    })()`);
    assert.equal(geminiChip.thinkingHidden, true, 'Gemini 不该出现思考档 chip');

    await client.eval(`(() => { sessions.delete(${JSON.stringify(FAKE_ID)}); activeSessionId = null; renderSessionList(); return true; })()`);
    saveReport(report);

    // ── B. 真实会话 ────────────────────────────────────────────────────
    async function createSession(kind, label) {
      const created = await client.eval(
        `require('electron').ipcRenderer.invoke('create-session', { kind: ${JSON.stringify(kind)},`
        + ` opts: { title: ${JSON.stringify(label)}, cwd: ${JSON.stringify(WORK_DIR)} } })`);
      assert.ok(created && created.id, `${kind} 会话没建起来：${JSON.stringify(created)}`);
      const sid = created.id;
      await waitFor(client, `!!terminalCache.get(${JSON.stringify(sid)})`, `${kind} terminal`, 60000);
      await _waitMs(kind === 'codex' ? 14000 : 3000);
      await client.eval(`(() => { activeSessionId = ${JSON.stringify(sid)}; showTerminal(${JSON.stringify(sid)}, { focus: false }); return true; })()`);
      await waitFor(client, "!!document.querySelector('.terminal-panel .floating-input-bar .composer')", `${kind} composer`);
      return sid;
    }

    // 从 composer 真按发送键，并抓住那一次 session:send-prompt 的返回。
    async function sendFromComposer(sid, text) {
      const sent = await client.eval(`(async () => {
        const started = Date.now();
        const box = document.querySelector('.floating-input-box');
        box.focus();
        document.execCommand('insertText', false, ${JSON.stringify(text)});
        const invoked = new Promise((resolve) => {
          const original = ipcRenderer.invoke.bind(ipcRenderer);
          ipcRenderer.invoke = (channel, ...args) => {
            const promise = original(channel, ...args);
            if (channel === 'session:send-prompt') {
              promise.then(r => resolve({ result: r, ms: Date.now() - started }));
              ipcRenderer.invoke = original;
            }
            return promise;
          };
        });
        document.querySelector('.floating-input-send').click();
        return await Promise.race([invoked, new Promise(r => setTimeout(() => r(null), 120000))]);
      })()`);
      assert.ok(sent && sent.result, `没走到 session:send-prompt`);
      assert.equal(sent.result.ok, true, `发送失败：${JSON.stringify(sent.result)}`);
      return sent;
    }

    async function waitTurnDone(sid, timeoutMs = 180000) {
      const expr = `(() => { const s = sessions.get(${JSON.stringify(sid)}); return !!s && !sessionRuntimeIsActive(s); })()`;
      await _waitMs(2500);
      await waitFor(client, expr, 'turn finished', timeoutMs);
      await _waitMs(2500);
    }

    // B1 普通 shell：非 paste-sensitive，主进程直写，没有语义确认这一环（设计如此）。
    const shellSid = await createSession('powershell', 'T1 shell 发送验证');
    report.sends.shell = await sendFromComposer(shellSid, 'Write-Output "frost-t1 composer shell check"');
    report.sends.shell.composer = await composerProbe(client);

    // B2 真实 PTY 退出：在本 Hub 的进程子树里定位这个 shell 的 PTY 再结束它。
    const before = await descendantPids(hub.pid);
    const shellPids = before.filter(p => /^(powershell|pwsh)\.exe$/i.test(p.name)).map(p => p.pid);
    report.real.ptyKill = { hubPid: hub.pid, candidates: shellPids };
    if (shellPids.length === 1) {
      await execFileAsync('taskkill.exe', ['/PID', String(shellPids[0]), '/T', '/F'], { windowsHide: true })
        .catch(err => { report.real.ptyKill.killError = err && err.message; });
      await _waitMs(4000);
      report.real.ptyKill.afterKill = await client.eval(`(() => {
        const sid = ${JSON.stringify(shellSid)};
        const c = document.querySelector('.terminal-panel .floating-input-bar .composer');
        return {
          sessionStillKnown: sessions.has(sid),
          activeSessionId,
          composerPresent: !!c,
          composerState: c ? c.dataset.state : null,
          emptyStateVisible: !!document.getElementById('empty-state')
            && document.getElementById('empty-state').style.display !== 'none',
        };
      })()`);
      report.screenshots.afterPtyKill = await shootWindow(client, 'T1-after-pty-kill.png');
    } else {
      report.real.ptyKill.skipped = '子树里的 powershell 进程不是恰好一个，放弃定位以免误杀';
    }
    saveReport(report);

    if (RUN_CODEX) {
      const sid = await createSession('codex', 'T1 Codex 真实交互验证');
      report.real.codexSessionId = sid;

      // ── 工作中（真实）──
      report.sends.codex = await sendFromComposer(sid, '只回一个词：ok');
      assert.equal(report.sends.codex.result.mode, 'closed-loop', 'Codex 必须走闭环');
      assert.notEqual(report.sends.codex.result.sendStatus, 'stuck', 'Codex 提交没拿到确认');
      await _waitMs(600);
      report.real.working = await composerProbe(client);
      report.screenshots.working = await shootComposer(client, 'T1-composer-working.png');
      assert.equal(report.real.working.state, 'working');
      assert.equal(report.real.working.stopVisible, true, '真实工作态必须露出停止键');

      // ── 就绪（真实）──
      await waitTurnDone(sid);
      report.real.ready = await composerProbe(client);
      report.screenshots.ready = await shootComposer(client, 'T1-composer-ready.png');
      assert.equal(report.real.ready.state, 'ready');
      assert.equal(report.real.ready.action, '查看上一轮 ↑');

      // ── 改思考档（真实）──
      // 必须在**初始模型 + 默认档位（Hub 给新 Codex 会话的默认是 max）**上测。
      // 2026-09-07 评审正是在这个初始状态下复现出“点 high 实际选成 medium”的；
      // 上一轮我先换模型、档位被带成 low，恰好绕开了这个 bug。顺序不得再倒回去。
      await _waitMs(2500);
      async function switchEffortFromChip(wanted) {
        return client.eval(`(async () => {
          const sid = ${JSON.stringify(sid)};
          const wanted = ${JSON.stringify(wanted)};
          const before = String(sessions.get(sid).effort || '');
          const chip = document.querySelector('.composer-thinking');
          if (!chip || chip.hidden) return { before, error: 'thinking chip not rendered' };
          // 用户看到的档位是 chip 上的文字（Hub 内部字段可能还没回填，
          // 而 CLI 启动参数里已经是 max）—— 断言要按用户看到的来。
          const beforeLabel = String(chip.querySelector('.composer-chip-label').textContent || '').trim();
          chip.click();
          await new Promise(r => setTimeout(r, 900));
          const menu = document.querySelector('.effort-picker-menu');
          if (!menu) return { before, error: 'effort picker did not open' };
          const offered = [...menu.querySelectorAll('.model-picker-item')].map(e => e.dataset.effort);
          const target = wanted || offered.find(e => e && e !== before);
          if (!target || target === before) { document.body.click(); return { before, beforeLabel, offered, error: 'no usable target effort' }; }
          const item = menu.querySelector('.model-picker-item[data-effort="' + target + '"]');
          if (!item) { document.body.click(); return { before, beforeLabel, offered, target, error: 'target effort not offered' }; }
          item.click();
          for (let i = 0; i < 100; i += 1) {
            await new Promise(r => setTimeout(r, 250));
            const now = String(sessions.get(sid).effort || '');
            if (now && now !== before) {
              const label = document.querySelector('.composer-thinking .composer-chip-label').textContent;
              document.body.click();
              return { before, beforeLabel, offered, target, after: now, chipLabel: label };
            }
          }
          document.body.click();
          return { before, beforeLabel, offered, target, error: 'effort switch not confirmed in 25s' };
        })()`);
      }

      // ① 默认 max → high：一级面板上的目标，但光标在“More reasoning…”那一行。
      report.real.effortSwitch = await switchEffortFromChip('high');
      assert.ok(report.real.effortSwitch.after,
        `思考档没能真的改掉：${JSON.stringify(report.real.effortSwitch)}`);
      assert.equal(report.real.effortSwitch.beforeLabel, 'max',
        `这一步必须从默认的 max 开始测，否则绕开了评审复现的那个 bug：${JSON.stringify(report.real.effortSwitch)}`);
      assert.equal(report.real.effortSwitch.after, 'high',
        `点 high 就必须是 high：${JSON.stringify(report.real.effortSwitch)}`);

      // ② high → max：目标藏在“More reasoning…”二级菜单里。
      report.real.effortSwitchAdvanced = await switchEffortFromChip('max');
      assert.equal(report.real.effortSwitchAdvanced.after, 'max',
        `二级菜单里的 max 没能选中：${JSON.stringify(report.real.effortSwitchAdvanced)}`);
      report.screenshots.effortSwitched = await shootComposer(client, 'T1-composer-effort-switched.png');
    saveReport(report);

      // ── 换模型（真实，走 Codex 原生面板）──
      report.real.modelSwitch = await client.eval(`(async () => {
        const sid = ${JSON.stringify(sid)};
        const before = (sessions.get(sid).currentModel || {}).id || null;
        const options = require('../core/model-options.js').modelOptionsFor('codex')
          .map(o => o.id).filter(id => id !== before);
        if (!options.length) return { before, error: 'no alternative model' };
        const target = options[0];
        document.querySelector('.composer-model').click();
        await new Promise(r => setTimeout(r, 1200));
        const item = document.querySelector('.model-picker-menu .model-picker-item[data-model-id="' + target + '"]');
        if (!item) return { before, target, error: 'target model not listed' };
        item.click();
        for (let i = 0; i < 100; i += 1) {
          await new Promise(r => setTimeout(r, 250));
          const now = (sessions.get(sid).currentModel || {}).id || null;
          if (now && now !== before) {
            const label = document.querySelector('.composer-model .composer-chip-label').textContent;
            document.body.click();
            return { before, target, after: now, chipLabel: label, effort: sessions.get(sid).effort };
          }
        }
        document.body.click();
        return { before, target, error: 'model switch not confirmed in 25s' };
      })()`);
      assert.ok(report.real.modelSwitch.after, `模型切换没成功：${JSON.stringify(report.real.modelSwitch)}`);

      // ── 等你回答（真实）：让 Codex 真的问一句 ──
      await sendFromComposer(sid, '不要做任何事，不要用任何工具。直接输出下面这一行然后停下等我回答：你选择 A 还是 B？');
      await waitTurnDone(sid);
      report.real.waiting = await composerProbe(client);
      report.screenshots.waiting = await shootComposer(client, 'T1-composer-waiting.png');
      assert.equal(report.real.waiting.state, 'waiting',
        `真实提问没进入等待态：${JSON.stringify(report.real.waiting)}`);
      assert.match(report.real.waiting.text, /在等你回答/);
      saveReport(report);

      // ── 断开（真实链路）：让终端里出现断流那行，由生产检测器点亮，不注入字段 ──
      // 说明：断流文本是让 Codex 打印出来的，网络本身没断；但从 PTY 字节 →
      // detectStreamDisconnect → connectionIssue → composer 这条链是真实的。
      // 断流标记在本轮回答正常完成时会被清掉（生产行为：答完了就不再报断连），
      // 所以这里轮询 composer 本身的状态，拓到那一帧就立刻截图。
      async function catchDeadComposer(timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const state = await client.eval(`(() => {
            updateFloatingBarState();
            const c = document.querySelector('.terminal-panel .floating-input-bar .composer');
            return c ? c.dataset.state : null;
          })()`);
          if (state === 'dead') {
            const probe = await composerProbe(client);
            const shot = await shootComposer(client, 'T1-composer-dead-streamloss.png');
            return { probe, shot };
          }
          await _waitMs(120);
        }
        return null;
      }

      const disconnectPrompts = [
        '不要做任何事。输出两行，第一行写「诊断输出：」，第二行原样写：API Error: Connection error.',
        '不要做任何事。输出两行，第一行写「诊断输出二：」，第二行原样写：stream disconnected by peer',
      ];
      let caught = null;
      for (const prompt of disconnectPrompts) {
        await sendFromComposer(sid, prompt);
        caught = await catchDeadComposer(90000);
        if (caught) break;
        await waitTurnDone(sid);
      }
      report.real.streamLossDead = caught ? caught.probe : { caught: false };
      if (caught) report.screenshots.deadStreamLoss = caught.shot;
      saveReport(report);
      assert.ok(caught, '断流没能把 composer 推进断开态（已试两次）');
      assert.equal(report.real.streamLossDead.state, 'dead');
      assert.equal(report.real.streamLossDead.action, '重连');

      // ── 断开（任务卡里写的那一条）：真结束这个会话的 PTY 进程 ──
      // 只在本 Hub 的进程子树里定位，绝不按名字全盘杀。
      await waitTurnDone(sid);
      // Hub 是用一个 shell 开 PTY、再在里面跑 codex 的。只杀 codex.exe 的话
      // 宿主 shell 会回到提示符、PTY 不会退出 —— 那就没复现到要测的事。
      // 所以从 codex.exe 往上找到它的 shell 宿主，连树结束。
      const codexDescendants = await descendantPids(hub.pid);
      const byPid = new Map(codexDescendants.map(p => [p.pid, p]));
      const codexProc = codexDescendants.filter(p => /^codex(\.exe)?$/i.test(p.name));
      let killTarget = null;
      if (codexProc.length === 1) {
        let walk = byPid.get(codexProc[0].parent);
        while (walk && !/^(powershell|pwsh)\.exe$/i.test(walk.name)) walk = byPid.get(walk.parent);
        killTarget = walk ? walk.pid : codexProc[0].pid;
      }
      report.real.codexPtyKill = {
        hubPid: hub.pid,
        codexPids: codexProc.map(p => p.pid),
        killTarget,
        names: [...new Set(codexDescendants.map(p => p.name))],
      };
      assert.ok(killTarget, `定位不到这个会话的 PTY 宿主，放弃以免误杀：${JSON.stringify(report.real.codexPtyKill)}`);
      await execFileAsync('taskkill.exe', ['/PID', String(killTarget), '/T', '/F'], { windowsHide: true });
      await _waitMs(5000);
      report.real.dead = await composerProbe(client);
      report.real.codexPtyKill.afterKill = await client.eval(`(() => {
        const s = sessions.get(${JSON.stringify(sid)});
        return {
          sessionStillKnown: !!s,
          status: s ? s.status : null,
          processLost: s ? s._processLost : null,
          activeSessionId,
        };
      })()`);
      report.screenshots.dead = await shootComposer(client, 'T1-composer-dead.png');
      saveReport(report);
      assert.equal(report.real.codexPtyKill.afterKill.sessionStillKnown, true,
        '进程崩了不应该把会话记录一起抹掉');
      assert.equal(report.real.dead.present, true, 'PTY 退出后输入框必须还在');
      assert.equal(report.real.dead.state, 'dead');
      assert.equal(report.real.dead.action, '重连');
      assert.match(report.real.dead.text, /CLI 进程/, '断开原因要说清是进程没了，不能笼统地说休眠');

      // 重连必须真的能把会话拉回来，不能是个按了没反应的按钮。
      // CDP 单次求值上限 30s，恢复一个 Codex 会话比这久，所以在测试进程侧轮询，
      // 不把等待塞进页面里的一次 eval。
      await client.eval(`(() => {
        const action = document.querySelector('.composer-status-action');
        if (!action || action.hidden) return false;
        action.click();
        return true;
      })()`);
      report.real.reconnect = { clicked: true };
      const reconnectDeadline = Date.now() + 150000;
      while (Date.now() < reconnectDeadline) {
        await _waitMs(1000);
        const revived = await client.eval(`(() => {
          const live = [...sessions.values()].find(s => String(s.kind || '').indexOf('codex') === 0
            && s.status !== 'dormant' && terminalCache.get(s.id));
          if (!live) {
            const dead = sessions.get(${JSON.stringify(sid)});
            window.__reconnectDiag = dead
              ? { status: dead.status, resumePending: dead._resumePending, processLost: dead._processLost }
              : { missing: true };
            return null;
          }
          return { ok: true, revivedSessionId: live.id, status: live.status,
            processLostCleared: !live._processLost, activeSessionId };
        })()`);
        if (revived) { report.real.reconnect = revived; break; }
      }
      saveReport(report);
      if (!report.real.reconnect.ok) {
        report.real.reconnectDiag = await client.eval('window.__reconnectDiag || null');
        saveReport(report);
      }
      assert.ok(report.real.reconnect.ok, `重连没能把会话拉回来：${JSON.stringify(report.real.reconnect)} diag=${JSON.stringify(report.real.reconnectDiag)}`);
      assert.equal(report.real.reconnect.processLostCleared, true,
        '唤醒成功后“进程丢了”这笔必须销掉');
    }

    saveReport(report);
    console.log(JSON.stringify(report, null, 2));
    console.log('\nCOMPOSER STATES E2E: OK');
  } finally {
    if (hub) await gracefulQuit(hub).catch(err => console.warn('quit warn:', err && err.message));
  }
})().catch((error) => {
  console.error('COMPOSER STATES E2E FAILED:', error && (error.stack || error.message));
  process.exitCode = 1;
});
