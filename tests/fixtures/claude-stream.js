'use strict';
// A separate OS process speaking the documented SDK control protocol.
const readline = require('readline');
const { randomUUID } = require('crypto');
const mode = process.argv.find(arg => arg.startsWith('--fixture='))?.slice(10) || 'normal';
let output = Promise.resolve();
let sessionId = process.argv[process.argv.indexOf('--session-id') + 1] || randomUUID();
let lastUser = null;
if (process.env.CLAUDE_HUB_FIXTURE_CONFIG_DIR) {
  if (!process.env.CLAUDE_HUB_DATA_DIR) throw new Error('Config capture requires isolated Hub data');
  const fs = require('node:fs'); const path = require('node:path');
  const directory = process.env.CLAUDE_HUB_FIXTURE_CONFIG_DIR;
  fs.mkdirSync(directory, { recursive: true });
  const at = process.argv.indexOf('--settings');
  fs.writeFileSync(path.join(directory, process.pid + '.json'), JSON.stringify({ args: process.argv.slice(2),
    settings: at >= 0 ? JSON.parse(fs.readFileSync(process.argv[at + 1], 'utf8')) : null }), 'utf8');
}
const frame = value => {
  output = output.then(() => new Promise(resolve => {
    const data = Buffer.from(JSON.stringify(value) + '\n');
    // Deliberately split a multi-byte UTF-8 sequence as well as JSON frames.
    const unicode = data.findIndex(byte => byte >= 0xC0);
    const split = unicode < 0 ? 7 : unicode + 1;
    process.stdout.write(data.subarray(0, split));
    setImmediate(() => process.stdout.write(data.subarray(split), resolve));
  }));
  return output;
};
const success = (id, response = {}) => frame({ type: 'control_response',
  response: { subtype: 'success', request_id: id, response } });
const result = (extra = {}) => frame({ type: 'result', subtype: 'success', is_error: false,
  result: '完成 🧪', uuid: randomUUID(), session_id: sessionId, terminal_reason: 'completed',
  origin: { kind: 'human' }, ...extra });
const complete = async () => {
  await frame({ type: 'assistant', uuid: randomUUID(), session_id: sessionId,
    parent_tool_use_id: null, message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: '完成 🧪' }] } });
  await result();
};
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async line => {
  const m = JSON.parse(line);
  if (m.type === 'control_request') {
    if (m.request.subtype === 'initialize') {
      if (mode === 'exit-before-init') return process.exit(7);
      if (mode === 'malformed') return process.stdout.write('{broken}\n');
      if (mode === 'truncated') { process.stdout.write('{"type":'); return process.exit(8); }
      if (mode === 'no-init') return;
      await success(m.request_id, { commands: [], models: [], test: true });
    } else if (m.request.subtype === 'interrupt') {
      await success(m.request_id);
      if (lastUser) { lastUser = null; await result({ terminal_reason: 'aborted_streaming' }); }
    } else if (m.request.subtype === 'get_context_usage') {
      await success(m.request_id, { totalTokens: 12500, maxTokens: 950000, rawMaxTokens: 1000000,
        percentage: 12500 / 950000 * 100, model: 'claude-opus-5[1m]' });
    } else if (m.request.subtype === 'fixture-env') {
      await success(m.request_id, { inherited: Object.hasOwn(process.env, 'HUB_NATIVE_TEST_PARENT_ONLY') });
    } else if (m.request.subtype === 'fixture-config') {
      const fs = require('node:fs');
      const at = process.argv.indexOf('--settings');
      await success(m.request_id, { args: process.argv.slice(2),
        settings: at >= 0 ? JSON.parse(fs.readFileSync(process.argv[at + 1], 'utf8')) : null });
    } else if (m.request.subtype === 'fixture-error') {
      await frame({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'denied by fixture' } });
    } else if (m.request.subtype === 'fixture-timeout') {
      setTimeout(() => success(m.request_id), 100);
    } else await success(m.request_id, { requested: m.request });
  } else if (m.type === 'user') {
    lastUser = m;
    if (m.session_id) sessionId = m.session_id;
    if (mode === 'crash-on-user') return process.exit(9);
    if (mode === 'crash-once') {
      const fs = require('node:fs'); const path = require('node:path');
      if (!process.env.CLAUDE_HUB_DATA_DIR || !process.env.CLAUDE_CONFIG_DIR) throw new Error('Crash fixture requires isolated config');
      const marker = path.join(process.env.CLAUDE_CONFIG_DIR, 'fixture-crashed');
      if (!fs.existsSync(marker)) { fs.writeFileSync(marker, 'crashed'); return process.exit(9); }
    }
    if (mode === 'no-echo') return;
    if (mode === 'old-result-first') await result({ uuid: 'old-result' });
    await frame({ ...m, session_id: sessionId, ...(mode === 'mismatch' ? { message: { ...m.message, content: 'changed text' } } : {}) });
    if (mode === 'echo-only' || mode === 'hold') return;
    if (mode === 'gated') {
      const fs = require('node:fs'); const path = require('node:path');
      const directory = process.env.CLAUDE_HUB_FIXTURE_GATE_DIR;
      if (!directory || !process.env.CLAUDE_HUB_DATA_DIR) throw new Error('Gated fixture requires isolated data');
      fs.mkdirSync(directory, { recursive: true });
      const text = typeof m.message.content === 'string' ? m.message.content
        : m.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
      fs.appendFileSync(path.join(directory, 'received.jsonl'), JSON.stringify({ uuid: m.uuid, sessionId, text }) + '\n');
      await frame({ type: 'assistant', uuid: randomUUID(), session_id: sessionId,
        message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: '阶段处理中' }] } });
      const gate = path.join(directory, m.uuid + '.json');
      const timer = setInterval(async () => {
        if (lastUser !== m) { clearInterval(timer); return; }
        if (!fs.existsSync(gate)) return;
        clearInterval(timer);
        await result(JSON.parse(fs.readFileSync(gate, 'utf8')));
      }, 25);
      return;
    }
    if (mode === 'conversation') {
      for (const messageId of ['progress-one', 'progress-two']) {
        await frame({ type: 'assistant', uuid: randomUUID(), session_id: sessionId,
          message: { id: messageId, role: 'assistant', stop_reason: 'tool_use',
            content: [{ type: 'text', text: '独立进度 — ' + messageId }] } });
      }
    }
    if (mode === 'tool-result') {
      await frame({ type: 'assistant', uuid: randomUUID(), session_id: sessionId, message: {
        id: 'assistant-tool', role: 'assistant', content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'file.txt' } }] } });
      await frame({ type: 'user', uuid: randomUUID(), session_id: sessionId, message: {
        role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'file text' }] } });
    }
    if (mode === 'delegated') {
      await frame({ type: 'system', subtype: 'task_started', session_id: sessionId, task_id: 'task-1', task_type: 'local_agent' });
      await result();
      await frame({ type: 'system', subtype: 'task_notification', session_id: sessionId, task_id: 'task-1', status: 'completed' });
      await result({ origin: { kind: 'task-notification' } });
      return;
    }
    if (mode === 'background' || mode === 'interleaved') {
      await frame({ type: 'system', subtype: 'task_started', session_id: sessionId, task_id: 'background-agent', task_type: 'local_agent' });
      if (mode === 'background') await complete();
      else await frame({ type: 'assistant', uuid: randomUUID(), session_id: sessionId, message: { id: randomUUID(),
        role: 'assistant', content: [{ type: 'text', text: '用户回合尚在处理' }] } });
      await frame({ type: 'user', uuid: randomUUID(), session_id: sessionId, origin: { kind: 'task-notification' },
        message: { role: 'user', content: 'controlled task notification' } });
      if (mode === 'interleaved') await complete();
      await frame({ type: 'assistant', uuid: randomUUID(), session_id: sessionId, message: { id: randomUUID(),
        role: 'assistant', content: [{ type: 'text', text: '后台任务独立回答 🧩' }] } });
      await result({ origin: { kind: 'task-notification' }, result: '后台任务独立回答 🧩' });
      await frame({ type: 'system', subtype: 'task_notification', session_id: sessionId, task_id: 'background-agent', status: 'completed' });
      return;
    }
    if (mode === 'approval' || mode === 'question') {
      await frame({ type: 'control_request', request_id: 'permission-1', request: {
        subtype: 'can_use_tool', tool_name: mode === 'question' ? 'AskUserQuestion' : 'Bash',
        tool_use_id: 'tool-1', input: mode === 'question'
          ? { questions: [{ question: '继续哪项？', options: [{ label: '甲' }, { label: '乙' }] }] }
          : { command: 'echo hello' },
      } });
      return;
    }
    if (mode === 'foreign-result') { await result({ session_id: 'foreign' }); return; }
    if (mode === 'background-result') {
      await result({ origin: { kind: 'task-notification' } });
      return;
    }
    if (mode === 'error-result') { await result({ is_error: true, result: 'API Error: fixture' }); return; }
    if (mode === 'empty-result') { await result({ result: '' }); return; }
    await complete();
  } else if (m.type === 'control_response') {
    await frame({ type: 'system', subtype: 'fixture_response', session_id: sessionId, reply: m });
    await complete();
  }
});
rl.on('close', () => { output.then(() => process.exit(0)); });
