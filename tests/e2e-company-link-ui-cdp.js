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
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(testRoot, 'data'), port: await freePort(), label: 'company-link-ui', windowMode: 'background',
      ...(process.env.COMPANY_ENTRY ? { entryPath: process.env.COMPANY_ENTRY } : {}),
      extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: path.join(testRoot, 'home'), CLAUDE_HUB_BRIDGE_ROLE: 'company',
        CLAUDE_HUB_WIRELESS_TIMER: '0', HUB_ASSISTANT_FAST_LANE: '0', DEEPSEEK_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', CODEX_API_KEY: '' } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const until = async (label, read) => {
      for (const end = Date.now() + 30000; Date.now() < end;) { if (await read()) return; await wait(200); }
      throw new Error('timeout: ' + label);
    };
    const click = async selector => {
      await until('clickable ' + selector, () => c.eval(`(() => { const e = document.querySelector(${json(selector)}); if (!e || e.disabled) return false; const r = e.getBoundingClientRect(), h = document.elementFromPoint(r.x+r.width/2, r.y+r.height/2); return r.width > 0 && (h === e || e.contains(h)); })()`));
      const p = await c.eval(`(() => { const r = document.querySelector(${json(selector)}).getBoundingClientRect(); return { x: r.x+r.width/2, y: r.y+r.height/2 }; })()`);
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    };
    const shot = async name => {
      const overflow = await c.eval('(() => { const e = document.querySelector("#home-link-dialog"); return e.scrollWidth > e.clientWidth + 1; })()');
      assert.equal(overflow, false, name + ' 不应横向溢出');
      const image = await c.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(out, name + '.png'); fs.writeFileSync(file, Buffer.from(image.data, 'base64')); result.screenshots.push(file);
    };
    await until('menu entry', () => c.eval('!!document.getElementById("options-home-link")'));
    await click('#btn-options');
    assert.equal(await c.eval('document.getElementById("options-home-link").textContent'), 'AI特战队专用功能');
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
    const fixture = { ok: true, role: 'company', settings: { enabled: true, codeRoots: ['D:\\code\\example'], effort: 'high', maxParallel: 2, pollSeconds: 45, instructions: '根据授权范围查询资料，完成后汇报结果。' },
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
    const pairedText = await c.eval('document.getElementById("home-link-dialog").innerText');
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
    result.passed = true;
  } catch (error) { result.error = error.stack || String(error); throw error; }
  finally {
    fs.writeFileSync(path.join(out, '20261015-company-link-ui-result-codex1.json'), json(result));
    if (c) await c.close();
    if (hub) await gracefulQuit(hub);
    console.log(out);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
