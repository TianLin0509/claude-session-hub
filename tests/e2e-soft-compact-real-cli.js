'use strict';
// 软压缩真机链路：隔离 Hub + 真实 PTY Claude（haiku）。软线压到 1000 token，
// 让用户目录下的提醒钩子（soft-compact-reminder）在第一次工具调用后就注入提醒；
// 断言 AI 自己在回复末尾留标记 → Hub 发 /compact → 压缩完成 → 带 -continue 时 Hub 发一次「继续」。
// 凭据复制进隔离目录、结束后删除；不碰生产 Hub。
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict'), crypto = require('crypto');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { CONTINUE_PROMPT } = require('../main/soft-compact-controller');
const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const MODEL = process.env.REAL_CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
// SOFT_COMPACT_E2E_MODE=continue：用户直接要求留 -continue 标记，专测「压缩后自动继续」分支。
const FORCE_CONTINUE = process.env.SOFT_COMPACT_E2E_MODE === 'continue';
const REMINDER = process.env.SOFT_COMPACT_REMINDER || path.join(os.homedir(), '.claude', 'scripts', 'soft-compact-reminder.py');

// Claude 落盘记录：真实用户消息、assistant 文本、压缩边界
function readTranscript(claudeHome) {
  const out = { users: [], assistants: [], compactBoundaries: 0 };
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.jsonl')) {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) { if (!line) continue; let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.type === 'system' && r.subtype === 'compact_boundary') out.compactBoundaries++;
      if (!r.message || r.isMeta || r.isCompactSummary) continue;
      let c = r.message.content;
      if (Array.isArray(c)) { if (c.some(x => x.type === 'tool_result')) continue; c = c.filter(x => x.type === 'text').map(x => x.text).join('\n'); }
      if (typeof c !== 'string' || !c.trim()) continue;
      if (r.type === 'user' && !/^<(command|local-command|system-reminder)/.test(c.trim())) out.users.push(c);
      if (r.type === 'assistant') out.assistants.push(c); } } } };
  const projects = path.join(claudeHome, 'projects'); if (fs.existsSync(projects)) walk(projects);
  return out;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-soft-compact-'));
  const out = path.resolve('artifacts/20261021-soft-compact-claude1'); fs.mkdirSync(out, { recursive: true });
  const claudeSource = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), claudeAuth = path.join(claudeSource, '.credentials.json');
  const before = hash(claudeAuth);
  const claudeHome = path.join(root, 'claude'), cwd = path.join(root, 'workspace'), dataDir = path.join(root, 'data'), stateDir = path.join(root, 'soft-state');
  for (const d of [claudeHome, cwd, dataDir]) fs.mkdirSync(d, { recursive: true });
  const result = { model: MODEL, passed: false, checks: [] };
  let hub, c;
  const until = async (expr, label, ms = 180000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.eval(expr)) return; await sleep(300); } throw Error('timeout: ' + label); };
  const untilDisk = async (fn, label, ms = 300000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn(readTranscript(claudeHome))) return; await sleep(1000); } throw Error('timeout: ' + label); };
  try {
    fs.copyFileSync(claudeAuth, path.join(claudeHome, '.credentials.json'));
    fs.writeFileSync(path.join(claudeHome, '.claude.json'), j({ hasCompletedOnboarding: true, theme: 'dark', projects: {} }));
    const { ensureClaudeHookIntegration } = require('../core/claude-hook-integration');
    ensureClaudeHookIntegration({ claudeDir: claudeHome, sourceScriptsDir: path.join(__dirname, '..', 'scripts'), logger: {} });
    const settingsFile = path.join(claudeHome, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings.permissions = { ...(settings.permissions || {}), allow: ['Bash(echo:*)'] };
    settings.hooks.PostToolUse = [...(settings.hooks.PostToolUse || []), { matcher: '*', hooks: [{ type: 'command', command: `python "${REMINDER}"` }] }];
    fs.writeFileSync(settingsFile, j(settings, null, 2));
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'hidden', label: 'soft compact', extraEnv: {
      CLAUDE_CONFIG_DIR: claudeHome, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '',
      SOFT_COMPACT_SOFT_TOKENS: '1000', SOFT_COMPACT_HARD_TOKENS: '801000', SOFT_COMPACT_STATE_DIR: stateDir } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions !== "undefined"', 'renderer');
    await c.eval(`(() => { window.__toasts = []; const original = showToast; showToast = (message, level) => { window.__toasts.push(String(message)); return original(message, level); }; })()`);
    const created = await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'claude', opts: { cwd, model: MODEL, effort: 'low', mcpProfile: 'none' } })})`);
    const sid = created.id, q = j(sid);
    await until(`!!document.querySelector('.session-item[data-session-id="${sid}"]')`, 'row', 20000);
    await c.eval(`document.querySelector('.session-item[data-session-id="${sid}"]').click()`);
    const screen = `(() => { const t = terminalCache.get(${q})?.terminal; if (!t) return ''; const b = t.buffer.active; let x = ''; for (let i = 0; i < b.length; i++) x += (b.getLine(i)?.translateToString(true) || '') + '\\n'; return x; })()`;
    await until(`!!terminalCache.get(${q})`, 'terminal', 60000);
    await c.eval(`applyViewMode('pty')`);
    await until(`(${screen}).match(/❯/)`, 'tui ready', 120000); await sleep(1500);
    await c.eval(`applyViewMode('card')`);

    // 默认是普通任务，不提标记：标记只能来自钩子注入的提醒。
    const prompt = FORCE_CONTINUE
      ? '只回复一句「第一阶段完成」，并在最后单独一行原样写 [[hub:compact-continue]]。'
      : '用 Bash 工具运行 echo STEP1_OK，然后告诉我输出是什么。';
    result.forceContinue = FORCE_CONTINUE;
    const sendResult = await c.eval(`ipcRenderer.invoke('session:send-prompt', ${j({ sessionId: sid, text: prompt })})`);
    result.sendResult = sendResult;
    assert.ok(sendResult && sendResult.ok !== false, '消息已发出：' + j(sendResult));
    await untilDisk(t => t.assistants.some(a => /\[\[hub:compact(-continue)?\]\]/.test(a)), 'AI 按提醒留下标记', 240000);
    const marked = readTranscript(claudeHome).assistants.find(a => /\[\[hub:compact(-continue)?\]\]/.test(a));
    result.markedReply = marked.slice(-300);
    const mode = /\[\[hub:compact-continue\]\]/.test(marked) ? 'continue' : 'wait';
    result.mode = mode;
    result.checks.push((FORCE_CONTINUE ? '按用户要求' : '提醒钩子在真实工具调用后注入，AI 自己') + '在回复末尾留了标记：' + mode);
    if (FORCE_CONTINUE) assert.equal(mode, 'continue');

    await untilDisk(t => t.compactBoundaries >= 1, 'Hub 自动发 /compact 并完成压缩', 300000);
    result.checks.push('Hub 自动发送 /compact，transcript 出现压缩边界');
    if (mode === 'continue') {
      await untilDisk(t => t.users.some(u => u.includes(CONTINUE_PROMPT)), '压缩后自动发继续', 120000);
      // 隔离环境只放行 echo，AI 去读进展卡会停在权限确认；这里只要求它在「继续」之后开始干活。
      await untilDisk(t => t.users.at(-1)?.includes(CONTINUE_PROMPT) && t.assistants.length >= 2, '继续后 AI 开始回复', 120000);
      result.checks.push('压缩完成后 Hub 自动发了「继续」，AI 接着回复');
    }
    await sleep(3000);
    const t = readTranscript(claudeHome);
    result.compactBoundaries = t.compactBoundaries;
    result.continuePrompts = t.users.filter(u => u.includes(CONTINUE_PROMPT)).length;
    result.lastReply = (t.assistants.at(-1) || '').slice(0, 300);
    result.toasts = await c.eval('window.__toasts');
    assert.equal(t.compactBoundaries, 1, '只压缩一次（冷却期防连环压缩）');
    assert.equal(result.continuePrompts, mode === 'continue' ? 1 : 0, '继续只发一次');
    assert.ok(result.toasts.some(x => x.includes('正在自动压缩')), '界面提示了正在自动压缩');
    assert.ok(result.toasts.some(x => x.includes('已自动压缩')), '界面提示了压缩完成');
    const shot = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'card.png'), Buffer.from(shot.data, 'base64'));
    result.passed = true;
  } catch (error) {
    result.error = error && error.stack || String(error);
    try { const t = readTranscript(claudeHome); result.users = t.users.map(x => x.slice(0, 200)); result.assistants = t.assistants.map(x => x.slice(-300)); result.compactBoundaries = t.compactBoundaries; } catch {}
    if (c) { try { result.toasts = await c.eval('window.__toasts'); const shot = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'fail.png'), Buffer.from(shot.data, 'base64')); } catch {} }
  } finally {
    if (c) { try { c.close(); } catch {} }
    if (hub) { try { result.exit = await gracefulQuit(hub); } catch (e) { result.teardownError = e.message; } }
    try { fs.rmSync(path.join(claudeHome, '.credentials.json'), { force: true }); } catch {}
    result.credentialsUntouched = hash(claudeAuth) === before;
    fs.writeFileSync(path.join(out, `result-${Date.now()}.json`), j(result, null, 2));
    console.log(j(result, null, 2));
  }
  if (!result.passed || !result.credentialsUntouched) process.exit(1);
  console.log('E2E soft compact: PASS');
}
main().catch(error => { console.error(error); process.exit(1); });
