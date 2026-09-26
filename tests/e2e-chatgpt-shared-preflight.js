'use strict';
// Explicit opt-in, existing logged-in profile, disposable page. Never fills or sends a prompt.
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict');
const { execFileSync } = require('child_process');
const { BrowserTool } = require('../core/hub-browser-tool');
(async () => {
  const root = process.env.HUB_CHROME_ROOT;
  if (!root) throw Error('Set HUB_CHROME_ROOT explicitly for a real website preflight');
  const scripts = process.env.HUB_IMAGE_SCRIPTS || path.join(os.homedir(), 'plugins/chatgpt-web-images/scripts');
  const code = `import ast,json,sys\nsys.path.insert(0,sys.argv[1])\nfrom chatgpt_account import STATUS_JS\nfrom pathlib import Path\ntree=ast.parse((Path(sys.argv[1])/'web_images.py').read_text(encoding='utf-8'))\nselect=[n.value for n in ast.walk(tree) if isinstance(n,ast.Constant) and isinstance(n.value,str) and 'const tool=page.locator' in n.value]\nassert len(select)==1\nprint(json.dumps({'status':STATUS_JS,'select':select[0]}))`;
  const sources = JSON.parse(execFileSync('python', ['-c', code, scripts], { encoding: 'utf8', windowsHide: true }));
  const binding = { root, id: 'preflight-codex1', tool: 'images', identity: 'main', playwright: require.resolve('playwright', { paths: [process.env.HUB_TEST_PLAYWRIGHT || 'C:/DevTools/playwright-cli-0.1.19/node_modules'] }) };
  const tool = new BrowserTool(binding);
  const out = path.resolve('artifacts/shared-browser-preflight'); fs.mkdirSync(out, { recursive: true });
  const run = async (name, source) => { const file = path.join(out, name + '.js'); fs.writeFileSync(file, source); return tool.execute(['run-code', '--filename', file]); };
  try {
    await tool.open('https://chatgpt.com/');
    await tool.withPage(page => page.locator('[contenteditable=true][data-composer-markdown],#prompt-textarea').waitFor({ timeout: 45000 }));
    const status = await run('original-status', sources.status);
    assert.equal(status.logged_in, true, 'the installed tool recognizes the modern logged-in page');
    assert.equal(await run('original-image-menu', sources.select), true, 'the installed image selection code works through the shared transport');
    const mode = await run('mode-verification', `async page => { const composer=page.locator('#prompt-textarea'); return {selected:await composer.locator('[data-inline-selection-pill][data-system-hint-type="picture_v2"]').count(),empty:(await composer.innerText()).trim()==='',send:await page.getByTestId('send-button').count()}; }`);
    assert.deepEqual(mode, { selected: 1, empty: true, send: 1 });
    const result = { passed: true, boundary: '真实 ChatGPT 新版页面；安装版生图工具的原始状态与菜单代码经共享适配器执行；未发送提示词、未生成图片、未读写中转消息', checks: ['logged-in detection', 'image-tool selection', 'selected mode guard', 'modern send control lookup', 'composer left empty'] };
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
  } finally {
    const target = await tool.target(); if (target) await tool.hub.closeTab(target.targetId);
    fs.rmSync(tool.file, { force: true });
  }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
