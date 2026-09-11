'use strict';
// Read-only protocol capability probe; no model prompt or credential is sent.
const { AcpClient } = require('../main/acp-client');
const fs = require('fs');
const path = require('path');
const root = process.env.ACP_TOOLS_ROOT;
if (!root) throw new Error('Set ACP_TOOLS_ROOT to the separately installed toolchain');
const output = path.resolve(__dirname, '../artifacts/acp');
fs.mkdirSync(output, { recursive: true });
async function main() {
  const results = [];
  for (const [kind, args] of [
    ['qwen', [path.join(root, 'node_modules/@qwen-code/qwen-code/cli-entry.js'), '--acp']],
    ['deepseek', [path.join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'acp']],
    ['glm', [path.join(root, 'node_modules/zcode-acp-server/dist/index.js')]],
  ]) {
    const home = path.join(root, 'probe-home', kind);
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: path.join(root, 'dsh-home'),
      ZCODE_BIN: path.join(root, 'zcode-extracted/resources/glm/zcode.cjs'), ZCODE_ACP_RUNTIME: 'node',
      ZCODE_NODE: process.execPath, ZCODE_ACP_REMOTE: '0' };
    for (const key of Object.keys(env)) if (/API_KEY|AUTH_TOKEN|CODEX_THREAD|CLAUDE_HUB_TOKEN|CLAUDE_HUB_PORT/.test(key)) delete env[key];
    const diagnostics = [];
    const client = new AcpClient({ command: process.execPath, args, env, cwd: home, timeoutMs: 20000 });
    client.on('diagnostic', text => diagnostics.push(text));
    try {
      const initialized = await client.start();
      results.push({ kind, initialized });
    } catch (error) { results.push({ kind, error: error.message, diagnostics: diagnostics.slice(-3) }); }
    finally { client.close(); }
  }
  fs.writeFileSync(path.join(output, 'native-capabilities.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  if (results.some(r => r.error)) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
