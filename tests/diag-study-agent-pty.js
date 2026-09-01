'use strict';
// tests/diag-study-agent-pty.js — 诊断：把学习 Agent 的 PTY 内容打出来看
//   node tests/diag-study-agent-pty.js [author|reviewer]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const ROLE = process.argv[2] || 'reviewer';
const PORT = Number(process.env.DIAG_PORT || 9337);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-diag-'));
  const studyRoot = path.join(dataDir, 'agent-study');
  fs.mkdirSync(path.join(studyRoot, 'days'), { recursive: true });
  fs.writeFileSync(path.join(studyRoot, 'PLAN.md'), ['| # | 主题 |', '|---|---|', '| L1 | 冒烟 |'].join('\n'), 'utf8');

  let hub = null; let page = null;
  try {
    hub = await launchIsolatedHub({ dataDir, port: PORT, label: 'diag', extraEnv: { AGENT_STUDY_DIR: studyRoot }, windowMode: 'visible' });
    page = await connectFirstPage(hub);
    await page.eval('new Promise(r=>setTimeout(r,2500))');

    const ens = await page.eval(`require('electron').ipcRenderer.invoke('study:ensure-session', ${JSON.stringify({ role: ROLE })})`);
    console.log('ensure:', JSON.stringify(ens && { ok: ens.ok, sessionId: ens.sessionId, err: ens.error }));
    if (!ens || !ens.ok) return;
    const sid = ens.sessionId;

    const dump = async (tag) => {
      const snap = await page.eval(`require('electron').ipcRenderer.invoke('get-session-buffer-snapshot', ${JSON.stringify(sid)})`).catch((e) => ({ text: 'ERR ' + e.message }));
      const snapLen = (typeof snap === 'string' ? snap : String((snap && snap.text) || '')).length;
      const raw = await page.eval(`require('electron').ipcRenderer.invoke('debug:get-session-buffer', ${JSON.stringify(sid)})`).catch((e) => 'ERR ' + e.message);
      const text = String(raw || '');
      console.log(`\n===== ${tag} · snapshot=${snapLen} raw=${text.length} =====`);
      console.log(JSON.stringify(text.slice(-1400)));
    };

    await sleep(12000); await dump('启动 12s');
    await sleep(20000); await dump('启动 32s');

    const ask = await page.eval(`require('electron').ipcRenderer.invoke('study:ask', ${JSON.stringify({ role: ROLE, text: '请只回复这一个词：DIAGPONG' })})`);
    console.log('\nask:', JSON.stringify(ask && { ok: ask.ok, err: ask.error, msg: ask.message }));

    for (const s of [15000, 20000, 25000, 30000, 40000]) {
      await sleep(s); await dump(`发送后累计 ${(s / 1000)}s+`);
    }

    const st = await page.eval(`require('electron').ipcRenderer.invoke('study:state')`);
    console.log('\nstate.agents:', JSON.stringify(st && st.agents));
  } catch (e) {
    console.error('诊断异常：', e && e.message);
  } finally {
    try { if (page && page.close) page.close(); } catch {}
    try { if (hub) await gracefulQuit(hub); } catch {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
}
main();
