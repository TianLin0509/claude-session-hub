'use strict';

// Stress test for the investment committee conductor. This uses the real
// conductor state machine with fake dispatcher/model outputs, so it can run
// often without spending external model quota. It targets stability invariants:
// complete sessions, no seat cross-wiring with duplicate Claude/Codex kinds,
// bounded retries, and no unexpected degradation on happy paths.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ARTIFACT_DIR = 'C:\\Users\\lintian\\hub-committee-artifacts';
const SUMMARY_PATH = path.join(ARTIFACT_DIR, 'committee-stress-summary.json');
const tmp = path.join(os.tmpdir(), `committee-stress-${Date.now()}`);
const pkg = path.join(tmp, 'committee');
fs.mkdirSync(pkg, { recursive: true });
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
fs.writeFileSync(path.join(pkg, '__init__.py'), '', 'utf8');
fs.writeFileSync(path.join(pkg, 'prep_case.py'), `
import json, sys, pathlib
symbol = sys.argv[1]
root = pathlib.Path(r"${tmp.replace(/\\/g, '\\\\')}")
case_path = root / (symbol + ".md")
case_path.write_text("# 案卷\\\\n机构记忆：V-20260601-000001 / L-001\\\\n校准期进行中", encoding="utf-8")
print(json.dumps({
  "ok": True,
  "symbol": symbol,
  "name": "压力测试股份",
  "case_path": str(case_path),
  "coverage_gate": {"max_rating": "S"},
  "objective": {"technical": 35, "capital": 30, "fundamental": 55},
  "markdown": case_path.read_text(encoding="utf-8")
}, ensure_ascii=False))
`, 'utf8');
fs.writeFileSync(path.join(pkg, 'committee_memory.py'), `
import argparse, json, pathlib
ROOT = pathlib.Path(r"${tmp.replace(/\\/g, '\\\\')}")
def main():
  ap = argparse.ArgumentParser()
  sub = ap.add_subparsers(dest="cmd")
  a = sub.add_parser("append-verdict"); a.add_argument("--file")
  c = sub.add_parser("append-checkup"); c.add_argument("--file")
  l = sub.add_parser("add-lesson"); l.add_argument("--file")
  args = ap.parse_args()
  if args.cmd in ("append-verdict", "append-checkup"):
    data = json.loads(pathlib.Path(args.file).read_text(encoding="utf-8"))
    seq = len(list(ROOT.glob(args.cmd + "-*.json"))) + 1
    out = ROOT / (args.cmd + "-" + str(seq).zfill(3) + ".json")
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    prefix = "V-STRESS-" if args.cmd == "append-verdict" else "C-STRESS-"
    print(json.dumps({"ok": True, "id": prefix + str(seq).zfill(3)}, ensure_ascii=False))
  elif args.cmd == "add-lesson":
    print(json.dumps({"ok": True, "id": "L-STRESS-001"}, ensure_ascii=False))
  else:
    print(json.dumps({"ok": False, "error": "bad cmd"}, ensure_ascii=False))
if __name__ == "__main__":
  main()
`, 'utf8');

process.env.LINDANG_DIR = tmp;

const { createCommitteeConductor } = require('../main/groupchat/committee-conductor.js');

const sessions = {
  sidFund: { id: 'sidFund', kind: 'deepseek', status: 'active' },
  sidNews: { id: 'sidNews', kind: 'claude', status: 'active' },
  sidTech: { id: 'sidTech', kind: 'codex', status: 'active' },
  sidChal: { id: 'sidChal', kind: 'codex', status: 'active' },
  sidChair: { id: 'sidChair', kind: 'claude', status: 'active' },
};
const meeting = {
  id: 'm-stress',
  scene: 'committee',
  groupChat: true,
  subSessions: ['sidFund', 'sidNews', 'sidTech', 'sidChal', 'sidChair'],
};

let active = null;
let progressTexts = [];
let dispatchCalls = [];

function bySid(sid, text, status = 'completed', reason = undefined) {
  return { sid, text, status, reason };
}

function analystJson(seat, signal, confidence, extras) {
  return [
    `${seat} report`,
    '```json',
    JSON.stringify({
      seat,
      signal,
      confidence,
      core_thesis: `${seat} 给出可验证的压力测试结论`,
      assumptions: ['案卷数据可用', '关键触发未证伪'],
      evidence: [{ claim: `案卷客观分支持 ${seat}`, source: '案卷', strength: 'medium' }],
      kill_switch: '跌破关键位或催化证伪',
      extras,
    }),
    '```',
  ].join('\n');
}

function fundReport() {
  return analystJson('fund', active.fundSignal || '看多', 72, {
    story_level: '有支撑',
    red_flag_review: [{ name: '现金流', comment: '案卷数字 55 支持基本面托底' }],
  });
}

function newsReport() {
  return analystJson('news', active.newsSignal || '看多', 70, {
    story_grade: '产业叙事',
    sector_position: '中军',
    catalysts: [{ date: '2026-07', event: '压力测试催化', expectation_gap: '市场低估兑现节奏' }],
  });
}

function techReport() {
  return analystJson('tech', active.techSignal || '中性', 58, {
    trend_stage: '启动',
    support: 10,
    resistance: 12,
    stop_suggest: 9.5,
  });
}

function verdictJson(overrides = {}) {
  return {
    rating: 'A',
    position_type: '短线打野',
    core_thesis: '基本面有托底，题材和技术需继续验证，适合弹性仓试错。',
    faces: {
      fundamental: { score: 55, comment: '托底中等' },
      news: { score: 45, comment: '催化一般' },
      technical: { score: 40, comment: '启动未确认' },
    },
    value_speculation: {
      fundamental_floor: '中',
      theme_purity: '沾边',
      expectation_gap: '一般',
      flow_elasticity: '中',
      timing_window: '未来 1-3 个月观察催化兑现',
      composite_score: 68,
      vetoes: [],
    },
    portfolio: {
      role: '弹性仓',
      suggested_cap_pct: 8,
      add_rule: '放量突破压力位后再加仓',
      trim_rule: '跌破止损或催化证伪则退出',
    },
    entry: { zone: '10-11', logic: '回踩不破后试错' },
    stop: '9.5',
    position_cap: '最高 8%',
    catalysts: [{ date: '2026-07', event: '压力测试催化' }],
    disagreements: [],
    alt_check: '同板块替代标的需要更强催化才优先',
    assumptions: ['基本面托底不恶化', '催化未证伪'],
    kill_switch_summary: ['跌破 9.5', '催化证伪'],
    upgrade_trigger: '',
    if_holding: '持有者保留弹性仓',
    if_not_holding: '未持有者小仓试错',
    memory_read: ['V-20260601-000001', 'L-001'],
    lesson_suggest: null,
    ...overrides,
  };
}

function checkupVerdict() {
  return {
    checkups: [
      { symbol: '002230', name: '测试A', action: '持有', reason: '尚未触发卖出条件', stop: 38.5, recheck_trigger: '跌破 38.5' },
      { symbol: '688008', name: '测试B', action: '减仓', reason: '题材拥挤且技术转弱', stop: 192, recheck_trigger: '重新站回 MA5' },
    ],
    portfolio_note: '组合半导体集中度偏高，先降低拥挤票',
    portfolio_risk: { concentration: '高', theme_crowding: '高', first_action: '先减 688008' },
  };
}

async function dispatchGroupChatTurn(_meetingId, { userInput, turnTimeoutMs }) {
  dispatchCalls.push({ scenario: active.name, userInput, turnTimeoutMs });
  const mark = (branch) => { dispatchCalls[dispatchCalls.length - 1].branch = branch; };
  if (userInput.includes('点名')) {
    mark('rollcall');
    return {
      status: 'completed',
      results: [
        bySid('sidFund', '就位'),
        bySid('sidNews', active.rollMissing === 'news' ? '' : '就位', active.rollMissing === 'news' ? 'absent' : 'completed'),
        bySid('sidTech', active.rollMissing === 'tech' ? '' : '就位', active.rollMissing === 'tech' ? 'absent' : 'completed'),
        bySid('sidChal', active.rollMissing === 'challenger' ? '' : '就位', active.rollMissing === 'challenger' ? 'absent' : 'completed'),
        bySid('sidChair', '就位'),
      ],
    };
  }
  if (active.checkup && userInput.includes('@m1') && userInput.includes('@m3')) {
    mark('checkup-analyst');
    return {
      status: 'completed',
      results: [
        bySid('sidFund', '```json\n{"seat":"fund","checks":[{"symbol":"002230","signal":"健康","sell_reasons_hit":[],"hold_guards_hit":["催化未到"],"comment":"含数字 38.5 的健康说明"}]}\n```'),
        bySid('sidTech', '```json\n{"seat":"tech","checks":[{"symbol":"688008","signal":"警惕","sell_reasons_hit":["趋势转弱"],"hold_guards_hit":[],"comment":"含数字 192 的警惕说明","stop_suggest":192}]}\n```'),
      ],
    };
  }
  if (active.checkup && userInput.includes('@m5')) {
    mark('checkup-chair');
    return { status: 'completed', results: [bySid('sidChair', '```json\n' + JSON.stringify(checkupVerdict()) + '\n```')] };
  }
  if (!active.checkup && (userInput.includes('@m1') || userInput.includes('@m2') || userInput.includes('@m3'))) {
    mark('act1');
    const mentionCount = ['@m1', '@m2', '@m3'].filter(m => userInput.includes(m)).length;
    const mainRound = mentionCount > 1;
    const results = [];
    if (userInput.includes('@m1')) results.push(bySid('sidFund', fundReport()));
    if (userInput.includes('@m2')) {
      results.push(bySid('sidNews',
        active.absentFirst === 'news' && mainRound ? '' : newsReport(),
        active.absentFirst === 'news' && mainRound ? 'absent' : 'completed'));
    }
    if (userInput.includes('@m3')) {
      results.push(bySid('sidTech',
        active.malformedFirst === 'tech' && mainRound ? '```json\n{"seat":"tech"}\n```' : techReport()));
    }
    return {
      status: 'completed',
      results,
    };
  }
  if (userInput.includes('退回重写') || (!active.checkup && (userInput.includes('@m2') || userInput.includes('@m3')))) {
    mark('retry');
    if (userInput.includes('@m2')) return { status: 'completed', results: [bySid('sidNews', newsReport())] };
    if (userInput.includes('@m3')) return { status: 'completed', results: [bySid('sidTech', techReport())] };
  }
  if (!active.checkup && userInput.includes('@m4')) {
    mark('challenge');
    if (active.challengeAbsent) return { status: 'completed', results: [bySid('sidChal', '', 'absent')] };
    return { status: 'completed', results: [bySid('sidChal', '```json\n{"targets":[],"priced_in_risk":"low","summary":"无强质询"}\n```')] };
  }
  if (!active.checkup && userInput.includes('@m5')) {
    mark('chair');
    if (active.chairBadOnce && !active._chairBadReturned && !userInput.includes('裁决退回')) {
      active._chairBadReturned = true;
      return { status: 'completed', results: [bySid('sidChair', '```json\n{"rating":"A"}\n```')] };
    }
    return { status: 'completed', results: [bySid('sidChair', '```json\n' + JSON.stringify(verdictJson(active.verdictOverrides)) + '\n```')] };
  }
  mark('default');
  return { status: 'completed', results: [] };
}

const conductor = createCommitteeConductor({
  dispatchGroupChatTurn,
  meetingManager: { getMeeting: () => meeting },
  sessionManager: { getSession: sid => sessions[sid] },
  logger: { log() {}, warn() {} },
  sendToRenderer: (_channel, payload) => progressTexts.push(String(payload && payload.text || '')),
});

const scenarioTemplates = [
  { name: 'happy-a', fundSignal: '看多', newsSignal: '看多', techSignal: '中性' },
  { name: 'happy-bearish-split', fundSignal: '看多', newsSignal: '看空', techSignal: '中性' },
  { name: 'malformed-tech-recovers', malformedFirst: 'tech', expectedRetry: true },
  { name: 'absent-news-recovers', absentFirst: 'news', expectedDegrade: true },
  { name: 'roll-missing-news-does-not-degrade', rollMissing: 'news' },
  { name: 'challenge-absent', fundSignal: '看多', newsSignal: '看多', techSignal: '看多', challengeAbsent: true, full: true, expectedDegrade: true },
  { name: 'chair-bad-once-recovers', chairBadOnce: true, expectedRetry: true },
  { name: 'checkup', checkup: true },
];

(async () => {
  const runs = [];
  const total = Number(process.env.COMMITTEE_STRESS_N || 100);
  for (let i = 0; i < total; i += 1) {
    active = { ...scenarioTemplates[i % scenarioTemplates.length] };
    progressTexts = [];
    dispatchCalls = [];
    const input = active.checkup
      ? '体检 002230 成本41.5 仓位20% 688008 成本71.1 仓位15%'
      : `${String(100000 + i).slice(-6)}${active.full ? ' 全量' : ''}`;
    const t0 = Date.now();
    const result = await conductor.runCommitteeSession('m-stress', input);
    const elapsedMs = Date.now() - t0;
    const degraded = progressTexts.some(t => /缺席|未应答|超时|派发失败/.test(t));
    const retried = progressTexts.some(t => /重试|校验未过|退回/.test(t));
    const verdictValid = !!(result && result.meta && result.meta.committee && result.meta.committee.verdictValid);
    const ok = result.status === 'completed' && verdictValid;
    if (active.rollMissing === 'news') {
      const mainAct1 = dispatchCalls.find(c => c.branch === 'act1' && c.userInput.includes('@m1'));
      assert.ok(mainAct1, `run ${i} should have a primary act1 call`);
      assert.ok(mainAct1.userInput.includes('@m2'), `run ${i} should keep warmup-missed news seat in primary act1`);
      const newsRetry = dispatchCalls.find(c => c.branch === 'act1' && c.userInput.includes('@m2') && !c.userInput.includes('@m1'));
      assert.ok(!newsRetry, `run ${i} should not degrade rollcall miss into direct short-budget retry`);
    }
    runs.push({ i, scenario: active.name, ok, status: result.status, verdictValid, degraded, retried, elapsedMs });
    assert.ok(ok, `run ${i} ${active.name} should complete with valid verdict`);
    if (active.expectedDegrade) {
      assert.strictEqual(degraded, true, `run ${i} ${active.name} should record expected degradation`);
    } else {
      assert.strictEqual(degraded, false, `run ${i} ${active.name} degraded unexpectedly: ${JSON.stringify({
        progressTexts,
        dispatchInputs: dispatchCalls.map(c => ({ branch: c.branch, input: c.userInput.slice(0, 220) })),
      })}`);
    }
  }

  const summary = {
    ok: true,
    total,
    completed: runs.filter(r => r.ok).length,
    degraded: runs.filter(r => r.degraded).length,
    retried: runs.filter(r => r.retried).length,
    byScenario: Object.fromEntries(scenarioTemplates.map(t => {
      const subset = runs.filter(r => r.scenario === t.name);
      return [t.name, {
        total: subset.length,
        completed: subset.filter(r => r.ok).length,
        degraded: subset.filter(r => r.degraded).length,
        retried: subset.filter(r => r.retried).length,
      }];
    })),
    tempDir: tmp,
    runs,
  };
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), 'utf8');
  console.log(JSON.stringify(summary, null, 2));
})().catch(e => {
  console.error(e.stack || e.message);
  process.exit(1);
});
