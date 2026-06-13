'use strict';

// E2E-ish conductor test: real committee-conductor state machine with fake
// dispatcher sessions and a temporary LinDangAgent committee Python package.
// Covers full verdict/checkup flow without invoking external model CLIs.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const tmp = path.join(os.tmpdir(), `committee-conductor-e2e-${Date.now()}`);
const pkg = path.join(tmp, 'committee');
fs.mkdirSync(pkg, { recursive: true });
fs.writeFileSync(path.join(pkg, '__init__.py'), '', 'utf8');
fs.writeFileSync(path.join(pkg, 'prep_case.py'), `
import json, sys
symbol = sys.argv[1]
print(json.dumps({
  "ok": True,
  "symbol": symbol,
  "name": "测试股份",
  "case_path": r"${tmp.replace(/\\/g, '\\\\')}\\\\case.md",
  "coverage_gate": {"max_rating": "S"},
  "objective": {"technical": 30, "capital": 20, "fundamental": 50},
  "markdown": "# 案卷\\\\n机构记忆：V-20260601-000001 / L-001\\\\n校准期进行中"
}, ensure_ascii=False))
`, 'utf8');
fs.writeFileSync(path.join(pkg, 'committee_memory.py'), `
import argparse, json, pathlib
ROOT = pathlib.Path(r"${tmp.replace(/\\/g, '\\\\')}")
def main():
  ap = argparse.ArgumentParser()
  sub = ap.add_subparsers(dest="cmd")
  a = sub.add_parser("append-verdict"); a.add_argument("--file")
  b = sub.add_parser("append-checkup"); b.add_argument("--file")
  l = sub.add_parser("add-lesson"); l.add_argument("--file")
  args = ap.parse_args()
  if args.cmd in ("append-verdict", "append-checkup"):
    data = json.loads(pathlib.Path(args.file).read_text(encoding="utf-8"))
    out = ROOT / (args.cmd + ".json")
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "id": "V-E2E-001" if args.cmd == "append-verdict" else "C-E2E-001"}))
  elif args.cmd == "add-lesson":
    print(json.dumps({"ok": True, "id": "L-E2E-001"}))
  else:
    print(json.dumps({"ok": False, "error": "bad cmd"}))
if __name__ == "__main__":
  main()
`, 'utf8');

process.env.LINDANG_DIR = tmp;

const scene = require('../core/committee-scene.js');
const { createCommitteeConductor } = require('../main/groupchat/committee-conductor.js');

const sessions = {
  sidFund: { id: 'sidFund', kind: 'deepseek', status: 'active' },
  sidNews: { id: 'sidNews', kind: 'claude', status: 'active' },
  sidTech: { id: 'sidTech', kind: 'codex', status: 'active' },
  sidChal: { id: 'sidChal', kind: 'codex', status: 'active' },
  sidChair: { id: 'sidChair', kind: 'claude', status: 'active' },
};
const meeting = {
  id: 'm1',
  scene: 'committee',
  groupChat: true,
  subSessions: ['sidFund', 'sidNews', 'sidTech', 'sidChal', 'sidChair'],
};
const progressEvents = [];

function bySid(sid, text) {
  return { sid, text };
}

function analystJson(seat, signal, confidence, extras) {
  return [
    `${seat} 口头要点`,
    '```json',
    JSON.stringify({
      seat,
      signal,
      confidence,
      core_thesis: `${seat} 有具体结论`,
      assumptions: ['假设一', '假设二'],
      evidence: [{ claim: '案卷证据', source: '案卷', strength: 'medium' }],
      kill_switch: '跌破关键位说明我错了',
      extras,
    }),
    '```',
  ].join('\n');
}

const verdict = {
  rating: 'A',
  position_type: '短线打野',
  core_thesis: '基本面托底中等，预期差明确，适合小仓位右侧参与',
  faces: {
    fundamental: { score: 35, comment: '托底中等' },
    news: { score: 55, comment: '预期差明确' },
    technical: { score: 40, comment: '趋势启动' },
  },
  value_speculation: {
    fundamental_floor: '中',
    theme_purity: '正宗',
    expectation_gap: '明确',
    flow_elasticity: '强',
    timing_window: '未来 1-3 个月',
    composite_score: 78,
    vetoes: [],
  },
  portfolio: {
    role: '弹性仓',
    suggested_cap_pct: 12,
    add_rule: '放量站稳压力位后加',
    trim_rule: '跌破止损或催化兑现后减',
  },
  entry: { zone: '10-11', logic: '回踩不破' },
  stop: '9.5',
  position_cap: '最高 12%',
  catalysts: [{ date: '2026-07', event: '测试催化' }],
  disagreements: [],
  alt_check: '同板块替代标的已对比',
  assumptions: ['催化未兑现', '基本面不恶化'],
  kill_switch_summary: ['跌破 9.5'],
  upgrade_trigger: '',
  if_holding: '持有，跌破止损减',
  if_not_holding: '等回踩确认',
  memory_read: ['V-20260601-000001', 'L-001'],
  lesson_suggest: { text: '测试教训', tags: ['测试'] },
};

const checkupVerdict = {
  checkups: [
    { symbol: '002230', name: '科大讯飞', action: '持有', reason: '未触发卖出理由', stop: 38.5, recheck_trigger: '跌破 38.5' },
    { symbol: '688008', name: '澜起科技', action: '减仓', reason: '破位且同题材拥挤', stop: 192, recheck_trigger: '放量站回 MA5' },
  ],
  portfolio_note: '组合半导体集中度偏高，先降拥挤票',
  portfolio_risk: { concentration: '高', theme_crowding: '高', first_action: '先减 688008' },
};

async function dispatchGroupChatTurn(_meetingId, { userInput }) {
  if (userInput.includes('点名')) {
    return { status: 'completed', results: Object.keys(sessions).map(sid => bySid(sid, '就位')) };
  }
  if (userInput.includes('幕一')) {
    return {
      status: 'completed',
      results: [
        bySid('sidFund', analystJson('fund', '看多', 72, { story_level: '有支撑', red_flag_review: [{ name: '现金流', comment: '现金流正常且有数字 123' }] })),
        bySid('sidNews', analystJson('news', '看多', 74, { story_grade: '产业叙事', sector_position: '龙头', catalysts: [{ date: '2026-07', event: '催化', expectation_gap: '市场低估' }] })),
        bySid('sidTech', analystJson('tech', '中性', 55, { trend_stage: '启动', support: 10, resistance: 12, stop_suggest: 9.5 })),
      ],
    };
  }
  if (userInput.includes('幕三')) {
    return { status: 'completed', results: [bySid('sidChair', '主席裁决\n```json\n' + JSON.stringify(verdict) + '\n```')] };
  }
  if (userInput.includes('体检') && userInput.includes('研判')) {
    return {
      status: 'completed',
      results: [
        bySid('sidFund', '```json\n{"seat":"fund","checks":[{"symbol":"002230","signal":"健康","sell_reasons_hit":[],"hold_guards_hit":["催化剂日期未到"],"comment":"含数字 123 的健康说明"}]}\n```'),
        bySid('sidTech', '```json\n{"seat":"tech","checks":[{"symbol":"688008","signal":"警惕","sell_reasons_hit":["板块退潮"],"hold_guards_hit":[],"comment":"含数字 192 的警惕说明","stop_suggest":192}]}\n```'),
      ],
    };
  }
  if (userInput.includes('体检') && userInput.includes('裁决')) {
    return { status: 'completed', results: [bySid('sidChair', '```json\n' + JSON.stringify(checkupVerdict) + '\n```')] };
  }
  return { status: 'completed', results: [] };
}

const conductor = createCommitteeConductor({
  dispatchGroupChatTurn,
  meetingManager: { getMeeting: () => meeting },
  sessionManager: { getSession: sid => sessions[sid] },
  logger: { log() {}, warn() {} },
  sendToRenderer: (_channel, payload) => progressEvents.push(payload),
});

(async () => {
  const r1 = await conductor.runCommitteeSession('m1', '002230');
  assert.strictEqual(r1.status, 'completed');
  assert.strictEqual(r1.meta.committee.verdictValid, true);
  assert.strictEqual(r1.meta.committee.rating, 'A');
  const savedVerdict = JSON.parse(fs.readFileSync(path.join(tmp, 'append-verdict.json'), 'utf8'));
  assert.strictEqual(savedVerdict.value_speculation.composite_score, 78);
  assert.strictEqual(savedVerdict.portfolio.role, '弹性仓');

  const r2 = await conductor.runCommitteeSession('m1', '体检 002230 成本41.5 688008 成本71.1');
  assert.strictEqual(r2.status, 'completed');
  assert.strictEqual(r2.meta.committee.verdictValid, true);
  const savedCheckup = JSON.parse(fs.readFileSync(path.join(tmp, 'append-checkup.json'), 'utf8'));
  assert.strictEqual(savedCheckup.portfolio_risk.concentration, '高');
  assert.strictEqual(savedCheckup.checkups.length, 2);
  assert.ok(progressEvents.some(e => String(e.text || '').includes('Dashboard')));
  console.log(JSON.stringify({ ok: true, tempDir: tmp, verdict: r1.meta.committee, checkup: r2.meta.committee }, null, 2));
})().catch(e => {
  console.error(e.stack || e.message);
  process.exit(1);
});
