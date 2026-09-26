'use strict';
// Read product DOM in one disposable page; no prompt or send operation.
const fs = require('fs'), path = require('path');
const { HubChrome } = require('../core/hub-chrome');
const { BrowserTool } = require('../core/hub-browser-tool');
(async () => {
  const root = process.env.HUB_CHROME_ROOT;
  if (!root) throw Error('An explicit browser root is required');
  const binding = { root, id: 'composer-inspection-codex1', tool: 'images', identity: 'main', playwright: require.resolve('playwright', { paths: ['C:/DevTools/playwright-cli-0.1.19/node_modules'] }) };
  const hub = new HubChrome({ root });
  const tool = new BrowserTool(binding, { hub });
  try {
    await tool.open('https://chatgpt.com/');
    const result = await tool.withPage(async page => {
      await page.locator('[contenteditable=true][data-composer-markdown],#prompt-textarea').waitFor({ timeout: 45000 });
      await page.locator('button[aria-label="Add files and more"],[data-testid="composer-plus-btn"]').click();
      const image = page.getByText(/^(Create image|Create images|创建图片|创建图像|生成图片)$/);
      await image.first().waitFor({ state: 'visible', timeout: 15000 });
      const options = await image.evaluateAll(nodes => nodes.map(n => ({tag:n.tagName,attrs:[...n.attributes].map(a=>[a.name,a.value]),parents:[n.parentElement,n.parentElement?.parentElement,n.parentElement?.parentElement?.parentElement].filter(Boolean).map(p=>({tag:p.tagName,attrs:[...p.attributes].map(a=>[a.name,a.value])}))})));
      const count = await image.count();
      if (count === 1) await image.click();
      const composer = await page.locator('[data-composer-body],form:has(#prompt-textarea)').evaluateAll(nodes => nodes.map(n => ({
        buttons: [...n.querySelectorAll('button')].map(b => ({ label: b.getAttribute('aria-label'), text: b.innerText })),
        pills: [...n.querySelectorAll('[data-inline-selection-pill],[data-system-hint-type]')].map(p => ({ text: p.innerText, attributes: [...p.attributes].map(a => [a.name, a.value]) })),
      })));
      return { options, selectedImageTool: count === 1, composer };
    });
    const out = path.resolve('artifacts/chatgpt-composer-dom.json');
    fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    // Only our target is closed. Keep the user's shared Chrome and all existing pages.
    const target = await tool.target(); if (target) await hub.closeTab(target.targetId);
    fs.rmSync(tool.file, { force: true });
  }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
