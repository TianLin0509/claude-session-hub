'use strict';
// Real isolated Electron UI/IPC. Model dispatch is a controlled fixture, not a live-model E2E.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { _parseGroupTargets } = require('../main/groupchat/dispatcher');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-prep-controls-'));
const WORK = path.join(ROOT, 'work');
const DATA = path.join(ROOT, 'data');
const ART = path.resolve(__dirname, '../output/playwright', `dev-prep-${Date.now()}`);
const LOG = path.join(ROOT, 'dispatch.jsonl');
const SCRIPT = path.join(ROOT, 'dispatch.js');
let PREP;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const calls = () => fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(e => e ? reject(e) : resolve(port)); });
});
fs.mkdirSync(WORK, { recursive: true }); fs.mkdirSync(ART, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'prepared-projects.json'), JSON.stringify({schemaVersion:1,projects:[],migrations:[]}));
fs.writeFileSync(path.join(WORK, '.aiwork-root'), '');
fs.writeFileSync(SCRIPT, `const fs=require('fs'); module.exports=args=>{ fs.appendFileSync(${JSON.stringify(LOG)},JSON.stringify(args)+'\\n'); return {text:'受控验收已收到'}; };`);

async function run() {
  let hub, cdp;
  const evidence = { checks: [], root: ROOT, artifacts: ART, dispatcher: 'controlled fixture' };
  const ok = (label, condition) => { assert(condition, label); evidence.checks.push(label); console.log('PASS ' + label); };
  try {
    hub = await launchIsolatedHub({ dataDir: DATA, port: await freePort(), windowMode: 'hidden',
      ...(process.env.HUB_PREP_ENTRY ? { entryPath: process.env.HUB_PREP_ENTRY } : {}),
      extraEnv: { CLAUDE_HUB_TEST_DISPATCH_SCRIPT: SCRIPT, AI_HUB_WORKSPACE_ROOT: WORK,
        CODEX_HOME: path.join(ROOT, 'codex'), CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude') } });
    evidence.pid = hub.pid; evidence.port = hub.port;
    cdp = await connectFirstPage(hub, t => /index\.html/.test(t.url));
    PREP = await cdp.eval("require('../core/dev-file-workflow').PROJECT_PREP_PROMPT");
    assert(PREP.includes('project-prep') && PREP.includes(DATA), 'project registration targets isolated data');
    const wait = async (fn, label) => {
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) { const v = await fn(); if (v) return v; await sleep(120); }
      throw new Error('Timeout: ' + label);
    };
    const invoke = (channel, args = {}) => cdp.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(args)})`);
    const click = async selector => {
      const p = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw Error('Missing '+${JSON.stringify(selector)}); const r=e.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; if(!r.width||!r.height||!e.contains(document.elementFromPoint(x,y))) throw Error('Not clickable '+${JSON.stringify(selector)});return {x,y};})()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 });
    };
    const shot = async name => { const s = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ART, name + '.png'), Buffer.from(s.data, 'base64')); };
    const size = async width => { await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false }); await sleep(250); };
    const type = async text => {
      await cdp.eval("(()=>{const b=document.getElementById('mr-input-box'); b.focus(); const r=document.createRange();r.selectNodeContents(b);const s=getSelection();s.removeAllRanges();s.addRange(r);})()");
      await cdp.send('Input.insertText', { text });
    };
    const enter = async () => {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    };
    await wait(() => cdp.eval('!!window.openMeetingCreateModal && !!window.MeetingRoom'), 'UI ready');
    await size(1600);
    // Use the actual creation modal and its normal create handler, not synthetic members.
    await cdp.eval("openMeetingCreateModal('group')");
    await click('[data-mcm-scene="general"]');
    await cdp.eval("closeMeetingCreateModal();openMeetingCreateModal('group')");
    ok('默认开发排第一，默认选择已有路径', await cdp.eval(`document.querySelector('input[name="mcm-scene"]:checked').value==='dev' && document.querySelector('[data-mcm-scene]').dataset.mcmScene==='dev' && document.querySelector('[data-mcm-workspace-mode="existing"]').getAttribute('aria-checked')==='true'`));
    ok('创建页不再显示起手选项', await cdp.eval("!document.querySelector('[data-mcm-dev-start]')"));
    await click('[data-mcm-workspace-mode="default"]');
    if (process.argv.includes('--solo')) {
      ok('开发群聊保留至少两位成员', await cdp.eval("!document.querySelector('[data-remove-member]')"));
      await click('[data-mcm-scene="general"]');
      await click('[data-remove-member="1"]');
      await click('[data-mcm-scene="dev"]');
      await click('#meeting-create-modal .mcm-create');
      await wait(() => cdp.eval("document.querySelector('.mcm-error')?.textContent.includes('至少需要两位')"), 'solo creation rejected');
      ok('单人开发引导至普通会话的一键开工', await cdp.eval("document.querySelector('.mcm-error').textContent.includes('一键开工')"));
      evidence.ok=true;
      return;
    }
    if (process.argv.includes('--double-codex')) {
      await cdp.eval(`(() => {const s=document.querySelector('.mcm-slot[data-slot="0"] .mcm-ai-select');s.value='codex';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    }
    await shot('creation');
    await click('#meeting-create-modal .mcm-create');
    const created = await wait(async () => (await invoke('get-meetings')).find(m => m.scene === 'dev' && m.subSessions.length === 2 && m.serialWorkflow?.fileFlowVersion === 2), 'real UI created room');
    const id = created.id;
    const room = async () => (await invoke('get-meetings')).find(m => m.id === id);
    await cdp.eval(`selectMeeting(${JSON.stringify(id)})`);
    await wait(() => cdp.eval("!!document.querySelector('[data-file-prep]')"), 'file controls');
    await shot('initial-wide');
    evidence.initial = created;
    ok('实际建群 UI：两席保留，初始仅首席选中', JSON.stringify(created.participants) === '[0]');
    if (process.argv.includes('--double-codex')) ok('两个独立 Codex 席位', created.slotSpecs.every(s => s.kind === 'codex') && new Set(created.subSessions).size === 2);
    ok('首席头像与收件人一致', await cdp.eval("JSON.stringify([...document.querySelectorAll('.mr-free-slot-cb:checked')].map(e=>Number(e.dataset.slotIdx)))==='[0]'"));
    const before = calls().length;
    await type('');
    await click('[data-file-prep]');
    ok('立项原文及输入焦点', await cdp.eval(`document.getElementById('mr-input-box').innerText===${JSON.stringify(PREP)} && document.activeElement.id==='mr-input-box'`));
    await click('[data-file-prep]');
    ok('重复立项不叠加', await cdp.eval(`document.getElementById('mr-input-box').innerText===${JSON.stringify(PREP)}`));
    ok('点击不派发、不创建阶段文件', calls().length === before && !fs.existsSync(path.join(DATA, 'task-docs', id)));
    await enter();
    await wait(() => calls().length > before, 'user Enter dispatch');
    // Normal discussion routing uses persisted participants; targetMemberIds is optional
    // and is only supplied explicitly by workflow dispatch / mentions.
    ok('用户 Enter 后提交完整提示词且收件人仍仅首席', calls()[before].userInput === PREP && JSON.stringify((await room()).participants) === '[0]');
    const targets = _parseGroupTargets(calls()[before].userInput, created.slotSpecs.map((s, i) => ({ ...s, sid: created.subSessions[i] })), (await room()).participants);
    ok('生产收件人解析函数只解析到首席 session', JSON.stringify(targets.targets.map(t => t.sid)) === JSON.stringify([created.subSessions[0]]));
    await wait(async () => !(await invoke('dev-file:status', { meetingId: id })).running, 'turn settles');
    await type('保留用户草稿\n第二行');
    await click('[data-file-prep]');
    const filled = await cdp.eval("document.getElementById('mr-input-box').innerText");
    ok('多行草稿原文保留', filled === '保留用户草稿\n第二行\n\n' + PREP);
    await click('.mr-free-avatar-chk[data-slot-idx="1"]');
    await wait(async () => JSON.stringify((await room()).participants) === '[0,1]', 'manual multiple');
    await click('.mr-free-avatar-chk[data-slot-idx="0"]');
    await wait(async () => JSON.stringify((await room()).participants) === '[1]', 'manual second');
    const other = await invoke('create-meeting', { mode: 'general', title: '另一个群', workspace: WORK });
    await cdp.eval(`selectMeeting(${JSON.stringify(other.id)})`);
    await cdp.eval(`selectMeeting(${JSON.stringify(id)})`);
    await wait(() => cdp.eval("!!document.querySelector('[data-file-prep]')"), 'return to room');
    await click('[data-file-prep]');
    ok('切房返回保留草稿和手选第二席', (await room()).participants.join() === '1' && await cdp.eval(`document.getElementById('mr-input-box').innerText===${JSON.stringify(filled)}`));
    // Wide target region: actions precede the recipients and sit within the right-hand blank area.
    evidence.geometry = {};
    for (const width of [1600, 1100, 760]) {
      await size(width);
      const g = await cdp.eval(`(() => {
        const rect = e => { const r = e.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}; };
        const f = document.querySelector('.mr-file-flow'), a = document.querySelector('.mr-file-actions'), n = document.querySelector('.mr-file-recipients');
        return {flow:rect(f),actions:rect(a),recipients:rect(n),avatar:rect(document.querySelector('#mr-free-avatars-row')),head:rect(document.querySelector('#mr-composer-head')),buttons:[...a.querySelectorAll('button')].map(e => {
          const r = e.getBoundingClientRect();
          return {text:e.innerText,...rect(e),hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};
        })};
      })()`);
      evidence.geometry[width] = g;
      ok(`宽度 ${width}：按钮可点击且不溢出`, g.buttons.every(b => b.hit && b.x >= g.flow.x - 1 && b.right <= g.flow.right + 1));
      ok(`宽度 ${width}：立项紧邻开题`, g.buttons[0].text === '立项' && g.buttons[1].text === '开题');
      ok(`宽度 ${width}：头像、状态与操作保持一行`, g.avatar.x < g.flow.x && Math.abs(g.avatar.y + g.avatar.h / 2 - g.actions.y - g.actions.h / 2) < 5 && g.head.h <= 45);
      await shot('controls-' + width);
    }
    await size(1600);
    await click('[data-file-kickoff]');
    await wait(async () => (await room()).participants.join() === '0', 'kickoff selects author');
    ok('开题仍预填并保留原文', await cdp.eval(`document.getElementById('mr-input-box').innerText.startsWith(${JSON.stringify(filled)}) && document.getElementById('mr-input-box').innerText.includes('【开题提示词结束】')`));
    ok('预填开题尚未创建阶段文件', !fs.existsSync(path.join(DATA, 'task-docs', id)));
    await click('.mr-free-avatar-chk[data-slot-idx="1"]');
    await click('.mr-free-avatar-chk[data-slot-idx="0"]');
    await wait(async () => (await room()).participants.join() === '1', 'legacy manual second');
    await invoke('update-meeting-sync', { meetingId: id, fields: { serialWorkflow: { ...created.serialWorkflow, fileFlowVersion: 1 } } });
    await cdp.eval(`selectMeeting(${JSON.stringify(other.id)});selectMeeting(${JSON.stringify(id)})`);
    await wait(() => cdp.eval("!document.querySelector('[data-file-prep]')"), 'legacy room controls');
    ok('旧流程不显示立项控件且不重置选择', (await room()).participants.join() === '1');
    evidence.ok = true;
  } catch (error) {
    evidence.error = error.stack;
    if (cdp) {
      try {
        const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(ART, 'failure.png'), Buffer.from(s.data, 'base64'));
        evidence.ui = await cdp.eval("({text:document.body.innerText.slice(-6000),preflight:document.querySelector('.mr-input-preflight')?.outerHTML})");
      } catch (captureError) { evidence.captureError = captureError.message; }
    }
    throw error;
  }
  finally {
    if (hub) fs.writeFileSync(path.join(ART, 'hub.log'), hub.log().join('\n'));
    const cleanupErrors = [];
    if (cdp) { try { await cdp.close(); } catch (e) { cleanupErrors.push(e); } }
    if (hub) { try { await gracefulQuit(hub); } catch (e) { cleanupErrors.push(e); } }
    if (cleanupErrors.length) {
      evidence.ok = false;
      evidence.cleanupErrors = cleanupErrors.map(e => e.stack);
    }
    fs.writeFileSync(path.join(ART, 'checks.json'), JSON.stringify(evidence, null, 2));
    console.log('ARTIFACT_ROOT ' + ART);
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Isolated Hub cleanup failed; run is not PASS');
  }
}
run().catch(e => { console.error(e); process.exitCode = 1; });
