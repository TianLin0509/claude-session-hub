'use strict';

// Live E2E: isolated Electron Hub + real five model CLIs + real groupchat:turn
// through committee-conductor. LinDang prep/memory are redirected to a temp
// package so this test does not pollute the real investment ledger.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const ELECTRON_EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const CDP_PORT = Number(process.env.COMMITTEE_LIVE_CDP_PORT || 9257);
const ARTIFACT_DIR = 'C:\\Users\\lintian\\hub-committee-artifacts';
const RUN_ID = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const DATA_DIR = path.join(os.tmpdir(), `hub-committee-live-${RUN_ID}`);
const LINDANG_DIR = path.join(os.tmpdir(), `lindang-committee-live-${RUN_ID}`);
const SYMBOL = process.env.COMMITTEE_LIVE_SYMBOL || '000001';
const HARD_TIMEOUT_MS = Number(process.env.COMMITTEE_LIVE_TIMEOUT_MS || 55 * 60 * 1000);
const REQUIRE_NO_DEGRADE = process.env.COMMITTEE_LIVE_REQUIRE_NO_DEGRADE !== '0';
const EXPECT_FULL = /full/i.test(SYMBOL) || String(SYMBOL).includes('\u5168\u91cf');

const DEGRADE_LOG_RE = /transitional hard timeout|forcing skip|本轮缺席|点名未应答|两次重写仍未过校验|质询官本轮缺席|session failed|投委会中断|auth failure|auth_required|cli not ready|submit_retry_failed|prompt submit retry threw/;
const RECOVERY_LOG_RE = /codex prompt submit not observed|transcript not bound|retrying prompt submit/g;
const EXPECTED_SLOT_SPECS = [
  { kind: 'deepseek', model: 'deepseek-v4-pro[1m]' },
  { kind: 'claude', model: 'claude-opus-4-8[1m]' },
  { kind: 'codex', model: 'gpt-5.5' },
  { kind: 'codex', model: 'gpt-5.5' },
  { kind: 'claude', model: 'claude-opus-4-8[1m]' },
];

function ensure(cond, msg) {
  if (!cond) throw new Error(msg);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function logLine(file, text) {
  fs.appendFileSync(file, `[${new Date().toISOString()}] ${text}\n`, 'utf8');
}

function timelineEntryHasJson(entry) {
  return String((entry && entry.text) || '').includes('```json');
}

function inspectMeetingTimeline(meetingPath, subSessions, expectFull) {
  const meeting = JSON.parse(fs.readFileSync(meetingPath, 'utf8'));
  const timeline = Array.isArray(meeting._timeline) ? meeting._timeline : [];
  const bySid = new Map();
  for (const entry of timeline) {
    if (!entry || !entry.sid) continue;
    if (!bySid.has(entry.sid)) bySid.set(entry.sid, []);
    bySid.get(entry.sid).push(entry);
  }
  const required = [
    ['fund', subSessions[0]],
    ['news', subSessions[1]],
    ['tech', subSessions[2]],
  ];
  if (expectFull) required.push(['challenger', subSessions[3]]);
  const missing = required
    .filter(([, sid]) => !(bySid.get(sid) || []).some(timelineEntryHasJson))
    .map(([seat, sid]) => `${seat}:${sid}`);
  return {
    nextIdx: meeting._nextIdx,
    count: timeline.length,
    missing,
    timeline: timeline.map(entry => ({
      sid: String(entry.sid || '').slice(0, 8),
      len: String(entry.text || '').length,
      hasJson: timelineEntryHasJson(entry),
      preview: String(entry.text || '').slice(0, 80),
    })),
  };
}

function assertExpectedSlotSpecs(slotSpecs) {
  ensure(Array.isArray(slotSpecs), 'meeting slotSpecs missing');
  ensure(slotSpecs.length === EXPECTED_SLOT_SPECS.length, `expected ${EXPECTED_SLOT_SPECS.length} slotSpecs, got ${slotSpecs.length}`);
  for (let i = 0; i < EXPECTED_SLOT_SPECS.length; i += 1) {
    const actual = slotSpecs[i] || {};
    const expected = EXPECTED_SLOT_SPECS[i];
    ensure(actual.kind === expected.kind && actual.model === expected.model,
      `slot ${i + 1} mismatch: expected ${expected.kind}/${expected.model}, got ${actual.kind}/${actual.model}`);
  }
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('http timeout')));
  });
}

async function waitForCdp(logPath) {
  const deadline = Date.now() + 45000;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const targets = JSON.parse(await httpGet(`http://127.0.0.1:${CDP_PORT}/json/list`));
      const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (e) {
      lastErr = e;
    }
    await sleep(500);
  }
  logLine(logPath, `CDP wait failed: ${lastErr && lastErr.message}`);
  throw new Error(`CDP target not ready on ${CDP_PORT}`);
}

function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  return new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.once('open', () => {
      ws.removeListener('error', reject);
      ws.on('message', raw => {
        const msg = JSON.parse(raw.toString());
        if (!msg.id || !pending.has(msg.id)) return;
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      });
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          return new Promise((res, rej) => {
            pending.set(id, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close() { ws.close(); },
      });
    });
  });
}

function killTree(pid) {
  if (!pid) return;
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch {}
}

function setupTempLindang() {
  const pkg = path.join(LINDANG_DIR, 'committee');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, '__init__.py'), '', 'utf8');
  fs.writeFileSync(path.join(pkg, 'prep_case.py'), `
import argparse, json, pathlib
ROOT = pathlib.Path(r"${LINDANG_DIR.replace(/\\/g, '\\\\')}")
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("symbol")
    ap.add_argument("--fast", action="store_true")
    args = ap.parse_args()
    case_path = ROOT / "case.md"
    md = """# 投委会案卷 ｜ 测试股份（000001）｜ live-e2e

## 0. 覆盖度门控
数据覆盖度达标
**本场最高可评级：S**

## 1. 三面客观分（程序化锚点）
- **技术面客观分：+35**（覆盖度 ok）组件: {"trend":"启动","support":10.0,"resistance":12.0}
- **资金面客观分：+20**（覆盖度 ok）组件: {"main_inflow":"温和流入"}
- **基本面客观分：+42**（覆盖度 ok）组件: {"profit":"稳定","debt":"低"}

## 2. 红旗预检面板（程序化，基本面官逐项必答）
- 🟢 **现金流背离**：最近一期经营现金流为正，未触发。
- 🟢 **高质押**：控股股东质押率 0%，未触发。

## 3. 板块对照卡
真概念归属：银行测试、低估值测试
- **银行测试**：本股涨幅排名 2（分位 0.25），本股主力净流入 +1.20亿
  成交额龙头：测试龙头A(3.2%) ｜ 涨幅龙头：测试龙头B(5.1%)

## 4. 消息面速览
**研报一致预期**：近90日 6 篇 / 近一年 18 篇（5 家机构），多头占比 0.67，近30日 上调1/下调0/首次0
**近期强相关新闻**：
  - 2026-06-10 测试股份发布稳定分红计划

## 5. 机构记忆
本标的历史决议：
- V-LIVE-000001：B 级（待结算）假设: 稳增长催化未兑现
相关教训（引用须带 ID）：
- L-LIVE-001（命中 1/1）：低估值标的若没有短线催化，只能观察不能重仓。
"""
    case_path.write_text(md, encoding="utf-8")
    print(json.dumps({
      "ok": True,
      "symbol": args.symbol,
      "name": "测试股份",
      "mode": "quick" if args.fast else "full",
      "case_path": str(case_path),
      "coverage_gate": {"max_rating": "S", "missing": [], "note": "数据覆盖度达标"},
      "objective": {"technical": 35, "capital": 20, "fundamental": 42},
      "red_flags_summary": {"triggered": 0, "clear": 2, "no_data": 0},
      "markdown": md
    }, ensure_ascii=False))
if __name__ == "__main__":
    main()
`, 'utf8');
  fs.writeFileSync(path.join(pkg, 'committee_memory.py'), `
import argparse, json, pathlib, datetime
ROOT = pathlib.Path(r"${LINDANG_DIR.replace(/\\/g, '\\\\')}")
def write(name, data):
    p = ROOT / name
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd")
    q = sub.add_parser("query"); q.add_argument("--symbol")
    d = sub.add_parser("doctor")
    s = sub.add_parser("settle")
    a = sub.add_parser("append-verdict"); a.add_argument("--file")
    c = sub.add_parser("append-checkup"); c.add_argument("--file")
    l = sub.add_parser("add-lesson"); l.add_argument("--file")
    args = ap.parse_args()
    if args.cmd == "query":
        print(json.dumps({"ok": True, "calibration_active": True, "verdicts_same_symbol": [], "lessons": [], "scoreboard": {}}, ensure_ascii=False))
    elif args.cmd == "doctor":
        print(json.dumps({"ok": True, "status": "ok", "problems": [], "calibration": {"sessions": 1}}, ensure_ascii=False))
    elif args.cmd == "settle":
        print(json.dumps({"ok": True, "settled": 0}, ensure_ascii=False))
    elif args.cmd == "append-verdict":
        data = json.loads(pathlib.Path(args.file).read_text(encoding="utf-8"))
        write("live-append-verdict.json", data)
        print(json.dumps({"ok": True, "id": "V-LIVE-E2E-001", "path": str(ROOT / "live-append-verdict.json")}, ensure_ascii=False))
    elif args.cmd == "append-checkup":
        data = json.loads(pathlib.Path(args.file).read_text(encoding="utf-8"))
        write("live-append-checkup.json", data)
        print(json.dumps({"ok": True, "id": "C-LIVE-E2E-001"}, ensure_ascii=False))
    elif args.cmd == "add-lesson":
        data = json.loads(pathlib.Path(args.file).read_text(encoding="utf-8"))
        write("live-add-lesson.json", data)
        print(json.dumps({"ok": True, "id": "L-LIVE-E2E-001"}, ensure_ascii=False))
    else:
        print(json.dumps({"ok": False, "error": "bad cmd"}, ensure_ascii=False))
if __name__ == "__main__":
    main()
`, 'utf8');
}

(async () => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(LINDANG_DIR, { recursive: true });
  setupTempLindang();
  ensure(fs.existsSync(ELECTRON_EXE), `electron.exe not found: ${ELECTRON_EXE}`);

  const logPath = path.join(ARTIFACT_DIR, `committee-live-five-seat-${RUN_ID}.log`);
  const summaryPath = path.join(ARTIFACT_DIR, `committee-live-five-seat-${RUN_ID}.json`);
  const shotPath = path.join(ARTIFACT_DIR, `committee-live-five-seat-${RUN_ID}.png`);
  logLine(logPath, `start live five-seat E2E symbol=${SYMBOL}`);
  logLine(logPath, `dataDir=${DATA_DIR}`);
  logLine(logPath, `lindangDir=${LINDANG_DIR}`);

  const child = spawn(ELECTRON_EXE, [ROOT, `--remote-debugging-port=${CDP_PORT}`], {
    cwd: ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      CLAUDE_HUB_DATA_DIR: DATA_DIR,
      LINDANG_DIR,
      CLAUDE_HUB_MOBILE_ENABLED: '',
      CLAUDE_HUB_MOBILE_ISOLATED_OPTIN: '',
    },
  });
  logLine(logPath, `electronPid=${child.pid}`);
  child.stdout.on('data', d => fs.appendFileSync(logPath, d));
  child.stderr.on('data', d => fs.appendFileSync(logPath, d));

  let cdp = null;
  let hardTimer = null;
  try {
    hardTimer = setTimeout(() => {
      logLine(logPath, `hard timeout after ${HARD_TIMEOUT_MS}ms`);
      killTree(child.pid);
      process.exit(2);
    }, HARD_TIMEOUT_MS);

    logLine(logPath, 'wait CDP');
    const page = await waitForCdp(logPath);
    cdp = await cdpClient(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    logLine(logPath, 'create committee meeting with five real slots');
    const createResult = await cdp.send('Runtime.evaluate', {
      expression: `
        (async () => {
          const { ipcRenderer } = require('electron');
          const meeting = await ipcRenderer.invoke('create-meeting', {
            title: 'LIVE 五席投委会 E2E ${RUN_ID}',
            mode: 'committee',
            scene: 'committee',
            groupChat: true,
            groupMode: 'deliberation',
            groupRecentRawN: 5,
            slots: [
              { kind: 'deepseek', model: 'deepseek-v4-pro[1m]' },
              { kind: 'claude', model: 'claude-opus-4-8[1m]' },
              { kind: 'codex', model: 'gpt-5.5' },
              { kind: 'codex', model: 'gpt-5.5' },
              { kind: 'claude', model: 'claude-opus-4-8[1m]' },
            ],
          });
          return {
            id: meeting && meeting.id,
            scene: meeting && meeting.scene,
            subSessions: meeting && meeting.subSessions,
            slotSpecs: meeting && meeting.slotSpecs,
          };
        })()
      `,
      awaitPromise: true,
      returnByValue: true,
    });
    const created = createResult.result.value;
    ensure(created && created.id, 'create-meeting returned no id');
    ensure(created.scene === 'committee', `scene mismatch: ${created.scene}`);
    ensure(Array.isArray(created.subSessions) && created.subSessions.length === 5, `expected 5 subSessions, got ${created.subSessions && created.subSessions.length}`);
    assertExpectedSlotSpecs(created.slotSpecs);
    logLine(logPath, `created meeting ${created.id} subs=${created.subSessions.join(',')}`);

    await sleep(12000);
    logLine(logPath, `invoke groupchat:turn ${SYMBOL}`);
    const turnResult = await cdp.send('Runtime.evaluate', {
      expression: `
        (async () => {
          const { ipcRenderer } = require('electron');
          const started = Date.now();
          const turn = await ipcRenderer.invoke('groupchat:turn', {
            meetingId: '${created.id}',
            userInput: '${SYMBOL}',
          });
          return {
            elapsedMs: Date.now() - started,
            status: turn && turn.status,
            reason: turn && turn.reason,
            meta: turn && turn.meta,
            results: turn && Array.isArray(turn.results) ? turn.results.map(r => ({
              sid: r.sid,
              status: r.status,
              textLen: (r.text || '').length,
              textHead: (r.text || '').slice(0, 160),
            })) : null,
          };
        })()
      `,
      awaitPromise: true,
      returnByValue: true,
    });
    const turn = turnResult.result.value;
    logLine(logPath, `turn completed status=${turn && turn.status} elapsedMs=${turn && turn.elapsedMs}`);
    ensure(turn && turn.status === 'completed', `turn not completed: ${JSON.stringify(turn)}`);
    ensure(turn.meta && turn.meta.committee && turn.meta.committee.verdictValid === true, 'committee verdictValid not true');
    if (EXPECT_FULL) {
      ensure(turn.meta.committee.challengeHeld === true, 'full committee run should trigger challengeHeld');
    }

    const savedPath = path.join(LINDANG_DIR, 'live-append-verdict.json');
    ensure(fs.existsSync(savedPath), 'temp append-verdict payload missing');
    const saved = JSON.parse(fs.readFileSync(savedPath, 'utf8'));
    ensure(saved.value_speculation && saved.value_speculation.composite_score !== undefined, 'saved value_speculation missing');
    ensure(saved.portfolio && saved.portfolio.role, 'saved portfolio missing');

    const meetingPath = path.join(DATA_DIR, 'meetings', `${created.id}.json`);
    ensure(fs.existsSync(meetingPath), 'meeting file missing after live run');
    const timelineProbe = inspectMeetingTimeline(meetingPath, created.subSessions, EXPECT_FULL);
    ensure(timelineProbe.missing.length === 0, `committee timeline missing required JSON reports: ${timelineProbe.missing.join(', ')}`);
    const logText = fs.readFileSync(logPath, 'utf8');
    const recoveryMatches = Array.from(new Set(Array.from(logText.matchAll(RECOVERY_LOG_RE)).map(m => m[0])));
    if (REQUIRE_NO_DEGRADE) {
      ensure(!DEGRADE_LOG_RE.test(logText), 'live committee log contains degradation marker');
      if (EXPECT_FULL) {
        ensure(/幕二答辩压缩/.test(logText), 'full live run should compress Codex act2 defense instead of re-waking Codex analyst');
      }
    }

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    const summary = {
      ok: true,
      runId: RUN_ID,
      dataDir: DATA_DIR,
      lindangDir: LINDANG_DIR,
      cdpPort: CDP_PORT,
      meeting: created,
      turn,
      savedVerdict: {
        rating: saved.rating,
        value_speculation: saved.value_speculation,
        portfolio: saved.portfolio,
      },
      timelineProbe,
      recoveryMatches,
      screenshot: shotPath,
      log: logPath,
    };
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    if (hardTimer) clearTimeout(hardTimer);
    if (cdp) cdp.close();
    killTree(child.pid);
    await sleep(2000);
  }
})().catch(e => {
  console.error(e.stack || e.message);
  process.exit(1);
});
