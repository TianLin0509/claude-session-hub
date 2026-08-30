'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const HUB_ROOT = path.resolve(__dirname, '..');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUTPUT_DIR = process.env.TASK_PRESET_E2E_OUTPUT_DIR
  ? path.resolve(process.env.TASK_PRESET_E2E_OUTPUT_DIR)
  : path.join(HUB_ROOT, 'artifacts');
const SINGLE_SHOT = path.join(OUTPUT_DIR, `task-presets-single-${STAMP}.png`);
const WORKFLOW_SHOT = path.join(OUTPUT_DIR, `task-presets-workflow-${STAMP}.png`);

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function availablePort(preferred) {
  for (let port = preferred; port < preferred + 80; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error(`No free CDP port from ${preferred}`);
}

async function waitForEval(client, expression, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await client.eval(`Boolean(${expression})`)) return;
    } catch {}
    await _waitMs(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function cleanupDataDir(dataDir) {
  const resolved = path.resolve(dataDir);
  const tmpRoot = path.resolve(os.tmpdir());
  if (!resolved.startsWith(tmpRoot + path.sep)) return;
  if (!path.basename(resolved).startsWith('claude-session-hub-task-presets-e2e-')) return;
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function screenshot(client, file) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  assert(fs.statSync(file).size > 10 * 1024, `screenshot too small: ${file}`);
}

(async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const port = await availablePort(Number(process.env.TASK_PRESET_E2E_PORT || 19460));
  const dataDir = path.join(os.tmpdir(), `claude-session-hub-task-presets-e2e-${process.pid}-${STAMP}`);
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir,
      port,
      label: 'task-presets-e2e',
      extraEnv: { CLAUDE_HUB_E2E: '1' },
    });
    client = await connectFirstPage(hub, t => t.type === 'page' && /renderer[\\/]index\.html/.test(t.url || ''));
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await waitForEval(
      client,
      'window.TaskPresets && window.WorkflowTemplates && typeof mountFloatingInput === "function" && typeof window.openWorkflowConfigModal === "function"',
      'task preset modules',
    );

    const single = await client.eval(`(() => {
      const old = document.getElementById('task-preset-e2e-stage');
      if (old) old.remove();
      const stage = document.createElement('div');
      stage.id = 'task-preset-e2e-stage';
      stage.style.cssText = 'position:fixed;inset:70px 70px 90px;z-index:9000;background:var(--bg-primary,#0d1117);border:1px solid var(--border,#30363d);border-radius:14px;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,.55)';
      stage.innerHTML = '<div style="padding:15px 18px;border-bottom:1px solid var(--border,#30363d);color:var(--text-primary,#e6edf3);font-weight:700">普通 Session · ChatGPT 拉取 E2E</div><div class="terminal-panel" style="position:absolute;inset:52px 0 0;display:flex;flex-direction:column"><div class="terminal-container" style="flex:1;padding:24px;color:var(--text-secondary,#8b949e)">真实 renderer / 隔离数据目录</div></div>';
      document.body.appendChild(stage);
      const sid = 'task-preset-e2e-session';
      sessions.set(sid, { id:sid, kind:'codex', title:'Codex E2E', status:'active' });
      const electronIpc = require('electron').ipcRenderer;
      window.__taskPresetOriginalInvoke = electronIpc.invoke;
      window.__chatgptPullEvents = [];
      electronIpc.invoke = async function(channel, ...args) {
        if (channel === 'chatgpt-bridge:pull-for-input') {
          window.__chatgptPullEvents.push('pull');
          return {
            ok:true, new:true, file_count:1,
            content:'公司纯文本\\n\\nC:\\\\VibeData\\\\ChatGPTBridge\\\\inbox\\\\mock.pdf',
            message_ids:['mock-message-1'],
            items:[
              {message_id:'mock-message-1',source:'inline_text',content:'公司纯文本'},
              {message_id:'mock-message-1',source:'file_path',path:'C:\\\\VibeData\\\\ChatGPTBridge\\\\inbox\\\\mock.pdf'},
            ],
          };
        }
        if (channel === 'chatgpt-bridge:ack') {
          window.__chatgptPullEvents.push('ack:' + args[0].messageIds.join(','));
          return {ok:true};
        }
        return window.__taskPresetOriginalInvoke.call(this, channel, ...args);
      };
      const terminal = { focus(){}, scrollToBottom(){} };
      const termContainer = stage.querySelector('.terminal-container');
      window.__taskPresetE2EControl = mountFloatingInput(sid, termContainer, terminal);
      const input = stage.querySelector('.floating-input-box');
      return {
        presetButtonCount: stage.querySelectorAll('.fi-preset-chip').length,
        pullButtonCount: stage.querySelectorAll('.fi-bridge-pull').length,
        pullLabel: stage.querySelector('.fi-bridge-pull')?.textContent || '',
      };
    })()`);
    assert.strictEqual(single.presetButtonCount, 0, 'unused normal-session task preset buttons must be removed');
    assert.strictEqual(single.pullButtonCount, 1, 'normal session must expose exactly one ChatGPT pull button');
    assert.strictEqual(single.pullLabel, '拉取');
    await client.eval(`document.querySelector('#task-preset-e2e-stage .fi-bridge-pull').click()`);
    await waitForEval(client,
      `document.querySelector('#task-preset-e2e-stage .floating-input-box').innerText.includes('mock.pdf') && window.__chatgptPullEvents.length === 2`,
      'ChatGPT pull text/path insertion and ack');
    const pulled = await client.eval(`(() => ({
      inputText: document.querySelector('#task-preset-e2e-stage .floating-input-box').innerText,
      events: window.__chatgptPullEvents.slice(),
    }))()`);
    assert(pulled.inputText.includes('公司纯文本'));
    assert(pulled.inputText.includes('C:\\VibeData\\ChatGPTBridge\\inbox\\mock.pdf'));
    assert.deepStrictEqual(pulled.events, ['pull', 'ack:mock-message-1'], 'ack must happen after content is inserted');
    await screenshot(client, SINGLE_SHOT);

    await client.eval(`(() => {
      if (window.__taskPresetE2EControl) window.__taskPresetE2EControl.dispose();
      if (window.__taskPresetOriginalInvoke) require('electron').ipcRenderer.invoke = window.__taskPresetOriginalInvoke;
      document.getElementById('task-preset-e2e-stage')?.remove();
      sessions.delete('task-preset-e2e-session');
      window.__workflowPresetSaved = null;
      window.openWorkflowConfigModal({
        members:[
          {memberId:'m1',kind:'codex',title:'Codex'},
          {memberId:'m2',kind:'claude',title:'Claude'},
          {memberId:'m3',kind:'kimi',title:'Kimi'},
        ],
        config:null,
        onSave(config){ window.__workflowPresetSaved = config; },
      });
      document.querySelector('.wf-switch').click();
      document.querySelector('[data-wf="task-preset"][data-task-preset="task-root-cause-fix"]').click();
    })()`);

    const workflow = await client.eval(`(() => ({
      presetButtons: document.querySelectorAll('[data-wf="task-preset"]').length,
      selected: document.querySelector('[data-task-preset="task-root-cause-fix"]').classList.contains('selected'),
      stepNames: Array.from(document.querySelectorAll('[data-wf-step-name]')).map(el => el.value),
      preview: document.querySelector('.wf-preview')?.innerText || '',
    }))()`);
    assert.strictEqual(workflow.presetButtons, 5, 'serial workflow modal must render five task preset buttons');
    assert.strictEqual(workflow.selected, true, 'workflow task preset must expose selected state');
    assert.deepStrictEqual(workflow.stepNames, ['并行诊断', '最小修复', '独立回归']);
    assert(/并行诊断/.test(workflow.preview) && /独立回归/.test(workflow.preview), 'workflow preview must reflect the generated steps');
    await screenshot(client, WORKFLOW_SHOT);

    const saved = await client.eval(`(() => {
      document.querySelector('.wf-save').click();
      return window.__workflowPresetSaved;
    })()`);
    assert(saved && saved.enabled, 'workflow preset must save as enabled');
    assert.strictEqual(saved.templateId, 'task-root-cause-fix');
    assert.strictEqual(saved.steps.length, 3);
    assert.strictEqual(saved.stepConfigs[1].name, '最小修复');

    console.log(JSON.stringify({
      ok: true,
      isolatedPid: hub.pid,
      port,
      normalSession: single,
      workflow: { presetButtons: workflow.presetButtons, stepNames: workflow.stepNames, savedTemplateId: saved.templateId },
      screenshots: [SINGLE_SHOT, WORKFLOW_SHOT],
    }, null, 2));
  } catch (err) {
    if (hub && typeof hub.log === 'function') {
      console.error('--- isolated hub log tail ---');
      console.error(hub.log().slice(-80).join('\n'));
    }
    throw err;
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub).catch(() => {});
    cleanupDataDir(dataDir);
  }
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
