'use strict';
// 诊断：在指定入口（源码或公司版导出目录）的隔离 Hub 里，开一个家里联动用途（只读）的 CodeAgent 会话，
// 发一句话，打印终端里敲出的启动命令和屏幕内容。用法：node tests/probe-company-bridge-codeagent.js [入口目录]
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
(async () => {
  const entry = process.argv[2] || null;
  const root = fs.mkdtempSync(path.join(process.env.HUB_E2E_TMP || os.tmpdir(), 'bridge-probe-'));
  const cac = path.join(root, '.cac'), cwd = path.join(root, 'code'), data = path.join(root, 'data');
  for (const d of [cac, cwd, data]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'a.c'), '#define N 16\n');
  fs.copyFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json'), path.join(cac, '.credentials.json'));
  fs.writeFileSync(path.join(cac, '.claude.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true, skipDangerousModePermissionPrompt: true,
    hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true, hasSeenAutoModeEntryWarning: true, theme: 'dark', projects: {} }));
  fs.writeFileSync(path.join(cac, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
  fs.writeFileSync(path.join(cac, 'settings.json'), j({ permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }));
  const hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), windowMode: 'background', label: 'probe', allowExternalState: true, ...(entry ? { entryPath: entry } : {}),
    extraEnv: { AI_HUB_CODEAGENT_COMMAND: path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: cac, CODEAGENT_STANDIN_MODEL: 'haiku',
      CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', CLAUDE_HUB_AGENT_RUNTIME: 'pty' } });
  const c = await connectFirstPage(hub);
  try {
    for (let i = 0; i < 100 && !(await c.eval('typeof sessions !== "undefined"')); i++) await sleep(300);
    const created = await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd, purpose: 'company-bridge', autonomous: true, noInheritCursor: true, effort: 'low' } })})`);
    const q = j(created.id);
    const screen = buf => `(() => { const t = terminalCache.get(${q})?.terminal; if (!t) return ''; const b = t.buffer.${buf}; let x = ''; for (let i = 0; i < b.length; i++) x += (b.getLine(i)?.translateToString(true) || '') + '\\n'; return x; })()`;
    await c.eval(`selectSession(${q})`); await c.eval(`applyViewMode('pty')`);
    await sleep(25000);
    const send = await c.eval(`ipcRenderer.invoke('session:send-prompt', ${j({ sessionId: created.id, text: '只回复 PROBE-OK，不要做别的事。' })})`);
    await sleep(30000);
    console.log('--- send receipt', j(send));
    console.log('--- typed (normal)'); console.log((await c.eval(screen('normal'))).replace(/\n{3,}/g, '\n\n').slice(-2500));
    console.log('--- active'); console.log((await c.eval(screen('active'))).replace(/\n{3,}/g, '\n\n').slice(-2500));
    console.log('--- status', await c.eval(`JSON.stringify((({status, ccSessionId, transcriptPath}) => ({status, ccSessionId, transcriptPath}))(sessions.get(${q}) || {}))`));
  } finally { await gracefulQuit(hub).catch(() => {}); }
})().catch(e => { console.error(e); process.exit(1); });
