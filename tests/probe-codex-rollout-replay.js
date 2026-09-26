'use strict';
// 诊断：把一份真实 rollout 逐行回放给 CodexTap，打印它发出的事件。
// 用法：node tests/probe-codex-rollout-replay.js <rollout.jsonl>
const fs = require('fs'), os = require('os'), path = require('path');
const { CodexTap } = require('../core/transcript-tap');
const src = process.argv[2];
const lines = fs.readFileSync(src, 'utf8').split(/\r?\n/).filter(Boolean);
const meta = JSON.parse(lines[0]).payload;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-replay-'));
const now = new Date();
const day = path.join(root, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
fs.mkdirSync(day, { recursive: true });
const file = path.join(day, path.basename(src));
fs.writeFileSync(file, lines[0] + '\n');
const tap = new CodexTap({ sessionsRoot: root, pollIntervalMs: 50 });
for (const name of ['turn-started', 'turn-complete', 'turn-aborted', 'prompt-submitted', 'turn-error']) {
  tap.on(name, ev => console.log(name, ev.turnId ? String(ev.turnId).slice(-8) : null, JSON.stringify(ev.text || ev.signalSource || '').slice(0, 40)));
}
(async () => {
  tap.registerSession('hub', { cwd: meta.cwd });
  console.log('bound', await tap.bindFromHook('hub', { codexSid: meta.id, transcriptPath: file }));
  for (const line of lines.slice(1)) {
    // 真实记录是几小时前的：换成现在的时间，否则会被当成历史跳过。
    const record = JSON.parse(line);
    record.timestamp = new Date().toISOString();
    if (record.payload && typeof record.payload === 'object') {
      for (const key of ['completed_at', 'started_at']) if (typeof record.payload[key] === 'number') record.payload[key] = Math.floor(Date.now() / 1000);
    }
    fs.appendFileSync(file, JSON.stringify(record) + '\n');
    await new Promise(r => setTimeout(r, Number(process.env.REPLAY_GAP_MS || 30)));
  }
  await new Promise(r => setTimeout(r, 1500));
  tap.unregisterSession('hub');
  process.exit(0);
})();
