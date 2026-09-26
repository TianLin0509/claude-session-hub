'use strict';
// 合成 Claude 落盘记录：若干轮普通问答 + 最后一轮带很多条「进展」再给「结果」。
// 形状与真实 ~/.claude/projects/*.jsonl 一致（text / tool_use / tool_result 分条落盘）。
function claudeLongTurnTranscript({ sessionId, cwd, earlierTurns = 4, progress = 20, start = Date.parse('2026-09-26T07:00:00Z') }) {
  const lines = [];
  let t = start, n = 0, parent = null;
  const push = (entry) => { const uuid = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    lines.push({ parentUuid: parent, isSidechain: false, userType: 'external', cwd, sessionId, version: '2.1.0', uuid,
      timestamp: new Date(t += 20000).toISOString(), ...entry }); parent = uuid; return uuid; };
  const user = text => push({ type: 'user', message: { role: 'user', content: text } });
  const said = (msg, text, stop) => push({ type: 'assistant', message: { id: msg, type: 'message', role: 'assistant', model: 'claude-opus-5-5',
    content: [{ type: 'text', text }], stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 } } });
  const tool = (msg, id) => { push({ type: 'assistant', message: { id: msg, type: 'message', role: 'assistant', model: 'claude-opus-5-5',
    content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'echo ' + id } }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } } });
    push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, toolUseResult: { stdout: 'ok' } }); };
  for (let k = 1; k <= earlierTurns; k++) { user(`EARLIER_QUESTION_${k}`); said(`msg_e${k}`, `EARLIER_RESULT_${k}`, 'end_turn'); }
  user('LONG_TURN_QUESTION');
  for (let k = 1; k <= progress; k++) { said(`msg_p${k}`, `PROGRESS_${String(k).padStart(2, '0')} 进展说明`, null); tool(`msg_p${k}`, `toolu_${k}`); }
  said('msg_final', 'FINAL_RESULT 最终结论', 'end_turn');
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n';
}
module.exports = { claudeLongTurnTranscript };
