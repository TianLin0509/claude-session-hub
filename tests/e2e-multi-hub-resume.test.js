// tests/e2e-multi-hub-resume.test.js
//
// 2026-05-07 道雪 — 多 Hub 并发安全 E2E
//
// 场景：
//   1. Hub A + Hub B 共享同一隔离 data dir 同时启动
//   2. 在 A 里加一个 session sa + 一个圆桌 ma；在 B 里加 sb + mb
//   3. 等 persist debounce 完成
//   4. 关闭 A、B
//   5. 启第三个 Hub C 同 data dir，验证侧边栏看到 sa+sb+ma+mb 全集
//
// 进一步场景：
//   6. 模拟 state.json 损坏（直接删除），单实例 Hub 启动后从 sessions/ + meetings/ 自我修复

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const TEMP_ROOT = path.join(os.tmpdir(), `hub-multi-e2e-${Date.now()}`);
const SHARED_DATA_DIR = path.join(TEMP_ROOT, 'shared-data');

const _ownedPids = new Set();
function trackPid(pid) { if (pid) _ownedPids.add(pid); }

async function killTrackedHubs(hubs) {
  for (const h of hubs) {
    if (!h) continue;
    try { await gracefulQuit(h); } catch (e) { console.warn(`gracefulQuit ${h.label} failed:`, e.message); }
  }
}

async function readDormantSessionsFromHub(client) {
  return await client.eval(`(async () => {
    const r = await ipcRenderer.invoke('get-dormant-sessions');
    return r;
  })()`);
}

async function readDormantMeetingsFromHub(client) {
  return await client.eval(`(async () => {
    const r = await ipcRenderer.invoke('get-dormant-meetings');
    return r;
  })()`);
}

async function getLiveSessions(client) {
  return await client.eval(`(async () => await ipcRenderer.invoke('get-sessions'))()`);
}

// 在 Hub 里"创建一个 powershell session"（相当于用户点 "+ 新建" 选 PowerShell 终端）。
//   通过 IPC 直接调 add-session — 这是 renderer.js 在用户点击 "+" 选 PS 后会调的同一 handler。
//   不依赖具体 UI 按钮位置，但走的是真实生产 IPC 路径。
async function createPowerShellSession(client, title = 'PSTest') {
  // Hub IPC: create-session 接受 string 'powershell' 或 {kind, opts}。这是 renderer 的
  // "+ 新建 powershell" 按钮真实调用的同一 handler。
  const safeTitle = title.replace(/[\\'"\n\r]/g, '_');
  const result = await client.eval(`(async () => {
    const s = await ipcRenderer.invoke('create-session', { kind: 'powershell', opts: { title: '${safeTitle}' } });
    return s;
  })()`);
  return result;
}

async function createMeeting(client, scene = 'general', title = '测试圆桌') {
  // Hub IPC: create-meeting 接受 { mode, slots, title }。slots 是 Modal 收集到的
  //   [{ index, kind, model }] —— main.js 内部据此 _addMeetingSubInternal 起 sub。
  //   用 powershell 为 sub kind 避免 spawn 真实 AI CLI（不依赖外网/auth）。
  const result = await client.eval(`(async () => {
    const opts = {
      mode: ${JSON.stringify(scene)},
      title: ${JSON.stringify(title)},
      slots: [{ index: 0, kind: 'powershell', model: null }],
    };
    return await ipcRenderer.invoke('create-meeting', opts);
  })()`);
  return result;
}

async function persistAndWait(client, ms = 1500) {
  // 触发一次 schedulePersist —— 这等价于 session-created/meeting-created 之类
  //   事件触发的渲染端持久化路径。我们 sleep 1.5s 让 400ms renderer + 500ms main
  //   两段 debounce 完成，并让 5s meeting-store debounce 至少有时间落盘
  //   （但 5s 防抖意味着 meeting 文件可能要等到 close 时 flushAll 才落）。
  await client.eval(`(async () => {
    if (typeof schedulePersist === 'function') schedulePersist();
    return true;
  })()`).catch(() => null);
  await _waitMs(ms);
}

async function main() {
  console.log('--- E2E multi-hub resume ---');
  console.log('shared dataDir:', SHARED_DATA_DIR);
  fs.mkdirSync(SHARED_DATA_DIR, { recursive: true });

  let hubA, hubB, hubC;
  let clientA, clientB, clientC;
  let failed = false;
  try {
    // 1. 启 Hub A
    console.log('\n[step 1] launching Hub A on port 9281');
    hubA = await launchIsolatedHub({ dataDir: SHARED_DATA_DIR, port: 9281, label: 'A' });
    trackPid(hubA.pid);
    console.log(`  Hub A PID=${hubA.pid}`);

    // 2. 启 Hub B（同 dataDir）
    console.log('[step 2] launching Hub B on port 9282 (SAME data dir as A)');
    hubB = await launchIsolatedHub({ dataDir: SHARED_DATA_DIR, port: 9282, label: 'B' });
    trackPid(hubB.pid);
    console.log(`  Hub B PID=${hubB.pid}`);

    // 3. 等 renderer ready
    await _waitMs(2000);
    clientA = await connectFirstPage(hubA);
    clientB = await connectFirstPage(hubB);

    // 4. Hub A 创建圆桌 ma（带 1 个 powershell sub）
    //   sub 有 meetingId，进入 renderer 持久化白名单 → 同时验证 sessions[] 与 meetings[]
    //   两层 merge。用 powershell 为 sub kind 避免 spawn 真实 AI CLI（不依赖外网/auth）。
    console.log('\n[step 3] Hub A: 创建通用圆桌 ma + 1 个 powershell sub');
    const ma = await createMeeting(clientA, 'general', 'A-meeting-通用');
    assert.ok(ma && ma.id, 'ma creation failed');
    assert.ok(Array.isArray(ma.subSessions) && ma.subSessions.length === 1, 'ma should have 1 sub');
    const sa = ma.subSessions[0];
    console.log(`  ma=${ma.id}  sa(sub)=${sa}`);

    // 5. Hub B 创建圆桌 mb（带 1 个 powershell sub）
    console.log('[step 4] Hub B: 创建投研圆桌 mb + 1 个 powershell sub');
    const mb = await createMeeting(clientB, 'research', 'B-meeting-投研');
    assert.ok(mb && mb.id, 'mb creation failed');
    assert.ok(Array.isArray(mb.subSessions) && mb.subSessions.length === 1, 'mb should have 1 sub');
    const sb = mb.subSessions[0];
    console.log(`  mb=${mb.id}  sb(sub)=${sb}`);

    // 6. 等 persist
    console.log('\n[step 5] persist + wait 2s');
    await persistAndWait(clientA, 1500);
    await persistAndWait(clientB, 1500);
    await _waitMs(1500);

    // 7. 关 A、B（gracefulQuit 触发 before-quit → flushAll 双备份）
    console.log('\n[step 6] gracefulQuit Hub A + B');
    await clientA.close();
    await clientB.close();
    await gracefulQuit(hubA);
    await gracefulQuit(hubB);
    await _waitMs(2000);

    // 8. 检查磁盘状态
    const stateJsonPath = path.join(SHARED_DATA_DIR, 'state.json');
    const stateJson = JSON.parse(fs.readFileSync(stateJsonPath, 'utf-8'));
    console.log('\n[step 7] state.json on disk after both Hubs closed:');
    console.log(`  sessions: ${stateJson.sessions.length}`);
    console.log(`  meetings: ${stateJson.meetings.length}`);
    const sessionIds = stateJson.sessions.map(s => s.hubId);
    const meetingIds = stateJson.meetings.map(m => m.id);
    console.log('  session hubIds:', sessionIds);
    console.log('  meeting ids:', meetingIds);

    // 关键断言：sa, sb, ma, mb 都在
    assert.ok(sessionIds.includes(sa), `state.json missing sa (${sa}) — multi-hub overwrite still happens!`);
    assert.ok(sessionIds.includes(sb), `state.json missing sb (${sb})`);
    assert.ok(meetingIds.includes(ma.id), `state.json missing ma (${ma.id})`);
    assert.ok(meetingIds.includes(mb.id), `state.json missing mb (${mb.id})`);
    console.log('PASS multi-hub state.json contains all 4 entries (sa+sb+ma+mb)');

    // 9. 启 Hub C 单实例验证 sidebar 看到全部
    console.log('\n[step 8] launching Hub C (solo) on port 9283 to verify sidebar restoration');
    hubC = await launchIsolatedHub({ dataDir: SHARED_DATA_DIR, port: 9283, label: 'C' });
    trackPid(hubC.pid);
    await _waitMs(2500);
    clientC = await connectFirstPage(hubC);
    const dormSess = await readDormantSessionsFromHub(clientC);
    const dormMtg = await readDormantMeetingsFromHub(clientC);
    const liveSessC = await getLiveSessions(clientC);
    console.log(`  Hub C dormant sessions: ${dormSess.sessions.length}, meetings: ${dormMtg.length}, live sessions: ${liveSessC.length}`);
    const seenSessionIds = new Set([
      ...dormSess.sessions.map(s => s.hubId),
      ...liveSessC.map(s => s.id),
    ]);
    const seenMeetingIds = new Set(dormMtg.map(m => m.id));
    assert.ok(seenSessionIds.has(sa), 'Hub C 没看到 sa');
    assert.ok(seenSessionIds.has(sb), 'Hub C 没看到 sb');
    assert.ok(seenMeetingIds.has(ma.id), 'Hub C 没看到 ma');
    assert.ok(seenMeetingIds.has(mb.id), 'Hub C 没看到 mb');
    console.log('PASS Hub C 侧边栏恢复 sa+sb+ma+mb 全集');

    // 10. 模拟 state.json 损坏 — 删除 + 重启
    console.log('\n[step 9] 模拟 state.json 损坏：删除 + 重启 Hub D');
    await clientC.close();
    await gracefulQuit(hubC);
    hubC = null;
    await _waitMs(2000);

    fs.unlinkSync(stateJsonPath);
    console.log('  state.json 已删除');

    const hubD = await launchIsolatedHub({ dataDir: SHARED_DATA_DIR, port: 9284, label: 'D' });
    trackPid(hubD.pid);
    await _waitMs(2500);
    const clientD = await connectFirstPage(hubD);
    const dormSessD = await readDormantSessionsFromHub(clientD);
    const dormMtgD = await readDormantMeetingsFromHub(clientD);
    console.log(`  Hub D dormant sessions: ${dormSessD.sessions.length}, meetings: ${dormMtgD.length}`);

    // 关键：sessions/ + meetings/ 目录里有完整备份，自我修复应该把它们捞回来
    const seenSessIdsD = new Set(dormSessD.sessions.map(s => s.hubId));
    const seenMeetIdsD = new Set(dormMtgD.map(m => m.id));
    assert.ok(seenSessIdsD.has(sa), `[corruption recover] 丢失 sa (${sa})`);
    assert.ok(seenSessIdsD.has(sb), `[corruption recover] 丢失 sb`);
    assert.ok(seenMeetIdsD.has(ma.id), `[corruption recover] 丢失 ma`);
    assert.ok(seenMeetIdsD.has(mb.id), `[corruption recover] 丢失 mb`);
    console.log('PASS Hub D 从 sessions/ + meetings/ 双备份完整恢复（state.json 删除后）');

    await clientD.close();
    await gracefulQuit(hubD);
    console.log('\n[ALL multi-hub E2E PASSED]');
  } catch (e) {
    failed = true;
    console.error('\n[FAIL]', e.message);
    if (e.logTail) console.error('Hub log tail:\n' + e.logTail);
    if (e.stack) console.error(e.stack);
  } finally {
    // 关闭所有还没关的 Hub —— 只针对 trackPid 的 PID
    try { if (clientA) await clientA.close(); } catch {}
    try { if (clientB) await clientB.close(); } catch {}
    try { if (clientC) await clientC.close(); } catch {}
    await killTrackedHubs([hubA, hubB, hubC].filter(Boolean));
    process.exit(failed ? 1 : 0);
  }
}

main();
