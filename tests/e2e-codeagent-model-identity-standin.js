'use strict';
// 真实验收（替身）：CodeAgent「请求的模型」和「实际回答的模型」不一致时，界面按实际模型显示（2026-10-13 用户：
// 同事有 DeepSeek 权限，会话显示 GLM-5.2，后台实际是 deepseek0731…，卡片对、输入框下方不对）。
// 替身 tests/fixtures/codeagent-standin 把 --model GLM… 换成 Claude haiku 再启动真 Claude Code，
// 正好复现「请求 GLM、实际是另一个模型」：
//   ① 新建会话时输入框下方是请求的 GLM-5.2 Auto；
//   ② 第一轮回答后，输入框下方、会话记录都换成回答里的真实模型，请求的 GLM 另记一笔，并弹出提示；
//   ③ 真实模型进了模型菜单；
//   ④ 头像与侧栏图标按模型对应：把会话模型换成 deepseek… / MiniMax-M2.7（模拟数据）后，
//      侧栏、输入框、卡片头像各自换成 DeepSeek / MiniMax 的图，图片真实加载成功。
// 凭据复制进临时目录，finally 删除。
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const STANDIN = path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd');
const QUESTION = '不要调用工具。用一句话说说什么是 HARQ。';
const DS = 'deepseek0731-wx-chat';

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codeagent-model-'));
  const out = path.resolve(process.env.E2E_OUT || 'artifacts/20261013-codeagent-model-identity-claude1'); fs.mkdirSync(out, { recursive: true });
  const claudeAuth = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
  const cac = path.join(root, '.cac'), dataDir = path.join(root, 'data'), cwd = path.join(root, 'workspace');
  for (const d of [cac, cwd, dataDir]) fs.mkdirSync(d, { recursive: true });
  const result = { checks: [], passed: false };
  let hub, c;
  const until = async (expr, label, ms = 180000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.eval(expr)) return; await sleep(300); } throw Error('timeout: ' + label); };
  const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(s.data, 'base64')); };
  const click = async selector => {
    const p = await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)throw Error('Missing control: '+${j(selector)});e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    await sleep(300);
  };
  const check = (ok, label) => { assert.ok(ok, label); result.checks.push(label); console.log('  ✓ ' + label); };
  const chipLabel = `[...document.querySelectorAll('.composer-model')].find(e=>!e.hidden&&e.offsetParent)?.querySelector('.composer-chip-label')?.textContent || ''`;
  const chipLogo = `[...document.querySelectorAll('.composer-model')].find(e=>!e.hidden&&e.offsetParent)?.querySelector('.composer-model-logo')?.className || ''`;
  const imageLoads = src => c.eval(`new Promise(r=>{const i=new Image();i.onload=()=>r(i.naturalWidth);i.onerror=()=>r(0);i.src=${j(src)};})`);
  try {
    fs.copyFileSync(claudeAuth, path.join(cac, '.credentials.json'));
    fs.writeFileSync(path.join(cac, '.claude.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true,
      skipDangerousModePermissionPrompt: true, hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true,
      hasSeenAutoModeEntryWarning: true, theme: 'dark', projects: {} }));
    fs.writeFileSync(path.join(cac, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
    fs.writeFileSync(path.join(cac, 'settings.json'), j({ permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }));

    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'hidden', label: 'codeagent model identity', extraEnv: {
      AI_HUB_CODEAGENT_COMMAND: STANDIN, AI_HUB_CODEAGENT_CONFIG_DIR: cac,
      CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', AI_HUB_RULES_BASE_URL: 'http://127.0.0.1:9/hub-rules/',
      HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none') } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions !== "undefined"', 'renderer');
    // 把 toast 都记下来（它几秒后自动消失）。
    await c.eval(`window.__toasts=[];new MutationObserver(()=>{const t=document.getElementById('gc-fork-toast');if(t&&t.textContent&&!window.__toasts.includes(t.textContent))window.__toasts.push(t.textContent);}).observe(document.body,{subtree:true,childList:true,characterData:true})`);

    // ① 新建：显示请求的 GLM
    const created = await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd, effort: 'low', mcpProfile: 'none' } })})`);
    const sid = created.id, q = j(sid);
    await until(`!!document.querySelector('.session-item[data-session-id="${sid}"]')`, 'row', 20000);
    await c.eval(`selectSession(${q})`);
    await c.eval(`applyViewMode('card')`);
    await until(`${chipLabel} === 'GLM-5.2 Auto'`, 'composer GLM', 20000);
    check(true, '新建 CodeAgent 会话，输入框下方显示请求的 GLM-5.2 Auto');
    await shot('01-before');

    // ② 第一轮回答后按实际模型显示
    await click('.floating-input-box');
    await c.send('Input.insertText', { text: QUESTION });
    await click('.floating-input-send');
    await until(`getSessionRuntimeTruth(sessions.get(${q})).state === 'completed' && [...document.querySelectorAll('#msg-overlay .turn-card.assistant')].some(e=>e.innerText.trim().length>10)`, 'first answer', 240000);
    await until(`/^claude-/.test(sessions.get(${q})?.currentModel?.id || '')`, 'observed model', 20000);
    const actual = await c.eval(`sessions.get(${q}).currentModel.id`);
    result.actualModel = actual;
    const cardModel = await c.eval(`[...document.querySelectorAll('#msg-overlay .turn-card.assistant')].pop()?.querySelector('.turn-who')?.innerText || ''`);
    check(cardModel.includes(actual), `卡片上的模型名是回答里的真实模型（${actual}）`);
    await until(`${chipLabel} === ${j(actual)}`, 'composer actual', 10000);
    check(true, '输入框下方换成同一个真实模型，不再显示 GLM');
    check((await c.eval(`sessions.get(${q}).codeagentRequestedModel`)) === 'GLM-5.2-WX-Auto', '原来请求的 GLM 另记一笔');
    await until(`window.__toasts.some(t=>t.includes('实际用的是'))`, 'toast', 10000);
    result.toast = await c.eval(`window.__toasts.find(t=>t.includes('实际用的是'))`);
    check(/GLM-5\.2 Auto/.test(result.toast) && result.toast.includes(actual), '弹出提示：选的是 GLM-5.2 Auto，实际用的是哪个模型');
    await shot('02-after-first-answer');

    // ③ 模型菜单里有真实模型
    await c.eval(`[...document.querySelectorAll('.composer-model')].find(e=>!e.hidden&&e.offsetParent).setAttribute('data-e2e-chip','1')`);
    await click('[data-e2e-chip="1"]');
    await until(`!!document.querySelector('.model-picker-menu .model-picker-item')`, 'menu', 10000);
    const menu = await c.eval(`[...document.querySelectorAll('.model-picker-menu .model-picker-item')].map(e=>({id:e.dataset.modelId,current:e.classList.contains('current')}))`);
    result.menu = menu;
    check(menu.some(m => m.id === actual && m.current), '模型菜单里出现真实模型，并标为当前');
    await shot('03-menu');
    await c.eval(`document.body.click()`);
    const savedObserved = JSON.parse(fs.readFileSync(path.join(dataDir, 'codeagent-models.json'), 'utf8'));
    check(savedObserved.models.some(m => m.id === actual), '本机记下了这个模型名，下次新建会话可以直接选');
    const evidence = fs.readFileSync(path.join(dataDir, 'logs', 'codeagent-model.log'), 'utf8');
    result.evidence = evidence.trim().split('\n');
    console.log('  证据日志：\n    ' + result.evidence.join('\n    '));
    check(/event=launch .*requested=\S+ model=GLM-5\.2-WX-Auto/.test(evidence)
      && new RegExp(`event=observe via=(stop-hook|turn-complete) .*actual=${actual.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(evidence),
      '证据日志：记下启动命令里的模型和回答实际用的模型');

    // ④ 头像与图标（模拟 deepseek / MiniMax 模型名）
    for (const [model, logo, avatar] of [[DS, 'deepseek', 'deepseek'], ['MiniMax-M2.7', 'minimax', 'minimax'], ['GLM-5.2-WX-Auto', 'codeagent', 'glm']]) {
      // 走界面收到主进程「会话已更新」的同一条路径（模拟主进程推来的模型）。主进程自己记的还是替身的真实模型，
      // 之后任何一次状态推送都会把它盖回去，所以注入后立刻读，被盖回就再注入一次。
      const inject = `ipcRenderer.emit('session-updated', {}, { session: { ...sessions.get(${q}), currentModel: { id: ${j(model)}, displayName: ${j(model)} } } })`;
      let row = null;
      for (let attempt = 0; attempt < 8 && !(row && row.cls.includes(`logo-${logo}`) && (logo !== 'minimax' || row.chip.includes('minimax'))); attempt++) {
        row = await c.eval(`(async()=>{${inject};await new Promise(r=>setTimeout(r,500));const e=document.querySelector('.session-item[data-session-id="${sid}"] .sl-kind');return e&&{cls:e.className,title:e.title,bg:getComputedStyle(e).backgroundImage,chip:${chipLogo}};})()`);
      }
      check(row && row.cls.includes(`logo-${logo}`) && row.bg.includes(`${logo}.svg`) && row.title.startsWith('CodeAgent'), `侧栏图标：${model} → ${logo}.svg，提示仍写 CodeAgent`);
      const src = await c.eval(`require('./chat-avatar').chatAvatarSrc('codeagent',{model:${j(model)}})`);
      check(src === `assets/ai-avatars/cel-v2/${avatar}.png` && (await imageLoads(src)) > 0, `卡片头像：${model} → ${avatar}.png，图片加载成功`);
      if (logo === 'minimax') check(row.chip.includes('minimax'), '输入框模型图标：MiniMax 用自己的图标');
      await shot(`04-${logo}`);
    }
    check((await imageLoads('assets/ai-logos/minimax.svg')) > 0, 'MiniMax 图标文件加载成功');
    result.passed = true;
  } catch (error) {
    result.error = error && error.stack || String(error);
    if (c) { try { await shot('fail'); result.screen = await c.eval('document.body.innerText.slice(-1500)'); } catch {} }
    if (hub) { try { result.hubLogTail = hub.log().slice(-40); } catch {} }
  } finally {
    if (c) { try { c.close(); } catch {} }
    if (hub) { try { await gracefulQuit(hub); } catch (e) { result.teardownError = e.message; } }
    try { fs.rmSync(path.join(cac, '.credentials.json'), { force: true }); } catch {}
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks, actualModel: result.actualModel, toast: result.toast, error: result.error }, null, 2));
    if (!result.passed) process.exitCode = 1;
  }
}
main();
