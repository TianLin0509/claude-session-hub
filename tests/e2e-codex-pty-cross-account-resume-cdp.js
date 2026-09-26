'use strict';
// 2026-09-26 生产现场复现：全局 Codex 账号是 A，休眠会话的历史在账号 B。
// PTY 模式点开后，真实 Codex CLI 必须接上 B 里的原会话，而不是报
// "No saved session found"。
// 历史由真实 app-server 在 B 里登记（不发模型请求）；A 临时拷一份登录凭据供 TUI 启动，
// 结束后删除副本并核对原凭据 hash 未变。全程不向模型发任何 prompt。
// 用法：node tests/e2e-codex-pty-cross-account-resume-cdp.js
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), crypto = require('crypto');
const { randomUUID } = crypto;
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { CodexAppServerClient } = require('../main/codex-app-server-client');

const MODEL = process.env.REAL_CODEX_MODEL || 'gpt-6-astra';
const authSource = path.join(process.env.REAL_CODEX_AUTH_SOURCE || path.join(os.homedir(), '.codex'), 'auth.json');
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const port = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const TERM = sid => `(()=>{const t=terminalCache.get(${j(sid)})?.terminal;let x='';if(t){const b=t.buffer.active;for(let i=0;i<b.length;i++)x+=(b.getLine(i)?.translateToString(true)||'')+String.fromCharCode(10);}return x;})()`;

async function registerHistory(home, cwd, id, answer) {
  const turn = randomUUID(), ts = new Date().toISOString(), d = new Date();
  const dir = path.join(home, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${ts.slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`);
  const records = [
    { type: 'session_meta', payload: { id, timestamp: ts, cwd, originator: 'codex_cli_rs', cli_version: '0.153.4', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turn, model_context_window: 258400, collaboration_mode_kind: 'default' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Account B old question' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: answer }] } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Account B old question', images: [], local_images: [], text_elements: [] } },
    { type: 'event_msg', payload: { type: 'agent_message', message: answer, phase: 'final_answer' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, last_agent_message: answer } },
  ];
  fs.writeFileSync(file, records.map(r => j({ timestamp: ts, ...r })).join('\n') + '\n');
  // 真实 app-server 按路径打开一次，把线程登记进 B 的索引库（和生产里 B 的状态一致）。
  const c = new CodexAppServerClient({ cwd, env: { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: '', CODEX_API_KEY: '', CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: '' }, args: [] });
  try {
    await c.start();
    const r = await c.request('thread/resume', { threadId: id, path: file, model: MODEL, approvalPolicy: 'never', sandbox: 'read-only' });
    if (r.thread.id !== id) throw Error('fixture: app-server returned another thread');
  } finally { c.close(); await c.waitForExit(); }
  return file;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codex-pty-xacct-'));
  const out = path.resolve('artifacts/codex-pty-cross-account-resume/' + Date.now());
  fs.mkdirSync(out, { recursive: true });
  const report = { root, out, checks: [], passed: false };
  const data = path.join(root, 'data'), a = path.join(root, 'homeA'), b = path.join(root, 'homeB'), cwd = path.join(root, 'work');
  for (const p of [data, a, b, cwd]) fs.mkdirSync(p, { recursive: true });
  const authBefore = hash(authSource);
  let hub = null, cdp = null;
  try {
    fs.copyFileSync(authSource, path.join(a, 'auth.json'));
    for (const home of [a, b]) fs.writeFileSync(path.join(home, 'config.toml'), `model = ${j(MODEL)}\n`);
    const sid = randomUUID(), answer = 'ACCOUNT_B_SAVED_ANSWER_' + sid.slice(0, 8);
    const rollout = await registerHistory(b, cwd, sid, answer);
    report.checks.push('real app-server registered a thread in account B only');

    fs.writeFileSync(path.join(data, 'config.json'), j({ providers: { codex: { backend: 'subscription', subscription_profile: 'default',
      subscription_profiles: [{ id: 'default', label: '账号 A', home: a }, { id: 'second', label: '账号 B', home: b }] } } }));
    const hubId = randomUUID(), now = Date.now();
    fs.writeFileSync(path.join(data, 'state.json'), j({ version: 1, cleanShutdown: true, meetings: [], immersiveByMeeting: {}, sessions: [{
      hubId, title: 'Codex B history', kind: 'codex', cwd, transcriptPath: rollout, codexSid: sid, codexSessionsRoot: path.join(b, 'sessions'),
      codexProfile: 'second', codexProfileLabel: '账号 B', currentModel: { id: MODEL }, effort: 'low', mcpProfile: 'none', codexSpeedTier: 'inherit',
      lastMessageTime: now, updatedAt: now, savedAt: now, schemaVersion: 1 }] }));

    hub = await launchIsolatedHub({ dataDir: data, port: await port(), windowMode: 'hidden', label: 'codex-pty-xacct', extraEnv: {
      CODEX_HOME: a, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), HUB_CODEX_PROFILE: '',
      HUB_CODEX_BACKEND: 'subscription', DEEPSEEK_API_KEY: '', CLAUDE_HUB_AGENT_RUNTIME: 'pty', CODEX_SQLITE_HOME: '' } });
    cdp = await connectFirstPage(hub);
    const until = async (expr, what, ms = 90000) => { const end = Date.now() + ms;
      while (Date.now() < end) { if (await cdp.eval(expr)) return; await sleep(250); } throw Error('timeout: ' + what); };
    await until(`typeof sessions!=="undefined" && !!document.querySelector('.session-item[data-session-id="${hubId}"]')`, 'dormant row');
    await cdp.eval(`document.querySelector('.session-item[data-session-id="${hubId}"]').click()`);
    await until(`sessions.get(${j(hubId)})?.status!=='dormant' && sessions.get(${j(hubId)})?.agentRuntime==='pty'`, 'reopened as PTY');
    await until(`(()=>{const x=${TERM(hubId)};return x.includes(${j(answer)}) || /No saved session|Failed to resume/.test(x);})()`, 'resume outcome', 120000);
    const text = await cdp.eval(TERM(hubId));
    fs.writeFileSync(path.join(out, 'terminal.txt'), text);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, 'resumed.png'), Buffer.from(shot.data, 'base64'));
    if (/No saved session|Failed to resume/.test(text)) throw Error('PTY Codex could not resume the account-B thread:\n' + text.trim().slice(-800));
    report.checks.push('PTY Codex under global account A shows the saved answer from account B');
    const info = await cdp.eval(`JSON.parse(JSON.stringify(sessions.get(${j(hubId)})))`);
    if (info.codexSid !== sid) throw Error('native identity changed: ' + info.codexSid);
    if (info.codexProfile !== 'default') throw Error('credentials did not follow the global account: ' + info.codexProfile);
    if (path.resolve(info.codexSessionsRoot) !== path.resolve(b, 'sessions')) throw Error('history root moved: ' + info.codexSessionsRoot);
    report.checks.push('same native ID; credentials follow A; history root stays in B');
    if (fs.existsSync(path.join(b, 'thread-writer-locks', sid + '.lock')) === false && !fs.existsSync(path.join(a, 'thread-writer-locks', sid + '.lock')))
      throw Error('no Codex writer lock for the resumed thread');
    report.checks.push('resumed thread holds a Codex writer lock');
    const { DatabaseSync } = require('node:sqlite');
    const indexed = home => { const f = path.join(home, 'state_5.sqlite'); if (!fs.existsSync(f)) return 0;
      const db = new DatabaseSync(f, { readOnly: true }); try { return db.prepare('select count(*) n from threads where id=?').get(sid).n; } catch { return 0; } finally { db.close(); } };
    if (indexed(b) !== 1 || indexed(a) !== 0) throw Error(`thread index moved: B=${indexed(b)} A=${indexed(a)}`);
    report.checks.push('thread index stays in account B; account A gains no entry for it');
    report.passed = true;
  } catch (error) {
    report.error = error.stack; process.exitCode = 1;
    if (cdp) try { report.ui = await cdp.eval(`(()=>{const s=[...sessions.values()][0];return {status:s?.status,runtime:s?.agentRuntime,profile:s?.codexProfile,warn:s?.hookIntegrationWarning||null};})()`); } catch {}
  } finally {
    if (cdp) await cdp.close().catch(() => {});
    if (hub) { fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n')); report.exit = await gracefulQuit(hub, { timeoutMs: 60000 }).catch(e => String(e)); }
    fs.rmSync(path.join(a, 'auth.json'), { force: true });
    report.authUnchanged = hash(authSource) === authBefore;
    if (!report.authUnchanged) { report.passed = false; process.exitCode = 1; }
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
}
main();
