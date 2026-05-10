import http from 'http';
import WebSocket from 'ws';

(async () => {
const pagesRes = await new Promise((resolve, reject) => {
  http.get('http://localhost:9221/json', res => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => resolve(JSON.parse(body)));
  });
});
const page = pagesRes.find(p => p.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 1;
const pending = new Map();
ws.on('message', m => { const msg = JSON.parse(m); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } });
function send(method, params = {}) { return new Promise(res => { const myId = id++; pending.set(myId, res); ws.send(JSON.stringify({ id: myId, method, params })); }); }
await new Promise(r => ws.once('open', r));
await send('Runtime.enable');

async function evalSrc(label, jsSrc) {
  const b64 = Buffer.from(jsSrc, 'utf8').toString('base64');
  const expr = `eval(Buffer.from('${b64}', 'base64').toString('utf8'))`;
  const ret = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (ret.result?.exceptionDetails) {
    console.log(`[${label}] EXC:`, ret.result.exceptionDetails.exception?.description || ret.result.exceptionDetails.text);
  } else {
    console.log(`[${label}]`, JSON.stringify(ret.result?.result?.value));
  }
}

const HUB = 'C:/Users/lintian/claude-session-hub';

await evalSrc('BASE_RULES seat line', `
(() => {
  const s = require('${HUB}/core/roundtable-scenes.js');
  return s.BASE_RULES.split('\n').find(l => l.includes('圆桌最多')) || 'NOT FOUND';
})()
`);

await evalSrc('research preset UI 槽位行 (memory.md 段)', `
(() => {
  const s = require('${HUB}/core/roundtable-scenes.js');
  const out = s.buildSystemPrompt('research', null, 'pikachu');
  return out.split('\n').find(l => l.includes('UI 槽位')) || 'NOT FOUND';
})()
`);

await evalSrc('free.fanout 你是 / 参与者 字段', `
(() => {
  const free = require('${HUB}/core/roundtable-free.js');
  const p = free.buildFreeFanoutPrompt({
    meeting: { scene: 'general', subSessions: ['a','b','c'], participants: [0,1,2] },
    selfSlot: 0, participants: [0,1,2], userInput: 'q',
    lastTurnInjection: null, turnNum: 1, sceneName: '通用圆桌',
  });
  return p.split('\n').filter(l => l.startsWith('- 你是:') || l.startsWith('- 参与者:')).join(' || ');
})()
`);

await evalSrc('research SLOT_BIASES 三派 header', `
(() => {
  const s = require('${HUB}/core/roundtable-scenes.js');
  return ['pikachu','charmander','squirtle'].map(slot => {
    const prompt = s.buildSystemPrompt('research', null, slot);
    return prompt.split('\n').find(l => l.startsWith('## [') && l.includes('偏置]')) || 'NF';
  }).join(' | ');
})()
`);

await evalSrc('summary prompt summarizer label', `
(() => {
  const free = require('${HUB}/core/roundtable-free.js');
  const p = free.buildFreeSummaryPrompt({
    meeting: { scene: 'general', subSessions: ['a','b','c'], participants: [0,1,2] },
    summarizerSlot: 'pikachu',
    userInput: '', lastTurnInjection: null, turnNum: 5, sceneName: '通用圆桌',
  });
  return p.split('\n')[0];
})()
`);

await evalSrc('SLOT_NAMES_S 源码片段', `
(() => {
  const fs = require('fs');
  const src = fs.readFileSync('${HUB}/renderer/meeting-room.js', 'utf-8');
  const idx = src.indexOf('SLOT_NAMES_S =');
  return idx >= 0 ? src.substr(idx, 90).split('\n')[0] : 'NOT FOUND';
})()
`);

ws.close();
process.exit(0);
})();
