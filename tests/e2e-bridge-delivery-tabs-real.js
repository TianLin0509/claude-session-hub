'use strict';
// 复现回执重投的根因（2026-10-18，家里 v1.6.517 真机 Q-1018-07）：
//   node tests/e2e-bridge-delivery-tabs-real.js [--out <目录>]
// 隔离 Hub + 真 Claude Code（CodeAgent 替身，Haiku）：经通道投递用的同一个发送入口（session:send-prompt，等 CLI 就绪、带提交编号）
// 发一段带制表符的回执。Claude 把制表符换成空格后提交，原生记录里这条消息已经在了，但发送入口回的是
// ok:false + sendStatus:'content-mismatch'（不带 unconfirmed / stuck / error）——投递方以前把它当「没发进去」每分钟重投。
// 再用 delivery-guard 的判定核对：这个回执现在按「内容已进会话」处理，原生记录核对也认得出这条回执。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const guard = require('../core/company-bridge/delivery-guard');

const STANDIN = path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd');
const argv = process.argv.slice(2);
const repo = path.resolve(__dirname, '..');
const out = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(repo, 'artifacts', '20261018-bridge-delivery-tabs-claude1'));
const j = JSON.stringify;
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(process.env.HUB_E2E_TMP || 'D:/Temp', 'hub-delivery-tabs-'));
  const t0 = Date.now(); const log = m => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
  const result = { passed: false, root, checks: [], scope: '隔离 Hub + 真 Claude Code（CodeAgent 替身，Haiku）+ 通道投递用的发送入口' };
  const check = (ok, label) => { assert.ok(ok, label); result.checks.push(label); log('✔ ' + label); };
  let hub, c;
  try {
    const cac = path.join(root, 'cac'); fs.mkdirSync(cac, { recursive: true });
    fs.copyFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json'), path.join(cac, '.credentials.json'));
    fs.writeFileSync(path.join(cac, '.claude.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true, skipDangerousModePermissionPrompt: true,
      hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true, hasSeenAutoModeEntryWarning: true, theme: 'dark', projects: {} }));
    fs.writeFileSync(path.join(cac, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
    fs.writeFileSync(path.join(cac, 'settings.json'), j({ model: 'haiku', permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }));
    const work = path.join(root, 'work'); fs.mkdirSync(work, { recursive: true });
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await freePort(), windowMode: 'background', label: 'delivery-tabs', allowExternalState: true,
      extraEnv: { CLAUDE_HUB_E2E: '1', DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', CLAUDE_HUB_AGENT_RUNTIME: 'pty', CLAUDE_HUB_HOME_DIR: path.join(root, 'hubhome'),
        HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'empty'),
        AI_HUB_CODEAGENT_COMMAND: STANDIN, AI_HUB_CODEAGENT_CONFIG_DIR: cac, CODEAGENT_STANDIN_MODEL: 'haiku' } });
    c = await connectFirstPage(hub);
    const until = async (label, read, timeout = 60000, every = 1000) => { let last; for (const end = Date.now() + timeout; Date.now() < end;) { try { last = await read(); } catch (e) { last = 'ERR ' + e.message; } if (last && !String(last).startsWith('ERR ')) return last; await _waitMs(every); } throw Error('timeout ' + label + ' last=' + j(last)); };
    await until('renderer', () => c.eval('typeof sessions!=="undefined" && location.href.includes("index.html")'), 90000, 300);
    const created = await c.eval(`require("electron").ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd: work, title: '收回执的会话' } })})`);
    const sid = created.id;
    const marker = `【公司回执 Q-1018-${randomBytes(2).toString('hex')} · 第 1 轮】`;
    const text = [marker, '', '下面是一张表（列之间是制表符）：', '参数\t取值\t单位', 'alpha\t0.01\t无', 'T\t1\tms', '', '——', '以上是端到端测试用的回执，请只回答一行：收到'].join('\n');
    const receipt = await c.eval(`require("electron").ipcRenderer.invoke("session:send-prompt", ${j({ sessionId: sid, text, clientSubmissionId: 'e2e-tabs-' + randomBytes(3).toString('hex'), waitForCliReady: true })})`);
    result.receipt = receipt;
    log('发送入口回执：' + j(receipt));
    const meta = await until('transcript bound', async () => (await c.eval('require("electron").ipcRenderer.invoke("get-sessions")')).find(x => x.id === sid && x.transcriptPath), 120000, 1000);
    const landed = await until('receipt in transcript', async () => guard.transcriptHasText(meta, marker) === true, 120000, 1000);
    const raw = fs.readFileSync(meta.transcriptPath, 'utf8');
    const line = raw.split('\n').find(l => l.includes(marker) && /"type"\s*:\s*"user"/.test(l)) || '';
    result.transcriptHasTab = line.includes('\\t');
    check(landed, '回执已经进了会话：原生记录里有一条用户消息带着编号和轮次标记');
    check(!result.transcriptHasTab, 'Claude 提交时把制表符换掉了（原生记录里那条消息不含制表符）');
    result.rootCause = receipt && receipt.ok === false && receipt.sendStatus === 'content-mismatch' && !receipt.unconfirmed && !receipt.error;
    if (result.rootCause) check(true, '复现根因：发送入口回 ok:false + content-mismatch（不带 unconfirmed / stuck / error），旧的投递判定会当成「没发进去」');
    else log('这一次发送入口没有报 content-mismatch（回执见上），根因未能在本机复现');
    check(guard.explicitFailure(receipt) === false, '新的投递判定：这个回执不算「明确没发进去」，不会重投');
    result.passed = true;
  } catch (error) {
    result.error = error && error.stack || String(error);
    console.error(result.error);
  } finally {
    try { c && c.close(); } catch {}
    if (hub) await gracefulQuit(hub).catch(() => {});
    fs.writeFileSync(path.join(out, '20261018-delivery-tabs-result-claude1.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, rootCause: !!result.rootCause, checks: result.checks.length, error: result.error ? String(result.error).split('\n')[0] : null }));
    if (!result.passed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
