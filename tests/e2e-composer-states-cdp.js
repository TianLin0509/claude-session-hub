'use strict';
// Composer 四态 + 真实发送闭环（T1 冷杉 v2）。
//
// 分两段：
//   A. 四种状态各截一张图。状态用真实的 session 字段驱动（runtime truth 自己推），
//      不直接改 composer 的 class —— 那样截出来的图只能证明 CSS 存在。
//   B. 真发一条 prompt：一个 Codex 会话（闭环 + agent-turn-started 确认，记录耗时）
//      和一个 PowerShell 会话（plain-shell 直写）。发送路径本卡一行没动，
//      这一段证明它确实还是那条路径。
//
// 用法：node tests/e2e-composer-states-cdp.js
// 需要真实 Codex 时加 --with-codex（默认跑，用 --no-codex 跳过）。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

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
  assert.ok(clip, 'composer 不在页面上，截不到图');
  const shot = await client.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false });
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const target = path.join(SHOT_DIR, file);
  fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
  return target;
}

// 状态由真实字段驱动：runtime truth 从 status / attention / runStartedAt 自己推。
const STATES = {
  ready: {
    file: 'T1-composer-ready.png',
    patch: `Object.assign(s, { status: 'idle', lastCompletedAt: Date.now() - 120000,
      lastRunDurationMs: 41000, contextPct: 12, contextUsed: 24000, contextEffectiveMax: 200000 });`,
    expect: 'ready',
  },
  working: {
    file: 'T1-composer-working.png',
    patch: `Object.assign(s, { status: 'running', _runSource: 'semantic', _agentWorking: 'card',
      runStartedAt: Date.now() - 38000, cardWorkingSince: Date.now() - 38000,
      currentCardActivity: { label: '正在读取 renderer.js' }, contextPct: 76 });
      s.runtimeTruth = { state: 'running', source: 'codex-task-started', confidence: 'authoritative',
        observedAt: Date.now(), startedAt: Date.now() - 38000, sequence: 1 };`,
    expect: 'working',
  },
  waiting: {
    file: 'T1-composer-waiting.png',
    patch: `Object.assign(s, { status: 'idle', attentionState: 'needs-input', needsUserInput: true,
      isWaiting: true, waitingReason: 'needs-input',
      waitingText: '是否要我直接修改 index.html？\\n1. 是，继续\\n2. 先看 diff\\n3. 换个方案',
      contextPct: 93 });
      s.runtimeTruth = null;`,
    expect: 'waiting',
  },
  dead: {
    file: 'T1-composer-dead.png',
    patch: `Object.assign(s, { status: 'error', lastError: 'PTY 退出码 1', contextPct: 41 });
      s.runtimeTruth = null;`,
    expect: 'dead',
  },
};

(async () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const dataDir = path.join(os.tmpdir(), `hub-frost-t1-${stamp}`);
  const port = await availablePort(Number(process.env.HUB_FROST_T1_PORT || 19831));
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const report = { screenshots: {}, states: {}, rail: null, picker: null, sends: {} };
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({ dataDir, port, label: 'frost-t1-composer' });
    client = await connectFirstPage(
      hub,
      target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''),
    );
    await waitFor(client, "typeof showTerminal === 'function' && typeof updateFloatingBarState === 'function'", 'renderer ready');
    // 证明没读生产数据。
    const meetings = await client.eval("require('electron').ipcRenderer.invoke('get-meetings')");
    assert.deepEqual(meetings, [], `隔离实例读到了生产数据：${JSON.stringify(meetings)}`);

    // ── A. 四态 ────────────────────────────────────────────────────────
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

    for (const [name, spec] of Object.entries(STATES)) {
      await client.eval(`(() => {
        const s = sessions.get(${JSON.stringify(FAKE_ID)});
        ${spec.patch}
        updateFloatingBarState();
        return true;
      })()`);
      await _waitMs(320);
      const probe = await client.eval(`(() => {
        const c = document.querySelector('.terminal-panel .floating-input-bar .composer');
        const stop = c.querySelector('.floating-input-stop');
        const send = c.querySelector('.floating-input-send');
        const ctx = c.querySelector('.composer-ctx');
        return {
          state: c.dataset.state,
          text: c.querySelector('.composer-status-text').textContent,
          detail: c.querySelector('.composer-status-detail').textContent,
          action: c.querySelector('.composer-status-action').hidden
            ? null : c.querySelector('.composer-status-action').textContent,
          quickReplies: [...c.querySelectorAll('.composer-quick-reply')].map(e => e.textContent),
          stopVisible: stop.classList.contains('visible'),
          sendHidden: !!send.hidden,
          ctxLevel: ctx.hidden ? null : ctx.dataset.level,
          ctxPct: ctx.hidden ? null : ctx.style.getPropertyValue('--composer-ctx-pct'),
        };
      })()`);
      assert.equal(probe.state, spec.expect, `${name} 状态不对：${JSON.stringify(probe)}`);
      report.states[name] = probe;
      report.screenshots[name] = await shootComposer(client, spec.file);
    }

    assert.equal(report.states.working.stopVisible, true, '工作中必须露出停止键');
    assert.equal(report.states.working.sendHidden, true, '工作中发送键必须让位给停止键');
    assert.equal(report.states.ready.stopVisible, false, '就绪不该有停止键');
    assert.deepEqual(report.states.waiting.quickReplies, ['是，继续', '先看 diff', '换个方案']);
    assert.equal(report.states.ready.ctxLevel, 'ok');
    assert.equal(report.states.working.ctxLevel, 'warn');
    assert.equal(report.states.waiting.ctxLevel, 'danger');

    // ── 底栏 chip 与模型选择器 ─────────────────────────────────────────
    report.rail = await client.eval(`(() => {
      const c = document.querySelector('.terminal-panel .floating-input-bar .composer');
      const rail = c.querySelector('.composer-rail');
      return {
        order: [...rail.children].filter(e => !e.hidden).map(e => e.className.split(' ')[0]),
        model: c.querySelector('.composer-model').hidden ? null : c.querySelector('.composer-model .composer-chip-label').textContent,
        thinking: c.querySelector('.composer-thinking').hidden ? null : c.querySelector('.composer-thinking .composer-chip-label').textContent,
        thinkingInteractive: c.querySelector('.composer-thinking').dataset.interactive,
        thinkingTitle: c.querySelector('.composer-thinking').title,
        attachHidden: !!c.querySelector('.composer-attach').hidden,
        pull: !!c.querySelector('.composer-rail .fi-bridge-pull'),
        fork: !!c.querySelector('.composer-rail .fi-bridge-fork'),
      };
    })()`);
    assert.equal(report.rail.model, 'GPT-5.6 Sol', '模型 chip 没显示模型名');
    assert.equal(report.rail.thinking, 'xhigh', '思考档 chip 没显示档位');
    assert.equal(report.rail.thinkingInteractive, '1', 'Codex 的思考档 chip 应可点');

    // 思考档在不支持的 CLI 上不渲染 —— 用一个 Gemini 会话真实验一次。
    const geminiChip = await client.eval(`(() => {
      const s = sessions.get(${JSON.stringify(FAKE_ID)});
      const kept = { kind: s.kind, model: s.currentModel, effort: s.effort };
      s.kind = 'gemini'; s.currentModel = { id: 'gemini-3-pro', displayName: 'Gemini 3 Pro' }; s.effort = 'max';
      updateFloatingBarState();
      const c = document.querySelector('.terminal-panel .floating-input-bar .composer');
      const out = { thinkingHidden: !!c.querySelector('.composer-thinking').hidden,
        model: c.querySelector('.composer-model .composer-chip-label').textContent };
      Object.assign(s, { kind: kept.kind, currentModel: kept.model, effort: kept.effort });
      updateFloatingBarState();
      return out;
    })()`);
    assert.equal(geminiChip.thinkingHidden, true, 'Gemini 不该出现思考档 chip');
    report.rail.geminiThinkingHidden = true;

    // 模型选择器：点 chip 必须打开现有的那个菜单，且不会开到窗外。
    report.picker = await client.eval(`(async () => {
      const chip = document.querySelector('.composer-model');
      chip.click();
      await new Promise(r => setTimeout(r, 900));
      const menu = document.querySelector('.model-picker-menu');
      if (!menu) return { opened: false };
      const r = menu.getBoundingClientRect();
      const out = {
        opened: true,
        items: [...menu.querySelectorAll('.model-picker-item')].map(e => e.dataset.modelId),
        insideViewport: r.top >= 0 && r.bottom <= window.innerHeight,
        top: Math.round(r.top), bottom: Math.round(r.bottom), viewport: window.innerHeight,
      };
      document.body.click();
      return out;
    })()`);
    assert.equal(report.picker.opened, true, '模型 chip 没能打开选择器');
    assert.equal(report.picker.insideViewport, true, `选择器开到了窗外：${JSON.stringify(report.picker)}`);

    await client.eval(`(() => { sessions.delete(${JSON.stringify(FAKE_ID)}); activeSessionId = null; renderSessionList(); return true; })()`);

    // ── B. 真发一条 prompt ────────────────────────────────────────────
    async function realSend(kind, text, label) {
      const created = await client.eval(
        `require('electron').ipcRenderer.invoke('create-session', { kind: ${JSON.stringify(kind)},`
        + ` opts: { title: ${JSON.stringify(label)}, cwd: ${JSON.stringify(WORK_DIR)} } })`);
      assert.ok(created && created.id, `${kind} 会话没建起来：${JSON.stringify(created)}`);
      const sid = created.id;
      await waitFor(client, `!!terminalCache.get(${JSON.stringify(sid)})`, `${kind} terminal`, 60000);
      await _waitMs(kind === 'codex' ? 12000 : 3000);
      await client.eval(`(() => { activeSessionId = ${JSON.stringify(sid)}; showTerminal(${JSON.stringify(sid)}, { focus: false }); return true; })()`);
      await waitFor(client, "!!document.querySelector('.terminal-panel .floating-input-bar .composer')", `${kind} composer`);

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
        return await Promise.race([invoked, new Promise(r => setTimeout(() => r(null), 90000))]);
      })()`);
      assert.ok(sent && sent.result, `${kind} 没走到 session:send-prompt`);
      assert.equal(sent.result.ok, true, `${kind} 发送失败：${JSON.stringify(sent.result)}`);
      const observed = await client.eval(`(() => {
        const c = document.querySelector('.terminal-panel .floating-input-bar .composer');
        return { state: c.dataset.state, text: c.querySelector('.composer-status-text').textContent };
      })()`);
      return { sessionId: sid, ...sent, composer: observed };
    }

    report.sends.shell = await realSend('powershell', 'Write-Output "frost-t1 composer shell check"', 'T1 shell 发送验证');
    if (RUN_CODEX) {
      report.sends.codex = await realSend('codex', '只回一个词：ok', 'T1 Codex 发送验证');
      assert.equal(report.sends.codex.result.mode, 'closed-loop', 'Codex 必须走闭环');
      assert.notEqual(report.sends.codex.result.sendStatus, 'stuck', 'Codex 提交没拿到确认');
      report.screenshots.codexWorking = await shootComposer(client, 'T1-composer-working-real-codex.png');

      // 模型 chip 真切一次：走的是 Codex 原生面板，Hub 拿到终端回执才改自己的元数据。
      const sid = report.sends.codex.sessionId;
      await waitFor(client, `(() => {
        const s = sessions.get(${JSON.stringify('__SID__')});
        return !!s && !sessionRuntimeIsActive(s);
      })()`.replace('__SID__', sid), 'codex turn finished', 120000);
      await _waitMs(2000);
      report.modelSwitch = await client.eval(`(async () => {
        const sid = ${JSON.stringify('__SID__')};
        const before = (sessions.get(sid).currentModel || {}).id || null;
        const options = require('../core/model-options.js').modelOptionsFor('codex')
          .map(o => o.id).filter(id => id !== before);
        if (!options.length) return { before, error: 'no alternative model in catalog' };
        const target = options[0];
        const chip = document.querySelector('.composer-model');
        chip.click();
        await new Promise(r => setTimeout(r, 1200));
        const item = document.querySelector('.model-picker-menu .model-picker-item[data-model-id="' + target + '"]');
        if (!item) return { before, target, error: 'target model not listed' };
        item.click();
        for (let i = 0; i < 120; i += 1) {
          await new Promise(r => setTimeout(r, 250));
          const now = (sessions.get(sid).currentModel || {}).id || null;
          if (now && now !== before) {
            const label = document.querySelector('.composer-model .composer-chip-label').textContent;
            document.body.click();
            return { before, target, after: now, chipLabel: label, effort: sessions.get(sid).effort };
          }
        }
        document.body.click();
        return { before, target, error: 'switch not confirmed in 30s' };
      })()`.replace('__SID__', sid));
      assert.ok(report.modelSwitch && report.modelSwitch.after,
        `模型切换没成功：${JSON.stringify(report.modelSwitch)}`);
      report.screenshots.codexModelSwitched = await shootComposer(client, 'T1-composer-model-switched.png');
    }

    console.log(JSON.stringify(report, null, 2));
    console.log('\nCOMPOSER STATES E2E: OK');
  } finally {
    if (hub) await gracefulQuit(hub).catch(err => console.warn('quit warn:', err && err.message));
  }
})().catch((error) => {
  console.error('COMPOSER STATES E2E FAILED:', error && (error.stack || error.message));
  process.exitCode = 1;
});
