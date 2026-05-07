// tests/e2e-multi-hub-stress.test.js
//
// 2026-05-07 道雪 — 多 Hub 压力 + 删除防复活验证
//
// 场景 S1（高并发）：
//   两个 Hub 同 data dir，各自连续创建 5 个圆桌（共 10），所有写盘交叠落到 lock 上。
//   关闭 + 重启验证 10 个圆桌完整保留。
//
// 场景 S2（删除防复活）：
//   两 Hub 同 data dir。Hub B 创建圆桌 mb，关 Hub B（持久化 mb）。Hub A 启动，
//   会从 self-heal 看到 mb（dormant）。Hub A 主动 close-meeting(mb)。
//   关 Hub A，重启 Hub C，验证 mb 没有复活——removed 标记应在 state.json 持久化期间生效。

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const TEMP_ROOT = path.join(os.tmpdir(), `hub-stress-${Date.now()}`);

async function createMeeting(client, scene, title) {
  return await client.eval(`(async () => await ipcRenderer.invoke('create-meeting', {
    mode: ${JSON.stringify(scene)},
    title: ${JSON.stringify(title)},
    slots: [{ index: 0, kind: 'powershell', model: null }],
  }))()`);
}

async function closeMeeting(client, meetingId) {
  return await client.eval(`(async () => await ipcRenderer.invoke('close-meeting', ${JSON.stringify(meetingId)}))()`);
}

async function getDormantMeetings(client) {
  return await client.eval(`(async () => await ipcRenderer.invoke('get-dormant-meetings'))()`);
}

async function scenario1_concurrent() {
  console.log('\n========== S1: 双 Hub 高并发 10 圆桌 ==========');
  const dataDir = path.join(TEMP_ROOT, 's1-data');
  fs.mkdirSync(dataDir, { recursive: true });

  let hubA, hubB, hubC;
  let cA, cB, cC;
  try {
    hubA = await launchIsolatedHub({ dataDir, port: 9301, label: 'A' });
    hubB = await launchIsolatedHub({ dataDir, port: 9302, label: 'B' });
    await _waitMs(2000);
    cA = await connectFirstPage(hubA);
    cB = await connectFirstPage(hubB);

    console.log('  双 Hub 各自 4 圆桌（同时发起）');
    const aPromises = [];
    const bPromises = [];
    for (let i = 0; i < 4; i++) {
      aPromises.push(createMeeting(cA, 'general', `A-${i}`));
      bPromises.push(createMeeting(cB, 'research', `B-${i}`));
    }
    const aMeetings = await Promise.all(aPromises);
    const bMeetings = await Promise.all(bPromises);
    const aIds = aMeetings.map(m => m.id);
    const bIds = bMeetings.map(m => m.id);
    console.log(`  A 创建 ${aIds.length} 个，B 创建 ${bIds.length} 个`);

    await _waitMs(3000);  // persist debounce
    console.log('  gracefulQuit 双 Hub');
    await cA.close(); cA = null;
    await cB.close(); cB = null;
    await gracefulQuit(hubA); hubA = null;
    await gracefulQuit(hubB); hubB = null;
    await _waitMs(2500);

    // 验证 state.json
    const sj = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf-8'));
    const seen = new Set(sj.meetings.map(m => m.id));
    for (const id of [...aIds, ...bIds]) {
      assert.ok(seen.has(id), `state.json 丢了 ${id}`);
    }
    console.log(`  state.json 有 ${sj.meetings.length} 个 meeting (期望 ${aIds.length + bIds.length}) ✓`);

    // 启 Hub C 验证侧边栏
    hubC = await launchIsolatedHub({ dataDir, port: 9303, label: 'C' });
    await _waitMs(2500);
    cC = await connectFirstPage(hubC);
    const dorm = await getDormantMeetings(cC);
    const seenC = new Set(dorm.map(m => m.id));
    for (const id of [...aIds, ...bIds]) {
      assert.ok(seenC.has(id), `Hub C 没看到 ${id}`);
    }
    console.log(`  Hub C 侧边栏看到 ${dorm.length} 个圆桌 ✓`);

    await cC.close(); cC = null;
    await gracefulQuit(hubC); hubC = null;
    console.log('S1 PASS');
  } finally {
    try { if (cA) await cA.close(); } catch {}
    try { if (cB) await cB.close(); } catch {}
    try { if (cC) await cC.close(); } catch {}
    if (hubA) try { await gracefulQuit(hubA); } catch {}
    if (hubB) try { await gracefulQuit(hubB); } catch {}
    if (hubC) try { await gracefulQuit(hubC); } catch {}
  }
}

async function scenario2_deleteNoResurrection() {
  console.log('\n========== S2: 删除防复活 ==========');
  const dataDir = path.join(TEMP_ROOT, 's2-data');
  fs.mkdirSync(dataDir, { recursive: true });

  let hubA, hubB, hubC;
  let cA, cB, cC;
  try {
    // 1. 启 Hub B → 建 mb → 关
    console.log('  [步骤1] Hub B 启 → 建 mb → 关');
    hubB = await launchIsolatedHub({ dataDir, port: 9311, label: 'B' });
    await _waitMs(2000);
    cB = await connectFirstPage(hubB);
    const mb = await createMeeting(cB, 'general', 'B-meeting');
    console.log(`    mb=${mb.id}`);
    await _waitMs(2000);
    await cB.close(); cB = null;
    await gracefulQuit(hubB); hubB = null;
    await _waitMs(2000);

    // 2. 启 Hub A → 应该看到 mb（dormant）→ 主动 close-meeting(mb) → 关 Hub A
    console.log('  [步骤2] Hub A 启 → 看到 mb dormant → close-meeting(mb) → 关');
    hubA = await launchIsolatedHub({ dataDir, port: 9312, label: 'A' });
    await _waitMs(2500);
    cA = await connectFirstPage(hubA);
    const dormBefore = await getDormantMeetings(cA);
    assert.ok(dormBefore.some(m => m.id === mb.id), 'Hub A boot 时应看到 mb dormant');
    console.log('    Hub A 看到 mb dormant ✓');

    // 主动关掉 mb（用户操作"右键关闭圆桌"）
    const closed = await closeMeeting(cA, mb.id);
    assert.ok(closed, 'close-meeting should return true');
    console.log('    Hub A 已 close-meeting(mb) ✓');

    await _waitMs(2000);  // persist
    await cA.close(); cA = null;
    await gracefulQuit(hubA); hubA = null;
    await _waitMs(2000);

    // 3. 启 Hub C 验证 mb 没复活
    console.log('  [步骤3] Hub C 启 → 验证 mb 已彻底消失');
    hubC = await launchIsolatedHub({ dataDir, port: 9313, label: 'C' });
    await _waitMs(2500);
    cC = await connectFirstPage(hubC);
    const dormAfter = await getDormantMeetings(cC);
    const sjAfter = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf-8'));
    const meetingFileExists = fs.existsSync(path.join(dataDir, 'meetings', `${mb.id}.json`));

    console.log(`    dormant meetings: ${dormAfter.length}`);
    console.log(`    state.json meetings: ${sjAfter.meetings.length}`);
    console.log(`    meetings/${mb.id}.json 存在: ${meetingFileExists}`);

    assert.ok(!dormAfter.some(m => m.id === mb.id), 'mb 不应在 dormant list');
    assert.ok(!sjAfter.meetings.some(m => m.id === mb.id), 'mb 不应在 state.json');
    assert.ok(!meetingFileExists, 'meetings/<mb>.json 应被删除');
    console.log('  S2 PASS — mb 未复活');

    await cC.close(); cC = null;
    await gracefulQuit(hubC); hubC = null;
  } finally {
    try { if (cA) await cA.close(); } catch {}
    try { if (cB) await cB.close(); } catch {}
    try { if (cC) await cC.close(); } catch {}
    if (hubA) try { await gracefulQuit(hubA); } catch {}
    if (hubB) try { await gracefulQuit(hubB); } catch {}
    if (hubC) try { await gracefulQuit(hubC); } catch {}
  }
}

(async () => {
  let failed = false;
  try {
    await scenario1_concurrent();
    await scenario2_deleteNoResurrection();
    console.log('\n[ALL stress E2E PASSED]');
  } catch (e) {
    failed = true;
    console.error('\n[FAIL]', e.message);
    if (e.stack) console.error(e.stack);
  }
  process.exit(failed ? 1 : 0);
})();
