'use strict';
// 自动派活会话不出选择题（2026-10-19）真实端到端：
//   node tests/e2e-codeagent-no-choice.js [--part a|b|all] [--out <目录>]
// CodeAgent 用替身 = 真 Claude Code + Haiku（tests/fixtures/codeagent-standin）。公司 Hub = 当前工作区按公司目标导出、以源码方式启动
// （公司版用 PowerShell 跑 hook，ask-gate 走的就是公司真机那条 .ps1 路径）。
// A 部分（单台公司 Hub）：
//   A1 CodeAgent 配置目录里登记了只匹配 AskUserQuestion 的同步 PreToolUse（ask-gate）；按登记的命令原样注入一次 AskUserQuestion 调用：
//      带自动派活标记 → 退出码 2、stderr 是拒绝理由（UTF-8）；不带标记 / 别的工具 / 坏输入 → 放行；
//   A2 通道会话（purpose=company-bridge）：系统提示文件里有「自动派活会话的工作方式」；问一个容易反问的问题，会话不停在选择题上、回答带「假设」；
//   A3 通道会话、但系统提示里没有这条规则（模拟说明层失效），明确要求调用 AskUserQuestion：hook 拒绝，模型收到理由后接着做完；
//   A4 用户自己开的会话：同样要求 → 选择菜单照常弹出（hook 放行）；屏幕识别认出题目和选项（真实 Claude Code 样本另存）。
// B 部分（家里 + 公司两台 Hub + 本机通道服务）：公司关掉强制层、替身丢掉系统提示（模拟两层都没生效）→ 通道会话停在选择菜单上
//   → 公司判「卡在选择题」、把题目和选项报给家里（没有发按键：旧会话仍停在菜单上）→ 家里追问给出选择 → 公司新开会话接着做 → 家里拿到回执。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), assert = require('node:assert/strict');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { createHmac, randomBytes } = require('node:crypto');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { renderRows } = require('../core/hub-phone/session-chat');
const { detectChoiceMenu } = require('../core/choice-menu-screen');
const rules = require('../core/auto-dispatch-rules');
const BRIDGE_TEST_MASTER = require('node:crypto').randomBytes(32).toString('hex'); // 家里隔离实例的本机密钥（只在测试里指定）

const PY = process.env.HUB_E2E_PYTHON || 'C:\\Users\\lintian\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
const RELAY = process.env.HUB_E2E_RELAY || 'C:\\Users\\lintian\\company-drop\\server\\relay_server.py';
const STANDIN = path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd');
const argv = process.argv.slice(2);
const part = argv.includes('--part') ? argv[argv.indexOf('--part') + 1] : 'all';
const repo = path.resolve(__dirname, '..');
const out = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(repo, 'artifacts', '20261019-no-choice-claude1'));
const j = JSON.stringify;
// 回放宽度按终端实际宽度：取输出里最长的一段横线（Claude Code 的分隔线铺满整行）；没有就按 120
const widthOf = text => { const runs = String(text).match(/─{40,}/g); return runs ? Math.max(...runs.map(s => s.length)) : 120; };
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

function standinConfig(dir, extra = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json'), path.join(dir, '.credentials.json'));
  fs.writeFileSync(path.join(dir, '.claude.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true, skipDangerousModePermissionPrompt: true,
    hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true, hasSeenAutoModeEntryWarning: true, theme: 'dark', projects: {} }));
  fs.writeFileSync(path.join(dir, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'haiku', permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true, ...extra }, null, 2));
  return dir;
}
// 原生记录：AskUserQuestion 调用、对应的工具结果、最后一条回答
function readTranscript(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { asks: [], results: [], finalText: '', raw: '' }; }
  const asks = [], results = [], texts = [];
  for (const line of raw.split('\n')) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    const content = o && o.message && Array.isArray(o.message.content) ? o.message.content : [];
    for (const b of content) {
      if (o.type === 'assistant' && b.type === 'tool_use' && b.name === 'AskUserQuestion') asks.push(b);
      if (o.type === 'user' && b.type === 'tool_result') results.push({ id: b.tool_use_id, isError: !!b.is_error, text: typeof b.content === 'string' ? b.content : (b.content || []).map(x => x.text || '').join('\n') });
      if (o.type === 'assistant' && b.type === 'text' && String(b.text || '').trim()) texts.push(String(b.text));
    }
  }
  return { asks, results, finalText: texts.length ? texts[texts.length - 1] : '', raw };
}
const writeSampleFixture = (name, raw) => {
  const dir = path.join(__dirname, 'fixtures', 'choice-menu');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), j(raw));
};

async function exportCompany(root) {
  const exportDir = path.join(root, 'export');
  execFileSync(process.execPath, [path.join(repo, 'scripts', 'community', 'export-community.js'), '--target', 'company', '--ref', 'WORKTREE', '--out', exportDir], { cwd: repo, stdio: 'ignore' });
  execFileSync('cmd.exe', ['/c', 'mklink', '/J', path.join(exportDir, 'node_modules'), path.join(repo, 'node_modules')], { stdio: 'ignore' });
  return exportDir;
}

async function partA(ctx) {
  const { root, check, log, result } = ctx;
  const exportDir = await exportCompany(root);
  check(fs.existsSync(path.join(exportDir, 'core', 'auto-dispatch-rules.js')) && fs.existsSync(path.join(exportDir, 'community-edition.json')), '公司版导出完成（社区版标记在，hook 用 PowerShell 跑）');
  const cac = standinConfig(path.join(root, 'a-cac'));
  const dataDir = path.join(root, 'a-data'), cwd = path.join(root, 'a-work');
  fs.mkdirSync(cwd, { recursive: true });
  const foreignPrompt = path.join(root, 'plain-system.md');
  fs.writeFileSync(foreignPrompt, '你是一个乐于助人的助手。\n');
  let hub, c;
  try {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'background', label: 'nochoice-a', allowExternalState: true, entryPath: exportDir,
      extraEnv: { CLAUDE_HUB_E2E: '1', AI_HUB_CODEAGENT_COMMAND: STANDIN, AI_HUB_CODEAGENT_CONFIG_DIR: cac, CODEAGENT_STANDIN_MODEL: 'haiku', CODEAGENT_STANDIN_NO_CHROME: '1', CLAUDE_HUB_AGENT_RUNTIME: 'pty',
        CLAUDE_HUB_HOME_DIR: path.join(root, 'a-home'), DEEPSEEK_API_KEY: '', ANTHROPIC_API_KEY: '', AI_HUB_RULES_BASE_URL: 'http://127.0.0.1:9/hub-rules/',
        HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none'), HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'none'), AI_HUB_UPDATE_STARTUP_DELAY_MS: '600000' } });
    c = await connectFirstPage(hub);
    const until = async (label, read, timeout = 60000, every = 1000) => { let last; for (const end = Date.now() + timeout; Date.now() < end;) { try { last = await read(); } catch (e) { last = 'ERR ' + e.message; } if (last && !String(last).startsWith('ERR ')) return last; await _waitMs(every); } throw Error('timeout ' + label + ' last=' + j(last).slice(0, 300)); };
    await until('renderer', () => c.eval('typeof sessions!=="undefined" && location.href.includes("index.html")'), 90000, 300);
    const invoke = (channel, arg) => c.eval(`require("electron").ipcRenderer.invoke(${j(channel)}, ${j(arg)})`);

    // ---- A1 hook 登记与注入调用 ----
    const settings = await until('gate deployed', () => { const s = JSON.parse(fs.readFileSync(path.join(cac, 'settings.json'), 'utf8')); return (s.hooks?.PreToolUse || []).find(g => g.matcher === 'AskUserQuestion') ? s : null; }, 30000, 500);
    const gate = settings.hooks.PreToolUse.find(g => g.matcher === 'AskUserQuestion').hooks[0];
    result.gateCommand = gate.command;
    check(/^powershell .*session-hub-hook\.ps1" ask-gate$/.test(gate.command) && gate.async !== true && gate.timeout === 20, 'CodeAgent 配置目录登记了只匹配 AskUserQuestion 的同步 PreToolUse（公司版走 PowerShell 脚本）');
    check(settings.hooks.PreToolUse.some(g => g.matcher === '' && g.hooks.some(h => /tool-start/.test(h.command) && h.async === true)), '原有的异步 tool-start 登记不变');
    // 按登记的命令原样执行（和 CLI 一样经 shell），stdin 是 PreToolUse 的事件 JSON
    const runGate = (env, payload) => spawnSync(gate.command.replace(/\\\\/g, '\\'), { shell: true, input: payload, env: { ...process.env, ...env }, windowsHide: true, timeout: 30000 });
    const askPayload = j({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '选哪个颜色？', options: [{ label: '红' }, { label: '蓝' }] }] } });
    const auto = { AI_HUB_NO_CHOICE: '1', AI_HUB_NO_CHOICE_REASON: rules.DENY_REASON, AI_HUB_NO_CHOICE_TOOLS: 'AskUserQuestion' };
    const denied = runGate(auto, askPayload);
    result.gateDenied = { status: denied.status, stderr: denied.stderr.toString('utf8') };
    check(denied.status === 2 && denied.stderr.toString('utf8') === rules.DENY_REASON, '注入一次 AskUserQuestion 调用：带自动派活标记 → 退出码 2，stderr 是拒绝理由（UTF-8 原文）');
    check(runGate({ AI_HUB_NO_CHOICE: '' }, askPayload).status === 0, '不带标记（用户自己的会话）→ 放行');
    check(runGate(auto, j({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'dir' } })).status === 0, '带标记但是别的工具 → 放行');
    check(runGate(auto, '{坏的 JSON').status === 0, 'hook 读不懂输入 → 放行（不挡工具）');

    const newSession = async (opts, label) => {
      const created = await invoke('create-session', { kind: 'codeagent', opts: { cwd, effort: 'low', mcpProfile: 'none', ...opts } });
      log(`${label} 会话 ${created.id.slice(0, 8)}`);
      await until(label + ' ready', () => c.eval(`(()=>{const s=sessions.get(${j(created.id)});return !!(s && s.ccSessionId && s.transcriptPath)})()`), 150000, 1000).catch(() => null);
      return created.id;
    };
    const send = async (sid, text) => { const r = await invoke('session:send-prompt', { sessionId: sid, text }); assert.ok(r && r.ok !== false, '发送失败 ' + j(r)); };
    const info = sid => c.eval(`(()=>{const s=sessions.get(${j(sid)});return s?{transcriptPath:s.transcriptPath||'',state:getSessionRuntimeTruth(s).state,hubRulesSystem:s.hubRulesSystem||null}:null})()`);
    const waitDone = (sid, label, timeout = 240000) => until(label, async () => { const i = await info(sid); if (!i || i.state !== 'completed' || !i.transcriptPath) return null; const t = readTranscript(i.transcriptPath); return t.finalText ? { ...i, ...t } : null; }, timeout, 2000);
    const screenOf = async sid => { const text = await invoke('get-ring-buffer', sid) || ''; return { text, cols: widthOf(text), rows: 40 }; };

    // ---- A2 通道会话：系统提示带规则，问一个容易反问的问题 ----
    const s2 = await newSession({ purpose: 'company-bridge', title: 'A2 通道会话' }, 'A2');
    const i2 = await info(s2);
    result.a2Rules = i2.hubRulesSystem;
    check(i2.hubRulesSystem && /自动派活规则/.test(i2.hubRulesSystem.label) && i2.hubRulesSystem.fileVersion, '通道会话启动时把「自动派活规则」写进系统提示（会话记录了这一版）');
    const sysFile = path.join(dataDir, 'hub-rules', 'system', `rules-${i2.hubRulesSystem.fileVersion}.md`);
    check(fs.readFileSync(sysFile, 'utf8').includes(rules.NO_CHOICE_RULE), '系统提示文件里是「自动派活会话的工作方式」原文');
    await send(s2, '帮我给团队周会定个时间和形式，直接给出方案就行，不需要读文件或运行命令。');
    const d2 = await waitDone(s2, 'A2 answer');
    result.a2 = { asks: d2.asks.length, results: d2.results.filter(r => d2.asks.some(a => a.id === r.id)), final: d2.finalText.slice(0, 600) };
    check(/假设/.test(d2.finalText), `A2 会话没有停在选择题上，回答里写了假设（${d2.asks.length ? '调用过提问工具、被拒后继续' : '没有调用提问工具'}）`);

    // ---- A3 通道会话、系统提示里没有这条规则：明确要求调用 AskUserQuestion，hook 拒绝后接着做完 ----
    const s3 = await newSession({ purpose: 'company-bridge', title: 'A3 通道会话（无规则）', appendSystemPromptFile: foreignPrompt }, 'A3');
    const i3 = await info(s3);
    check(!i3.hubRulesSystem, 'A3 会话带的是别的系统提示文件，没有写进自动派活规则（模拟说明层失效）');
    await send(s3, '请调用 AskUserQuestion 工具问我一个单选问题：“选哪个颜色？”，选项只有“红”和“蓝”。拿到回答后只回复 COLOR=<选择>；如果没法问，就自己选一个，回复 COLOR=<选择>，并说明你的假设。');
    const d3 = await waitDone(s3, 'A3 answer');
    const deniedResult = d3.results.find(r => d3.asks.some(a => a.id === r.id));
    result.a3 = { asks: d3.asks.length, result: deniedResult || null, final: d3.finalText.slice(0, 400) };
    check(d3.asks.length >= 1, 'A3 模型真的调用了 AskUserQuestion');
    check(deniedResult && deniedResult.isError && deniedResult.text.includes(rules.DENY_REASON), 'hook 拒绝了这次调用，模型收到的工具结果就是拒绝理由');
    check(/COLOR=/.test(d3.finalText), 'A3 拒绝之后模型接着做完，给出了回答（会话没有停在选择题上）');

    // ---- A4 用户自己开的会话：选择菜单照常弹出，屏幕识别认出来 ----
    const s4 = await newSession({ title: 'A4 用户会话' }, 'A4');
    await send(s4, '请调用 AskUserQuestion 工具问我一个单选问题：“选哪个颜色？”，选项只有“红”和“蓝”。拿到我的回答后，只回复 COLOR=<我的选择>。');
    const menu = await until('A4 menu', async () => { const raw = await screenOf(s4); const m = detectChoiceMenu(await renderRows(raw)); return m ? { m, raw } : null; }, 180000, 2000)
      .catch(async error => { // 认不出时把最后一屏和原始输出留下来，对着改规则
        const raw = await screenOf(s4);
        fs.writeFileSync(path.join(out, 'a4-last-screen.txt'), (await renderRows(raw)).join('\n'));
        fs.writeFileSync(path.join(out, 'a4-raw.json'), j(raw));
        throw error;
      });
    writeSampleFixture('claude-code-2.1-askuserquestion.json', { note: '真实 Claude Code（替身，haiku）AskUserQuestion 菜单的终端输出，tests/e2e-codeagent-no-choice.js A4 抓取', version: String(spawnSync('cmd.exe', ['/c', 'claude', '--version'], { encoding: 'utf8', windowsHide: true }).stdout || '').trim(), cols: menu.raw.cols, rows: menu.raw.rows, text: menu.raw.text.slice(-60000) });
    result.a4Menu = menu.m;
    check(/颜色/.test(menu.m.question) && menu.m.options.some(o => /红/.test(o.label)) && menu.m.options.some(o => /蓝/.test(o.label)), `用户会话：选择菜单照常弹出（hook 放行），屏幕识别认出题目「${menu.m.question}」和选项`);
    const t4 = readTranscript((await info(s4)).transcriptPath);
    check(t4.asks.length >= 1 && !t4.results.some(r => r.text.includes(rules.DENY_REASON)), '用户会话的 AskUserQuestion 没有被拒绝');
    check(menu.m.kind === 'question', 'AskUserQuestion 菜单归为「提问」');

    // ---- A5 工具权限确认（不是提问）：用户会话按 default 权限模式启动，让它建目录 → 弹权限确认，识别归为 permission ----
    const s5 = await newSession({ title: 'A5 权限确认', permissionMode: 'default' }, 'A5');
    // （这台电脑装了 Chrome 扩展，非 bypass 模式的 Claude Code 启动时会先问要不要用它：替身加 --no-chrome 跳过，公司 CLI 没有这一问）
    await send(s5, '请用 Bash 工具运行命令 mkdir probe-dir-a5，然后只回复 DONE。');
    const perm = await until('A5 permission', async () => { const raw = await screenOf(s5); const m = detectChoiceMenu(await renderRows(raw)); return m ? { m, raw } : null; }, 180000, 2000)
      .catch(async error => { const raw = await screenOf(s5); fs.writeFileSync(path.join(out, 'a5-last-screen.txt'), (await renderRows(raw)).join('\n')); throw error; });
    writeSampleFixture('claude-code-2.1-permission-bash.json', { note: '真实 Claude Code（替身，haiku，--permission-mode default）Bash 权限确认的终端输出，tests/e2e-codeagent-no-choice.js A5 抓取', cols: perm.raw.cols, rows: perm.raw.rows, text: perm.raw.text.slice(-60000) });
    result.a5Menu = perm.m;
    check(perm.m.kind === 'permission', `工具权限确认归为「权限确认」，不当选择题（题目「${perm.m.question}」）`);
    const shot = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, 'a-company-hub.png'), Buffer.from(shot.data, 'base64'));
  } finally {
    try { c && c.close(); } catch {}
    if (hub) await gracefulQuit(hub).catch(() => {});
    try { fs.rmSync(path.join(cac, '.credentials.json'), { force: true }); } catch {}
  }
}

async function partB(ctx) {
  const { root, check, log, result } = ctx;
  const nonce = randomBytes(3).toString('hex');
  const exportDir = fs.existsSync(path.join(root, 'export')) ? path.join(root, 'export') : await exportCompany(root);
  const relayPort = await freePort();
  const relay = spawn(PY, ['-I', RELAY, '--root', path.join(root, 'relay'), '--port', String(relayPort)], { stdio: 'ignore', windowsHide: true });
  let home, company, hc, cc;
  const cac = standinConfig(path.join(root, 'b-company-cac')), hcac = standinConfig(path.join(root, 'b-home-cac'));
  try {
    for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${relayPort}/health`); if (r.ok) break; } catch {} await _waitMs(200); }
    const apiUrl = `http://127.0.0.1:${relayPort}`;
    const cdata = path.join(root, 'b-company-data'), hdata = path.join(root, 'b-home-data');
    const codeDir = path.join(root, 'b-company-code'); fs.mkdirSync(codeDir, { recursive: true });
    fs.writeFileSync(path.join(codeDir, 'README.md'), '# 端到端测试用的代码目录\n');
    const homeWork = path.join(root, 'b-home-work'); fs.mkdirSync(homeWork, { recursive: true });
    { const { AssistantStore } = require('../core/hub-assistant/store'); const s = new AssistantStore(path.join(cdata, 'company-bridge')); s.set('featureUnlock', { at: Date.now(), via: 'e2e' }); s.db.close(); }
    const common = { CLAUDE_HUB_E2E: '1', DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', CODEX_API_KEY: '', ANTHROPIC_API_KEY: '', CLAUDE_HUB_AGENT_RUNTIME: 'pty',
      HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'empty'), AI_HUB_CODEAGENT_COMMAND: STANDIN, CODEAGENT_STANDIN_MODEL: 'haiku' };
    [home, company] = await Promise.all([
      launchIsolatedHub({ dataDir: hdata, port: await freePort(), windowMode: 'background', label: 'nochoice-home', allowExternalState: true,
        extraEnv: { ...common, CLAUDE_HUB_HOME_DIR: path.join(root, 'b-home-hubhome'), CLAUDE_HUB_BRIDGE_ROLE: 'home', CLAUDE_HUB_E2E_BRIDGE_MASTER: BRIDGE_TEST_MASTER, CLAUDE_HUB_BRIDGE_API_URL: apiUrl, CLAUDE_HUB_WIRELESS_TIMER: '0', AI_HUB_CODEAGENT_CONFIG_DIR: hcac } }),
      // 两层都没生效：强制层关掉、替身丢掉系统提示
      launchIsolatedHub({ dataDir: cdata, port: await freePort(), windowMode: 'background', label: 'nochoice-company', allowExternalState: true, entryPath: exportDir,
        extraEnv: { ...common, CLAUDE_HUB_HOME_DIR: path.join(root, 'b-company-hubhome'), AI_HUB_CODEAGENT_CONFIG_DIR: cac, AI_HUB_UPDATE_STARTUP_DELAY_MS: '600000',
          AI_HUB_CODEAGENT_CHOICE_GATE: '0', CODEAGENT_STANDIN_DROP_SYSTEM_PROMPT: '1' } }),
    ]);
    [hc, cc] = await Promise.all([connectFirstPage(home), connectFirstPage(company)]);
    const until = async (label, read, timeout = 60000, every = 1000) => { let last; for (const end = Date.now() + timeout; Date.now() < end;) { try { last = await read(); } catch (e) { last = 'ERR ' + e.message; } if (last && !String(last).startsWith('ERR ')) return last; await _waitMs(every); } throw Error('timeout ' + label + ' last=' + j(last).slice(0, 300)); };
    const status = c => c.eval('require("electron").ipcRenderer.invoke("bridge:status")');
    await until('renderers', async () => (await hc.eval('typeof sessions!=="undefined" && location.href.includes("index.html")')) && (await cc.eval('typeof sessions!=="undefined" && location.href.includes("index.html")')), 90000, 300);
    const settingsB = JSON.parse(fs.readFileSync(path.join(cac, 'settings.json'), 'utf8'));
    check(!(settingsB.hooks?.PreToolUse || []).some(g => g.matcher === 'AskUserQuestion'), 'B：强制层开关关掉时不登记 ask-gate');
    const { code } = await hc.eval('require("electron").ipcRenderer.invoke("bridge:create-pairing")');
    await cc.eval(`require("electron").ipcRenderer.invoke("bridge:pair", { code: ${j(code)} })`);
    await until('paired', async () => (await status(cc)).link.state === 'paired' && (await status(hc)).link.state === 'paired', 120000, 2000);
    await cc.eval(`require("electron").ipcRenderer.invoke("bridge:set-settings", ${j({ codeRoots: [codeDir], effort: 'low' })})`);
    check(true, 'B：家里与公司配对接通');
    const asker = await hc.eval(`require("electron").ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd: homeWork, title: '家里 · 提问方' } })})`);
    const hsid = asker.id;
    const endpointFile = path.join(hdata, 'company-bridge', 'mcp-endpoint.json');
    // 2026-10-20 起家里的本机密钥只在 Hub 内存里、不再落盘：测试经 CLAUDE_HUB_E2E_BRIDGE_MASTER 让隔离实例用同一把，并核对库里没有明文旧值。
    const master = BRIDGE_TEST_MASTER;
    { const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(path.join(hdata, 'company-bridge', 'assistant.sqlite'), { readOnly: true });
      try { require('node:assert/strict').equal(db.prepare("SELECT value FROM meta WHERE key='localMaster'").get(), undefined, '本机密钥不该明文存在 assistant.sqlite'); } finally { db.close(); } }
    const cliEnv = { ...process.env, HUB_BRIDGE_SESSION_ID: hsid, HUB_BRIDGE_SESSION_PASS: createHmac('sha256', master).update('session:' + hsid).digest('hex'), HUB_BRIDGE_ENDPOINT_FILE: endpointFile };
    const cli = args => { const r = spawnSync(process.execPath, [path.join(repo, 'scripts', 'company-ask.js'), ...args], { env: cliEnv, encoding: 'utf8', windowsHide: true, timeout: 90000 }); return JSON.parse(r.stdout); };
    const qFile = path.join(root, 'b-q1.md');
    fs.writeFileSync(qFile, `这是 AI Hub「卡在选择题」的端到端测试（${nonce}）。不需要读文件、不需要运行命令。请调用 AskUserQuestion 工具问我一个单选问题：“选哪个颜色？”，选项只有“红”和“蓝”。拿到我的回答后，只回复一行 COLOR=<我的选择>-${nonce}。\n`);
    const asked = cli(['ask', '--file', qFile, '--title', '卡在选择题']);
    check(asked.ok, `B：家里发出 ${asked.thread}`);
    const homeRound = (n, label, pick, timeout = 8 * 60000) => until(label, async () => { await hc.eval('require("electron").ipcRenderer.invoke("bridge:check-now")'); const t = (await status(hc)).threads.find(x => x.id === asked.thread); return pick(t && t.rounds[n - 1]); }, timeout, 4000);
    const stuckRound = await homeRound(1, 'home stuck error', r => r && r.error ? r : null);
    result.bStuck = stuckRound.error;
    check(/卡在选择题/.test(stuckRound.error) && /颜色/.test(stuckRound.error) && /红/.test(stuckRound.error) && /蓝/.test(stuckRound.error), 'B：家里收到「卡在选择题」，带回题目和选项');
    check(!/家里/.test(stuckRound.error), 'B：公司报回的说明里没有「家里」字样');
    const cst = await status(cc);
    const ct = cst.threads.find(x => x.id === asked.thread);
    const oldSession = ct.sessionId;
    check(ct.choiceStuckSession === oldSession && ct.rounds[0].choiceStuck, 'B：公司把这一轮标成卡在选择题，记下停住的会话');
    const oldScreen = await cc.eval(`require("electron").ipcRenderer.invoke("get-ring-buffer", ${j(oldSession)})`) || '';
    const oldRows = await renderRows({ text: oldScreen, cols: widthOf(oldScreen), rows: 40 });
    fs.writeFileSync(path.join(out, 'b-old-session-screen.txt'), `cols=${widthOf(oldScreen)} length=${oldScreen.length}\n` + oldRows.join('\n'));
    // 证据用原生记录：提问工具调用了、却没有对应的工具结果 = 没人（公司也没有）替它选。屏幕回放宽度猜不准，只留作附件
    const oldTranscript = await cc.eval(`sessions.get(${j(oldSession)})?.transcriptPath || ''`);
    const ot = readTranscript(oldTranscript);
    result.bOldSession = { asks: ot.asks.length, answered: ot.results.filter(x => ot.asks.some(a => a.id === x.id)).length };
    check(ot.asks.length >= 1 && !ot.results.some(x => ot.asks.some(a => a.id === x.id)), 'B：旧会话的提问一直没有答案（公司没有发按键、没有替它选）');
    const companyLog = fs.readFileSync(path.join(cdata, 'logs', 'company-bridge.log'), 'utf8');
    check(new RegExp(`choice-stuck ${asked.thread}#1`).test(companyLog), 'B：公司通道日志记下 choice-stuck');
    const fFile = path.join(root, 'b-f2.md');
    fs.writeFileSync(fFile, `我选蓝。不用再问我，直接按原来的要求只回复一行 COLOR=蓝-${nonce}。\n`);
    const fu = cli(['followup', '--thread', asked.thread, '--file', fFile]);
    check(fu.ok !== false && fu.round === 2, 'B：家里追问给出选择（第 2 轮）');
    const r2 = await homeRound(2, 'home reply 2', r => r && r.reply ? r : (r && r.error ? 'ERR ' + r.error : null));
    result.bReply = { text: String(r2.reply).slice(0, 300), meta: r2.meta };
    check(new RegExp(`COLOR=蓝-${nonce}`).test(r2.reply) && r2.meta && r2.meta.rehomeKind === 'choice', 'B：公司新开会话接着做，家里拿到回执（元数据写明因选择题新开会话）');
    const ct2 = (await status(cc)).threads.find(x => x.id === asked.thread);
    check(ct2.sessionId && ct2.sessionId !== oldSession && (ct2.prevSessions || []).some(p => p.sessionId === oldSession), 'B：第 2 轮用的是新会话，旧会话记在 prevSessions 里');
    const shot = await cc.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, 'b-company-hub.png'), Buffer.from(shot.data, 'base64'));
  } finally {
    try { hc && hc.close(); } catch {}
    try { cc && cc.close(); } catch {}
    if (home) await gracefulQuit(home).catch(() => {});
    if (company) await gracefulQuit(company, { allowAlreadyExited: true }).catch(() => {});
    try { relay.kill(); } catch {}
    for (const d of [cac, hcac]) { try { fs.rmSync(path.join(d, '.credentials.json'), { force: true }); } catch {} }
  }
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(process.env.HUB_E2E_TMP || 'D:/Temp', 'hub-no-choice-'));
  const t0 = Date.now(); const log = m => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
  const result = { passed: false, part, root, checks: [], scope: '真实 Electron（公司版导出，PowerShell hook）+ CodeAgent 替身（真 Claude Code + Haiku）；B 部分另有家里 Hub 与本机通道服务' };
  const check = (ok, label) => { assert.ok(ok, label); result.checks.push(label); log('✔ ' + label); };
  try {
    if (part === 'a' || part === 'all') await partA({ root, check, log, result });
    if (part === 'b' || part === 'all') await partB({ root, check, log, result });
    result.passed = true;
  } catch (error) {
    result.error = error && error.stack || String(error);
    console.error(result.error);
  } finally {
    fs.writeFileSync(path.join(out, `20261019-no-choice-${part}-result-claude1.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks.length, error: result.error ? String(result.error).split('\n')[0] : null }));
    if (!result.passed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
