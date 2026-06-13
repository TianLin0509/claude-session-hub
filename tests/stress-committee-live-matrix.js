'use strict';

// Sequential live matrix runner for the five-seat investment committee.
// It wraps e2e-committee-live-five-seat.js with isolated CDP ports and writes
// a compact summary that is easier to compare across quick/full live runs.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE_E2E = path.join(__dirname, 'e2e-committee-live-five-seat.js');
const ARTIFACT_DIR = 'C:\\Users\\lintian\\hub-committee-artifacts';
const RUN_ID = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const MATRIX_LOG = path.join(ARTIFACT_DIR, `committee-live-matrix-${RUN_ID}.log`);
const MATRIX_SUMMARY = path.join(ARTIFACT_DIR, `committee-live-matrix-${RUN_ID}.json`);
const PORT_BASE = Number(process.env.COMMITTEE_LIVE_MATRIX_PORT_BASE || 9270);
const CHILD_TIMEOUT_MS = Number(process.env.COMMITTEE_LIVE_MATRIX_CHILD_TIMEOUT_MS || (35 * 60 * 1000));
const PLAN = String(process.env.COMMITTEE_LIVE_MATRIX_PLAN || 'quick,full')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);
const DEGRADE_LOG_RE = /transitional hard timeout|forcing skip|本轮缺席|点名未应答|点名预热未返回|两次重写仍未过校验|质询官本轮缺席|session failed|投委会中断|auth failure|auth_required|cli not ready|submit_retry_failed|prompt submit retry threw/g;
const RECOVERY_LOG_RE = /codex prompt submit not observed|transcript not bound|Codex transcript is not bound yet|retrying prompt submit/g;

function log(line) {
  fs.appendFileSync(MATRIX_LOG, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
}

function symbolForMode(mode, index) {
  const code = String(100001 + index).slice(-6);
  if (mode === 'full') return `${code} 全量`;
  return code;
}

function parseJsonFromStdout(stdout) {
  const text = String(stdout || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('child stdout does not contain JSON object');
  }
  return JSON.parse(text.slice(start, end + 1));
}

function runIdFromPath(fp) {
  const m = String(fp || '').match(/committee-live-five-seat-(\d{14})\.log$/);
  return m && m[1];
}

function inspectLog(fp) {
  if (!fp || !fs.existsSync(fp)) return { degradationMatches: [], recoveryMatches: [] };
  const text = fs.readFileSync(fp, 'utf8');
  const matches = Array.from(new Set(Array.from(text.matchAll(DEGRADE_LOG_RE)).map(m => m[0])));
  const recoveryMatches = Array.from(new Set(Array.from(text.matchAll(RECOVERY_LOG_RE)).map(m => m[0])));
  return {
    degradationMatches: matches,
    recoveryMatches,
    completed: /turn completed status=completed/.test(text),
    hasAct2Compress: /幕二答辩压缩/.test(text),
  };
}

function findChildArtifacts(symbol, cdpPort, startedAt) {
  const logs = fs.readdirSync(ARTIFACT_DIR)
    .filter(name => /^committee-live-five-seat-\d{14}\.log$/.test(name))
    .map(name => path.join(ARTIFACT_DIR, name))
    .filter(fp => fs.statSync(fp).mtimeMs >= startedAt - 5000)
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const fp of logs) {
    let text = '';
    try { text = fs.readFileSync(fp, 'utf8'); } catch { continue; }
    if (!text.includes(`symbol=${symbol}`)) continue;
    if (!text.includes(`:${cdpPort}`) && !text.includes(`cdpPort=${cdpPort}`)) continue;
    const runId = runIdFromPath(fp);
    return {
      runId,
      log: fp,
      screenshot: path.join(ARTIFACT_DIR, `committee-live-five-seat-${runId}.png`),
      summary: path.join(ARTIFACT_DIR, `committee-live-five-seat-${runId}.json`),
      ...inspectLog(fp),
    };
  }
  return { degradationMatches: [] };
}

function runOne(mode, index) {
  const cdpPort = PORT_BASE + index;
  const symbol = symbolForMode(mode, index);
  const startedAt = Date.now();
  const env = {
    ...process.env,
    COMMITTEE_LIVE_SYMBOL: symbol,
    COMMITTEE_LIVE_CDP_PORT: String(cdpPort),
    COMMITTEE_LIVE_REQUIRE_NO_DEGRADE: '1',
  };
  log(`run ${index + 1}/${PLAN.length} mode=${mode} symbol=${symbol} port=${cdpPort}`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [LIVE_E2E], {
      cwd: ROOT,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      log(`timeout mode=${mode} symbol=${symbol} port=${cdpPort} after ${CHILD_TIMEOUT_MS}ms; killing child tree pid=${child.pid || '?'}`);
      if (child.pid) {
        try {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
        } catch (e) {
          log(`taskkill failed pid=${child.pid}: ${e.message}`);
        }
      }
      const artifacts = findChildArtifacts(symbol, cdpPort, startedAt);
      resolve({
        mode,
        symbol,
        cdpPort,
        ok: false,
        timedOut: true,
        timeoutMs: CHILD_TIMEOUT_MS,
        error: `live matrix child timed out mode=${mode} after ${CHILD_TIMEOUT_MS}ms`,
        stderrTail: stderr.slice(-2000),
        stdoutTail: stdout.slice(-2000),
        ...artifacts,
      });
    }, CHILD_TIMEOUT_MS);
    timeout.unref?.();
    child.stdout.on('data', d => {
      const s = d.toString();
      stdout += s;
      fs.appendFileSync(MATRIX_LOG, s, 'utf8');
    });
    child.stderr.on('data', d => {
      const s = d.toString();
      stderr += s;
      fs.appendFileSync(MATRIX_LOG, s, 'utf8');
    });
    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
    child.on('exit', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        const artifacts = findChildArtifacts(symbol, cdpPort, startedAt);
        resolve({
          mode,
          symbol,
          cdpPort,
          ok: false,
          exitCode: code,
          error: `live matrix child failed mode=${mode} code=${code}`,
          stderrTail: stderr.slice(-2000),
          stdoutTail: stdout.slice(-2000),
          ...artifacts,
        });
        return;
      }
      try {
        const parsed = parseJsonFromStdout(stdout);
        const logInfo = inspectLog(parsed.log);
        resolve({
          mode,
          symbol,
          cdpPort,
          ok: parsed.ok === true,
          runId: parsed.runId,
          elapsedMs: parsed.turn && parsed.turn.elapsedMs,
          status: parsed.turn && parsed.turn.status,
          challengeHeld: !!(parsed.turn && parsed.turn.meta && parsed.turn.meta.committee && parsed.turn.meta.committee.challengeHeld),
          verdictValid: !!(parsed.turn && parsed.turn.meta && parsed.turn.meta.committee && parsed.turn.meta.committee.verdictValid),
          missingTimeline: parsed.timelineProbe && parsed.timelineProbe.missing || [],
          log: parsed.log,
          screenshot: parsed.screenshot,
          summary: path.join(ARTIFACT_DIR, `committee-live-five-seat-${parsed.runId}.json`),
          ...logInfo,
        });
      } catch (e) {
        const artifacts = findChildArtifacts(symbol, cdpPort, startedAt);
        resolve({
          mode,
          symbol,
          cdpPort,
          ok: false,
          error: e.message,
          stderrTail: stderr.slice(-2000),
          stdoutTail: stdout.slice(-2000),
          ...artifacts,
        });
      }
    });
  });
}

(async () => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  log(`start matrix plan=${PLAN.join(',')} portBase=${PORT_BASE}`);
  const runs = [];
  for (let i = 0; i < PLAN.length; i += 1) {
    const mode = PLAN[i];
    if (!['quick', 'full'].includes(mode)) {
      throw new Error(`unsupported matrix mode: ${mode}`);
    }
    const run = await runOne(mode, i);
    runs.push(run);
    log(`done mode=${mode} runId=${run.runId || '?'} ok=${run.ok} status=${run.status || '?'} elapsedMs=${run.elapsedMs || '?'} matches=${(run.degradationMatches || []).join('|')}`);
  }
  const summary = {
    ok: runs.every(r => r.ok && r.status === 'completed' && r.verdictValid && r.missingTimeline.length === 0 && (!r.degradationMatches || r.degradationMatches.length === 0)),
    runId: RUN_ID,
    plan: PLAN,
    childTimeoutMs: CHILD_TIMEOUT_MS,
    total: runs.length,
    failed: runs.filter(r => !r.ok).length,
    timedOut: runs.filter(r => r.timedOut).length,
    completed: runs.filter(r => r.status === 'completed').length,
    fullChallengeHeld: runs.filter(r => r.mode === 'full').every(r => r.challengeHeld),
    degradationRuns: runs.filter(r => (r.degradationMatches || []).length > 0).length,
    recoveryRuns: runs.filter(r => (r.recoveryMatches || []).length > 0).length,
    runs,
    log: MATRIX_LOG,
  };
  fs.writeFileSync(MATRIX_SUMMARY, JSON.stringify(summary, null, 2), 'utf8');
  console.log(JSON.stringify({ ...summary, summary: MATRIX_SUMMARY }, null, 2));
  if (!summary.ok || !summary.fullChallengeHeld) process.exit(1);
})().catch(e => {
  log(`matrix failed: ${e.stack || e.message}`);
  console.error(e.stack || e.message);
  process.exit(1);
});
