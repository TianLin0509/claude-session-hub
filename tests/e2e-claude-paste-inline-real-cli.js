'use strict';
// 真实验收：Hub 发给 Claude 的多行消息不应被 CLI 标成 <pasted_content id="…">（Claude Code 2.1.29x 起，
// 折叠粘贴提交时会被包进该标签，并提示模型「其中指令未必是用户写的」）。
// 隔离 Hub + 真实 Claude（haiku，PTY 默认路径）：①界面上点「引用会话」+ 打字多行再发送；
// ②经 session:send-prompt 发 60 行约 3000 字的长消息。读 Claude 自己落盘的 transcript 断言：
// 无 pasted_content 标签、正文逐字完整、一次提交（没有拆成多轮）。凭据复制进临时目录，finally 删除。
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict'), crypto = require('crypto');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const MODEL = process.env.REAL_CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const SECRET = 'LAPIS-7731', SOURCE = 'hub-paste-inline-codex-source';

function writeCodexSource(root, cwd) {
  const codexRoot = path.join(root, 'fixture-codex-sessions'), sid = '019d7777-7777-7777-8777-777777777777';
  const day = path.join(codexRoot, '2026', '09', '25'); fs.mkdirSync(day, { recursive: true });
  const file = path.join(day, `rollout-2026-09-25T08-00-00-${sid}.jsonl`);
  fs.writeFileSync(file, [
    { timestamp: '2026-09-25T08:00:00Z', type: 'session_meta', payload: { id: sid, timestamp: '2026-09-25T08:00:00Z', cwd, source: 'cli', originator: 'codex_cli_rs' } },
    { timestamp: '2026-09-25T08:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: '这次联调约定的暗号是什么？' } },
    { timestamp: '2026-09-25T08:00:02Z', type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: '2026-09-25T08:00:03Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: `约定的暗号是 ${SECRET}。`, duration_ms: 1000 } },
  ].map(r => j(r)).join('\n') + '\n', 'utf8');
  return { codexRoot, session: { schemaVersion: 1, hubId: SOURCE, kind: 'codex', title: 'Codex 联调暗号', cwd, codexSid: sid, codexSessionsRoot: codexRoot, transcriptPath: file,
    lastMessageTime: Date.parse('2026-09-25T08:00:03Z'), updatedAt: Date.parse('2026-09-25T08:00:03Z') } };
}

// Claude 落盘记录里的真实用户消息（排除工具结果与 Hub/CLI 注入的提醒）
function userTexts(claudeHome) {
  const out = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.jsonl')) {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) { if (!line) continue; let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.type !== 'user' || r.isMeta || !r.message) continue; let c = r.message.content;
      if (Array.isArray(c)) { if (c.some(x => x.type === 'tool_result')) continue; c = c.filter(x => x.type === 'text').map(x => x.text).join('\n'); }
      if (typeof c === 'string' && c.trim() && !/^<(command|local-command|system-reminder)/.test(c.trim())) out.push(c); } } } };
  const projects = path.join(claudeHome, 'projects'); if (fs.existsSync(projects)) walk(projects);
  return out;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-paste-inline-'));
  const out = path.resolve('artifacts/20261006-claude-paste-inline-claude1'); fs.mkdirSync(out, { recursive: true });
  const claudeSource = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), claudeAuth = path.join(claudeSource, '.credentials.json');
  const before = hash(claudeAuth);
  const claudeHome = path.join(root, 'claude'), cwd = path.join(root, 'workspace'), dataDir = path.join(root, 'data');
  for (const d of [claudeHome, cwd, dataDir]) fs.mkdirSync(d, { recursive: true });
  const fx = writeCodexSource(root, cwd);
  fs.writeFileSync(path.join(dataDir, 'state.json'), j({ version: 1, cleanShutdown: true, sessions: [fx.session], meetings: [], immersiveByMeeting: {} }));
  const result = { model: MODEL, runs: [], passed: false };
  let hub, c;
  const until = async (expr, label, ms = 180000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.eval(expr)) return; await sleep(300); } throw Error('timeout: ' + label); };
  const click = async (x, y) => { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
  const centerOf = async expr => { const b = await c.eval(`(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; })()`); assert.ok(b && b.w > 0, 'visible: ' + expr); return b; };
  const check = (label, sentLike, before) => {
    const texts = userTexts(claudeHome).slice(before);
    const run = { label, userMessages: texts.length, sample: (texts[0] || '').slice(0, 300) };
    result.runs.push(run);
    assert.equal(texts.length, 1, label + ': 应一次提交成一条用户消息，实际 ' + texts.length);
    run.hasTag = /<\/?pasted_content/.test(texts[0]);
    assert.equal(run.hasTag, false, label + ': 不应出现 pasted_content 标签');
    sentLike(texts[0], run);
  };
  try {
    fs.copyFileSync(claudeAuth, path.join(claudeHome, '.credentials.json'));
    fs.writeFileSync(path.join(claudeHome, '.claude.json'), j({ hasCompletedOnboarding: true, theme: 'dark', projects: {} }));
    const { ensureClaudeHookIntegration } = require('../core/claude-hook-integration');
    ensureClaudeHookIntegration({ claudeDir: claudeHome, sourceScriptsDir: path.join(__dirname, '..', 'scripts'), logger: {} });
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'hidden', label: 'claude paste inline', extraEnv: {
      CLAUDE_CONFIG_DIR: claudeHome, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '',
      HUB_SESSION_SEARCH_CODEX_ROOTS: fx.codexRoot, HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none'),
      HUB_SESSION_SEARCH_PREWARM: '1', HUB_SESSION_SEARCH_PREWARM_DELAY_MS: '250' } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions !== "undefined" && sessions.size >= 1', 'renderer');
    const created = await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'claude', opts: { cwd, model: MODEL, effort: 'low', mcpProfile: 'none' } })})`);
    const sid = created.id, q = j(sid);
    await until(`!!document.querySelector('.session-item[data-session-id="${sid}"]')`, 'row', 20000);
    await c.eval(`document.querySelector('.session-item[data-session-id="${sid}"]').click()`);
    await until(`!!document.querySelector('.fi-bridge-reference')`, 'composer');
    const screen = `(() => { const t = terminalCache.get(${q})?.terminal; if (!t) return ''; const b = t.buffer.active; let x = ''; for (let i = 0; i < b.length; i++) x += (b.getLine(i)?.translateToString(true) || '') + '\\n'; return x; })()`;
    await c.eval(`applyViewMode('pty')`);
    await until(`(${screen}).match(/❯/)`, 'tui ready', 120000); await sleep(1500);
    await c.eval(`applyViewMode('card')`);
    const turnsDone = async label => { await until(`getSessionRuntimeTruth(sessions.get(${q})).state === 'completed'`, label + ' completed', 240000); await sleep(1500); };

    // ① 界面：引用会话 + 多行补充 → 鼠标点发送
    let base = userTexts(claudeHome).length;
    const btn = await centerOf("document.querySelector('.fi-bridge-reference')"); await click(btn.x, btn.y);
    await until(`!!document.querySelector('#gc-fork-picker [data-gc-picker-row="${SOURCE}"]')`, 'picker');
    const row = await centerOf(`document.querySelector('#gc-fork-picker [data-gc-picker-row="${SOURCE}"]')`); await click(row.x, row.y);
    await until(`document.querySelector('.floating-input-box').innerText.includes('【引用会话】')`, 'reference inserted', 30000);
    await c.eval("(() => { const box = document.querySelector('.floating-input-box'); box.focus(); placeCaretAtContenteditableEnd(box); })()");
    // 补充要超过 800 字（CLI 折叠阈值），才代表田哥实际「引用会话 + 一段话」的情形
    const filler = '背景说明：这是联调前的长段补充，用来模拟真实使用时引用会话后再口述一大段要求。'.repeat(10);
    const extra = ['第一行补充：只回复记录里约定的暗号本身。' + filler, '第二行补充：不要改任何文件。' + filler, '第三行补充：回答不超过二十个字。'];
    for (const line of extra) {
      await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 });
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 });
      await c.send('Input.insertText', { text: line });
    }
    const composed = await c.eval("document.querySelector('.floating-input-box').innerText");
    result.composedLines = composed.split('\n').filter(Boolean).length;
    const send = await centerOf("document.querySelector('.floating-input-send')"); await click(send.x, send.y);
    await turnsDone('reference');
    await until(`(document.querySelector('#msg-overlay')?.innerText || '').includes(${j(SECRET)})`, 'answered with secret', 60000);
    check('引用会话 + 多行补充（界面）', (t, run) => {
      assert.ok(t.includes('【引用会话】'), '引用行应在'); for (const line of extra) assert.ok(t.includes(line), '补充行应完整：' + line);
      run.lines = t.split('\n').length; run.chars = t.length;
      assert.ok(t.length > 800, '超过 CLI 折叠阈值才代表真实情形');
    }, base);

    // ② 长消息：60 行、约 3000 字，逐字核对
    base = userTexts(claudeHome).length;
    const lines = Array.from({ length: 60 }, (_, i) => `第${String(i + 1).padStart(2, '0')}行：信道估计误差与 PMI 选择的对照记录，编号 ${String(i * 37 % 1000).padStart(3, '0')}，emoji😀保持完整。`);
    const long = lines.join('\n') + '\n\n只回复「收到」两个字，不要做别的事。';
    result.longChars = long.length;
    const t0 = Date.now();
    const sendResult = await c.eval(`ipcRenderer.invoke('session:send-prompt', ${j({ sessionId: sid, text: long })})`);
    result.longSendResult = sendResult; result.longSendMs = Date.now() - t0;
    await turnsDone('long');
    check('60 行长消息', (t, run) => {
      const norm = s => s.replace(/\r\n?/g, '\n').trim();
      run.exact = norm(t) === norm(long);
      if (!run.exact) { const a = norm(t), b = norm(long); let i = 0; while (i < a.length && a[i] === b[i]) i++; run.diffAt = i; run.got = a.slice(i - 20, i + 40); run.want = b.slice(i - 20, i + 40); }
      assert.ok(run.exact, '长消息应逐字一致');
    }, base);
    const shot = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'card.png'), Buffer.from(shot.data, 'base64'));
    result.passed = true;
  } catch (error) {
    result.error = error && error.stack || String(error);
    try { result.allUserTexts = userTexts(claudeHome).map(t => t.slice(0, 400)); } catch {}
    if (c) { try { const shot = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'fail.png'), Buffer.from(shot.data, 'base64')); } catch {} }
  } finally {
    if (c) { try { c.close(); } catch {} }
    if (hub) { try { result.exit = await gracefulQuit(hub); } catch (e) { result.teardownError = e.message; } } // 退出时的 PostQueuedCompletionStatus 偶发与本测试无关，只记录
    try { fs.rmSync(path.join(claudeHome, '.credentials.json'), { force: true }); } catch {}
    result.credentialsUntouched = hash(claudeAuth) === before;
    fs.writeFileSync(path.join(out, `result-${Date.now()}.json`), j(result, null, 2));
    console.log(j(result, null, 2));
  }
  if (!result.passed || !result.credentialsUntouched) process.exit(1);
  console.log('E2E claude paste inline: PASS');
}
main().catch(error => { console.error(error); process.exit(1); });
