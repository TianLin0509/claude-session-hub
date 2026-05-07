// tests/e2e-single-hub-resume.test.js
//
// 2026-05-07 道雪 — 单 Hub 回归验证
//
// 场景：
//   1. 单 Hub 启动
//   2. 创建 1 个圆桌 + 3 个 sub（powershell）
//   3. 关 Hub
//   4. 重启 Hub
//   5. 验证侧边栏完整恢复（圆桌 + 3 个 dormant sub）
//   6. 进一步：开启第二轮 Hub 启停看 immersive 状态被持久化
//
// 这个测试验证"我的多 Hub merge 改动"没有打破单 Hub 普通流程。

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const TEMP_ROOT = path.join(os.tmpdir(), `hub-single-e2e-${Date.now()}`);
const DATA_DIR = path.join(TEMP_ROOT, 'data');

async function createMeetingWithSubs(client, scene, title, subKinds = ['powershell', 'powershell', 'powershell']) {
  const result = await client.eval(`(async () => {
    const opts = {
      mode: ${JSON.stringify(scene)},
      title: ${JSON.stringify(title)},
      slots: ${JSON.stringify(subKinds.map((k, i) => ({ index: i, kind: k, model: null })))},
    };
    return await ipcRenderer.invoke('create-meeting', opts);
  })()`);
  return result;
}

async function getSessions(client) {
  return await client.eval(`(async () => await ipcRenderer.invoke('get-sessions'))()`);
}

async function getDormantSessions(client) {
  return await client.eval(`(async () => await ipcRenderer.invoke('get-dormant-sessions'))()`);
}

async function getDormantMeetings(client) {
  return await client.eval(`(async () => await ipcRenderer.invoke('get-dormant-meetings'))()`);
}

async function main() {
  console.log('--- E2E single-hub resume regression ---');
  console.log('dataDir:', DATA_DIR);
  fs.mkdirSync(DATA_DIR, { recursive: true });

  let hub1, hub2;
  let client1, client2;
  let failed = false;
  try {
    // round 1
    console.log('\n[round 1] launching Hub on port 9291');
    hub1 = await launchIsolatedHub({ dataDir: DATA_DIR, port: 9291, label: 'R1' });
    await _waitMs(2000);
    client1 = await connectFirstPage(hub1);

    console.log('  创建通用圆桌 + 3 个 powershell sub');
    const meeting = await createMeetingWithSubs(client1, 'general', 'regression-meeting', ['powershell', 'powershell', 'powershell']);
    assert.ok(meeting && meeting.id, 'meeting creation failed');
    assert.strictEqual(meeting.subSessions.length, 3, 'expected 3 subs');
    const meetingId = meeting.id;
    const subIds = meeting.subSessions.slice();
    console.log(`  meeting=${meetingId}, subs=${subIds.join(',')}`);

    // 等 persist 落盘（renderer schedulePersist 400ms + main debounce 500ms）
    await _waitMs(1500);

    // 关闭 Hub —— before-quit 会 flushAll，把 per-meeting JSON + per-session JSON
    //   还没到 5s/200ms debounce 期的 dirty 强制 sync 落盘。
    console.log('\n[round 1] gracefulQuit (触发 flushAll 双备份)');
    await client1.close(); client1 = null;
    await gracefulQuit(hub1);
    hub1 = null;
    await _waitMs(2000);

    // 检查 per-meeting JSON + per-session JSON 都已落盘（flushAll 后必现）
    const meetingFilePath = path.join(DATA_DIR, 'meetings', `${meetingId}.json`);
    const subFilePaths = subIds.map(s => path.join(DATA_DIR, 'sessions', `${s}.json`));

    assert.ok(fs.existsSync(meetingFilePath), `meeting per-id JSON missing after flushAll: ${meetingFilePath}`);
    console.log(`  meeting per-id JSON 已写: ${meetingFilePath}`);
    const meetingFileData = JSON.parse(fs.readFileSync(meetingFilePath, 'utf-8'));
    assert.strictEqual(meetingFileData.schemaVersion, 2, 'meeting JSON should be v2');
    assert.strictEqual(meetingFileData.title, 'regression-meeting', 'meeting JSON should preserve title');
    assert.strictEqual(meetingFileData.scene, 'general', 'meeting JSON should preserve scene');
    assert.strictEqual(meetingFileData.subSessions.length, 3, 'meeting JSON should record subSessions');
    console.log('  meeting JSON v2 含 title/scene/subSessions ✓');

    for (const sp of subFilePaths) {
      assert.ok(fs.existsSync(sp), `sub session per-id JSON missing: ${sp}`);
    }
    console.log('  3 个 sub session per-id JSON 都已写 ✓');

    // 检查 state.json
    const stateJson = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'state.json'), 'utf-8'));
    assert.strictEqual(stateJson.cleanShutdown, true, 'cleanShutdown should be true after graceful quit');
    assert.strictEqual(stateJson.meetings.length, 1, 'state.json should have 1 meeting');
    assert.strictEqual(stateJson.meetings[0].id, meetingId);
    assert.strictEqual(stateJson.meetings[0].subSessions.length, 3);
    assert.strictEqual(stateJson.sessions.length, 3, 'state.json should have 3 sub sessions');
    console.log('  state.json cleanShutdown=true, 1 meeting + 3 subs ✓');

    // round 2 — 重启
    console.log('\n[round 2] re-launching Hub on port 9292');
    hub2 = await launchIsolatedHub({ dataDir: DATA_DIR, port: 9292, label: 'R2' });
    await _waitMs(2500);
    client2 = await connectFirstPage(hub2);

    const dormSess = await getDormantSessions(client2);
    const dormMtg = await getDormantMeetings(client2);
    const live = await getSessions(client2);
    console.log(`  dormant sessions: ${dormSess.sessions.length}, meetings: ${dormMtg.length}, live: ${live.length}`);
    assert.strictEqual(dormSess.sessions.length, 3, 'should restore 3 dormant subs');
    assert.strictEqual(dormMtg.length, 1, 'should restore 1 meeting');
    assert.strictEqual(dormMtg[0].id, meetingId);
    // 字段完整性检查
    assert.strictEqual(dormMtg[0].title, 'regression-meeting');
    assert.strictEqual(dormMtg[0].scene, 'general');
    assert.strictEqual(dormMtg[0].subSessions.length, 3);
    console.log('  侧边栏完整恢复: meeting title/scene/subSessions 都对 ✓');

    // 验证 wasCleanShutdown signal
    assert.strictEqual(dormSess.wasCleanShutdown, true, 'wasCleanShutdown should be true after graceful quit + reboot');
    console.log('  wasCleanShutdown=true 信号传到 renderer ✓');

    // round 2 收尾
    await client2.close(); client2 = null;
    await gracefulQuit(hub2);
    hub2 = null;

    console.log('\n[ALL single-hub regression E2E PASSED]');
  } catch (e) {
    failed = true;
    console.error('\n[FAIL]', e.message);
    if (e.logTail) console.error('Hub log tail:\n' + e.logTail);
    if (e.stack) console.error(e.stack);
  } finally {
    try { if (client1) await client1.close(); } catch {}
    try { if (client2) await client2.close(); } catch {}
    if (hub1) try { await gracefulQuit(hub1); } catch {}
    if (hub2) try { await gracefulQuit(hub2); } catch {}
    process.exit(failed ? 1 : 0);
  }
}

main();
