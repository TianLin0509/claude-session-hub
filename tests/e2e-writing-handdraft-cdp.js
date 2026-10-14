'use strict';
/**
 * 写作 Tab「田哥手写」真机 E2E（2026-10-15）：隔离 Hub，文章目录是真的（writing:article-create 建在临时写作根下），
 * 两位 AI 的稿用固定数据代替群聊（不调真实模型）。按田哥的操作路径走：
 *   标签栏最后一页「田哥手写」→ 左边打字、右边实时排版、停笔自动存成 手写稿.md → 轮询不打断输入
 *   → 到 Claude 的稿里选中一段「摘到手写稿」→ 到 Codex 的稿点「放进手写稿」→ 文件里都有
 *   → 文件在别处被改过：不覆盖，提示选版本 → 窄窗口上下排
 * 用法：node tests/e2e-writing-handdraft-cdp.js
 */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), j = JSON.stringify;
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-writing-hand-'));
  const out = path.resolve('artifacts', '20261015-writing-handdraft-' + Date.now()); fs.mkdirSync(out, { recursive: true });
  let hub, c;
  const evidence = { passed: false, checks: [], kind: 'isolated real Hub UI; real article dir + real handdraft IPC; AI drafts are fixtures' };
  const check = (label, value) => { assert(value, label); evidence.checks.push(label); console.log('PASS', label); };
  const wait = async (expr, label, ms = 20000) => { for (let i = 0; i < ms / 100; i++) { if (await c.eval(expr)) return; await sleep(100); } throw Error('Timeout ' + label); };
  const click = async (selector) => {
    const p = await c.eval(`(()=>{const e=document.querySelector(${j(selector)});e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
  };
  const clickText = async (selector, text) => {
    const p = await c.eval(`(()=>{const e=[...document.querySelectorAll(${j(selector)})].find(x=>x.textContent.trim()===${j(text)});e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
  };
  const type = async (text) => { await c.send('Input.insertText', { text }); };
  const key = async (k, code, vk) => { for (const t of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type: t, key: k, code, windowsVirtualKeyCode: vk }); };
  const shot = async (name) => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(r.data, 'base64')); };
  const handTab = `.wb-tab[data-key="__hand"]`;
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await freePort(), windowMode: 'hidden', extraEnv: { HUB_STARTUP_TRACE: '1', CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), CLAUDE_HUB_WRITING_ROOT: path.join(root, 'writing'), CLAUDE_HUB_WRITING_SKILLS_DIR: path.join(root, 'skills') } });
    c = await connectFirstPage(hub); let ready = false;
    c.ws.on('message', (msg) => { if (String(msg).includes('renderer-sidebar-ready sent')) ready = true; }); await c.send('Runtime.enable');
    for (let i = 0; !ready && i < 200; i++) await sleep(100); assert(ready, 'startup');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }); await sleep(400);
    await wait("typeof window.__writingShow==='function'", 'writing loaded');
    // 真文章目录：手写稿的读写走真实 IPC
    const dir = await c.eval(`ipcRenderer.invoke('writing:article-create').then(r=>r.dir)`);
    assert(dir && fs.existsSync(dir), 'article dir');
    const handFile = path.join(dir, '手写稿.md');
    await c.eval(`window.__handView={dir:${j(dir)},meetingId:'fixture-meeting',title:'多智能体涌现',idea:'Agent 自己绕开了我的工作流',latestTurn:1,steps:{idea:true,draft:true},questions:[],
      columns:['Claude','Codex'].map((name,i)=>({sid:i?'writer-b':'writer-a',name,status:'done',items:[{kind:'draft',version:1,chars:300,title:name+' 的文章',
        text:'# '+name+' 的文章\\n\\n'+name+'的开头：工作流约束的是议程，不是通道。\\n\\n'+name+'的第二段：它先决定找人，再去找电话。'}]}))};
      meetings['fixture-meeting']={id:'fixture-meeting',subSessions:['writer-a','writer-b']};
      const original=ipcRenderer.invoke.bind(ipcRenderer);ipcRenderer.invoke=async(channel,...args)=>{
        if(channel==='writing:article-list')return {ok:true,articles:[{dir:__handView.dir,meetingId:'fixture-meeting',title:__handView.title,createdAt:Date.now(),drafts:[{},{}]}]};
        if(channel==='writing:article-view')return {ok:true,view:JSON.parse(JSON.stringify(__handView))};
        return original(channel,...args);
      };`);
    await click('#btn-writing'); await wait("!!document.querySelector('.wb-panel .wr-paper')", 'article');
    await wait(`(document.querySelector(${j(handTab + ' .wb-tab-sub')})||{}).textContent==='还没写'`, 'hand tab ready');
    check('标签栏最后一页是「田哥手写」，显示「还没写」', await c.eval(`(()=>{const t=[...document.querySelectorAll('.wb-tab')];return t[t.length-1].dataset.key==='__hand'&&t[t.length-1].innerText.includes('田哥手写');})()`));
    check('默认仍打开 AI 的稿', await c.eval(`document.querySelector('.wb-tab.on').dataset.key==='writer-a'`));
    await shot('01-AI稿与手写标签');

    await click(handTab); await wait("!!document.querySelector('.wb-hand-input')", 'hand panel');
    const geo = await c.eval(`(()=>{const a=document.querySelector('.wb-hand-input').getBoundingClientRect(),b=document.querySelector('.wb-hand-preview').getBoundingClientRect();return{aw:a.width,bw:b.width,ah:a.height,sameRow:Math.abs(a.top-b.top)<40,leftFirst:a.left<b.left};})()`);
    evidence.geometry = geo;
    check('左编辑、右预览并排，各占一半以上宽度', geo.sameRow && geo.leftFirst && geo.aw > 500 && geo.bw > 500 && geo.ah > 400);
    check('编辑区和预览区完整露出，不被底部点评框盖住', await c.eval(`(()=>{const b=document.querySelector('.wb-basket').getBoundingClientRect().top;return document.querySelector('.wb-hand-input').getBoundingClientRect().bottom<=b&&document.querySelector('.wb-hand-preview').getBoundingClientRect().bottom<=b;})()`));
    await click('.wb-hand-input');
    await type('# 我的一稿'); await type('\n\n');
    await type('工作流约束的是**议程**，不是通道。');
    await wait(`!!document.querySelector('.wb-hand-preview h1')&&!!document.querySelector('.wb-hand-preview strong')`, 'preview');
    check('右边实时排版：标题与加粗', await c.eval(`document.querySelector('.wb-hand-preview h1').textContent==='我的一稿'&&document.querySelector('.wb-hand-preview strong').textContent==='议程'`));
    await wait(`document.querySelector('.wb-hand-status').textContent.includes('已自动保存')`, 'autosave');
    check('停笔自动保存成文章目录的 手写稿.md', fs.readFileSync(handFile, 'utf8') === '# 我的一稿\n\n工作流约束的是**议程**，不是通道。');
    check('标签上显示字数', await c.eval(`/\\d+ 字/.test(document.querySelector(${j(handTab + ' .wb-tab-sub')}).textContent)`));
    await type('继续写'); await sleep(3600);
    check('3 秒轮询之后仍在编辑：内容、焦点都在', await c.eval(`document.activeElement===document.querySelector('.wb-hand-input')&&document.querySelector('.wb-hand-input').value.endsWith('继续写')`));
    await shot('02-手写页-左写右看');

    // 到 Claude 的稿里选中第二段，摘过来
    await click('.wb-tab[data-key="writer-a"]'); await wait("!!document.querySelector('.wb-panel .wr-paper p')", 'claude paper');
    check('切走时把没存的内容存上', await (async () => { await sleep(300); return fs.readFileSync(handFile, 'utf8').endsWith('继续写'); })());
    await c.eval(`(()=>{const p=[...document.querySelectorAll('.wb-panel .wr-paper p')][1];const r=document.createRange();r.selectNodeContents(p);const s=getSelection();s.removeAllRanges();s.addRange(r);p.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));})()`);
    await wait("!!document.querySelector('.wb-sel-btns')", 'selection buttons');
    check('选中文字后出现「点评这段」和「摘到手写稿」', await c.eval(`[...document.querySelectorAll('.wb-sel-btns button')].map(b=>b.textContent).join('|')==='点评这段|摘到手写稿'`));
    await shot('03-选中后两个按钮');
    await clickText('.wb-sel-btns button', '摘到手写稿');
    await wait(`!document.querySelector('.wb-sel-btns')`, 'buttons gone');
    for (let i = 0; i < 40 && !fs.readFileSync(handFile, 'utf8').includes('Claude的第二段'); i++) await sleep(100);
    check('摘录接在手写稿末尾、空一行', fs.readFileSync(handFile, 'utf8').endsWith('继续写\n\nClaude的第二段：它先决定找人，再去找电话。\n'));

    await click('.wb-tab[data-key="writer-b"]'); await wait(`document.querySelector('.wb-panel').dataset.col==='writer-b'`, 'codex tab');
    await clickText('.wb-panel-bar button', '放进手写稿');
    for (let i = 0; i < 40 && !fs.readFileSync(handFile, 'utf8').includes('# Codex 的文章'); i++) await sleep(100);
    check('「放进手写稿」把整篇 Markdown 接到末尾', fs.readFileSync(handFile, 'utf8').includes('\n\n# Codex 的文章\n\nCodex的开头'));

    await click(handTab); await wait("!!document.querySelector('.wb-hand-input')", 'hand again');
    check('回到手写页，摘来的内容都在编辑器里', await c.eval(`(()=>{const v=document.querySelector('.wb-hand-input').value;return v.includes('Claude的第二段')&&v.includes('# Codex 的文章');})()`));
    await shot('04-摘录后的手写稿');

    // 文件在别处被改过：不覆盖
    fs.writeFileSync(handFile, '# 在 Typora 里改的', 'utf8');
    await click('.wb-hand-input'); await key('End', 'End', 35); await type('再补一句');
    await wait(`!document.querySelector('.wb-hand-conflict').hidden`, 'conflict');
    check('文件在别处被改过：不覆盖，提示选版本', fs.readFileSync(handFile, 'utf8') === '# 在 Typora 里改的');
    await shot('05-冲突提示');
    await clickText('.wb-hand-conflict button', '用文件里的版本');
    check('选「用文件里的版本」后编辑器换成文件内容', await c.eval(`document.querySelector('.wb-hand-input').value==='# 在 Typora 里改的'&&document.querySelector('.wb-hand-conflict').hidden`));
    await click('.wb-hand-input'); await key('End', 'End', 35); await type('，接着写');
    await wait(`document.querySelector('.wb-hand-status').textContent.includes('已自动保存')`, 'save after conflict');
    check('之后照常自动保存', fs.readFileSync(handFile, 'utf8') === '# 在 Typora 里改的，接着写');

    await c.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 800, deviceScaleFactor: 1, mobile: false }); await sleep(600);
    check('窄窗口改成上下排', await c.eval(`(()=>{const a=document.querySelector('.wb-hand-input').getBoundingClientRect(),b=document.querySelector('.wb-hand-preview').getBoundingClientRect();return b.top>a.bottom-5&&a.width>600;})()`));
    await shot('06-窄窗口');
    evidence.passed = true;
  } catch (e) { evidence.error = e.stack; if (c) await shot('failure').catch(() => {}); throw e; }
  finally { if (c) await c.close(); if (hub) { fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n')); await gracefulQuit(hub); } fs.writeFileSync(path.join(out, 'checks.json'), JSON.stringify(evidence, null, 2)); console.log('ARTIFACT_ROOT', out); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
