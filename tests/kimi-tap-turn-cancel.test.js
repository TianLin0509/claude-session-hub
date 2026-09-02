// 2026-08-09 [kimi ESC 中断收尾] 回归测试：turn.cancel 是 Kimi wire 里被中断 turn
// 的唯一收尾信号。覆盖：
//   T1: turn.cancel → emit 'turn-aborted'（时间取 record.time）
//   T2: turn.cancel 清空中断现场（turnText/steps/completedSteps/streamingText）
//   T3: turn.cancel 清算在跑的 background Agent job（emit finished，防后台状态卡死）
//   T4: turn.steer 不触发任何收尾事件（turn 仍在运行）
const assert = require('assert');
const os = require('os');
const path = require('path');
const { KimiTap } = require('../core/kimi-transcript-tap.js');

function makeBound() {
  return {
    hubSessionId: 'hub-test-1',
    kind: 'kimi',
    kimiSid: 'sid-test-1',
    sessionDir: path.join(os.tmpdir(), 'kimi-tap-test'),
    wirePath: path.join(os.tmpdir(), 'kimi-tap-test', 'agents', 'main', 'wire.jsonl'),
    offset: 0,
    partial: '',
    turnText: '被中断的部分输出',
    currentPrompt: '原始 prompt',
    lastUserText: '',
    steps: new Map([['step-1', { text: '半截文本', hadTool: false }]]),
    completedSteps: new Set(['step-0']),
    backgroundAgentCalls: new Set(['job-1']),
    streamingText: '半截文本',
    lastAssistantText: '',
    tail: null,
  };
}

(() => {
  // T1+T2+T3
  {
    const tap = new KimiTap({ homeDir: os.tmpdir() });
    const aborted = [];
    const bgEvents = [];
    tap.on('turn-aborted', (ev) => aborted.push(ev));
    tap.on('background-work-changed', (ev) => bgEvents.push(ev));

    const bound = makeBound();
    const cancelTime = 1786029040643;
    tap._processRecord(bound, { type: 'turn.cancel', time: cancelTime });

    assert.strictEqual(aborted.length, 1, 'turn.cancel 应 emit 一次 turn-aborted');
    assert.strictEqual(aborted[0].hubSessionId, 'hub-test-1');
    assert.strictEqual(aborted[0].abortedAt, cancelTime, 'abortedAt 应取 record.time');
    assert.strictEqual(aborted[0].signalSource, 'kimi_wire_turn_cancel');
    assert.strictEqual(aborted[0].transcriptPath, bound.wirePath);
    console.log('PASS T1 turn.cancel → turn-aborted');

    assert.strictEqual(bound.turnText, '');
    assert.strictEqual(bound.steps.size, 0);
    assert.strictEqual(bound.completedSteps.size, 0);
    assert.strictEqual(bound.streamingText, '');
    console.log('PASS T2 turn.cancel 清空中断现场');

    assert.strictEqual(bound.backgroundAgentCalls.size, 0, '中断应清算在跑的 Agent job');
    const finishes = bgEvents.filter((ev) => ev.phase === 'finished');
    assert.strictEqual(finishes.length, 1);
    assert.strictEqual(finishes[0].jobId, 'job-1');
    console.log('PASS T3 turn.cancel 清算 background Agent job');
  }

  // T4
  {
    const tap = new KimiTap({ homeDir: os.tmpdir() });
    const events = [];
    tap.on('turn-aborted', (ev) => events.push(ev));
    tap.on('turn-complete', (ev) => events.push(ev));
    const bound = makeBound();
    tap._processRecord(bound, { type: 'turn.steer', time: Date.now(), input: [{ type: 'text', text: '追加' }] });
    assert.strictEqual(events.length, 0, 'turn.steer 不应触发收尾事件');
    assert.strictEqual(bound.turnText, '被中断的部分输出', 'turn.steer 不应清现场');
    console.log('PASS T4 turn.steer 无状态动作');
  }

  console.log('ALL PASS kimi-tap-turn-cancel');
})();
