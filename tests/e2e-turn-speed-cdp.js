'use strict';
// Real isolated Electron UI; provider records are synthetic, not a Fast
// benchmark. Values here verify token/time pairing and display state only.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-turn-speed-'));
const data = path.join(root, 'data'), work = path.join(root, 'work');
const out = path.resolve('artifacts', '20261005-hub-turn-speed-codex1-' + Date.now());
for (const dir of [data, work, out]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ providers: { codex: {
  subscription_profiles: ['default', 'second'].map(id => ({ id, label: id, home: path.join(root, 'codex-' + id) }))
} } }));
const base = Date.now() - 60000, at = s => new Date(base + s * 1000).toISOString();
const codexRows = [
  { type: 'event_msg', timestamp: at(0), payload: { type: 'task_started' } },
  { type: 'turn_context', payload: { model: 'gpt-test', service_tier: 'default' } },
  { type: 'event_msg', timestamp: at(9), payload: { type: 'token_count', info: {
    last_token_usage: { input_tokens: 100, output_tokens: 300, reasoning_output_tokens: 100 },
    total_token_usage: { input_tokens: 100, output_tokens: 300, reasoning_output_tokens: 100 } } } },
  { type: 'event_msg', timestamp: at(10), payload: { type: 'task_complete', last_agent_message: '这是已经完成的一轮回复。均速和速度档放在头部同一排，完整过程仍可展开。' } }
];
const codexFile = path.join(work, 'codex-rollout.jsonl');
fs.writeFileSync(codexFile, [{ type: 'session_meta', payload: { id: '019eaaaa-bbbb-7ccc-8ddd-123456789abc', cwd: work, originator: 'codex_cli_rs' } },
  ...codexRows].map(JSON.stringify).join('\n') + '\n');
const claudeRows = [
  { type: 'user', uuid: 'u', timestamp: at(11), message: { content: '请解释结果' } },
  { type: 'assistant', uuid: 'a', timestamp: at(21), message: { id: 'a', model: 'claude-opus-5',
    content: [{ type: 'text', text: '这是 Claude 的正常回复。' }], stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 200, speed: 'fast' } } }
];
const claudeFile = path.join(work, 'claude-transcript.jsonl');
fs.writeFileSync(claudeFile, claudeRows.map(JSON.stringify).join('\n') + '\n');
(async () => {
  let hub, client;
  const evidence = { checks: [], boundary: '隔离真实 Electron；模拟提供方记录验证计算与界面，无真实 AI 请求，不证明 Fast 实际加速幅度' };
  try {
    const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => {
      const p = s.address().port; s.close(() => resolve(p)); }); });
    hub = await launchIsolatedHub({ dataDir: data, port, label: 'turn-speed', extraEnv: {
      CLAUDE_HUB_E2E: '1', CLAUDE_HUB_AGENT_RUNTIME: 'pty', AI_HUB_WORKSPACE_ROOT: root,
      CODEX_HOME: path.join(root, 'codex-default'), CLAUDE_CONFIG_DIR: path.join(root, 'claude') } });
    client = await connectFirstPage(hub);
    async function until(expr) { const end = Date.now() + 25000;
      while (!await client.eval(`Boolean(${expr})`)) { if (Date.now() > end) throw Error('timeout: ' + expr); await _waitMs(100); } }
    async function click(selector) {
      const point = await client.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const r=e.getBoundingClientRect();
        const x=r.x+r.width/2,y=r.y+r.height/2;if(!r.width||!r.height||!e.contains(document.elementFromPoint(x,y)))throw Error('not clickable '+${JSON.stringify(selector)});return{x,y};})()`);
      for (const type of ['mousePressed', 'mouseReleased']) await client.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
    }
    await until('!!window.__hubE2E');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
    await client.eval(`(async()=>{window.__hubE2E.addFakeSession({id:'speed-codex',title:'速度与档位',kind:'codex',cwd:${JSON.stringify(work)},transcriptPath:${JSON.stringify(codexFile)},status:'idle',codexSpeedTier:'fast'});
      await window.__hubE2E.selectSession('speed-codex');})()`);
    await until(`!!terminalCache.get('speed-codex') && activeSessionId==='speed-codex'`);
    await _waitMs(500);
    await until(`document.querySelector('.turn-speed')?.textContent.includes('30 tok/s')`);
    assert(await client.eval(`document.querySelector('.turn-speed').textContent.includes('标准')`));
    assert(await client.eval(`document.querySelector('.session-turn-speed').textContent.includes('当前快速')`));
    evidence.checks.push('真实卡片显示标准档该轮均速30，当前快速设置与历史档位明确分开');
    await client.eval(`document.querySelector('.floating-input-box').textContent='保留草稿';sessions.get('speed-codex').codexSpeedTier='standard';
      document.querySelector('.floating-input-bar')._paintComposer(sessions.get('speed-codex'));`);
    await until(`document.querySelector('.session-turn-speed').textContent.includes('当前标准')`);
    assert(await client.eval(`document.querySelector('.turn-speed').textContent.includes('标准') && document.querySelector('.floating-input-box').textContent==='保留草稿'`));
    await click('#btn-backstage');
    await until(`!!document.querySelector('.turn-speed')`);
    assert(await client.eval(`!document.querySelector('.session-turn-speed').hidden && document.querySelector('.session-turn-speed').textContent.includes('30 tok/s')`));
    fs.appendFileSync(codexFile, [
      { type: 'event_msg', timestamp: at(20), payload: { type: 'task_started' } },
      { type: 'event_msg', timestamp: at(39), payload: { type: 'token_count', info: {
        last_token_usage: { input_tokens: 100, output_tokens: 300, reasoning_output_tokens: 100 },
        total_token_usage: { input_tokens: 200, output_tokens: 600, reasoning_output_tokens: 200 } } } },
      { type: 'event_msg', timestamp: at(40), payload: { type: 'task_complete', last_agent_message: '后台运行时完成的新回复' } }
    ].map(JSON.stringify).join('\n') + '\n');
    await client.eval(`ipcRenderer.emit('turn-complete-event',{}, {hubSessionId:'speed-codex',kind:'codex',transcriptPath:${JSON.stringify(codexFile)},text:'后台运行时完成的新回复',completedAt:${base+40000}})`);
    await until(`document.querySelector('.session-turn-speed').textContent.includes('15 tok/s')`);
    evidence.checks.push('后台直接完成新一轮时，复用完成事件读真实隔离转录，顶部均速更新为15，无额外轮询或切回卡片');
    evidence.checks.push('切换标准后同步当前档位，后台顶部保留同一轮均速，草稿不变');
    await click('#btn-backstage');
    await until(`!!document.querySelector('.turn-speed')`);
    await client.eval('themeController.setTheme("dark")');
    assert(await client.eval(`getComputedStyle(document.querySelector('.turn-speed')).color!==getComputedStyle(document.querySelector('#msg-overlay')).backgroundColor`));
    await client.eval('themeController.setTheme("codex")');
    await client.eval(`(async()=>{window.__hubE2E.addFakeSession({id:'speed-claude',kind:'claude',title:'Claude速度',cwd:${JSON.stringify(work)},transcriptPath:${JSON.stringify(claudeFile)},status:'idle',fastMode:false,currentModel:{id:'claude-opus-5'}});
      await window.__hubE2E.selectSession('speed-claude');})()`);
    await until(`!!terminalCache.get('speed-claude') && activeSessionId==='speed-claude'`);
    await _waitMs(500);
    assert(!await client.eval(`document.querySelector('.session-turn-speed').textContent.includes('30 tok/s')`));
    await until(`document.querySelector('.turn-speed')?.textContent.includes('20 tok/s')`);
    assert(await client.eval(`document.querySelector('.turn-speed').textContent.includes('快速')`));
    evidence.checks.push('Claude快档均速20可见；跨会话切换不串用Codex数据；浅深主题可读');
    await click('[data-display-mode="phone"]');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await _waitMs(300);
    const phone = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, 'phone.png'), Buffer.from(phone.data, 'base64'));
    const geometry = await client.eval(`(()=>{const r=document.querySelector('.turn-speed').getBoundingClientRect();return{x:r.x,right:r.right,width:r.width,viewport:innerWidth};})()`);
    assert(geometry.width > 0 && geometry.x >= 0 && geometry.right <= geometry.viewport, JSON.stringify(geometry));
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
    await click('[data-display-mode="desktop"]');
    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, 'desktop.png'), Buffer.from(shot.data, 'base64'));
    await client.eval(`window._mountSessionTurnCard('speed-claude',{id:'unknown',role:'assistant',text:'数据不足的回复',ts:${base+22000},tsEnd:${base+23000},nativeOutcome:'completed'},{kind:'claude'})`);
    assert(!await client.eval(`document.querySelector('.session-turn-speed').textContent.includes('20 tok/s')`));
    evidence.checks.push('390像素手机中指标可见；后续回复缺数据时隐藏旧均速，不用字符数猜测');
    evidence.ok = true; evidence.version = require('../package.json').version;
    console.log(JSON.stringify({ ...evidence, out }, null, 2));
  } finally { fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
    await client?.close(); if (hub) await gracefulQuit(hub); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
