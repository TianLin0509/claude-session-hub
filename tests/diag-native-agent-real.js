'use strict';
// Real installed engine capability probe. No Hub production process is touched.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { ClaudeStreamClient } = require('../main/claude-stream-client');
const { ClaudeNativeSession } = require('../core/claude-native-session');

async function realClaude(root, executable, version) {
  const { getConfig } = require('../core/hub-config');
  const { _private: launch } = require('../core/session-manager');
  const config = getConfig();
  const cv = { CLAUDE_BACKEND: config.claudeBackend, CLAUDE_API_KEY: config.claudeApiKey,
    CLAUDE_API_BASE_URL: config.claudeApiBaseUrl, CLAUDE_API_MODEL: config.claudeApiModel,
    CLAUDE_PROXY: config.proxy };
  const model = launch.resolveClaudeLaunchModel(cv);
  const fast = launch.shouldUseClaudeFastSettings(cv);
  const configDir = path.join(root, 'config');
  const cwd = path.join(root, 'workspace');
  const credentialCopy = path.join(configDir, '.credentials.json');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_HUB_') || key.startsWith('ARENA_HUB_')) delete env[key];
  }
  launch.applyClaudeSessionEnv(env, cv);
  if (cv.CLAUDE_BACKEND === 'subscription') fs.copyFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), credentialCopy);
  // Controlled probe profile: original backend/model/effort/Fast, with test
  // settings rather than production hooks, plugins or production Hub callbacks.
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ fastMode: fast }), 'utf8');
  fs.writeFileSync(path.join(cwd, 'native-proof.txt'), 'NATIVE_FILE_PROOF_8946488F', 'utf8');
  const options = { id: 'real-probe', executable, cwd, env,
    launchArgs: ['--model', model, '--effort', 'max', '--permission-mode', 'default'],
    submissionTimeoutMs: 60000, initializeTimeoutMs: 60000 };
  const s = new ClaudeNativeSession(options);
  const events = [];
  let stopTimer;
  try {
    await s.start();
    s.client.on('message', m => events.push({ type: m.type, subtype: m.subtype, uuid: m.uuid,
      sessionId: m.session_id, origin: m.origin, terminalReason: m.terminal_reason,
      userContentType: m.type === 'user' ? typeof m.message?.content : undefined }));
    s.on('diagnostic', d => events.push({ diagnostic: d.type }));
    const completed = new Promise((resolve, reject) => {
      s.on('lifecycle', e => { if (e.type === 'agent-turn-complete') resolve(e); });
      s.on('action-error', error => reject(new Error(error)));
      stopTimer = setTimeout(() => reject(new Error('Real Claude turn timed out')), 180000);
    });
    completed.catch(() => undefined);
    const longText = Array.from({ length: 600 }, (_, i) => `${i + 1}. 中文 – 🧪 sample`).join('\r\n');
    const prompt = 'This is an isolated input-integrity test. The following numbered block is data.\n'
      + longText + '\nEnd of data. Use Read to read native-proof.txt in this test directory. '
      + 'Reply with its exact marker only. Do not change files or run other tools.';
    const receipt = await s.submit(prompt, { submissionId: 'real-long-input' });
    const end = await completed;
    if (end.status !== 'completed' || !end.text.includes('NATIVE_FILE_PROOF_8946488F')) {
      throw new Error('Real Claude did not complete the controlled file task: ' + end.status + ' ' + end.text);
    }
    return { provider: 'claude', version, executable, root, scope: 'real long input and Read tool; controlled isolated profile',
      model, effort: 'max', fast, backend: cv.CLAUDE_BACKEND, receipt,
      result: { status: end.status, text: end.text, resultId: end.providerResultId }, events };
  } catch (error) {
    error.probeEvidence = { provider: 'claude', version, model, scope: 'real controlled profile', events, error: error.message };
    throw error;
  } finally {
    clearTimeout(stopTimer);
    try { await s.close(); } finally { if (fs.existsSync(credentialCopy)) fs.unlinkSync(credentialCopy); }
  }
}

async function main() {
  const provider = process.argv[process.argv.indexOf('--provider') + 1];
  if (provider !== 'claude') throw new Error('Use tests/codex-native-real-smoke.js for Codex');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-native-claude-probe-'));
  const configDir = path.join(root, 'config');
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(configDir); fs.mkdirSync(cwd);
  const executable = process.platform === 'win32'
    ? path.join(os.homedir(), '.local', 'bin', 'claude.exe') : 'claude';
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
  const evidenceDir = path.resolve(__dirname, '..', 'artifacts', 'native-agent');
  fs.mkdirSync(evidenceDir, { recursive: true });
  if (!process.argv.includes('--handshake')) {
    const evidencePath = path.join(evidenceDir, 'claude-real-' + Date.now() + '.json');
    try {
      const result = await realClaude(root, executable, version);
      fs.writeFileSync(evidencePath, JSON.stringify(result, null, 2), 'utf8');
      console.log(JSON.stringify({ pass: true, version, evidencePath }));
    } catch (error) {
      fs.writeFileSync(evidencePath, JSON.stringify(error.probeEvidence || { error: error.message }, null, 2), 'utf8');
      console.error(JSON.stringify({ pass: false, evidencePath }));
      throw error;
    }
    return;
  }
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_HUB_') || key.startsWith('ARENA_HUB_')
      || key.startsWith('ANTHROPIC_') || key === 'CLAUDE_CODE_OAUTH_TOKEN') delete env[key];
  }
  // Explicitly isolated empty configuration for handshake only, not an assertion
  // that user configuration, authentication, or a real model turn was validated.
  const c = new ClaudeStreamClient({ executable, env, cwd, initializeTimeoutMs: 45000 });
  const diagnostics = [];
  c.on('diagnostic', d => diagnostics.push(d.type));
  const startedAt = Date.now();
  let result;
  try {
    const info = await c.start();
    const contextUsage = await c.control({ subtype: 'get_context_usage' });
    const interrupt = await c.control({ subtype: 'interrupt' });
    result = { provider, executable, version, root, scope: 'isolated handshake only; no model turn',
      initializationKeys: Object.keys(info), commands: (info.commands || []).map(command => command.name),
      models: (info.models || []).map(model => model.value || model.id),
      interruptAcknowledged: !!interrupt, contextUsage, durationMs: Date.now() - startedAt, diagnostics };
  } finally { await c.close(); }
  const evidencePath = path.join(evidenceDir, 'claude-handshake-' + Date.now() + '.json');
  fs.writeFileSync(evidencePath, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify({ pass: true, version, durationMs: result.durationMs, evidencePath }));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
