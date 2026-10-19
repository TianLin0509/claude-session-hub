'use strict';
// Real isolated Electron -> SessionManager -> PowerShell -> child fixture.
// No company service, real account credentials, model request, or auth value is read back.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs: sleep } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const j = JSON.stringify;
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const out = path.resolve(__dirname, '../artifacts/20261019-auth-isolation-e2e-codex1.json');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-auth-isolation-'));
  const dataDir = path.join(root, 'data'), cwd = path.join(root, 'work');
  const personal = path.join(root, 'personal'), poolId = 'authfixture1';
  const pooled = path.join(dataDir, 'codeagent-pool', 'accounts', poolId);
  const GLM = 'GLM-5.2-WX-Auto', DS = 'deepseek-v4-flash-0731';
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, j(value)); };
  for (const [dir, model, account] of [[personal, GLM, 'fixture-personal'], [pooled, DS, 'fixture-pool']]) {
    write(path.join(dir, '.credentials.json'), { idaasOAuth: { accountId: account, xAuthToken: 'fixture-encrypted-token', expiresAt: 4e12 } });
    write(path.join(dir, 'settings.json'), { model, permissions: { defaultMode: 'probe' } });
    write(path.join(dir, '.cac.json'), { hasCompletedOnboarding: true, projects: {} });
    write(path.join(dir, 'hub-models.json'), { schema: 1, models: [model], defaultModel: model, at: new Date().toISOString() });
  }
  write(path.join(dataDir, 'codeagent-pool', 'personal-models.json'), { schema: 1, models: [GLM], defaultModel: GLM });
  write(path.join(dataDir, 'codeagent-pool', 'pool.json'), { schema: 1, accounts: [{ id: poolId, note: 'fixture', createdAt: new Date().toISOString() }] });
  fs.mkdirSync(cwd, { recursive: true });
  const childOutput = path.join(root, 'child-results.jsonl');
  const fixtureJs = path.join(root, 'auth-fixture.cjs'), fixtureCmd = path.join(root, 'auth-fixture.cmd');
  fs.writeFileSync(fixtureJs, `const fs=require('fs'),path=require('path');
const e=process.env, dir=e.CODEAGENT3_CONFIG_DIR;
const value={dir, session:e.CLAUDE_HUB_SESSION_ID, tokenPresent:!!e.CODEAGENT3_X_AUTH_TOKEN, guardPreserved:e.TOOL_GUARD_CODEAGENT3_DATA_DIR==='fixture-guard', proxyPreserved:e.HTTPS_PROXY==='http://127.0.0.1:9', certPreserved:e.SSL_CERT_FILE==='fixture-certificate.pem'};
fs.appendFileSync(${j(childOutput)},JSON.stringify(value)+'\\n');
console.log('AUTH-FIXTURE-COMPLETE');`);
  fs.writeFileSync(fixtureCmd, `@echo off\r\n"${process.execPath}" "${fixtureJs}"\r\n`);
  let hub, c;
  const result = { passed: false, scope: 'Real isolated Electron and child process; synthetic credentials; no company model request', root, checks: [] };
  try {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), label: 'auth-isolation', extraEnv: {
      AI_HUB_CODEAGENT_COMMAND: fixtureCmd, AI_HUB_CODEAGENT_CONFIG_DIR: personal,
      CODEAGENT3_X_AUTH_TOKEN: 'fixture-parent-token', TOOL_GUARD_CODEAGENT3_DATA_DIR: 'fixture-guard',
      HTTPS_PROXY: 'http://127.0.0.1:9', SSL_CERT_FILE: 'fixture-certificate.pem',
      AI_HUB_UPDATE_STARTUP_DELAY_MS: '600000', CLAUDE_HUB_BRIDGE_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
      AI_HUB_RULES_BASE_URL: 'http://127.0.0.1:9/hub-rules/',
    } });
    c = await connectFirstPage(hub);
    for (let i = 0; i < 120; i++) {
      if (await c.eval('typeof ipcRenderer !== "undefined" && typeof sessions !== "undefined"').catch(() => false)) break;
      await sleep(400);
    }
    const cases = [
      { name: 'personal', dir: personal, opts: {} },
      { name: 'pool', dir: pooled, opts: { codeagentAccount: 'pool', codeagentPoolPick: poolId } },
      { name: 'metadata-only', dir: personal, tokenPresent: true, opts: {}, prepare: () =>
        write(path.join(personal, '.credentials.json'), { idaasOAuth: { accountId: 'fixture-personal', expiresAt: 4e12 } }) },
    ];
    for (const row of cases) {
      row.prepare?.();
      const response = await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd, title: row.name, purpose: 'company-bridge', ...row.opts } })})`);
      assert.ok(response.id, j(response));
      let values = [];
      for (let i = 0; i < 100; i++) {
        try { values = fs.readFileSync(childOutput, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch {}
        if (values.some(v => v.session === response.id)) break;
        await sleep(300);
      }
      const observed = values.find(v => v.session === response.id);
      assert.ok(observed, `${row.name}: child must start with the selected config directory`);
      assert.deepEqual(observed, { dir: row.dir, session: response.id, tokenPresent: !!row.tokenPresent, guardPreserved: true, proxyPreserved: true, certPreserved: true });
      result.checks.push({ account: row.name, ...observed });
    }
    for (const [dir, model] of [[personal, GLM], [pooled, DS]]) {
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).model, model);
    }
    result.passed = true;
  } catch (error) { result.error = error.stack; throw error; }
  finally {
    if (c) c.close();
    if (hub) await gracefulQuit(hub).catch(() => {});
    fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, j(result));
    console.log(j({ passed: result.passed, checks: result.checks.length, out }));
  }
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
