'use strict';
// 真实验收（替身）：「昨日之我」里的 CodeAgent 记录（2026-10-13 公司版）。
// 替身 tests/fixtures/codeagent-standin 启动真 Claude Code（GLM 换成 haiku），参数原样透传。
//   ① 在 proj-alpha 跑一次 CodeAgent，记一个暗号（落盘到隔离配置目录 .cac/projects）；另放一份同暗号的 Claude 格式记录在假 ~/.claude/projects；
//   ② 打开「昨日之我」搜暗号：CodeAgent 那条标「CodeAgent」，Claude 那条仍标「Claude」；筛选栏有 CodeAgent 按钮，点它只剩 CodeAgent；
//   ③ 点 CodeAgent 那条「继续会话」：新会话是 codeagent-resume，工作目录是 proj-alpha，绑定原会话号（不发消息、不花 token）；
//   ④ 对这个会话「分支」：分支卡片不报「加载历史失败：ENOENT」，显示分支前的对话。
// E2E_ENTRY 指向公司版导出目录时验证公司版筛选栏是「全部 / CodeAgent / 群聊」。
// 隔离：搜索根只指向临时目录（Codex / Kimi / Gemini 指向空目录），不索引真实记录；凭据复制进临时目录，finally 删除。
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { spawnSync } = require('child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const STANDIN_JS = path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent-standin.js');
const STANDIN = path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd');
const SECRET = '海棠-7731';
const COMPANY = !!process.env.E2E_ENTRY;

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codeagent-search-'));
  const out = path.resolve(process.env.E2E_OUT || 'artifacts/20261013-codeagent-search-label-claude2'); fs.mkdirSync(out, { recursive: true });
  const claudeAuth = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
  const cac = path.join(root, '.cac'), dataDir = path.join(root, 'data'), empty = path.join(root, 'empty');
  const fakeClaude = path.join(root, 'claude-home', '.claude', 'projects');
  const alpha = path.join(root, 'proj-alpha');
  for (const d of [cac, dataDir, empty, fakeClaude, alpha]) fs.mkdirSync(d, { recursive: true });
  const result = { company: COMPANY, checks: [], passed: false };
  let hub, c;
  const until = async (expr, label, ms = 180000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await c.eval(expr)) return; } catch (_) {} await sleep(300); } throw Error('timeout: ' + label); };
  const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, (COMPANY ? 'company-' : 'personal-') + name + '.png'), Buffer.from(s.data, 'base64')); };
  const click = async selector => {
    const p = await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)throw Error('Missing control: '+${j(selector)});e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    await sleep(300);
  };
  const check = (ok, label) => { assert.ok(ok, label); result.checks.push(label); console.log('  ✓ ' + label); };
  const rowsExpr = `JSON.stringify([...document.querySelectorAll('.session-search-result')].map(r=>({provider:r.querySelector('.session-search-result-provider')?.textContent.trim(),cls:r.querySelector('.session-search-result-provider')?.className||'',title:r.querySelector('.session-search-result-title')?.textContent||''})))`;
  try {
    fs.copyFileSync(claudeAuth, path.join(cac, '.credentials.json'));
    fs.writeFileSync(path.join(cac, '.claude.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true,
      skipDangerousModePermissionPrompt: true, hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true,
      hasSeenAutoModeEntryWarning: true, theme: 'dark', projects: {} }));
    fs.writeFileSync(path.join(cac, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
    fs.writeFileSync(path.join(cac, 'settings.json'), j({ permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }));

    // ① 一段真实 CodeAgent 历史 + 一份同暗号的 Claude 格式记录
    const env = { ...process.env, CODEAGENT3_CONFIG_DIR: cac };
    for (const key of Object.keys(env)) if (/^CLAUDECODE$|^CLAUDE_CODE_/.test(key)) delete env[key];
    const run = spawnSync(process.execPath, [STANDIN_JS, '--disable-update', '--model', 'GLM-5.2-WX-Auto', '--permission-mode', 'bypassPermissions',
      '--output-format', 'json', '-p', `不要调用工具。请记住这个暗号：${SECRET}。只回答“记住了”。`], { cwd: alpha, env, encoding: 'utf8', timeout: 180000, windowsHide: true });
    const line = String(run.stdout || '').split(/\r?\n/).find(l => l.trim().startsWith('{'));
    const nativeId = line ? JSON.parse(line).session_id : '';
    if (!nativeId) throw Error(`seed failed: ${String(run.stderr || run.stdout).slice(0, 400)}`);
    const claudeSid = '44444444-4444-4444-8444-444444444444';
    fs.mkdirSync(path.join(fakeClaude, 'D--c'), { recursive: true });
    fs.writeFileSync(path.join(fakeClaude, 'D--c', claudeSid + '.jsonl'), [
      { type: 'user', uuid: 'cu1', sessionId: claudeSid, timestamp: new Date(Date.now() - 3600e3).toISOString(), cwd: 'D:\\c', message: { role: 'user', content: `Claude 这边也提到 ${SECRET}` } },
      { type: 'assistant', uuid: 'ca1', sessionId: claudeSid, timestamp: new Date(Date.now() - 3590e3).toISOString(), cwd: 'D:\\c', message: { role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: '好的' }] } },
    ].map(x => j(x)).join('\n') + '\n');
    check(fs.readdirSync(path.join(cac, 'projects')).length === 1, `CodeAgent 记录落在隔离配置目录（会话 ${nativeId.slice(0, 8)}…）`);

    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'hidden', label: 'codeagent search label',
      ...(COMPANY ? { entryPath: process.env.E2E_ENTRY } : {}), extraEnv: {
        AI_HUB_CODEAGENT_COMMAND: STANDIN, AI_HUB_CODEAGENT_CONFIG_DIR: cac,
        CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', AI_HUB_RULES_BASE_URL: 'http://127.0.0.1:9/hub-rules/',
        AI_HUB_UPDATE_SOURCES: j([{ id: 'x', name: 'x', manifest: 'http://127.0.0.1:9/x.json', files: 'http://127.0.0.1:9/' }]),
        HUB_SESSION_SEARCH_CLAUDE_ROOTS: [fakeClaude, path.join(cac, 'projects')].join(path.delimiter),
        HUB_SESSION_SEARCH_CODEX_ROOTS: empty, HUB_SESSION_SEARCH_KIMI_ROOTS: empty, HUB_SESSION_SEARCH_GEMINI_ROOTS: empty } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions !== "undefined"', 'renderer');
    result.version = await c.eval(`document.getElementById('hub-version')?.textContent || ''`);

    // ② 搜暗号
    await c.eval(`document.dispatchEvent(new CustomEvent('sidebar:open-search', { detail: {} }))`);
    await until(`!!document.getElementById('search-query')?.offsetParent`, 'search open', 15000);
    await click('#search-query');
    await c.send('Input.insertText', { text: SECRET });
    await until(`(()=>{const r=JSON.parse(${rowsExpr});return r.some(x=>x.provider==='CodeAgent')&&r.some(x=>x.provider==='Claude');})()`, 'both hits', 180000);
    const rows = JSON.parse(await c.eval(rowsExpr));
    result.rows = rows;
    check(rows.some(r => r.provider === 'CodeAgent' && /provider-codeagent/.test(r.cls)) && rows.some(r => r.provider === 'Claude'),
      `命中两条：${rows.map(r => r.provider).join(' / ')}（CodeAgent 记录标「CodeAgent」，Claude 记录仍标「Claude」）`);
    const chips = JSON.parse(await c.eval(`JSON.stringify([...document.querySelectorAll('#session-search-provider-filters [data-provider]')].filter(b=>!b.hidden&&b.offsetParent).map(b=>b.dataset.provider+':'+b.querySelector('b')?.textContent))`));
    result.chips = chips;
    if (COMPANY) check(chips.map(x => x.split(':')[0]).join(',') === 'all,codeagent,meeting', `公司版筛选栏：${chips.join('  ')}`);
    else check(chips.some(x => x.startsWith('codeagent:1')), `个人版有 CodeAgent 结果时显示 CodeAgent 按钮：${chips.join('  ')}`);
    await shot('01-search-all');
    await click('#session-search-provider-filters [data-provider="codeagent"]');
    await until(`(()=>{const r=JSON.parse(${rowsExpr});return r.length>0&&r.every(x=>x.provider==='CodeAgent');})()`, 'filtered', 30000);
    check(true, '点 CodeAgent 按钮后只剩 CodeAgent 的结果');
    await shot('02-search-codeagent');

    // ③ 继续会话
    const before = await c.eval('sessions.size');
    await click('.session-search-result');
    await until(`!!document.querySelector('[data-search-action="open"]')`, 'reader open', 30000);
    await click('[data-search-action="open"]');
    await until(`sessions.size > ${before}`, 'session created', 30000);
    const sid = await c.eval(`[...sessions.values()].pop().id`), q = j(sid);
    const info = JSON.parse(await c.eval(`JSON.stringify((({kind,cwd})=>({kind,cwd}))(sessions.get(${q})))`));
    result.created = info;
    check(info.kind === 'codeagent-resume' && path.resolve(info.cwd).toLowerCase() === path.resolve(alpha).toLowerCase(),
      `新会话 kind=${info.kind}，工作目录是原来的 proj-alpha`);
    await until(`sessions.get(${q}).ccSessionId === ${j(nativeId)}`, 'bound', 120000);
    check(true, `绑定原会话号 ${nativeId.slice(0, 8)}…`);
    await shot('03-resumed');

    // ④ 分支：卡片不报 ENOENT，显示分支前的对话
    await until(`getSessionRuntimeTruth(sessions.get(${q})).state !== 'starting'`, 'ready', 120000);
    const fork = JSON.parse(await c.eval(`ipcRenderer.invoke('fork-session',{sourceSessionId:${q},sourceTitle:sessions.get(${q}).title||''}).then(r=>JSON.stringify({ok:r&&r.ok,id:r&&r.session&&r.session.id,message:r&&r.message}))`));
    result.fork = fork;
    check(fork.ok && fork.id, '分支创建成功');
    const fq = j(fork.id);
    await until(`!!sessions.get(${fq})`, 'fork in renderer', 30000);
    await c.eval(`selectSession(${fq})`);
    await c.eval(`applyViewMode('card')`);
    await until(`!!sessions.get(${fq}).transcriptPath`, 'fork transcript bound by hook', 120000);
    const forkPath = await c.eval(`sessions.get(${fq}).transcriptPath`);
    result.forkTranscriptExists = fs.existsSync(forkPath);
    await c.eval(`loadSessionHistoryToOverlay(${fq})`);
    await sleep(2500);
    const forkView = JSON.parse(await c.eval(`JSON.stringify({text:document.getElementById('msg-overlay')?.innerText||'',cards:document.querySelectorAll('#msg-overlay .turn-card').length})`));
    result.forkView = { cards: forkView.cards, text: forkView.text.slice(0, 600) };
    check(!/加载历史失败|历史同步暂未完成|ENOENT/.test(forkView.text),
      `分支卡片没有 ENOENT 报错（分支记录文件${result.forkTranscriptExists ? '已' : '尚未'}生成）`);
    check(forkView.cards > 0 && forkView.text.includes(SECRET), `分支卡片显示分支前的对话（${forkView.cards} 张卡）`);
    await shot('04-fork-card');
    result.passed = true;
  } catch (error) {
    result.error = error && error.stack || String(error);
    if (c) { try { await shot('fail'); result.screen = await c.eval('document.body.innerText.slice(-1500)'); } catch {} }
    if (hub) { try { result.hubLogTail = hub.log().slice(-40); } catch {} }
  } finally {
    if (c) { try { c.close(); } catch {} }
    if (hub) { try { await gracefulQuit(hub); } catch (e) { result.teardownError = e.message; } }
    try { fs.rmSync(path.join(cac, '.credentials.json'), { force: true }); } catch {}
    fs.writeFileSync(path.join(out, (COMPANY ? 'company' : 'personal') + '-result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, version: result.version, checks: result.checks, error: result.error }, null, 2));
    if (!result.passed) process.exitCode = 1;
  }
}
main();
