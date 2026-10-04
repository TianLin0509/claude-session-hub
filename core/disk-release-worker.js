'use strict';
const { parentPort, workerData } = require('worker_threads');
const { createDiskReleaseEngine } = require('./disk-release-engine');
const engine = createDiskReleaseEngine({ ...workerData,
  onProgress: progress => parentPort.postMessage({ progress }),
});
let running = false;
parentPort.on('message', async ({ id, method, request }) => {
  if (method === 'cancel') { engine.cancelScan(); return; }
  if (running) { parentPort.postMessage({ id, error: '已有扫描或清理正在进行' }); return; }
  running = true;
  try {
    const result = method === 'execute' ? await engine.execute(request) : await engine.scan();
    parentPort.postMessage({ id, result });
  } catch (error) { parentPort.postMessage({ id, error: error.message }); }
  finally { running = false; }
});
