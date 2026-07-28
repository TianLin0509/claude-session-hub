'use strict';
// 卡片视图里 AI 回答卡"重复出现两遍"的怀疑点：turn.id 不稳定。
// mountSessionTurnCard 是按 turn.id 去重的，同一条内容只要两次解析拿到不同 id，
// 就会被当成两条新卡挂两次。
// codex 解析器的 _makeTurnId 在没有 obj.id 时回落成 `${prefix}-${ts}-${行号}`，
// 而卡片视图会做尾部增量读取（fromTail+limit）——行号在尾读里是从切片开头重新数的，
// 与全量读不同 → 同一条内容两次解析 id 不一样。
//   node tests/diag-codex-turn-id-drift.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseCodexRolloutToTurns } = require('../core/codex-transcript-parser.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-idrift-'));
const FILE = path.join(ROOT, 'rollout.jsonl');

// 造一个多轮 rollout：user → agent_message → task_complete，重复 N 次。
// 每条都不带 id 字段（真实 rollout 实测就是这样），逼解析器走行号回落。
function buildRollout(turns) {
  const lines = [];
  lines.push(JSON.stringify({
    timestamp: '2026-07-28T00:00:00.000Z', type: 'session_meta',
    payload: { session_id: 'sid-x', cwd: 'C:/tmp' },
  }));
  for (let i = 1; i <= turns; i++) {
    const ts = `2026-07-28T00:${String(i).padStart(2, '0')}:00.000Z`;
    lines.push(JSON.stringify({
      timestamp: ts, type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `用户第 ${i} 问` }] },
    }));
    lines.push(JSON.stringify({
      timestamp: ts, type: 'event_msg',
      payload: { type: 'agent_message', message: `助手第 ${i} 答` },
    }));
    lines.push(JSON.stringify({
      timestamp: ts, type: 'event_msg',
      payload: { type: 'task_complete', last_agent_message: `助手第 ${i} 答` },
    }));
  }
  fs.writeFileSync(FILE, lines.join('\n') + '\n', 'utf8');
}

function main() {
  buildRollout(30);

  const full = parseCodexRolloutToTurns(FILE);
  const tail = parseCodexRolloutToTurns(FILE, { limit: 6, fromTail: true });

  console.log(`全量解析: ${full.length} 轮   尾部解析(limit 6): ${tail.length} 轮`);

  const fullIds = new Set(full.map(t => t.id));
  const drift = tail.filter(t => !fullIds.has(t.id));

  console.log(`\n尾部解析出的 id 在全量里找不到的条数: ${drift.length}`);
  for (const d of drift.slice(0, 6)) {
    const same = full.find(t => t.role === d.role && (t.text || '') === (d.text || ''));
    console.log(`  [${d.role}] ${JSON.stringify((d.text || '').slice(0, 16))}`);
    console.log(`      尾读 id: ${d.id}`);
    console.log(`      全量 id: ${same ? same.id : '(没找到同内容的)'}`);
  }

  console.log('\n=== 判定 ===');
  if (drift.length > 0) {
    console.log('❌ 复现：同一条内容在两次解析里拿到不同 id —— 卡片会被挂两遍');
    process.exitCode = 1;
  } else {
    console.log('✅ id 在全量/尾读之间稳定，不会重复挂卡');
  }
}

try { main(); } finally { fs.rmSync(ROOT, { recursive: true, force: true }); }
