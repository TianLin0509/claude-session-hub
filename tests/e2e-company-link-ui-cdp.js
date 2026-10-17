'use strict';
// 公司专用功能的界面回归：真实隔离 Hub + CDP 点击，配对后用状态夹具覆盖活跃/空闲/断连。
// 不连接真实公司通道、不启动 AI；完整往返另见 e2e-company-bridge-real.js。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { unlockPhrase, typeKeys, typeUnlock } = require('./helpers/company-unlock');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const json = JSON.stringify;

(async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'company-link-ui-'));
  const out = path.resolve('artifacts/20261015-company-link-ui-codex1', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(out, { recursive: true });
  const result = { passed: false, scope: '真实隔离 Hub 界面；未配对为真实状态，其余为状态夹具，不代表真实公司端往返', checks: [], screenshots: [], out };
  let hub, c;
  const check = message => { result.checks.push(message); console.log('✓ ' + message); };
  const launch = async () => {
    hub = await launchIsolatedHub({ dataDir: path.join(testRoot, 'data'), port: await freePort(), label: 'company-link-ui', windowMode: 'background',
      ...(process.env.COMPANY_ENTRY ? { entryPath: process.env.COMPANY_ENTRY } : {}),
      extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: path.join(testRoot, 'home'), CLAUDE_HUB_BRIDGE_ROLE: 'company',
        CLAUDE_HUB_WIRELESS_TIMER: '0', HUB_ASSISTANT_FAST_LANE: '0', DEEPSEEK_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', CODEX_API_KEY: '' } });
    c = await connectFirstPage(hub);
  };
  try {
    const phrase = unlockPhrase();
    await launch();
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const until = async (label, read) => {
      for (const end = Date.now() + 30000; Date.now() < end;) { if (await read()) return; await wait(200); }
      throw new Error('timeout: ' + label);
    };
    const click = async selector => {
      // 设置页变长后「保存」可能在视野外：像人一样先滚过去再点（2026-10-17 加了并行档位一栏）。
      await c.eval(`document.querySelector(${json(selector)})?.scrollIntoView({ block: 'center' })`);
      await until('clickable ' + selector, () => c.eval(`(() => { const e = document.querySelector(${json(selector)}); if (!e || e.disabled) return false; const r = e.getBoundingClientRect(), h = document.elementFromPoint(r.x+r.width/2, r.y+r.height/2); return r.width > 0 && (h === e || e.contains(h)); })()`));
      const p = await c.eval(`(() => { const r = document.querySelector(${json(selector)}).getBoundingClientRect(); return { x: r.x+r.width/2, y: r.y+r.height/2 }; })()`);
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    };
    const shot0 = async name => {
      const image = await c.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(out, name + '.png'); fs.writeFileSync(file, Buffer.from(image.data, 'base64')); result.screenshots.push(file);
    };
    const shot = async name => {
      const overflow = await c.eval('(() => { const e = document.querySelector("#home-link-dialog"); return e.scrollWidth > e.clientWidth + 1; })()');
      assert.equal(overflow, false, name + ' 不应横向溢出');
      const image = await c.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(out, name + '.png'); fs.writeFileSync(file, Buffer.from(image.data, 'base64')); result.screenshots.push(file);
    };
    // ---- 隐藏入口：没解锁时菜单里没有这一项，主进程接口也不应答 ----
    const menuOpen = () => c.eval('(() => { const m = document.getElementById("options-menu"); return !!m && m.style.display !== "none" && m.getClientRects().length > 0; })()');
    const hasEntry = () => c.eval('!!document.getElementById("options-home-link")');
    await until('company renderer', () => c.eval('require("electron").ipcRenderer.invoke("bridge:status").then(s => s && s.role === "company")'));
    assert.deepEqual(await c.eval('require("electron").ipcRenderer.invoke("bridge:status")'), { ok: true, role: 'company', unlocked: false });
    assert.equal((await c.eval('require("electron").ipcRenderer.invoke("bridge:set-settings", { autoGate: true })')).error, '功能未启用');
    await click('#btn-options');
    await until('options menu open', menuOpen);
    assert.equal(await hasEntry(), false);
    await shot0('00-locked-menu');
    check('没解锁：设置菜单里没有「AI特战队专用功能」，主进程接口只回答未解锁');
    // 焦点在输入框里时敲口令：是在打字，不算解锁。
    // 优先用页面上真实可见的输入框；首页没有会话时没有，就放一个临时输入框（不在菜单里），检查的是「焦点在输入框」这条规则本身。
    const field = await c.eval(`(() => {
      for (const e of document.querySelectorAll("textarea, input:not([type]), input[type=text], input[type=search]")) {
        if (e.closest("#options-menu") || e.disabled || !e.getClientRects().length) continue;
        e.focus(); if (document.activeElement !== e) continue;
        e.setAttribute("data-unlock-probe", "1"); return e.id || e.className || e.tagName;
      }
      const e = document.createElement("input"); e.type = "text"; e.style.cssText = "position:fixed;left:400px;top:20px;z-index:1"; e.setAttribute("data-unlock-probe", "temp");
      document.body.append(e); e.focus(); return document.activeElement === e ? "临时输入框" : null;
    })()`);
    assert.ok(field, '页面上应有可聚焦的输入框'); result.probeField = field;
    assert.equal(await menuOpen(), true);
    await typeKeys(c, phrase); await wait(500);
    assert.equal(await hasEntry(), false, '在输入框里打字不应解锁');
    await c.eval('(() => { const e = document.querySelector("[data-unlock-probe]"); if (e && "value" in e) { e.value = ""; e.dispatchEvent(new Event("input", { bubbles: true })); } const temp = e?.getAttribute("data-unlock-probe") === "temp"; e?.removeAttribute("data-unlock-probe"); e?.blur(); if (temp) e.remove(); })()');
    check('焦点在输入框里敲口令不解锁');
    // 敲错（字母顺序反了）不解锁。
    if (!(await menuOpen())) await click('#btn-options');
    await typeKeys(c, [...phrase].reverse().join('')); await wait(500);
    assert.equal(await hasEntry(), false, '敲错不应解锁');
    // 菜单关着时敲对也不算。
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await until('menu closed', async () => !(await menuOpen()));
    await typeKeys(c, phrase); await wait(500);
    assert.equal(await hasEntry(), false, '菜单关着时不应解锁');
    check('敲错不解锁；菜单关着时敲对也不解锁');
    // 菜单开着、焦点不在输入框：敲对立即出现，不弹提示。
    await click('#btn-options');
    await until('options menu open', menuOpen);
    const toastsBefore = await c.eval('document.body.innerText.includes("解锁")');
    await typeUnlock(c, { phrase });
    assert.equal(await c.eval('document.getElementById("options-home-link").textContent'), 'AI特战队专用功能');
    assert.equal(await menuOpen(), true, '解锁后菜单保持打开');
    assert.equal(await c.eval('document.body.innerText.includes("解锁")'), toastsBefore, '解锁不应有任何提示');
    assert.equal((await c.eval('require("electron").ipcRenderer.invoke("bridge:status")')).unlocked, true);
    await shot0('00-unlocked-menu');
    check('菜单开着时敲对口令：入口立即出现在菜单里，没有任何提示');
    await click('#options-home-link');
    await until('unpaired dialog', () => c.eval('!!document.querySelector("#home-link-dialog[open] [data-hl-f=code]")'));
    const unpaired = await c.eval('document.getElementById("home-link-dialog").innerText');
    assert.match(unpaired, /AI特战队专用功能/); assert.match(unpaired, /授权成员/);
    assert.doesNotMatch(unpaired, /家里|公司代码|内网|回传/);
    assert.equal(await c.eval('!!document.querySelector("[data-hl-sec=settings]")'), false);
    await shot('01-unpaired'); check('未配对入口只展示授权成员配对说明，不展示设置或任务内容');

    // IPC 替身仅存在于这个独立 renderer 内，退出后自然消失。
    await c.eval(`(() => {
      const ipc = require('electron').ipcRenderer, invoke = ipc.invoke.bind(ipc);
      window.__companyUiFixture = { state: null, saved: [] };
      ipc.invoke = async (channel, payload) => {
        const f = window.__companyUiFixture;
        if (f.state && (channel === 'bridge:status' || channel === 'bridge:check-now')) return structuredClone(f.state);
        if (f.state && channel === 'bridge:set-settings') {
          f.saved.push(structuredClone(payload));
          f.state.settings = { ...f.state.settings, ...payload, codeRoots: String(payload.codeRoots).split(/\\r?\\n/).filter(Boolean) };
          return structuredClone(f.state);
        }
        return invoke(channel, payload);
      };
    })()`);
    const now = Date.now();
    const fixture = { ok: true, role: 'company', settings: { enabled: true, codeRoots: ['D:\\code\\example'], effort: 'high', maxParallel: 3, maxParallelIdle: 6, perAccountPeak: 3, perAccountIdle: 6, memFloorPct: 10, busyHours: '08:30-12:00,13:30-17:30', usePool: true, pollSeconds: 45, instructions: '根据授权范围查询资料，完成后汇报结果。' },
      parallel: { cap: 6, peak: false, limitedBy: '闲时上限', working: 1 },
      defaultInstructions: '根据授权范围查询资料，完成后汇报结果。',
      link: { state: 'paired', pairedAt: now, outbox: 0 }, net: { lastOkAt: new Date(now).toISOString(), peerSeen: new Date(now).toISOString() },
      polling: { active: true, intervalSeconds: 10, activeUntil: now + 600000 }, now, nextPullAt: now + 10000,
      threads: [{ id: 'Q-UI-01', title: '界面回归样例', createdAt: now, state: 'replied', from: { title: '样例会话' },
        rounds: [{ round: 1, question: '检查任务记录是否完整。', reply: '记录完整，后续追问会保留在同一任务中。', replyAt: now }] }] };
    const show = async state => {
      await c.eval(`(() => { window.__companyUiFixture.state = ${json(state)}; require('electron').ipcRenderer.emit('bridge:changed', {}); })()`);
      await until('state rendered', () => c.eval(`document.querySelector('.hl-state')?.textContent === ${json(state.link.state === 'paired' ? '已接通 · 自动作答' : '等待确认')}`));
      await wait(100);
    };
    await show(fixture);
    await until('active interval', () => c.eval('document.querySelector(".hl-polling")?.textContent.includes("活跃检查 · 每 10 秒")'));
    const options = await c.eval('Array.from(document.querySelector("[data-hl-f=pollSeconds]").options).map(o => o.value)');
    assert.deepEqual(options, ['10', '15', '30', '45', '60', '120']);
    // 「向家里求助」一节（ask_home，2026-10-15 起）按设计写明家里；其余部分保持中性。
    const pairedText = await c.eval('(() => { const d = document.getElementById("home-link-dialog").cloneNode(true); d.querySelector("[data-hl-sec=ask-home]")?.remove(); document.body.append(d); const t = d.innerText; d.remove(); return t; })()');
    assert.match(pairedText, /任务记录/); assert.match(pairedText, /空闲检查间隔/); assert.match(pairedText, /45 秒/); assert.doesNotMatch(pairedText, /家里/);
    await shot('02-active'); check('活跃状态显示每 10 秒；空闲设置包含 10 秒及原有自定义值，任务记录保留');

    const draftRoots = 'D:\\draft\\keep';
    await c.eval(`(() => { const e = document.querySelector('[data-hl-f=codeRoots]'); e.value = ${json(draftRoots)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    fixture.polling = { active: false, intervalSeconds: 45, activeUntil: null };
    await show(fixture);
    assert.equal(await c.eval('document.querySelector("[data-hl-f=codeRoots]").value'), draftRoots);
    assert.match(await c.eval('document.querySelector(".hl-polling").textContent'), /空闲检查 · 每 45 秒/);
    await shot('03-idle-preserves-edit'); check('状态切到空闲 45 秒时，正在编辑的设置不会被刷新覆盖');
    await click('[data-hl=save]');
    await until('settings saved', () => c.eval('window.__companyUiFixture.saved.length === 1'));
    assert.equal(await c.eval('window.__companyUiFixture.saved[0].pollSeconds'), 45);
    assert.equal(await c.eval('window.__companyUiFixture.saved[0].codeRoots'), draftRoots);
    check('保存按钮保留原设置值并提交编辑内容');

    // 2026-10-17 田哥：工作日忙时 3 个、内存保底 10%，这些数字都可在设置里调。
    const parallelText = await c.eval('document.getElementById("home-link-dialog").innerText');
    assert.match(parallelText, /同时处理/); assert.match(parallelText, /现在是闲时，最多同时 6 个（1 个在跑，受闲时上限限制）/);
    const saved0 = await c.eval('window.__companyUiFixture.saved[0]');
    assert.deepEqual([saved0.maxParallel, saved0.maxParallelIdle, saved0.perAccountPeak, saved0.perAccountIdle, saved0.memFloorPct, saved0.usePool], [3, 6, 3, 6, 10, true]);
    await c.eval(`(() => { const set = (k, v) => { const e = document.querySelector('[data-hl-f=' + k + ']'); e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); };
      set('maxParallel', '4'); set('memFloorPct', '15'); set('perAccountIdle', '8'); })()`);
    await c.eval('document.querySelector("[data-hl-f=maxParallel]").scrollIntoView({ block: "center" })');
    await shot('03b-parallel-settings');
    await click('[data-hl=save]');
    await until('parallel saved', () => c.eval('window.__companyUiFixture.saved.length === 2'));
    const saved1 = await c.eval('window.__companyUiFixture.saved[1]');
    assert.deepEqual([saved1.maxParallel, saved1.memFloorPct, saved1.perAccountIdle], [4, 15, 8]);
    check('并行档位（忙时、闲时、每号、内存保底、忙时时段、号池）在设置页可见、可改、保存时提交');

    fixture.net = { gate: { since: new Date(now).toISOString() } };
    await show(fixture);
    assert.match(await c.eval('document.getElementById("home-link-dialog").innerText'), /期间收到的问题和要发的回执都不会丢/);
    assert.equal(await c.eval('!!document.querySelector("[data-hl=gate]")'), true);
    await shot('04-network-gate'); check('网络放行恢复入口仍可见');
    fixture.link.state = 'waiting-welcome'; fixture.net = {};
    await show(fixture);
    const waiting = await c.eval('document.getElementById("home-link-dialog").innerText');
    assert.match(waiting, /等待对端确认/); assert.doesNotMatch(waiting, /家里|公司代码|内网|回传/);
    await shot('05-waiting'); check('等待配对文案保持中性，取消和立即检查入口保留');

    // 重开 Hub（同一数据目录）：不用再敲，入口一直在。
    await c.close(); c = null; await gracefulQuit(hub); hub = null;
    await launch();
    await until('entry after restart', hasEntry);
    check('重开 Hub 后入口仍在，不用再解锁');
    result.passed = true;
  } catch (error) { result.error = error.stack || String(error); throw error; }
  finally {
    fs.writeFileSync(path.join(out, '20261015-company-link-ui-result-codex1.json'), json(result));
    if (c) await c.close();
    if (hub) await gracefulQuit(hub);
    console.log(out);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
