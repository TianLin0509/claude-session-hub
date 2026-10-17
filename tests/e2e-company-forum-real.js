'use strict';
// 真实验收（替身）：公司版「论坛」页在隔离 Hub 里的完整链路（2026-10-18）。
//   论坛用本机两个假站（tests/fixtures/forum-standin.js：真的单页应用、数据走接口，稼先要登录、心声不用）；
//   CodeAgent 用替身（真 Claude Code，配置成 haiku）写摘要。
//   覆盖：左侧「论坛」按钮（在「助理」下面）→ 打开页面自动同步：心声出两个榜，稼先提示登录 → 点「登录」弹出 Hub 自己的浏览器窗口，
//   在里面登录 → 窗口自动关掉、稼先出热榜（点过「热点」tab、带阅读和回复数）→ AI 看点和每帖摘要出来，看点的出处能点到帖子 →
//   切心声的「24小时回复」榜 → 只能打开这两个站的网址 → 隐藏窗口不抢 Hub 主窗口标题。截图（1440 宽）存 output/。
//   node tests/e2e-company-forum-real.js
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { execFileSync } = require('child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage, connectCDP } = require('./helpers/cdp-client');
const { startForumStandin } = require('./fixtures/forum-standin');

const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const CODEAGENT = path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd');
const targets = hub => new Promise(resolve => require('http').get(`${hub.cdpHttpBase}/json/list`, res => { let b = ''; res.on('data', d => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve([]); } }); }).on('error', () => resolve([])));

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-company-forum-'));
  const out = path.resolve(__dirname, '..', 'output'); fs.mkdirSync(out, { recursive: true });
  const now = new Date(), stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const cac = path.join(root, '.cac'), dataDir = path.join(root, 'data');
  for (const d of [cac, path.join(dataDir, 'company-assistant'), path.join(dataDir, 'company-forum')]) fs.mkdirSync(d, { recursive: true });
  const claudeAuth = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
  const result = { checks: [], shots: [] };
  const sites = await startForumStandin();
  let hub, c;
  const until = async (expr, label, ms = 120000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.eval(expr).catch(() => false)) return; await sleep(400); } throw Error('timeout: ' + label); };
  const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); const f = path.join(out, `${stamp}-company-forum-${name}-claude2.png`); fs.writeFileSync(f, Buffer.from(s.data, 'base64')); result.shots.push(f); };
  const status = () => c.eval(`ipcRenderer.invoke('company-forum:status')`);
  try {
    fs.copyFileSync(claudeAuth, path.join(cac, '.credentials.json'));
    fs.writeFileSync(path.join(cac, '.claude.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true,
      skipDangerousModePermissionPrompt: true, hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true, hasSeenAutoModeEntryWarning: true, theme: 'dark', projects: {} }));
    fs.writeFileSync(path.join(cac, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
    fs.writeFileSync(path.join(cac, 'settings.json'), j({ model: 'haiku', permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }));
    // 助理已从 WeLink 读到的邮箱：论坛用它的域名（站点地址由测试开关指到本机假站）。测试可能在周末跑：工作日设成每天。
    fs.writeFileSync(path.join(dataDir, 'company-assistant', 'settings.json'), j({ email: 'user001@example.com', emailFrom: 'welink' }));
    fs.writeFileSync(path.join(dataDir, 'company-forum', 'settings.json'), j({ workdays: [0, 1, 2, 3, 4, 5, 6], summarize: 6 }));

    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'hidden', label: 'company-forum', extraEnv: {
      AI_HUB_CODEAGENT_COMMAND: CODEAGENT, AI_HUB_CODEAGENT_CONFIG_DIR: cac, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '',
      HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none'), CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0',
      CLAUDE_HUB_COMPANY_FORUM: '1', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_FORUM_SITES: j({ jx: sites.jxBase, xinsheng: sites.xsBase }) } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions !== "undefined" && !!document.getElementById("btn-company-forum")', 'rail button', 60000);
    const order = await c.eval(`[...document.querySelectorAll('#scene-rail .rail-navigation > button')].filter(b => !b.hidden && getComputedStyle(b).display !== 'none').map(b => b.id)`);
    assert.equal(order[order.indexOf('btn-company-assistant') + 1], 'btn-company-forum', order.join(','));
    result.checks.push('左侧「论坛」按钮在「助理」下面');

    // ① 打开：自动同步；心声出两个榜，稼先提示登录
    await c.eval(`document.getElementById('btn-company-forum').click()`);
    await until(`!document.getElementById('company-forum-page')?.hidden`, 'page open', 10000);
    assert.equal(await c.eval(`document.getElementById('btn-company-forum').classList.contains('cw-current') || document.getElementById('btn-company-forum').classList.contains('active')`), true);
    await until(`document.querySelectorAll('.cf-site[data-site="xinsheng"] .cf-post').length >= 10 && !!document.querySelector('.cf-site[data-site="jx"] [data-cf="login"]')`, 'xinsheng posts + jx login', 120000);
    const s1 = await status();
    assert.equal(s1.domain, 'example.com'); assert.equal(s1.domainFrom, 'email');
    const xsLists = s1.snapshot.sites.find(s => s.id === 'xinsheng').lists;
    assert.deepEqual(xsLists.map(l => [l.key, l.posts.length]), [['click', 10], ['reply', 6]]);
    assert.equal(xsLists[0].posts[0].title, sites.click[0].title, '心声点击榜第一名照站点顺序');
    assert.equal(xsLists[0].from, 'api-card', '心声排行取自卡片接口（页面条目没有链接）');
    assert.ok(xsLists[0].posts[0].url.endsWith('/next/detail/#/index?uuid=xs901&uniqueType=homeRanking'));
    assert.equal(s1.snapshot.sites.find(s => s.id === 'jx').needsLogin, true);
    assert.ok(!sites.log.some(r => r.site === 'jx' && r.path.includes('homeHotResources') && r.loggedIn), '没登录时取不到稼先热榜');
    await shot('01-xinsheng-ok-jx-login');
    result.checks.push('打开论坛页自动同步：心声出「24小时点击」10 条、「24小时回复」6 条，顺序同站点；稼先没登录，那一栏显示「登录」');

    // ② 点「登录」：弹出 Hub 自己的浏览器窗口，在里面登录；窗口自动关掉，稼先出热榜
    await c.eval(`document.querySelector('.cf-site[data-site="jx"] [data-cf="login"]').click()`);
    let loginTarget = null;
    for (let i = 0; i < 60 && !loginTarget; i += 1) { loginTarget = (await targets(hub)).find(t => t.type === 'page' && t.url.startsWith(sites.jxBase + '/login')); if (!loginTarget) await sleep(500); }
    assert.ok(loginTarget, '登录窗口打开到了稼先的登录页');
    const lw = await connectCDP(loginTarget.webSocketDebuggerUrl);
    for (let i = 0; i < 40 && !(await lw.eval(`!!document.getElementById('go')`).catch(() => false)); i += 1) await sleep(250);
    const loginShot = await lw.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, `${stamp}-company-forum-02-login-window-claude2.png`), Buffer.from(loginShot.data, 'base64'));
    result.shots.push(path.join(out, `${stamp}-company-forum-02-login-window-claude2.png`));
    await lw.eval(`document.getElementById('go').click()`);
    await lw.close();
    for (let i = 0; i < 40 && (await targets(hub)).some(t => t.url.startsWith(sites.jxBase) && t.type === 'page' && !/postsDetails/.test(t.url) && t.id === loginTarget.id); i += 1) await sleep(500);
    assert.ok(!(await targets(hub)).some(t => t.id === loginTarget.id), '登录好了窗口自动关掉');
    await until(`document.querySelectorAll('.cf-site[data-site="jx"] .cf-post').length >= 8`, 'jx posts after login', 120000);
    const s2 = await status();
    const jxHot = s2.snapshot.sites.find(s => s.id === 'jx').lists[0];
    assert.equal(jxHot.posts[0].title, sites.hot[0].title, '取的是点「热点」后的热榜，不是推荐流');
    assert.equal(jxHot.posts[0].views, sites.hot[0].browseCount);
    assert.equal(jxHot.from, 'api', '稼先热榜取自 homeHotResources 接口，不是推荐流或热门话题');
    assert.equal(jxHot.posts[0].author, '作者1');
    assert.equal(jxHot.posts[0].replies, sites.hot[0].commentCount);
    assert.ok(/阅读 9000 · 回复 120/.test(await c.eval(`document.querySelector('.cf-site[data-site="jx"] .cf-meta').innerText`)));
    assert.ok(sites.log.some(r => r.site === 'jx' && r.path.includes('homeHotResources') && r.loggedIn));
    result.checks.push('点「登录」弹出 Hub 自己的浏览器窗口（稼先登录页），登录后窗口自动关掉；稼先出「热点」8 条，带阅读、回复数（来自接口），不是推荐流');

    // ③ AI 摘要：看点 + 每帖一句话，出处能点到帖子
    await until(`document.querySelectorAll('.cf-overview li').length >= 2 && document.querySelectorAll('.cf-sum').length >= 3`, 'ai summary', 6 * 60000);
    const s3 = await status();
    const summarized = s3.snapshot.sites.flatMap(s => s.lists.flatMap(l => l.posts)).filter(p => p.summary);
    assert.ok(summarized.length >= 3, '至少 3 条帖子有摘要');
    assert.ok(s3.snapshot.overview.every(o => o.refs.length), '每句看点都指回帖子');
    const allTitles = new Set(s3.snapshot.sites.flatMap(s => s.lists.flatMap(l => l.posts.map(p => p.title))));
    assert.ok(s3.snapshot.overview.every(o => o.refs.every(r => allTitles.has(r.title))));
    const excerpts = s3.snapshot.sites.flatMap(s => s.lists.flatMap(l => l.posts)).filter(p => p.excerpt).length;
    const xsTop = s3.snapshot.sites.find(s => s.id === 'xinsheng').lists[0].posts[0];
    assert.equal(xsTop.views, 30000, '心声的阅读数从详情接口补上');
    assert.equal(xsTop.replies, 300);
    assert.ok(excerpts >= 4, '排在前面的帖子读到了正文摘录：' + excerpts);
    await shot('03-summary');
    await c.eval(`document.querySelector('.cf-ref').click()`);
    await until(`!!document.querySelector('.cf-post.flash')`, 'jump flash', 5000);
    result.checks.push(`AI 看点 ${s3.snapshot.overview.length} 句、${summarized.length} 条帖子有一句话摘要，${excerpts} 条读到正文摘录；看点后面的出处能点到对应帖子`);

    // ④ 切心声「24小时回复」榜
    await c.eval(`document.querySelector('.cf-site[data-site="xinsheng"] [data-list="reply"]').click()`);
    await until(`document.querySelectorAll('.cf-site[data-site="xinsheng"] .cf-post').length === 6`, 'reply tab', 5000);
    await shot('04-xinsheng-reply-tab');
    result.checks.push('心声切到「24小时回复」榜，显示 6 条');

    // ⑤ 只放行这两个站的网址（不真的打开系统浏览器）
    const evil = await c.eval(`ipcRenderer.invoke('company-forum:open-url', { url: 'https://evil.example/' })`);
    assert.equal(evil.ok, false); assert.match(evil.error, /只能打开论坛站点/);
    const firstUrl = await c.eval(`document.querySelector('.cf-post-title[data-url]').dataset.url`);
    assert.ok(firstUrl.startsWith(sites.jxBase) || firstUrl.startsWith(sites.xsBase));
    result.checks.push('点帖子只会用系统浏览器打开这两个站的网址，别的网址拒绝');

    // ⑥ 隐藏窗口不抢主窗口：页面目标里主窗口还在，进程主窗口标题仍是 Hub
    const title = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${hub.pid}).MainWindowTitle`], { encoding: 'utf8', windowsHide: true }).trim();
    result.mainWindowTitle = title;
    assert.ok(!/论坛|登录/.test(title), '进程主窗口标题不是论坛窗口：' + title);
    const sessionId = s3.session;
    const sess = await c.eval(`(sessions.get(${j(sessionId)}) || {}).purpose || (sessions.get(${j(sessionId)}) || {}).info?.purpose || ''`).catch(() => '');
    result.summarySessionPurpose = sess;
    result.checks.push('论坛的隐藏窗口挂在宿主下，进程主窗口标题仍是 Hub：' + (title || '（窗口隐藏，标题为空）'));
    result.ok = true;
  } catch (error) {
    result.error = error.message;
    try { result.lastStatus = await status(); } catch {}
    try { const sid = result.lastStatus && result.lastStatus.session; result.sessionInfo = await c.eval(`(() => { const s = sessions.get(${j(sid)}); return s ? { kind: s.kind, status: s.status, ccSessionId: s.ccSessionId, transcriptPath: s.transcriptPath, agentTurnActive: s.agentTurnActive, keys: Object.keys(s).slice(0, 80) } : null; })()`); } catch (e) { result.sessionInfo = e.message; }
    throw error;
  } finally {
    try { result.hubLog = hub ? hub.log().filter(l => /forum|论坛|Error|error/i.test(l)).slice(-60) : []; } catch {}
    try { c && c.close(); } catch {}
    if (hub) { try { await gracefulQuit(hub); } catch (e) { result.teardownError = e.message; } }
    try { fs.rmSync(path.join(cac, '.credentials.json'), { force: true }); } catch {}
    await sites.close().catch(() => {});
    result.requests = sites.log.length;
    fs.writeFileSync(path.join(out, `${stamp}-company-forum-e2e-claude2.json`), JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
