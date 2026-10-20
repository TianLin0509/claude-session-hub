'use strict';
// 会话栏去杂端到端（2026-10-20 田哥）：真实隔离 Electron + 假 CodeAgent（tests/fixtures/codeagent-pool-fake）。
//   公司版：启动中心建个人号与两个号池号的 CodeAgent 会话 → 侧栏不再有「池」，统一显示账号首字母（l / w / f），悬停是代称；
//          通道回合状态（已答 / 没答上 / 处理中）不在侧栏，挪到会话头部（工具栏面包屑）的「⇄」标签。
//   家里版：问公司的会话「⇄ 2 轮」、替公司作答的「⇄ 公司」、群聊同样不在侧栏显示回合状态，会话头部有。
// 线程记录用 bridge:status 替身注入（不连真实公司、不启动 AI）；卡片视图里的通道卡用真实渲染器挂进会话卡片层。
// 用法：node tests/e2e-sidebar-clean-cdp.js [输出目录] [标签 before|after]（before 只记录现状、不断言新行为）
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'output', 'sidebar-clean'));
const TAG = process.argv[3] || 'after';
const STRICT = TAG !== 'before';
const MIN = 60000;
const j = JSON.stringify;

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
    const el = document.querySelector(${j(selector)});
    if (!el) return null; el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`));
  for (const type of ['mousePressed', 'mouseReleased']) await client.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await _waitMs(250);
}
async function choose(client, selector, value) {
  assert.equal(await client.eval(`(() => { const s = document.querySelector(${j(selector)});
    if (!s || ![...s.options].some(o => o.value === ${j(value)})) return false;
    s.value = ${j(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`), true, `${selector}=${value}`);
  await _waitMs(400);
}
const sessionsOf = client => client.eval(`require('electron').ipcRenderer.invoke('get-sessions')`);

async function createCodeAgent(client, account, poolPick = null) {
  await click(client, '#btn-new');
  // 装了 CodeAgent 时它的按钮会被挪到网格最前（workspace-controller.js），等版面稳定后再点，点完核对确实选中了它
  await _waitMs(600);
  for (let i = 0; i < 4; i += 1) {
    await click(client, '.new-session-option[data-kind="codeagent"]');
    if (await client.eval(`!!document.querySelector('.new-session-option[data-kind="codeagent"].selected')`)) break;
    await _waitMs(400);
  }
  assert.equal(await client.eval(`!!document.querySelector('.new-session-option[data-kind="codeagent"].selected')`), true, '启动中心选中 CodeAgent');
  // 家里版没有号池入口（「用量账号」不显示），个人账号直接建
  const shown = await waitFor('account field', () => client.eval(`!document.getElementById('new-session-codeagent-account-field').hidden`), account === 'personal' ? 3000 : 20000).catch(error => { if (account !== 'personal') throw error; return false; });
  if (shown) await choose(client, '#new-session-codeagent-account', account);
  if (poolPick) {
    await waitFor('manual pool picker', () => client.eval(`!document.getElementById('new-session-codeagent-pool-field').hidden`));
    await choose(client, '#new-session-codeagent-pool', poolPick);
  }
  const before = (await sessionsOf(client)).map(s => s.id);
  await click(client, '#new-session-submit');
  return waitFor('new CodeAgent session', async () => (await sessionsOf(client)).find(s => s.kind === 'codeagent' && !before.includes(s.id)), 60000);
}

// 隔离夹具：个人账号凭证 + 号池两个号（凭证里的工号首字母 l / w / f）。
function seedAccounts(root) {
  const personal = path.join(root, 'personal-cac');
  const data = path.join(root, 'hub-data');
  fs.mkdirSync(personal, { recursive: true });
  fs.writeFileSync(path.join(personal, 'settings.json'), j({ model: 'GLM-5.2-WX-Auto' }));
  fs.writeFileSync(path.join(personal, '.credentials.json'), j({ idaasOAuth: { xAuthToken: 'x', accountId: 'l00654321', expiresAt: Date.now() + 86400e3 } }));
  const accounts = [['abc123', 'w00612345', '王工'], ['def456', 'f00123456', '']];
  for (const [id, accountId] of accounts) {
    const dir = path.join(data, 'codeagent-pool', 'accounts', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.credentials.json'), j({ idaasOAuth: { xAuthToken: 'x', accountId, expiresAt: Date.now() + 86400e3 } }));
    fs.writeFileSync(path.join(dir, 'settings.json'), j({ model: 'GLM-5.2-WX-Auto' }));
  }
  fs.writeFileSync(path.join(data, 'codeagent-pool', 'pool.json'), j({ schema: 1, accounts: accounts.map(([id, , note]) => ({ id, note, createdAt: new Date().toISOString() })) }));
  return { personal, data };
}

// 侧栏现状：每行标题、状态点、时间/未读、号池「池」、账号字母、⇄ 标签；分区标题。
const SIDEBAR_FACTS = `(() => ({
  sections: [...document.querySelectorAll('#session-list .session-sec-header')].map(h => h.innerText.replace(/\\s+/g, ' ').trim()),
  items: [...document.querySelectorAll('#session-list .session-item')].map(e => ({
    id: e.dataset.sessionId || e.dataset.meetingId || e.dataset.sidebarRenderKey || '',
    title: (e.querySelector('.sl-title')?.innerText || '').trim(),
    dot: e.querySelector('.sl-kind')?.getAttribute('data-state') || e.querySelector('.sl-group-logos')?.getAttribute('data-state') || '',
    time: (e.querySelector('.sl-time')?.innerText || '').trim(),
    unread: !!e.querySelector('.sl-unread, .sl-time .unread, [class*="unread"]'),
    pool: !!e.querySelector('.sl-pool'),
    acct: e.querySelector('.sl-acct')?.textContent || '',
    acctTitle: e.querySelector('.sl-acct')?.getAttribute('title') || '',
    bridge: e.querySelector('.bt-badge')?.textContent || '',
    groupProgress: !!e.querySelector('.sl-group-progress'),
    cls: e.className,
  })),
}))()`;

async function runRole(role, result) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sidebar-clean-${role}-`));
  const { personal, data } = seedAccounts(root);
  const port = await reservePort();
  let hub, client;
  const facts = { role };
  const check = message => { result.checks.push(`[${role}] ${message}`); console.log(`✓ [${role}] ${message}`); };
  const shot = async (name, clip) => {
    await _waitMs(350);
    const r = await client.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { scale: 1, ...clip } } : {}) });
    const file = path.join(OUT, `20261020-sidebar-${TAG}-${role}-${name}-claude3.png`);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64')); result.screenshots.push(file);
  };
  try {
    hub = await launchIsolatedHub({ dataDir: data, port, label: `sidebar-clean-${role}`, windowMode: 'background', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces'), CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '',
      CLAUDE_HUB_BRIDGE_ROLE: role, CLAUDE_HUB_WIRELESS_TIMER: '0', HUB_ASSISTANT_FAST_LANE: '0',
      AI_HUB_CODEAGENT_COMMAND: path.join(ROOT, 'tests', 'fixtures', 'codeagent-pool-fake', 'codeagent.cmd'),
      AI_HUB_CODEAGENT_CONFIG_DIR: personal, CODEAGENT_POOL_FAKE_LOG: path.join(root, 'fake.jsonl'),
      AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan-home'),
    } });
    fs.mkdirSync(path.join(root, 'workspaces'), { recursive: true });
    client = await connectFirstPage(hub, t => t.type === 'page' && /renderer[\\/]index\.html/i.test(t.url || ''));
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await waitFor('renderer ready', () => client.eval(`document.readyState === 'complete' && !!window.WorkspaceController && !!window._bridgeThreads`));

    // 真实启动路径：启动中心选个人账号 / 号池手动选号建 CodeAgent 会话
    const mine = await createCodeAgent(client, 'personal');
    const poolW = role === 'company' ? await createCodeAgent(client, 'pool-manual', 'abc123') : null;
    const poolF = role === 'company' ? await createCodeAgent(client, 'pool-manual', 'def456') : null;
    if (poolW) assert.equal(poolW.codeagentPoolAccount, 'abc123');
    if (poolF) assert.equal(poolF.codeagentPoolAccount, 'def456');
    check(`启动中心建了 ${role === 'company' ? '个人号 + 号池 2 个号' : '1 个'} CodeAgent 会话`);

    const now = await client.eval('Date.now()');
    const T = now - 20 * MIN;
    const Q1 = '要 AirView HARQ 合并的关键文件地图', Q2 = '再核对 HARQ 合并后的 SINR 修正项';
    const A1 = '📌 关键文件 8 个，HARQ 合并在下行解调模块。\n\n把握程度：高', A2 = '📌 修正项在合并后叠加，步长 0.5 dB。\n\n把握程度：中';
    let state, titles, cardTurns, openId;
    if (role === 'company') {
      titles = { [mine.id]: '特战-HARQ 合并核对', [poolW.id]: '特战-功控复核', [poolF.id]: '特战-调度器摸底' };
      state = { ok: true, role: 'company', askHome: [], threads: [
        { id: 'Q-1020-01', sessionId: mine.id, title: 'HARQ 合并核对', state: 'replied', from: { title: 'SuperRAN · HARQ 对齐（Claude）', kind: 'claude' }, createdAt: T,
          rounds: [{ round: 1, question: Q1, receivedAt: T, sentAt: T + MIN, reply: A1, replyAt: T + 6 * MIN, meta: { model: 'GLM-5.2-WX-Auto' } },
            { round: 2, question: Q2, receivedAt: T + 10 * MIN, sentAt: T + 11 * MIN, reply: A2, replyAt: T + 16 * MIN, meta: { model: 'GLM-5.2-WX-Auto' } }] },
        { id: 'Q-1020-02', sessionId: poolW.id, title: '功控复核', state: 'open', from: { title: 'SuperRAN · 功控复核（Codex）', kind: 'codex' }, createdAt: T,
          rounds: [{ round: 1, question: '功控闭环的步长在哪', receivedAt: T, sentAt: T + MIN, error: '会话卡住，重发 1 次仍没有回答', errorAt: T + 9 * MIN }] },
        { id: 'Q-1020-03', sessionId: poolF.id, title: '调度器摸底', state: 'open', from: { title: 'SuperRAN · 调度器（Claude）', kind: 'claude' }, createdAt: T,
          rounds: [{ round: 1, question: '下行调度器的入口', receivedAt: now - 5 * MIN, sentAt: now - 4 * MIN }] },
      ] };
      openId = mine.id;
      cardTurns = [
        { id: 'c1', role: 'user', text: ['你是公司 CodeAgent，替家里查资料……', '', '## 成员请求（编号 Q-1020-01）', '', Q1].join('\n'), ts: T + MIN },
        { id: 'c2', role: 'assistant', kind: 'codeagent', model: 'GLM-5.2-WX-Auto', text: A1, ts: T + 6 * MIN },
        { id: 'c3', role: 'user', text: ['## 成员追问（编号 Q-1020-01，第 2 轮）', '', Q2, '', '（规则同前：保持公司电脑原样、不回传源码和凭据、末尾写把握程度和没读到的部分。）'].join('\n'), ts: T + 11 * MIN },
        { id: 'c4', role: 'assistant', kind: 'codeagent', model: 'GLM-5.2-WX-Auto', text: A2, ts: T + 16 * MIN },
      ];
    } else {
      titles = { [mine.id]: 'SuperRAN · HARQ 对齐' };
      const rec = (id, sessionId, round2) => ({ id, sessionId, title: 'HARQ 对齐', createdAt: T, state: 'open', gen: 'g1',
        rounds: [{ round: 1, question: Q1, sentAt: T, ackAt: T + 5000, startedAt: T + MIN, status: 'replied', reply: A1, replyAt: T + 6 * MIN, meta: { model: 'GLM-5.2-WX-Auto' } },
          { round: 2, question: Q2, sentAt: T + 10 * MIN, ...round2 }] });
      state = { ok: true, role: 'home', threads: [
        rec('Q-1020-11', mine.id, { ackAt: T + 10 * MIN + 6000, startedAt: T + 11 * MIN, status: 'replied', reply: A2, replyAt: T + 16 * MIN, meta: { model: 'GLM-5.2-WX-Auto' } }),
        rec('Q-1020-12', 'h-run', { ackAt: T + 10 * MIN + 6000, startedAt: now - 4 * MIN, status: 'running' }),
        rec('Q-1020-13', 'h-fail', { ackAt: T + 10 * MIN + 4000, status: 'error', error: '没写进 CodeAgent 记录 · 重发 1 次仍没有', errorAt: T + 15 * MIN }),
      ], consults: [{ id: 'Q-1020-14', sessionId: 'h-consult', title: '帮公司查 3GPP 条款', state: 'replied', from: { title: '公司会话 · 协议查询' }, createdAt: T,
        rounds: [{ round: 1, question: '38.214 里 CQI 表 2 的定义', receivedAt: T, sentAt: T + MIN, reply: '📌 在 5.2.2.1 节。', replyAt: T + 3 * MIN }] }] };
      openId = mine.id;
      const receipt = (round, reply) => [`【公司回执 Q-1020-11 · 第 ${round} 轮】`, '', reply, '', '——', '以上是公司 CodeAgent 的回执（不含源码）。'].join('\n');
      cardTurns = [
        { id: 'h1', role: 'user', text: '帮我把 AirView HARQ 合并的文件地图要过来', ts: T - MIN },
        { id: 'h2', role: 'user', text: receipt(1, A1), ts: T + 6 * MIN },
        { id: 'h3', role: 'assistant', kind: 'codeagent', text: '文件地图到了，按它整理 SuperRAN 的对应模块……', ts: T + 7 * MIN },
        { id: 'h4', role: 'user', text: receipt(2, A2), ts: T + 16 * MIN },
      ];
    }
    // 线程记录替身（仅此隔离 renderer 内）；家里另塞 3 个休眠的普通会话与 1 个群聊，覆盖未读 / 置顶 / 群聊进度条。
    await client.eval(`(() => {
      const ipc = require('electron').ipcRenderer, invoke = ipc.invoke.bind(ipc);
      window.__scState = ${j(state)};
      ipc.invoke = async (channel, payload) => channel === 'bridge:status' ? structuredClone(window.__scState) : invoke(channel, payload);
      for (const [id, title] of Object.entries(${j(titles)})) { const s = sessions.get(id); if (s) s.title = title; }
      if (${j(role)} === 'home') {
        const base = { kind: 'claude', status: 'dormant', suspended: true, lastMessageTime: Date.now() - 60000, createdAt: Date.now() - 3600000 };
        sessions.set('h-run', { ...base, id: 'h-run', title: 'SuperRAN · 调度器对齐', pinned: true });
        sessions.set('h-fail', { ...base, id: 'h-fail', kind: 'codex', title: 'SuperRAN · 功控复核', unreadCount: 2, hasCompletedUnread: true, replyReadyText: '功控复核结果' });
        sessions.set('h-consult', { ...base, id: 'h-consult', title: '帮公司查 3GPP 条款' });
        sessions.set('g-m1', { ...base, id: 'g-m1', title: 'Claude', meetingId: 'g1' });
        sessions.set('g-m2', { ...base, id: 'g-m2', kind: 'codex', title: 'Codex', meetingId: 'g1' });
        meetings['g1'] = { id: 'g1', title: '无线圆桌 · HARQ 方案', groupChat: true, subSessions: ['g-m1', 'g-m2'], participants: ['g-m1', 'g-m2'], status: 'idle',
          lastMessageTime: Date.now() - 30000, createdAt: Date.now() - 7200000, unreadAnswered: new Set(), answeredThisTurn: new Set(['g-m1']) };
      }
      ipc.emit('bridge:changed', {});
    })()`);
    await waitFor('records loaded', () => client.eval(`Object.keys(window._bridgeThreads.records()).length === ${state.threads.length + (state.consults || []).length}`));
    if (STRICT && role === 'company') await waitFor('account letters', () => client.eval(`document.querySelectorAll('#session-list .sl-acct').length >= 3`));
    await client.eval('renderSessionList()');
    await _waitMs(600);
    facts.sidebar = await client.eval(SIDEBAR_FACTS);
    await shot('01-window');
    await shot('02-sidebar', { x: 0, y: 0, width: 560, height: 640 });
    await shot('02b-sidebar-zoom', { x: 44, y: 190, width: 224, height: 150, scale: 2.5 });

    const item = id => facts.sidebar.items.find(i => i.id === id) || {};
    if (STRICT) {
      assert.equal(facts.sidebar.items.filter(i => i.pool).length, 0, '侧栏不再有「池」');
      assert.equal(facts.sidebar.items.filter(i => i.bridge).length, 0, '侧栏不再有回合状态标签：' + j(facts.sidebar.items.map(i => i.bridge)));
      if (role === 'company') {
        assert.equal(item(mine.id).acct, 'l'); assert.equal(item(poolW.id).acct, 'w'); assert.equal(item(poolF.id).acct, 'f');
        assert.match(item(mine.id).acctTitle, /个人/); assert.match(item(poolW.id).acctTitle, /号 \d/); assert.match(item(poolW.id).acctTitle, /王工/);
        for (const i of [mine, poolW, poolF]) assert.doesNotMatch(item(i.id).acctTitle, /\d{5,}/, '悬停不写工号全文');
        check('侧栏：没有「池」，个人号 l、号池号 w / f 统一显示首字母，悬停是代称（个人 / 号 N），不含工号全文');
      } else {
        assert.equal(item(mine.id).acct, 'l');
        check('侧栏：CodeAgent 会话同样显示账号首字母');
      }
      check('侧栏：通道会话不再显示「已答 / 没答上 / 2 轮 / 处理中 / 公司」等回合状态');
    }

    // 卡片视图：点开会话（真实点击），通道卡挂进会话卡片层
    await click(client, `#session-list .session-item[data-session-id="${openId}"]`);
    await waitFor('session active', () => client.eval(`activeSessionId === ${j(openId)}`));
    await _waitMs(1200);
    await client.eval(`(() => { for (const t of ${j(cardTurns)}) window._mountSessionTurnCard(${j(openId)}, t); })()`);
    await waitFor('bridge thread in card view', () => client.eval(`!!document.querySelector('#msg-overlay .bt-anchor .bridge-thread')`));
    await _waitMs(500);
    facts.header = await client.eval(`(() => ({ crumb: document.getElementById('toolbar-crumb')?.innerText || '',
      chip: document.querySelector('#toolbar-crumb .crumb-bridge')?.textContent || '', chipTitle: document.querySelector('#toolbar-crumb .crumb-bridge')?.getAttribute('title') || '',
      chipState: document.querySelector('#toolbar-crumb .crumb-bridge')?.dataset.state || '',
      thread: document.querySelector('#msg-overlay .bt-anchor .bt-head')?.innerText || '', banner: document.querySelector('#msg-overlay > .bt-banner')?.innerText || '' }))()`);
    await shot('03-card-view');
    if (STRICT) {
      if (role === 'company') {
        assert.match(facts.header.chip, /已答/); assert.match(facts.header.chipTitle, /Q-1020-01 · 第 2 轮已答/);
      } else {
        assert.match(facts.header.chip, /2 轮/); assert.match(facts.header.chipTitle, /Q-1020-11 · 第 2 轮已回执/);
      }
      assert.match(facts.header.thread, /2 轮/);
      check(`卡片视图：会话头部有「${facts.header.chip}」（悬停：${facts.header.chipTitle}），通道串块头仍有轮数与状态`);
      // 切到另一个有通道状态的会话：头部标签跟着换
      if (role === 'company') {
        await click(client, `#session-list .session-item[data-session-id="${poolW.id}"]`);
        await waitFor('pool session header chip', () => client.eval(`/没答上/.test(document.querySelector('#toolbar-crumb .crumb-bridge')?.textContent || '')`));
        check('切到号池号的会话：头部标签换成「没答上」');
        await shot('04-card-view-failed');
      }
    }
    facts.rendererErrors = await client.eval(`(window.__hubRendererErrors || []).slice(0, 5)`).catch(() => []);
  } catch (error) {
    if (client) {
      await shot('fail').catch(() => {});
      facts.failText = await client.eval(`[...document.querySelectorAll('.toast, [role=alert], .new-session-error, #new-session-error')].map(e => e.innerText).filter(Boolean).join(' | ')`).catch(() => '');
      console.error('[fail ui]', facts.failText);
    }
    throw error;
  } finally {
    try { client && await client.close(); } catch {}
    if (hub) await gracefulQuit(hub).catch(() => {});
  }
  return facts;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const result = { tag: TAG, scope: '真实隔离 Hub + 假 CodeAgent（启动中心真实建会话）；通道线程记录为 bridge:status 替身，通道卡由真实渲染器挂进卡片层', checks: [], screenshots: [], facts: {} };
  try {
    for (const role of ['company', 'home']) result.facts[role] = await runRole(role, result);
    result.passed = true;
  } catch (error) {
    result.error = error.stack || error.message;
    console.error(error);
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(OUT, `20261020-sidebar-${TAG}-result-claude3.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: !!result.passed, checks: result.checks.length, screenshots: result.screenshots.length }, null, 1));
  }
})();
