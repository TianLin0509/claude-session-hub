'use strict';
// Real isolated Electron and real UI actions. WeLink is synthetic; --ai also exercises real Claude as the CodeAgent-compatible test driver.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage, connectCDP } = require('./helpers/cdp-client');
const pause = ms => new Promise(r => setTimeout(r, ms));
const port = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const root = path.resolve(__dirname, '..'), out = path.join(root, 'artifacts', `20261023-team-e2e-codex1-${process.pid}`);
const realAI = process.argv.includes('--ai');
async function main() {
  fs.mkdirSync(out, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-team-e2e-')), dataDir = path.join(temp, 'data'), profile = path.join(temp, 'codeagent-profile');
  fs.mkdirSync(path.join(dataDir, 'company-assistant'), { recursive: true }); fs.mkdirSync(profile);
  const fixtureState = path.join(temp, 'welink-state'); fs.writeFileSync(fixtureState, 'ok');
  fs.writeFileSync(path.join(temp, 'welink-exchange'), 'demo@example.com');
  fs.writeFileSync(path.join(dataDir, 'company-assistant', 'settings.json'), JSON.stringify({ enabled: true, refreshMinutes: 1440, briefTime: '23:59', phone: { enabled: false } }));
  const auth = path.join(profile, '.credentials.json');
  const result = { realHub: true, syntheticWelink: true, realAI, checks: [], dataDir };
  let hub, c;
  // CDPClient returns a RemoteObject for JavaScript undefined; only true is a pass.
  const until = async (fn, label, timeout = 60000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn() === true) return; await pause(200); } throw new Error('等待超时：' + label); };
  const expr = (value, label, timeout) => until(() => c.eval(value).catch(() => false), label, timeout);
  const click = async selector => {
    const point = await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    assert.ok(point, '可点击元素：' + selector);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };
  const input = async (selector, text) => { await click(selector); await c.send('Input.insertText', { text }); };
  const shot = async name => { const png = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, `20261023-team-${name}.png`), Buffer.from(png.data, 'base64')); };
  try {
    if (realAI) {
      fs.copyFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json'), auth);
      fs.writeFileSync(path.join(profile, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true, skipDangerousModePermissionPrompt: true, hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true, hasSeenAutoModeEntryWarning: true, projects: {} }));
      fs.writeFileSync(path.join(profile, '.cac.json'), JSON.stringify({ hasCompletedOnboarding: true, projects: {} }));
      fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ model: 'haiku', permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }));
    }
    hub = await launchIsolatedHub({ dataDir, port: await port(), label: 'team-e2e', windowMode: 'background', extraEnv: {
      CLAUDE_HUB_E2E: '1', CLAUDE_HUB_TEAM: '1', CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: realAI ? '1' : '0', CLAUDE_HUB_FORUM_TIMER: '0',
      CLAUDE_HUB_WELINK_CLI: path.join(__dirname, 'fixtures', 'welink-cli-standin.js'), WELINK_STANDIN_STATE: fixtureState,
      WELINK_STANDIN_LOG: path.join(temp, 'welink-calls.jsonl'), WELINK_STANDIN_PAD: '0', WELINK_STANDIN_FOUNDATION: '1',
      HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(temp, 'none'), AI_HUB_CODEAGENT_CONFIG_DIR: profile,
      ...(realAI ? { AI_HUB_CODEAGENT_COMMAND: path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd'), CODEAGENT_STANDIN_NO_CHROME: '1' } : {}),
    } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await expr(`!!document.getElementById('btn-team')`, '团队入口'); await click('#btn-team');
    await expr(`document.querySelector('#team-page .tp-status')?.textContent.includes('暂不可用')`, '未核实登录不可用');
    result.checks.push('真实UI未核实登录不展示旧数据');
    // Use the real assistant refresh button to establish fixture login; do not patch team state via IPC.
    await click('#btn-company-assistant');
    await expr(`!!document.querySelector('[data-ca="refresh"]')`, '助理刷新'); await click('[data-ca="refresh"]');
    await expr(`document.querySelector('[data-ca="refresh"]')?.disabled===false`, '合成WeLink刷新', 120000);
    await click('#btn-team');
    await expr(`document.querySelector('#team-page .tp-status')?.textContent.includes('已连接')`, '登录状态传播');
    await click('[data-team="tab"][data-tab="members"]');
    await input('input[data-draft="memberInput"]', 'colleague_z'); await click('[data-team="resolve"]');
    await expr(`!!document.querySelector('[data-team="follow"]')`, '核对成员');
    await click('[data-team="follow"]');
    await expr(`document.querySelector('.tp-member')?.textContent.includes('示例发言人')`, '关注成功');
    await click('[data-team="refresh"]');
    await expr(`!document.querySelector('[data-team="refresh"]')?.disabled && document.querySelector('.tp-member')?.textContent.includes('最终决定：周三交付')`, '全文采集', 120000);
    await click('.tp-member > details > summary');
    await shot('members'); result.checks.push('查账号→确认关注→7天范围真实采集链→完整尾部原文');
    if (realAI) {
      await click('[data-team="analyze"]');
      await until(async () => {
        await click('[data-team="reload"]');
        const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'team-workspace', require('node:crypto').createHash('sha256').update('user001').digest('hex') + '.json'), 'utf8'));
        const analysis = state.analyses.at(-1);
        if (analysis?.state === 'error') throw new Error('真实模型分析失败：' + analysis.error);
        if (analysis?.state !== 'done' || !analysis.findings?.length) return false;
        result.analysis = { state: analysis.state, findingCount: analysis.findings.length, text: analysis.text };
        return c.eval(`!document.getElementById('team-page').hidden && document.querySelector('.tp-member')?.textContent.includes('周三') && document.querySelector('.tp-member')?.textContent.includes('已生成，待你核实')`);
      }, '真实模型分析', 300000);
      await click('.tp-member > details > summary'); await shot('real-ai');
      result.checks.push('真实模型从本机材料生成含出处的分析');
    }
    await click('[data-team="tab"][data-tab="commitments"]');
    await input('input[data-draft="commitmentTitle"]', '周五前协调联调窗口（合成验收）'); await click('[data-team="commitment.add"]');
    await expr(`!!document.querySelector('.tp-commitment')`, '确认承诺'); await click('[data-team="commitment.done"]');
    await expr(`document.querySelector('.tp-commitment')?.textContent.includes('已完成')`, '标记完成');
    await click('[data-team="tab"][data-tab="weekly"]'); await click('[data-team="weekly.draft"]');
    await expr(`!!document.querySelector('.tp-weekly-editor')`, '生成周报草稿');
    assert.match(await c.eval(`document.querySelector('.tp-weekly-editor').value`), /协调联调窗口/);
    result.checks.push('确认承诺→完成→周报草稿，未提交到云端'); await shot('weekly');
    for (const tab of ['today', 'members', 'weekly', 'commitments', 'tools']) { await click(`[data-team="tab"][data-tab="${tab}"]`); assert.equal(await c.eval('document.documentElement.scrollWidth > innerWidth + 1'), false); }
    result.checks.push('五子页真实点击、1440宽度无整页横溢');
    await click('[data-team="web"][data-tool="captain"]');
    // Read-only public login page. It intentionally rejects iframe but works as a top-level WebContentsView.
    let remote;
    await until(async () => { const targets = await (await fetch(`http://127.0.0.1:${hub.port}/json/list`)).json(); remote = targets.find(t => /\/captain\//.test(t.url)); return !!remote; }, '工具顶层页面', 45000);
    const wc = await connectCDP(remote.webSocketDebuggerUrl);
    try {
      assert.equal(await wc.eval('typeof require'), 'undefined'); assert.equal(await wc.eval('typeof process'), 'undefined');
      await until(() => wc.eval(`location.href.includes('/captain/') && document.readyState==='complete' && !!document.title`).catch(() => false), '工具页面加载', 45000);
      result.remoteTitle = await wc.eval('document.title'); assert.ok(result.remoteTitle);
      const remoteShot = await wc.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(out, '20261023-team-cloud-login.png'), Buffer.from(remoteShot.data, 'base64'));
    } finally { await wc.close(); }
    await click('[data-team="web.close"]'); await click('#btn-home');
    await expr(`document.getElementById('team-page').hidden`, '返回主页'); await click('#btn-team');
    result.checks.push('真实公网门禁页在顶层视图打开，Node不可用；返回与重新打开团队页正常');
    await shot('tools'); result.status = 'passed';
  } catch (error) { result.status = 'failed'; result.error = error.stack; process.exitCode = 1; if (c) await shot('failure').catch(() => {}); }
  finally {
    if (c) await c.close().catch(() => {});
    if (hub) { result.hubLogTail = hub.log().slice(-12); result.teardown = await gracefulQuit(hub).catch(e => ({ error: e.message })); }
    if (fs.existsSync(auth)) fs.unlinkSync(auth);
    fs.writeFileSync(path.join(out, `20261023-team-e2e${realAI ? '-real-ai' : ''}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
