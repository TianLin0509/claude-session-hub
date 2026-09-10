'use strict';
// Real Codex + Claude, real worktree/test/merge, isolated Hub and transcript roots.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const RESUME = process.env.HUB_FILEFLOW_RESUME_ROOT || '';
const ROOT = RESUME ? fs.realpathSync(RESUME) : fs.mkdtempSync(path.join(os.tmpdir(), 'hub-fileflow-l-'));
if (!ROOT.startsWith(fs.realpathSync(os.tmpdir()) + path.sep) || !path.basename(ROOT).startsWith('hub-fileflow-l-')) throw new Error('fixture root must stay inside its dedicated temp directory');
const DATA = path.join(ROOT, 'data'), REPO = path.join(ROOT, 'fixture'), REMOTE = path.join(ROOT, 'remote.git');
const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', windowsHide: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const write = (name, body) => { const p = path.join(REPO, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body, 'utf8'); };
function fixture() {
  write('AGENTS.md', `# Disposable workflow fixture\nOnly work in this fixture, task docs and worktrees under ${ROOT}. No production operations or network push.\nUser authorizes implementation, independent review and local fixture merge. Do not ask approval.\nAuthor uses a separate worktree. Test command: node test.js. Do not create reports beyond Hub stage files.\n`);
  write('.agents/AUTHOR.md', `# Fixture implementation facts\nWorktree root: ${ROOT}\nTest: node test.js. No dependencies. No version bump. Do not merge the branch.\n`);
  write('.agents/MERGER.md', `# Fixture merge facts\nMain repository: ${REPO}\nUse python scripts/merge_task.py TASK_BRANCH --dry-run, then python scripts/merge_task.py TASK_BRANCH.\nThis fixture has no running production service. origin is a disposable local bare repo, push there is allowed.\nExisting script accepts no --expected-head parameters; record and verify full candidate SHA manually.\n`);
  write('.agents/project.json', JSON.stringify({ name: 'file-workflow-fixture', trunk: 'master', test: ['node test.js'],
    versionFiles: [], versionBump: [], afterMerge: [], protectedBranches: [], worktreeRoot: ROOT }, null, 2));
  write('scripts/merge_task.py', fs.readFileSync(path.join(__dirname, '../scripts/merge_task.py'), 'utf8'));
  write('greet.js', "exports.greet = name => 'hello ' + name;\n");
  write('test.js', "const assert=require('node:assert/strict'); const {greet}=require('./greet'); assert.equal(greet('Ada'),'hello Ada'); console.log('OK');\n");
  git('init', '-q', '-b', 'master'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('add', '.'); git('commit', '-qm', 'fixture baseline'); git('init', '--bare', '-q', REMOTE); git('remote', 'add', 'origin', REMOTE); git('push', '-q', 'origin', 'master');
  return git('rev-parse', 'HEAD').trim();
}
function isolatedProfiles() {
  const codex = path.join(ROOT, 'codex-home'), claude = path.join(ROOT, 'claude-config');
  for (const [source, dest, names] of [[path.join(os.homedir(), '.codex'), codex, ['auth.json', 'config.toml', 'models_cache.json']],
    [path.join(os.homedir(), '.claude'), claude, ['.credentials.json', 'settings.json']]]) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of names) if (fs.existsSync(path.join(source, name))) fs.copyFileSync(path.join(source, name), path.join(dest, name));
  }
  const claudeState = path.join(os.homedir(), '.claude.json');
  if (fs.existsSync(claudeState)) fs.copyFileSync(claudeState, path.join(claude, '.claude.json'));
  return { CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude };
}
async function run() {
  const baseline = RESUME ? git('rev-list', '--max-parents=0', 'HEAD').trim() : fixture(); let hub, cdp, meetingId;
  console.log('ARTIFACT_ROOT ' + ROOT);
  try {
    hub = await launchIsolatedHub({ dataDir: DATA, port: await freePort(), windowMode: 'hidden', extraEnv: isolatedProfiles() });
    cdp = await connectFirstPage(hub, t => /index\.html/.test(t.url));
    const invoke = (channel, args = {}) => cdp.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)}, ${JSON.stringify(args)})`);
    for (let i = 0; i < 60 && !await cdp.eval('!!window.WorkflowTemplates'); i++) await sleep(500);
    const prior = RESUME ? (await invoke('get-meetings')).find(m => m.serialWorkflow?.fileFlowVersion === 2) : null;
    const alternate = process.env.HUB_FILEFLOW_TEST_REVIEWER === 'codex';
    const m = RESUME && !alternate ? prior
      : await invoke('create-meeting', { mode: 'dev', groupChat: true, title: '真实 CLI 文件工作流验证', workspace: REPO,
        slots: [{ index: 0, kind: 'codex', memberId: 'm1' }, { index: 1, kind: alternate ? 'codex' : 'claude', memberId: 'm2' }] });
    meetingId = m.id; assert.equal(m.subSessions.length, 2);
    console.log('CLI_SESSIONS ' + JSON.stringify(m.subSessions));
    const config = await cdp.eval("window.WorkflowTemplates.createTemplateConfig('dev-task', [{memberId:'m1',kind:'codex'},{memberId:'m2',kind:'claude'}])");
    if (!RESUME || alternate) await invoke('update-meeting-sync', { meetingId, fields: { serialWorkflow: { ...config, ...(RESUME && alternate ? {fileFlow:{paused:true}} : {}) } } });
    if (RESUME && alternate) {
      const source = path.join(DATA, 'task-docs', prior.id), dest = path.join(DATA, 'task-docs', meetingId);
      fs.mkdirSync(dest, {recursive:true});
      for (const name of ['已完成-开题报告.md', '已完成-实现手册-轮次1.md']) fs.copyFileSync(path.join(source,name), path.join(dest,name), fs.constants.COPYFILE_EXCL);
      console.log('TEST_SETUP independent Codex reviewer takes over the existing file handoff; Claude quota unavailable');
    }
    await cdp.eval(`selectMeeting(${JSON.stringify(meetingId)})`);
    const handledImport = new Set();
    async function handleFixtureStartup() {
      for (const sid of m.subSessions) {
        if (handledImport.has(sid)) continue;
        const buf = String(await invoke('debug:get-session-buffer', sid) || '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\s+/g, '');
        if (buf.includes('AllowexternalCLAUDE.mdfileimports?') && buf.includes('❯No,disableexternalimports')) {
          // This is an observed CLI startup menu with No selected, not a prompt submission.
          await cdp.eval(`require('electron').ipcRenderer.send('terminal-input',${JSON.stringify({sessionId:sid,data:'\r'})})`);
          handledImport.add(sid); console.log('TEST_SETUP disabled unrelated external CLAUDE imports in isolated profile');
        }
      }
    }
    const readyDeadline = Date.now() + 180000;
    while (Date.now() < readyDeadline) {
      await handleFixtureStartup();
      if ((await Promise.all(m.subSessions.map(sid=>invoke('cli-ready-status',sid)))).every(Boolean)) break;
      await sleep(1000);
    }
    assert((await Promise.all(m.subSessions.map(sid=>invoke('cli-ready-status',sid)))).every(Boolean),'both isolated CLI sessions must finish startup');
    let userInput;
    if (RESUME) userInput = '继续，沿用已交付的开题与实现文件完成独立合并验证。补充明确：origin 是本测试目录内的本地 bare fixture，允许按项目既有合并脚本向它同步；不需要禁止 file 传输，禁止连接其他远端。';
    else {
      const preset = await invoke('dev-file:kickoff-preset', { meetingId });
      await invoke('groupchat:set-participants', { meetingId, participants: [0] });
      const task = '为 greet(name, greeting) 增加可选 greeting 参数；省略时保持 hello，显式空字符串应保留为空。补充测试并实际验证，由独立合并位亲验后合到此临时 fixture 的 master。本次只操作测试临时目录；项目 origin 指向本目录下的本地 bare fixture，明确允许按合并脚本向它同步，禁止连接其他远端。';
      userInput = task + (process.env.HUB_FILEFLOW_ASSERT_HISTORY === '1'
        ? '\n本次同时验收群聊消息留存：每个阶段用普通中文发至少三条简短进展，不加 PLAN/UPDATE 等标签，至少一条包含真实验证命令或路径。交付文件后用最后一条回答说明本阶段交付情况。' : '') + '\n\n' + preset.prompt;
    }
    if(RESUME && process.env.HUB_FILEFLOW_ASSERT_HISTORY==='1') userInput+='\n继续验收消息留存：本阶段用普通中文发至少三条不同进展，不加固定标签；交付文件后给出最终答复。';
    await cdp.eval(`void require('electron').ipcRenderer.invoke('groupchat:turn', ${JSON.stringify({ meetingId, userInput })})`);
    let previous = '', done = false;
    const deadline = Date.now() + Number(process.env.HUB_FILEFLOW_L_BUDGET_MS || 900000);
    while (Date.now() < deadline) {
      await handleFixtureStartup();
      const state = await invoke('dev-file:status', { meetingId });
      const text = `${state.key} ${state.files.join(', ')} ${state.dispatchError || state.error || ''}`;
      if (text !== previous) { console.log(text); previous = text; }
      fs.writeFileSync(path.join(ROOT, 'file-status.json'), JSON.stringify(state, null, 2));
      if (state.done) { done = true; break; }
      if (state.error || state.dispatchError) throw new Error(state.error || state.dispatchError);
      await sleep(2000);
    }
    let gc = await invoke('groupchat:get-state', { meetingId });
    if(done && process.env.HUB_FILEFLOW_ASSERT_HISTORY === '1') {
      const endDeadline=Date.now()+90000;
      while(Date.now()<endDeadline && Object.values(gc.devChatHistory?.receipts || {}).some(r=>!r.sourceCompletedAt)) {
        await sleep(500);gc=await invoke('groupchat:get-state',{meetingId});
      }
    }
    fs.writeFileSync(path.join(ROOT, 'groupchat.json'), JSON.stringify(gc, null, 2));
    assert(done, 'real Agents did not finish the file chain within budget');
    if(process.env.HUB_FILEFLOW_ASSERT_HISTORY === '1') {
      const sourceMessages=gc.messages.filter(m=>m.sourceMessage);
      for(const receipt of Object.values(gc.devChatHistory?.receipts || {})) {
        const owned=sourceMessages.filter(m=>m.attemptId===receipt.attemptId);
        assert(owned.filter(m=>m.phase==='commentary').length>=3,`turn ${receipt.turnNum} must preserve at least three natural progress messages`);
        assert(owned.some(m=>m.phase==='final') && receipt.sourceCompletedAt,`turn ${receipt.turnNum} must preserve its own final after file delivery`);
      }
      assert(sourceMessages.length>=4,'natural source messages and the final must be persisted');
      assert(!gc.messages.some(m=>m.role==='assistant' && m.status==='superseded'),'automatic handoffs must not supersede answers');
      assert.equal(await cdp.eval("document.querySelectorAll('[data-gc-retry-answer]').length"),0,'development cards must not offer retry');
      console.log('PASS real source history: '+sourceMessages.length+' cards, no superseded answers or retry buttons');
    }
    assert.notEqual(git('rev-parse', 'master').trim(), baseline);
    const output = execFileSync(process.execPath, ['test.js'], { cwd: REPO, encoding: 'utf8' });
    assert(output.includes('OK'));
    execFileSync(process.execPath, ['-e', "const a=require('node:assert/strict'),{greet}=require('./greet');a.equal(greet('Ada'),'hello Ada');a.equal(greet('Ada','hi'),'hi Ada');a.equal(greet('Ada',''),' Ada');"], { cwd: REPO });
    const shot = await cdp.send('Page.captureScreenshot', {format:'png'}); fs.writeFileSync(path.join(ROOT, 'completed-ui.png'), Buffer.from(shot.data, 'base64'));
    console.log('PASS real kickoff -> implementation -> independent merge; actual master behavior verified');
    fs.writeFileSync(path.join(ROOT, 'result.json'), JSON.stringify({ pass: true, baseline, head: git('rev-parse', 'HEAD').trim(), output, root: ROOT }, null, 2));
  } catch(error) {
    try { if(cdp && meetingId) {
      const state=await cdp.eval(`require('electron').ipcRenderer.invoke('groupchat:get-state',{meetingId:${JSON.stringify(meetingId)}})`);
      fs.writeFileSync(path.join(ROOT,'failed-groupchat.json'),JSON.stringify(state,null,2));
      const meeting=await cdp.eval(`require('electron').ipcRenderer.invoke('get-meetings').then(ms=>ms.find(m=>m.id===${JSON.stringify(meetingId)}))`);
      for(const sid of meeting.subSessions) {
        const buffer=await cdp.eval(`require('electron').ipcRenderer.invoke('debug:get-session-buffer',${JSON.stringify(sid)})`);
        fs.writeFileSync(path.join(ROOT,`failed-buffer-${sid}.txt`),String(buffer || ''));
      }
      const shot=await cdp.send('Page.captureScreenshot',{format:'png'});
      fs.writeFileSync(path.join(ROOT,'failed-ui.png'),Buffer.from(shot.data,'base64'));
    } } catch(diagnosticError) { console.error('failed to save CLI failure evidence:',diagnosticError.message); }
    throw error;
  } finally {
    try {
      if (cdp && meetingId) {
        try { await cdp.eval(`require('electron').ipcRenderer.invoke('groupchat:interrupt', {meetingId:${JSON.stringify(meetingId)}})`); }
        catch (error) { console.error('test interrupt failed', error.message); }
      }
      if (cdp) await cdp.close(); if (hub) await gracefulQuit(hub);
    } finally {
      // Teardown can itself fail. Credential cleanup must still run.
      for (const [dir, names] of [['codex-home', ['auth.json', 'config.toml']], ['claude-config', ['.credentials.json', 'settings.json', '.claude.json']]]) {
        for (const name of names) { const file = path.join(ROOT, dir, name); if (fs.existsSync(file)) fs.unlinkSync(file); }
      }
    }
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
