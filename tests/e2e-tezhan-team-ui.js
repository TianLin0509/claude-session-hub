'use strict';
// 特战队团队入口的真实界面流程（2026-10-18）：本机起真实 relay_server.py，三个隔离 Hub 实例按真人路径点：
//   1) 组长 Hub（有管理口令）：无线页「特战队成员」新建邀请码；
//   2) 同事家里 Hub（没有收件箱配置）：粘贴邀请码 → 生成配对码；同事公司 Hub：解锁 → 粘贴配对码 → 两边接通；
//   3) 组长收回邀请码 → 同事家里立即显示钥匙被收回。
// 不碰线上服务器、不启动 AI。跑法：HUB_UNLOCK_PHRASE=<公司版口令> node tests/e2e-tezhan-team-ui.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { typeUnlock } = require('./helpers/company-unlock');

const SERVER = process.env.TEZHAN_RELAY_SERVER || path.join(os.homedir(), 'company-drop', 'server', 'relay_server.py');
const ADMIN = 'e2e-ui-admin-token-0123456789abcdefgh';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = JSON.stringify;
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});

(async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tezhan-team-ui-'));
  const out = path.resolve('artifacts/20261018-tezhan-team-claude1', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(out, { recursive: true });
  const result = { passed: false, scope: '真实隔离 Hub 界面 + 本机真实通道服务；不连线上服务器、不启动 AI', checks: [], screenshots: [], out };
  const check = message => { result.checks.push(message); console.log('✓ ' + message); };
  const hubs = [];
  let relayProc = null;
  try {
    // ---- 本机真实通道服务 ----
    const relayRoot = path.join(testRoot, 'relay');
    fs.mkdirSync(path.join(relayRoot, 'team'), { recursive: true });
    fs.writeFileSync(path.join(relayRoot, 'team', 'admin.json'), json({ token_sha256: createHash('sha256').update(ADMIN).digest('hex') }));
    const relayPort = await freePort();
    relayProc = spawn(process.env.PYTHON || 'python', ['-u', SERVER, '--root', relayRoot, '--port', String(relayPort)], { windowsHide: true, stdio: 'ignore' });
    const relay = `http://127.0.0.1:${relayPort}`;
    for (let i = 0; i < 50; i++) { try { if ((await fetch(relay + '/health')).ok) break; } catch {} await wait(100); }

    // 组长电脑：收件箱配置里带管理口令；同事电脑：什么都没有
    const leaderHome = path.join(testRoot, 'leader-home'), memberHome = path.join(testRoot, 'member-home');
    fs.mkdirSync(path.join(leaderHome, '.config', 'company-drop'), { recursive: true });
    fs.mkdirSync(memberHome, { recursive: true });
    fs.writeFileSync(path.join(leaderHome, '.config', 'company-drop', 'config.json'), json({ base_url: relay + '/drop/tok', team_admin_token: ADMIN }));

    const launch = async (label, role, bridgeHome) => {
      const hub = await launchIsolatedHub({ dataDir: path.join(testRoot, label, 'data'), port: await freePort(), label: 'tezhan-' + label, windowMode: 'background',
        extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: path.join(testRoot, label, 'home'), CLAUDE_HUB_BRIDGE_ROLE: role,
          ...(bridgeHome ? { CLAUDE_HUB_BRIDGE_HOME: bridgeHome } : {}),
          CLAUDE_HUB_WIRELESS_TIMER: '0', HUB_ASSISTANT_FAST_LANE: '0', DEEPSEEK_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', CODEX_API_KEY: '' } });
      hubs.push(hub);
      const c = await connectFirstPage(hub);
      await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
      await c.eval('window.confirm = () => true'); // 收回、换邀请码的确认框直接点「确定」
      const until = async (what, read, ms = 30000) => {
        for (const end = Date.now() + ms; Date.now() < end;) { if (await read()) return; await wait(200); }
        throw new Error(`[${label}] timeout: ${what}`);
      };
      const click = async selector => {
        await c.eval(`document.querySelector(${json(selector)})?.scrollIntoView({ block: 'center' })`);
        await until('clickable ' + selector, () => c.eval(`(() => { const e = document.querySelector(${json(selector)}); if (!e || e.disabled) return false; const r = e.getBoundingClientRect(), h = document.elementFromPoint(r.x+r.width/2, r.y+r.height/2); return r.width > 0 && (h === e || e.contains(h)); })()`));
        const p = await c.eval(`(() => { const r = document.querySelector(${json(selector)}).getBoundingClientRect(); return { x: r.x+r.width/2, y: r.y+r.height/2 }; })()`);
        for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
      };
      const type = async (selector, text) => { await click(selector); await c.send('Input.insertText', { text }); };
      const shot = async name => {
        const image = await c.send('Page.captureScreenshot', { format: 'png' });
        const file = path.join(out, name + '.png'); fs.writeFileSync(file, Buffer.from(image.data, 'base64')); result.screenshots.push(file);
      };
      const text = selector => c.eval(`document.querySelector(${json(selector)})?.innerText || ''`);
      return { hub, c, until, click, type, shot, text };
    };
    const openWireless = async h => {
      await h.until('renderer', () => h.c.eval('!!document.getElementById("btn-wireless")'));
      await h.click('#btn-wireless');
      await h.until('company link section', () => h.c.eval('(() => { const e = document.querySelector(".cl-section"); return !!e && !e.hidden && !!e.querySelector(".cl-head").innerText.trim(); })()'));
      await h.c.eval('document.querySelector(".cl-section").scrollIntoView({ block: "start" })');
    };

    // ---- 1. 组长新建邀请码 ----
    let leader = await launch('leader', 'home', leaderHome);
    await openWireless(leader);
    await leader.until('team block', () => leader.c.eval('!!document.querySelector(".cl-team")'));
    await leader.until('members loaded', async () => /还没有发过邀请码/.test(await leader.text('.cl-team')));
    await leader.type('[data-cl-input="label"]', '同事');
    // 正在称呼框里打字时通道来了动静：不重绘这一块，输入框还是原来那个、内容和焦点都在
    await leader.c.eval('(() => { window.__labelEl = document.querySelector("[data-cl-input=label]"); require("electron").ipcRenderer.emit("bridge:changed", {}); })()');
    await wait(800);
    assert.equal(await leader.c.eval('document.querySelector("[data-cl-input=label]") === window.__labelEl && document.activeElement === window.__labelEl && window.__labelEl.value === "同事"'), true);
    check('组长：正在称呼框里打字时通道刷新，不重绘、不丢字、不丢焦点（拼音输入法不会被打断）');
    await leader.click('[data-cl="team-create"]');
    await leader.until('fresh invite', () => leader.c.eval('!!document.querySelector("[data-cl-input=fresh]")?.value'));
    const invite = await leader.c.eval('document.querySelector("[data-cl-input=fresh]").value');
    assert.match(invite, /^AIHUB-TZ-1\./);
    await leader.until('member listed', async () => /同事[\s\S]*在用/.test(await leader.text('.cl-team')));
    await leader.c.eval('document.querySelector(".cl-team").scrollIntoView({ block: "center" })');
    await leader.shot('01-leader-new-invite');
    check('组长：无线页「特战队成员」输入称呼、点生成邀请码，得到 AIHUB-TZ-1 邀请码，列表显示「同事 · 在用」');
    // 只显示这一次：重开页面后不再显示
    await leader.c.close(); await gracefulQuit(leader.hub); hubs.splice(hubs.indexOf(leader.hub), 1);

    // ---- 2. 同事家里粘贴邀请码，公司粘贴配对码 ----
    const home = await launch('member-home', 'home', memberHome);
    const company = await launch('member-company', 'company', null);
    await openWireless(home);
    assert.equal(await home.c.eval('!!document.querySelector(".cl-invite [data-cl-input=invite]")'), true);
    assert.equal(await home.c.eval('!!document.querySelector("[data-cl=create]")'), false, '没有邀请码时不显示生成配对码');
    assert.equal(await home.c.eval('!!document.querySelector(".cl-team")'), false, '同事电脑不显示成员管理');
    await home.shot('02-member-needs-invite');
    check('同事家里：没有收件箱配置时先显示「粘贴邀请码」，不显示生成配对码和成员管理');

    await home.type('[data-cl-input="invite"]', 'AIHUB-LINK-1.abcdefghijklmnopqrstuvwxyz');
    await home.click('[data-cl="invite-save"]');
    await home.until('wrong paste hint', () => home.c.eval('document.body.innerText.includes("这是配对码")'));
    check('同事家里：错把配对码贴进来，提示「这是配对码，要粘贴到公司 Hub」');
    await home.c.eval('(() => { const e = document.querySelector("[data-cl-input=invite]"); e.value = ""; })()');
    await home.type('[data-cl-input="invite"]', invite);
    await home.click('[data-cl="invite-save"]');
    await home.until('create button', () => home.c.eval('!!document.querySelector("[data-cl=create]")'));
    assert.match(await home.text('.cl-head'), /特战队团队入口 · 同事 · 127\.0\.0\.1/);
    assert.ok(fs.existsSync(path.join(memberHome, '.claude', 'skills', 'tezhan-ask-company', 'SKILL.md')), 'Claude 的 skill 目录装上了团队版');
    assert.ok(fs.existsSync(path.join(memberHome, '.agents', 'skills', 'tezhan-ask-company', 'SKILL.md')), 'Codex 的 skill 目录装上了团队版');
    check('同事家里：保存邀请码后显示「通道：特战队团队入口 · 同事」，团队版 skill 装到 Claude 与 Codex 两处');

    await home.click('[data-cl="create"]');
    await home.until('pairing code', () => home.c.eval('(document.querySelector(".cl-head .cl-code")?.value || "").startsWith("AIHUB-LINK-1.")'));
    const code = await home.c.eval('document.querySelector(".cl-head .cl-code").value');
    assert.equal(await home.c.eval('!!document.querySelector("[data-cl=send]")'), false, '没有收件箱时不显示「发到公司收件箱」');
    assert.equal(await home.c.eval('document.querySelector("[data-cl=copy]").classList.contains("primary")'), true);
    await home.shot('03-member-pairing-code');
    check('同事家里：生成配对码；没有收件箱时只有「复制」（主按钮），不显示「发到公司收件箱」');

    await company.click('#btn-options');
    await typeUnlock(company.c);
    await company.click('#options-home-link');
    await company.until('pair field', () => company.c.eval('!!document.querySelector("#home-link-dialog[open] [data-hl-f=code]")'));
    await company.type('[data-hl-f=code]', code);
    await company.click('[data-hl=pair]');
    const linked = async () => /已接通/.test(await home.text('.cl-head'));
    for (const end = Date.now() + 90000; Date.now() < end && !(await linked());) {
      await home.c.eval('document.querySelector("[data-cl=check]")?.click()');
      await company.c.eval('require("electron").ipcRenderer.invoke("bridge:check-now")');
      await wait(1500);
    }
    assert.ok(await linked(), '家里显示已接通');
    await company.until('company paired', () => company.c.eval('require("electron").ipcRenderer.invoke("bridge:status").then(s => s.link && s.link.state === "paired")'));
    await home.shot('04-member-home-paired');
    await company.shot('04-member-company-paired');
    check('同事公司：解锁后粘贴配对码 → 两边接通（家里显示「已接通」），全程走团队入口');
    const memberDirs = fs.readdirSync(path.join(relayRoot, 'team')).filter(n => /^m[a-f0-9]{8}$/.test(n));
    assert.equal(memberDirs.length, 1);
    assert.ok(fs.readdirSync(path.join(relayRoot, 'team', memberDirs[0])).some(n => /^[a-f0-9]{32}$/.test(n)), '通道落在这位同事自己的目录里');
    assert.equal(fs.existsSync(path.join(relayRoot, 'bridge')) ? fs.readdirSync(path.join(relayRoot, 'bridge')).length : 0, 0, '组长的旧通道目录没被用');
    check('服务器上：这位同事的通道只落在他自己的成员目录里，组长的旧通道目录没被碰');

    // ---- 3. 组长收回 → 同事家里立即看到 ----
    leader = await launch('leader', 'home', leaderHome);
    await openWireless(leader);
    await leader.until('member row', () => leader.c.eval('!!document.querySelector(".cl-member [data-cl^=revoke]")'));
    assert.equal(await leader.c.eval('!!document.querySelector("[data-cl-input=fresh]")'), false, '邀请码只显示一次，重开后不再显示');
    await leader.click('.cl-member [data-cl^="revoke"]');
    await leader.until('revoked', async () => /已收回/.test(await leader.text('.cl-team')));
    await leader.c.eval('document.querySelector(".cl-team").scrollIntoView({ block: "center" })');
    await leader.shot('05-leader-revoked');
    check('组长：重开后邀请码不再显示；点「收回」后列表显示「已收回」');
    const revokedShown = async () => /已被收回/.test(await home.text('.cl-head'));
    for (const end = Date.now() + 30000; Date.now() < end && !(await revokedShown());) { await home.c.eval('document.querySelector("[data-cl=check]")?.click()'); await wait(1000); }
    assert.ok(await revokedShown(), '同事家里显示钥匙已被收回');
    await home.shot('06-member-revoked');
    check('同事家里：点「立即检查」即显示「这把通道钥匙已被收回：请向组长要新的邀请码」');

    // 横向不溢出（1440 宽）
    for (const h of [home, leader]) assert.equal(await h.c.eval('(() => { const e = document.querySelector(".cl-section"); return e.scrollWidth <= e.clientWidth + 1; })()'), true);
    check('1440 宽度下「公司联动」区块不横向溢出');
    result.passed = true;
  } catch (error) { result.error = error.stack || String(error); console.error(error); process.exitCode = 1; }
  finally {
    for (const hub of hubs.splice(0)) { try { await gracefulQuit(hub); } catch (e) { console.warn('quit', e.message); } }
    try { relayProc?.kill(); } catch {}
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch {}
    console.log(JSON.stringify({ passed: result.passed, out, checks: result.checks.length }));
  }
})();
