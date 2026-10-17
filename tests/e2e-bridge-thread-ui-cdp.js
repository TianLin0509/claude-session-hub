'use strict';
// 通道串界面回归（2026-10-16，B 通道串 + E 进度线）：真实隔离 Hub + 真实卡片渲染器与样式表。
// 卡片经 window._mountSessionTurnCard 挂进页面上的展示容器（与会话里同一套渲染、同一套 CSS），
// 线程记录用 bridge:status 替身注入；不连真实公司、不启动 AI。截图存 output/。
// 用法：node tests/e2e-bridge-thread-ui-cdp.js [输出目录]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const json = JSON.stringify;
const MIN = 60000;

const receipt = (id, round, reply) => [`【公司回执 ${id} · 第 ${round} 轮】`, '', reply, '', '——',
  '以上是公司 CodeAgent 的回执（不含源码）。请核对：可信就据此继续；把握程度低、没读到关键部分或与家里证据矛盾时，用 followup_company 追问（同一个公司会话，它记得上一轮读过的内容），次数不限。'].join('\n');
const failedReceipt = (id, round, error) => [`【公司回执 ${id} · 第 ${round} 轮 · 没答上】`, '', error, '', '——',
  '公司那边这一轮没有给出回答。可以用 followup_company 换个问法重问，或先按现有证据继续，并在汇报里写明待公司核实的点。'].join('\n');
const ANSWER1 = '📌 关键文件 12 个，入口在下行调度器，AMC 在链路自适应模块。\n\n| 模块 | 作用 |\n|---|---|\n| 下行调度器 | 每 TTI 选用户、分 RB |\n| 链路自适应 | CQI → MCS 映射与 OLLA |\n\n把握程度：高';
const ANSWER2 = '📌 10 条追问全部有代码证据：OLLA 在最终 MCS 选择前叠加，步长 0.01 dB，BLER 目标 10%。\n\n1. **OLLA 调整位置**：在链路自适应模块的 MCS 选择里，先按 CQI 映射，再叠加 OLLA 偏移。\n2. **步长与目标**：上调 0.01 dB / 下调 0.09 dB，对应 BLER 目标 10%。\n\n把握程度：高 · 没读到：HARQ 合并后的修正项';
const Q1 = '要 AirView 下行调度和 AMC 的关键文件地图';
const Q2 = '请再核对 10 处：OLLA 的叠加位置、步长、BLER 目标、初值……';

(async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-thread-ui-'));
  const out = path.resolve(process.argv[2] || 'output');
  fs.mkdirSync(out, { recursive: true });
  const result = { passed: false, scope: '真实隔离 Hub 的真实卡片渲染器与样式表；线程记录为状态替身，不是真实公司往返', checks: [], screenshots: [] };
  const check = message => { result.checks.push(message); console.log('✓ ' + message); };
  let hub, c;
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(testRoot, 'data'), port: await freePort(), label: 'bridge-thread-ui', windowMode: 'background',
      extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: path.join(testRoot, 'home'), CLAUDE_HUB_BRIDGE_ROLE: 'home',
        CLAUDE_HUB_WIRELESS_TIMER: '0', HUB_ASSISTANT_FAST_LANE: '0', DEEPSEEK_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', CODEX_API_KEY: '' } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const until = async (label, read, ms = 30000) => {
      for (const end = Date.now() + ms; Date.now() < end;) { if (await read().catch(() => false)) return; await wait(200); }
      throw new Error('timeout: ' + label);
    };
    await until('renderer ready', () => c.eval('typeof window._mountSessionTurnCard === "function" && !!window._bridgeThreads'));

    const now = await c.eval('Date.now()');
    const T = now - 3 * MIN; // 第 2 轮发出时刻
    const homeRec = (id, sessionId, round2) => ({ id, sessionId, title: 'AirView OLLA 核对', createdAt: T - 30 * MIN, state: 'open', gen: 'g1',
      rounds: [{ round: 1, question: Q1, sentAt: T - 30 * MIN, ackAt: T - 30 * MIN + 5000, startedAt: T - 29 * MIN, status: 'replied', reply: ANSWER1, replyAt: T - 15 * MIN, meta: { model: 'GLM-5.2-WX-Auto', elapsedSec: 840 } },
        { round: 2, question: Q2, sentAt: T, ...round2 }] });
    const state = { ok: true, role: 'home', threads: [
      homeRec('Q-1016-05', 'home-s1', { ackAt: T + 8000, startedAt: T + 68000, status: 'replied', reply: ANSWER2, replyAt: T + 12 * MIN, meta: { model: 'GLM-5.2-WX-Auto', elapsedSec: 660 } }),
      homeRec('Q-1016-11', 'st-queued', { ackAt: T + 6000, status: 'received', note: '排队第 1 个 · 受闲时上限 · 预计 6 分后开工' }),
      homeRec('Q-1016-12', 'st-running', { ackAt: T + 6000, startedAt: T + 2 * MIN - 60000 * 4, status: 'running' }),
      homeRec('Q-1016-13', 'st-done', { ackAt: T + 8000, startedAt: T + 68000, status: 'replied', reply: ANSWER2, replyAt: T + 12 * MIN, meta: { model: 'GLM-5.2-WX-Auto' } }),
      homeRec('Q-1016-14', 'st-failed', { ackAt: T + 4000, status: 'error', error: '没写进 CodeAgent 记录 · 重发 1 次仍没有。提问没能送进公司的 CodeAgent（重发一次后它的记录里仍没有这条提问）', errorAt: T + 9 * MIN }),
    ], consults: [] };
    // 线程记录替身仅存在于这个隔离 renderer 内；补收调用记下来核对。
    await c.eval(`(() => {
      const ipc = require('electron').ipcRenderer, invoke = ipc.invoke.bind(ipc);
      window.__btFixture = { state: ${json(state)}, calls: [] };
      ipc.invoke = async (channel, payload) => {
        const f = window.__btFixture;
        if (channel === 'bridge:status') return structuredClone(f.state);
        if (channel === 'bridge:recollect') { f.calls.push([channel, payload]); return { thread: payload.thread, round: 2, status: '已请公司补收' }; }
        return invoke(channel, payload);
      };
      ipc.emit('bridge:changed', {});
    })()`);
    await until('records loaded', () => c.eval('Object.keys(window._bridgeThreads.records()).length === 5'));
    check('bridge:status 线程记录载入（5 串）');

    // 展示容器：与会话卡片层同一个 class，铺满窗口。
    await c.eval(`(() => {
      const host = document.createElement('div'); host.id = 'bt-e2e';
      host.style.cssText = 'position:fixed;inset:0;z-index:100000;overflow:auto;background:#f8f8fa';
      document.body.appendChild(host);
      window.__btPanel = (id, title) => {
        host.innerHTML = '<div style="max-width:900px;margin:18px auto 0;font:600 15px Microsoft YaHei UI;color:#1c1c1e">' + title + '</div>'
          + '<div class="msg-overlay" id="' + id + '" style="position:relative;inset:auto;height:auto;display:block;background:transparent;overflow:visible"></div>'
          + '<div class="floating-input-bar" data-session-id="' + id + '" style="max-width:880px;margin:0 auto 24px"><div class="floating-input-box" contenteditable="true" style="min-height:40px;border:1px solid #e4e4ea;border-radius:10px;background:#fff;padding:8px 12px;font-size:13px"></div></div>';
        return host.querySelector('.msg-overlay');
      };
      window.__btMount = (sessionId, container, turns) => { for (const t of turns) window._mountSessionTurnCard(sessionId, t, { container }); };
    })()`);
    const shot = async (name, el = '#bt-e2e') => {
      await wait(300);
      const h = await c.eval(`Math.max(1000, Math.ceil(document.querySelector(${json(el)}).scrollHeight + 10))`);
      await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: Math.min(h, 4000), deviceScaleFactor: 1, mobile: false });
      await wait(250);
      const overflow = await c.eval(`(() => { const e = document.querySelector('#bt-e2e'); return e.scrollWidth > e.clientWidth + 1; })()`);
      assert.equal(overflow, false, name + ' 不应横向溢出');
      const image = await c.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(out, `20261016-通道串-${name}-claude1.png`);
      fs.writeFileSync(file, Buffer.from(image.data, 'base64')); result.screenshots.push(file);
      await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    };
    const q = expr => c.eval(expr);

    // ① 家里会话：第 1 轮回执在上午，第 2 轮刚回来
    const homeTurns = [
      { id: 'h1', role: 'user', text: '帮我把 AirView 下行调度和 AMC 的文件地图要过来', ts: T - 31 * MIN },
      { id: 'h2', role: 'user', text: receipt('Q-1016-05', 1, ANSWER1), ts: T - 15 * MIN },
      { id: 'h3', role: 'assistant', kind: 'claude', text: '文件地图到了，我先按它整理 SuperRAN 的对应模块……', ts: T - 14 * MIN },
      { id: 'h4', role: 'user', text: '再核对一下 OLLA 的实现细节', ts: T - MIN },
      { id: 'h5', role: 'user', text: receipt('Q-1016-05', 2, ANSWER2), ts: T + 12 * MIN },
      { id: 'h6', role: 'assistant', kind: 'claude', text: '回执可信，按它更新了 SuperRAN 的 OLLA 参数：上调 0.01 dB、下调 0.09 dB……', ts: T + 13 * MIN },
    ];
    await c.eval(`window.__btMount('home-s1', window.__btPanel('home-s1', '① 家里会话 · SuperRAN · AirView OLLA 核对（Claude）'), ${json(homeTurns)})`);
    await until('home aggregated', () => q(`document.querySelectorAll('#home-s1 .turn-card.bridge-msg.bt-merged-card').length === 1 && !!document.querySelector('#home-s1 .bt-anchor .bridge-thread.st-done')`));
    const home = await q(`(() => {
      const root = document.querySelector('#home-s1');
      const cards = [...root.children].map(e => e.classList.contains('bt-merged-card') ? 'line' : e.classList.contains('bt-anchor') ? 'thread' : e.classList.contains('user') ? 'user' : 'ai');
      const block = root.querySelector('.bt-anchor .bridge-thread');
      return { cards, open: block.open, head: block.querySelector('.bt-head').innerText, steps: block.querySelector('.bt-steps').innerText,
        headline: block.querySelector('.bt-headline').innerText, rows: [...block.querySelectorAll('.bt-round')].map(r => r.querySelector('.bt-name').textContent + '|' + r.className),
        line: root.querySelector('.bt-merged-card .bt-merged').innerText, lineVisible: root.querySelector('.bt-merged-card .bt-merged').getBoundingClientRect().height > 0,
        oldSlotHidden: root.querySelector('.bt-merged-card .bt-slot').getBoundingClientRect().height === 0,
        avatar: block.querySelector('.bt-round.party-company img')?.getAttribute('src') };
    })()`);
    assert.deepEqual(home.cards, ['user', 'line', 'ai', 'user', 'thread', 'ai']);
    assert.equal(home.open, false, '默认收起');
    assert.match(home.head, /Q-1016-05 · 公司 CodeAgent/); assert.match(home.head, /已回执/); assert.match(home.head, /2 轮/); assert.match(home.head, /全程 12 分/);
    assert.match(home.steps, /发出.*公司收到 \+8 秒.*排队 1 分.*处理 11 分.*回执/s);
    assert.match(home.headline, /^📌 10 条追问全部有代码证据/);
    assert.deepEqual(home.rows.map(r => r.split('|')[0]), ['家里问', '公司答', '家里问', '公司答']);
    assert.ok(home.rows[1].includes('party-company'));
    assert.match(home.line, /Q-1016-05 第 1 轮 · 已并入下方通道串/); assert.ok(home.lineVisible); assert.ok(home.oldSlotHidden);
    assert.match(home.avatar || '', /ai-avatars/);
    check('家里会话：两轮回执聚合成一块，块在最新位置，旧位置只留细线；默认收起，块头有对端、轮数、状态、全程与进度线，露 📌 结论');
    await shot('01-家里会话-收起');

    // 展开块与第 2 轮全文：markdown 渲染
    await q(`(() => { const b = document.querySelector('#home-s1 .bt-anchor .bridge-thread'); b.open = true; const rows = b.querySelectorAll('.bt-round'); rows[rows.length - 1].open = true; })()`);
    const full = await q(`(() => { const r = [...document.querySelectorAll('#home-s1 .bt-anchor .bt-round')].pop().querySelector('.bt-full'); return { strong: !!r.querySelector('strong'), ol: !!r.querySelector('ol'), text: r.innerText }; })()`);
    assert.ok(full.strong && full.ol, '全文按 markdown 渲染');
    check('点开一轮：全文按 markdown 渲染（加粗、编号列表）');
    await shot('02-家里会话-展开');

    // 再来一轮（补收的回执 / 新一轮）时块跟着走：模拟第 2 轮的同一回执重放不新增块
    await c.eval(`window.__btMount('home-s1', document.querySelector('#home-s1'), [{ id: 'h5', role: 'user', text: ${json(receipt('Q-1016-05', 2, ANSWER2))}, ts: ${T + 12 * MIN} }])`);
    await wait(150);
    assert.equal(await q(`document.querySelectorAll('#home-s1 .bridge-thread').length - document.querySelectorAll('#home-s1 .bt-merged-card .bridge-thread').length`), 1);
    assert.equal(await q(`document.querySelector('#home-s1 .bt-anchor .bridge-thread').open`), true, '刷新后展开状态保留');
    check('同一条回执再次挂载：不多出块，展开状态保留');

    // 追问：填进本会话输入框；补收：直接调 bridge:recollect
    await q(`document.querySelector('#home-s1 .bt-anchor [data-bridge-action="followup"]').click()`);
    await until('composer filled', () => q(`document.querySelector('.floating-input-bar[data-session-id="home-s1"] .floating-input-box').textContent.startsWith('用 followup_company 就编号 Q-1016-05 追问公司')`), 5000);
    await q(`document.querySelector('#home-s1 .bt-anchor [data-bridge-action="recollect"]').click()`);
    await until('recollect called', () => q(`window.__btFixture.calls.length === 1`), 5000);
    assert.deepEqual(await q('window.__btFixture.calls[0]'), ['bridge:recollect', { sessionId: 'home-s1', thread: 'Q-1016-05' }]);
    check('「追问」把命令开头填进本会话输入框；「补收」直接调 bridge:recollect（带会话与编号）');
    await until('toast gone', () => q(`![...document.querySelectorAll('body *')].some(e => e.childElementCount === 0 && /已请公司补收/.test(e.textContent) && e.getBoundingClientRect().height > 0)`), 15000).catch(() => {});

    // ② 公司会话：家里提问收进通道串，顶部为家里办事
    state.role = 'company';
    state.threads = [{ id: 'Q-1016-05', sessionId: 'co-s1', title: 'AirView 下行调度与 AMC', state: 'replied', from: { title: 'SuperRAN · AirView OLLA 核对（Claude）', kind: 'claude' }, createdAt: T - 31 * MIN,
      rounds: [{ round: 1, question: Q1, receivedAt: T - 30 * MIN, sentAt: T - 29 * MIN, reply: ANSWER1, replyAt: T - 15 * MIN, meta: { model: 'GLM-5.2-WX-Auto' } },
        { round: 2, question: Q2, receivedAt: T, sentAt: T + MIN, reply: ANSWER2, replyAt: T + 12 * MIN, meta: { model: 'GLM-5.2-WX-Auto' } }] }];
    state.askHome = []; delete state.consults;
    await c.eval(`(() => { window.__btFixture.state = ${json(state)}; require('electron').ipcRenderer.emit('bridge:changed', {}); })()`);
    await until('company records', () => q(`window._bridgeThreads.records()['Q-1016-05']?.bridgeRole === 'answerer'`));
    const coTurns = [
      { id: 'c1', role: 'user', text: ['你是公司 CodeAgent，替家里查资料……', '', '代码位置：', 'D:/code/airview', '', '## 成员请求（编号 Q-1016-05）', '', Q1].join('\n'), ts: T - 29 * MIN },
      { id: 'c2', role: 'assistant', kind: 'codeagent', model: 'GLM-5.2-WX-Auto', text: ANSWER1, ts: T - 15 * MIN },
      { id: 'c3', role: 'user', text: ['## 成员追问（编号 Q-1016-05，第 2 轮）', '', Q2, '', '（规则同前：保持公司电脑原样、不回传源码和凭据、末尾写把握程度和没读到的部分。）'].join('\n'), ts: T + MIN },
      { id: 'c4', role: 'assistant', kind: 'codeagent', model: 'GLM-5.2-WX-Auto', text: ANSWER2, ts: T + 12 * MIN },
    ];
    await c.eval(`window.__btMount('co-s1', window.__btPanel('co-s1', '② 公司 CodeAgent 会话 · AI特战队 · AirView 下行调度与 AMC'), ${json(coTurns)})`);
    await until('company aggregated', () => q(`!!document.querySelector('#co-s1 > .bt-banner') && !!document.querySelector('#co-s1 .bt-anchor .bridge-thread.role-answerer')`));
    const co = await q(`(() => {
      const root = document.querySelector('#co-s1'), block = root.querySelector('.bt-anchor .bridge-thread');
      return { banner: root.querySelector('.bt-banner').innerText, head: block.querySelector('.bt-head').innerText,
        rows: [...block.querySelectorAll('.bt-round')].map(r => r.querySelector('.bt-name').textContent + '|' + r.className),
        acts: block.querySelectorAll('[data-bridge-action]').length, answers: root.querySelectorAll(':scope > .turn-card.assistant').length,
        homeAvatar: block.querySelector('.bt-round.party-home img')?.getAttribute('src') || '' };
    })()`);
    assert.match(co.banner, /为家里办事：\s*SuperRAN · AirView OLLA 核对（Claude）/);
    assert.match(co.head, /为家里办事 · Q-1016-05 · 家里 Claude/);
    assert.deepEqual(co.rows.map(r => r.split('|')[0]), ['家里问', '公司答', '家里问', '公司答']);
    assert.ok(co.rows[0].includes('party-home'));
    assert.match(co.homeAvatar, /claude/);
    assert.equal(co.acts, 0);
    assert.equal(co.answers, 2, 'CodeAgent 自己的回答照常显示');
    check('公司会话：顶部「为家里办事：<家里会话标题>」，家里提问收进通道串、家里 Claude 署名暖色，CodeAgent 回答照常显示');
    await q(`document.querySelector('#co-s1 .bt-anchor .bridge-thread').open = true`);
    await shot('03-公司会话');

    // ④ 四种状态
    state.role = 'home'; state.threads = state.threads; // 先占位，下面换回家里的四串
    const homeState = { ok: true, role: 'home', threads: [
      homeRec('Q-1016-11', 'st-queued', { ackAt: T + 6000, status: 'received', note: '排队第 1 个 · 受闲时上限 · 预计 6 分后开工' }),
      homeRec('Q-1016-12', 'st-running', { ackAt: T + 6000, startedAt: T + 2 * MIN - 4 * MIN, status: 'running' }),
      homeRec('Q-1016-13', 'st-done', { ackAt: T + 8000, startedAt: T + 68000, status: 'replied', reply: ANSWER2, replyAt: T + 12 * MIN, meta: { model: 'GLM-5.2-WX-Auto' } }),
      homeRec('Q-1016-14', 'st-failed', { ackAt: T + 4000, status: 'error', error: '没写进 CodeAgent 记录 · 重发 1 次仍没有。提问没能送进公司的 CodeAgent（重发一次后它的记录里仍没有这条提问）', errorAt: T + 9 * MIN }),
      homeRec('Q-1016-05', 'home-s1', { ackAt: T + 8000, startedAt: T + 68000, status: 'replied', reply: ANSWER2, replyAt: T + 12 * MIN, meta: { model: 'GLM-5.2-WX-Auto' } }),
    ], consults: [] };
    await c.eval(`(() => { window.__btFixture.state = ${json(homeState)}; require('electron').ipcRenderer.emit('bridge:changed', {}); })()`);
    await until('home records again', () => q(`window._bridgeThreads.records()['Q-1016-11']?.bridgeRole === 'asker'`));
    await c.eval(`(() => {
      const host = document.querySelector('#bt-e2e');
      host.innerHTML = '<div style="max-width:900px;margin:18px auto 6px;font:600 15px Microsoft YaHei UI;color:#1c1c1e">④ 通道串的四种状态</div>';
      for (const [id, label] of [['st-queued','排队中'],['st-running','处理中'],['st-done','已回执'],['st-failed','没答上']]) {
        host.insertAdjacentHTML('beforeend', '<div style="max-width:880px;margin:14px auto 6px;font:13px Microsoft YaHei UI;color:#6c6c72">' + label + '</div><div class="msg-overlay" id="' + id + '" style="position:relative;inset:auto;height:auto;display:block;background:transparent;overflow:visible;padding:0 36px"></div>');
      }
    })()`);
    const stateCards = {
      'st-queued': ['Q-1016-11', [receipt('Q-1016-11', 1, ANSWER1)]],
      'st-running': ['Q-1016-12', [receipt('Q-1016-12', 1, ANSWER1)]],
      'st-done': ['Q-1016-13', [receipt('Q-1016-13', 1, ANSWER1), receipt('Q-1016-13', 2, ANSWER2)]],
      'st-failed': ['Q-1016-14', [receipt('Q-1016-14', 1, ANSWER1), failedReceipt('Q-1016-14', 2, '提问没能送进公司的 CodeAgent（重发一次后它的记录里仍没有这条提问）')]],
    };
    for (const [sid, [, texts]] of Object.entries(stateCards)) {
      const turns = texts.map((text, i) => ({ id: sid + '-' + i, role: 'user', text, ts: T + i * MIN }));
      await c.eval(`window.__btMount(${json(sid)}, document.querySelector('#${sid}'), ${json(turns)})`);
    }
    await until('four states', () => q(`['queued','running','done','failed'].every(s => document.querySelector('#st-' + s + ' .bt-anchor .bridge-thread.st-' + s))`));
    await q(`document.querySelectorAll('#bt-e2e .bt-anchor .bridge-thread').forEach(b => { b.open = true; })`);
    const four = await q(`(() => Object.fromEntries(['queued','running','done','failed'].map(s => { const b = document.querySelector('#st-' + s + ' .bt-anchor .bridge-thread');
      return [s, { state: b.querySelector('.bt-state').innerText, steps: b.querySelector('.bt-steps')?.innerText || '', wait: !!b.querySelector('.bt-wait'),
        fail: !!b.querySelector('.bt-round.fail'), reask: !!b.querySelector('[data-bridge-action="reask"]'), recollect: !!b.querySelector('[data-bridge-action="recollect"]') }]; })))()`);
    assert.equal(four.queued.state, '排队中'); assert.match(four.queued.steps, /排队第 1 个 · 受闲时上限/); assert.ok(four.queued.wait);
    assert.equal(four.running.state, '处理中'); assert.match(four.running.steps, /处理中 · 已 \d+ 分/); assert.ok(four.running.wait);
    assert.equal(four.done.state, '已回执'); assert.ok(!four.done.wait && !four.done.reask);
    assert.equal(four.failed.state, '没答上'); assert.ok(four.failed.fail && four.failed.reask && four.failed.recollect);
    assert.match(four.failed.steps, /没写进 CodeAgent 记录/);
    check('四种状态：排队中（排队说明 + 等待占位）、处理中（已用时）、已回执、没答上（标红 + 补收 + 重问）');
    await shot('04-四种状态');

    // ③ 列表标签：往侧栏塞 4 个休眠会话，按线程记录打标签
    await c.eval(`(() => { document.querySelector('#bt-e2e').remove();
      const base = { kind: 'claude', status: 'dormant', suspended: true, lastMessageTime: Date.now(), createdAt: Date.now() };
      for (const [id, title] of [['home-s1','SuperRAN · AirView OLLA 核对'],['st-running','SuperRAN · HARQ 对齐'],['st-queued','公司 CodeAgent 摸底'],['st-failed','SuperRAN · 功控复核']]) sessions.set(id, { ...base, id, title });
      renderSessionList();
    })()`);
    await until('sidebar badges', () => q(`document.querySelectorAll('#session-list .bt-badge').length >= 4`));
    const badges = await q(`[...document.querySelectorAll('#session-list .session-item')].filter(e => e.querySelector('.bt-badge')).map(e => e.querySelector('.sl-title').innerText + ' || ' + e.querySelector('.bt-badge').title)`);
    assert.ok(badges.some(b => /⇄ 2 轮/.test(b) && /Q-1016-05 · 第 2 轮已回执 · 12 分/.test(b)), badges.join('\n'));
    assert.ok(badges.some(b => /⇄ 处理中 · \d+ 分/.test(b)), badges.join('\n'));
    assert.ok(badges.some(b => /⇄ 排队中/.test(b) && /排队第 1 个/.test(b)), badges.join('\n'));
    check('会话列表：每行标题前「⇄」标签（轮数或当前状态与耗时），悬停看编号、当前那一步与全程');
    const image = await c.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 520, height: 520, scale: 1 } });
    const file = path.join(out, '20261016-通道串-05-会话列表-claude1.png');
    fs.writeFileSync(file, Buffer.from(image.data, 'base64')); result.screenshots.push(file);

    result.passed = true;
  } catch (error) {
    result.error = error.stack || error.message;
    console.error(error);
    process.exitCode = 1;
  } finally {
    try { c && await c.close(); } catch {}
    try { hub && await gracefulQuit(hub); } catch (error) { console.warn('quit:', error.message); }
    fs.writeFileSync(path.join(out, '20261016-通道串-e2e结果-claude1.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks.length, screenshots: result.screenshots }, null, 1));
  }
})();
