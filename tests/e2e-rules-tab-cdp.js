'use strict';
// 规则 Tab 端到端（2026-10-12）：隔离 Hub + 本机假规则服务器，按用户真实操作点：
//   导航位置（含旧自定义顺序迁移）→ 打开规则页 → 检查更新（已是最新 / 有新版立即生效）→ 对比 →
//   回到上一版 → 开关 → 我的规则编辑保存 → 送达情况 → 切到别的页面互斥隐藏。
// 不启动真实 AI。截图在 output/rules-tab/。
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), http = require('node:http');
const { createHash } = require('node:crypto');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const repo = path.resolve(__dirname, '..');
const out = path.join(repo, 'output', 'rules-tab');
fs.mkdirSync(out, { recursive: true });
const reservePort = () => new Promise(resolve => {
  const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const sha = t => createHash('sha256').update(t, 'utf8').digest('hex');
const report = { checks: [], boundary: '真实隔离 Electron + 本机假规则服务器；不启动真实 AI' };
let hub, cdp, rulesServer;

// 假规则服务器：和阿里云上的静态文件同一套路径与字段。
const published = new Map();
let latestVersion = 1;
function publish(version, text, notes) { published.set(version, { text, notes }); latestVersion = version; }
function startRulesServer() {
  return new Promise(resolve => {
    rulesServer = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      // 公司版拉 company 频道、其余拉 public；假服务器两个频道内容相同。
      const latestMatch = url.match(/^\/hub-rules\/(public|company)\/latest\.json$/);
      if (latestMatch) {
        const v = published.get(latestVersion);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ schema: 1, channel: latestMatch[1], version: latestVersion, notes: v.notes, published_at: '2026-10-12T09:00:00+08:00', sha256: sha(v.text), bytes: Buffer.byteLength(v.text), md: `v/${latestVersion}.md` }));
      }
      const m = url.match(/^\/hub-rules\/(?:public|company)\/v\/(\d+)\.md$/);
      if (m && published.has(Number(m[1]))) { res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' }); return res.end(published.get(Number(m[1])).text); }
      res.writeHead(404); res.end();
    });
    rulesServer.listen(0, '127.0.0.1', () => resolve(rulesServer.address().port));
  });
}

const until = async (expression, label = expression, tries = 150) => {
  for (let i = 0; i < tries; i++) { if (await cdp.eval(`Boolean(${expression})`)) return; await _waitMs(100); }
  throw Error('timeout ' + label);
};
const click = async selector => {
  const p = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing ${selector.replace(/'/g, '')}');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,hit:e===document.elementFromPoint(x,y)||e.contains(document.elementFromPoint(x,y))}})()`);
  assert(p.hit, 'covered ' + selector);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await _waitMs(250);
};
const clickText = async (root, text) => {
  const id = await cdp.eval(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(root + ' button')})].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!e)return null;e.dataset.e2eTarget='1';return true;})()`);
  assert(id, 'missing button ' + text);
  await click('[data-e2e-target="1"]');
  await cdp.eval(`document.querySelectorAll('[data-e2e-target]').forEach(e=>delete e.dataset.e2eTarget)`);
};
const check = (ok, label) => { assert(ok, label); report.checks.push(label); console.log('  ✓ ' + label); };
const shot = async name => {
  const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(s.data, 'base64'));
};
const text = sel => cdp.eval(`document.querySelector(${JSON.stringify(sel)})?.textContent||''`);

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-rules-tab-'));
  const workspace = path.join(temp, 'work'); fs.mkdirSync(workspace);
  const dataDir = path.join(temp, 'data');
  try {
    // 和真实服务器一样存 LF（git 检出的内置文件可能是 CRLF，客户端按 LF 口径比对）。
    const builtin = fs.readFileSync(path.join(repo, 'core', 'hub-rules-default.md'), 'utf8').replace(/\r\n?/g, '\n');
    publish(1, builtin, '第一版');
    const rulesPort = await startRulesServer();
    hub = await launchIsolatedHub({ dataDir, port: await reservePort(), label: 'rules-tab', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: workspace, CLAUDE_HUB_E2E: '1', CODEX_HOME: path.join(temp, 'codex'), CLAUDE_CONFIG_DIR: path.join(temp, 'claude'),
      AI_HUB_RULES_BASE_URL: `http://127.0.0.1:${rulesPort}/hub-rules/` } });
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('document.querySelector("#empty-state")?.dataset.homeReady === "true"', 'home ready', 300);
    // 页面脚本按顺序加载，首页就绪时 rules.js 可能还没跑完（导出的发行版首次启动尤其明显）。
    await until(`typeof window.__rulesShow === 'function'`, 'rules script loaded', 300);

    // 1. 导航位置
    const order = () => cdp.eval(`[...document.querySelectorAll('#scene-rail .rail-navigation .btn-shell-nav')].filter(e=>!e.hidden).map(e=>e.id)`);
    let ids = await order();
    // 公司版关掉了助理（target.json features.assistant=false），规则后面就是下一个可见按钮。
    const hasAssistant = ids.includes('btn-assistant');
    check(ids[0] === 'btn-home' && ids[1] === 'btn-rules' && (!hasAssistant || ids[2] === 'btn-assistant'), hasAssistant ? '左侧导航：规则在主页和助理之间' : '左侧导航：规则紧跟主页（本版没有助理）');
    check(await cdp.eval(`(()=>{const i=document.querySelector('#btn-rules img');return i.naturalWidth>0&&i.getBoundingClientRect().width>0})()`), '规则图标已加载');

    // 2. 打开规则页：内置第一版、默认开
    await click('#btn-rules');
    await until(`getComputedStyle(document.getElementById('rules-panel')).display==='flex' && !!document.querySelector('.rl-official .rl-doc h1')`, 'rules panel');
    check(await cdp.eval(`document.getElementById('btn-rules').classList.contains('cw-current')`), '规则页打开时导航高亮在「规则」');
    check((await text('.rl-ver-num')) === 'v1', '显示内置第一版 v1');
    check(await cdp.eval(`document.querySelector('.rl-switch').getAttribute('aria-checked')==='true'`), '通用规则默认开（隔离环境没有个人基础规则）');
    check((await text('.rl-official .rl-doc h1')).includes('AI Hub 通用规则 v1'), '正文按 Markdown 排版显示');
    check(await cdp.eval(`document.getElementById('rules-panel').scrollWidth<=document.getElementById('rules-panel').clientWidth+1`), '1440 宽度下没有横向溢出');
    await shot('01-official-v1');

    // 3. 检查更新：已是最新
    await click('#rl-check-update');
    await until(`(document.querySelector('#rl-check-result')?.textContent||'').includes('已是最新')`, 'up to date');
    check(true, '检查更新：服务器也是 v1 时提示「已是最新」');

    // 4. 发布 v2 后检查更新：立即生效，显示改动
    const v2 = builtin.replace('# AI Hub 通用规则 v1', '# AI Hub 通用规则 v2') + '\n## 三、新增一节\n\n- 这是 v2 新增的一条规则。\n';
    publish(2, v2, '新增第三节');
    await click('#rl-check-update');
    await until(`document.querySelector('.rl-ver-num')?.textContent==='v2'`, 'updated to v2');
    check((await text('.rl-update')).includes('已更新到 v2') && (await text('.rl-update')).includes('新增第三节'), '有新版：立即更新到 v2，并显示本版改动说明');
    check((await text('.rl-official .rl-doc')).includes('这是 v2 新增的一条规则'), '正文已换成 v2');
    await shot('02-updated-v2');
    await clickText('.rl-seg', '和 v1 对比');
    await until(`!!document.querySelector('.rl-diff-line.add')`, 'diff');
    check(await cdp.eval(`[...document.querySelectorAll('.rl-diff-line.add')].some(e=>e.textContent.includes('v2 新增的一条规则'))`), '对比视图标出新增的行');
    await shot('03-diff');

    // 5. 回到上一版
    await click('#rl-rollback');
    await until(`document.querySelector('.rl-ver-num')?.textContent==='v1'`, 'rollback');
    check((await text('#rl-check-result')).includes('已回到 v1'), '回到上一版：v1 生效，并提示再检查更新会重新拉最新版');
    await click('#rl-check-update');
    await until(`document.querySelector('.rl-ver-num')?.textContent==='v2'`, 'update again');
    check(true, '再次检查更新：重新拉到 v2');

    // 6. 开关
    await click('.rl-switch');
    await until(`document.querySelector('.rl-switch')?.getAttribute('aria-checked')==='false'`, 'switch off');
    check((await text('#rl-summary')).includes('关 通用规则 v2'), '关掉后顶部显示「关」');
    const stateFile = path.join(dataDir, 'hub-rules', 'state.json');
    check(JSON.parse(fs.readFileSync(stateFile, 'utf8')).enabled === false, '开关状态写进 Hub 数据目录');
    await click('.rl-switch');
    await until(`document.querySelector('.rl-switch')?.getAttribute('aria-checked')==='true'`, 'switch on');

    // 7. 我的规则：输入、预览、保存
    await clickText('.rl-tabs', '我的规则');
    await until(`!!document.getElementById('rl-mine-editor')`, 'mine editor');
    await click('#rl-mine-editor');
    await cdp.send('Input.insertText', { text: '## 我的补充\n\n- 回答一律用中文。\n- 改代码前先说明影响范围。' });
    await until(`(document.querySelector('.rl-preview h2')?.textContent||'')==='我的补充'`, 'preview');
    check((await text('#rl-mine-status')).includes('有未保存的修改'), '输入后实时预览，并提示有未保存的修改');
    await shot('04-mine-editing');
    await click('#rl-mine-save');
    await until(`(document.querySelector('#rl-mine-status')?.textContent||'').includes('已保存')`, 'saved');
    const mineFile = path.join(dataDir, 'hub-rules', 'mine.md');
    check(fs.readFileSync(mineFile, 'utf8').includes('改代码前先说明影响范围'), '保存后写进 Hub 数据目录的 mine.md');
    check((await text('#rl-summary')).includes('开 我的规则'), '顶部显示「我的规则」已生效');

    // 8. 送达情况
    await clickText('.rl-tabs', '送达情况');
    await until(`!!document.querySelector('.rl-view .rl-empty, .rl-table')`, 'delivery');
    check(true, '送达情况页可打开（还没有会话时显示空状态）');
    await shot('05-delivery');

    // 9. 互斥：切到开发看板，规则页隐藏；回主页也隐藏
    await click('#btn-ran');
    await until(`getComputedStyle(document.getElementById('rules-panel')).display==='none'`, 'hidden by dev');
    check(await cdp.eval(`!document.getElementById('btn-rules').classList.contains('cw-current')`), '切到开发看板时规则页隐藏、高亮转走');
    await click('#btn-rules');
    await until(`getComputedStyle(document.getElementById('rules-panel')).display==='flex'`, 'reopen');
    await click('#btn-home');
    await until(`getComputedStyle(document.getElementById('rules-panel')).display==='none'`, 'hidden by home');
    check(true, '回主页时规则页隐藏');

    // 10. 旧版本自定义过导航顺序的用户：重载后「规则」仍插在主页和助理之间
    await cdp.eval(`localStorage.setItem('hub.navigationOrder.v1', JSON.stringify(['btn-home','btn-assistant','btn-rail-accounts','btn-ran','btn-rail-memo','btn-rail-capabilities']))`);
    await cdp.send('Page.reload', {});
    await _waitMs(1500);
    await until('document.querySelector("#empty-state")?.dataset.homeReady === "true"', 'home ready after reload', 300);
    await until(`typeof window.__rulesShow === 'function'`, 'rules script loaded after reload', 300);
    ids = await order();
    const expected = ['btn-home', 'btn-rules', ...(hasAssistant ? ['btn-assistant'] : []), 'btn-rail-accounts'];
    check(expected.every((id, i) => ids[i] === id), '旧的自定义顺序：规则插在主页和助理之间，其余顺序不变');
    await shot('06-nav-migrated');

    report.ok = true;
    console.log(`规则 Tab e2e：${report.checks.length} 项全部通过`);
  } catch (error) {
    report.ok = false; report.error = error.stack || String(error);
    console.error(error);
    try { await shot('99-failure'); } catch (_) {}
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    try { cdp?.close?.(); } catch (_) {}
    if (hub) await gracefulQuit(hub).catch(e => { console.error('退出隔离 Hub 失败', e); process.exitCode = 1; });
    rulesServer?.close();
  }
})();
