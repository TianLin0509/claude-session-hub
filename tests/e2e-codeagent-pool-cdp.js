'use strict';
// CodeAgent 号池端到端（真实隔离 Electron + 鼠标点击）：
//   1. 「AI特战队专用功能」弹窗里添加两个号池账号（隔离夹具代替真实登录窗口，写入假凭证）；
//   2. 启动中心选 CodeAgent → 「用量账号」出现 → 选号池建会话：假 CodeAgent 记下的配置目录是号池账号的目录，
//      第二个号池会话挑的是没有会话的那个号；选个人账号时仍是个人目录；
//   3. 号池账号目录部署了 Hub 的 hook、同步了个人账号的规则，模型保留号自己的；
//   4. 卡片上有「池」标记；1440 宽度截图。
// 不调用模型、不碰真实 CodeAgent、不碰生产 Hub。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-codeagent-pool-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const HOME_DIR = path.join(TEMP_ROOT, 'home');
const WORKSPACE_ROOT = path.join(TEMP_ROOT, 'workspaces');
const PERSONAL_DIR = path.join(TEMP_ROOT, 'personal-cac');
const FAKE_LOG = path.join(TEMP_ROOT, 'codeagent-fake.jsonl');
const SCAN_HOME = path.join(TEMP_ROOT, 'scan-home');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'codeagent-pool');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.unref(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(e => e ? reject(e) : resolve(port)); });
  });
}
async function waitFor(label, fn, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs; let last = null;
  while (Date.now() < deadline) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await _waitMs(150); }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}
async function click(client, selector) {
  const point = await waitFor(`visible ${selector}`, () => client.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null; el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`));
  for (const type of ['mousePressed', 'mouseReleased']) await client.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await _waitMs(250);
}
async function typeInto(client, selector, text) {
  await click(client, selector);
  await client.send('Input.insertText', { text });
}
async function choose(client, selector, value) {
  assert.equal(await client.eval(`(() => { const s = document.querySelector(${JSON.stringify(selector)});
    if (!s || ![...s.options].some(o => o.value === ${JSON.stringify(value)})) return false;
    s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`), true, `${selector}=${value}`);
  await _waitMs(400);
}
async function shot(client, name) {
  const r = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(path.join(ARTIFACT_DIR, name), Buffer.from(r.data, 'base64'));
}
const fakeLaunches = () => (fs.existsSync(FAKE_LOG) ? fs.readFileSync(FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const sessions = client => client.eval(`require('electron').ipcRenderer.invoke('get-sessions')`);

async function createCodeAgent(client, account, poolPick = null) {
  await click(client, '#btn-new');
  await click(client, '.new-session-option[data-kind="codeagent"]');
  await waitFor('account field', () => client.eval(`!document.getElementById('new-session-codeagent-account-field').hidden`));
  await choose(client, '#new-session-codeagent-account', account);
  if (poolPick) {
    await waitFor('manual pool picker', () => client.eval(`!document.getElementById('new-session-codeagent-pool-field').hidden`));
    await choose(client, '#new-session-codeagent-pool', poolPick);
  }
  const before = (await sessions(client)).map(s => s.id);
  const launchesBefore = fakeLaunches().length;
  await click(client, '#new-session-submit');
  const created = await waitFor('new CodeAgent session', async () => (await sessions(client)).find(s => s.kind === 'codeagent' && !before.includes(s.id)), 30000);
  const launch = await waitFor('fake CodeAgent launched', () => fakeLaunches().slice(launchesBefore).find(l => l.hubSession === created.id), 30000);
  return { created, launch };
}

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.mkdirSync(PERSONAL_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  fs.writeFileSync(path.join(PERSONAL_DIR, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX-Auto', permissions: { allow: ['Read'] } }));
  fs.writeFileSync(path.join(PERSONAL_DIR, 'AGENTS.md'), '# 个人账号的全局规则\n');
  fs.writeFileSync(path.join(PERSONAL_DIR, '.credentials.json'), JSON.stringify({ devUCOAuth: { accessToken: 'x', accountId: 'y00000002', expiresAt: Date.now() + 3600e3 } }));
  // 本机另一个已登录的目录（用户手动登过的 .cac-deepseek），用来测「导入本机已登录的号」
  fs.mkdirSync(path.join(SCAN_HOME, '.cac-deepseek'), { recursive: true });
  fs.writeFileSync(path.join(SCAN_HOME, '.cac-deepseek', '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'x', accountId: 'z00000003', expiresAt: Date.now() + 3600e3 } }));
  fs.writeFileSync(path.join(SCAN_HOME, '.cac-deepseek', 'settings.json'), JSON.stringify({ model: 'deepseek-v4-flash-0731' }));
  // 解锁「AI特战队专用功能」入口（等同于本机解锁过一次）
  const { AssistantStore } = require('../core/hub-assistant/store.js');
  const store = new AssistantStore(path.join(DATA_DIR, 'company-bridge'));
  store.set('featureUnlock', { at: Date.now(), via: 'test' });
  store.db.close?.();

  const port = await reservePort();
  const result = { checks: [], screenshots: [] };
  let hub;
  try {
    hub = await launchIsolatedHub({ dataDir: DATA_DIR, port, label: 'codeagent-pool', windowMode: 'background', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: WORKSPACE_ROOT, CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: HOME_DIR, DEEPSEEK_API_KEY: '',
      CLAUDE_HUB_BRIDGE_ROLE: 'company',
      AI_HUB_CODEAGENT_COMMAND: path.join(ROOT, 'tests', 'fixtures', 'codeagent-pool-fake', 'codeagent.cmd'),
      AI_HUB_CODEAGENT_CONFIG_DIR: PERSONAL_DIR,
      AI_HUB_CODEAGENT_POOL_LOGIN_FIXTURE: 'w00123',
      CODEAGENT_POOL_FAKE_LOG: FAKE_LOG,
      AI_HUB_CODEAGENT_POOL_SCAN_ROOT: SCAN_HOME,
    } });
    const client = await connectFirstPage(hub, t => t.type === 'page' && /renderer[\\/]index\.html/i.test(t.url || ''));
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await waitFor('renderer ready', () => client.eval(`document.readyState === 'complete' && !!window.WorkspaceController`));

    // 普通同事的样子：号池为空时启动中心不显示「用量账号」
    await click(client, '#btn-new');
    await click(client, '.new-session-option[data-kind="codeagent"]');
    await _waitMs(800);
    assert.equal(await client.eval(`document.getElementById('new-session-codeagent-account-field').hidden`), true);
    result.checks.push('empty pool hides the account selector');
    await click(client, '#new-session-close');

    // 特战队弹窗里添加两个号池账号
    await click(client, '#btn-options');
    await click(client, '#options-home-link');
    await click(client, '[data-hl="tab:pool"]');
    await waitFor('pool section', () => client.eval(`!!document.querySelector('[data-hl-sec="pool"] [data-hl="pool-add"]')`));
    for (const note of ['同事甲', '同事乙']) {
      await typeInto(client, '[data-hl-f="pool-note"]', note);
      await click(client, '[data-hl="pool-add"]');
      await waitFor(`pool account ${note} ready`, () => client.eval(`[...document.querySelectorAll('[data-hl-sec="pool"] tr[data-hl-account]')].some(i => i.textContent.includes(${JSON.stringify(note)}) && i.textContent.includes('可用'))`));
    }
    // 导入本机已登录的目录：不用重新登录
    await click(client, '[data-hl^="pool-import:"]');
    await waitFor('imported account ready', () => client.eval(`[...document.querySelectorAll('[data-hl-sec="pool"] tr[data-hl-account]')].some(i => i.textContent.includes('.cac-deepseek') && i.textContent.includes('可用') && i.textContent.includes('z000****03'))`));
    await waitFor('import button gone', () => client.eval(`!document.querySelector('[data-hl^="pool-import:"]') && document.querySelector('[data-hl-sec="pool"]').textContent.includes('已在号池里')`));
    await shot(client, '01-pool-dialog-1440.png'); result.screenshots.push('01-pool-dialog-1440.png');
    const listed = await client.eval(`require('electron').ipcRenderer.invoke('codeagent-pool:list')`);
    assert.equal(listed.usable, 3);
    assert.ok(listed.accounts.some(a => a.note === '.cac-deepseek' && a.models.includes('deepseek-v4-flash-0731')));
    result.checks.push('two pool accounts added through the dialog and one imported from a local logged-in dir');

    // v2.1.6：不点按钮——新登录、导入的号和个人账号自动获取模型权限（假 CodeAgent：z 开头的号只有 DeepSeek，其余只有 GLM）
    await waitFor('all models probed', () => client.eval(`(() => {
      const sec = document.querySelector('[data-hl-sec="pool"]');
      return sec && !sec.textContent.includes('获取中') && sec.querySelectorAll('tr[data-hl-account]').length === 4
        && [...sec.querySelectorAll('tr[data-hl-account]')].every(tr => !tr.textContent.includes('未获取'));
    })()`), 120000);
    const probedRows = await client.eval(`[...document.querySelectorAll('[data-hl-sec="pool"] tr[data-hl-account]')].map(tr => tr.textContent)`);
    assert.ok(probedRows[0].includes('个人账号') && probedRows[0].includes('GLM-5.2-WX-Auto') && !probedRows[0].includes('deepseek'), probedRows[0]);
    assert.ok(probedRows.some(t => t.includes('.cac-deepseek') && t.includes('deepseek-v4-flash-0731') && !t.includes('GLM')), JSON.stringify(probedRows));
    await shot(client, '00-accounts-tab-1440.png'); result.screenshots.push('00-accounts-tab-1440.png');
    const listedAfterProbe = await client.eval(`require('electron').ipcRenderer.invoke('codeagent-pool:list')`);
    const deepseekAccount = listedAfterProbe.accounts.find(a => a.note === '.cac-deepseek');
    assert.deepEqual(deepseekAccount.models, ['deepseek-v4-flash-0731']);
    result.checks.push('model permissions are fetched automatically for new, imported and never-probed accounts (personal GLM only, imported DeepSeek only)');
    // 手动「获取」仍可用：重新获取个人账号
    const probedBefore = await client.eval(`require('electron').ipcRenderer.invoke('codeagent-pool:list').then(s => s.personal.modelsProbedAt)`);
    await _waitMs(1100);
    await click(client, '[data-hl="pool-probe:personal"]');
    await waitFor('manual re-probe', async () => (await client.eval(`require('electron').ipcRenderer.invoke('codeagent-pool:list').then(s => s.personal.modelsProbedAt)`)) !== probedBefore, 60000);
    result.checks.push('manual per-row fetch still refreshes model permissions');
    await click(client, '[data-hl="close"]');

    // 号池会话 1、2：各挑一个号，第二个挑没有会话的那个
    const first = await createCodeAgent(client, 'pool');
    const poolDirs = listed.accounts.map(a => path.join(DATA_DIR, 'codeagent-pool', 'accounts', a.id));
    assert.ok(poolDirs.includes(path.resolve(first.launch.configDir)), `first pool session dir ${first.launch.configDir}`);
    assert.ok(first.created.codeagentPoolAccount, 'session remembers its pool account');
    const second = await createCodeAgent(client, 'pool');
    assert.notEqual(second.created.codeagentPoolAccount, first.created.codeagentPoolAccount, 'second session goes to the idle account');
    assert.ok(poolDirs.includes(path.resolve(second.launch.configDir)));
    assert.notEqual(path.resolve(second.launch.configDir), path.resolve(first.launch.configDir));
    result.checks.push('pool sessions launch in pool account dirs; second picks the idle account');

    // 号池目录：Hub hook 已部署、规则已同步、个人模型没有带过去
    const poolSettings = JSON.parse(fs.readFileSync(path.join(first.launch.configDir, 'settings.json'), 'utf8'));
    assert.ok(poolSettings.hooks && Object.keys(poolSettings.hooks).length, 'hub hooks deployed into the pool account dir');
    assert.notEqual(poolSettings.model, 'GLM-5.2-WX-Auto');
    assert.equal(fs.readFileSync(path.join(first.launch.configDir, 'AGENTS.md'), 'utf8'), '# 个人账号的全局规则\n');
    result.checks.push('pool dir has hub hooks and personal rules, not the personal model');

    // 个人账号会话仍用个人目录
    const personal = await createCodeAgent(client, 'personal');
    assert.equal(path.resolve(personal.launch.configDir), path.resolve(PERSONAL_DIR));
    assert.ok(!personal.created.codeagentPoolAccount);
    result.checks.push('personal account sessions keep the personal config dir');

    // 会话栏的账号字母（2026-10-20 起不再用「池」）：号池 w00123 夹具的两个号与个人号 y00000002 各显示工号首字母
    const letters = await waitFor('account letters on rows', () => client.eval(`(() => { const l = [...document.querySelectorAll('#session-list .sl-acct')].map(e => e.textContent); return l.length === 3 ? l.sort() : null; })()`));
    assert.equal(await client.eval(`document.querySelectorAll('#session-list .sl-pool').length`), 0);
    assert.deepEqual(letters.filter(x => x !== 'y').length, 2, JSON.stringify(letters));
    assert.ok(letters.includes('y'), 'personal account letter');
    result.checks.push('CodeAgent rows show the account initial (personal and pool alike), no pool tag');

    // 休眠后点卡片唤醒：回到同一个号的目录（会话记录在那里）。先等号池目录里的 hook 把原生会话 id 报给 Hub。
    await waitFor('pool hook bound native id', async () => (await sessions(client)).find(s => s.id === first.created.id)?.ccSessionId === first.launch.sessionId, 30000);
    result.checks.push('hook deployed in the pool account dir reports the native session to Hub');
    const suspended = await client.eval(`require('electron').ipcRenderer.invoke('suspend-session', ${JSON.stringify(first.created.id)})`);
    assert.equal(suspended && suspended.ok, true, `suspend: ${JSON.stringify(suspended)}`);
    // 休眠后主进程不再持有它，卡片留在侧栏、标为休眠
    await waitFor('first session dormant', async () => !(await sessions(client)).some(s => s.id === first.created.id)
      && await client.eval(`!!document.querySelector('#session-list .session-item[data-session-id="${first.created.id}"]')`));
    const launchesBeforeWake = fakeLaunches().length;
    await click(client, `#session-list .session-item[data-session-id="${first.created.id}"]`);
    const woke = await waitFor('woken pool session relaunched', () => fakeLaunches().slice(launchesBeforeWake).find(l => l.hubSession === first.created.id), 30000);
    assert.equal(path.resolve(woke.configDir), path.resolve(first.launch.configDir), 'wake keeps the same pool account dir');
    assert.equal(woke.resumed, true, 'wake resumes the original native session');
    assert.equal(woke.sessionId, first.launch.sessionId);
    const afterWake = (await sessions(client)).find(s => s.id === first.created.id);
    assert.equal(afterWake.codeagentPoolAccount, first.created.codeagentPoolAccount);
    result.checks.push('dormant pool session wakes in the same pool account dir');

    // 号池 · 手动选择：点名 DeepSeek 那个号，模型菜单只剩它的模型
    await click(client, '#btn-new');
    await click(client, '.new-session-option[data-kind="codeagent"]');
    await choose(client, '#new-session-codeagent-account', 'pool-manual');
    await waitFor('manual picker shown', () => client.eval(`!document.getElementById('new-session-codeagent-pool-field').hidden`));
    await choose(client, '#new-session-codeagent-pool', deepseekAccount.id);
    const manualModels = await waitFor('manual account models', () => client.eval(`(() => { const o = [...document.querySelectorAll('#new-session-model option')].map(x => x.value).filter(Boolean); return o.length === 1 && o[0] === 'deepseek-v4-flash-0731' ? o : null; })()`));
    assert.deepEqual(manualModels, ['deepseek-v4-flash-0731']);
    await shot(client, '02b-launch-center-manual-1440.png'); result.screenshots.push('02b-launch-center-manual-1440.png');
    await click(client, '#new-session-close');
    const manual = await createCodeAgent(client, 'pool-manual', deepseekAccount.id);
    assert.equal(manual.created.codeagentPoolAccount, deepseekAccount.id);
    assert.equal(path.resolve(manual.launch.configDir), path.resolve(path.join(DATA_DIR, 'codeagent-pool', 'accounts', deepseekAccount.id)));
    result.checks.push('manual pool pick launches on the chosen account and shows only its models');

    // 刷新会话数：表里每个号的进行中会话和主进程一致
    await click(client, '#btn-options');
    await click(client, '#options-home-link');
    await waitFor('pool tab remembered', () => client.eval(`!!document.querySelector('[data-hl="pool-refresh"]')`));
    await click(client, '[data-hl="pool-refresh"]');
    const counts = await waitFor('session counts', async () => {
      const live = await client.eval(`require('electron').ipcRenderer.invoke('codeagent-pool:list')`);
      const shown = await client.eval(`Object.fromEntries([...document.querySelectorAll('[data-hl-sec="pool"] tr[data-hl-account]')].map(tr => [tr.dataset.hlAccount, Number(tr.querySelector('.hl-num').textContent)]))`);
      const expected = Object.fromEntries([['personal', live.personal.activeSessions], ...live.accounts.map(a => [a.id, a.activeSessions])]);
      return JSON.stringify(shown) === JSON.stringify(expected) ? { shown, live } : null;
    });
    assert.equal(counts.live.personal.activeSessions, 1);
    assert.equal(counts.live.accounts.find(a => a.id === deepseekAccount.id).activeSessions >= 1, true);
    assert.equal(Object.values(counts.shown).reduce((a, b) => a + b, 0), 4, 'personal 1 + pool sessions 3 (first, second, manual)');
    await shot(client, '04-accounts-counts-1440.png'); result.screenshots.push('04-accounts-counts-1440.png');
    await click(client, '[data-hl="close"]');
    result.checks.push('refresh shows live session counts per account');

    // 再开启动中心看「用量账号」的样子并截图
    await click(client, '#btn-new');
    await click(client, '.new-session-option[data-kind="codeagent"]');
    await choose(client, '#new-session-codeagent-account', 'pool');
    await shot(client, '02-launch-center-pool-1440.png'); result.screenshots.push('02-launch-center-pool-1440.png');
    await click(client, '#new-session-close');
    await shot(client, '03-session-cards-1440.png'); result.screenshots.push('03-session-cards-1440.png');

    const errors = await client.eval(`(window.__hubRendererErrors || []).slice(0, 5)`).catch(() => []);
    result.rendererErrors = errors;
    result.ok = true;
  } finally {
    if (hub) await gracefulQuit(hub).catch(() => {});
    fs.writeFileSync(path.join(ARTIFACT_DIR, `result-${RUN_ID}.json`), JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
