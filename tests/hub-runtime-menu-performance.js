'use strict';
// Controlled workload in the real renderer; no live model requests.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
(async () => {
  let hub, client;
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(os.tmpdir(), `hub-runtime-menu-${process.pid}-${Date.now()}`), port: await port(), label: 'runtime-menu-perf', extraEnv: { CLAUDE_HUB_E2E: '1' } });
    client = await connectFirstPage(hub);
    for (let i = 0; i < 150; i++) {
      if (await client.eval('typeof sessionSplit !== "undefined" && !!sessionSplit && !!window.__hubE2E')) break;
      await delay(200);
    }
    const result = await client.eval(`(async () => {
      const now = Date.now();
      window.__hubE2E.addFakeSessions(Array.from({length:900}, (_, i) => ({ id:'runtime-menu-'+i, title:'会话 '+i, kind:'codex', status:'idle', createdAt:now, lastMessageTime:now })));
      await window.__hubE2E.selectSession('runtime-menu-0');
      const original = document.createElement;
      let optionsCreated = 0;
      document.createElement = function(tag, ...args) { if(tag === 'option') optionsCreated++; return original.call(this, tag, ...args); };
      const measure = () => {
        optionsCreated = 0;
        const started = performance.now();
        for(let i=0;i<50;i++) { sessions.get('runtime-menu-1').status = i%2 ? 'running' : 'idle'; sessionSplit.sync(); }
        return { updates:50, optionsCreated, elapsedMs:performance.now()-started };
      };
      try {
        const single = measure();
        await sessionSplit.setLayout('two');
        const split = measure();
        sessions.get('runtime-menu-1').title = '已改名'; sessionSplit.sync();
        const renamed = [...document.querySelector('.session-pane-right select').options].find(o=>o.value==='runtime-menu-1')?.textContent;
        sessions.get('runtime-menu-1').status='dormant'; sessionSplit.sync();
        const dormant = [...document.querySelector('.session-pane-right select').options].find(o=>o.value==='runtime-menu-1')?.textContent;
        await sessionSplit.setLayout('single');
        return { sessionCount:sessions.size, single, split, renamed, dormant };
      } finally { document.createElement = original; }
    })()`);
    const target = path.resolve(process.argv[2] || 'artifacts/20261004-hub-runtime-menu-codex1.json');
    fs.mkdirSync(path.dirname(target), { recursive:true }); fs.writeFileSync(target, JSON.stringify(result,null,2),'utf8');
    console.log(JSON.stringify(result));
  } finally { await client?.close(); if(hub) await gracefulQuit(hub); }
})().catch(error => { console.error(error); process.exitCode=1; });
