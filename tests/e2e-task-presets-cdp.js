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
      stage.innerHTML = '<div style="padding:15px 18px;border-bottom:1px solid var(--border,#30363d);color:var(--text-primary,#e6edf3);font-weight:700">普通 Session · 任务预设 E2E</div><div class="terminal-panel" style="position:absolute;inset:52px 0 0;display:flex;flex-direction:column"><div class="terminal-container" style="flex:1;padding:24px;color:var(--text-secondary,#8b949e)">真实 renderer / 隔离数据目录</div></div>';
      document.body.appendChild(stage);
      const sid = 'task-preset-e2e-session';
      sessions.set(sid, { id:sid, kind:'codex', title:'Codex E2E', status:'active' });
      const terminal = { focus(){}, scrollToBottom(){} };
      const termContainer = stage.querySelector('.terminal-container');
      window.__taskPresetE2EControl = mountFloatingInput(sid, termContainer, terminal);
      const input = stage.querySelector('.floating-input-box');
      input.textContent = '继续，把剩余问题处理完';
      input.dispatchEvent(new Event('input', { bubbles:true }));
      const button = stage.querySelector('[data-preset-id="root-cause-fix"]');
      button.click();
      return {
        buttonCount: stage.querySelectorAll('.fi-preset-chip').length,
        selected: button.getAttribute('aria-pressed'),
        inputText: input.innerText,
        previewName: stage.querySelector('.fi-preset-preview strong').innerText,
        previewText: stage.querySelector('.fi-preset-preview-text').innerText,
        previewVisible: !stage.querySelector('.fi-preset-preview').hidden,
      };
    })()`);
    assert.strictEqual(single.buttonCount, 5, 'normal session must render five presets');
    assert.strictEqual(single.selected, 'true', 'clicked preset must expose selected state');
    assert.strictEqual(single.inputText, '继续，把剩余问题处理完', 'selecting a preset must not rewrite user text');
    assert.strictEqual(single.previewName, '根因修复', 'selected preset preview must be visible');
    assert(single.previewText.includes('复现 → 日志与证据 → 调用链'), 'preview must expose the actual editable constraint');
    assert.strictEqual(single.previewVisible, true, 'preview must be visible before send');
    await screenshot(client, SINGLE_SHOT);

    const reversible = await client.eval(`(() => {
      const stage = document.getElementById('task-preset-e2e-stage');
      const input = stage.querySelector('.floating-input-box');
      const preview = stage.querySelector('.fi-preset-preview-text');
      preview.textContent = '只做最小修复并回归';
      preview.dispatchEvent(new Event('input', { bubbles:true }));
      stage.querySelector('[data-preset-id="root-cause-fix"]').click();
      return {
        inputText: input.innerText,
        previewHidden: stage.querySelector('.fi-preset-preview').hidden,
        selectedCount: stage.querySelectorAll('.fi-preset-chip[aria-pressed="true"]').length,
      };
    })()`);
    assert.strictEqual(reversible.inputText, '继续，把剩余问题处理完', 'toggle-off must preserve the original draft');
    assert.strictEqual(reversible.previewHidden, true, 'clicking the selected preset again must remove it');
    assert.strictEqual(reversible.selectedCount, 0, 'no preset may remain selected after toggle-off');

    await client.eval(`(() => {
      if (window.__taskPresetE2EControl) window.__taskPresetE2EControl.dispose();
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
