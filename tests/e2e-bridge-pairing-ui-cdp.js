'use strict';
// 配对号牌界面回归（2026-10-20）：真实隔离 Hub（家里角色）+ 真实渲染器与样式表；线程记录用 bridge:status 替身注入，不连真实公司、不启动 AI。
// 核对：① 家里会话头部「⇄」标签后面写「→ 公司 号 · 模型 · 会话 <公司会话号牌>」，同一会话多个在途编号全列出；
//       ② 联动面板每条线程写来自会话「名 #短码」和对接的公司号 / 模型 / 会话；
//       ③ 家里会话里的通道串：新格式回执首行（带题目）和 Codex 丢掉「·」的回执都并进同一块，块头带公司会话号牌；
//       ④ 公司会话：顶部「家里 <会话名 #短码> · <家里模型>」和「本会话由 <号> · <模型> 作答」。
// 用法：node tests/e2e-bridge-pairing-ui-cdp.js [截图目录]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { replyMessage } = require('../core/company-bridge/home');
const plate = require('../core/company-bridge/pairing-plate');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const j = JSON.stringify;
const MIN = 60000;
const A1 = '📌 遗忘因子取 1/64，每 TTI 更新一次。\n\n| 量 | 取值 |\n|---|---|\n| alpha | 1/64 |\n| 更新 | 每 TTI |\n\n把握程度：高';
const A2 = '📌 初值按宽带 CQI 估算，未调度的 TTI 按 0 衰减。\n\n把握程度：高 · 没读到：异常分支';

(async () => {
  const testRoot = fs.mkdtempSync(path.join(process.env.HUB_E2E_TMP || os.tmpdir(), 'bridge-pairing-ui-'));
  const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'output', 'bridge-pairing-ui'));
  fs.mkdirSync(out, { recursive: true });
  const result = { passed: false, scope: '真实隔离 Hub 的真实渲染器与样式表；线程记录为 bridge:status 替身，不是真实公司往返', checks: [], screenshots: [], facts: {} };
  const check = message => { result.checks.push(message); console.log('✓ ' + message); };
  let hub, c;
  try {
    // 会话用真实启动路径建（假 CodeAgent，tests/fixtures/codeagent-pool-fake），会话头部、卡片层都是真的。
    const personal = path.join(testRoot, 'personal-cac'), workspaces = path.join(testRoot, 'workspaces');
    fs.mkdirSync(personal, { recursive: true }); fs.mkdirSync(path.join(workspaces, 'pairing-demo'), { recursive: true });
    fs.writeFileSync(path.join(personal, 'settings.json'), j({ model: 'GLM-5.2-WX-Auto' }));
    fs.writeFileSync(path.join(personal, '.credentials.json'), j({ idaasOAuth: { xAuthToken: 'x', accountId: 'l00654321', expiresAt: Date.now() + 86400e3 } }));
    hub = await launchIsolatedHub({ dataDir: path.join(testRoot, 'data'), port: await freePort(), label: 'bridge-pairing-ui', windowMode: 'background',
      extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: path.join(testRoot, 'home'), CLAUDE_HUB_BRIDGE_ROLE: 'home', AI_HUB_WORKSPACE_ROOT: workspaces,
        AI_HUB_CODEAGENT_COMMAND: path.join(__dirname, 'fixtures', 'codeagent-pool-fake', 'codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: personal,
        CODEAGENT_POOL_FAKE_LOG: path.join(testRoot, 'fake.jsonl'), AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(testRoot, 'scan-home'),
        CLAUDE_HUB_WIRELESS_TIMER: '0', HUB_ASSISTANT_FAST_LANE: '0', DEEPSEEK_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', CODEX_API_KEY: '' } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const until = async (label, read, ms = 30000) => {
      for (const end = Date.now() + ms; Date.now() < end;) { const v = await read().catch(() => false); if (v) return v; await wait(200); }
      throw new Error('timeout: ' + label);
    };
    const q = expr => c.eval(expr);
    await until('renderer ready', () => q('typeof window._mountSessionTurnCard === "function" && !!window._bridgeThreads && typeof renderSessionList === "function"'));
    const shot = async (name, clip = null) => {
      await wait(400);
      const image = await c.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: clip.scale || 1 } } : {}) });
      const file = path.join(out, `20261020-配对号牌-${name}-claude3.png`);
      fs.writeFileSync(file, Buffer.from(image.data, 'base64')); result.screenshots.push(file);
      console.log('截图 ' + file);
    };

    const now = await q('Date.now()');
    const T = now - 20 * MIN;
    const mk = async title => (await q(`require('electron').ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd: path.join(workspaces, 'pairing-demo'), title } })})`)).id;
    const HOME_SID = await mk('无线调度遗忘因子核对'), OTHER_SID = await mk('周报整理（续）');
    const CODE = plate.shortCode(HOME_SID);
    const HOME_TITLE = '无线调度遗忘因子核对', HOME_MODEL = 'DeepSeek';
    const from = { title: HOME_TITLE, kind: 'deepseek-claude', code: plate.shortCode(HOME_SID), model: HOME_MODEL };
    const plateOf = id => plate.companySessionTitle({ id, from });
    // 公司会话：同一渲染器切到公司角色时用；会话名就按公司一端的规则起（真实 Hub 会话名）
    const CO_SID = await mk(plateOf('Q-1020-21'));
    assert.ok(HOME_SID && OTHER_SID && CO_SID, '建了 3 个会话');
    // 家里一端的线程记录：Q-1020-21 已两轮回执；Q-1020-22、Q-1020-23 同一会话在途；Q-1020-24 是另一个会话
    const homeThreads = [
      { id: 'Q-1020-21', sessionId: HOME_SID, sessionTitle: HOME_TITLE, code: from.code, title: 'PF 遗忘因子怎么取', plate: plateOf('Q-1020-21'), state: 'open', gen: 'g1', createdAt: T - 30 * MIN,
        company: { sessionTitle: plateOf('Q-1020-21'), accountAlias: '号 1', model: 'GLM-5.2-WX-Auto' }, session: { open: true, title: HOME_TITLE, code: from.code },
        rounds: [
          { round: 1, question: 'PF 遗忘因子怎么取？请读调度器实现', sentAt: T - 30 * MIN, ackAt: T - 30 * MIN + 5000, startedAt: T - 29 * MIN, status: 'replied', reply: A1, replyAt: T - 18 * MIN, meta: { model: 'GLM-5.2-WX-Auto', accountAlias: '号 1' }, delivered: true },
          { round: 2, question: '初值怎么给？', sentAt: T - 6 * MIN, ackAt: T - 6 * MIN + 4000, startedAt: T - 5 * MIN, status: 'replied', reply: A2, replyAt: T - MIN, meta: { model: 'GLM-5.2-WX-Auto', accountAlias: '号 1' }, delivered: true },
        ] },
      { id: 'Q-1020-22', sessionId: HOME_SID, sessionTitle: HOME_TITLE, code: from.code, title: 'HARQ 进程数', plate: plateOf('Q-1020-22'), state: 'open', gen: 'g1', createdAt: now - 4 * MIN,
        company: { sessionTitle: plateOf('Q-1020-22'), accountAlias: '号 2', model: 'deepseek-v4-0731' }, session: { open: true, title: HOME_TITLE, code: from.code },
        rounds: [{ round: 1, question: 'HARQ 进程数和最大重传次数？', sentAt: now - 4 * MIN, ackAt: now - 4 * MIN + 3000, startedAt: now - 3 * MIN, status: 'running' }] },
      { id: 'Q-1020-23', sessionId: HOME_SID, sessionTitle: HOME_TITLE, code: from.code, title: '功控步长', plate: plateOf('Q-1020-23'), state: 'open', gen: 'g1', createdAt: now - MIN,
        session: { open: true, title: HOME_TITLE, code: from.code },
        rounds: [{ round: 1, question: '上行功控闭环步长？', sentAt: now - MIN, ackAt: now - MIN + 3000, status: 'received', note: '排队第 1 个' }] },
      { id: 'Q-1020-24', sessionId: OTHER_SID, sessionTitle: '周报整理（续）', code: plate.shortCode(OTHER_SID), title: '最新周报', state: 'open', gen: 'g1', createdAt: T,
        plate: plate.companySessionTitle({ id: 'Q-1020-24', from: { title: '周报整理（续）', kind: 'codex', code: plate.shortCode(OTHER_SID), model: 'Codex' } }),
        transferredFrom: [{ sessionId: 'c09d-old', label: '周报整理 #c09d', at: T, why: '引用会话「周报整理」' }], session: { open: true, title: '周报整理（续）', code: plate.shortCode(OTHER_SID) },
        rounds: [{ round: 1, question: '最新周报是哪天？', sentAt: T, ackAt: T + 3000, startedAt: T + MIN, status: 'replied', reply: '📌 最新是 10-15。', replyAt: T + 5 * MIN, meta: { model: 'GLM-5.2-WX-Auto', accountAlias: '号 1' }, delivered: true }] },
    ];
    // 联动面板要完整的状态：先取隔离 Hub 的真实 bridge:status，再把配对状态和线程换成替身
    const real = await q(`require('electron').ipcRenderer.invoke('bridge:status')`);
    assert.equal(real.role, 'home', '隔离实例是家里角色');
    const homeState = { ...real, link: { ...(real.link || {}), state: 'paired', peerSeen: new Date(now - 20000).toISOString() }, peer: { companyOnline: true, companyLastSeen: '刚刚在线' }, threads: homeThreads, consults: [] };
    await q(`(() => {
      const ipc = require('electron').ipcRenderer, invoke = ipc.invoke.bind(ipc);
      window.__bpState = ${j(homeState)};
      ipc.invoke = async (channel, payload) => channel === 'bridge:status' ? structuredClone(window.__bpState) : invoke(channel, payload);
      for (const [id, title] of [[${j(HOME_SID)}, ${j(HOME_TITLE)}], [${j(OTHER_SID)}, '周报整理（续）']]) { const s = sessions.get(id); if (s) s.title = title; }
      ipc.emit('bridge:changed', {});
      renderSessionList();
    })()`);
    await until('records loaded', () => q(`Object.keys(window._bridgeThreads.records()).length === 4`));

    // ① 会话头部
    await q(`window.__hubOpenSession(${j(HOME_SID)})`);
    await until('session active', () => q(`activeSessionId === ${j(HOME_SID)}`));
    await wait(800);
    const turns = [
      { id: 'u1', role: 'user', text: 'PF 遗忘因子怎么取，问一下公司', ts: T - 31 * MIN },
      { id: 'r1', role: 'user', text: replyMessage(homeThreads[0], homeThreads[0].rounds[0]), ts: T - 18 * MIN },
      { id: 'a1', role: 'assistant', kind: 'deepseek-claude', text: '回执可信：遗忘因子 1/64。接着问初值。', ts: T - 17 * MIN },
      // 第 2 轮：Codex 按键粘贴会把「·」吞成空格，这里用这种写法核对仍能认出、并进同一块
      { id: 'r2', role: 'user', text: replyMessage(homeThreads[0], homeThreads[0].rounds[1]).replace(/^([^\n]*)/, line => line.replace(/ · /g, '  ')), ts: T - MIN },
    ];
    result.facts.receiptHeads = turns.filter(t => t.id.startsWith('r')).map(t => t.text.split('\n')[0]);
    await q(`(() => { for (const t of ${j(turns)}) window._mountSessionTurnCard(${j(HOME_SID)}, t); })()`);
    await until('peer in crumb', () => q(`!!document.querySelector('#toolbar-crumb .crumb-bridge-peer')`), 15000);
    await until('thread merged', () => q(`!!document.querySelector('#msg-overlay .bt-anchor .bridge-thread')`), 15000);
    const head = await q(`(() => { const chip = document.querySelector('#toolbar-crumb .crumb-bridge'), peer = document.querySelector('#toolbar-crumb .crumb-bridge-peer');
      return { chip: chip.textContent, chipTitle: chip.title, peer: peer.textContent, peerTitle: peer.title, peerWidth: peer.getBoundingClientRect().width, overflow: peer.scrollWidth > peer.clientWidth }; })()`);
    result.facts.head = head;
    assert.match(head.peer, /^→ 公司 2 个在途：Q22 号 2 · deepseek-v4-0731｜Q23 排队中$/, head.peer);
    assert.ok(head.peerTitle.includes(`Q-1020-22 → 公司 号 2 · deepseek-v4-0731 · 会话 Q22 · 家「无线调度遗忘因子核对 #${CODE}」· DeepSeek`), head.peerTitle);
    assert.ok(head.peerTitle.includes(`Q-1020-23 → 公司 会话 Q23 · 家「无线调度遗忘因子核对 #${CODE}」· DeepSeek`), head.peerTitle);
    assert.match(head.chipTitle, /Q-1020-2[23]/);
    check(`家里会话头部：⇄ 标签「${head.chip}」后面写「${head.peer}」，悬停逐条列出每个在途编号对接的公司号、模型和公司会话号牌`);
    await shot('01-家里会话头部-多个在途', { x: 0, y: 0, width: 1440, height: 120 });

    // ② 通道串（家里会话里）
    const block = await q(`(() => { const root = document.querySelector('#msg-overlay'), b = root.querySelector('.bt-anchor .bridge-thread'); b.open = true;
      return { blocks: root.querySelectorAll('.bt-anchor .bridge-thread').length, merged: root.querySelectorAll('.bt-merged-card').length, head: b.querySelector('.bt-head').innerText,
        chips: [...b.querySelectorAll('.bt-chip')].map(x => x.textContent), rounds: b.querySelectorAll('.bt-round').length }; })()`);
    result.facts.block = block;
    assert.equal(block.blocks, 1, '新格式回执和丢点的回执并进同一块');
    assert.equal(block.merged, 1, '第 1 轮的位置只留一条细线');
    assert.match(block.head, /Q-1020-21/);
    assert.ok(block.chips.some(x => x === '会话 ' + plateOf('Q-1020-21')), '块头带公司会话号牌：' + j(block.chips));
    assert.match(block.head, /Q-1020-21 · 公司 CodeAgent · 号 1/, '块头带公司号（以前取不到，永远是空的）');
    check(`家里通道串：首行「${result.facts.receiptHeads[0]}」和 Codex 丢点的「${result.facts.receiptHeads[1]}」并进同一块；块头写「会话 ${plateOf('Q-1020-21')}」`);
    await shot('02-家里通道串-块头号牌');

    // ③ 联动面板
    await q(`document.getElementById('btn-wireless')?.click()`);
    await until('link panel', () => q(`document.querySelectorAll('.cl-pair').length >= 3`), 20000);
    await q(`(() => { const d = document.querySelector('.cl-section details'); if (d) d.open = true; document.querySelector('.cl-section .cl-pair')?.closest('.wp-item, li, details, div')?.scrollIntoView({ block: 'start' }); })()`);
    await wait(600);
    const panel = await q(`[...document.querySelectorAll('.cl-section .cl-pair')].map(e => e.closest('li,div.wp-item,div')?.innerText || e.innerText)`);
    const pairs = await q(`[...document.querySelectorAll('.cl-section .cl-pair')].map(e => e.innerText)`);
    const metas = await q(`[...document.querySelectorAll('.cl-section .wp-meta:not(.cl-pair)')].map(e => e.innerText)`);
    result.facts.panel = { pairs, metas };
    assert.ok(pairs.includes('→ 公司 号 1 · GLM-5.2-WX-Auto · 会话 ' + plateOf('Q-1020-21')), j(pairs));
    assert.ok(pairs.some(x => x === '→ 公司 会话 ' + plateOf('Q-1020-23')), '公司还没回传：用家里推算的号牌 ' + j(pairs));
    assert.ok(metas.some(x => x.includes(`来自会话「无线调度遗忘因子核对 #${CODE}」`)), j(metas));
    assert.ok(metas.some(x => /从「周报整理 #c09d」转来/.test(x)), '交接过的编号写明从哪转来 ' + j(metas));
    check('联动面板：每条线程写「来自会话「名 #短码」」和「→ 公司 号 · 模型 · 会话 号牌」；交接过的写「从「旧会话 #短码」转来」');
    void panel;
    await shot('03-家里联动面板');

    // ④ 公司会话（同一渲染器切到公司角色）
    const coState = { ok: true, role: 'company', askHome: [], threads: [
      { id: 'Q-1020-21', sessionId: CO_SID, title: 'PF 遗忘因子怎么取', state: 'replied', from, createdAt: T - 30 * MIN, pairing: { sessionTitle: plateOf('Q-1020-21'), accountAlias: '号 1', model: 'GLM-5.2-WX-Auto' },
        rounds: [{ round: 1, question: 'PF 遗忘因子怎么取？请读调度器实现', receivedAt: T - 30 * MIN, sentAt: T - 29 * MIN, reply: A1, replyAt: T - 18 * MIN, meta: { model: 'GLM-5.2-WX-Auto', accountAlias: '号 1' } }] },
    ] };
    await q(`(() => { document.getElementById('btn-wireless') && null; window.__bpState = ${j(coState)};
      require('electron').ipcRenderer.emit('bridge:changed', {}); renderSessionList(); })()`);
    await until('company records', () => q(`window._bridgeThreads.records()['Q-1020-21']?.bridgeRole === 'answerer'`));
    await q(`window.__hubOpenSession(${j(CO_SID)})`);
    await until('company session active', () => q(`activeSessionId === ${j(CO_SID)}`));
    await wait(800);
    const coTurns = [
      { id: 'c1', role: 'user', text: ['你是公司 CodeAgent，替家里查资料……', '', '## 家里的问题（编号 Q-1020-21）', '', 'PF 遗忘因子怎么取？请读调度器实现'].join('\n'), ts: T - 29 * MIN },
      { id: 'c2', role: 'assistant', kind: 'codeagent', model: 'GLM-5.2-WX-Auto', text: A1, ts: T - 18 * MIN },
    ];
    await q(`(() => { for (const t of ${j(coTurns)}) window._mountSessionTurnCard(${j(CO_SID)}, t); })()`);
    await until('company banner', () => q(`!!document.querySelector('#msg-overlay > .bt-banner')`), 15000);
    const co = await q(`(() => { const b = document.querySelector('#msg-overlay > .bt-banner'), blk = document.querySelector('#msg-overlay .bt-anchor .bridge-thread');
      return { banner: b.innerText, by: b.querySelector('.bt-banner-by')?.innerText || '', chips: blk ? [...blk.querySelectorAll('.bt-chip')].map(x => x.textContent) : [],
        crumbPeer: document.querySelector('#toolbar-crumb .crumb-bridge-peer')?.textContent || '', title: sessions.get(${j(CO_SID)}).title }; })()`);
    result.facts.company = co;
    assert.ok(co.banner.includes(`家里 无线调度遗忘因子核对 #${CODE} · DeepSeek`), co.banner);
    assert.equal(co.by, '本会话由 号 1 · GLM-5.2-WX-Auto 作答');
    assert.equal(co.crumbPeer, `家里 无线调度遗忘因子核对 #${CODE} · DeepSeek · 本会话由 号 1 · GLM-5.2-WX-Auto 作答`);
    assert.equal(co.title, `Q21 · 家「无线调度遗忘因子核对 #${CODE}」· DeepSeek`);
    check(`公司会话：会话名「${co.title}」；顶部写「家里 无线调度遗忘因子核对 #${CODE} · DeepSeek」和「${co.by}」，头部 ⇄ 后面同样写出`);
    await shot('04-公司会话-顶部');

    // ⑤ 公司「AI特战队专用功能」任务记录：隔离实例是家里角色，入口没启用；按公司角色（已解锁、已配对）重新跑一遍 home-link.js 再打开
    const dialogState = { ...coState, unlocked: true, link: { state: 'paired', pairedAt: T - 3 * 24 * 60 * MIN, outbox: 0 }, net: { lastOkAt: new Date(now - 5000).toISOString(), peerSeen: new Date(now - 20000).toISOString() },
      settings: { enabled: true, pollSeconds: 30, codeRoots: ['D:/code/l2'], instructions: '你是公司 CodeAgent……', effort: 'low', usePool: true }, defaultInstructions: '', images: null, consults: [],
      threads: coState.threads.map(t => ({ ...t, session: { open: true, busy: false } })) };
    await q(`(() => { window.__bpState = ${j(dialogState)}; (0, eval)(require('fs').readFileSync(${j(path.join(__dirname, '..', 'renderer', 'home-link.js'))}, 'utf8')); })()`);
    await until('company dialog entry', () => q(`typeof window.__homeLinkOpen === 'function'`), 15000);
    await q(`window.__homeLinkOpen()`);
    await until('company task list', () => q(`!!document.querySelector('#home-link-dialog .hl-item')`), 15000);
    const listMeta = await q(`[...document.querySelectorAll('#home-link-dialog .hl-item .hl-muted')].map(e => e.innerText)`);
    result.facts.companyList = listMeta;
    assert.ok(listMeta.some(x => x.includes(`家里 无线调度遗忘因子核对 #${CODE} · DeepSeek`) && x.includes('本会话由 号 1 · GLM-5.2-WX-Auto 作答')), j(listMeta));
    await q(`document.querySelector('#home-link-dialog .hl-item')?.scrollIntoView({ block: 'center' })`);
    await wait(500);
    check('公司「AI特战队专用功能」任务记录：每条写「家里 会话名 #短码 · 家里模型」和「本会话由 号 · 模型 作答」');
    await shot('05-公司特战功能-任务记录');
    result.passed = true;
  } catch (error) {
    result.error = error.stack || error.message;
    console.error(error);
    process.exitCode = 1;
    try { if (c) { const image = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, '20261020-配对号牌-失败现场-claude3.png'), Buffer.from(image.data, 'base64')); } } catch {}
  } finally {
    try { c && await c.close(); } catch {}
    try { hub && await gracefulQuit(hub); } catch (error) { console.warn('quit:', error.message); }
    fs.writeFileSync(path.join(out, '20261020-配对号牌-e2e结果-claude3.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks.length, screenshots: result.screenshots }, null, 1));
    try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch {}
  }
})();
