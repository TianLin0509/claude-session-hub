'use strict';
// Controlled protocol load, not real-model performance or a GUI click benchmark.
const fs = require('fs'), path = require('path'), os = require('os');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const { createHash } = require('crypto');
const { ClaudeNativeSession } = require('../core/claude-native-session');
const { CodexNativeSession, pool } = require('../core/codex-native-session');
const { CodexAppServerClient } = require('../main/codex-app-server-client');
const { alive } = require('../core/native-session-ownership');
const ROOT = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 30000) {
  const end = Date.now() + timeout;
  while (!fn()) { if (Date.now() > end) throw new Error('Load test deadline exceeded'); await sleep(20); }
}
function samples(pids) {
  assert.ok(pids.every(Number.isInteger));
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-Process -Id ' + pids.join(',') + ' -ErrorAction Stop | Select-Object Id,CPU,WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress'],
  { windowsHide: true, encoding: 'utf8', timeout: 15000 }));
}
async function main() {
  const out = path.join(ROOT, 'artifacts/native-agent', 'load-' + Date.now()); fs.mkdirSync(out, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-load-'));
  const count = 20, observationMs = 600000;
  const result = { controlledProtocol: true, realModel: false, sessionsPerProvider: count, observationMs,
    benchmarkBoundary: 'driver call to protocol receipt; excludes GUI click and model latency; no old/new comparison',
    out, temp, rows: [], samples: [], passed: false, cleanupErrors: [] };
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  const names = [...new Set(git('ls-files', '--cached', '--others', '--exclude-standard', '-z', '--',
    'core', 'main', 'renderer', 'main.js', 'package.json', 'package-lock.json', 'tests/fixtures', 'tests/diag-native-agent-load.js').split('\0').filter(Boolean))].sort();
  const files = names.map(file => ({ file, sha256: fs.existsSync(path.join(ROOT, file))
    ? createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex') : null }));
  const checkpoint = { contentSha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    headSha: git('rev-parse', 'HEAD').trim(), dirty: !!git('status', '--porcelain').trim(), files, createdAt: new Date().toISOString() };
  result.sourceCheckpoint = { contentSha256: checkpoint.contentSha256, headSha: checkpoint.headSha, dirty: checkpoint.dirty, createdAt: checkpoint.createdAt };
  fs.writeFileSync(path.join(out, 'source-checkpoint.json'), JSON.stringify(checkpoint, null, 2), 'utf8');
  if (process.argv.includes('--checkpoint-only')) { console.log(JSON.stringify({ scope: 'source manifest only', out, ...result.sourceCheckpoint })); return; }
  const claude = [], codex = []; let pids = [], clients = [];
  try {
    const env = { ...process.env, CODEX_HOME: path.join(temp, 'codex'), CLAUDE_CONFIG_DIR: path.join(temp, 'claude'),
      CLAUDE_HUB_DATA_DIR: path.join(temp, 'hub'), CLAUDE_HUB_HOME_DIR: path.join(temp, 'home') };
    for (let index = 0; index < count; index++) {
      if (os.freemem() < 256 * 1048576) throw new Error('Insufficient available RAM; full 20-session test was not reduced');
      const a = new ClaudeNativeSession({ id: 'claude-' + index, executable: process.execPath, cwd: temp, env,
        commandArgs: [path.join(__dirname, 'fixtures/claude-stream.js')], initializeTimeoutMs: 30000 });
      const b = new CodexNativeSession({ id: 'codex-' + index, cwd: temp, env,
        threadParams: { model: 'controlled-fixture' }, turnParams: { model: 'controlled-fixture', effort: 'max' },
        clientFactory: () => new CodexAppServerClient({ cwd: temp, timeoutMs: 30000,
          launch: { command: process.execPath, args: [path.join(__dirname, 'fixtures/codex-app-server.js')], env } }) });
      claude.push(a); codex.push(b); await Promise.all([a.start(), b.start()]);
    }
    pids = [...new Set([...claude, ...codex].map(s => s.pid))];
    clients = [...new Set(codex.map(s => s.entry.client))];
    result.processCount = { claude: new Set(claude.map(s => s.pid)).size, codex: new Set(codex.map(s => s.pid)).size };
    assert.deepEqual(result.processCount, { claude: 20, codex: 1 });
    for (let round = 0; round < 2; round++) {
      await Promise.all([...claude, ...codex].map(async (s, index) => {
        const provider = index < count ? 'claude' : 'codex';
        const text = `  ${provider} / ${index} / ${round}\r\n` + Array.from({ length: 600 }, (_, n) => `${n}. 中文 — 🧪`).join('\r\n') + '\r\n  ';
        const id = provider + '-' + index + '-' + round; const start = performance.now();
        const receipt = provider === 'claude' ? await s.submit(text, { clientSubmissionId: id }) : await s.send(text, { clientSubmissionId: id });
        const receiptMs = performance.now() - start;
        await until(() => s.runtime.state === 'completed');
        if (provider === 'claude') {
          assert.equal(s.records.get(id).text, text); assert.equal(s.records.get(id).status, 'completed');
        } else {
          const read = await s.entry.client.request('thread/read', { threadId: s.threadId, includeTurns: true });
          const turn = read.thread.turns.find(t => t.id === receipt.turnId);
          assert.equal(turn.items.find(item => item.type === 'userMessage').content[0].text, text);
        }
        result.rows.push({ provider, id, receiptMs, completionMs: performance.now() - start,
          sessionId: s.sessionId || s.threadId, inputIdentity: receipt.userMessageId || receipt.turnId });
      }));
    }
    for (const provider of ['claude', 'codex']) {
      const times = result.rows.filter(r => r.provider === provider).map(r => r.receiptMs).sort((a, b) => a - b);
      assert.equal(times.length, 40);
      result[provider] = { sends: times.length, receiptP50Ms: times[Math.ceil(times.length * 0.5) - 1],
        receiptP95Ms: times[Math.ceil(times.length * 0.95) - 1] };
    }
    result.childPids = pids; result.startedObservationAt = new Date().toISOString();
    const began = Date.now();
    while (true) {
      result.samples.push({ elapsedMs: Date.now() - began, freeMiB: Math.round(os.freemem() / 1048576), processes: samples([process.pid, ...pids]) });
      assert.ok([...claude, ...codex].every(s => s.runtime.connection === 'connected' && s.runtime.state === 'completed'));
      fs.writeFileSync(path.join(out, 'progress.json'), JSON.stringify(result, null, 2), 'utf8');
      console.log('Observed ' + Math.round((Date.now() - began) / 1000) + 's / 600s; 40 sessions connected');
      if (Date.now() - began >= observationMs) break;
      await sleep(Math.min(30000, observationMs - (Date.now() - began)));
    }
    result.actualObservationMs = Date.now() - began;
    result.passed = true;
  } catch (error) { result.error = error.stack; throw error; }
  finally {
    for (const s of claude) try { await s.close(); } catch (e) { result.cleanupErrors.push(e.message); }
    for (const s of codex) try { s.kill(); } catch (e) { result.cleanupErrors.push(e.message); }
    try { await until(() => !pool.size && pids.every(pid => !alive(pid)), 15000); }
    catch (e) { result.cleanupErrors.push(e.message); }
    result.remainingThreadListeners = clients.map(client => Object.fromEntries(
      ['notification', 'server-request', 'disconnect', 'late-response', 'diagnostic'].map(event => [event, client.listenerCount(event)])));
    if (result.remainingThreadListeners.some(counts => Object.values(counts).some(Boolean))) result.cleanupErrors.push('Thread listeners were not released');
    if (result.cleanupErrors.length) result.passed = false;
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify({ passed: result.passed, cleanupErrors: result.cleanupErrors, out }));
    if (result.cleanupErrors.length) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
