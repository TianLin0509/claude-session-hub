'use strict';
// 公司收件箱文字中转 · 真实端到端（隔离 Hub + 真实阿里云 + 真实 Claude Haiku）。
// 公司侧：向真实收件箱接口 POST 一段文字（与公司网页发送完全同一个接口）。
// 家里侧：隔离 Hub 的单聊输入框点「拉取」→ 文字进输入框 → 发送给 Haiku →
//        在回答卡片「更多」里点「同步这条消息到公司」→ 收件箱 feed 出现该回答（带「当前回答」标签）。
// 结束时删除本次在服务器上产生的测试记录；生产 Hub 进程与数据不受影响。
// 跑法：node tests/e2e-company-drop-relay-real-cdp.js
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), crypto = require('crypto');
const assert = require('assert/strict');
const { execFileSync } = require('child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { resolveCompanyTextRuntime } = require('../main/ipc/chatgpt-bridge-handlers.js');

const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const port = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const CLAUDE_MODEL = process.env.REAL_CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const CONFIG = path.join(os.homedir(), '.config', 'company-drop', 'config.json');

function relay(args, input) {
  const rt = resolveCompanyTextRuntime({ env: { ...process.env, AI_HUB_COMPANY_TEXT_BACKEND: 'relay' } });
  assert.equal(rt.backend, 'relay', j(rt));
  const out = execFileSync(rt.pythonPath, [rt.scriptPath, ...args], { input: input || '', windowsHide: true, encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
  return JSON.parse(out.trim().split(/\r?\n/).pop());
}

async function api(base, route, init) {
  const res = await fetch(base + 'api/' + route, init);
  return { status: res.status, body: await res.json() };
}

function cleanup(ids) {
  const rt = resolveCompanyTextRuntime({ env: { ...process.env, AI_HUB_COMPANY_TEXT_BACKEND: 'relay' } });
  const code = [
    'import sys, posixpath; sys.path.insert(0, sys.argv[1])',
    'import company_drop as cd',
    'cfg = cd.load_config(cd.DEFAULT_CONFIG); c, s = cd.connect_sftp(cfg); gone = []',
    'for rid in sys.argv[2:]:',
    '    for f in ("up", "done", "down"):',
    '        try: s.remove(posixpath.join(cfg.remote_root + "/relay/" + f, rid + ".json")); gone.append(f + "/" + rid)',
    '        except OSError: pass',
    's.close(); c.close(); print(gone)',
  ].join('\n');
  return execFileSync(rt.pythonPath, ['-c', code, path.dirname(rt.scriptPath), ...ids], { windowsHide: true, encoding: 'utf8' }).trim();
}

async function main() {
  const base = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).base_url.replace(/\/?$/, '/');
  const token = crypto.randomBytes(4).toString('hex');
  const marker = `COMPANY_RELAY_${token}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-company-relay-'));
  const out = path.resolve('artifacts', 'company-relay-real-' + Date.now()); fs.mkdirSync(out, { recursive: true });
  const claudeSource = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), claudeAuth = path.join(claudeSource, '.credentials.json');
  const before = hash(claudeAuth), claudeHome = path.join(root, 'claude'), cwd = path.join(root, 'workspace');
  for (const d of [claudeHome, cwd]) fs.mkdirSync(d);
  const result = { out, marker, checks: [], timings: {}, passed: false }; const created = []; let hub, c;
  const check = (name, extra) => { result.checks.push(name + (extra ? ' · ' + extra : '')); console.log('PASS', name, extra || ''); };
  const until = async (expr, label, ms = 120000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await c.eval(expr); if (v) return v; await sleep(250); } throw Error('timeout: ' + label); };
  const click = async expr => {
    const p = await c.eval(`(()=>{const e=${expr};e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width};})()`);
    assert.ok(p && p.w > 0, 'element must be visible: ' + expr);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
  };
  const snap = async name => { const shot = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64')); };
  try {
    const status = relay(['status']);
    assert.equal(status.service_ok, true, 'relay service online');
    assert.equal(status.pending, 0, '线上已有未取走的公司文字，为避免测试把真实消息拉进隔离 Hub，先停止');
    check('线上中转服务在线且无待取消息');

    const posted = await api(base, 'up', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://me.lt-stockpartner.tech' },
      // 用正常的工作问题：「只回复某暗号」会被模型当成可疑指令拒答（2026-10-07 实测）。
      body: j({ text: `${marker}\n公司同事的问题：用一句中文解释无线通信里的 BSR 是什么。`, client_id: 'e2e-' + token + '-0001' }) });
    assert.equal(posted.status, 200, j(posted)); created.push(posted.body.id);
    check('公司侧提交文字', posted.body.id);

    fs.copyFileSync(claudeAuth, path.join(claudeHome, '.credentials.json'));
    // PTY 的真实 TUI：跳过首次引导（否则停在登录页）；部署 Hub 的 hook（PTY 靠它判断一轮结束）。
    fs.writeFileSync(path.join(claudeHome, '.claude.json'), j({ hasCompletedOnboarding: true, theme: 'dark', projects: {} }));
    require('../core/claude-hook-integration').ensureClaudeHookIntegration({ claudeDir: claudeHome, sourceScriptsDir: path.join(__dirname, '..', 'scripts'), logger: {} });
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await port(), windowMode: 'hidden', label: 'company relay', extraEnv: {
      CLAUDE_CONFIG_DIR: claudeHome, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '' } });
    c = await connectFirstPage(hub); await c.send('Page.bringToFront');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions!=="undefined"', 'renderer');
    const cs = await c.eval(`ipcRenderer.invoke('create-session',${j({ kind: 'claude', opts: { cwd, model: CLAUDE_MODEL, effort: 'low', mcpProfile: 'none' } })})`);
    const q = j(cs.id);
    await until(`!!document.querySelector('.session-item[data-session-id="${cs.id}"]')`, 'session row', 20000);
    await c.eval(`document.querySelector('.session-item[data-session-id="${cs.id}"]').click()`);
    await until('!!document.querySelector(".floating-input-box") && !!document.querySelector(".fi-bridge-pull")', 'composer with pull button');
    // 默认 PTY：等真实 Claude TUI 出现提示符再操作，然后切回卡片视图（田哥日常看到的界面）。
    await c.eval(`applyViewMode('pty')`);
    const screen = `(() => { const t = terminalCache.get(${q})?.terminal; if (!t) return ''; const b = t.buffer.active; let x = ''; for (let i = 0; i < b.length; i++) x += (b.getLine(i)?.translateToString(true) || '') + '\\n'; return x; })()`;
    await until(`(${screen}).match(/❯/)`, 'claude tui ready', 120000);
    await sleep(1500);
    await c.eval(`applyViewMode('card')`);
    const title = await c.eval('document.querySelector(".fi-bridge-pull").title');
    assert.equal(title, '从公司拉取新文字到输入框'); check('拉取按钮文案已去掉 ChatGPT', title);
    await snap('01-before-pull');

    let t = Date.now();
    // 单聊输入框里「拉取」收在「工具」菜单里：先点「工具」，再点「拉取」（田哥实际操作顺序）。
    await click('document.querySelector(".composer-tools-toggle")');
    await until('document.querySelector(".composer-tools-popover") && !document.querySelector(".composer-tools-popover").hidden', 'tools menu open', 5000);
    await click('document.querySelector(".composer-tools-popover .fi-bridge-pull")');
    const toast = await until(`(()=>{const el=document.getElementById('chatgpt-bridge-status');return el&&el.dataset.state!=='working'?{state:el.dataset.state,text:el.textContent}:null})()`, 'pull toast', 60000);
    result.timings.pullMs = Date.now() - t;
    assert.equal(toast.state, 'success', j(toast));
    const boxText = await c.eval('document.querySelector(".floating-input-box").innerText');
    assert.ok(boxText.includes(marker) && boxText.includes('BSR'), boxText);
    check('点「拉取」后文字进入输入框', `${result.timings.pullMs}ms · ${toast.text.replace(/\n/g, ' ')}`);
    await snap('02-pulled-into-input');
    const feed1 = await api(base, 'feed');
    const mine = feed1.body.up.find(m => m.id === posted.body.id);
    assert.equal(mine && mine.status, 'pulled', j(mine)); check('公司页面状态变为已被家里取走');

    t = Date.now();
    await click('document.querySelector(".floating-input-send")');
    await until(`getSessionRuntimeTruth(sessions.get(${q})).state === 'completed'`, 'turn completed', 300000);
    const answerCard = `[...document.querySelectorAll('#msg-overlay .turn-card:not(.user)')].reverse().find(e=>/缓冲|Buffer/i.test(e.innerText))`;
    await until(`!!${answerCard}`, 'haiku answer card', 60000);
    result.answer = await c.eval(`${answerCard}.querySelector('.turn-body').innerText`);
    result.timings.answerMs = Date.now() - t; check('Haiku 收到并回答', `${result.timings.answerMs}ms`);
    await sleep(800); await snap('03-answer');

    const cardExpr = answerCard;
    const pushStarted = `(()=>{const el=document.getElementById('chatgpt-bridge-status');return !!el&&/同步/.test(el.textContent);})()`;
    // 回答刚结束时卡片会重绘一次，可能点到被替换的旧节点：没起作用就重新打开「更多」再点（最多 3 次）。
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await sleep(1000);
      await click(`${cardExpr}.querySelector('.card-actions-more')`);
      await until(`${cardExpr}.querySelector('.card-actions-menu').open`, 'more menu open', 5000);
      t = Date.now();
      await click(`${cardExpr}.querySelector('.ta-company')`);
      const end = Date.now() + 8000; let started = false;
      while (!started && Date.now() < end) { started = await c.eval(pushStarted); if (!started) await sleep(200); }
      result.pushAttempts = attempt;
      if (started) break;
    }
    const pushToast = await until(`(()=>{const el=document.getElementById('chatgpt-bridge-status');return el&&el.dataset.state!=='working'&&/同步/.test(el.textContent)?{state:el.dataset.state,text:el.textContent}:null})()`, 'push toast', 60000);
    result.timings.pushMs = Date.now() - t;
    assert.equal(pushToast.state, 'success', j(pushToast));
    assert.match(pushToast.text, /公司收件箱/);
    check('卡片「同步这条消息到公司」成功', `${result.timings.pushMs}ms · ${pushToast.text.replace(/\n/g, ' ')}`);
    await snap('04-synced-to-company');
    const feed2 = await api(base, 'feed');
    const norm = v => String(v || '').replace(/\s+/g, '');
    const down = feed2.body.down.find(m => m.label === '当前回答' && norm(m.text) === norm(result.answer));
    assert.ok(down, 'answer visible on company page feed: ' + j(feed2.body.down.slice(0, 2)));
    created.push(down.id);
    assert.equal(down.label, '当前回答'); check('公司页面收到回答且带「当前回答」标签', down.text.slice(0, 40));
    result.passed = true;
  } catch (error) {
    result.error = error.stack; process.exitCode = 1;
    if (c) try {
      await snap('99-failure');
      result.diag = await c.eval(`(()=>{const t=document.getElementById('chatgpt-bridge-status');const b=[...document.querySelectorAll('#msg-overlay .ta-company')].map(x=>({text:x.textContent,open:x.closest('details')?.open}));return {toast:t&&{state:t.dataset.state,text:t.textContent},companyButtons:b};})()`);
      console.log('DIAG', JSON.stringify(result.diag));
    } catch {}
  } finally {
    try { if (hub) await gracefulQuit(hub); } catch (e) { result.quitError = e.message; }
    try { fs.unlinkSync(path.join(claudeHome, '.credentials.json')); } catch {}
    assert.equal(hash(claudeAuth), before, 'production credentials untouched');
    try { result.cleanup = cleanup(created); } catch (e) { result.cleanupError = e.message; }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, out, checks: result.checks, timings: result.timings, cleanup: result.cleanup, error: result.error }, null, 2));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
