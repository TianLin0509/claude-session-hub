'use strict';
// Real isolated Electron UI + real config/export/create IPC. CLI execution uses
// fixture commands; no cloud answer quality or provider acceptance is claimed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./e2e-session-reference-cdp');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const baseline = process.argv.includes('--baseline');
const out = path.resolve('output/playwright/group-session-parity', baseline ? 'baseline' : 'candidate');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  fixture.writeFakeCli(); fixture.writeFixtures(); fs.mkdirSync(out, { recursive: true });
  const configPath = path.join(fixture.DATA_DIR, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.models = { defaults: { claude: 'claude-opus-5-5[1m]', codex: 'gpt-5.5' } };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const claudeConfig = path.join(fixture.TEMP_ROOT, 'claude-config');
  fs.mkdirSync(claudeConfig, { recursive: true });
  fs.writeFileSync(path.join(claudeConfig, '.claude.json'), JSON.stringify({
    additionalModelOptionsCache: [{ id: 'claude-opus-5-5[1m]' }],
  }));
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path';
  const evidence = { baseline, checks: [], boundaries: '真实隔离界面和 IPC，CLI 为夹具；未调用云端模型。' };
  let hub, c;
  const check = (label, value) => { assert(value, label); evidence.checks.push(label); console.log('PASS ' + label); };
  try {
    hub = await launchIsolatedHub({ dataDir: fixture.DATA_DIR, port: await fixture.reservePort(),
      ...(baseline ? { entryPath: 'C:/Users/lintian/claude-session-hub' } : {}),
      extraEnv: {
        [pathKey]: `${fixture.FAKE_BIN_DIR}${path.delimiter}${process.env[pathKey] || ''}`,
        CLAUDE_CONFIG_DIR: claudeConfig, CODEX_HOME: fixture.CODEX_HOME,
        AI_HUB_WORKSPACE_ROOT: fixture.WORK_DIR,
        HUB_CLAUDE_BACKEND: 'subscription', HUB_CODEX_BACKEND: 'subscription', HUB_CODEX_PROFILE: 'e2e',
        HUB_SESSION_SEARCH_CLAUDE_ROOTS: fixture.CLAUDE_ROOT, HUB_SESSION_SEARCH_CODEX_ROOTS: fixture.CODEX_ROOT,
      } });
    c = await connectFirstPage(hub, t => /index\.html/.test(t.url));
    const wait = async (expression, label) => {
      for (let i = 0; i < 200; i++) { const v = await c.eval(expression); if (v) return v; await sleep(100); }
      throw Error('Timeout: ' + label);
    };
    const click = async selector => {
      const point = await c.eval(`(() => {const e=document.querySelector(${JSON.stringify(selector)});
        if(!e)throw Error('Missing element');e.scrollIntoView({block:'nearest',inline:'nearest'});
        const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
        if(!r.width||!r.height||!e.contains(document.elementFromPoint(x,y)))throw Error('Covered: '+${JSON.stringify(selector)});
        return {x,y};})()`);
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    };
    const choose = (selector, value) => c.eval(`(() => {const s=document.querySelector(${JSON.stringify(selector)});
      s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    const shot = async name => {
      const image = await c.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(image.data, 'base64'));
    };
    await wait('!!window.WorkspaceController && !!window.MeetingRoom', 'renderer ready');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });
    if (baseline) await c.eval('WorkspaceController.loadPrimaryModelCatalogs()');
    await c.eval('WorkspaceController.openNewSessionModal({kind:"claude"})');
    await wait('document.querySelector("#new-session-model")?.value === "claude-opus-5-5[1m]"', 'ordinary default');
    check('普通 Session 默认 Opus 5.5（1M）', true);
    await c.eval('WorkspaceController.closeNewSessionModal();openMeetingCreateModal("group")');
    const model = '.mcm-slot[data-slot="0"] .mcm-model-select';
    await sleep(900);
    const value = await c.eval(`document.querySelector(${JSON.stringify(model)}).value`);
    if (baseline) {
      evidence.ordinary = 'claude-opus-5-5[1m]'; evidence.group = value;
      check('复现：群聊错误预选出厂 Opus 5', value === 'claude-opus-5[1m]');
      await shot('default-mismatch'); return;
    }
    check('群聊初始 Claude 成员默认与普通会话一致', value === 'claude-opus-5-5[1m]');
    check('Codex 同样读取独立默认值', await c.eval('document.querySelector(".mcm-slot[data-slot=\\\"1\\\"] .mcm-model-select").value === "gpt-5.5"'));
    await choose('.mcm-slot[data-slot="0"] .mcm-ai-select', 'codex');
    await choose('.mcm-slot[data-slot="0"] .mcm-ai-select', 'claude');
    check('切换 AI 类型后仍使用该类型默认模型', await c.eval(`document.querySelector(${JSON.stringify(model)}).value === 'claude-opus-5-5[1m]'`));
    await click('#mcm-add-member');
    await choose('.mcm-slot[data-slot="2"] .mcm-ai-select', 'claude');
    check('新增 Claude 成员读取相同默认模型', await c.eval('document.querySelector(".mcm-slot[data-slot=\\\"2\\\"] .mcm-model-select").value === "claude-opus-5-5[1m]"'));
    await click('[data-remove-member="2"]');
    // Delay actual config reads to exercise a user edit during async hydration.
    await c.eval(`(() => { const ipc=require('electron').ipcRenderer, invoke=ipc.invoke.bind(ipc);
      window.__created=[];window.__submitted=[];window.__delayConfig=true;
      ipc.invoke=async(channel,...args)=>{
        if(channel==='get-hub-config'&&window.__delayConfig)await new Promise(r=>setTimeout(r,700));
        if(channel==='session-reference:resolve'&&window.__delayReference)await new Promise(r=>setTimeout(r,700));
        if(channel==='groupchat:turn'){window.__submitted.push(args[0]);return {ok:true};}
        const result=await invoke(channel,...args);
        if(channel==='create-meeting')window.__created.push({request:args[0],result});
        return result;
      };
      closeMeetingCreateModal();openMeetingCreateModal('group'); })()`);
    await choose(model, 'claude-sonnet-5');
    await sleep(1000);
    check('异步读取配置保留手选模型', await c.eval(`document.querySelector(${JSON.stringify(model)}).value === 'claude-sonnet-5'`));
    await c.eval('window.__delayConfig=false;closeMeetingCreateModal();openMeetingCreateModal("group")');
    await wait(`document.querySelector(${JSON.stringify(model)}).value === 'claude-opus-5-5[1m]'`, 'reopen default');
    await shot('models');
    await click('[data-mcm-scene="general"]');
    await click('[data-mcm-workspace-mode="scratch"]');
    await click('.mcm-create');
    await wait('window.__created.length === 1', 'real group creation');
    const created = await c.eval('window.__created[0]');
    evidence.creation = created.request;
    check('真实创建请求发送 Opus 5.5 而非旧默认', created.request.slots[0].model === 'claude-opus-5-5[1m]');
    const id = created.result.id;
    await wait(`MeetingRoom.getActiveMeetingId() === ${JSON.stringify(id)}`, 'room visible');
    await wait('!!document.querySelector("#mr-input-tuning .fi-bridge-reference")', 'group toolbar');
    check('成员实际模型状态也是 Opus 5.5', await c.eval(`sessions.get(${JSON.stringify(created.result.subSessions[0])}).currentModel.id === 'claude-opus-5-5[1m]'`));
    await click('#mr-btn-add-sub');
    await click('#mr-add-sub-menu [data-add-kind="claude"]');
    await wait('document.querySelectorAll(".mr-input-member-tuning").length === 3', 'added member');
    check('建群后的新增 Claude 成员也使用 Opus 5.5', await c.eval(`Array.from(sessions.values()).filter(s=>s.meetingId===${JSON.stringify(id)} && s.kind==='claude').every(s=>s.currentModel.id==='claude-opus-5-5[1m]')`));
    await shot('toolbar');
    const input = '#mr-input-box';
    await click(input); await c.send('Input.insertText', { text: '原有草稿\n' });
    await click('#mr-input-tuning .fi-bridge-reference');
    await wait('!!document.querySelector("#gc-fork-picker")', 'reference picker');
    await shot('reference-picker');
    await click(`#gc-fork-picker [data-gc-picker-row="${fixture.SOURCE_HUB_ID}"]`);
    const inserted = await wait('document.querySelector("#mr-input-box").innerText.includes("【引用会话】") && document.querySelector("#mr-input-box").innerText', 'reference inserted');
    const mdPath = inserted.match(/聊天记录：(.+?\.md)/)?.[1];
    check('引用追加到已有草稿并导出真实会话正文', inserted.startsWith('原有草稿') && !!mdPath && fs.readFileSync(mdPath, 'utf8').includes('REFERENCE_ANSWER_MARKER'));
    check('引用不会自动发送', await c.eval('window.__submitted.length === 0'));
    await click('.mr-composer-expand');
    await wait('!!document.querySelector("#mr-input-editor-textarea")', 'expanded editor');
    check('展开编辑带入引用和原有草稿', await c.eval('document.querySelector("#mr-input-editor-textarea").value.includes("【引用会话】")'));
    await click('#mr-input-editor-textarea');
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, modifiers: 2 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35, modifiers: 2 });
    await c.send('Input.insertText', { text: '\n展开补充 ' });
    await click('#mr-input-editor-overlay [data-action="apply"]');
    const attachment = path.join(fixture.WORK_DIR, '带 空格的文件.md'); fs.writeFileSync(attachment, '拖入测试');
    const point = await c.eval(`(()=>{const r=document.querySelector('${input}').getBoundingClientRect();return {x:r.x+40,y:r.y+20};})()`);
    for (const type of ['dragEnter', 'dragOver', 'drop']) await c.send('Input.dispatchDragEvent', {
      type, ...point, data: { items: [], files: [attachment], dragOperationsMask: 1 },
    });
    await wait(`document.querySelector('${input}').innerText.includes(${JSON.stringify(attachment)})`, 'native file drop');
    check('真实文件拖入保留中文和空格路径', true);
    const draft = await c.eval(`document.querySelector('${input}').innerText`);
    await c.eval(`selectSession(${JSON.stringify(fixture.SOURCE_HUB_ID)})`);
    await c.eval(`selectMeeting(${JSON.stringify(id)})`);
    check('切走再回来保留草稿、引用和附件路径', (await c.eval(`document.querySelector('${input}').innerText`)) === draft);
    // Resolve pending while leaving the room must not write to a reused composer.
    await c.eval('window.__delayReference=true');
    await click('#mr-input-tuning .fi-bridge-reference');
    await click(`#gc-fork-picker [data-gc-picker-row="${fixture.SOURCE_HUB_ID}"]`);
    await c.eval(`selectSession(${JSON.stringify(fixture.SOURCE_HUB_ID)})`);
    await sleep(1000); await c.eval(`selectMeeting(${JSON.stringify(id)})`);
    check('引用处理中切换页面不会误写草稿', (await c.eval(`document.querySelector('${input}').innerText`)) === draft);
    await click('#mr-send-btn');
    await wait('window.__submitted.length === 1', 'send boundary');
    evidence.submitted = await c.eval('window.__submitted[0]');
    check('群聊发送边界收到引用路径与附件', JSON.stringify(evidence.submitted).includes(mdPath.replaceAll('\\','\\\\')) && JSON.stringify(evidence.submitted).includes('带 空格的文件.md'));
    await click('.mr-composer-history');
    await wait('!!document.querySelector(".mr-input-history-item")', 'recent input');
    await click('.mr-input-history-item');
    check('最近输入能恢复刚才的完整消息', (await c.eval(`document.querySelector('${input}').innerText`)).includes('【引用会话】'));
    await click('.mr-composer-expand');
    await click('#mr-input-editor-textarea');
    await c.send('Input.insertText', { text: '切换前的编辑' });
    const edited = await c.eval('document.querySelector("#mr-input-editor-textarea").value');
    await c.eval(`selectSession(${JSON.stringify(fixture.SOURCE_HUB_ID)})`);
    check('切换页面关闭展开编辑器', await c.eval('!document.querySelector("#mr-input-editor-overlay")'));
    await c.eval(`selectMeeting(${JSON.stringify(id)})`);
    check('展开编辑中的修改随切换保存回原群草稿', (await c.eval(`document.querySelector('${input}').innerText`)).trim() === edited.trim());
    await shot('complete');
    evidence.ok = true;
  } catch (error) {
    evidence.ok = false; evidence.error = error.stack;
    if (c) { try { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out,'failure.png'),Buffer.from(s.data,'base64')); } catch {} }
    throw error;
  } finally {
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(evidence, null, 2));
    if (c) c.close(); if (hub) await gracefulQuit(hub);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
