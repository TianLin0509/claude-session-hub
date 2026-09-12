'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { AcpSession } = require('../core/acp-session');
const { buildAcpOptions } = require('../core/acp-profiles');
const root = process.env.ACP_TOOLS_ROOT;
const keyFile = process.env.ACP_TEST_KEY_FILE;
if (!root || !keyFile) throw new Error('ACP_TOOLS_ROOT and ACP_TEST_KEY_FILE required');
const data = path.join(root, 'real-smoke');
const artifact = path.resolve(__dirname, '../artifacts/acp');
fs.mkdirSync(artifact, { recursive: true });
const key = fs.readFileSync(keyFile, 'utf8').trim();
const providers = {
  qwen: { entryPath: path.join(root, 'node_modules/@qwen-code/qwen-code/cli-entry.js'), model: 'qwen3.8-max' },
  'deepseek-acp': { entryPath: path.join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), model: 'deepseek-v4-pro',
    bridgePath: process.env.ACP_DSH_RICH === '1' ? path.join(root, 'node_modules/@openma/deepseek-harness-acp') : null },
  glm: { entryPath: path.join(root, 'node_modules/zcode-acp-server/dist/index.js'),
    backendPath: path.join(root, 'zcode-extracted/resources/glm/zcode.cjs'), model: 'glm-5.2' },
};
async function run(kind) {
  const cwd = path.join(data, 'workspace', kind);
  fs.mkdirSync(cwd, { recursive: true });
  const nonce = randomUUID();
  fs.writeFileSync(path.join(cwd, 'probe.txt'), nonce);
  const options = buildAcpOptions(kind, { id: kind + '-smoke-' + Date.now(), cwd },
    { acp: { apiKey: key, nodePath: process.execPath, providers } }, data);
  const session = new AcpSession(options);
  const evidence = { kind, model: providers[kind].model, events: [], diagnostics: [] };
  session.on('diagnostic', text => evidence.diagnostics.push(text.slice(-1200)));
  session.on('lifecycle', event => evidence.events.push({ type: event.type, turnId: event.turnId }));
  session.on('state', runtime => {
    for (const request of runtime.requests) {
      const choice = request.params.options?.find(o => o.kind === 'allow_once');
      if (!choice || request.answered) continue;
      request.answered = true;
      session.reply(request.id, { outcome: { outcome: 'selected', optionId: choice.optionId } }, runtime.epoch)
        .catch(error => evidence.diagnostics.push(error.message));
    }
  });
  let timeout;
  try {
    await session.start();
    session.client.on('notification', m => { (evidence.updates ||= []).push(m); });
    evidence.configOptions = session.configOptions;
    const work = (async () => {
      await session.send('Use your native file reading tool to read probe.txt in the current directory. Return only its exact contents. Do not change any files.');
      await session.idle(90000);
      evidence.text = session.finalText();
      evidence.outcome = session.runtime.state;
      evidence.toolCalls = session.readTranscript({}).flatMap(c => c.toolCalls || []).length;
      evidence.transcript = session.readTranscript({});
      evidence.ok = evidence.text.includes(nonce) && evidence.outcome === 'completed' && evidence.toolCalls > 0;
    })();
    await Promise.race([work, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Real smoke timeout')), 100000); })]);
  } catch (error) { evidence.error = error.message; evidence.details = error.details;
    evidence.configOptions = session.configOptions; evidence.models = session.models; evidence.ok = false; }
  finally { clearTimeout(timeout); session.kill(); }
  const safe = JSON.stringify(evidence, null, 2).split(key).join('[REDACTED]');
  fs.writeFileSync(path.join(artifact, kind + '-real-smoke.json'), safe);
  console.log(JSON.stringify({ kind, ok: evidence.ok, error: evidence.error, outcome: evidence.outcome,
    toolCalls: evidence.toolCalls, diagnostics: evidence.diagnostics.slice(-2) }));
  return evidence.ok;
}
(async () => {
  let success = true;
  for (const kind of (process.argv[2] ? [process.argv[2]] : Object.keys(providers))) success = await run(kind) && success;
  if (!success) process.exitCode = 1;
})().catch(error => { console.error(error.message.split(key).join('[REDACTED]')); process.exitCode = 1; });
