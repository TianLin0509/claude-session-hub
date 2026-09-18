'use strict';
// 群聊分支的**界面**入口：会话右键「加入群聊…」、群聊「+ 成员 → 从已有会话分支…」、
// 群聊右键「分支群聊」。全部用真实鼠标事件点，跑在隔离 Hub 上（fixture 扮演成员，不花钱）。
//
// 跑法：node tests/e2e-groupchat-fork-ui-cdp.js
// 证据：artifacts/groupchat-fork-ui/

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const j = JSON.stringify;
const pause = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-gcforkui-'));
  const out = path.resolve(process.env.GC_FORK_UI_EVIDENCE_DIR || 'artifacts/groupchat-fork-ui');
  fs.mkdirSync(out, { recursive: true });
  const dataDir = path.join(root, 'data');
  const cwd = path.join(root, 'workspace');
  const home = path.join(root, 'codex');
  fs.mkdirSync(cwd); fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "high"\n');
  const port = await new Promise((res, rej) => {
    const s = net.createServer(); s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => res(n)); });
  });

  let hub; let c;
  const evidence = { checks: [], passed: false };
  const check = (name, pass, detail) => {
    assert(pass, name + ': ' + j(detail));
    evidence.checks.push({ name, detail: detail === undefined ? null : detail });
    console.log('PASS ' + name);
  };
  const until = async (expr, label, ms = 60000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await c.eval(expr)) return; await pause(150); }
    throw new Error('timeout: ' + label);
  };
  const invoke = (channel, payload) => c.eval(`ipcRenderer.invoke(${j(channel)}, ${j(payload)})`);
  const clickSelector = async (selector) => {
    await until(`(()=>{const e=document.querySelector(${j(selector)});if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0;})()`, 'clickable ' + selector);
    const pos = await c.eval(`(()=>{const r=document.querySelector(${j(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pos });
    for (const type of ['mousePressed', 'mouseReleased']) {
      await c.send('Input.dispatchMouseEvent', { type, ...pos, button: 'left', clickCount: 1 });
    }
    await pause(150);
  };
  // 右键菜单走真实的 contextmenu 事件（渲染层就是监听它的），坐标取行的中心。
  const rightClick = async (selector) => {
    await until(`!!document.querySelector(${j(selector)})`, 'exists ' + selector);
    await c.eval(`(()=>{const el=document.querySelector(${j(selector)});const r=el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:Math.round(r.x+r.width/2),clientY:Math.round(r.y+r.height/2)}));return true;})()`);
    await pause(150);
  };
  const clickMenuItemByText = async (containerSelector, text) => {
    await until(`[...document.querySelectorAll(${j(containerSelector)})].some(e=>e.textContent.includes(${j(text)}) && e.offsetParent!==null)`,
      `menu item ${text}`);
    const index = await c.eval(`[...document.querySelectorAll(${j(containerSelector)})].findIndex(e=>e.textContent.includes(${j(text)}) && e.offsetParent!==null)`);
    const pos = await c.eval(`(()=>{const r=[...document.querySelectorAll(${j(containerSelector)})][${index}].getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pos });
    for (const type of ['mousePressed', 'mouseReleased']) {
      await c.send('Input.dispatchMouseEvent', { type, ...pos, button: 'left', clickCount: 1 });
    }
    await pause(200);
  };
  const shot = async (name) => {
    const s = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(s.data, 'base64'));
  };
  const membersOf = meetingId => c.eval(`(()=>{const m=meetings[${j(meetingId)}];return m?m.subSessions.length:-1;})()`);

  try {
    hub = await launchIsolatedHub({
      dataDir, port, windowMode: 'hidden', label: 'groupchat-fork-ui',
      extraEnv: {
        CODEX_HOME: home,
        CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
        CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.join(__dirname, 'fixtures/codex-app-server.js'),
      },
    });
    evidence.pid = hub.pid;
    c = await connectFirstPage(hub);
    await c.send('Page.enable');
    await until('typeof sessions!=="undefined" && !!window.__hubE2E', 'renderer');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1550, height: 1080, deviceScaleFactor: 1, mobile: false });

    const slot = { kind: 'codex', model: 'gpt-6-astra', effort: 'high', mcpProfile: 'none', codexSpeedTier: 'standard' };
    const group = await c.eval(`ipcRenderer.invoke('create-meeting', ${j({
      title: 'UI 分支群', groupChat: true, scene: 'general', workspace: cwd, slots: [slot, slot],
    })})`);
    // 两位成员先答一轮，拿到可分支的原生会话 ID。
    await invoke('groupchat:turn', { meetingId: group.id, userInput: '先聊一句，让成员拿到原生会话 ID。' });
    await until(`(async()=>{const rows=await ipcRenderer.invoke('groupchat:forkable-sessions',{meetingId:${j(group.id)}});return rows.length>=0;})()`, 'ipc alive');

    // 一个独立会话，用来测「加入群聊…」
    const standalone = await c.eval(`ipcRenderer.invoke('create-session', ${j({
      kind: 'codex', opts: { title: 'UI 独立会话', cwd, model: 'gpt-6-astra', effort: 'high', mcpProfile: 'none' },
    })})`);
    await invoke('session:send-prompt', { sessionId: standalone.id, text: '独立会话的一轮，拿原生 ID。' });
    await until(`(async()=>{const rows=await ipcRenderer.invoke('groupchat:forkable-sessions',{});return rows.some(r=>r.id===${j(standalone.id)});})()`,
      '独立会话可分支');

    // ── UI 1：会话右键 → 加入群聊… ────────────────────────────────────────
    await until(`!!document.querySelector('[data-session-id="${standalone.id}"]')`, '侧栏出现独立会话');
    await rightClick(`[data-session-id="${standalone.id}"]`);
    check('会话右键菜单出现「加入群聊…」', await c.eval(
      `(()=>{const m=document.getElementById('context-menu');const b=m.querySelector('[data-action="join-group"]');
        return m.style.display==='block' && b && b.style.display!=='none';})()`));
    check('会话右键菜单不显示「分支群聊」（那是群聊的入口）', await c.eval(
      `document.querySelector('#context-menu [data-action="fork-meeting"]').style.display==='none'`));
    await shot('01-session-context-menu');
    await clickSelector('#context-menu [data-action="join-group"]');
    await until(`!!document.getElementById('gc-join-group-menu')`, '加入群聊的二级菜单');
    check('二级菜单列出可加入的群聊和「新建群聊」', await c.eval(
      `(()=>{const items=[...document.querySelectorAll('#gc-join-group-menu .mr-quote-menu-item')].map(e=>e.textContent);
        return items.some(t=>t.includes('新建群聊')) && items.some(t=>t.includes('UI 分支群'));})()`));
    await shot('02-join-group-menu');
    const before1 = await membersOf(group.id);
    await clickMenuItemByText('#gc-join-group-menu .mr-quote-menu-item', 'UI 分支群');
    await until(`(()=>{const m=meetings[${j(group.id)}];return m && m.subSessions.length===${before1 + 1};})()`, '成员加入');
    check('通过右键菜单把已有会话分支进了群聊', await membersOf(group.id) === before1 + 1);
    check('原会话仍然独立存在', await c.eval(`(()=>{const s=sessions.get(${j(standalone.id)});return !!s && !s.meetingId;})()`));
    // 进度/成功提示必须是轻提示。用模态框报「正在加入…」会把后续操作挡住 ——
    // 2026-09-17 第一版就是这么写的，真机一跑就卡在「知道了」上。
    check('进度提示不是模态框（不挡住后续操作）', await c.eval(
      `!document.querySelector('dialog.hub-dialog[open]') && !!document.getElementById('gc-fork-toast')`));

    // ── UI 2：群聊「+ 成员 → 从已有会话分支…」 ────────────────────────────
    // 侧栏行会随未读/活跃度重排，点击未必落在行本身（可能命中成员小标签）。
    // 这一步只是"进到房间里"，不是本次要验的功能，所以点两次仍未进就用测试钩子兜底。
    let openedByClick = false;
    for (let attempt = 0; attempt < 2 && !openedByClick; attempt += 1) {
      await clickSelector(`[data-meeting-id="${group.id}"]`);
      try {
        await until(`window.__hubE2E.getActiveMeetingId()===${j(group.id)}`, '打开群聊', 5000);
        openedByClick = true;
      } catch { /* 下一次重试 */ }
    }
    evidence.openedByClick = openedByClick;
    if (!openedByClick) {
      await c.eval(`window.__hubE2E.selectMeeting(${j(group.id)})`);
      await until(`window.__hubE2E.getActiveMeetingId()===${j(group.id)}`, '用测试钩子打开群聊');
    }
    await until('!!document.getElementById("mr-input-box")', '群聊输入框');
    // 「+ 成员」在群聊里有两处：右侧成员面板和房间头部。哪个此刻可见就点哪个。
    await until('!!document.querySelector("[data-gc-add-member]") || !!document.getElementById("mr-btn-add-sub")', '群聊加成员按钮');
    // 用可见矩形判断，不用 offsetParent —— 房间头部挂在 position:fixed 的容器里，
    // offsetParent 天生是 null，按它判断会把明明看得见的按钮判成不可见。
    const addBtnSelector = await c.eval(`(()=>{const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();
        const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';};
      if(visible(document.querySelector('[data-gc-add-member]'))) return '[data-gc-add-member]';
      return visible(document.getElementById('mr-btn-add-sub')) ? '#mr-btn-add-sub' : null;})()`);
    if (!addBtnSelector) {
      const diag = await c.eval(`(()=>({
        activeMeetingId: typeof activeMeetingId!=='undefined'?activeMeetingId:null,
        headerExists: !!document.getElementById('mr-btn-add-sub'),
        sideExists: !!document.querySelector('[data-gc-add-member]'),
        addMemberTexts: [...document.querySelectorAll('button')].filter(b=>b.textContent.includes('成员')).map(b=>({id:b.id,cls:b.className,rect:b.getBoundingClientRect().width})),
      }))()`);
      assert.fail('群聊里没有可见的「+ 成员」按钮：' + j(diag));
    }
    evidence.addMemberButton = addBtnSelector;
    await clickSelector(addBtnSelector);
    await until(`!!document.getElementById('mr-add-sub-menu')`, '加成员菜单');
    check('加成员菜单里有「从已有会话分支…」', await c.eval(
      `[...document.querySelectorAll('#mr-add-sub-menu .mr-quote-menu-item')].some(e=>e.textContent.includes('从已有会话分支'))`));
    await shot('03-add-member-menu');
    await clickMenuItemByText('#mr-add-sub-menu .mr-quote-menu-item', '从已有会话分支');
    await until(`!!document.getElementById('gc-fork-picker')`, '会话选择弹窗');
    const rows = await c.eval(`document.querySelectorAll('#gc-fork-picker .modal-row').length`);
    check('选择弹窗列出了可分支的会话', rows >= 1, rows);
    await shot('04-session-picker');
    // 过滤框要能收窄列表
    await c.eval(`(()=>{const i=document.querySelector('#gc-fork-picker .modal-filter');i.value='不可能匹配到的关键词';i.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    await pause(200);
    check('过滤框生效（筛不到时给出空状态而不是空白）', await c.eval(
      `document.querySelectorAll('#gc-fork-picker .modal-row').length===0 && !!document.querySelector('#gc-fork-picker .modal-empty')`));
    await c.eval(`(()=>{const i=document.querySelector('#gc-fork-picker .modal-filter');i.value='';i.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    await pause(200);
    const before2 = await membersOf(group.id);
    await clickSelector('#gc-fork-picker .modal-row');
    await until(`(()=>{const m=meetings[${j(group.id)}];return m && m.subSessions.length===${before2 + 1};})()`, '从弹窗加入的成员');
    check('从弹窗选中的会话被分支进群聊', await membersOf(group.id) === before2 + 1);
    check('弹窗选完就关闭', await c.eval(`!document.getElementById('gc-fork-picker')`));

    // ── UI 3：群聊右键 → 分支群聊 ─────────────────────────────────────────
    const meetingsBefore = await c.eval('Object.keys(meetings).length');
    await rightClick(`[data-meeting-id="${group.id}"]`);
    check('群聊右键菜单出现「分支群聊」', await c.eval(
      `(()=>{const b=document.querySelector('#context-menu [data-action="fork-meeting"]');return b && b.style.display!=='none';})()`));
    check('群聊右键菜单不显示「加入群聊…」', await c.eval(
      `document.querySelector('#context-menu [data-action="join-group"]').style.display==='none'`));
    await shot('05-meeting-context-menu');
    await clickSelector('#context-menu [data-action="fork-meeting"]');
    await until(`!!document.querySelector('dialog.hub-dialog')`, '分支确认框');
    check('分支前有确认框，并说明会新建几个成员会话', await c.eval(
      `document.querySelector('dialog.hub-dialog .hub-dialog-body').textContent.includes('个成员会话')`));
    await shot('06-fork-confirm');
    await clickSelector('dialog.hub-dialog .hub-button-primary');
    await until(`Object.keys(meetings).length===${meetingsBefore + 1}`, '分支群聊出现', 120000);
    const forkedId = await c.eval(`Object.values(meetings).find(m=>m.title.includes('（分支'))?.id`);
    check('分支群聊建出来了，成员数与原群聊一致', await membersOf(forkedId) === await membersOf(group.id),
      { forkedId, members: await membersOf(forkedId) });
    await until(`!!document.querySelector('[data-meeting-id="${forkedId}"]')`, '分支群聊进入侧栏');
    check('分支群聊出现在侧栏且是当前打开的房间', await c.eval(`window.__hubE2E.getActiveMeetingId()===${j(forkedId)}`));
    await shot('07-forked-room');

    evidence.passed = true;
  } catch (error) {
    evidence.error = error.stack;
    throw error;
  } finally {
    if (c) { try { await shot('last'); } catch {} await c.close(); }
    if (hub) {
      fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n'));
      evidence.exit = await gracefulQuit(hub);
    }
    fs.writeFileSync(path.join(out, 'evidence.json'), j(evidence, null, 2));
    console.log(j({ passed: evidence.passed, checks: evidence.checks.length, exit: evidence.exit }));
    try { if (root.startsWith(os.tmpdir())) fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
