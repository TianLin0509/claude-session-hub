'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

async function run() {
  assert.equal(process.env.HUB_FEISHU_LIVE_ACCEPT, '1', 'set HUB_FEISHU_LIVE_ACCEPT=1 to send the live acceptance card');
  const root = path.resolve(__dirname, '..');
  const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  const electronTest = path.join(__dirname, 'fixtures', 'feishu-card-live-app');
  const resultPath = path.join(__dirname, '20260901-feishu-card-live-acceptance-codex1.json');
  try { fs.unlinkSync(resultPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }

  const child = spawn(electronExe, ['--enable-logging=stderr', electronTest], {
    cwd: root,
    env: {
      ...process.env,
      HUB_FEISHU_LIVE_ACCEPT: '1',
      HUB_FEISHU_ACCEPT_RESULT: resultPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  const exit = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error('live acceptance timed out after 90 seconds'));
    }, 90_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
  });

  let result = null;
  try { result = JSON.parse(fs.readFileSync(resultPath, 'utf8')); } catch {}
  try { fs.unlinkSync(resultPath); } catch {}
  if (!result || result.ok !== true || exit.code !== 0) {
    const error = new Error(`live acceptance failed: ${JSON.stringify({ exit, result, stdout: stdout.slice(-500), stderr: stderr.slice(-500) })}`);
    throw error;
  }
  console.log(JSON.stringify(result));
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
