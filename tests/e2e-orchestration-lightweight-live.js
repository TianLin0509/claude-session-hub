'use strict';
// Real Codex PTY + isolated Hub + UI input/confirmation/budget/restart.
// No production writes, refresh credential, network publishing, or fake tool calls.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const scenario = process.argv[2] || 'delivery';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-orch-codex-'));
const data = path.join(root, 'data'), home = path.join(root, 'codex'), work = path.join(root, 'work');
const art = path.resolve(__dirname, '../artifacts/orchestration-lightweight', scenario + '-' + Date.now());
for (const p of [data, home, work, art]) fs.mkdirSync(p, { recursive: true });
const report = { scenario, root, art, start: new Date().toISOString(), realModel: true, inputRoute: process.env.HUB_CODEX_EDITOR_INPUT==='0'?'pty-paste-fallback':'default-editor', timeline: [], checks: [], problems: [] };
report.sourceHead=execFileSync('git',['rev-parse','HEAD'],{cwd:path.resolve(__dirname,'..'),encoding:'utf8',windowsHide:true}).trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (event, value) => { report.timeline.push({ at: new Date().toISOString(), event, value }); console.log(event, value ? JSON.stringify(value).slice(0, 700) : ''); fs.writeFileSync(path.join(art, 'live.json'), JSON.stringify(report, null, 2)); };
const git = (...args) => execFileSync('git', args, { cwd: work, encoding: 'utf8', windowsHide: true });
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
let hub, cdp, meetingId, authFile, sourceFile, sourceHash;
const hash = file => require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const ledger = () => read(path.join(data, 'task-docs', meetingId || '-', 'orchestration/ledger.json'));
const run = () => read(path.join(data, 'task-docs', meetingId || '-', 'deliveries/run.json'));
const invoke = (ch, args = {}) => cdp.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(ch)},${JSON.stringify(args)})`);
async function wait(label, pred, ms = 60000) { const end = Date.now() + ms; while (Date.now() < end) { const value = await pred(); if (value) return value; await sleep(1000); } throw Error('Timeout: ' + label); }
async function click(selector) {
  const point = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`);
  if (!point) throw Error('Missing clickable ' + selector);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
}
async function send(text) {
  await click('#mr-input-box');
  await cdp.send('Input.insertText', { text });
  for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}
async function shot(name) { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(art, name + '.png'), Buffer.from(r.data, 'base64')); }
async function launch() {
  const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  hub = await launchIsolatedHub({ dataDir: data, port, label: 'codex-orchestration-audit', extraEnv: {
    CLAUDE_HUB_AGENT_RUNTIME: 'pty', CODEX_HOME: home, CODEX_SQLITE_HOME: home, HUB_CODEX_PROFILE: 'default',
    AI_HUB_WORKSPACE_ROOT: root, DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    USERPROFILE: path.join(root, 'home'), HOME: path.join(root, 'home'),
    CODEX_CI: '', CODEX_THREAD_ID: '', CODEX_SESSION_ID: '', VISUAL: '', EDITOR: '', TERM: 'xterm-256color',
    ...(process.env.HUB_CODEX_EDITOR_INPUT === '0' ? {HUB_CODEX_EDITOR_INPUT:'0'} : {}),
  } });
  cdp = await connectFirstPage(hub, t => /index\.html/.test(t.url));
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
  await wait('renderer', () => cdp.eval('!!window.MeetingRoom && typeof selectMeeting === "function"'));
  log('isolated Hub launched', { pid: hub.pid, port });
}
async function open() { await cdp.eval(`selectMeeting(${JSON.stringify(meetingId)})`); await wait('orchestration strip', () => cdp.eval("!!document.querySelector('.mr-orch-strip')")); }
(async () => {
  try {
    const cfg = read(path.join(os.homedir(), '.claude-session-hub/config.json'));
    const selected = cfg.providers.codex.subscription_profiles.find(p => p.id === cfg.providers.codex.subscription_profile);
    sourceFile = path.join(selected.home || path.join(os.homedir(), '.codex'), 'auth.json'); sourceHash = hash(sourceFile);
    const auth = read(sourceFile), token = auth.tokens?.access_token;
    const seconds = token && JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).exp - Date.now() / 1000;
    if (auth.auth_mode !== 'chatgpt' || !(seconds > 7200)) throw Error('Need selected subscription access token valid for >2h');
    // Short test uses the current access token, with refresh deliberately unavailable.
    auth.tokens.refresh_token = '';
    authFile = path.join(home, 'auth.json'); fs.writeFileSync(authFile, JSON.stringify(auth), { mode: 0o600 });
    fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n');
    log('selected credential isolated', { profile: selected.id, accessValidHours: Math.floor(seconds / 3600), refreshAvailable: false });
    // Codex also migrates legacy history from the OS home. Keep it isolated.
    for (const p of ['sessions', 'archived_sessions']) fs.mkdirSync(path.join(home,p), {recursive:true});
    fs.mkdirSync(path.join(root, 'home/.codex/sessions'), {recursive:true});
    const { CodexAppServerClient } = require('../main/codex-app-server-client');
    const warm = new CodexAppServerClient({cwd:work,env:{...process.env,CODEX_HOME:home,CODEX_SQLITE_HOME:home,USERPROFILE:path.join(root,'home'),HOME:path.join(root,'home'),OPENAI_API_KEY:''}});
    try {
      await warm.start();
      const {DatabaseSync}=require('node:sqlite');
      await wait('fresh Codex database backfill',()=>{try{const db=new DatabaseSync(path.join(home,'state_5.sqlite'),{readOnly:true});const row=db.prepare('select status from backfill_state').get();db.close();return row?.status==='complete'||row?.status==='completed';}catch{return false;}},60000);
      log('fresh Codex database initialized');
    } finally {warm.close();await warm.waitForExit();}
    fs.writeFileSync(path.join(data, 'prepared-projects.json'), JSON.stringify({ schemaVersion: 1, projects: [], migrations: [] }));
    fs.writeFileSync(path.join(work, 'AGENTS.md'), '# 隔离验收项目\n所有开发只在本仓库的独立分支完成，审核位独立运行 node test.js 通过后合并到本仓库 master。没有远端，不推送。不得改仓库外的用户文件。\n');
    fs.writeFileSync(path.join(work, 'arithmetic.js'), "'use strict';\nmodule.exports = {sum: (values) => values.reduce((a,b)=>a+b,0)};\n");
    fs.writeFileSync(path.join(work, 'test.js'), "const assert=require('node:assert/strict'); const {sum}=require('./arithmetic'); assert.equal(sum([1,2,3]),6); console.log('sum ok');\n");
    git('init', '-q', '-b', 'master'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'orch-codex-test'); git('add', '.'); git('commit', '-qm', 'isolated fixture');
    await launch();
    const room = await invoke('create-meeting', { mode: 'general', scene: 'general', groupChat: true, title: 'Codex 编排实测 · ' + scenario, workspace: work,
      slots: [{ index: 0, kind: 'codex', model: 'gpt-6.1-sol', effort: 'high', mcpProfile: 'lean' }, { index: 1, kind: 'codex', model: 'gpt-6-luna', effort: 'low', mcpProfile: 'lean' }, { index: 2, kind: 'codex', model: 'gpt-6-luna', effort: 'low', mcpProfile: 'lean' }], participants: [0],
      orchestration: { enabled: true, settings: { requireConfirm: true, roundCap: 8, timeCapMin: 180, stuckMin: 5 } } });
    if (!room?.id) throw Error('create-meeting failed: ' + JSON.stringify(room));
    meetingId = report.meetingId = room.id; await open(); await shot('00-room');
    if(scenario!=='startup') {
      await wait('Codex TUI model loaded', async()=>{const b=await invoke('debug:get-session-buffer',room.orchestration.sessionId);return /GPT-6\.1-Sol.*high/.test(b.slice(-2000));},60000);
      log('Codex TUI model loaded', {inputRoute:process.env.HUB_CODEX_EDITOR_INPUT==='0'?'supported PTY paste fallback':'default editor'});
    }
    report.initialBudget=ledger().budget;
    if(report.initialBudget.roundCap!==8 || report.initialBudget.timeCapMs!==180*60000)throw Error('default budget mismatch');
    report.checks.push('default budget 8 rounds / 180 minutes');
    const members='只使用群里已选好的两位成员，编排员自主分工；只做一个 development 工作段。用 hub_orchestrator 工具编排，成员按交付文件协议交付。';
    const base='在 '+work+' 增加 mean(values)：非空数字数组返回均值，空数组返回 null。test.js 覆盖 [2,4,6]、[-3,3]、[0]、[]，保持 sum 原行为。审核位独立运行 node test.js 并检查实现，PASS 后合并到隔离仓库 master，记录完整 SHA。没有远端。';
    const task=base+members+(scenario==='delivery'?'允许10轮以内迭代，最多半小时。':scenario==='rework'?'本次专门实测返工链路：实现位首轮只实现非空数组，空数组要求留待下一轮；审核位首轮须独立指出此遗漏并交需返工，随后实现位补齐空数组行为，审核通过才能合并。这是受控缺陷注入。':'本次专门实测运行阻塞：实现位在开题阶段遇到受控缺失条件（实验设备登录失效），请按阻塞交付协议写明需要田哥重新登录设备，再将该步文件改名为阻塞文件，保持暂停。无需尝试登录或修复，编排员仅给处理建议。');
    await send(task); log('goal sent via UI');
    const deadline = Date.now() + Number(process.env.MAX_MIN || 25) * 60000;
    let last = '', confirmed = false, granted = false, restarted = false;
    while (Date.now() < deadline) {
      const l = ledger(), r = run();
      fs.writeFileSync(path.join(art, 'hub-live.log'), hub.log().join('\n'));
      if (fs.existsSync(path.join(art,'stop-test'))) throw Error('Test stopped for diagnosis');
      if (hub.log().some(x=>/sendToPty threw.*(?:未确认 Codex 已接收|长文本输入通道未就绪)/.test(x))) throw Error('Default Codex editor input rejected the group prompt; see Hub log and terminal snapshots');
      const key = JSON.stringify([l?.status, l?.plan?.version, l?.budget?.roundsUsed, l?.halt?.reason, l?.segments?.map(s => [s.status, s.steps]), r?.steps?.map(s => [s.index, Object.keys(s.deliveries || {})])]);
      if (key !== last) { last = key; log('state', { status: l?.status, budget: l?.budget?.roundsUsed, halt: l?.halt?.reason, segments: l?.segments, step: r?.steps?.at(-1) }); await shot('state-' + report.timeline.length); }
      if(scenario==='startup' && l?.status==='awaiting_confirm') { report.checks.push('immediate cold-start group prompt reached real orchestrator'); report.ok=true; break; }
      if (l?.status === 'awaiting_confirm' && !confirmed) { const expected=scenario==='delivery'?10:8; if(l.plan.budget.roundCap!==expected)throw Error('natural-language plan budget mismatch'); report.checks.push('plan budget '+expected+' rounds'); await sleep(2000); await click('.mr-orch-strip [data-orch-action="confirm"]'); confirmed = true; report.checks.push('UI plan confirmation'); log('plan confirmed via UI'); }
      const rooms=await invoke('get-meetings');
      if(rooms.find(m=>m.id===meetingId).subSessions.length!==3)throw Error('fixed roster changed');
      if(confirmed && l?.plan?.confirmedVersion===l?.plan?.version && l.budget.roundCap!==(scenario==='delivery'?10:8))throw Error('confirmed budget not enforced');
      if(scenario==='fault' && l?.status==='halted' && l.halt?.reported){
        if(!/(?:新建|重新开|新开|重开|新).{0,12}任务/.test(l.reports.at(-1)?.summary||''))throw Error('blocking advice does not respect Hub recovery capability');
        report.checks.push('real member reports injected blocking condition; real orchestrator gives advice');
        const before=JSON.stringify([l.status,r.status,r.steps.length,l.budget.roundsUsed]);
        await send('现在卡在哪里，有什么建议？'); await sleep(20000);
        if(JSON.stringify([ledger().status,run().status,run().steps.length,ledger().budget.roundsUsed])!==before)throw Error('ordinary question resumed blocked work');
        report.checks.push('ordinary follow-up keeps work paused'); report.ok=true; break;
      }
      if (l?.status === 'finished') { if(scenario==='rework' && !(r?.steps?.some(step=>Object.values(step.deliveries||{}).some(d=>d.outcome==='rework'))))throw Error('missing real review rework'); if(scenario==='rework')report.checks.push('real independent review requests rework; corrected implementation passes'); if(scenario==='delivery' && l.budget.timeCapMs!==30*60000)throw Error('time limit not enforced'); report.checks.push('fixed roster unchanged; real orchestrator final accepted'); await sleep(15000); await shot('99-finished'); report.ok = true; break; }
      await sleep(3000);
    }
    if (!report.ok) report.problems.push('deadline exceeded without final');
  } catch (e) { report.problems.push(e.stack); console.error(e.stack); if (cdp) await shot('fatal').catch(() => {}); }
  finally {
    report.ledger = ledger(); report.run = run();
    report.interventions=[];
    for(const name of ['manual-intervention.json','manual-rescue-2.json'])if(fs.existsSync(path.join(art,name)))report.interventions.push(read(path.join(art,name)));
    report.automaticRecovery = !report.interventions.length;
    if(cdp)try{const ss=await invoke('get-sessions');report.terminalSnapshots=[];for(const s of ss)report.terminalSnapshots.push({id:s.id,kind:s.kind,status:s.status,codexSid:s.codexSid,tail:String(await invoke('debug:get-session-buffer',s.id)).slice(-6000)});}catch(e){report.problems.push('snapshot: '+e.message);}
    try { report.gitLog = git('log', '--all', '--format=%H %s', '-12'); report.gitStatus = git('status', '--short'); if(scenario!=='fault'){ const source=fs.readFileSync(path.join(work,'arithmetic.js'),'utf8'); const vm=require('node:vm'); const box={module:{exports:{}}};vm.runInNewContext(source,box); const assert=require('node:assert/strict');for(const [a,v] of [[[2,4,6],4],[[-3,3],0],[[0],0],[[],null]])assert.equal(box.module.exports.mean(a),v); report.checks.push('independent four-boundary verification'); } report.testOutput = execFileSync('node', ['test.js'], { cwd: work, encoding: 'utf8', windowsHide: true }); } catch(e) { report.problems.push('fixture validation: ' + e.message); }
    if (meetingId) fs.cpSync(path.join(data, 'task-docs', meetingId), path.join(art, 'task-docs'), { recursive: true });
    if (hub) fs.writeFileSync(path.join(art, 'hub.log'), hub.log().join('\n'));
    if (cdp) await cdp.close().catch(() => {});
    if (hub) await gracefulQuit(hub).catch(e => report.problems.push('quit: ' + e.message));
    if (authFile) fs.rmSync(authFile, { force: true });
    report.credentialRemoved = !authFile || !fs.existsSync(authFile);
    report.sourceCredentialUnchanged = sourceFile && hash(sourceFile) === sourceHash;
    report.end = new Date().toISOString(); fs.writeFileSync(path.join(art, 'report.json'), JSON.stringify(report, null, 2));
    console.log('ARTIFACT', art); process.exitCode = report.ok && !report.problems.length ? 0 : 1;
  }
})();
