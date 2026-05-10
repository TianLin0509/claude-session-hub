import http from 'http';
import WebSocket from 'ws';
import fs from 'fs';

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
function send(method, params = {}) {
  return new Promise(res => { const myId = id++; pending.set(myId, res); ws.send(JSON.stringify({ id: myId, method, params })); });
}
await new Promise(r => ws.once('open', r));

const shot = await send('Page.captureScreenshot', { format: 'png' });
const buf = Buffer.from(shot.result.data, 'base64');
const out = process.argv[2];
fs.writeFileSync(out, buf);
console.log('screenshot saved:', out, '(' + buf.length + ' bytes)');
ws.close();
process.exit(0);
})();
