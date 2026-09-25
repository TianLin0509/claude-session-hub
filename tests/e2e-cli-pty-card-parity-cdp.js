'use strict';
// 卡片一致性：同一个问题分别在原生回退模式与 PTY 模式的隔离 Hub 里跑一遍，
// 逐项比对卡片结构（角色序列、过程/结果分段、工具行与状态、耗时、结局），并各截一张图。
// 用法：node tests/e2e-cli-pty-card-parity-cdp.js [--only=claude|codex]
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), crypto = require('crypto');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { ensureClaudeHookIntegration } = require('../core/claude-hook-integration');

const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const ONLY = process.argv.slice(2).find(a => a.startsWith('--only='))?.slice(7) || null;
const CLAUDE_MODEL = process.env.REAL_CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const CODEX_MODEL = process.env.REAL_CODEX_MODEL || 'gpt-5.5';
const port = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const PROMPT = {
  claude: '先用一句话说明你要做什么，然后用 Bash 工具分两次调用，依次运行 `echo ALPHA` 和 `echo BETA`，最后只回复 PARITY_DONE。',
  codex: '先用一句话说明你要做什么，然后分两次执行 shell 命令 `echo ALPHA` 和 `echo BETA`，最后只回复 PARITY_DONE。',
};

function shape(turns) {
  return turns.map(t => ({
    role: t.role,
    phases: (t.displayMessages || []).map(m => m.phase),
    tools: (t.toolCalls || []).map(x => ({ status: x.status || (x.result != null || x.output != null ? 'completed' : null),
      hasDuration: Number.isFinite(x.durationMs), hasInput: x.input != null, hasOutput: (x.output ?? x.result) != null })),
    outcome: t.nativeOutcome || null,
    hasModel: !!t.model, hasUsage: !!t.usage, text: String(t.text || '').slice(0, 80),
  }));
}

async function runOnce({ mode, provider, root, out, claudeHome, codexHome, cwd }) {
  const dataDir = path.join(root, `data-${mode}-${provider}`);
  const extraEnv = { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'),
    DEEPSEEK_API_KEY: '', ...(mode === 'native' ? { CLAUDE_HUB_AGENT_RUNTIME: 'native' } : {}) };
  const hub = await launchIsolatedHub({ dataDir, port: await port(), windowMode: 'hidden', label: `parity ${mode} ${provider}`, extraEnv });
  let c;
  const until = async (expr, label, ms = 180000) => { const end = Date.now() + ms;
    while (Date.now() < end) { if (await c.eval(expr)) return; await sleep(200); } throw Error('timeout: ' + label); };
  try {
    c = await connectFirstPage(hub);
    await c.send('Page.bringToFront');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions!=="undefined"', 'renderer');
    const opts = provider === 'claude'
      ? { cwd, model: CLAUDE_MODEL, effort: 'low', mcpProfile: 'none', fastMode: false, permissionMode: 'bypassPermissions' }
      : { cwd, model: CODEX_MODEL, effort: 'low', mcpProfile: 'none', codexSpeedTier: 'inherit' };
    const s = await c.eval(`ipcRenderer.invoke('create-session',${j({ kind: provider, opts })})`);
    const q = j(s.id);
    await until(`!!document.querySelector('.session-item[data-session-id=${j(s.id)}]')`, 'row', 20000);
    await c.eval(`document.querySelector('.session-item[data-session-id=${j(s.id)}]').click()`);
    await until('!!document.querySelector(".floating-input-box")', 'composer');
    if (mode === 'pty') {
      await c.eval(`applyViewMode('pty')`);
      await until(`(()=>{const t=terminalCache.get(${q})?.terminal;if(!t)return false;const b=t.buffer.active;let x='';for(let i=0;i<b.length;i++){x+=b.getLine(i)?.translateToString(true)+'\\n';}return ${provider === 'claude' ? "/❯/.test(x)" : "/›|context left|Context/i.test(x)"};})()`, 'tui ready', 120000);
      await sleep(1500);
    } else {
      await until(`['idle','completed'].includes(sessions.get(${q})?.nativeRuntime?.state) || sessions.get(${q})?.nativeRuntime?.connection==='connected'`, 'native connected', 120000);
    }
    await c.eval(`(()=>{const box=document.querySelector(".floating-input-box");box.textContent=${j(PROMPT[provider])};box.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector(".floating-input-send").click();})()`);
    await until(`getSessionRuntimeTruth(sessions.get(${q})).state==='completed'`, 'completed', 240000);
    await c.eval(`applyViewMode('card')`);
    await until(`document.querySelector('#msg-overlay').innerText.includes('PARITY_DONE')`, 'card text', 60000);
    await sleep(1500);
    const turns = await c.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${q},opts:{limit:10,fromTail:true}}).then(r=>r.turns)`);
    const dom = await c.eval(`[...document.querySelectorAll('#msg-overlay .turn-card')].map(e=>({cls:e.className,phase:e.dataset.phase||null,text:(e.querySelector('.turn-body')?.innerText||'').slice(0,60),toolRows:e.querySelectorAll('.tool-row,.turn-tool-row,[data-tool-id]').length}))`);
    const shot = await c.send('Page.captureScreenshot', { format: 'png' });
    const png = path.join(out, `${provider}-${mode}.png`);
    fs.writeFileSync(png, Buffer.from(shot.data, 'base64'));
    return { mode, provider, shape: shape(turns), dom, png };
  } finally {
    try { await gracefulQuit(hub); } catch {}
  }
}

function compare(native, pty) {
  const diffs = [];
  const n = native.shape, p = pty.shape;
  if (n.map(t => t.role).join() !== p.map(t => t.role).join()) diffs.push(`roles: native=${n.map(t => t.role)} pty=${p.map(t => t.role)}`);
  const na = n.filter(t => t.role === 'assistant').at(-1) || {}, pa = p.filter(t => t.role === 'assistant').at(-1) || {};
  if ((na.phases || []).includes('final_answer') !== (pa.phases || []).includes('final_answer')) diffs.push('final_answer phase');
  if ((na.phases || []).includes('commentary') !== (pa.phases || []).includes('commentary')) diffs.push('commentary phase');
  if ((na.tools || []).length !== (pa.tools || []).length) diffs.push(`tool rows: native=${(na.tools || []).length} pty=${(pa.tools || []).length}`);
  for (const key of ['status', 'hasDuration', 'hasInput', 'hasOutput']) {
    const nv = (na.tools || []).map(t => t[key]).join(), pv = (pa.tools || []).map(t => t[key]).join();
    if (nv !== pv) diffs.push(`tool ${key}: native=${nv} pty=${pv}`);
  }
  for (const key of ['outcome', 'hasModel', 'hasUsage']) if (na[key] !== pa[key]) diffs.push(`${key}: native=${na[key]} pty=${pa[key]}`);
  return diffs;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-card-parity-'));
  const out = path.resolve('artifacts/cli-pty-core/card-parity-' + Date.now());
  fs.mkdirSync(out, { recursive: true });
  const claudeAuth = path.join(os.homedir(), '.claude', '.credentials.json');
  const codexSource = path.join(os.homedir(), '.codex'), codexAuth = path.join(codexSource, 'auth.json');
  const before = { claude: hash(claudeAuth), codex: hash(codexAuth) };
  const claudeHome = path.join(root, 'claude'), codexHome = path.join(root, 'codex'), cwd = path.join(root, 'workspace');
  for (const d of [claudeHome, codexHome, cwd]) fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(claudeAuth, path.join(claudeHome, '.credentials.json'));
  fs.writeFileSync(path.join(claudeHome, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark',
    bypassPermissionsModeAccepted: true, skipDangerousModePermissionPrompt: true, projects: {} }));
  ensureClaudeHookIntegration({ claudeDir: claudeHome, sourceScriptsDir: path.join(__dirname, '..', 'scripts'), logger: {} });
  fs.copyFileSync(codexAuth, path.join(codexHome, 'auth.json'));
  if (fs.existsSync(path.join(codexSource, 'models_cache.json'))) fs.copyFileSync(path.join(codexSource, 'models_cache.json'), path.join(codexHome, 'models_cache.json'));
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = ' + j(CODEX_MODEL) + '\nmodel_reasoning_effort = "low"\n');
  const report = { out, results: [], comparisons: {}, passed: false };
  try {
    for (const provider of ['claude', 'codex']) {
      if (ONLY && ONLY !== provider) continue;
      const pair = {};
      for (const mode of ['native', 'pty']) {
        try { pair[mode] = await runOnce({ mode, provider, root, out, claudeHome, codexHome, cwd }); }
        catch (error) { pair[mode] = { mode, provider, error: String(error.stack || error).slice(0, 1500) }; }
        report.results.push(pair[mode]);
        console.log(`[parity] ${provider} ${mode} ${pair[mode].error ? 'FAILED: ' + pair[mode].error.split('\n')[0] : 'ok'}`);
      }
      report.comparisons[provider] = pair.native?.shape && pair.pty?.shape ? compare(pair.native, pair.pty) : ['run failed'];
      console.log(`[parity] ${provider} diffs: ${j(report.comparisons[provider])}`);
    }
    report.passed = Object.values(report.comparisons).every(d => !d.includes('run failed'));
  } finally {
    for (const [file, key] of [[path.join(claudeHome, '.credentials.json'), 'claude'], [path.join(codexHome, 'auth.json'), 'codex']]) {
      try { fs.unlinkSync(file); } catch {}
      report[key + 'CredentialsUntouched'] = hash(key === 'claude' ? claudeAuth : codexAuth) === before[key];
    }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.passed, out, comparisons: report.comparisons }, null, 2));
    if (!report.passed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
