'use strict';

// Real sidebar right-click -> copy -> another session -> paste -> Send.
// Native clipboard is opt-in and guarded; the CLI is an OS-process fixture, no model call.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const fixture = require('./e2e-session-reference-cdp');
const { buildReferenceText } = require('../core/session-reference');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const native = process.argv.includes('--native');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const j = JSON.stringify;
const out = path.resolve('output/playwright/20261014-sidebar-reference-codex1', `${Date.now()}-${native ? 'native' : 'sandbox'}`);
const evidence = { native, checks: [], boundary: '真实隔离 Hub 界面、IPC 和进程管道；CLI 为夹具，未调用云端模型。' };
const guard = path.join(__dirname, 'helpers/clipboard-guard.ps1');
const backupDir = path.join(fixture.TEMP_ROOT, 'clipboard-backup');
const copiedFile = path.join(fixture.TEMP_ROOT, 'copied-reference.txt');
const ps = (...args) => execFileSync('powershell.exe', ['-NoProfile', '-STA', '-File', guard, ...args],
  { windowsHide: true, encoding: 'utf8' }).trim();
let hub, c, backedUp = false;

async function wait(expression) {
  for (let i = 0; i < 300; i++) {
    const value = await c.eval(`(${expression}) || false`);
    if (value) return value;
    await sleep(100);
  }
  throw Error('Timed out: ' + expression);
}
async function click(selector, button = 'left') {
  await wait(`!!document.querySelector(${j(selector)})`);
  const point = await c.eval(`(() => {
    const el=document.querySelector(${j(selector)});el.scrollIntoView({block:'nearest'});
    const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
    if(!r.width||!r.height||!el.contains(document.elementFromPoint(x,y)))throw Error('Covered: '+${j(selector)});
    return {x,y};
  })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await c.send('Input.dispatchMouseEvent', { type, ...point, button, clickCount: 1 });
  }
}
const row = id => `.session-item[data-session-id="${id}"]`;
const referenceButton = '#context-menu [data-action="reference"]';
const readClipboard = () => c.eval("require('electron').clipboard.readText()");
const readInput = () => c.eval("readContenteditablePlainText(document.querySelector('.floating-input-box'))");
const check = (label, value) => { assert(value, label); evidence.checks.push(label); console.log('PASS ' + label); };
async function shot(name) {
  const image = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(image.data, 'base64'));
}
function restoreClipboard() {
  if (!backedUp) return;
  evidence.restore = ps('restore', backupDir, '-TextFile', copiedFile);
  backedUp = false;
  if (evidence.restore.startsWith('RESTORED')) evidence.restoreVerification = ps('verify', backupDir);
}

async function main() {
  fixture.writeFakeCli(); fixture.writeFixtures(); fs.mkdirSync(out, { recursive: true });
  const statePath = path.join(fixture.DATA_DIR, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const targetId = state.sessions.find(s => s.kind === 'claude').hubId;
  const emptyId = 'hub-empty-reference-source';
  state.sessions.push({ schemaVersion: 1, hubId: emptyId, kind: 'kimi', title: '尚未聊天的会话', cwd: fixture.WORK_DIR });
  state.sessions.forEach(s => { s.pinned = true; });
  fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path';
  try {
    hub = await launchIsolatedHub({ dataDir: fixture.DATA_DIR, port: await fixture.reservePort(), label: 'sidebar-reference', extraEnv: {
      [pathKey]: `${fixture.FAKE_BIN_DIR}${path.delimiter}${process.env[pathKey] || ''}`,
      CLAUDE_CONFIG_DIR: path.join(fixture.TEMP_ROOT, 'claude-config'), CODEX_HOME: fixture.CODEX_HOME,
      AI_HUB_WORKSPACE_ROOT: fixture.WORK_DIR,
      CLAUDE_HUB_CLAUDE_STREAM_FIXTURE: path.join(__dirname, 'fixtures/claude-stream.js'),
      HUB_CLAUDE_BACKEND: 'subscription', HUB_CODEX_BACKEND: 'subscription', HUB_CODEX_PROFILE: 'e2e',
      HUB_SESSION_SEARCH_CLAUDE_ROOTS: fixture.CLAUDE_ROOT, HUB_SESSION_SEARCH_CODEX_ROOTS: fixture.CODEX_ROOT,
      HUB_SESSION_SEARCH_KIMI_ROOTS: path.join(fixture.TEMP_ROOT, 'empty-kimi'),
      HUB_SESSION_SEARCH_GEMINI_ROOTS: path.join(fixture.TEMP_ROOT, 'empty-gemini'),
      ...(native ? { CLAUDE_HUB_E2E_REAL_CLIPBOARD: '1' } : {}),
    } });
    c = await connectFirstPage(hub, t => /index\.html/.test(t.url));
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
    await wait(`typeof sessions!=='undefined' && sessions.has(${j(fixture.SOURCE_HUB_ID)})`);
    await click('[data-session-days="pinned"]');
    await c.eval(`(() => {
      window.__referenceSends=[];
      const ipc=require('electron').ipcRenderer,original=ipc.invoke.bind(ipc);
      ipc.invoke=async(channel,...args)=>{
        const result=await original(channel,...args);
        if(channel==='session:send-prompt')window.__referenceSends.push({args,result});
        return result;
      };
    })()`);
    const sourceBefore = await c.eval(`({active:activeSessionId,status:sessions.get(${j(fixture.SOURCE_HUB_ID)}).status})`);
    assert.equal(sourceBefore.status, 'dormant');
    // Prepare the expected file before any system clipboard write, including failure cleanup.
    const resolved = await c.eval(`require('electron').ipcRenderer.invoke('session-reference:resolve',{sessionId:${j(fixture.SOURCE_HUB_ID)}})`);
    assert.equal(resolved.ok, true);
    const expected = buildReferenceText({ title: fixture.SOURCE_TITLE, kind: 'codex', path: resolved.path });
    fs.writeFileSync(copiedFile, expected, 'utf8');
    if (native) { evidence.backup = ps('backup', backupDir); backedUp = true; }
    await click(row(fixture.SOURCE_HUB_ID), 'right');
    check('会话右键菜单显示引用会话', await c.eval(`document.querySelector(${j(referenceButton)}).textContent==='引用会话'`));
    await shot('01-context-menu');
    await click(referenceButton);
    await wait("document.getElementById('gc-fork-toast')?.textContent.includes('已复制会话引用')");
    assert.equal((await readClipboard()).replace(/\r\n/g, '\n'), expected);
    check('剪贴板与输入框引用使用完全相同格式', true);
    assert.deepEqual(await c.eval(`({active:activeSessionId,status:sessions.get(${j(fixture.SOURCE_HUB_ID)}).status})`), sourceBefore);
    check('引用不切换当前会话、不唤醒休眠来源', true);
    const md = fs.readFileSync(resolved.path, 'utf8');
    check('引用路径存在，包含来源会话的问题和回答', md.includes('REFERENCE_QUESTION_MARKER') && md.includes('REFERENCE_ANSWER_MARKER'));

    await click(row(targetId));
    await wait(`activeSessionId===${j(targetId)} && !!document.querySelector('.floating-input-box')`);
    await click('.floating-input-box');
    const draft = '请基于下面引用继续分析：\n';
    await c.send('Input.insertText', { text: draft });
    if (native) {
      for (const type of ['keyDown', 'keyUp']) {
        await c.send('Input.dispatchKeyEvent', { type, key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 });
      }
    } else {
      await c.eval(`(() => {
        const data=new DataTransfer();data.setData('text/plain',require('electron').clipboard.readText());
        document.querySelector('.floating-input-box').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
      })()`);
    }
    await wait("readContenteditablePlainText(document.querySelector('.floating-input-box')).includes('【引用会话】')");
    const pasted = await readInput();
    check(native ? '真实 Ctrl+V 将引用粘贴进目标会话，并保留草稿' : '粘贴事件将引用放入目标会话，并保留草稿', pasted === draft + expected);
    check('复制和粘贴均不会自动发送', (await c.eval('window.__referenceSends.length')) === 0);
    await shot('02-pasted-reference');
    restoreClipboard();

    if (!native) {
      await click(row(fixture.SOURCE_HUB_ID), 'right'); await click(referenceButton);
      await wait("document.getElementById('gc-fork-toast')?.textContent.includes('已复制会话引用')");
      check('当前草稿不被再次引用覆盖', (await readInput()) === pasted);
      await click(row(emptyId), 'right'); await click(referenceButton);
      await wait("document.querySelector('.hub-dialog')?.textContent.includes('没有可读取的聊天记录')");
      check('没有记录时提示失败，保留原剪贴板与草稿', (await readClipboard()) === expected && (await readInput()) === pasted);
      await click('.hub-dialog-actions .hub-button-primary');
      await c.eval(`(() => {const clip=require('electron').clipboard;window.__referenceOriginalWrite=clip.writeText;
        clip.writeText=()=>{throw Error('clipboard busy')};})()`);
      await click(row(fixture.SOURCE_HUB_ID), 'right'); await click(referenceButton);
      await wait("document.querySelector('.hub-dialog')?.textContent.includes('剪贴板暂时不可用')");
      check('剪贴板写入失败不会误报成功', await c.eval("!document.getElementById('gc-fork-toast')?.textContent.includes('已复制')"));
      await c.eval("require('electron').clipboard.writeText=window.__referenceOriginalWrite");
      await click('.hub-dialog-actions .hub-button-primary');
    }
    await click('.floating-input-send');
    const sends = await wait('window.__referenceSends.length && window.__referenceSends');
    assert.equal(sends.length, 1);
    check('点击发送后完整引用经过真实提交管道送到 CLI 夹具', JSON.stringify(sends[0].args).includes(resolved.path.replace(/\\/g, '\\\\'))
      && sends[0].result?.ok === true);
    evidence.delivery = sends[0].result;
    evidence.passed = true;
  } catch (error) {
    evidence.error = error.stack; process.exitCode = 1;
    if (error.logTail) evidence.logTail = error.logTail;
    if (c) await shot('failure').catch(() => {});
  } finally {
    try { restoreClipboard(); } catch (error) { evidence.restoreError = String(error); process.exitCode = 1; }
    if (c) await c.close().catch(() => {});
    if (hub) await gracefulQuit(hub);
    fs.writeFileSync(path.join(out, '20261014-sidebar-reference-evidence-codex1.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
    console.log('Evidence: ' + out);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
