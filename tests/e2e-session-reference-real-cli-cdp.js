'use strict';
// 「引用会话」真实 CLI 验收：隔离 Hub + 真实 Claude（haiku）+ 真实 Codex（低思考档），
// 权限参数不显式传，走界面新建会话的默认路径。两个源会话是伪造的原生记录，各藏一个暗号；
// 目标会话用真实鼠标点「引用会话」、选源、补一句问题并发送 —— 只有真的读了引用的
// 聊天记录 md（位于 Hub 数据目录，在会话工作目录之外）才答得出暗号。
// 跨 CLI 两个方向：Claude 读 Codex 源、Codex 读 Claude 源。凭据复制进临时目录，finally 删除。
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict'), crypto = require('crypto');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const CLAUDE_MODEL = process.env.REAL_CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const CODEX_MODEL = process.env.REAL_CODEX_MODEL || 'gpt-5.5';
const CODEX_SECRET = 'LAPIS-7731';
const CLAUDE_SECRET = 'CORAL-4452';
const CODEX_SOURCE = 'hub-ref-real-codex-source';
const CLAUDE_SOURCE = 'hub-ref-real-claude-source';

function writeSourceFixtures(root, cwd) {
  const codexRoot = path.join(root, 'fixture-codex-sessions');
  const claudeRoot = path.join(root, 'fixture-claude-projects');
  const codexSid = '019d7777-7777-7777-8777-777777777777';
  const claudeSid = '88888888-8888-4888-8888-888888888888';
  const day = path.join(codexRoot, '2026', '09', '25');
  fs.mkdirSync(day, { recursive: true });
  const codexPath = path.join(day, `rollout-2026-09-25T08-00-00-${codexSid}.jsonl`);
  fs.writeFileSync(codexPath, [
    { timestamp: '2026-09-25T08:00:00Z', type: 'session_meta', payload: { id: codexSid, timestamp: '2026-09-25T08:00:00Z', cwd, source: 'cli', originator: 'codex_cli_rs' } },
    { timestamp: '2026-09-25T08:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: '这次联调约定的暗号是什么？' } },
    { timestamp: '2026-09-25T08:00:02Z', type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: '2026-09-25T08:00:03Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: `约定的暗号是 ${CODEX_SECRET}。`, duration_ms: 1000 } },
  ].map(r => j(r)).join('\n') + '\n', 'utf8');
  const claudeDir = path.join(claudeRoot, 'ref-real');
  fs.mkdirSync(claudeDir, { recursive: true });
  const claudePath = path.join(claudeDir, `${claudeSid}.jsonl`);
  fs.writeFileSync(claudePath, [
    { type: 'user', uuid: 'u1', timestamp: '2026-09-25T09:00:00Z', message: { role: 'user', content: '另一组的暗号定了吗？' } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-09-25T09:00:01Z', message: { role: 'assistant', model: 'claude-haiku', stop_reason: 'end_turn', content: [{ type: 'text', text: `定了，暗号是 ${CLAUDE_SECRET}。` }] } },
  ].map(r => j({ ...r, sessionId: claudeSid, cwd })).join('\n') + '\n', 'utf8');
  return {
    codexRoot, claudeRoot,
    sessions: [
      { schemaVersion: 1, hubId: CODEX_SOURCE, kind: 'codex', title: 'Codex 联调暗号', cwd, codexSid, codexSessionsRoot: codexRoot, transcriptPath: codexPath,
        lastMessageTime: Date.parse('2026-09-25T08:00:03Z'), updatedAt: Date.parse('2026-09-25T08:00:03Z') },
      { schemaVersion: 1, hubId: CLAUDE_SOURCE, kind: 'claude', title: 'Claude 另一组暗号', cwd, ccSessionId: claudeSid, transcriptPath: claudePath,
        lastMessageTime: Date.parse('2026-09-25T09:00:01Z'), updatedAt: Date.parse('2026-09-25T09:00:01Z') },
    ],
  };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ref-real-'));
  const out = path.resolve('output/playwright/session-reference-real-cli'); fs.mkdirSync(out, { recursive: true });
  const claudeSource = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), claudeAuth = path.join(claudeSource, '.credentials.json');
  const codexSource = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), codexAuth = path.join(codexSource, 'auth.json');
  const before = { claude: hash(claudeAuth), codex: hash(codexAuth) };
  const claudeHome = path.join(root, 'claude'), codexHome = path.join(root, 'codex'), cwd = path.join(root, 'workspace'), dataDir = path.join(root, 'data');
  for (const d of [claudeHome, codexHome, cwd, dataDir]) fs.mkdirSync(d, { recursive: true });
  if (fs.existsSync(path.join(codexSource, 'models_cache.json'))) fs.copyFileSync(path.join(codexSource, 'models_cache.json'), path.join(codexHome, 'models_cache.json'));
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = ' + j(CODEX_MODEL) + '\nmodel_reasoning_effort = "low"\n');
  const fixtures = writeSourceFixtures(root, cwd);
  fs.writeFileSync(path.join(dataDir, 'state.json'), j({ version: 1, cleanShutdown: true, sessions: fixtures.sessions, meetings: [], immersiveByMeeting: {} }));
  const result = { root, claudeModel: CLAUDE_MODEL, codexModel: CODEX_MODEL, runs: [], passed: false };
  let hub, c;
  const until = async (expr, label, ms = 180000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.eval(expr)) return; await sleep(300); } throw Error('timeout: ' + label); };
  const click = async (x, y) => {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const centerOf = async selectorExpr => {
    const box = await c.eval(`(() => { const el = ${selectorExpr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; })()`);
    assert.ok(box && box.w > 0, 'element must be visible: ' + selectorExpr);
    return box;
  };

  async function referenceAndAsk({ label, kind, opts, sourceId, secret }) {
    const run = { label, kind, sourceId };
    result.runs.push(run);
    const created = await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind, opts })})`);
    const sid = created.id, q = j(sid);
    run.sessionId = sid;
    await until(`sessions.get(${q})?.nativeRuntime?.connection === 'connected'`, label + ' connected');
    run.runtime = await c.eval(`(() => { const s = sessions.get(${q}); return { backend: s.runtimeBackend, permissionMode: s.nativeRuntime?.permissionMode || null, sandbox: s.nativeRuntime?.sandbox || s.codexSandbox || null }; })()`);
    await c.eval(`document.querySelector('.session-item[data-session-id="${sid}"]').click()`);
    await until(`!!document.querySelector('.floating-input-bar[data-session-id="${sid}"] .fi-bridge-reference') || !!document.querySelector('.fi-bridge-reference')`, label + ' composer');

    const btn = await centerOf("document.querySelector('.fi-bridge-reference')");
    await click(btn.x, btn.y);
    await until(`!!document.querySelector('#gc-fork-picker [data-gc-picker-row="${sourceId}"]')`, label + ' picker');
    const row = await centerOf(`document.querySelector('#gc-fork-picker [data-gc-picker-row="${sourceId}"]')`);
    await click(row.x, row.y);
    await until(`document.querySelector('.floating-input-box').innerText.includes('【引用会话】')`, label + ' reference inserted', 30000);
    run.referenceLine = await c.eval("document.querySelector('.floating-input-box').innerText.trim()");
    run.mdPath = (run.referenceLine.match(/聊天记录：(.+?\.md)/) || [])[1];
    assert.ok(run.mdPath && fs.existsSync(run.mdPath), 'referenced md must exist');
    assert.ok(!path.resolve(run.mdPath).startsWith(path.resolve(cwd)), 'md is outside the session cwd, like production');
    assert.ok(fs.readFileSync(run.mdPath, 'utf8').includes(secret), 'md carries the secret');
    assert.ok(!run.referenceLine.includes(secret), 'the prompt itself must not leak the secret');

    // 真实打字补一句问题，再用鼠标点发送。
    await c.eval("(() => { const box = document.querySelector('.floating-input-box'); box.focus(); placeCaretAtContenteditableEnd(box); })()");
    await c.send('Input.insertText', { text: '只回复这份记录里约定的暗号本身，不要做别的事，不要改任何文件。' });
    const send = await centerOf("document.querySelector('.floating-input-send')");
    await click(send.x, send.y);
    await until(`(() => { const s = sessions.get(${q}); const t = document.querySelector('#msg-overlay')?.innerText || ''; return s?.nativeRuntime?.state === 'completed' && t.includes(${j(secret)}); })()`, label + ' answered with secret', 240000);
    run.answerHasSecret = true;
    const shot = await c.send('Page.captureScreenshot', { format: 'png' });
    run.screenshot = path.join(out, `${Date.now()}-${kind}.png`);
    fs.writeFileSync(run.screenshot, Buffer.from(shot.data, 'base64'));
  }

  try {
    fs.copyFileSync(claudeAuth, path.join(claudeHome, '.credentials.json'));
    fs.copyFileSync(codexAuth, path.join(codexHome, 'auth.json'));
    hub = await launchIsolatedHub({
      dataDir, port: await freePort(), windowMode: 'hidden', label: 'reference real cli', extraEnv: {
        CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '',
        HUB_SESSION_SEARCH_CLAUDE_ROOTS: fixtures.claudeRoot, HUB_SESSION_SEARCH_CODEX_ROOTS: fixtures.codexRoot,
        HUB_SESSION_SEARCH_PREWARM: '1', HUB_SESSION_SEARCH_PREWARM_DELAY_MS: '250',
      },
    });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions !== "undefined" && sessions.size >= 2', 'renderer');

    // 不传 permissionMode / sandbox：与界面新建会话的默认路径一致。
    await referenceAndAsk({ label: 'Claude reads Codex source', kind: 'claude', opts: { cwd, model: CLAUDE_MODEL, effort: 'low', mcpProfile: 'none' }, sourceId: CODEX_SOURCE, secret: CODEX_SECRET });
    await referenceAndAsk({ label: 'Codex reads Claude source', kind: 'codex', opts: { cwd, model: CODEX_MODEL, effort: 'low', mcpProfile: 'none', codexSpeedTier: 'inherit' }, sourceId: CLAUDE_SOURCE, secret: CLAUDE_SECRET });
    result.passed = true;
  } catch (error) {
    result.error = error && error.stack || String(error);
    if (c) { try { const shot = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, `${Date.now()}-fail.png`), Buffer.from(shot.data, 'base64')); } catch {} }
  } finally {
    if (c) { try { c.close(); } catch {} }
    if (hub) await gracefulQuit(hub);
    for (const f of [path.join(claudeHome, '.credentials.json'), path.join(codexHome, 'auth.json')]) { try { fs.rmSync(f, { force: true }); } catch {} }
    result.credentialsUntouched = hash(claudeAuth) === before.claude && hash(codexAuth) === before.codex;
    fs.writeFileSync(path.join(out, `result-${Date.now()}.json`), j(result, null, 2));
    console.log(j(result, null, 2));
  }
  if (!result.passed || !result.credentialsUntouched) process.exit(1);
  console.log('E2E session-reference real CLI: PASS');
}

main().catch(error => { console.error(error); process.exit(1); });
