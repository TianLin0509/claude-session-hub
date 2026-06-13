'use strict';

// E2E-ish degraded conductor test: some analyst seats are unavailable
// (auth_required / absent), but the committee should not hang. The chair can
// still issue a schema-valid verdict and the ledger records missing seats as
// errored.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = path.join(os.tmpdir(), `committee-conductor-degraded-${Date.now()}`);
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
  "objective": {"technical": 20, "capital": 10, "fundamental": 55},
  "markdown": "# 案卷\\n机构记忆：V-20260601-000001 / L-001\\n校准期进行中"
}, ensure_ascii=False))
`, 'utf8');
fs.writeFileSync(path.join(pkg, 'committee_memory.py'), `
import argparse, json, pathlib
ROOT = pathlib.Path(r"${tmp.replace(/\\/g, '\\\\')}")
def main():
  ap = argparse.ArgumentParser()
  sub = ap.add_subparsers(dest="cmd")
  a = sub.add_parser("append-verdict"); a.add_argument("--file")
  l = sub.add_parser("add-lesson"); l.add_argument("--file")
  args = ap.parse_args()
  if args.cmd == "append-verdict":
    data = json.loads(pathlib.Path(args.file).read_text(encoding="utf-8"))
    (ROOT / "append-verdict.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "id": "V-DEGRADED-001"}))
  elif args.cmd == "add-lesson":
    print(json.dumps({"ok": True, "id": "L-DEGRADED-001"}))
  else:
    print(json.dumps({"ok": False, "error": "bad cmd"}))
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
  id: 'm-degraded',
  scene: 'committee',
  groupChat: true,
  subSessions: ['sidFund', 'sidNews', 'sidTech', 'sidChal', 'sidChair'],
};

const progressTexts = [];
const dispatchCalls = [];

function bySid(sid, text, status = 'completed', reason = undefined) {
  return { sid, text, status, reason };
}

function fundReport() {
  return [
    'fund report',
    '```json',
    JSON.stringify({
      seat: 'fund',
      signal: '看多',
      confidence: 72,
      core_thesis: '基本面托底仍在但必须限仓观察催化兑现',
      assumptions: ['现金流不恶化', '短期催化不证伪'],
      evidence: [{ claim: '案卷显示基本面客观分 55', source: '案卷', strength: 'medium' }],
      kill_switch: '基本面分降至 30 以下则撤销买入假设',
      extras: {
        story_level: '有支撑',
        red_flag_review: [{ name: '现金流', comment: '案卷数字 55 支撑基本面仍可托底' }],
      },
    }),
    '```',
  ].join('\n');
}

const chairVerdict = {
  rating: 'A',
  position_type: '短线打野',
  core_thesis: '只有基本面官有效出席，仍可给小仓弹性观察，但禁止重仓。',
  faces: {
    fundamental: { score: 55, comment: '基本面可托底但非强确认' },
    news: { score: 0, comment: '消息面官缺席，按未知处理' },
    technical: { score: 0, comment: '技术面官缺席，按未知处理' },
  },
  value_speculation: {
    fundamental_floor: '中',
    theme_purity: '沾边',
    expectation_gap: '一般',
    flow_elasticity: '未知',
    timing_window: '未来 1-3 个月只观察催化兑现',
    composite_score: 62,
    vetoes: ['消息面与技术面席位缺席，禁止升 S'],
  },
  portfolio: {
    role: '弹性仓',
    suggested_cap_pct: 6,
    add_rule: '补齐消息面和技术面验证后再加仓',
    trim_rule: '跌破止损或催化证伪立即退出',
  },
  entry: { zone: '10-11', logic: '只允许回踩不破后小仓试错' },
  stop: '9.5',
  position_cap: '最高 6%，缺席席位未恢复前不加仓',
  catalysts: [{ date: '2026-07', event: '验证短期催化' }],
  disagreements: ['消息面官缺席', '技术面官缺席'],
  alt_check: '同板块替代标的需等消息面和技术面席位恢复后再比价',
  assumptions: ['基本面托底不恶化', '缺席席位恢复后不反向证伪'],
  kill_switch_summary: ['跌破 9.5', '消息面恢复后判定为蹭热点'],
  upgrade_trigger: '',
  if_holding: '持有者降到观察仓',
  if_not_holding: '未持有者只允许小仓试错',
  memory_read: ['V-20260601-000001', 'L-001'],
  lesson_suggest: null,
};

async function dispatchGroupChatTurn(_meetingId, { userInput, turnTimeoutMs }) {
  dispatchCalls.push({ userInput, turnTimeoutMs });
  if (userInput.includes('点名')) {
    return {
      status: 'completed',
      results: [
        bySid('sidFund', '就位'),
        bySid('sidNews', '', 'errored', 'auth_required'),
        bySid('sidTech', '', 'absent'),
        bySid('sidChal', '就位'),
        bySid('sidChair', '就位'),
      ],
    };
  }
  if (userInput.includes('幕一')) {
    return {
      status: 'completed',
      results: [
        bySid('sidFund', fundReport()),
        bySid('sidNews', '', 'errored', 'auth_required'),
        bySid('sidTech', '', 'absent'),
      ],
    };
  }
  if (userInput.includes('@m2') || userInput.includes('@m3')) {
    return {
      status: 'completed',
      results: [
        bySid('sidNews', '', 'errored', 'auth_required'),
        bySid('sidTech', '', 'absent'),
      ],
    };
  }
  if (userInput.includes('幕三')) {
    return {
      status: 'completed',
      results: [bySid('sidChair', '主席裁决\n```json\n' + JSON.stringify(chairVerdict) + '\n```')],
    };
  }
  return { status: 'completed', results: [] };
}

const conductor = createCommitteeConductor({
  dispatchGroupChatTurn,
  meetingManager: { getMeeting: () => meeting },
  sessionManager: { getSession: sid => sessions[sid] },
  logger: { log() {}, warn() {} },
  sendToRenderer: (_channel, payload) => progressTexts.push(String(payload && payload.text || '')),
});

(async () => {
  const result = await conductor.runCommitteeSession('m-degraded', '002230');
  assert.strictEqual(result.status, 'completed');
  assert.strictEqual(result.meta.committee.verdictValid, true);
  assert.strictEqual(result.meta.committee.verdictId, 'V-DEGRADED-001');
  assert.ok(dispatchCalls.some(c => Number(c.turnTimeoutMs) > 0), 'committee dispatch should pass hard timeouts');
  assert.ok(progressTexts.some(t => t.includes('缺席')), 'progress should disclose missing seats');

  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'append-verdict.json'), 'utf8'));
  assert.strictEqual(saved.rating, 'A');
  assert.strictEqual(saved.value_speculation.composite_score, 62);
  assert.strictEqual(saved.portfolio.suggested_cap_pct, 6);
  assert.strictEqual(saved.seats.fund.signal, '看多');
  assert.strictEqual(saved.seats.news.signal, 'errored');
  assert.strictEqual(saved.seats.tech.signal, 'errored');
  console.log(JSON.stringify({
    ok: true,
    tempDir: tmp,
    verdict: result.meta.committee,
    degradedSeats: {
      news: saved.seats.news,
      tech: saved.seats.tech,
    },
  }, null, 2));
})().catch(e => {
  console.error(e.stack || e.message);
  process.exit(1);
});
