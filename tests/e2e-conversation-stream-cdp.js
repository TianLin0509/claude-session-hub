'use strict';
// Ordinary chat presents one complete reply with folded native process records.
// Group chat remains file-based. Run both actual isolated GUI acceptance paths.
const { spawn } = require('node:child_process');
const path = require('node:path');
(async () => {
  for (const name of ['e2e-simple-chat-cdp.js', 'e2e-group-answer-files-cdp.js']) {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(__dirname, name)], {
        cwd: path.resolve(__dirname, '..'), stdio: 'inherit', windowsHide: true,
      });
      child.on('error', reject);
      child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${name}: ${code || signal}`)));
    });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });