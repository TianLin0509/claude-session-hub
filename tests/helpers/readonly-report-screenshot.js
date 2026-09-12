'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

function screenshotReadOnlyReport(report, screenshot) {
  const browser = [process.env.HUB_REPORT_CHROME,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file => file && fs.existsSync(file));
  if (!browser) throw new Error('An installed Chromium browser is required for offline report rendering');
  if (fs.existsSync(screenshot)) throw new Error('Do not overwrite report screenshot evidence');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'native-report-chrome-'));
  // Standalone browser, not Hub. Its own temporary profile cannot attach to
  // the user's open browser. There is no network content or script in the report.
  const run = spawnSync(browser, ['--headless', '--disable-gpu', '--no-first-run',
    '--disable-background-networking', '--disable-extensions', '--disable-sync',
    '--user-data-dir=' + profile, '--window-size=1200,900', '--screenshot=' + path.resolve(screenshot),
    pathToFileURL(path.resolve(report)).href], { windowsHide: true, timeout: 30000, encoding: 'utf8' });
  if (run.error || run.status !== 0 || run.signal) throw new Error('Offline report renderer failed: '
    + (run.error?.message || run.stderr || `status=${run.status} signal=${run.signal}`));
  const bytes = fs.readFileSync(screenshot);
  if (bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw new Error('Report renderer did not produce PNG evidence');
  return { browser, profile, pid: run.pid, exitCode: run.status, screenshot };
}
module.exports = { screenshotReadOnlyReport };
