'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const ROOT = path.resolve(__dirname, '..');
const BRANDED_HUB_EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'AIGroupChatHub.exe');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-groupchat-create-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const WORKSPACE_ROOT = path.join(TEMP_ROOT, 'workspaces');
const FAKE_BIN = path.join(TEMP_ROOT, 'fake-bin');
const CODEX_HOME = path.join(TEMP_ROOT, 'codex-home');
const INVOCATION_LOG = path.join(TEMP_ROOT, 'invocations.jsonl');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'groupchat-create');
const MODAL_SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `groupchat-modal-${RUN_ID}.png`);
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `groupchat-create-${RUN_ID}.png`);

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(address.port));
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

async function pointFor(client, selector) {
  return client.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { found: false, selector: ${JSON.stringify(selector)} };
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      found: true, selector: ${JSON.stringify(selector)}, x, y,
      visible: rect.width > 0 && rect.height > 0 && getComputedStyle(el).display !== 'none',
      topmost: hit === el || el.contains(hit),
      hit: hit && (hit.tagName + '.' + hit.className),
    };
  })()`);
}

async function clickPoint(client, point) {
  assert.equal(point.found, true, `${point.selector} should exist`);
  assert.equal(point.visible, true, `${point.selector} should be visible`);
  assert.equal(point.topmost, true, `${point.selector} should be topmost; hit=${point.hit}`);
  await client.send('Page.bringToFront');
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

function writeFixtures() {
  fs.mkdirSync(FAKE_BIN, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(CODEX_HOME, { recursive: true });
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const fake = path.join(FAKE_BIN, 'fake-cli.js');
  fs.writeFileSync(fake, `'use strict';
const fs = require('node:fs');
const provider = process.argv[2];
fs.appendFileSync(process.env.HUB_GROUPCHAT_E2E_LOG, JSON.stringify({ provider, cwd: process.cwd(), args: process.argv.slice(3) }) + '\\n');
process.stdout.write('FAKE_CLI_READY ' + provider + '\\r\\n');
setInterval(() => {}, 1000);
`, 'utf8');
  for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
    fs.writeFileSync(path.join(FAKE_BIN, `${provider}.cmd`), `@echo off\r\n"${process.execPath}" "${fake}" ${provider} %*\r\n`, 'utf8');
  }
  fs.writeFileSync(path.join(CODEX_HOME, 'config.toml'), [
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
  fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify({
    providers: {
      claude: { backend: 'subscription' },
      codex: {
        backend: 'subscription',
        subscription_profile: 'e2e',
        subscription_profiles: [{ id: 'e2e', label: 'E2E', home: CODEX_HOME }],
      },
    },
  }, null, 2), 'utf8');
}

async function main() {
  writeFixtures();
  const port = await reservePort();
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path';
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'groupchat-create-click',
      executablePath: BRANDED_HUB_EXE,
      extraEnv: {
        AI_HUB_WORKSPACE_ROOT: WORKSPACE_ROOT,
        CODEX_HOME,
        HUB_CODEX_PROFILE: 'e2e',
        HUB_GROUPCHAT_E2E_LOG: INVOCATION_LOG,
        [pathKey]: `${FAKE_BIN}${path.delimiter}${process.env[pathKey] || ''}`,
      },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /index\.html/i.test(target.url || ''));
    await client.send('Runtime.enable');
    await waitFor('standalone group-chat launcher', () => client.eval(
      `!!(document.querySelector('#btn-group-chat') && window.WorkspaceController && window.openMeetingCreateModal)`
    ));
    assert.equal(await client.eval(`require('node:path').basename(process.execPath)`), 'AIGroupChatHub.exe');
    await client.eval(`(() => {
      window.__groupCreateErrors = [];
      window.addEventListener('error', event => window.__groupCreateErrors.push(String(event.error || event.message || 'renderer error')));
      window.addEventListener('unhandledrejection', event => window.__groupCreateErrors.push(String(event.reason || 'unhandled rejection')));
      const { ipcRenderer } = require('electron');
      const originalInvoke = ipcRenderer.invoke.bind(ipcRenderer);
      window.__groupCreateInvokes = [];
      ipcRenderer.invoke = async (...args) => {
        const startedAt = Date.now();
        try {
          const value = await originalInvoke(...args);
          window.__groupCreateInvokes.push({ channel: args[0], ok: true, elapsedMs: Date.now() - startedAt });
          return value;
        } catch (error) {
          window.__groupCreateInvokes.push({ channel: args[0], ok: false, elapsedMs: Date.now() - startedAt, error: String(error && error.message || error) });
          throw error;
        }
      };
      return true;
    })()`);

    await clickPoint(client, await pointFor(client, '#btn-group-chat'));
    try {
      await waitFor('meeting modal', () => client.eval(`document.querySelector('#meeting-create-modal')?.style.display === 'flex'`), 8000);
    } catch (error) {
      const diagnostics = await client.eval(`(async () => {
        const modal = document.querySelector('#meeting-create-modal');
        let meetings = [];
        try { meetings = await require('electron').ipcRenderer.invoke('get-meetings'); } catch {}
        return {
          readyState: document.readyState,
          modalExists: !!modal,
          modalDisplay: modal && modal.style.display,
          meetingCreateApi: typeof window.openMeetingCreateModal,
          workspaceApi: typeof window.WorkspaceController,
          rendererErrors: window.__groupCreateErrors || [],
          invokes: window.__groupCreateInvokes || [],
          sessionItems: document.querySelectorAll('.session-item').length,
          meetingItems: document.querySelectorAll('.meeting-item').length,
          meetings: meetings.length,
          bodyBusy: document.body.getAttribute('aria-busy'),
        };
      })()`);
      console.error(JSON.stringify({ diagnostics, logs: hub.log().slice(-80) }, null, 2));
      throw error;
    }

    const modalShot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(MODAL_SCREENSHOT_PATH, Buffer.from(modalShot.data, 'base64'));

    // Regression: any synchronous DOM problem used to throw before _onCreate's try/catch,
    // leaving the user with a button that appeared to do absolutely nothing.
    await client.eval(`document.querySelector('#meeting-create-modal .mcm-slot .mcm-ai-select').remove()`);
    await clickPoint(client, await pointFor(client, '.mcm-create'));
    const recoveredError = await waitFor('visible synchronous create error', () => client.eval(`(() => {
      const modal = document.querySelector('#meeting-create-modal');
      const error = modal && modal.querySelector('.mcm-error');
      const button = modal && modal.querySelector('.mcm-create');
      if (!error || !button || button.disabled) return null;
      return {
        error: error.textContent,
        buttonText: button.textContent,
        ariaBusy: button.getAttribute('aria-busy'),
        createInvokes: (window.__groupCreateInvokes || []).filter(item => item.channel === 'create-meeting').length,
      };
    })()`));
    assert.match(recoveredError.error, /成员 1 未选择 AI/);
    assert.equal(recoveredError.buttonText, '创建群聊');
    assert.equal(recoveredError.ariaBusy, null);
    assert.equal(recoveredError.createInvokes, 0);

    await client.eval(`window.openMeetingCreateModal('group')`);
    await waitFor('member tuning controls', () => client.eval(`(() => {
      const slots = document.querySelectorAll('#meeting-create-modal .mcm-slot');
      return slots.length === 3
        && slots[0].querySelector('.mcm-fast-checkbox')
        && slots[1].querySelector('.mcm-codex-tier-select')
        && slots[2].querySelector('.mcm-codex-tier-select');
    })()`), 8000);
    const configuredMembers = await client.eval(`(() => {
      const setValue = (el, value) => {
        if (!el || !Array.from(el.options || []).some(option => option.value === value)) {
          throw new Error('missing option ' + value + ' for ' + (el && el.className));
        }
        el.value = value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const slots = Array.from(document.querySelectorAll('#meeting-create-modal .mcm-slot'));
      setValue(slots[0].querySelector('.mcm-effort-select'), 'high');
      setValue(slots[0].querySelector('.mcm-mcp-select'), 'lean');
      const fast = slots[0].querySelector('.mcm-fast-checkbox');
      fast.checked = false;
      fast.dispatchEvent(new Event('change', { bubbles: true }));

      // Codex 成员故意保持所有默认值：本 E2E 直接验证 Sol-Max / 1M /
      // None / Fast 从真实群聊 UI 一路进入 PTY 启动参数。

      setValue(slots[2].querySelector('.mcm-effort-select'), 'medium');
      setValue(slots[2].querySelector('.mcm-mcp-select'), 'wireless');
      setValue(slots[2].querySelector('.mcm-codex-tier-select'), 'flex');
      const research = document.querySelector('#meeting-create-modal input[name="mcm-scene"][value="research"]');
      research.checked = true;
      research.dispatchEvent(new Event('change', { bubbles: true }));

      return slots.map(slot => ({
        kind: slot.querySelector('.mcm-ai-select').value,
        model: slot.querySelector('.mcm-model-select').value,
        effort: slot.querySelector('.mcm-effort-select')?.value || null,
        mcpProfile: slot.querySelector('.mcm-mcp-select')?.value || null,
        fastMode: slot.querySelector('.mcm-fast-checkbox')?.checked ?? null,
        codexSpeedTier: slot.querySelector('.mcm-codex-tier-select')?.value || null,
      }));
    })()`);
    assert.deepEqual(configuredMembers.map(member => ({
      kind: member.kind,
      effort: member.effort,
      mcpProfile: member.mcpProfile,
      fastMode: member.fastMode,
      codexSpeedTier: member.codexSpeedTier,
    })), [
      { kind: 'claude', effort: 'high', mcpProfile: 'lean', fastMode: false, codexSpeedTier: null },
      { kind: 'codex', effort: 'max', mcpProfile: 'none', fastMode: null, codexSpeedTier: 'fast' },
      { kind: 'deepseek', effort: 'medium', mcpProfile: 'wireless', fastMode: null, codexSpeedTier: 'flex' },
    ]);

    const configuredShot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(MODAL_SCREENSHOT_PATH, Buffer.from(configuredShot.data, 'base64'));
    const createPoint = await pointFor(client, '.mcm-create');
    await clickPoint(client, createPoint);

    const result = await waitFor('meeting creation or visible error', () => client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const meetings = await ipcRenderer.invoke('get-meetings');
      const modal = document.querySelector('#meeting-create-modal');
      const error = modal && modal.querySelector('.mcm-error');
      if (!meetings.length && !error) return null;
      return {
        meetingCount: meetings.length,
        meeting: meetings[meetings.length - 1] || null,
        sessions: meetings.length
          ? (await ipcRenderer.invoke('get-sessions')).filter(session => session.meetingId === meetings[meetings.length - 1].id)
          : [],
        modalDisplay: modal && modal.style.display,
        createDisabled: !!modal?.querySelector('.mcm-create')?.disabled,
        createText: modal?.querySelector('.mcm-create')?.textContent || '',
        error: error?.textContent || '',
        invokes: window.__groupCreateInvokes || [],
        rendererErrors: window.__groupCreateErrors || [],
      };
    })()`), 30000);

    const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(shot.data, 'base64'));
    const logs = hub.log().slice(-40);
    assert.ok(!logs.some(line => /installed into Gemini settings\.json/.test(line)),
      'isolated Hub must not rewrite the real user Gemini settings');
    console.log(JSON.stringify({ ok: result.meetingCount > 0 && result.modalDisplay === 'none', recoveredError, createPoint, result, screenshots: { modal: MODAL_SCREENSHOT_PATH, created: SCREENSHOT_PATH }, logs }, null, 2));
    assert.ok(result.meetingCount > 0, `group chat was not created: ${result.error || 'no visible error'}`);
    assert.equal(result.meeting.subSessions.length, 3);
    assert.equal(result.meeting.scene, 'research');
    assert.deepEqual(result.meeting.slotSpecs, [
      {
        index: 0, kind: 'claude', model: configuredMembers[0].model,
        effort: 'high', mcpProfile: 'lean', fastMode: false,
      },
      {
        index: 1, kind: 'codex', model: configuredMembers[1].model,
        effort: 'max', mcpProfile: 'none', codexSpeedTier: 'fast', contextMax: 1_000_000,
      },
      {
        index: 2, kind: 'deepseek', model: configuredMembers[2].model,
        effort: 'medium', mcpProfile: 'wireless', codexSpeedTier: 'flex',
      },
    ]);
    const sessionsByKind = Object.fromEntries(result.sessions.map(session => [session.kind, session]));
    assert.equal(sessionsByKind.claude.effort, 'high');
    assert.equal(sessionsByKind.claude.mcpProfile, 'lean');
    assert.equal(sessionsByKind.claude.fastMode, false);
    assert.equal(sessionsByKind.codex.effort, 'max');
    assert.equal(sessionsByKind.codex.mcpProfile, 'none');
    assert.equal(sessionsByKind.codex.codexSpeedTier, 'fast');
    assert.equal(sessionsByKind.codex.contextMax, 1_000_000);
    assert.equal(sessionsByKind.deepseek.effort, 'medium');
    assert.equal(sessionsByKind.deepseek.mcpProfile, 'wireless');
    assert.equal(sessionsByKind.deepseek.codexSpeedTier, 'flex');

    const invocations = await waitFor('three tuned CLI invocations', () => {
      if (!fs.existsSync(INVOCATION_LOG)) return null;
      const rows = fs.readFileSync(INVOCATION_LOG, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
      return rows.length >= 3 ? rows : null;
    }, 12000);
    const claudeInvocation = invocations.find(row => row.provider === 'claude');
    const codexInvocations = invocations.filter(row => row.provider === 'codex');
    const codexInvocation = codexInvocations.find(row => row.args.includes(configuredMembers[1].model));
    const deepseekInvocation = codexInvocations.find(row => row.args.includes(configuredMembers[2].model));
    const argsText = row => (row && row.args || []).join(' ');
    assert.match(argsText(claudeInvocation), /--effort high/);
    assert.match(argsText(claudeInvocation), /--strict-mcp-config/);
    assert.match(argsText(claudeInvocation), /research-mcp\.json/,
      'Lean must retain the mandatory research MCP config');
    assert.match(argsText(claudeInvocation), /claude-mcp-lean-none\.json/,
      'Lean must add its filtered global MCP config beside the room config');
    assert.doesNotMatch(argsText(claudeInvocation), /claude-subscription-fast-settings/,
      'Claude Fast off must reach the actual group member command');
    assert.match(argsText(codexInvocation), /model_reasoning_effort=.*max/);
    assert.match(argsText(codexInvocation), /model_context_window=1000000/);
    assert.match(argsText(codexInvocation), /features\.fast_mode=true/);
    assert.match(argsText(codexInvocation), /service_tier=.*fast/);
    assert.doesNotMatch(argsText(codexInvocation), /service_tier=.*default/);
    assert.match(argsText(codexInvocation), /mcp_servers\.superran\.enabled=false/);
    assert.match(argsText(codexInvocation), /mcp_servers\.misc\.enabled=false/);
    assert.match(argsText(codexInvocation), /mcp_servers\.playwright\.enabled=false/);
    assert.doesNotMatch(argsText(codexInvocation), /mcp_servers\.ai-team\.command/);
    assert.doesNotMatch(argsText(codexInvocation), /mcp_servers\.arena_research\.command/);
    assert.match(argsText(deepseekInvocation), /model_reasoning_effort=.*medium/);
    assert.match(argsText(deepseekInvocation), /service_tier=.*flex/);
    // DeepSeek 的 Codex API profile 是隔离生成的，本用例没有给它预装全局 MCP；
    // 仍需确认逐成员档位已持久化，且房间必需的 ai-team MCP 没被 Wireless 过滤掉。
    assert.match(argsText(deepseekInvocation), /mcp_servers\.ai-team\.command/);
    assert.match(argsText(deepseekInvocation), /mcp_servers\.arena_research\.command/);
    assert.equal(result.modalDisplay, 'none', 'modal should close after successful creation');
    assert.deepEqual(result.rendererErrors, []);
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub);
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
