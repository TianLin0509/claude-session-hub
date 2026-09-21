'use strict';
// A separate OS process speaking the documented SDK control protocol.
const readline = require('readline');
const { randomUUID } = require('crypto');
const mode = process.argv.find(arg => arg.startsWith('--fixture='))?.slice(10) || 'normal';
let output = Promise.resolve();
const argValue = flag => { const index=process.argv.indexOf(flag); return index<0 ? undefined : process.argv[index+1]; };
let sessionId = argValue('--session-id') || argValue('--resume') || randomUUID();
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
const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'manual', 'plan'];
const flagSettings = (() => {
  const at = process.argv.indexOf('--settings');
  if (at < 0) return {};
  try { return JSON.parse(require('node:fs').readFileSync(process.argv[at + 1], 'utf8')); } catch { return {}; }
})();
let permissionMode = argValue('--permission-mode') || 'default';

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async line => {
  const m = JSON.parse(line);
  if (m.type === 'control_request') {
    if (m.request.subtype === 'initialize') {
      if (process.env.CLAUDE_HUB_FIXTURE_INIT_GATE) {
        const fs = require('node:fs');
        const deadline = Date.now() + 60000;
        while (!fs.existsSync(process.env.CLAUDE_HUB_FIXTURE_INIT_GATE)) {
          if (Date.now() > deadline) throw new Error('Fixture initialize gate timed out');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      if (mode === 'exit-before-init') return process.exit(7);
      if (mode === 'malformed') return process.stdout.write('{broken}\n');
      if (mode === 'truncated') { process.stdout.write('{"type":'); return process.exit(8); }
      if (mode === 'no-init') return;
      await success(m.request_id, { commands: [], models: [], test: true,
        // The real engine reports these on initialize; the Hub's speed chip and
        // working-mode control read them, so the fixture must answer in kind.
        fast_mode_state: flagSettings.fastMode === true ? 'on' : 'off',
        ...(flagSettings.fastMode === true ? {} : { fast_mode_disabled_reason: 'sdk_opt_in_required' }),
        current_permission_mode: permissionMode });
    } else if (m.request.subtype === 'interrupt') {
      await success(m.request_id);
      if (lastUser) { lastUser = null; await result({ terminal_reason: 'aborted_streaming' }); }
    } else if (m.request.subtype === 'get_usage') {
      const file = process.env.CLAUDE_HUB_FIXTURE_USAGE_FILE;
      if (!file) return success(m.request_id, { rate_limits_available: false });
      if (!process.env.CLAUDE_HUB_DATA_DIR) throw new Error('Usage fixture requires isolated data');
      const fs = require('node:fs');
      fs.appendFileSync(file + '.requests', JSON.stringify({ at: Date.now(), sessionId }) + '\n');
      const usage = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (usage.error) return frame({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: usage.error } });
      await success(m.request_id, { rate_limits_available: true, rate_limits: usage });
    } else if (m.request.subtype === 'get_context_usage') {
      await success(m.request_id, { totalTokens: 12500, maxTokens: 950000, rawMaxTokens: 1000000,
        percentage: 12500 / 950000 * 100, model: 'claude-opus-5[1m]' });
    } else if (m.request.subtype === 'apply_flag_settings') {
      if (mode === 'late-fast-control') {
        process.stderr.write('fixture: waiting for delayed configuration confirmation\n');
        await new Promise(resolve=>setTimeout(resolve,require('../../core/native-confirmation-policy').NATIVE_CONFIRMATION_MS+4000));
      }
      if (!m.request.settings || typeof m.request.settings !== 'object' || Array.isArray(m.request.settings)) {
        return frame({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id,
          error: 'apply_flag_settings requires `settings` to be an object' } });
      }
      Object.assign(flagSettings, m.request.settings);
      await success(m.request_id, {});
    } else if (m.request.subtype === 'set_permission_mode') {
      if (!PERMISSION_MODES.includes(m.request.mode)) {
        return frame({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id,
          error: 'Cannot set permission mode: must be one of ' + PERMISSION_MODES.join(', ') } });
      }
      permissionMode = m.request.mode;
      await success(m.request_id, { mode: permissionMode });
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
    if (process.env.CLAUDE_HUB_NATIVE_FIXTURE_INSTRUCTIONS === '1') {
      if (!process.env.CLAUDE_HUB_DATA_DIR) throw new Error('Instruction fixture requires isolated data');
      const {spawn} = require('node:child_process');
      await new Promise((resolve, reject) => {
        const child = spawn('python', [require('node:path').resolve(__dirname, '../../scripts/session-hub-hook.py'), 'instructions-loaded'], {windowsHide:true});
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve() : reject(new Error('Instruction hook exited: ' + code)));
        child.stdin.end(JSON.stringify({session_id:sessionId, file_path:require('node:path').join(process.cwd(),'AGENTS.md'), load_reason:'include', hook_event_name:'InstructionsLoaded'}));
      });
    }
    if (mode === 'crash-on-user') return process.exit(9);
    if (mode === 'crash-once') {
      const fs = require('node:fs'); const path = require('node:path');
      if (!process.env.CLAUDE_HUB_DATA_DIR || !process.env.CLAUDE_CONFIG_DIR) throw new Error('Crash fixture requires isolated config');
      const marker = path.join(process.env.CLAUDE_CONFIG_DIR, 'fixture-crashed');
      if (!fs.existsSync(marker)) { fs.writeFileSync(marker, 'crashed'); return process.exit(9); }
    }
    if (mode === 'no-echo') return;
    if (JSON.stringify(m.message?.content || '').includes('fixture:unconfirmed')) return;
    if (mode === 'old-result-first') await result({ uuid: 'old-result' });
    await frame({ ...m, session_id: sessionId, ...(mode === 'mismatch' ? { message: { ...m.message, content: 'changed text' } } : {}) });
    if (mode === 'echo-only' || mode === 'hold') return;
    if (mode === 'feedback') {
      const messageId=randomUUID();
      await frame({type:'stream_event',session_id:sessionId,event:{type:'message_start',message:{id:messageId,role:'assistant',content:[]}}});
      await frame({type:'stream_event',session_id:sessionId,event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}});
      let text='';
      for(let i=1;i<=12;i++) {
        await new Promise(resolve=>setTimeout(resolve,i===1?300:350));
        if(lastUser!==m)return;
        const delta=`FEEDBACK_${String(i).padStart(2,'0')}@${Date.now()}\n`;
        text+=delta;
        await frame({type:'stream_event',session_id:sessionId,event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:delta}}});
      }
      await frame({type:'assistant',uuid:randomUUID(),session_id:sessionId,message:{id:messageId,role:'assistant',content:[{type:'text',text}]}});
      return;
    }
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
    if (JSON.stringify(m.message?.content || '').includes('fixture:search')) {
      const text = '融合第一处。跨格式：融**合**第二处。\n\n'
        + Array.from({ length: 40 }, (_, i) => `段落 ${i + 1}：用于搜索滚动验证的普通内容。`).join('\n\n')
        + '\n\n融合最后一处。';
      await frame({ type: 'assistant', uuid: randomUUID(), session_id: sessionId,
        message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text }] } });
      await result({ result: text });
      return;
    }
    if (JSON.stringify(m.message?.content || '').includes('fixture:layout')) {
      await frame({ type: 'assistant', uuid: randomUUID(), session_id: sessionId,
        message: { id: randomUUID(), role: 'assistant', stop_reason: 'tool_use',
          content: [{ type: 'text', text: '正在检查长回答与输入区边界。' },
            { type: 'tool_use', id: 'layout-read', name: 'Read', input: { file_path: 'layout.txt' } }] } });
      await frame({ type: 'user', uuid: randomUUID(), session_id: sessionId,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'layout-read', content: 'layout checked' }] } });
      const text = Array.from({ length: 42 }, (_, i) => `段落 ${i + 1}：Claude 长回答应在正文区域内滚动，标题跟随正文移动，输入框保持固定。`).join('\n\n');
      await frame({ type: 'assistant', uuid: randomUUID(), session_id: sessionId,
        message: { id: randomUUID(), role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
      await result({ result: text });
      return;
    }
    if (mode === 'conversation') {
      for (const messageId of ['progress-one', 'progress-two']) {
        await frame({ type: 'assistant', uuid: randomUUID(), session_id: sessionId,
          message: { id: messageId, role: 'assistant', stop_reason: 'tool_use',
            content: [{ type: 'text', text: '独立进度 — ' + messageId }] } });
      }
    }
    if (mode === 'many-tools') {
      // A long silent tool run, like a real multi-step task: many calls with no
      // prose between them, then one final answer. Reproduces cards that froze
      // mid-turn and a composer with no live progress.
      const count = Number(process.env.CLAUDE_HUB_FIXTURE_TOOL_COUNT) || 30;
      const gap = Number(process.env.CLAUDE_HUB_FIXTURE_TOOL_GAP_MS) || 60;
      for (let i = 1; i <= count; i += 1) {
        const id = 'tool-' + i;
        await frame({ type: 'assistant', uuid: randomUUID(), session_id: sessionId, timestamp: new Date().toISOString(),
          message: { id: 'assistant-' + i, role: 'assistant', stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id, name: i % 3 ? 'Read' : 'Bash',
              input: i % 3 ? { file_path: 'file-' + i + '.txt' } : { command: 'echo step ' + i } }] } });
        await new Promise(resolve => setTimeout(resolve, gap));
        await frame({ type: 'user', uuid: randomUUID(), session_id: sessionId, timestamp: new Date().toISOString(),
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok ' + i }] } });
      }
      await frame({ type: 'assistant', uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null,
        message: { id: 'assistant-final', role: 'assistant', stop_reason: 'end_turn',
          content: [{ type: 'text', text: '全部步骤完成：最终回答' }] } });
      await result({ result: '全部步骤完成：最终回答' });
      return;
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
