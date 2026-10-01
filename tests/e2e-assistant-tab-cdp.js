'use strict';
// Real isolated Electron UI + backend. Model output is explicitly a native fixture.
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const number = server.address().port; server.close(() => resolve(number)); }); });
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-assistant-ui-'));
  const dataDir = path.join(root, 'data'), home = path.join(root, 'home');
  const out = path.resolve('artifacts/assistant-tab-cdp', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(dataDir, { recursive: true }); fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ providers: { codex: { backend: 'subscription', subscription_profile: 'second', subscription_profiles: [{ id: 'second', label: '主账号（隔离验证）', home: path.join(home, '.codex') }] } } }), 'utf8');
  const navigationOnly = process.argv.includes('--navigation-only');
  const result = { passed: false, mode: navigationOnly ? 'navigation-only' : 'native-fixture-flow', boundary: '真实隔离 Hub 界面与服务；模型回答为显式原生协议夹具，不代表真实模型质量', checks: [], root, out };
  let hub, cdp;
  const until = async (label, expression, timeout = 35000) => { for (const end = Date.now() + timeout; Date.now() < end;) { if (await cdp.eval(`Boolean(${expression})`)) return; await delay(120); } throw Error('timeout: ' + label); };
  const click = async selector => {
    await until('clickable ' + selector, `document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`);
    const point = await cdp.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  };
  const shot = async name => { const image = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(image.data, 'base64')); };
  try {
    hub = await launchIsolatedHub({ dataDir, port: await port(), label: 'assistant-tab', windowMode: 'background', extraEnv: {
      CLAUDE_HUB_HOME_DIR: home, CODEX_HOME: path.join(home, '.codex'), CODEX_SQLITE_HOME: '', CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      AI_HUB_WORKSPACE_ROOT: root, CLAUDE_HUB_AGENT_RUNTIME: 'native',
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.resolve('tests/fixtures/codex-app-server.js'),
      CLAUDE_HUB_NATIVE_FIXTURE_STORE: path.join(root, 'threads.json'),
      CLAUDE_HUB_NATIVE_FIXTURE_TRACE: path.join(root, 'trace.jsonl'),
      CLAUDE_HUB_FIXTURE_CONFIG_DIR: path.join(root, 'launch-config'),
      HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'empty'),
      HUB_SESSION_SEARCH_KIMI_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_GEMINI_ROOTS: path.join(root, 'empty'), DEEPSEEK_API_KEY: '',
    } });
    result.pid = hub.pid; cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until('renderer ready', 'typeof assistantPanel!=="undefined"');
    const before = await cdp.eval('sessions.size');
    await click('#btn-assistant');
    await until('overview rendered', '!!document.querySelector("[data-assistant-action=open]")');
    await until('overview finished', 'document.querySelector(".assistant-status").hidden || document.querySelector(".assistant-status").classList.contains("assistant-error")');
    assert.equal(await cdp.eval('sessions.size'), before);
    assert.equal(fs.existsSync(path.join(root, 'trace.jsonl')), false);
    await until('penguin loaded', 'document.querySelector(".assistant-hero img").naturalWidth===512');
    await shot('01-overview'); result.checks.push('打开助理 Tab 不创建会话、不发模型请求；企鹅本地素材加载');
    await click('#btn-home');
    assert.equal(await cdp.eval('document.getElementById("assistant-page").hidden'), true);
    await click('#btn-assistant'); await until('reopened', '!document.getElementById("assistant-page").hidden');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 960, deviceScaleFactor: 1, mobile: false });
    const fits = await cdp.eval('(()=>{const p=document.getElementById("assistant-page");return p.scrollWidth<=p.clientWidth+1})()');
    assert.equal(fits, true); await shot('02-narrow'); result.checks.push('导航互斥，800px 窄窗口无横向溢出');
    // Renderer-only failure/late-response fixtures, still operated by real mouse clicks.
    await cdp.eval(`window.__assistantOriginalInvoke=ipcRenderer.invoke;window.__assistantReadNumber=0;ipcRenderer.invoke=function(channel,...args){if(channel!=='assistant:get-overview')return window.__assistantOriginalInvoke.call(this,channel,...args);const number=++window.__assistantReadNumber;if(number===1)return Promise.reject(new Error('界面验收：记录暂不可用'));return new Promise(resolve=>setTimeout(()=>resolve({ok:true,summary:number===2?'过时的变化':'较新的变化 <b>按文字显示</b>',needsAttention:[],updatedAt:Date.now()}),number===2?350:10));};`);
    await click('[data-assistant-action="refresh"]');
    await until('read failure visible', 'document.querySelector(".assistant-status").textContent.includes("记录暂不可用")');
    await click('[data-assistant-action="refresh"]'); await click('[data-assistant-action="refresh"]');
    await until('latest read shown', 'document.querySelector(".assistant-content").textContent.includes("较新的变化")');
    await delay(400);
    assert.equal(await cdp.eval('document.querySelector(".assistant-content").textContent.includes("过时的变化")'), false);
    assert.equal(await cdp.eval('document.querySelector(".assistant-card b")'), null);
    await cdp.eval('ipcRenderer.invoke=window.__assistantOriginalInvoke;delete window.__assistantOriginalInvoke;');
    result.checks.push('界面故障夹具：读取失败可重试，旧请求不会覆盖新结果，正文按文字安全呈现');
    if (navigationOnly) { result.passed = true; return; }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await click('[data-question="progress"]');
    await until('ordinary input', 'activeSessionId && document.querySelector(".floating-input-box")?.textContent.includes("最近三小时")', 60000);
    const sessionId = await cdp.eval('activeSessionId'); result.sessionId = sessionId;
    const bar = `.floating-input-bar[data-session-id="${sessionId}"]`;
    assert.equal(await cdp.eval('document.getElementById("assistant-page").hidden'), true);
    const trace = () => fs.existsSync(path.join(root, 'trace.jsonl')) ? fs.readFileSync(path.join(root, 'trace.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    assert.equal(trace().filter(row => row.method === 'turn/start').length, 0);
    await shot('03-real-session-draft'); result.checks.push('快捷问题进入真实普通 session，草稿等待用户发送，不静默发问');
    await click(bar + ' .floating-input-send');
    await until('fixture answer', `sessions.get(${JSON.stringify(sessionId)})?.nativeRuntime?.state==='completed'`, 60000);
    assert.equal(trace().filter(row => row.method === 'turn/start').length, 1);
    const submitted = trace().find(row => row.method === 'turn/start');
    const submittedText = submitted.params.input.map(item => item.text || '').join('');
    assert.match(submittedText, /AI_HUB_ASSISTANT_CONTEXT_V1/); assert.match(submittedText, /"history":/);
    assert.match(submittedText, /最近三小时/); assert.match(submittedText, /requestToken/);
    assert.equal(path.resolve(submitted.fixtureHome), path.resolve(home, '.codex'));
    assert.equal(await cdp.eval(`sessions.get(${JSON.stringify(sessionId)}).purpose`), 'hub-assistant');
    assert.match(submittedText, /"manifestOnly":true/);
    result.checks.push('原生提交实含本轮请求与资料目录，purpose 保留，使用隔离配置中的主账号目录');
    await until('context collapsed', '!!document.querySelector(".assistant-turn-context")');
    assert.equal(await cdp.eval('document.querySelector(".assistant-turn-context").open'), false);
    const displayedUser = await cdp.eval('document.querySelector(".turn-card.user .turn-body").textContent');
    assert.match(displayedUser, /最近三小时/); assert.doesNotMatch(displayedUser, /AI_HUB_ASSISTANT_CONTEXT_V1|requestToken/);
    await click('.assistant-turn-context summary');
    assert.equal(await cdp.eval('document.querySelector(".assistant-turn-context").open'), true);
    assert.equal(await cdp.eval('document.querySelector(".assistant-turn-context pre").textContent'), submittedText);
    await shot('04-context-expanded'); await click('.assistant-turn-context summary');
    assert.doesNotMatch(await cdp.eval('document.querySelector(".question-directory-title").textContent'), /AI_HUB_ASSISTANT_CONTEXT_V1/);
    await click('.turn-card.user .card-actions-more'); await click('.turn-card.user [data-action="edit-resend"]');
    const editDraft = await cdp.eval(`document.querySelector(${JSON.stringify(bar + ' .floating-input-box')}).textContent`);
    assert.match(editDraft, /最近三小时/); assert.doesNotMatch(editDraft, /AI_HUB_ASSISTANT_CONTEXT_V1|requestToken/);
    await click(bar + ' .floating-input-box');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    result.checks.push('助理用户卡片默认只显示原话，本轮请求与资料目录可展开且与实际提交全文一致');
    result.checks.push('问题目录与编辑重发使用原话，不把旧上下文重新填进输入框');
    await shot('04-native-fixture-answer'); result.checks.push('点击普通发送按钮经过真实服务与原生夹具，产生一轮回答');
    await click(bar + ' .floating-input-box'); await cdp.send('Input.insertText', { text: '保留这份草稿' });
    await click('#btn-assistant'); await until('existing assistant', 'document.querySelector("[data-assistant-action=open]")?.textContent.includes("继续")');
    await click('[data-question="attention"]');
    await until('appended draft', 'document.querySelector(".floating-input-box")?.textContent.includes("需要我决定")');
    assert.equal(await cdp.eval('activeSessionId'), sessionId);
    assert.match(await cdp.eval('document.querySelector(".floating-input-box").textContent'), /保留这份草稿/);
    assert.equal(trace().filter(row => row.method === 'turn/start').length, 1);
    assert.equal(trace().filter(row => row.method === 'thread/start').length, 1);
    result.checks.push('再次进入仍是同一助理，建议问题保留并追加旧草稿，不重复发模型请求');
    await click('#btn-assistant'); await until('assistant reopen', '!document.getElementById("assistant-page").hidden');
    await cdp.eval(`window.__assistantOriginalInvoke=ipcRenderer.invoke;ipcRenderer.invoke=async function(channel,...args){const result=await window.__assistantOriginalInvoke.call(this,channel,...args);if(channel==='assistant:ensure-session')await new Promise(resolve=>setTimeout(resolve,350));return result;};`);
    await click('[data-assistant-action="open"]'); await click('#btn-home'); await delay(500);
    assert.equal(await cdp.eval('activeSessionId'), null);
    assert.equal(await cdp.eval('document.getElementById("assistant-page").hidden'), true);
    await cdp.eval('ipcRenderer.invoke=window.__assistantOriginalInvoke;delete window.__assistantOriginalInvoke;');
    result.checks.push('延迟返回夹具：打开助理途中切回工作台，迟到结果不会抢走页面');
    result.passed = true;
  } catch (error) { result.error = error.stack; if (cdp) await shot('failure').catch(() => {}); throw error; }
  finally {
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
    if (cdp) cdp.close(); if (hub) await gracefulQuit(hub);
    console.log(JSON.stringify(result, null, 2));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
