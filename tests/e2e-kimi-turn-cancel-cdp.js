'use strict';

// 2026-08-09 回归（隔离 Hub 实例 + CDP），覆盖 fix/kimi-status-and-bp-paste 三项修复：
//   [A①] Kimi ESC 中断：wire 写 turn.cancel（无 step.end、无 tool.result）→ 侧栏应立即
//        回 idle 并清算在跑的 background Agent job；修复前要卡 45min maxAge。
//   [A②] 45min 硬顶改输出续命：hasSemanticCardWorking 期间有 PTY 输出即顺延；
//        50min 无输出仍判卡死；floating_input 的 15s 提交确认窗口不顺延。
//   [B]  浮动输入框对 kimi 走 BP 包裹：多行文本作为一次粘贴发出
//        （\x1b[200~ ... \x1b[201~），不再被换行拆成多次提交。

const fs = require('fs');
const assert = require('node:assert/strict');
const net = require('net');
const os = require('os');
const path = require('path');
const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const RUN_ID = `${Date.now()}-${process.pid}`;
const ROOT = path.join(os.tmpdir(), `hub-kimi-cancel-${RUN_ID}`);
const DATA_DIR = path.join(ROOT, 'hub-data');
const WORKSPACES = path.join(ROOT, 'workspaces');
const FAKE_BIN = path.join(ROOT, 'fake-bin');
const KIMI_HOME = path.join(ROOT, 'kimi-home');
const STDIN_LOG = path.join(ROOT, 'kimi-stdin.log');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitFor(label, fn, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await _waitMs(150);
  }
  throw new Error(`timeout waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function writeFixtures() {
  fs.mkdirSync(FAKE_BIN, { recursive: true });
  fs.mkdirSync(KIMI_HOME, { recursive: true });

  fs.writeFileSync(path.join(FAKE_BIN, 'fake-kimi.js'), `
const fs = require('fs');
const path = require('path');
const home = process.env.KIMI_CODE_HOME;
const stdinLog = process.env.FAKE_KIMI_STDIN_LOG;
const sid = 'e2e-cancel-${RUN_ID}';
const sessionDir = path.join(home, 'sessions', 'e2e-work', sid);
const wire = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
fs.mkdirSync(path.dirname(wire), { recursive: true });
fs.writeFileSync(wire, '', 'utf8');
const append = (record) => fs.appendFileSync(wire, JSON.stringify(record) + '\\n', 'utf8');
// 必须开 VT 输入模式，否则 ConPTY 会把 ESC[200~ 等序列和裸 \\n 在输入侧过滤掉
// （真实 kimi.exe 是 TUI 会自己开；fake 需要显式开才能收到 BP marker）
if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
  try { process.stdin.setRawMode(true); } catch {}
}
process.stdin.on('data', (chunk) => { try { fs.appendFileSync(stdinLog, chunk); } catch {} });
setTimeout(() => {
  fs.mkdirSync(home, { recursive: true });
  fs.appendFileSync(path.join(home, 'session_index.jsonl'), JSON.stringify({
    sessionId: sid, sessionDir, workDir: process.cwd()
  }) + '\\n', 'utf8');
}, 400);
// turn.prompt + 一个 Agent 后台 job + 半截流式输出 —— 没有 step.end（模拟中断前状态）
setTimeout(() => {
  append({ type: 'turn.prompt', input: [{ type: 'text', text: 'do work' }], origin: { kind: 'user' }, time: Date.now() });
  append({ type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 'open-step', turnId: '0', step: 1 }, time: Date.now() });
  append({ type: 'context.append_loop_event', event: {
    type: 'tool.call', stepUuid: 'open-step', toolCallId: 'cancel-job', name: 'Agent',
    args: { description: 'job to be cancelled' }
  }, time: Date.now() });
  append({ type: 'context.append_loop_event', event: {
    type: 'content.part', stepUuid: 'open-step', part: { type: 'text', text: '半截输出' }
  }, time: Date.now() });
}, 1400);
// 用户按 ESC：turn.cancel 是被中断现场的最终记录 —— 没有 step.end、没有 tool.result
setTimeout(() => {
  append({ type: 'turn.cancel', time: Date.now() });
}, 4000);
process.stdout.write('fake kimi ready\\r\\n');
process.stdin.resume();
setInterval(() => {}, 1 << 30);
`, 'utf8');
  fs.writeFileSync(path.join(FAKE_BIN, 'kimi.cmd'),
    `@echo off\r\nnode "${path.join(FAKE_BIN, 'fake-kimi.js')}" %*\r\n`, 'utf8');
}

async function main() {
  writeFixtures();
  fs.mkdirSync(WORKSPACES, { recursive: true });
  const port = await reservePort();
  const hub = await launchIsolatedHub({
    dataDir: DATA_DIR,
    port,
    label: 'kimi-turn-cancel',
    extraEnv: {
      AI_HUB_WORKSPACE_ROOT: WORKSPACES,
      PATH: `${FAKE_BIN};${process.env.PATH}`,
      KIMI_CODE_HOME: KIMI_HOME,
      KIMI_CODE_BIN: path.join(FAKE_BIN, 'kimi.cmd'),
      FAKE_KIMI_STDIN_LOG: STDIN_LOG,
      CLAUDE_HUB_NO_EFFORT_MAX: '1',
      CLAUDE_HUB_E2E: '1',
    },
  });

  let client = null;
  try {
    client = await waitFor('CDP page', async () => {
      try { return await connectFirstPage(hub); } catch { return null; }
    });
    await waitFor('WorkspaceController', () => client.eval(
      '!!(window.WorkspaceController && window.WorkspaceController.createScratch && window.WorkspaceController.createSession)'));
    await waitFor('hook server', () => hub.log().some((line) => line.includes('hook server listening')));

    const kimi = await client.eval(`(async () => {
      const workspace = await window.WorkspaceController.createScratch('kimi-cancel');
      const session = await window.WorkspaceController.createSession('kimi', { workspace });
      return { id: session.id };
    })()`);

    // [前置] turn.prompt 到达 → running，且看到 background Agent job
    // （prompt-submitted 与 background-work-changed 是两条独立 IPC，必须放在同一个
    //   waitFor 谓词里等齐，否则首轮 poll 可能在两条事件之间采样——与
    //   e2e-pty-kimi-regression-cdp.js 的谓词写法保持一致）
    const running = await waitFor('kimi running with background job', () => client.eval(`(() => {
      const s = sessions.get(${JSON.stringify(kimi.id)});
      if (!s || s.status !== 'running') return null;
      const jobs = s._kimiBackgroundJobs ? s._kimiBackgroundJobs.size : -1;
      if (s.cardWorkingSource !== 'kimi_background_agent' || jobs !== 1) return null;
      return { status: s.status, source: s.cardWorkingSource, jobs };
    })()`), 30000);
    assert.strictEqual(running.status, 'running');
    assert.strictEqual(running.jobs, 1, 'Agent tool.call 应登记 1 个后台 job');

    // [A①] turn.cancel → 快速回 idle，清算 job，不置 isWaiting
    const settled = await waitFor('kimi idle after turn.cancel', () => client.eval(`(() => {
      const s = sessions.get(${JSON.stringify(kimi.id)});
      if (!s || s.status === 'running') return null;
      return {
        status: s.status,
        cardWorkingSince: s.cardWorkingSince || null,
        jobs: s._kimiBackgroundJobs ? s._kimiBackgroundJobs.size : -1,
        isWaiting: !!s.isWaiting,
      };
    })()`), 30000);
    assert.strictEqual(settled.status, 'idle', 'turn.cancel 后应立即回 idle');
    assert.strictEqual(settled.cardWorkingSince, null, '工作标记应清空');
    assert.strictEqual(settled.jobs, 0, '被中断的 Agent job 应清算');
    assert.strictEqual(settled.isWaiting, false, '中断后不应标记等你响应');

    // [A②] 续命逻辑（直接在 page 内驱动 hasSemanticCardWorking）
    const lease = await client.eval(`(() => {
      const s = sessions.get(${JSON.stringify(kimi.id)});
      const out = {};
      s.cardWorkingSource = 'rollout_user_message';
      s.cardWorkingSince = Date.now() - 46 * 60 * 1000;
      s._lastOutputTs = Date.now() - 60 * 1000;
      out.extended = hasSemanticCardWorking(s) === true; // 1 分钟前还有输出 → 续命
      s.cardWorkingSince = Date.now() - 46 * 60 * 1000;
      s._lastOutputTs = Date.now() - 50 * 60 * 1000;      // 50 分钟无输出 → 判卡死回收
      out.reclaimed = hasSemanticCardWorking(s) === false && s.cardWorkingSince === null;
      s.cardWorkingSource = 'floating_input';
      s.cardWorkingSince = Date.now() - 20 * 1000;
      s._lastOutputTs = Date.now();                        // floating_input 窗口不顺延
      out.floatingNotExtended = hasSemanticCardWorking(s) === false;
      s.cardWorkingSince = null;
      s.cardWorkingSource = null;
      return out;
    })()`);
    assert.strictEqual(lease.extended, true, '有输出应按最后输出时间续命');
    assert.strictEqual(lease.reclaimed, true, '50min 无输出应判卡死');
    assert.strictEqual(lease.floatingNotExtended, true, 'floating_input 15s 窗口不顺延');

    // [B] 浮动输入框发送多行文本 → fake-kimi stdin 应收到 BP 包裹的单次粘贴
    const sent = await waitFor('floating input mounted', () => client.eval(`(() => {
      const box = document.querySelector('.floating-input-box');
      if (!box) return null;
      box.innerText = '第一行ABC\\n第二行DEF';
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    })()`), 15000);
    assert.strictEqual(sent, true);

    await waitFor('BP-wrapped multi-line payload on kimi stdin', () => {
      try {
        const log = fs.readFileSync(STDIN_LOG, 'utf8');
        const start = log.indexOf('\x1b[200~');
        const end = log.indexOf('\x1b[201~');
        if (start < 0 || end <= start) return null;
        const payload = log.slice(start + '\x1b[200~'.length, end);
        return payload.includes('第一行ABC') && payload.includes('第二行DEF') ? true : null;
      } catch { return null; }
    }, 15000);

    console.log(JSON.stringify({ running, settled, lease, bpWrapped: true }, null, 2));
  } finally {
    if (client) await client.close().catch(() => {});
    await gracefulQuit(hub);
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
