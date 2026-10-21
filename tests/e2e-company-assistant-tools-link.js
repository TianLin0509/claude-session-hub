'use strict';
// 公司助理「会话工具」接通（v3.1.1，2026-10-22）真实端到端：隔离 Hub（源码方式启动）+ CodeAgent 替身（真 Claude Code，模型 haiku）+ 假 welink-cli。
//   node tests/e2e-company-assistant-tools-link.js --mode normal [--out <截图目录>]
//     助理页提问「列出会话」→ 助理会话启动、会话工具状态行「正在接通」→「已接上」→ 助理确实调用 list_sessions，回答里有替身会话。
//   node tests/e2e-company-assistant-tools-link.js --mode race [--delay 120000] [--before] [--out <截图目录>]
//     竞争复现：会话工具接口推迟开始监听（CLAUDE_HUB_E2E_ASSISTANT_TOOLS_DELAY_MS，只在隔离 E2E 生效），
//     接口还没监听时就按助理的同一套参数建好助理会话，看它的 MCP 配置里有没有 hub_sessions。
//     修改后：挂上；接口迟迟不开时 90 秒翻成「未接上」并写原因 → 接口开了点「重开助理会话」→「已接上」→ 提问「列出会话」走 list_sessions。
//     --before：在修改前的代码上跑（只有推迟监听的测试钩子），只核对「没挂上」和助理答不出会话列表，不看新状态行。
// 截图 1440 宽；凭据复制进临时目录，结束后删除临时目录里的凭据。
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { randomUUID } = require('crypto');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const argv = process.argv.slice(2);
const arg = (name, d) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : d);
const MODE = arg('--mode', 'normal'), BEFORE = argv.includes('--before');
const DELAY = Number(arg('--delay', '120000'));
const OUT = path.resolve(arg('--out', path.join(__dirname, '..', 'output')));
const TAG = arg('--tag', 'claude1');
const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const CODEAGENT = path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd');
const WELINK = path.join(__dirname, 'fixtures', 'welink-cli-standin.js');
const STANDIN_TITLE = '替身会话-信道仿真';

function walk(dir, out = []) { let list = []; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; } for (const e of list) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.jsonl')) out.push(p); } return out; }

async function main() {
  assert.ok(['normal', 'race'].includes(MODE), '--mode normal|race');
  fs.mkdirSync(OUT, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-tools-link-'));
  const now = new Date(), stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const variant = `${MODE}${BEFORE ? '-before' : ''}`;
  const cac = path.join(root, '.cac'), dataDir = path.join(root, 'data'), log = path.join(root, 'welink-calls.log'), state = path.join(root, 'welink-state');
  for (const d of [cac, dataDir]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(state, 'ok');
  fs.writeFileSync(path.join(root, 'welink-exchange'), 'user001@example.com');
  const assistantDir = path.join(dataDir, 'company-assistant'), endpointFile = path.join(assistantDir, 'tools-endpoint.json');
  const mounted = id => { try { return !!JSON.parse(fs.readFileSync(path.join(dataDir, 'extra-mcp', `codeagent-${id}.json`), 'utf8')).mcpServers?.hub_sessions; } catch { return false; } };
  const result = { mode: variant, scope: '隔离 Hub（源码）+ CodeAgent 替身（真 Claude Code + haiku）+ 假 welink-cli', checks: [], shots: [], timings: {} };
  const t0 = Date.now(); const note = m => { console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`); };
  const check = (ok, label) => { assert.ok(ok, label); result.checks.push(label); note('✔ ' + label); };
  let hub, c;
  const until = async (expr, label, ms = 180000, every = 500) => { const end = Date.now() + ms; let last; while (Date.now() < end) { last = await c.eval(expr).catch(e => 'ERR ' + e.message); if (last && !String(last).startsWith('ERR ')) return last; await sleep(every); } throw Error('timeout: ' + label + ' last=' + j(last)); };
  const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); const f = path.join(OUT, `${stamp}-mcp-${variant}-${name}-${TAG}.png`); fs.writeFileSync(f, Buffer.from(s.data, 'base64')); result.shots.push(f); note('截图 ' + f); };
  const click = async sel => {
    await c.eval(`document.querySelector(${j(sel)}).scrollIntoView({block:'center'})`);
    const p = await c.eval(`(()=>{const r=document.querySelector(${j(sel)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
  };
  const toolsRow = `[...document.querySelectorAll('.ca-status .ca-connection')].map(e=>e.innerText.replace(/\\s+/g,' ')).find(t=>t.includes('会话工具'))||''`;
  const status = () => c.eval('ipcRenderer.invoke("company-assistant:status")');
  try {
    const claudeAuth = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
    fs.copyFileSync(claudeAuth, path.join(cac, '.credentials.json'));
    fs.writeFileSync(path.join(cac, '.claude.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true,
      skipDangerousModePermissionPrompt: true, hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true, hasSeenAutoModeEntryWarning: true, theme: 'dark', projects: {} }));
    fs.writeFileSync(path.join(cac, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
    fs.writeFileSync(path.join(cac, 'settings.json'), j({ model: 'haiku', permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }));

    // 竞争复现：预先写好「助理会话是 SID」（和 Hub 重启前已有助理会话一样），接口开始监听前就按助理的参数把它建起来
    const SID = randomUUID();
    if (MODE === 'race') {
      fs.mkdirSync(assistantDir, { recursive: true });
      const { TOOLS_VERSION } = require('../core/company-assistant/service');
      fs.writeFileSync(path.join(assistantDir, 'state.json'), j({ sessionId: SID, toolsVersion: TOOLS_VERSION, keywordSince: Date.now() }));
    }
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'hidden', label: 'tools-link-' + variant, extraEnv: {
      AI_HUB_CODEAGENT_COMMAND: CODEAGENT, AI_HUB_CODEAGENT_CONFIG_DIR: cac, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '',
      HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none'), CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_E2E: '1',
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_WELINK_CLI: WELINK, WELINK_STANDIN_LOG: log, WELINK_STANDIN_STATE: state,
      ...(MODE === 'race' ? { CLAUDE_HUB_E2E_ASSISTANT_TOOLS_DELAY_MS: String(DELAY) } : {}) } });
    const launchedAt = Date.now();
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions !== "undefined" && typeof ipcRenderer !== "undefined" && !!document.getElementById("btn-company-assistant")', 'renderer', 90000, 300);

    if (MODE === 'race') {
      const endpointBefore = fs.existsSync(endpointFile);
      const created = await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { id: SID, cwd: path.join(assistantDir, 'workspace'), title: '公司助理', purpose: 'company-assistant', autonomous: true, noInheritCursor: true } })}).then(s => s && s.id)`);
      const endpointAfter = fs.existsSync(endpointFile);
      result.timings.createdAfterLaunchMs = Date.now() - launchedAt;
      result.race = { sid: SID, endpointBeforeCreate: endpointBefore, endpointAfterCreate: endpointAfter, mounted: mounted(SID) };
      check(created === SID && !endpointBefore && !endpointAfter, `接口开始监听前（启动后 ${Math.round(result.timings.createdAfterLaunchMs / 1000)} 秒，接口推迟 ${DELAY / 1000} 秒）按助理参数建好助理会话`);
      if (BEFORE) check(result.race.mounted === false, '修改前：这个助理会话的 MCP 配置里没有 hub_sessions（整场会话都不带会话工具）');
      else check(result.race.mounted === true, '修改后：接口还没监听也挂上了 hub_sessions');
    }
    // 一个要被助理看到的普通会话（替身会话），工作目录放在测试临时目录里
    const workDir = path.join(root, 'work'); fs.mkdirSync(workDir, { recursive: true });
    const work = await c.eval(`ipcRenderer.invoke('create-session', { kind: 'powershell', opts: { title: ${j(STANDIN_TITLE)}, cwd: ${j(workDir)} } }).then(s => s.id)`);
    assert.ok(work);

    await click('#btn-company-assistant');
    await until(`!!document.querySelector('.ca-status .ca-connection')`, 'assistant page', 30000);

    if (MODE === 'race' && !BEFORE) {
      await until(`/会话工具/.test(${toolsRow}) && /正在接通/.test(${toolsRow})`, 'tools starting', 60000);
      await shot('01-starting');
      check(true, '助理页状态行：会话工具 正在接通…');
      // 接口一直没开：会话起来满 90 秒翻成「未接上」，写原因，带「重开助理会话」
      const missing = await until(`/未接上/.test(${toolsRow}) && !!document.querySelector('[data-ca="reopen-session"]') && /原因：/.test(document.querySelector('.ca-tools-reason')?.innerText || '') && (${toolsRow} + ' / ' + document.querySelector('.ca-tools-reason').innerText)`, 'tools missing', 150000);
      result.missingText = missing;
      check(Date.now() - launchedAt < DELAY, `接口还没开（推迟 ${DELAY / 1000} 秒）时 90 秒到点翻成「未接上」：${missing}`);
      await shot('02-missing');
      // 接口开始监听后再点「重开助理会话」
      const end = Date.now() + DELAY + 60000; while (!fs.existsSync(endpointFile) && Date.now() < end) await sleep(500);
      check(fs.existsSync(endpointFile), '会话工具接口开始监听（接口文件写好）');
      const reopenStart = Date.now();
      await click('[data-ca="reopen-session"]');
      const linked = await until(`/已接上/.test(${toolsRow}) && ${toolsRow}`, 'tools linked after reopen', 180000);
      result.timings.reopenToLinkedMs = Date.now() - reopenStart;
      const st = await status();
      result.reopen = { sessionId: st.tools.sessionId, sameSession: st.tools.sessionId === SID };
      check(true, `点「重开助理会话」后 ${Math.round(result.timings.reopenToLinkedMs / 1000)} 秒显示「${linked}」（${result.reopen.sameSession ? '同一个助理会话按原会话重启' : '换了新的助理会话'}）`);
      await shot('03-linked-after-reopen');
    }
    if (MODE === 'race' && BEFORE) {
      const end = Date.now() + DELAY + 60000; while (!fs.existsSync(endpointFile) && Date.now() < end) await sleep(500);
      check(fs.existsSync(endpointFile), '会话工具接口开始监听');
    }

    // 提问「列出会话」（真实输入框 + 发送按钮）
    const askedAt = Date.now();
    await c.eval(`(() => { const t = document.querySelector('[data-slot="form"] textarea'); t.value = '列出这台电脑 Hub 里现在有哪些会话，写出标题和状态。'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await click('[data-slot="form"] button[type="submit"]');
    if (MODE === 'normal') {
      await until(`/会话工具/.test(${toolsRow}) && /正在接通|已接上/.test(${toolsRow})`, 'tools row appears', 120000);
      const linked = await until(`/已接上/.test(${toolsRow}) && ${toolsRow}`, 'tools linked', 180000);
      result.timings.askToLinkedMs = Date.now() - askedAt;
      await shot('01-linked');
      check(true, `助理会话启动后 ${Math.round(result.timings.askToLinkedMs / 1000)} 秒，助理页显示「${linked}」`);
    }
    const answer = await until(`ipcRenderer.invoke("company-assistant:status").then(d => { const x = (d.chat || []).at(-1); return x && (x.state === 'done' || x.state === 'error') ? JSON.stringify(x) : null; })`, 'answer', 6 * 60000, 2000);
    const item = JSON.parse(answer);
    result.timings.askToAnswerMs = Date.now() - askedAt;
    result.answer = String(item.a || item.error || '').slice(0, 1200);
    await c.eval(`(() => { const s = document.querySelector('.ca-scroll'); s.scrollTop = s.scrollHeight; })()`);
    await sleep(300);
    await shot((MODE === 'normal' ? '02' : BEFORE ? '01' : '04') + '-answer');
    // 会话记录里有没有调用 list_sessions（CodeAgent 替身 = Claude Code，记录在配置目录 projects 下）
    const st = await status();
    const sid = st.session?.id;
    const files = walk(path.join(cac, 'projects'));
    const calls = [];
    for (const f of files) for (const line of fs.readFileSync(f, 'utf8').split('\n')) { if (!line.includes('mcp__hub_sessions__')) continue; try { const m = JSON.parse(line); for (const b of m.message?.content || []) if (b.type === 'tool_use' && /^mcp__hub_sessions__/.test(b.name)) calls.push(b.name); } catch { /* 半行 */ } }
    result.toolCalls = calls;
    result.transcripts = files.length;
    if (BEFORE) {
      check(item.state === 'done' || item.state === 'error', '修改前：助理答完这一问');
      check(!calls.includes('mcp__hub_sessions__list_sessions'), `修改前：助理会话没有 hub_sessions 工具，没能调用 list_sessions（会话记录里的会话工具调用：${calls.join('、') || '无'}）`);
      result.beforeAnswerMentionsStandin = result.answer.includes(STANDIN_TITLE);
    } else {
      check(item.state === 'done', '助理答完这一问');
      check(calls.includes('mcp__hub_sessions__list_sessions'), `会话记录里助理调用了 mcp__hub_sessions__list_sessions（共 ${calls.length} 次会话工具调用）`);
      check(result.answer.includes(STANDIN_TITLE), `回答里列出了替身会话「${STANDIN_TITLE}」`);
      check(st.tools?.lastTool === 'list_sessions' && st.tools?.state === 'linked', `Hub 侧记到这次调用：最近一次工具 ${st.tools?.lastTool}，状态 ${st.tools?.label}`);
      result.diagFields = await c.eval('ipcRenderer.invoke("company-assistant:status").then(d => Object.keys(d.tools || {}))');
    }
    if (MODE === 'race' && !BEFORE) {
      // 答过一轮的助理会话（已绑定原生身份）再重开一次：应走 Hub 的重启，同一个会话、同一段对话，重新接上
      const sinceBefore = (await status()).tools.since;
      const again = await c.eval('ipcRenderer.invoke("company-assistant:reopen-session")');
      result.secondReopen = again;
      await until(`ipcRenderer.invoke("company-assistant:status").then(d => d.tools && d.tools.state === 'linked' && d.tools.since > ${Number(sinceBefore) || 0})`, 'relinked after restart', 180000, 1000);
      check(again.ok && again.how === 'restart' && again.sessionId === (await status()).session?.id, `答过一轮后再重开：走 Hub 现有的重启（${again.how}），同一个助理会话重新接上`);
      await shot('05-linked-after-restart');
    }
    result.assistantSession = sid;
    result.passed = true;
  } catch (error) {
    result.error = error && error.stack || String(error);
    console.error(result.error);
    try { if (c) await shot('99-failure'); } catch { /* 截不了 */ }
  } finally {
    try { c && c.close(); } catch {}
    if (hub) await gracefulQuit(hub).catch(() => {});
    try { fs.rmSync(path.join(cac, '.credentials.json'), { force: true }); } catch {}
    result.root = root;
    const file = path.join(OUT, `${stamp}-mcp-${variant}-result-${TAG}.json`);
    fs.writeFileSync(file, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: !!result.passed, mode: variant, checks: result.checks.length, result: file, error: result.error ? String(result.error).split('\n')[0] : null }));
    if (!result.passed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
