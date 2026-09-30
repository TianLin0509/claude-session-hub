'use strict';
/**
 * 写作 Tab 真机 E2E：隔离 Hub + 模拟真人点击，走完 作品库 → 文风 → 写作台六步。
 *
 * 数据：把用户的文章目录和 tiange-voice / chinese-tech-writing 复制到临时目录再测，
 * 不碰真实文件。起草与审阅真实调用 Claude（默认 haiku，按项目规则省额度）；
 * 隔离 home 里没有 Codex 订阅和 DeepSeek 密钥，这两家在界面上应显示为不可用。
 *
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
const REAL_SKILLS = path.join(os.homedir(), '.codex', 'skills');

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
    while (Date.now() < end) { if (await cdp.eval(`Boolean(${expr})`)) return; await sleep(200); }
    throw new Error('timeout: ' + label);
  };
  const clickText = async (text, scope = '#writing-panel') => {
    await until(`[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].some(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled)`, 'button ' + text);
    await cdp.eval(`[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled).click()`);
  };
  const clickModal = async (text) => clickText(text, '.wr-modal');
  const snap = async (name) => { const b64 = await cdp.eval('ipcRenderer.invoke("test:writing-capture")'); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(b64, 'base64')); };
  const setField = async (selector, value) => cdp.eval(`(()=>{const el=${selector};el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);

  try {
    hub = await launchIsolatedHub({
      dataDir: data, port: await freePort(), windowMode: 'hidden', entryPath: entry, label: 'writing-tab',
      extraEnv: { CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_WRITING_ROOT: writingRoot, CLAUDE_HUB_WRITING_CLAUDE_MODEL: process.env.WRITING_E2E_CLAUDE_MODEL || 'haiku' },
    });
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until('!!document.getElementById("btn-writing")', 'rail button');
    // 按钮写在 HTML 里，处理点击的 writing.js 在页面末尾才加载：等脚本就绪再点，否则点击会落空
    await until('typeof window.__writingShow === "function"', 'writing.js loaded');

    // 导航：写作按钮在账号正下方
    const order = await cdp.eval('(()=>{const a=document.getElementById("btn-rail-accounts");return a&&a.nextElementSibling&&a.nextElementSibling.id})()');
    check('左侧导航：写作紧挨在账号下方', order === 'btn-writing', order);

    // ① 作品库
    await cdp.eval('document.getElementById("btn-writing").click()');
    await until('document.querySelectorAll("#wr-view-library .wr-item").length>0', 'library items', 60000);
    const total = await cdp.eval('document.querySelector("#wr-view-library .wr-total b").textContent');
    check('作品库加载全部旧作', Number(total) === 592, `共 ${total} 篇`);
    check('界面显示版本号', await cdp.eval('/AI Hub v\\d+\\.\\d+\\.\\d+/.test(document.querySelector(".wr-version").textContent)'));
    const stars = await cdp.eval('document.querySelectorAll("#wr-view-library .wr-item .star").length');
    check('出过范文的文章带星标', stars > 0, `${stars} 篇`);
    await snap('01-作品库');
    await setField('document.querySelector("#wr-view-library input[type=search]")', '信道估计');
    await until('document.querySelector("#wr-view-library .wr-muted") && /筛出 \\d+ 篇/.test(document.querySelector("#wr-view-library .wr-listcol .wr-muted").textContent) && Number(document.querySelector("#wr-view-library .wr-listcol .wr-muted").textContent.match(/\\d+/)[0])<100', 'search filter');
    await cdp.eval('document.querySelector("#wr-view-library .wr-item").click()');
    await until('document.querySelector("#wr-reader .wr-paper p")', 'reader');
    const picked = await cdp.eval(`(()=>{const ps=[...document.querySelectorAll('#wr-reader .wr-paper p')].filter(p=>p.textContent.trim().length>20);const p=ps[0];const r=document.createRange();r.selectNodeContents(p);const s=getSelection();s.removeAllRanges();s.addRange(r);p.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));return p.textContent.trim();})()`);
    await until('document.querySelector(".wr-selbar.show")', 'selection bar');
    await snap('02-选中段落');
    await clickText('设为范文', '.wr-selbar');
    await until('document.querySelector(".wr-modal")', 'exemplar modal');
    await cdp.eval('(()=>{const s=document.querySelector(".wr-modal select");s.value="类比";s.dispatchEvent(new Event("change"));})()');
    await clickModal('加入候选');
    await until('JSON.parse(require("fs").readFileSync(' + JSON.stringify(path.join(voiceDir, 'voice-review.json')) + ',"utf8")).candidates.length===1', 'candidate saved');
    check('选中段落 → 设为范文候选', true, picked.slice(0, 30));

    // ② 文风
    await clickText('文风', '.wr-tabs');
    await until('document.querySelector("#wr-view-voice .wr-portrait")', 'voice view');
    check('文风页显示画像与十条写法', await cdp.eval('document.querySelectorAll("#wr-view-voice .wr-rule").length') === 10);
    check('候选提示', await cdp.eval('/候选 1 段待转正/.test(document.querySelector("#wr-view-voice").textContent)'));
    await clickText('类比 3 +1', '.wr-gtabs');
    await clickText('转正');
    await until(`require("fs").readFileSync(${JSON.stringify(path.join(voiceDir, 'exemplars.md'))},"utf8").includes(${JSON.stringify('> ' + picked.split('\n')[0].slice(0, 12))})`, 'promoted into exemplars.md');
    check('候选转正写进 exemplars.md（临时副本）', true);
    await cdp.eval('document.querySelector("#wr-view-voice .wr-rule-head").click()');
    await clickText('确认');
    await until(`JSON.parse(require("fs").readFileSync(${JSON.stringify(path.join(voiceDir, 'voice-review.json'))},"utf8")).rules["1"].status==="confirmed"`, 'rule confirmed');
    check('确认第 1 条写法', true);
    await snap('03-文风');

    // ③ 写作台：新建 → 访谈
    await clickText('写作台', '.wr-tabs');
    await clickText('＋ 新文章');
    await until('document.querySelector(".wr-modal input")', 'new piece modal');
    await setField('document.querySelector(".wr-modal input")', 'E2E 测试：分身不是分集');
    await clickModal('创建');
    await until('document.querySelector("#wr-view-studio .wr-form")', 'interview form');
    const inputs = '[...document.querySelectorAll("#wr-view-studio .wr-form input, #wr-view-studio .wr-form textarea")]';
    await setField(inputs + '[0]', '懂 AI、不懂无线的算法专家');
    await setField(inputs + '[2]', '同一个模型开几个分身，不等于多了几条独立的路');
    await setField(inputs + '[4]', '400-600');
    await setField(inputs + '[5]', '多天线的阵列增益与分集增益；同模型分身像同一衰落下的多根天线');
    await snap('04-访谈');
    await clickText('保存并去起草 →');
    await until('document.querySelector("#wr-view-studio .wr-providers")', 'draft stage');
    const prov = await cdp.eval('[...document.querySelectorAll("#wr-view-studio .wr-providers label")].map(l=>(l.querySelector("input").disabled?"×":"✓")+l.textContent.trim().slice(0,12))');
    check('Codex / DeepSeek 在隔离 home 下显示为不可用，Claude 可用', prov[0].startsWith('✓') && prov[1].startsWith('×') && prov[2].startsWith('×'), prov.join(' | '));

    // ④ 起草（真实调用 Claude）
    await clickText('开始起草');
    await until('document.querySelector("#wr-view-studio .wr-pill.brand")', 'drafting started', 15000);
    await snap('05-起草中');
    await until('[...document.querySelectorAll("#wr-view-studio .wr-pill")].some(p=>/完成|失败/.test(p.textContent))', 'draft finished', 240000);
    const draftState = await cdp.eval('[...document.querySelectorAll("#wr-view-studio .wr-drafts .wr-card")].map(c=>c.textContent.trim().slice(0,200))');
    check('Claude 起草完成', /完成/.test(draftState.join(' ')), draftState.join(' | '));

    // ⑤ 盲选
    await clickText('去盲选 →');
    await until('document.querySelector("#wr-view-studio .wr-draft")', 'blind cards');
    check('盲选卡片不显示作者', await cdp.eval('!/claude|haiku/i.test(document.querySelector("#wr-view-studio .wr-draft").textContent)'));
    await cdp.eval('document.querySelectorAll("#wr-view-studio .wr-stars button")[3].click()');
    await sleep(600);
    await clickText('选这份');
    await clickText('揭晓作者');
    await until('document.querySelector("#wr-view-studio .wr-reveal")', 'reveal');
    const reveal = await cdp.eval('document.querySelector("#wr-view-studio .wr-reveal").textContent');
    check('揭晓后显示作者与干净度：工具、MCP、skill 都是 0', /claude/.test(reveal) && /工具 0 \/ MCP 0 \/ skill 0/.test(reveal), reveal);
    // 截图曾暴露的两个布局 bug：文风页叠在写作台上；空元素被当成文字 null 显示
    check('写作台激活时其他子页隐藏', await cdp.eval('getComputedStyle(document.getElementById("wr-view-voice")).display==="none" && getComputedStyle(document.getElementById("wr-view-library")).display==="none"'));
    check('页面上没有孤立的 null 文字', await cdp.eval('!/(^|\\n)\\s*null\\s*(\\n|$)/.test(document.getElementById("wr-view-studio").innerText)'));
    check('写作台主区宽度正常（阶段名不被挤成竖排）', await cdp.eval('document.querySelector("#wr-view-studio .wr-stage").getBoundingClientRect().width > 700'));
    await snap('06-盲选');

    // ⑥ 审阅（只有 Claude 可用，显式选它）
    await clickText('下一步：审阅 →');
    await until('document.querySelector("#wr-view-studio .wr-review")', 'review stage');
    await cdp.eval('(()=>{const s=document.querySelector("#wr-view-studio .wr-toolbar select");s.value="claude";})()');
    await clickText('开始审阅');
    await until('document.querySelectorAll("#wr-view-studio .wr-ritem").length>0 || /失败/.test(document.querySelector("#wr-view-studio .wr-toolbar").textContent)', 'review finished', 240000);
    const nItems = await cdp.eval('document.querySelectorAll("#wr-view-studio .wr-ritem").length');
    check('审阅只出批注', nItems > 0, `${nItems} 条`);
    await clickText('采纳');
    await sleep(800);
    await snap('07-审阅');

    // ⑦ 定稿：内置 Markdown 编辑器
    await clickText('下一步：定稿 →');
    await until('document.querySelector("#wr-view-studio .wr-editor textarea") && document.querySelector("#wr-view-studio .wr-editor textarea").value.length>50', 'editor loaded');
    check('采纳的批注列进定稿待办', await cdp.eval('/采纳的批注（1）/.test(document.querySelector("#wr-view-studio").textContent)'));
    await cdp.eval('(()=>{const t=document.querySelector("#wr-view-studio .wr-editor textarea");t.value="在公司楼下等咖啡的时候，我想明白了一件事。\\n\\n"+t.value.split(/\\n\\s*\\n/).slice(1).join("\\n\\n");t.dispatchEvent(new Event("input"));})()');
    await until('/在公司楼下等咖啡/.test(document.querySelector("#wr-view-studio .wr-editor .wr-paper").textContent)', 'live preview');
    check('编辑器实时预览', true);
    check('定稿页没有孤立的 null 文字', await cdp.eval('!/(^|\\n)\\s*null\\s*(\\n|$)/.test(document.getElementById("wr-view-studio").innerText)'));
    check('编辑区足够宽', await cdp.eval('document.querySelector("#wr-view-studio .wr-editor textarea").getBoundingClientRect().width > 350'));
    await snap('08-定稿编辑器');
    await clickText('定稿并回流 →');
    await until('document.querySelector("#wr-view-studio .wr-ratio")', 'reflow stage', 60000);
    const ratio = await cdp.eval('document.querySelector("#wr-view-studio .wr-ratio").textContent');
    check('回流：算出改动比例', /\d+%/.test(ratio), ratio);
    await until('document.querySelector("#wr-view-studio .wr-paper table")', 'diff table');
    await snap('09-回流');
    const state = JSON.parse(fs.readFileSync(path.join(voiceDir, 'voice-review.json'), 'utf8'));
    check('改动比例写进文风状态', state.editRatios.length === 1, JSON.stringify(state.editRatios[0]));
    await clickText('去文风页');
    await until('document.querySelector("#wr-view-voice svg.wr-chart circle")', 'ratio chart point');
    await snap('10-文风曲线');

    // 新作回到作品库
    await clickText('作品库', '.wr-tabs');
    await setField('document.querySelector("#wr-view-library input[type=search]")', 'E2E 测试');
    await until('[...document.querySelectorAll("#wr-view-library .wr-item")].some(i=>/E2E 测试/.test(i.textContent)&&/新作/.test(i.textContent))', 'new piece in library');
    check('定稿以「新作」出现在作品库', true);

    // 互斥：回到工作台，写作面板要收起
    await cdp.eval('document.getElementById("btn-home").click()');
    await until('document.getElementById("writing-panel").style.display==="none"', 'writing hidden on home');
    check('点工作台后写作面板收起', true);

    result.passed = true;
  } catch (err) {
    // 失败现场：截图 + 写作面板文字 + 页面上的错误提示，便于定位
    try {
      await snap('zz-失败现场');
      result.failure = {
        message: err.message,
        panel: await cdp.eval('(()=>{const p=document.getElementById("writing-panel");return p?{display:p.style.display,text:p.innerText.slice(0,1500)}:null})()'),
        toasts: await cdp.eval('[...document.querySelectorAll(".wr-toast")].map(t=>t.textContent)'),
        ipc: await cdp.eval('ipcRenderer.invoke("writing:library-list",{}).then(r=>({ok:r.ok,message:r.message,total:r.total}))'),
      };
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
