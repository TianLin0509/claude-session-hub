'use strict';
// 点2 集成回归：真实 orchestrator（非 mock）模拟 dispatcher 五幕 silent 调用序列
// （buildFirstDelta 拿 prompt → rollbackTurn → markDeliveredSilent，与 dispatcher silent 分支同款），
// 断言每委员只「首次被叫」带 systemPrompt（含战法规则），点评/辩论幕走增量不重发（防上下文污染回归）。
const fs = require('fs'); const os = require('os'); const path = require('path');
const groupchat = require(path.join(__dirname, '..', 'core', 'group-chat-orchestrator.js'));

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log(' FAIL ' + m); } else { console.log('  ok   ' + m); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-p2-'));
const orch = groupchat.getOrchestrator(tmp, 'm-p2');
const RULE = '右侧交易战法纪律';
const sys = kind => groupchat.buildSystemPromptText(kind, 'research', { kind });
ok(sys('deepseek').includes(RULE), 'research systemPrompt 含战法规则');

const SIDS = ['s-ds', 's-cl', 's-cx'];
function act(sids, userInput) {
  const p = {};
  for (const sid of sids) p[sid] = orch.buildFirstDelta(sid, userInput, sys('deepseek'));
  orch.rollbackTurn(0);                              // silent 分支同款
  orch.markDeliveredSilent(sids.map(sid => ({ sid })));
  return p;
}

act(['s-cl'], '立会');                                // 主席首次被叫
const build = act(SIDS, '建库');
ok(build['s-ds'].includes(RULE) && build['s-cx'].includes(RULE), '建库幕：首次被叫的委员带规则（正常，每委员首次须带一次）');
ok(!build['s-cl'].includes(RULE), '建库幕：立会已叫过的主席不再带规则');
const review = act(SIDS, '点评');
ok(SIDS.every(s => !review[s].includes(RULE)), '点评幕：全员走增量、不重发规则（点2 核心）');
const debate = act(SIDS, '辩论');
ok(SIDS.every(s => !debate[s].includes(RULE)), '辩论幕：全员不重发规则');

console.log('\n' + (fails === 0 ? '=== committee-point2-resend 全绿（每委员只首次带规则）===' : '=== ' + fails + ' FAILED ==='));
process.exit(fails === 0 ? 0 : 1);
