'use strict';
/**
 * 写作 Tab 真机 E2E：隔离 Hub + 模拟真人操作，走完新版写作流程。
 *
 *   写作台  点「新文章」→ 建写作场景群聊并打开 → 在群聊输入框里说中心思想（真实调用 Claude haiku）
 *           → AI 把稿存进文章目录 → 让它汇总改定 → 写作台显示「已定稿」→ 后台自动优化文风
 *   文风    带行号展示源文件；手动编辑保存；变更记录里看得到 AI 自动优化与手动修改
 *   作品库  定稿以「新作」出现；只读
 *
 * 数据：文章库与文风 skill 复制到临时目录再测，不碰真实文件。写作群只放一位 Claude（haiku）省额度。
 * 用法：node tests/e2e-writing-tab-cdp.js [--out <截图目录>]
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');
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
  const clickText = async (text, scope = '#writing-panel') => {
    await until(`[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].some(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled)`, 'button ' + text);
    await cdp.eval(`[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled).click()`);
  };
  const snap = async (name) => { const b64 = await cdp.eval('ipcRenderer.invoke("test:writing-capture")'); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(b64, 'base64')); };
  // 真实键盘输入：聚焦输入框，全选后插入文字（与群聊 E2E 的做法一致），再点发送
  const sendInGroup = async (text) => {
    await until('document.querySelector("#mr-input-box") && !document.querySelector("#mr-send-btn").disabled', 'group input ready', 90000);
    await cdp.eval('document.querySelector("#mr-input-box").focus()');
    for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    await cdp.send('Input.insertText', { text });
    await sleep(300);
    await cdp.eval('document.querySelector("#mr-send-btn").click()');
  };
  const pieceDir = () => { try { return fs.readdirSync(piecesRoot).map((n) => path.join(piecesRoot, n)).find((d) => fs.existsSync(path.join(d, 'piece.json'))); } catch { return null; } };

  try {
    hub = await launchIsolatedHub({
      dataDir: data, port: await freePort(), windowMode: 'hidden', entryPath: entry, label: 'writing-tab',
      extraEnv: {
        CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_WRITING_ROOT: writingRoot,
        CLAUDE_HUB_WRITING_MEMBERS: 'claude:haiku', CLAUDE_HUB_WRITING_EVOLVE_MODEL: 'haiku', CLAUDE_HUB_WRITING_CLAUDE_MODEL: 'haiku',
        CLAUDE_HUB_WRITING_EVOLVE_SETTLE_MS: '0', // 真实使用时定稿稳定两分钟才优化，测试不等
      },
    });
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until('!!document.getElementById("btn-writing")', 'rail button');
    await until('typeof window.__writingShow === "function"', 'writing.js loaded');
    check('左侧导航：写作紧挨在账号下方', await cdp.eval('document.getElementById("btn-rail-accounts").nextElementSibling.id') === 'btn-writing');

    // ① 写作台：新文章 → 写作群聊
    await cdp.eval('document.getElementById("btn-writing").click()');
    await until('document.querySelector("#wr-view-studio.active")', 'studio view');
    check('打开写作 Tab 默认就是写作台', true);
    await snap('01-写作台-空');
    await clickText('＋ 新文章');
    await until('document.getElementById("writing-panel").style.display==="none" && document.getElementById("meeting-room-panel") && getComputedStyle(document.getElementById("meeting-room-panel")).display!=="none"', 'meeting room opened', 90000);
    const meeting = await cdp.eval('ipcRenderer.invoke("get-meetings").then(ms=>ms.find(m=>m.scene==="writing"))');
    check('新文章直接建成写作场景群聊并打开', !!meeting && meeting.scene === 'writing', meeting && meeting.title);
    const dir = pieceDir();
    check('群聊工作目录就是这篇文章的目录', dir && path.resolve(meeting.workspace || '') === path.resolve(dir), meeting.workspace);
    check('文章目录里有 .vibe-root，并记下了群聊 id', fs.existsSync(path.join(dir, '.vibe-root')) && JSON.parse(fs.readFileSync(path.join(dir, 'piece.json'), 'utf8')).meetingId === meeting.id);
    const members = await cdp.eval(`ipcRenderer.invoke("get-sessions").then(ss=>ss.filter(s=>s.meetingId===${JSON.stringify(meeting.id)}).map(s=>({kind:s.kind,purpose:s.purpose})))`);
    check('写作群成员标记为 purpose=writing', members.length === 1 && members.every((m) => m.purpose === 'writing'), JSON.stringify(members));

    // ② 在群里说中心思想（真实调用 Claude haiku）
    await sendInGroup('中心思想：同一个模型多开几个分身互相审稿，并不能像多根独立天线那样带来分集增益，因为它们的错误高度相关。读者是懂 AI、不懂无线的算法工程师。信息已经够了，不用问我问题，请直接写一篇 300 字左右的短文，并按群规则保存稿件。');
    await snap('02-群聊-已发送');
    const draft = await untilFs(() => { try { const f = fs.readdirSync(path.join(dir, 'drafts')).find((n) => n.endsWith('.md')); return f && fs.statSync(path.join(dir, 'drafts', f)).size > 200 ? f : null; } catch { return null; } }, 'draft saved by AI', 300000);
    const draftText = fs.readFileSync(path.join(dir, 'drafts', draft), 'utf8');
    check('AI 按写作群规则把稿存进文章目录，并用 # 标题开头', /^#\s+\S/m.test(draftText), `${draft}：${draftText.split('\n')[0]}`);
    check('稿件里没有标签腔', !/【(推断|坐实|工程推断)】/.test(draftText));
    await until('document.querySelectorAll("#meeting-room-panel .gc-bubble, #meeting-room-panel [data-role=assistant], #meeting-room-panel .mr-gc-msg").length>0 || /分集|天线/.test(document.getElementById("meeting-room-panel").innerText)', 'reply visible in group chat', 120000);
    check('稿件也出现在群聊消息里', await cdp.eval('/分集|天线/.test(document.getElementById("meeting-room-panel").innerText)'));
    await snap('03-群聊-稿件');

    // ③ 点评并让它汇总改定
    await sendInGroup('开头太像讲义，改成从一个具体场景起笔；其余保留。请你汇总改定，按群规则保存为 final.md。');
    await untilFs(() => fs.existsSync(path.join(dir, 'final.md')) && fs.statSync(path.join(dir, 'final.md')).size > 200, 'final.md saved', 300000);
    check('按点评汇总改定，定稿存为 final.md', true);

    // ④ 回到写作台：已定稿 + 文风自动优化
    await cdp.eval('document.getElementById("btn-writing").click()');
    await until('/已定稿/.test(document.getElementById("wr-view-studio").innerText)', 'studio shows final', 30000);
    check('写作台显示已定稿', true);
    await until('/文风已根据这篇更新|这篇没有需要改的地方|没通过检查|文风优化失败/.test(document.getElementById("wr-view-studio").innerText)', 'voice evolution finished', 300000);
    const vstat = JSON.parse(fs.readFileSync(path.join(dir, 'piece.json'), 'utf8')).voice;
    check('定稿后自动优化文风（结果写进文章记录）', ['done', 'rejected'].includes(vstat.status), `${vstat.status}：${vstat.summary || vstat.error || ''}`);
    const log = fs.readFileSync(path.join(voiceDir, 'CHANGELOG.md'), 'utf8');
    check('变更日志记下了这次自动优化', /AI (根据|读完|对)《/.test(log));
    await snap('04-写作台-已定稿');

    // ⑤ 文风：带行号的源文件、手动编辑、变更记录
    await clickText('文风', '.wr-tabs');
    await until('document.querySelectorAll("#wr-view-voice .wr-line").length>20', 'voice lines');
    check('文风页带行号展示源文件', await cdp.eval('document.querySelector("#wr-view-voice .wr-line .ln").textContent') === '1');
    check('变更记录里看得到 AI 自动优化', await cdp.eval('document.querySelectorAll("#wr-view-voice .wr-changelog li.ai").length>0'));
    await sleep(800); // 后台窗口偶尔还没把新视图画上去就截图，拿到空白帧
    await snap('05-文风');
    await clickText('编辑');
    await until('document.querySelector("#wr-view-voice textarea.wr-voice-editor")', 'editor');
    await cdp.eval('(()=>{const t=document.querySelector("#wr-view-voice textarea.wr-voice-editor");t.value=t.value+"\\n<!-- E2E 手动修改 -->\\n";})()');
    await clickText('保存（Ctrl+S）');
    await until('document.querySelector("#wr-view-voice .wr-line")', 'back to lines');
    check('手动编辑保存写回 SKILL.md（临时副本）', fs.readFileSync(path.join(voiceDir, 'SKILL.md'), 'utf8').includes('E2E 手动修改'));
    check('变更记录里出现手动修改', await cdp.eval('document.querySelectorAll("#wr-view-voice .wr-changelog li.me").length>0'));

    // ⑥ 作品库：只读，新作出现
    await clickText('作品库', '.wr-tabs');
    await until('document.querySelectorAll("#wr-view-library .wr-item").length>0', 'library', 60000);
    check('作品库加载全部旧作和这篇新作', await cdp.eval('Number(document.querySelector("#wr-view-library .wr-total b").textContent)') === 593);
    check('作品库只读：没有设范文、摘句、改题材', await cdp.eval('!/设为范文|摘句|改题材/.test(document.getElementById("wr-view-library").innerText)'));
    await snap('06-作品库');

    // 互斥：回到工作台，写作面板收起
    await cdp.eval('document.getElementById("btn-home").click()');
    await until('document.getElementById("writing-panel").style.display==="none"', 'writing hidden on home');
    check('点工作台后写作面板收起', true);
    result.passed = true;
  } catch (err) {
    try {
      await snap('zz-失败现场');
      result.failure = { message: err.message, panel: await cdp.eval('(document.getElementById("writing-panel")||{}).innerText?.slice(0,1200)'), toasts: await cdp.eval('[...document.querySelectorAll(".wr-toast")].map(t=>t.textContent)') };
      console.log('失败现场：', JSON.stringify(result.failure, null, 2).slice(0, 2500));
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
