'use strict';
/**
 * 写作 Tab 真机 E2E：隔离 Hub + 模拟真人操作，全程只在写作 Tab 里写一篇文章，不打开群聊（2026-10-03 版）。
 *
 *   写作台  没有文章时直接是「新文章」输入框 → 写中心思想、点「开始写」（后台建写作群并发出，真实调用两位 Claude haiku）
 *           → 文风作为常驻指令装进成员（文章目录 AGENTS.md，Claude 带 --append-system-prompt-file）
 *           → 每位 AI 一个标签页，文章排版显示（文章放在两行标记之间，Hub 存成 drafts/Claude-1-v1.md）；
 *             切标签、切「并排对比」再切回
 *           → 问题卡：改答案、发给大家 → 出现 v2
 *           → 在稿里用鼠标划一段、点「点评这段」写意见 → 点评篮 → 「汇总定稿」→ 定稿置顶、存成 final.md
 *           → 后台自动优化文风；「在群聊里看过程」能打开后台群聊
 *   文风    带行号展示源文件；手动编辑保存；变更记录里看得到 AI 自动优化与手动修改
 *   作品库  定稿以「新作」出现；只读
 *
 * 数据：文章库与文风 skill 复制到临时目录再测，不碰真实文件。写作群放两位 Claude（haiku）：标签页要有得切，又省额度。
 * 用法：node tests/e2e-writing-tab-cdp.js [--out <截图目录>]
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }

const REAL_ARTICLES = 'C:\\AIWork\\20260926-写作工坊\\田哥材料\\文章';
const REAL_SKILLS = path.join(os.homedir(), '.codex', 'skills');

// 不用 fs.cpSync：Node 24 复制这批带中文与全角符号文件名的文章时会整个进程静默退出（退出码 127，
// 2026-09-30 实测，无报错无调用栈）。逐个文件复制没有这个问题。
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
    else if (e.isSymbolicLink()) { const real = fs.realpathSync(s); if (fs.statSync(real).isDirectory()) copyTree(real, d); else fs.copyFileSync(real, d); }
  }
}

async function main() {
  const outArg = process.argv.indexOf('--out');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-writing-e2e-'));
  const data = path.join(root, 'data');
  const home = path.join(root, 'home');
  const writingRoot = path.join(root, 'writing');
  const out = outArg > 0 ? path.resolve(process.argv[outArg + 1]) : path.join(root, 'shots');
  for (const p of [data, home, writingRoot, out]) fs.mkdirSync(p, { recursive: true });
  copyTree(REAL_ARTICLES, path.join(writingRoot, '田哥材料', '文章'));
  const skills = path.join(home, '.codex', 'skills');
  copyTree(path.join(REAL_SKILLS, 'tiange-voice'), path.join(skills, 'tiange-voice'));
  copyTree(path.join(REAL_SKILLS, 'chinese-tech-writing', 'references'), path.join(skills, 'chinese-tech-writing', 'references'));
  const voiceDir = path.join(skills, 'tiange-voice');
  const piecesRoot = path.join(writingRoot, '写作台');

  const entry = path.join(root, 'writing-test-entry.cjs');
  fs.writeFileSync(entry, `require(${JSON.stringify(path.resolve('main-bootstrap.js'))});
const {app,ipcMain}=require('electron');
app.on('browser-window-created',(_e,win)=>win.webContents.setBackgroundThrottling(false));
ipcMain.handle('test:writing-capture',async e=>{await e.sender.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');return (await e.sender.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64');});
`);

  const result = { root, out, checks: [], passed: false };
  const check = (name, ok, detail) => { result.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`); assert.ok(ok, name); };
  let hub; let cdp;
  const until = async (expr, label, ms = 35000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await cdp.eval(`Boolean(${expr})`)) return; await sleep(300); }
    throw new Error('timeout: ' + label);
  };
  const untilFs = async (fn, label, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(1000); } throw new Error('timeout: ' + label); };
  const btnExpr = (scope, text) => `[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled&&b.offsetParent)`;
  const clickText = async (text, scope = '#writing-panel', ms) => {
    await until(btnExpr(scope, text), 'button ' + text, ms);
    await cdp.eval(`${btnExpr(scope, text)}.click()`);
  };
  // 截图只是留证据：后台窗口偶发 UnknownVizError（2026-10-01 实测），截不到就记一笔，不让功能断言跟着失败
  const snap = async (name) => {
    await sleep(500);
    try { const b64 = await cdp.eval('ipcRenderer.invoke("test:writing-capture")'); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(b64, 'base64')); return; }
    catch (e) { (result.snapErrors = result.snapErrors || []).push(`${name}: ${String(e.message || e).slice(0, 120)}`); }
    // 主进程截图不行时退到 CDP 自己的截图（清瓷白 E2E 用的就是这条）
    try { const s = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(s.data, 'base64')); }
    catch (e) { console.log(`    （截图 ${name} 没截到：${String(e.message || e).slice(0, 80)}）`); }
  };
  // 真实键盘输入：聚焦、全选，再插入文字
  const typeInto = async (selector, text) => {
    await until(`document.querySelector(${JSON.stringify(selector)})`, 'input ' + selector);
    await cdp.eval(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    await cdp.send('Input.insertText', { text });
    await sleep(200);
  };
  const meetingPanelHidden = () => cdp.eval('(()=>{const p=document.getElementById("meeting-room-panel");return !p||getComputedStyle(p).display==="none";})()');
  const pieceDir = () => { try { return fs.readdirSync(piecesRoot).map((n) => path.join(piecesRoot, n)).find((d) => fs.existsSync(path.join(d, 'piece.json'))); } catch { return null; } };
  const groupState = (id) => { try { return JSON.parse(fs.readFileSync(path.join(data, 'arena-prompts', `${id}-groupchat.json`), 'utf8')); } catch { return null; } };
  const userSaid = (id) => ((groupState(id) || {}).messages || []).filter((m) => m.role === 'user' && m.origin === 'user').map((m) => String(m.content));

  try {
    hub = await launchIsolatedHub({
      dataDir: data, port: await freePort(), windowMode: 'hidden', entryPath: entry, label: 'writing-tab',
      extraEnv: {
        CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_WRITING_ROOT: writingRoot,
        CLAUDE_HUB_WRITING_MEMBERS: 'claude:haiku,claude:haiku', CLAUDE_HUB_WRITING_EVOLVE_MODEL: 'haiku', CLAUDE_HUB_WRITING_CLAUDE_MODEL: 'haiku',
        CLAUDE_HUB_WRITING_EVOLVE_SETTLE_MS: '0', // 真实使用时定稿稳定两分钟才优化，测试不等
      },
    });
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until('!!document.getElementById("btn-writing")', 'rail button');
    await until('typeof window.__writingShow === "function"', 'writing.js loaded');
    check('左侧导航：写作紧挨在账号下方', await cdp.eval('document.getElementById("btn-rail-accounts").nextElementSibling.id') === 'btn-writing');

    // ① 新文章：在 Tab 里写中心思想，点「开始写」
    await cdp.eval('document.getElementById("btn-writing").click()');
    await until('document.querySelector("#wr-view-studio.active .wb-compose-text")', 'composer', 30000);
    check('还没有文章时，写作台直接是新文章输入框', true);
    await typeInto('.wb-compose-text', '中心思想：同一个模型多开几个分身互相审稿，并不能像多根独立天线那样带来分集增益，因为它们的错误高度相关。读者是懂 AI、不懂无线的算法工程师。请写一篇 300 字左右的短文。（这次是测试：请务必在「想问田哥」里问我一个问题。）');
    await snap('01-新文章');
    await clickText('开始写');
    await until('document.querySelector(".wb .wb-title")', 'workbench mounted', 90000);
    const meeting = await cdp.eval('ipcRenderer.invoke("get-meetings").then(ms=>ms.find(m=>m.scene==="writing"))');
    check('后台建好写作场景群聊', !!meeting && meeting.scene === 'writing', meeting && meeting.id);
    check('不跳到群聊：群聊面板没打开，写作 Tab 还在', await meetingPanelHidden() && await cdp.eval('document.getElementById("writing-panel").style.display!=="none"'));
    const dir = pieceDir();
    check('群聊工作目录就是这篇文章的目录，并记下了群聊 id', dir && path.resolve(meeting.workspace || '') === path.resolve(dir) && JSON.parse(fs.readFileSync(path.join(dir, 'piece.json'), 'utf8')).meetingId === meeting.id);
    const members = await cdp.eval(`ipcRenderer.invoke("get-sessions").then(ss=>ss.filter(s=>s.meetingId===${JSON.stringify(meeting.id)}).map(s=>({kind:s.kind,purpose:s.purpose})))`);
    check('写作群成员标记为 purpose=writing', members.length === 2 && members.every((m) => m.purpose === 'writing'), JSON.stringify(members));
    const pack = path.join(dir, 'AGENTS.md');
    check('文风写成文章目录的 AGENTS.md（Codex 自动加载）', fs.existsSync(pack) && fs.readFileSync(pack, 'utf8').includes('田哥文风') && fs.readFileSync(pack, 'utf8').includes('起草指南'));
    // Claude 成员的真实启动命令行里要带上这份文件
    const cmdlines = await untilFs(() => {
      try {
        const outp = execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name like 'claude%' or Name like 'node%'\" | ForEach-Object { $_.CommandLine }"], { encoding: 'utf8', windowsHide: true });
        const hits = outp.split(/\r?\n/).filter((l) => l.includes('--append-system-prompt-file') && l.includes(path.basename(dir)));
        return hits.length >= 2 ? hits : null;
      } catch { return null; }
    }, 'claude cmdline with voice pack', 60000).catch(() => []);
    check('两位 Claude 启动时都带 --append-system-prompt-file 指向文风包', cmdlines.length >= 2, `${cmdlines.length} 个进程`);
    await untilFs(() => userSaid(meeting.id).some((t) => t.includes('分集增益')), 'idea sent to group', 60000);
    check('中心思想由 Tab 替你发进了群', true);

    // ② 初稿出现在标签页里（真实调用 Claude haiku）
    await until('document.querySelectorAll(".wb-tabbar .wb-tab").length===2', 'two tabs', 60000);
    check('每位 AI 一个标签页', JSON.stringify(await cdp.eval('[...document.querySelectorAll(".wb-tab .wb-tab-name")].map(x=>x.textContent)')) === JSON.stringify(['Claude 1', 'Claude 2']));
    await until('document.querySelector(".wb-panel .wb-panel-body .wr-paper")', 'draft panel', 300000);
    const v1File = await untilFs(() => fs.existsSync(path.join(dir, 'drafts', 'Claude-1-v1.md')) && 'Claude-1-v1.md', 'draft materialized', 30000);
    const draftText = fs.readFileSync(path.join(dir, 'drafts', v1File), 'utf8');
    const marked = /文章开始/.test((groupState(meeting.id).messages || []).filter((m) => m.role === 'assistant' && m.speaker === 'Claude 1').map((m) => m.content).join('\n'));
    result.formatFollowed = { v1: marked };
    check('交稿存成 drafts/Claude-1-v1.md，只有文章本身', /^#\s+\S/.test(draftText) && !/文章开始|文章结束|## 给田哥|## 想问田哥/.test(draftText), `${draftText.split('\n')[0]}（${marked ? '用了文章标记' : '没加标记，按稿件收下'}）`);
    check('标签页显示排版好的文章，不是「没找到文章」的原样回复', await cdp.eval('!document.querySelector(".wb-panel .wb-hint.warn") && !!document.querySelector(".wb-panel .wr-paper h1")'));
    // 切到第二位、并排对比、再切回
    await until('document.querySelectorAll(".wb-tab .wb-tab-sub")[1] && /字/.test(document.querySelectorAll(".wb-tab .wb-tab-sub")[1].textContent)', 'second draft', 300000);
    await cdp.eval('document.querySelectorAll(".wb-tabbar .wb-tab")[1].click()');
    await until('document.querySelector(".wb-tab.on .wb-tab-name").textContent==="Claude 2" && document.querySelector(".wb-panel[data-col] .wr-paper")', 'switch tab');
    check('点标签切到另一位 AI 的稿', await cdp.eval('document.querySelector(".wb-panel").dataset.col') !== '');
    await snap('02b-第二位');
    await clickText('并排对比', '.wb-tabbar');
    await until('document.querySelectorAll(".wb-cols .wb-col").length===2', 'compare mode');
    check('「并排对比」把两份稿左右并排', true);
    await snap('02c-并排对比');
    await clickText('回到标签页', '.wb-tabbar');
    await until('document.querySelector(".wb-panel")', 'back to tabs');
    await cdp.eval('document.querySelectorAll(".wb-tabbar .wb-tab")[0].click()');
    await until('document.querySelector(".wb-tab.on .wb-tab-name").textContent==="Claude 1"', 'back to first tab');
    check('稿件里没有标签腔', !/【(推断|坐实|工程推断)】/.test(draftText));
    // 问不问问题是模型自己的判断：有问题卡走回答，没有就走总评点评，两条路都要能改出 v2
    const asked = await until('document.querySelectorAll(".wb-questions .wb-q").length>0', 'question card', 30000).then(() => true, () => false);
    await snap('02-初稿');

    if (asked) {
      // ③a 回答问题 → 各自改一版
      check('问题卡出现，带推荐答案', await cdp.eval('document.querySelector(".wb-q-input").value.trim().length>0'), await cdp.eval('document.querySelector(".wb-q-text").textContent'));
      await typeInto('.wb-q-input', '写给做调度算法的工程师，多用调度里的例子');
      await clickText('把回答发给大家');
      await untilFs(() => userSaid(meeting.id).some((t) => t.includes('回答你们的问题') && t.includes('调度算法')), 'answers sent', 60000);
      check('回答整理成一条消息发进群', true);
    } else {
      // ③b 没有问题卡：点「总评」写一句 → 发出点评，各自改一版
      console.log('    （这次 AI 没出问题卡，改走总评点评）');
      await clickText('总评', '.wb-panel');
      await typeInto('.wb-pop-input', '写给做调度算法的工程师，多用调度里的例子');
      await clickText('放进点评篮（Ctrl+Enter）', '.wb-pop');
      await clickText('发出点评', '.wb-basket');
      await untilFs(() => userSaid(meeting.id).some((t) => t.includes('我的点评') && t.includes('调度算法')), 'comments sent', 60000);
      check('总评整理成一条点评消息发进群', true);
    }
    await until('[...document.querySelectorAll(".wb-panel .wb-ver")].some(b=>b.textContent==="v2")', 'v2 draft', 300000);
    check('按回答 / 点评改出 v2，可在 v1 / v2 之间切换', fs.existsSync(path.join(dir, 'drafts', 'Claude-1-v2.md')));
    await snap('03-改稿v2');

    // ④ 鼠标划一段 → 点评这段 → 点评篮
    await until('!document.querySelector(".wb-panel.working")', 'panel settled', 120000); // 真人也是读完再划
    const rect = await cdp.eval(`(()=>{const p=[...document.querySelectorAll(".wb-panel .wb-panel-body .wr-paper p")].find(x=>x.textContent.trim().length>20);const t=document.createTreeWalker(p,NodeFilter.SHOW_TEXT).nextNode();const r=document.createRange();r.setStart(t,0);r.setEnd(t,Math.min(14,t.length));const a=r.getClientRects();const s=a[0],e=a[a.length-1];p.scrollIntoView({block:'center'});const a2=r.getClientRects();return {x1:a2[0].left+1,y:(a2[0].top+a2[0].bottom)/2,x2:a2[a2.length-1].right-1,y2:(a2[a2.length-1].top+a2[a2.length-1].bottom)/2};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x1, y: rect.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: (rect.x1 + rect.x2) / 2, y: rect.y2, button: 'left', buttons: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x2, y: rect.y2, button: 'left', buttons: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x2, y: rect.y2, button: 'left', clickCount: 1 });
    await until('document.querySelector(".wb-sel-btn")', 'selection button', 5000);
    const quote = await cdp.eval('window.getSelection().toString().trim()');
    check('鼠标划选一段后浮出「点评这段」', quote.length >= 2, quote);
    await cdp.eval('document.querySelector(".wb-sel-btn").click()');
    await typeInto('.wb-pop-input', '开头太像讲义，改成从一个具体场景起笔');
    await clickText('放进点评篮（Ctrl+Enter）', '.wb-pop');
    await until('document.querySelectorAll(".wb-basket .wb-chip").length===1', 'basket chip');
    check('点评进了点评篮，带被划的原文', await cdp.eval(`document.querySelector(".wb-basket .wb-chip").textContent.includes(${JSON.stringify(quote.slice(0, 10))})`));
    await snap('04-划线点评');

    // ⑤ 点名汇总定稿
    await clickText('汇总定稿', '.wb-basket');
    await untilFs(() => userSaid(meeting.id).some((t) => t.includes('汇总定稿') && t.includes('开头太像讲义') && t.includes(quote.slice(0, 6))), 'finalize sent', 60000);
    check('「汇总定稿」连同点评篮里的意见一起发出', true);
    // Tab 要确认派发没被拒（约 2.5 秒）才清点评篮：失败时点评要留着
    await until('document.querySelectorAll(".wb-basket .wb-chip").length===0', 'basket cleared', 15000);
    check('点评篮确认发出后清空', true);
    await until('document.querySelector(".wb-final .wr-paper")', 'final view', 300000);
    check('定稿出现后成为第一个标签并自动打开，各家的稿仍在后面的标签里', await cdp.eval('document.querySelector(".wb-tab .wb-tab-name").textContent==="定稿" && document.querySelector(".wb-tab.on .wb-tab-name").textContent==="定稿" && document.querySelectorAll(".wb-tab").length===3'));
    await untilFs(() => fs.existsSync(path.join(dir, 'final.md')) && fs.statSync(path.join(dir, 'final.md')).size > 200, 'final.md', 30000);
    check('定稿存成 final.md', /^#\s+\S/.test(fs.readFileSync(path.join(dir, 'final.md'), 'utf8')));
    check('全程没有打开群聊', await meetingPanelHidden());
    await snap('05-定稿');

    // ⑥ 文风自动优化，结果显示在文章列表
    await until('/文风已根据这篇更新|这篇没有需要改的地方|没通过检查|文风优化失败/.test(document.querySelector("#wr-view-studio .wr-studio-list").innerText)', 'voice evolution finished', 300000);
    let vstat = JSON.parse(fs.readFileSync(path.join(dir, 'piece.json'), 'utf8')).voice;
    if (vstat.status === 'failed') {
      // 真人会怎么做：看到「文风优化失败」就点「重新优化文风」
      console.log(`    （文风优化第一次失败：${vstat.error}；点「重新优化文风」再来一次）`);
      await clickText('重新优化文风', '#wr-view-studio');
      await until('/文风已根据这篇更新|这篇没有需要改的地方|没通过检查/.test(document.querySelector("#wr-view-studio .wr-studio-list").innerText)', 'voice evolution retried', 300000);
      vstat = JSON.parse(fs.readFileSync(path.join(dir, 'piece.json'), 'utf8')).voice;
    }
    check('定稿后自动优化文风（结果写进文章记录）', ['done', 'rejected'].includes(vstat.status), `${vstat.status}：${vstat.summary || vstat.error || ''}`);
    check('变更日志记下了这次自动优化', /AI (根据|读完|对)《/.test(fs.readFileSync(path.join(voiceDir, 'CHANGELOG.md'), 'utf8')));
    await snap('06-文风已优化');

    // ⑦ 后台群聊仍然可看
    await clickText('在群聊里看过程');
    await until('(()=>{const p=document.getElementById("meeting-room-panel");return p&&getComputedStyle(p).display!=="none";})()', 'meeting opened', 30000);
    check('「在群聊里看过程」打开这篇的后台群聊', await cdp.eval('document.getElementById("writing-panel").style.display==="none"'));
    await cdp.eval('document.getElementById("btn-writing").click()');
    await until('document.querySelector(".wb .wb-title")', 'back to workbench');

    // ⑧ 文风：带行号的源文件、手动编辑、变更记录
    await clickText('文风', '.wr-tabs');
    await until('document.querySelectorAll("#wr-view-voice .wr-line").length>20', 'voice lines');
    check('文风页带行号展示源文件', await cdp.eval('document.querySelector("#wr-view-voice .wr-line .ln").textContent') === '1');
    check('变更记录里看得到 AI 自动优化', await cdp.eval('document.querySelectorAll("#wr-view-voice .wr-changelog li.ai").length>0'));
    await snap('07-文风');
    await clickText('编辑');
    await until('document.querySelector("#wr-view-voice textarea.wr-voice-editor")', 'editor');
    await cdp.eval('(()=>{const t=document.querySelector("#wr-view-voice textarea.wr-voice-editor");t.value=t.value+"\\n<!-- E2E 手动修改 -->\\n";})()');
    await clickText('保存（Ctrl+S）');
    await until('document.querySelector("#wr-view-voice .wr-line")', 'back to lines');
    check('手动编辑保存写回 SKILL.md（临时副本）', fs.readFileSync(path.join(voiceDir, 'SKILL.md'), 'utf8').includes('E2E 手动修改'));
    check('变更记录里出现手动修改', await cdp.eval('document.querySelectorAll("#wr-view-voice .wr-changelog li.me").length>0'));

    // ⑨ 作品库：只读，新作出现
    await clickText('作品库', '.wr-tabs');
    await until('document.querySelectorAll("#wr-view-library .wr-item").length>0', 'library', 60000);
    check('作品库加载全部旧作和这篇新作', await cdp.eval('Number(document.querySelector("#wr-view-library .wr-total b").textContent)') === 593);
    check('作品库只读：没有设范文、摘句、改题材', await cdp.eval('!/设为范文|摘句|改题材/.test(document.getElementById("wr-view-library").innerText)'));
    await snap('08-作品库');

    // 互斥：回到工作台，写作面板收起
    await cdp.eval('document.getElementById("btn-home").click()');
    await until('document.getElementById("writing-panel").style.display==="none"', 'writing hidden on home');
    check('点工作台后写作面板收起', true);
    result.passed = true;
  } catch (err) {
    try {
      await snap('zz-失败现场');
      result.failure = { message: err.message, panel: await cdp.eval('(document.getElementById("writing-panel")||{}).innerText?.slice(0,1500)'), toasts: await cdp.eval('[...document.querySelectorAll(".wr-toast")].map(t=>t.textContent)') };
      console.log('失败现场：', JSON.stringify(result.failure, null, 2).slice(0, 3000));
    } catch (e2) { console.log('记录失败现场也失败了：', e2.message); }
    throw err;
  } finally {
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    try { if (cdp) await cdp.close(); } catch { /* ignore */ }
    if (hub) await gracefulQuit(hub).catch(() => {});
    console.log(`截图与结果：${out}`);
  }
}

main().catch((e) => { console.error('E2E 失败：', e && e.stack || e); process.exit(1); });
