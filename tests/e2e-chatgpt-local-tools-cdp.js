'use strict';
// Real model acceptance. Browser-only is a BLOCKED result, never a pass.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const assert = require('node:assert/strict');
const { requireWebTools, webStatus } = require('../core/chatgpt-web-integration');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const model = 'chatgpt-web/high';
const out = path.resolve(__dirname, '../artifacts', `20260911-chatgpt-real-codex1-${Date.now()}`);

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const result = { status: 'BLOCKED', model, checks: [] };
  const report = () => fs.writeFileSync(path.join(out, '20260911-chatgpt-real-evidence-codex1.json'), JSON.stringify(result, null, 2));
  let config;
  try {
    config = requireWebTools(model);
    const status = await webStatus();
    if (!status.online) throw new Error(status.message);
  } catch (error) {
    result.reason = error.message; report();
    console.log(JSON.stringify({ ...result, out }));
    process.exitCode = 2;
    return;
  }
  delete process.env.ELECTRON_RUN_AS_NODE;
  const source = require('../core/chatgpt-isolation').isolatedPaths().codexHome;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-chatgpt-real-'));
  const home = path.join(temp, 'codex-home'), cwd = path.join(temp, 'workspace');
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(temp, 'runtime'));
  const publicConfig = Object.fromEntries(['host','port','mode','browserInteractionMode','solAvailable','proAvailable','zeroRiskProEnabled'].map(key => [key, config[key]]));
  fs.writeFileSync(path.join(temp, 'runtime', 'config.json'), JSON.stringify(publicConfig));
  fs.writeFileSync(path.join(temp, 'isolation.json'), JSON.stringify({version:1,purpose:'ai-hub-chatgpt-only',port:config.port}));
  const auth = path.join(home, 'auth.json');
  const hashes = {};
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  for (const name of ['auth.json', 'config.toml']) hashes[name] = hash(path.join(source, name));
  const marker = 'local-file-' + crypto.randomBytes(16).toString('hex');
  const input = marker + '\n';
  fs.writeFileSync(path.join(cwd, 'input.txt'), input);
  let hub, cdp;
  try {
  fs.copyFileSync(path.join(source, 'auth.json'), auth);
  if (fs.existsSync(path.join(source, 'models_cache.json'))) fs.copyFileSync(path.join(source, 'models_cache.json'), path.join(home, 'models_cache.json'));
  fs.writeFileSync(path.join(home, 'config.toml'), `model="${model}"\nmodel_reasoning_effort="high"\nopenai_base_url="http://127.0.0.1:${config.port}/v1"\n`);
    const server = require('net').createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    hub = await launchIsolatedHub({ dataDir: path.join(temp, 'data'), port, label: 'chatgpt-real', windowMode: 'hidden', extraEnv: { CODEX_HOME: home, AI_HUB_CHATGPT_ROOT: temp, AI_HUB_WORKSPACE_ROOT: temp } });
    cdp = await connectFirstPage(hub);
    const until = async (expression, timeout = 300000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await cdp.eval(expression)) return;
        if (result.sessionId) {
          const state = await cdp.eval(`sessions.get(${JSON.stringify(result.sessionId)})?.nativeRuntime`);
          if (state?.configurationError || state?.connection === 'disconnected' || state?.state === 'failed') throw new Error(state.configurationError || state.reason || 'native turn failed');
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      throw new Error('真实 ChatGPT 本地工具验收超时');
    };
    await until('typeof sessions !== "undefined"', 30000);
    const session = await cdp.eval(`ipcRenderer.invoke('create-session', ${JSON.stringify({ kind: 'chatgpt', opts: { cwd, model, effort: 'high', mcpProfile: 'none', codexSpeedTier: 'inherit' } })})`);
    result.sessionId = session.id;
    const sid = JSON.stringify(session.id);
    await until(`sessions.get(${sid})?.nativeRuntime?.state === 'idle'`);
    await cdp.eval(`document.querySelector('.session-item[data-session-id="${session.id}"]').click()`);
    await until('!!document.querySelector(".floating-input-box")', 30000);
    const prompt = '这是隔离目录中的本地工具验收。只操作当前工作目录：先读取 input.txt；实际执行命令计算 input.txt 的 SHA256；将 input.txt 内容转成大写写入 output.txt，并将计算出的 SHA256 单独写入 sha256.txt。不要猜测文件内容，不要访问其他目录。完成后简要报告读取、命令执行、文件修改三项结果。';
    await cdp.eval(`(() => { const box=document.querySelector('.floating-input-box'); box.textContent=${JSON.stringify(prompt)}; box.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('.floating-input-send').click(); })()`);
    await until(`sessions.get(${sid})?.nativeRuntime?.state === 'completed'`);
    assert.equal(fs.readFileSync(path.join(cwd, 'output.txt'), 'utf8').trim(), marker.toUpperCase());
    const expectedHash = crypto.createHash('sha256').update(input).digest('hex');
    assert.equal(fs.readFileSync(path.join(cwd, 'sha256.txt'), 'utf8').trim().toLowerCase(), expectedHash);
    const sessionRoot = path.join(home, 'sessions');
    const records = fs.readdirSync(sessionRoot, { recursive: true }).filter(file => file.endsWith('.jsonl'))
      .flatMap(file => fs.readFileSync(path.join(sessionRoot, file), 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)));
    const calls = records.filter(row => row.type === 'response_item' && row.payload?.type === 'function_call').map(row => row.payload);
    const outputIds = new Set(records.filter(row => row.payload?.type === 'function_call_output').map(row => row.payload.call_id));
    assert(calls.some(call => /exec_command|shell_command|(?:^|\.)exec$|(?:^|\.)shell$/.test(call.name) && outputIds.has(call.call_id)), '必须有真实命令工具调用及结果回执');
    result.toolNames = calls.map(call => call.name);
    result.checks = ['unseen local file read', 'command SHA256 and native tool receipt', 'local file modification'];
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, '20260911-chatgpt-real-codex1.png'), Buffer.from(shot.data, 'base64'));
    result.status = 'PASS';
  } catch (error) {
    result.status = 'FAIL'; result.reason = error.message; process.exitCode = 1;
  } finally {
    if (cdp) await cdp.close();
    try { if (hub) result.exit = await gracefulQuit(hub); }
    catch (error) { result.status = 'FAIL'; result.teardownError = error.message; process.exitCode = 1; }
    finally {
      if (fs.existsSync(auth)) fs.unlinkSync(auth);
      result.originalUnchanged = Object.entries(hashes).every(([name, before]) => hash(path.join(source, name)) === before);
      if (!result.originalUnchanged) { result.status = 'FAIL'; process.exitCode = 1; }
      report(); console.log(JSON.stringify({ ...result, out }));
    }
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
