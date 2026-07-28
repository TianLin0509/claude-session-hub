'use strict';
// 归档流程的多 CLI 端到端回归：claude / codex / kimi 各开一个 scratch 会话，
// 走真实的 workspace:archive-and-restart，逐项验证跨目录搬迁后上下文没丢。
//
// 覆盖的三个真实故障：
//   claude — transcript 按 cwd 分桶，不迁移则 `--resume` 报 "No conversation found"
//   kimi   — 会校验 workDir，不迁移则 "created under a different directory" 并退出
//   codex  — rollout 按日期存，不该被动到（防回归：别顺手"修"坏了）
//
//   node tests/e2e-archive-multi-cli-cdp.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');
const { kimiWorkspaceKey, toPosix } = require('../core/kimi-session-migrator.js');
const { projectSlug } = require('../core/claude-transcript-locator.js');

const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-archive-multi-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const WORKSPACE_ROOT = path.join(TEMP_ROOT, 'workspaces');
const FAKE_BIN = path.join(TEMP_ROOT, 'fake-bin');
const KIMI_HOME = path.join(TEMP_ROOT, 'kimi-home');
const FAKE_USER_HOME = path.join(TEMP_ROOT, 'fake-home');
const CODEX_HOME = path.join(TEMP_ROOT, 'codex-home');

const CC_SESSION_ID = 'cc-e2e-0001';
const KIMI_SESSION_ID = 'session_e2e_kimi_0001';
const CODEX_SID = 'codex-e2e-0001';

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      server.close(e => (e ? reject(e) : resolve(a.port)));
    });
  });
}

async function waitFor(label, fn, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await _waitMs(150);
  }
  throw new Error(`timeout ${label}${last ? `: ${last.message}` : ''}`);
}

function writeFakeClis() {
  fs.mkdirSync(FAKE_BIN, { recursive: true });
  const js = `'use strict';
process.stdout.write('FAKE_CLI_READY ' + process.argv[2] + '\\r\\n');
process.stdin.resume();
setInterval(() => {}, 1 << 30);
`;
  fs.writeFileSync(path.join(FAKE_BIN, 'fake-cli.js'), js, 'utf8');
  for (const p of ['claude', 'codex', 'kimi', 'gemini']) {
    fs.writeFileSync(path.join(FAKE_BIN, `${p}.cmd`),
      `@echo off\r\nnode "${path.join(FAKE_BIN, 'fake-cli.js')}" ${p}\r\n`, 'utf8');
  }
}

// 在假的 user home 里放一份 claude transcript，模拟"这个会话已经有历史了"
function seedClaudeTranscript(cwd) {
  const bucket = path.join(FAKE_USER_HOME, '.claude', 'projects', projectSlug(cwd));
  fs.mkdirSync(bucket, { recursive: true });
  const file = path.join(bucket, `${CC_SESSION_ID}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', cwd, text: 'e2e-history' })}\n`, 'utf8');
  return file;
}

function seedKimiSession(cwd) {
  const key = kimiWorkspaceKey(cwd);
  const dir = path.join(KIMI_HOME, 'sessions', key, KIMI_SESSION_ID);
  fs.mkdirSync(path.join(dir, 'agents', 'main'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ workDir: toPosix(cwd) }, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'agents', 'main', 'wire.jsonl'), '{"t":"kimi-history"}\n', 'utf8');
  fs.writeFileSync(path.join(KIMI_HOME, 'session_index.jsonl'),
    `${JSON.stringify({ sessionId: KIMI_SESSION_ID, sessionDir: toPosix(dir), workDir: toPosix(cwd) })}\n`, 'utf8');
  fs.writeFileSync(path.join(KIMI_HOME, 'workspaces.json'), JSON.stringify({
    version: 1,
    workspaces: { [key]: { root: toPosix(cwd), name: path.basename(cwd), created_at: 'T0', last_opened_at: 'T0' } },
  }, null, 2), 'utf8');
  return dir;
}

async function main() {
  for (const d of [WORKSPACE_ROOT, KIMI_HOME, FAKE_USER_HOME, CODEX_HOME, path.join(WORKSPACE_ROOT, 'AI')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  writeFakeClis();
  const port = await reservePort();
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'Path';

  const hub = await launchIsolatedHub({
    dataDir: DATA_DIR, port, label: 'archive-multi',
    extraEnv: {
      AI_HUB_WORKSPACE_ROOT: WORKSPACE_ROOT,
      KIMI_CODE_HOME: KIMI_HOME,
      CODEX_HOME,
      USERPROFILE: FAKE_USER_HOME,
      HUB_WORKSPACE_E2E_ALLOW_FALLBACK_RESUME: '1',
      CLAUDE_HUB_NO_EFFORT_MAX: '1',
      [pathKey]: `${FAKE_BIN}${path.delimiter}${process.env[pathKey] || ''}`,
    },
  });

  let client = null;
  const results = {};
  try {
    client = await waitFor('cdp page', async () => {
      try { return await connectFirstPage(hub); } catch { return null; }
    });
    await waitFor('sidebar', () => client.eval('!!document.getElementById("btn-new")'));
    // workspace-controller.js 比侧栏晚装，早一步 eval 会拿到 undefined。
    await waitFor('WorkspaceController', () => client.eval(
      '!!(window.WorkspaceController && window.WorkspaceController.createScratch)'));

    const cases = [
      { kind: 'claude', opts: { resumeCCSessionId: CC_SESSION_ID }, folder: 'archived-claude' },
      { kind: 'codex', opts: { codexSid: CODEX_SID }, folder: 'archived-codex' },
      { kind: 'kimi', opts: { kimiSid: KIMI_SESSION_ID }, folder: 'archived-kimi' },
    ];

    for (const c of cases) {
      const created = await client.eval(`(async () => {
        const ws = await window.WorkspaceController.createScratch(${JSON.stringify(c.kind)});
        const s = await window.WorkspaceController.createSession(${JSON.stringify(c.kind)}, {
          workspace: ws, opts: ${JSON.stringify(c.opts)},
        });
        return { sessionId: s.id, cwd: s.cwd };
      })()`);
      assert.ok(created && created.cwd, `${c.kind}: session must be created`);

      if (c.kind === 'claude') seedClaudeTranscript(created.cwd);
      if (c.kind === 'kimi') seedKimiSession(created.cwd);
      await _waitMs(1200);

      const parent = path.join(WORKSPACE_ROOT, 'AI');
      const archived = await client.eval(`(async () => {
        const { ipcRenderer } = require('electron');
        return await ipcRenderer.invoke('workspace:archive-and-restart', {
          scope: 'session',
          id: ${JSON.stringify(created.sessionId)},
          parent: ${JSON.stringify(parent)},
          folderName: ${JSON.stringify(c.folder)},
        });
      })()`);
      assert.equal(archived && archived.ok, true, `${c.kind}: archive must succeed`);

      const target = path.join(parent, c.folder);
      assert.equal(fs.existsSync(target), true, `${c.kind}: archived directory must exist`);
      assert.equal(fs.existsSync(created.cwd), false, `${c.kind}: scratch directory must be gone`);
      assert.equal(archived.workspace.path, target, `${c.kind}: registry must point at the new path`);
      assert.ok(archived.resumedSessionIds.length >= 1, `${c.kind}: CLI must be resumed`);

      results[c.kind] = { source: created.cwd, target, resumed: archived.resumedSessionIds.length };

      if (c.kind === 'claude') {
        // transcript 必须出现在新 cwd 的桶里，否则 --resume 会 "No conversation found"
        const moved = path.join(FAKE_USER_HOME, '.claude', 'projects', projectSlug(target), `${CC_SESSION_ID}.jsonl`);
        assert.equal(fs.existsSync(moved), true, 'claude: transcript must land in the new cwd bucket');
        assert.match(fs.readFileSync(moved, 'utf8'), /e2e-history/, 'claude: transcript content must survive');
        results.claude.transcript = moved;
      }

      if (c.kind === 'kimi') {
        const newKey = kimiWorkspaceKey(target);
        const newDir = path.join(KIMI_HOME, 'sessions', newKey, KIMI_SESSION_ID);
        assert.equal(fs.existsSync(newDir), true, 'kimi: session dir must move to the new workspace key');
        assert.equal(
          fs.readFileSync(path.join(newDir, 'agents', 'main', 'wire.jsonl'), 'utf8'), '{"t":"kimi-history"}\n',
          'kimi: transcript payload must survive');
        const state = JSON.parse(fs.readFileSync(path.join(newDir, 'state.json'), 'utf8'));
        assert.equal(state.workDir, toPosix(target), 'kimi: state.json workDir must be rewritten');
        const idx = fs.readFileSync(path.join(KIMI_HOME, 'session_index.jsonl'), 'utf8')
          .split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
        const entry = idx.find(e => e.sessionId === KIMI_SESSION_ID);
        assert.equal(entry.workDir, toPosix(target), 'kimi: session_index workDir must be rewritten');
        assert.equal(entry.sessionDir, toPosix(newDir), 'kimi: session_index sessionDir must be rewritten');
        const ws = JSON.parse(fs.readFileSync(path.join(KIMI_HOME, 'workspaces.json'), 'utf8'));
        assert.equal(ws.workspaces[newKey].root, toPosix(target), 'kimi: workspaces.json must register the new root');
        results.kimi.sessionDir = newDir;
      }

      if (c.kind === 'codex') {
        // codex rollout 按日期存，归档不该在 claude 的桶里留下任何东西
        const stray = path.join(FAKE_USER_HOME, '.claude', 'projects', projectSlug(target));
        assert.equal(fs.existsSync(stray), false, 'codex: must not be treated as a cwd-bucketed CLI');
      }
    }

    console.log(JSON.stringify({ ok: true, results }, null, 2));
  } finally {
    if (client) await client.close().catch(() => {});
    await gracefulQuit(hub);
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error('E2E FAILED:', err && err.message);
  if (err && err.logTail) console.error(err.logTail);
  process.exitCode = 1;
});
