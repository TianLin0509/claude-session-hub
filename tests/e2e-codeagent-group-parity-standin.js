'use strict';
// 真实验收（替身）：公司版群聊与自用版拉齐（2026-10-14 同事反馈「加入群聊」不行、没有编排员）。
// 替身 tests/fixtures/codeagent-standin 启动真 Claude Code（GLM/MiniMax 换成 haiku），参数原样透传。
//   ① 新建一个 CodeAgent 会话，让它记一个暗号；
//   ② 侧栏右键这个会话 →「加入群聊…」→「新建群聊（以此会话分支）」：群聊建出来，成员是 CodeAgent；
//   ③ 在群聊输入框问暗号：成员答出暗号（带着原会话的上下文进群）；
//   ④ 启动中心 → AI 群聊：编排员开关可见，打开后成员 1（CodeAgent）当编排员，建群；
//   ⑤ 在编排群里让编排员查状态：它真的调用了编排工具 orch_status，工具返回成功。
// E2E_ENTRY 指向公司版导出目录（目录里要有指向生产依赖的 node_modules 链接）。凭据复制进临时目录，finally 删除。
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const STANDIN = path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd');
const SECRET = '秋枫-7713';

// 隔离配置目录里所有原生记录的条目（替身 = 真 Claude Code 落盘格式）。
function transcriptEntries(cac) {
  const out = [];
  const root = path.join(cac, 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return out; }
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(root, d)).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      let raw = '';
      try { raw = fs.readFileSync(path.join(root, d, f), 'utf8'); } catch { continue; }
      for (const line of raw.split('\n')) { try { const o = JSON.parse(line); out.push({ file: f, ...o }); } catch {} }
    }
  }
  return out;
}
// 用户条目的内容可能是纯文本（打字的消息）也可能是块数组（工具结果）。
const blocksOf = entry => (Array.isArray(entry && entry.message && entry.message.content) ? entry.message.content : []);
const textOf = entry => {
  const content = entry && entry.message && entry.message.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text).join('') : '';
};

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codeagent-group-'));
  const out = path.resolve(process.env.E2E_OUT || 'artifacts/20261014-codeagent-group-parity-claude1'); fs.mkdirSync(out, { recursive: true });
  const claudeAuth = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
  const cac = path.join(root, '.cac'), dataDir = path.join(root, 'data'), work = path.join(root, 'work'), proj = path.join(work, 'proj-secret');
  for (const d of [cac, dataDir, work, proj]) fs.mkdirSync(d, { recursive: true });
  const result = { company: !!process.env.E2E_ENTRY, checks: [], passed: false };
  let hub, c;
  const until = async (expr, label, ms = 180000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await c.eval(expr); if (v) return v; } catch (_) {} await sleep(400); } throw Error('timeout: ' + label); };
  const waitFor = async (fn, label, ms = 240000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(1500); } throw Error('timeout: ' + label); };
  const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(s.data, 'base64')); };
  const click = async selector => {
    const p = await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)throw Error('Missing control: '+${j(selector)});e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    await sleep(300);
  };
  const clickText = async (selector, text) => {
    await c.eval(`(()=>{const e=[...document.querySelectorAll(${j(selector)})].find(x=>x.textContent.includes(${j(text)})&&x.offsetParent!==null);if(!e)throw Error('Missing '+${j(text)});document.querySelectorAll('[data-e2e-pick]').forEach(x=>x.removeAttribute('data-e2e-pick'));e.setAttribute('data-e2e-pick','1');})()`);
    await click('[data-e2e-pick="1"]');
  };
  const rightClick = async selector => c.eval(`(()=>{const el=document.querySelector(${j(selector)});const r=el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:Math.round(r.x+r.width/2),clientY:Math.round(r.y+r.height/2)}));return true;})()`);
  const typeInRoom = async text => {
    await c.eval("(()=>{const b=document.getElementById('mr-input-box'); b.focus(); const r=document.createRange();r.selectNodeContents(b);const s=getSelection();s.removeAllRanges();s.addRange(r);})()");
    await c.send('Input.insertText', { text });
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  };
  const check = (ok, label) => { assert.ok(ok, label); result.checks.push(label); console.log('  ✓ ' + label); };
  try {
    fs.copyFileSync(claudeAuth, path.join(cac, '.credentials.json'));
    fs.writeFileSync(path.join(cac, '.claude.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true,
      skipDangerousModePermissionPrompt: true, hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true,
      hasSeenAutoModeEntryWarning: true, theme: 'dark', projects: {} }));
    fs.writeFileSync(path.join(cac, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
    fs.writeFileSync(path.join(cac, 'settings.json'), j({ permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }));

    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'hidden', label: 'codeagent group parity',
      ...(process.env.E2E_ENTRY ? { entryPath: process.env.E2E_ENTRY } : {}), extraEnv: {
        AI_HUB_CODEAGENT_COMMAND: STANDIN, AI_HUB_CODEAGENT_CONFIG_DIR: cac, AI_HUB_CODEAGENT_PICKER_LABELS: j({ 'GLM-5.2-WX-Auto': 'Haiku', 'MiniMax-M2.7': 'Haiku' }), AI_HUB_WORKSPACE_ROOT: work,
        CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', AI_HUB_RULES_BASE_URL: 'http://127.0.0.1:9/hub-rules/',
        AI_HUB_UPDATE_SOURCES: j([{ id: 'x', name: 'x', manifest: 'http://127.0.0.1:9/x.json', files: 'http://127.0.0.1:9/' }]),
        HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none') } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions !== "undefined" && !!window.openMeetingCreateModal && !!window.MeetingRoom', 'renderer', 60000);
    result.product = await c.eval(`document.querySelector('#hub-identity strong')?.textContent || ''`);

    // ① 一个 CodeAgent 会话，记暗号
    const standalone = await c.eval(`require('electron').ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { title: '记暗号的会话', cwd: proj, model: 'GLM-5.2-WX-Auto', effort: 'low' } })})`);
    await until(`!!sessions.get(${j(standalone.id)})`, 'session in renderer', 30000);
    await until(`getSessionRuntimeTruth(sessions.get(${j(standalone.id)})).state !== 'starting'`, 'standalone ready', 120000);
    await c.eval(`require('electron').ipcRenderer.invoke('session:send-prompt', ${j({ sessionId: standalone.id, text: `不要调用任何工具。请记住这个暗号：${SECRET}。只回答“记住了”。` })})`);
    await until(`(async()=>{const rows=await require('electron').ipcRenderer.invoke('groupchat:forkable-sessions',{});return rows.some(r=>r.id===${j(standalone.id)});})()`, '会话可加入群聊', 240000);
    check(true, 'CodeAgent 会话答完一轮后出现在「可加入群聊」的会话里');

    // ② 右键 → 加入群聊… → 新建群聊
    await until(`!!document.querySelector('[data-session-id="${standalone.id}"]')`, '侧栏出现会话', 30000);
    await rightClick(`[data-session-id="${standalone.id}"]`);
    check(await c.eval(`(()=>{const m=document.getElementById('context-menu');const b=m.querySelector('[data-action="join-group"]');return m.style.display==='block'&&b&&b.style.display!=='none';})()`), '会话右键菜单有「加入群聊…」');
    await click('#context-menu [data-action="join-group"]');
    await until(`!!document.getElementById('gc-join-group-menu')`, '加入群聊二级菜单', 10000);
    await shot('01-join-group-menu');
    const meetingsBefore = await c.eval('Object.keys(meetings).length');
    await clickText('#gc-join-group-menu .mr-quote-menu-item', '新建群聊');
    const joined = await until(`(()=>{const m=Object.values(meetings).filter(m=>(m.subSessions||[]).length).pop();return Object.keys(meetings).length>${meetingsBefore}&&m?m.id:null;})()`, '群聊建出来', 120000);
    const member = await c.eval(`(()=>{const m=meetings[${j(joined)}];const s=sessions.get(m.subSessions[0]);return s&&{id:s.id,kind:s.kind};})()`);
    check(member && member.kind === 'codeagent', '「加入群聊」建出群聊，成员是 CodeAgent（分支，不变成 Claude）');
    check(await c.eval(`(()=>{const s=sessions.get(${j(standalone.id)});return !!s && !s.meetingId;})()`), '原会话仍然独立存在');

    // ③ 群里问暗号
    await c.eval(`selectMeeting(${j(joined)})`);
    await until(`!!document.getElementById('mr-input-box')`, '群聊输入框', 20000);
    await until(`getSessionRuntimeTruth(sessions.get(${j(member.id)})).state !== 'starting'`, 'member ready', 120000);
    const askedAt = Date.now();
    await typeInRoom('我之前让你记住的暗号是什么？只回答暗号本身。');
    const recall = await waitFor(() => transcriptEntries(cac).find(e => e.type === 'assistant' && Date.parse(e.timestamp) > askedAt && textOf(e).includes('7713')), '群聊成员答出暗号');
    result.recall = textOf(recall).slice(0, 80);
    check(true, `群聊成员答出暗号「${result.recall.trim()}」——带着原会话的上下文进了群`);
    await sleep(2000);
    await shot('02-joined-group-recall');

    // ④ 编排员
    await c.eval("document.getElementById('btn-new-more').click()");
    await until(`!!document.getElementById('launch-intent-group')`, 'launch center', 15000);
    await click('#launch-intent-group');
    await until(`!!document.querySelector('#new-session-menu #mcm-orch-toggle')`, 'orch toggle', 15000);
    check(await c.eval(`getComputedStyle(document.getElementById('mcm-orch-row')).display!=='none'`), '建群页显示「编排员」开关');
    await click('#new-session-menu [data-mcm-scene="general"]');
    await click('#new-session-menu [data-mcm-workspace-mode="default"]');
    await click('#new-session-menu .mcm-orch-switch');
    const slots = await c.eval(`[...document.querySelectorAll('#new-session-menu .mcm-slot .mcm-ai-select')].map(s=>s.value)`);
    check(slots.length >= 2 && slots.every(k => k === 'codeagent') && await c.eval(`document.querySelector('.mcm-slot[data-slot="0"] .mcm-slot-label').textContent.includes('编排员')`),
      `成员 1（CodeAgent）标为编排员，成员都是 CodeAgent（${slots.join('、')}）`);
    await shot('03-create-orchestration');
    const before = (await c.eval(`require('electron').ipcRenderer.invoke('get-meetings')`)).length;
    await c.eval("[...document.querySelectorAll('#new-session-menu button')].find(b=>b.textContent.trim()==='创建群聊').click()");
    const orchMeeting = await waitFor(async () => { const all = await c.eval(`require('electron').ipcRenderer.invoke('get-meetings')`); return all.length > before && all.find(m => m.orchestration?.enabled && m.orchestration.sessionId); }, '编排群建出来', 60000);
    const orchSession = await c.eval(`(()=>{const s=sessions.get(${j(orchMeeting.orchestration.sessionId)});return s&&{kind:s.kind,purpose:s.purpose};})()`);
    check(orchSession && orchSession.kind === 'codeagent' && orchSession.purpose === 'hub-orchestrator', '编排员是 CodeAgent 会话（purpose=hub-orchestrator）');

    // ⑤ 编排员真的能调编排工具
    await c.eval(`selectMeeting(${j(orchMeeting.id)})`);
    await until(`!!document.querySelector('.mr-orch-strip')`, '编排状态条', 20000);
    await until(`getSessionRuntimeTruth(sessions.get(${j(orchMeeting.orchestration.sessionId)})).state !== 'starting'`, 'orchestrator ready', 120000);
    const orchAskedAt = Date.now();
    await typeInRoom('先不要派工。请调用 orch_status 查看状态，然后只用一句话告诉我有几位工作成员。');
    const toolUse = await waitFor(() => transcriptEntries(cac).find(e => e.type === 'assistant' && Date.parse(e.timestamp) > orchAskedAt
      && blocksOf(e).some(b => b.type === 'tool_use' && /orch_status$/.test(b.name))), '编排员调用 orch_status');
    const useId = toolUse.message.content.find(b => b.type === 'tool_use' && /orch_status$/.test(b.name)).id;
    const toolResult = await waitFor(() => transcriptEntries(cac).find(e => e.type === 'user' && blocksOf(e).some(b => b.type === 'tool_result' && b.tool_use_id === useId)), 'orch_status 结果', 60000);
    const block = toolResult.message.content.find(b => b.type === 'tool_result' && b.tool_use_id === useId);
    const blockText = typeof block.content === 'string' ? block.content : j(block.content);
    result.orchStatus = { name: toolUse.message.content.find(b => b.id === useId).name, isError: !!block.is_error, sample: blockText.slice(0, 200) };
    check(!block.is_error && /m2|member/i.test(blockText), `编排员调用 ${result.orchStatus.name}，工具返回成员与计划（不是报错）`);
    await sleep(8000);
    await shot('04-orchestrator-status');
    result.passed = true;
  } catch (error) {
    result.error = error && error.stack || String(error);
    if (c) { try { await shot('fail'); result.screen = await c.eval('document.body.innerText.slice(-1500)'); } catch {} }
    if (hub) { try { result.hubLogTail = hub.log().slice(-40); } catch {} }
  } finally {
    if (c) { try { c.close(); } catch {} }
    if (hub) { try { await gracefulQuit(hub); } catch (e) { result.teardownError = e.message; } }
    try { fs.rmSync(path.join(cac, '.credentials.json'), { force: true }); } catch {}
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, product: result.product, checks: result.checks, error: result.error }, null, 2));
    if (!result.passed) process.exitCode = 1;
  }
}
main();
