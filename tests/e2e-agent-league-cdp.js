'use strict';

// Isolated real-Hub E2E for the native Chuxin Agent League tab.
// Production Hub/data are untouched; one real Codex PTY is created without sending a model prompt.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { AgentLeagueStore } = require('../core/agent-league-store.js');
const { PHILOSOPHY_TEMPLATES } = require('../core/agent-league-philosophies.js');
const { validateDecision, validateHookReview, validateWeeklyReview } = require('../core/agent-league-accounting.js');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const HUB_ROOT = path.resolve(__dirname, '..');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const TEMP_ROOT = path.join(os.tmpdir(), `agent-league-e2e-${process.pid}-${STAMP}`);
const LEAGUE_ROOT = path.join(TEMP_ROOT, 'league');
const OUTPUT = path.join(HUB_ROOT, 'output', 'playwright', `agent-league-${STAMP}`);

function freePort(start = 25280) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      if (port > start + 50) return reject(new Error('no isolated CDP port available'));
      const server = net.createServer();
      server.once('error', () => tryPort(port + 1));
      server.once('listening', () => server.close(() => resolve(port)));
      server.listen(port, '127.0.0.1');
    };
    tryPort(start);
  });
}

async function waitEval(client, expression, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await client.eval(`Boolean(${expression})`)) return; } catch {}
    await _waitMs(200);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function screenshot(client, name) {
  const result = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const target = path.join(OUTPUT, name);
  fs.writeFileSync(target, Buffer.from(result.data, 'base64'));
  return target;
}

function seedLeague() {
  const store = new AgentLeagueStore({ root: LEAGUE_ROOT });
  const providers = [
    ['codex-cli', 'codex', 'gpt-5.6-sol'],
    ['claude-cli', 'claude', 'claude-opus-5[1m]'],
    ['gemini-cli', 'gemini', 'gemini-3-pro-preview'],
  ];
  const returns = [0.0312, 0.0274, 0.0231, 0.0144, 0.0089, 0.0042, -0.0018, -0.0054, -0.0112, -0.0205];
  const names = ['衡策', '逐浪', '远见', '守拙', '知止', '拾贝', '破浪', '矩衡', '慎行', '择时'];
  for (let index = 0; index < 10; index += 1) {
    const philosophy = PHILOSOPHY_TEMPLATES[index % PHILOSOPHY_TEMPLATES.length];
    const provider = providers[index % providers.length];
    const id = `fixture-agent-${String(index + 1).padStart(2, '0')}`;
    store.createAgent({
      id,
      name: names[index],
      provider: provider[0],
      kind: provider[1],
      model: provider[2],
      philosophy,
      initialCash: 500_000,
    });
    const nav = 500_000 * (1 + returns[index]);
    store.savePortfolio(id, {
      initialCash: 500_000,
      cash: nav,
      positions: [],
      pendingDecision: null,
      navHistory: [{ date: '2026-08-25', nav, cash: nav, marketValue: 0, dailyReturn: returns[index] / 4 }],
    });
    if (index === 0) {
      const draft = validateDecision({
        action_summary: '卖出失效持仓，试探一只预期差标的', market_view: '风险偏好回升但高位拥挤仍在',
        core_conflict: '逻辑改善与短期位置不舒服同时存在', cash_target: 0.8,
        targets: [{
          symbol: '600001.SH', name: '测试股', target_weight: 0.2, conviction: 0.65, horizon_days: 20,
          rule_refs: ['C1', 'P1', 'R2'], thesis: '改善证据尚未充分计价', counter_evidence: '短期涨幅较快',
          timing_reason: '只用试探仓验证，不追求一次买满', invalidation: '验证数据转弱或关键结构失守',
        }], watchlist: [], risk_notes: ['高位拥挤'], memory_note: '沿用不追高纪律',
      });
      const hook = validateHookReview({
        verdict: 'PASS', rule_checks: [{ rule_id: 'P1', status: 'PASS', comment: '仓位已经反映位置不舒服。' }],
        strongest_counter_evidence: '短期估值扩张可能领先改善。', timing_check: '已比较等待与现金。',
        portfolio_check: '80% 现金与当前证据匹配。', behavior_check: '未受排行榜影响。', account_feasibility: '50 万账户可按 100 股整数倍执行。',
        changes: [], final_decision: draft,
        daily_brief: {
          headline: '逻辑看对了，也不代表今天值得重仓',
          body: '今天最重要的矛盾是改善逻辑和短期位置不舒服同时存在。我认可这只股票的预期差，但最强反证是估值扩张已经走在验证前面，因此只保留试探仓并维持高现金。如果后续验证数据转弱或关键结构失守，我会承认判断错误，而不是为了排名补仓。',
          hook_change: '自检后没有改变仓位，原预案已经把追高风险压进仓位。', video_hooks: ['好逻辑不等于好买点'],
        },
      }, { draft });
      store.recordRunStart(id, { runId: 'fixture-daily', decisionDate: '2026-08-27', dataAsOf: '2026-08-26' });
      store.recordDraft(id, { runId: 'fixture-daily', decisionDate: '2026-08-27', dataAsOf: '2026-08-26', draft });
      store.recordDecision(id, { runId: 'fixture-daily', decisionDate: '2026-08-27', dataAsOf: '2026-08-26', decision: draft, hook, dailyBrief: hook.daily_brief });
      const review = validateWeeklyReview({
        summary: '本周最有价值的是在逻辑成立时仍然保持价格纪律。', process_win: '没有因上涨扩大仓位。',
        process_mistake: '对等待条件的描述还不够具体。', lesson: '等待应写出可验证的触发条件。',
        strongest_counterexample: '过度等待也可能错失继续上涨。', evidence_for: ['两次克制'], evidence_against: ['一次踏空'], checklist_proposal: null,
      });
      store.recordWeeklyStart(id, { runId: 'fixture-weekly', saturdayDate: '2026-08-29', tradingDates: ['2026-08-27'] });
      store.recordWeeklyReview(id, { runId: 'fixture-weekly', saturdayDate: '2026-08-29', review });
    }
  }
}

function removeTempRoot() {
  const resolved = path.resolve(TEMP_ROOT);
  const temp = path.resolve(os.tmpdir());
  if (!resolved.startsWith(temp + path.sep)) return;
  if (!path.basename(resolved).startsWith('agent-league-e2e-')) return;
  fs.rmSync(resolved, { recursive: true, force: true });
}

(async () => {
  fs.mkdirSync(OUTPUT, { recursive: true });
  seedLeague();
  const port = await freePort();
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir: path.join(TEMP_ROOT, 'hub-data'),
      port,
      label: 'agent-league',
      windowMode: 'hidden',
      extraEnv: {
        CHUXIN_AGENT_LEAGUE_DIR: LEAGUE_ROOT,
        CHUXIN_DIR: 'C:\\Users\\lintian\\chuxin-research',
        CHUXIN_API_BASE: 'http://127.0.0.1:3004',
        CHUXIN_WEB_BASE: 'http://127.0.0.1:3003',
      },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''));
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
    await waitEval(client, 'document.getElementById("btn-chuxin") && document.querySelector(".cx-primary-tab[data-tab=league]")', 'Agent League tab');
    await client.eval(`(() => {
      window.__agentLeagueErrors = [];
      window.addEventListener('error', event => window.__agentLeagueErrors.push(String(event.error || event.message)));
      window.addEventListener('unhandledrejection', event => window.__agentLeagueErrors.push(String(event.reason)));
      document.getElementById('btn-chuxin').click();
      document.querySelector('.cx-primary-tab[data-tab="league"]').click();
    })()`);
    await waitEval(client, 'document.querySelectorAll(".cxl-row").length === 10', 'ten leaderboard rows');
    const ranking = await client.eval(`(() => {
      const list = document.querySelector('.cxl-ranking');
      return {
        rows: document.querySelectorAll('.cxl-row').length,
        first: document.querySelector('.cxl-row .cxl-agent b')?.textContent,
        viewWidth: Math.round(document.querySelector('.cx-view-league').getBoundingClientRect().width),
        clientHeight: list.clientHeight,
        scrollHeight: list.scrollHeight,
        visibleRows: Math.floor(list.clientHeight / 58),
        aggregateTotalVisible: document.querySelector('.cxl-root').innerText.includes('模拟总资产'),
      };
    })()`);
    assert.equal(ranking.rows, 10);
    assert.equal(ranking.first, '衡策');
    assert.equal(ranking.scrollHeight, 580);
    assert.equal(ranking.aggregateTotalVisible, false);
    assert(ranking.viewWidth > 800, JSON.stringify(ranking));
    assert(ranking.visibleRows >= 6 && ranking.visibleRows <= 8, JSON.stringify(ranking));
    const leaderboardShot = await screenshot(client, '01-leaderboard.png');

    await client.eval(`document.querySelector('.cxl-row').click()`);
    await waitEval(client, '!document.querySelector("[data-role=detail-overlay]").hidden && document.querySelector(".cxl-drawer")', 'Agent detail drawer');
    assert.equal(await client.eval(`/打开卡片 Session|创建卡片 Session/.test(document.querySelector('.cxl-drawer').innerText)`), true);
    assert.equal(await client.eval(`/打开 PTY|创建并打开 PTY/.test(document.querySelector('.cxl-drawer').innerText)`), true);
    assert.equal(await client.eval(`document.querySelector('.cxl-drawer').innerText.includes('DRAFT')`), true);
    assert.equal(await client.eval(`document.querySelector('.cxl-drawer').innerText.includes('DAILY BRIEF')`), true);
    assert.equal(await client.eval(`document.querySelector('.cxl-drawer').innerText.includes('周六沉淀')`), true);
    assert.equal(await client.eval(`document.querySelector('.cxl-drawer').innerText.includes('个人 CHECKLIST')`), true);
    const detailShot = await screenshot(client, '02-detail.png');
    await client.eval(`document.querySelector('[data-action="edit-prompts"]').click()`);
    await waitEval(client, `!document.querySelector('[data-role="prompt-overlay"]').hidden && document.querySelectorAll('[data-prompt-key]').length >= 19`, 'prompt workbench');
    const promptInitial = await client.eval(`(() => ({
      title: document.querySelector('[data-role="prompt-file-title"]').textContent,
      editable: !document.querySelector('[data-role="prompt-editor"]').readOnly,
      hasCore: document.querySelector('[data-role="prompt-editor"]').value.includes('核心理念'),
      hasMachine: !document.querySelector('[data-role="machine-state"]').hidden
    }))()`);
    assert.deepEqual(promptInitial, { title: '核心投资人格', editable: true, hasCore: true, hasMachine: true });
    await client.eval(`(() => {
      const editor = document.querySelector('[data-role="prompt-editor"]');
      editor.value += '\\n\\n## E2E 编辑标记\\n\\nPROMPT-EDITOR-E2E';
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-action="save-prompt"]').click();
    })()`);
    await waitEval(client, `document.querySelector('[data-role="prompt-status"]').textContent.includes('保存成功')`, 'prompt save');
    const promptSaved = await client.eval(`(async()=>{
      const result=await require('electron').ipcRenderer.invoke('agent-league:prompt-files',{agentId:'fixture-agent-01'});
      return result.files.find(row=>row.key==='agent').content.includes('PROMPT-EDITOR-E2E');
    })()`);
    assert.equal(promptSaved, true);
    await client.eval(`document.querySelector('[data-prompt-key="contractHook"]').click()`);
    await waitEval(client, `document.querySelector('[data-role="prompt-file-title"]').textContent.includes('决策 Hook') && document.querySelector('[data-role="prompt-editor"]').readOnly`, 'read-only hook contract');
    const promptShot = await screenshot(client, '02c-prompt-workbench.png');
    await client.eval(`document.querySelector('[data-action="close-prompts"]').click()`);
    await client.eval(`document.querySelector('[data-action="close-detail"]').click()`);

    await client.eval(`document.documentElement.setAttribute('data-theme', 'codex')`);
    await _waitMs(180);
    const lightTheme = await client.eval(`(() => {
      const root = getComputedStyle(document.querySelector('.cxl-root'));
      const row = getComputedStyle(document.querySelector('.cxl-row'));
      return { color: root.color, background: root.backgroundColor, rowBackground: row.backgroundColor };
    })()`);
    assert.notEqual(lightTheme.color, lightTheme.background);
    const lightShot = await screenshot(client, '02b-light-theme.png');
    await client.eval(`document.documentElement.setAttribute('data-theme', 'dark')`);
    await _waitMs(120);

    // Electron is a desktop shell, so validate its real narrow-window CSS path
    // instead of forcing mobile-browser viewport semantics onto index.html.
    await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await _waitMs(250);
    const mobile = await client.eval(`({
      viewport: document.documentElement.clientWidth,
      pageScrollWidth: document.documentElement.scrollWidth,
      rows: document.querySelectorAll('.cxl-row').length,
      sidebarDisplay: getComputedStyle(document.getElementById('session-sidebar')).display,
      leagueWidth: Math.round(document.querySelector('.cx-view-league').getBoundingClientRect().width),
      rankingClientHeight: document.querySelector('.cxl-ranking').clientHeight,
      rankingScrollHeight: document.querySelector('.cxl-ranking').scrollHeight
    })`);
    assert.equal(mobile.viewport, 390);
    assert.equal(mobile.pageScrollWidth, 390);
    assert.equal(mobile.rows, 10);
    assert.equal(mobile.sidebarDisplay, 'none');
    assert.equal(mobile.leagueWidth, 390);
    assert(mobile.rankingScrollHeight > mobile.rankingClientHeight);
    const mobileShot = await screenshot(client, '03-mobile-leaderboard.png');
    await client.eval(`document.querySelector('.cxl-row').click()`);
    await waitEval(client, `!document.querySelector('[data-role="detail-overlay"]').hidden`, 'mobile detail drawer');
    await client.eval(`document.querySelector('[data-action="edit-prompts"]').click()`);
    await waitEval(client, `!document.querySelector('[data-role="prompt-overlay"]').hidden && document.querySelector('[data-role="prompt-editor"]')`, 'mobile prompt workbench');
    await _waitMs(300);
    const mobilePrompt = await client.eval(`(() => {
      const node=document.querySelector('.cxl-prompt-workbench');
      return { pageWidth:document.documentElement.scrollWidth, width:Math.round(node.getBoundingClientRect().width), height:Math.round(node.getBoundingClientRect().height), editorVisible:document.querySelector('[data-role="prompt-editor"]').clientHeight>100 };
    })()`);
    const mobilePromptShot = await screenshot(client, '03b-mobile-prompt-workbench.png');
    assert.equal(mobilePrompt.pageWidth, 390);
    assert(mobilePrompt.width >= 340 && mobilePrompt.width <= 390, JSON.stringify(mobilePrompt));
    assert(mobilePrompt.height >= 620, JSON.stringify(mobilePrompt));
    assert.equal(mobilePrompt.editorVisible, true);
    await client.eval(`document.querySelector('[data-action="close-prompts"]').click(); document.querySelector('[data-action="close-detail"]').click()`);
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
    await _waitMs(250);

    await client.eval(`document.querySelector('[data-action="new-agent"]').click()`);
    await waitEval(client, '!document.querySelector("[data-role=create-overlay]").hidden && document.querySelector("[data-role=create-form] [name=model] option")', 'create Agent form');
    await client.eval(`(() => {
      const form = document.querySelector('[data-role="create-form"]');
      form.elements.name.value = '会话探针';
      form.elements.id.value = 'session-probe';
      form.elements.provider.value = 'codex-cli';
      form.elements.provider.dispatchEvent(new Event('change', { bubbles: true }));
      form.elements.model.value = 'gpt-5.6-sol';
      form.elements.philosophyKey.value = 'chuxin-value-speculation';
      form.elements.initialCash.value = '500000';
      form.requestSubmit();
    })()`);
    await waitEval(client, `document.querySelector('[data-agent-row="session-probe"]')`, 'created Agent leaderboard row');
    await client.eval(`document.querySelector('[data-agent-row="session-probe"]').click()`);
    await waitEval(client, `document.querySelector('.cxl-drawer .cxl-status.pending') && document.querySelector('.cxl-drawer').innerText.includes('待首次运行')`, 'pending native Session status');
    await client.eval(`document.querySelector('[data-action="close-detail"]').click()`);
    const sessionId = await client.eval(`(async()=> (await require('electron').ipcRenderer.invoke('get-sessions')).find(row => row.title === 'Agent · 会话探针')?.id || '')()`);
    assert(sessionId, 'created Agent session id is missing');
    await waitEval(client, `(async()=> (await require('electron').ipcRenderer.invoke('get-sessions')).some(row => row.id === ${JSON.stringify(sessionId)} && row.purpose === 'agent-league' && !row.hiddenFromSidebar))()`, 'visible ordinary Agent session');
    const opened = await client.eval(`window.__chuxinSessionBridge.open(${JSON.stringify(sessionId)}, 'card')`);
    assert.equal(opened.ok, true);
    await waitEval(client, 'getComputedStyle(document.getElementById("chuxin-panel")).display === "none" && getComputedStyle(document.getElementById("terminal-panel")).display !== "none"', 'ordinary Session surface');
    assert.equal(await client.eval(`document.getElementById('session-list').innerText.includes('Agent · 会话探针')`), true);
    const sessionShot = await screenshot(client, '04-ordinary-session.png');
    assert.deepEqual(await client.eval('window.__agentLeagueErrors'), []);

    console.log(JSON.stringify({
      ok: true,
      ranking,
      mobile,
      sessionId,
      lightTheme,
      mobilePrompt,
      screenshots: [leaderboardShot, detailShot, promptShot, lightShot, mobileShot, mobilePromptShot, sessionShot],
      output: OUTPUT,
    }, null, 2));
  } finally {
    if (client) await client.close();
    if (hub) await gracefulQuit(hub);
    removeTempRoot();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
