'use strict';
// REAL models on the development delivery flow in a throwaway Git repo:
// kickoff -> build (worktree + CANDIDATE line) -> Hub test gate -> review/merge.
// Credentials are copied into a temp profile and deleted afterwards; only the
// Hub's own Claude hooks are kept. Usage: node tests/e2e-dev-flow-live.js [authorModel] [reviewerKind] [reviewerModel]
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher'), { connectFirstPage } = require('./helpers/cdp-client');
const AUTHOR_MODEL = process.argv[2] || 'claude-haiku-4-5-20251001';
const REVIEWER_KIND = process.argv[3] || 'claude', REVIEWER_MODEL = process.argv[4] || AUTHOR_MODEL;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-devflow-live-')), DATA = path.join(ROOT, 'data');
const ART = path.resolve(__dirname, '..', 'artifacts', 'dev-flow-live'); fs.mkdirSync(ART, { recursive: true });
const secrets = [], delay = ms => new Promise(r => setTimeout(r, ms));
function profiles() {
  const env = { CLAUDE_HUB_AGENT_RUNTIME: 'pty', CLAUDE_HUB_HOME_DIR: path.join(ROOT, 'home'), AI_HUB_WORKSPACE_ROOT: path.join(ROOT, 'work'), DEEPSEEK_API_KEY: '' };
  for (const [key, source, names] of [['CODEX_HOME', '.codex', ['auth.json', 'config.toml', 'models_cache.json']], ['CLAUDE_CONFIG_DIR', '.claude', ['.credentials.json', 'settings.json']]]) {
    const dest = path.join(ROOT, source.slice(1)); fs.mkdirSync(dest, { recursive: true }); env[key] = dest;
    for (const name of names) { const o = path.join(os.homedir(), source, name), t = path.join(dest, name); if (fs.existsSync(o)) { fs.copyFileSync(o, t); secrets.push(t); } }
  }
  const st = path.join(os.homedir(), '.claude.json'); if (fs.existsSync(st)) { const d = path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'); fs.copyFileSync(st, d); secrets.push(d); }
  const settings = path.join(env.CLAUDE_CONFIG_DIR, 'settings.json');
  if (fs.existsSync(settings)) {
    const s = JSON.parse(fs.readFileSync(settings, 'utf8')), hooks = {};
    for (const [event, groups] of Object.entries(s.hooks || {})) {
      const kept = (groups || []).map(g => ({ ...g, hooks: (g.hooks || []).filter(h => /session-hub-hook/.test(h.command || '')) })).filter(g => g.hooks.length);
      if (kept.length) hooks[event] = kept;
    }
    s.hooks = hooks; delete s.enabledPlugins; delete s.statusLine; fs.writeFileSync(settings, JSON.stringify(s), 'utf8');
  }
  return env;
}
const port = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

(async () => {
  let hub, cdp, id;
  const report = { realModel: true, author: AUTHOR_MODEL, reviewer: `${REVIEWER_KIND}:${REVIEWER_MODEL}`, root: ROOT, problems: [] };
  const invoke = (ch, a = {}) => cdp.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(ch)},${JSON.stringify(a)})`);
  const shot = async n => { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ART, n + '.png'), Buffer.from(r.data, 'base64')); };
  try {
    // A tiny prepared project: contracts, a real test command, Git history.
    const work = path.join(ROOT, 'work'), repo = path.join(work, 'demo');
    fs.mkdirSync(path.join(repo, '.agents'), { recursive: true }); fs.writeFileSync(path.join(work, '.aiwork-root'), '');
    const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', windowsHide: true }).trim();
    git('init', '-q', '-b', 'master'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# demo\n极小的演示仓库。只做任务要求的事，不联网，不加依赖。\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'check.js'), "const fs=require('fs');process.exit(fs.existsSync('hello.txt')&&fs.readFileSync('hello.txt','utf8').trim()==='hi'?0:1);\n", 'utf8');
    fs.writeFileSync(path.join(repo, '.agents', 'project.json'), JSON.stringify({ name: 'demo', trunk: 'master', test: ['node check.js'] }, null, 2));
    fs.writeFileSync(path.join(repo, '.agents', 'AUTHOR.md'), `# 实现\n在 ${path.join(work, 'demo-wt')} 用 \`git worktree add ${path.join(work, 'demo-wt')} -b feat/hello\` 建 worktree，在其中实现并提交。不要改主目录。\n`, 'utf8');
    fs.writeFileSync(path.join(repo, '.agents', 'MERGER.md'), `# 审查与合并\n在 worktree 里运行 \`node check.js\` 验证。通过后在主目录 ${repo} 执行 \`git merge --no-ff feat/hello -m "merge feat/hello"\`，再运行 \`node check.js\` 作为合并后检查。\n`, 'utf8');
    git('add', '-A'); git('commit', '-qm', 'init');
    new (require('../core/prepared-project-registry').PreparedProjectRegistry)({ dataDir: DATA }).register(repo);

    hub = await launchIsolatedHub({ dataDir: DATA, port: await port(), windowMode: 'hidden', label: 'devflow-live', extraEnv: profiles() });
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    for (let i = 0; i < 120 && !(await cdp.eval('!!window.MeetingRoom')); i++) await delay(500);
    const slots = [{ index: 0, memberId: 'm1', kind: 'claude', model: AUTHOR_MODEL, effort: 'low', fastMode: false, mcpProfile: 'lean' },
      { index: 1, memberId: 'm2', kind: REVIEWER_KIND, model: REVIEWER_MODEL, effort: 'low', fastMode: false, mcpProfile: 'lean' }];
    const m = await invoke('create-meeting', { mode: 'dev', scene: 'dev', groupChat: true, title: '真实模型 · 开发流', workspace: repo, slots });
    id = m.id;
    const config = await cdp.eval("require('../core/workflow-settings').createDeliveryConfig('development',[{memberId:'m1'},{memberId:'m2'}])");
    await invoke('update-meeting-sync', { meetingId: id, fields: { serialWorkflow: config } });
    const fresh = (await invoke('get-meetings')).find(x => x.id === id);
    await cdp.eval(`window.MeetingRoom.openMeeting(${JSON.stringify(id)},${JSON.stringify(fresh)})`);
    for (let i = 0; i < 240 && !(await cdp.eval("!!document.querySelector('[data-delivery=files]')")); i++) await delay(500);
    await delay(3000);
    const p = await cdp.eval("(()=>{const r=document.querySelector('#mr-input-box').getBoundingClientRect();return {x:r.x+30,y:r.y+20};})()");
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    await cdp.send('Input.insertText', { text: '在 demo 仓库根目录新增 hello.txt，内容只有一行 hi。' });
    for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    const started = Date.now(); let st = null, sawGate = false;
    while (Date.now() - started < 20 * 60_000) {
      st = await invoke('delivery:status', { meetingId: id });
      if (st.gate === 'running' && !sawGate) { sawGate = true; await shot('gate-running'); }
      if (st.finished || st.paused) break;
      await delay(5000);
    }
    report.seconds = Math.round((Date.now() - started) / 1000);
    report.status = { status: st?.status, done: st?.done, paused: st?.paused, error: st?.error, label: st?.label };
    const base = path.join(DATA, 'task-docs', id, 'deliveries'), run = JSON.parse(fs.readFileSync(path.join(base, 'run.json'), 'utf8'));
    report.steps = run.steps.map(s => ({ n: s.number, stage: run.stages[s.index].name, gate: s.gate ? { state: s.gate.state, reason: s.gate.reason || null, sha: s.gate.sha } : null,
      deliveries: Object.values(s.deliveries).map(d => ({ member: d.memberId, outcome: d.outcome, chars: d.path && fs.existsSync(d.path) ? fs.readFileSync(d.path, 'utf8').length : 0,
        candidateLine: d.path && fs.existsSync(d.path) ? (fs.readFileSync(d.path, 'utf8').match(/CANDIDATE:.*/) || [null])[0] : null })) }));
    report.kickoffHasFailureModes = (() => { const d = Object.values(run.steps[0]?.deliveries || {})[0]; return !!d && /失败模式/.test(fs.readFileSync(d.path, 'utf8')); })();
    report.merged = { log: git('log', '--oneline', '-5', 'master'), helloOnMaster: fs.existsSync(path.join(repo, 'hello.txt')) };
    report.lessons = fs.existsSync(path.join(DATA, 'project-lessons')) ? fs.readdirSync(path.join(DATA, 'project-lessons')) : [];
    const gs = await invoke('groupchat:get-state', { meetingId: id });
    report.cards = gs.messages.filter(x => x.role === 'assistant' && !x.sourceMessage).map(x => ({ turn: x.turnNum, member: x.memberId, state: x.answer?.state || 'none', chars: (x.content || '').length }));
    await shot('final');
  } catch (error) { report.problems.push(error.stack); if (cdp) { try { await shot('failure'); } catch {} } }
  finally {
    if (cdp) await cdp.close();
    if (hub) { await gracefulQuit(hub); try { fs.writeFileSync(path.join(ART, 'hub.log'), (hub.log ? hub.log() : []).join(String.fromCharCode(10)), 'utf8'); } catch {} }
    for (const f of secrets) if (fs.existsSync(f)) fs.unlinkSync(f);
    fs.writeFileSync(path.join(ART, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2));
  }
})();
