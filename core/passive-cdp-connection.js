'use strict';
// Playwright's noDefaults preserves focus but also disables native downloads.
// Download scripts keep their previous Playwright behavior through a short-lived
// loopback relay that suppresses only synthetic focus. Provider traffic, browser
// events, cookies and download bytes pass unchanged and are never logged.
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');

async function passiveDownloadConnection(ep) {
  const endpoint = ep.ws || (await (await fetch(`http://127.0.0.1:${ep.port}/json/version`, { signal: AbortSignal.timeout(3000) })).json()).webSocketDebuggerUrl;
  const url = new URL(endpoint);
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || Number(url.port) !== ep.port) throw Error('Invalid local browser endpoint');
  const ticket = '/' + crypto.randomUUID();
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const relay = new WebSocket.Server({ noServer: true });
  const sockets = new Set();
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== ticket) { socket.destroy(); return; }
    relay.handleUpgrade(req, socket, head, client => {
      const upstream = new WebSocket(endpoint, { handshakeTimeout: 5000 });
      sockets.add(client); sockets.add(upstream);
      let queued = [];
      const stop = () => { queued = []; for (const ws of [client, upstream]) { sockets.delete(ws); if (ws.readyState !== WebSocket.CLOSED) ws.terminate(); } };
      client.on('error', stop); upstream.on('error', stop);
      client.on('close', stop); upstream.on('close', stop);
      client.on('message', bytes => {
        let message;
        try { message = JSON.parse(bytes); } catch { stop(); return; }
        if (message.method === 'Emulation.setFocusEmulationEnabled' && message.params?.enabled === true) {
          if (message.id !== undefined) client.send(JSON.stringify({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), result: {} }));
          return;
        }
        if (upstream.readyState === WebSocket.OPEN) upstream.send(bytes.toString());
        else if (upstream.readyState === WebSocket.CONNECTING && queued.length < 1000) queued.push(bytes.toString());
        else stop();
      });
      upstream.on('open', () => { for (const message of queued) upstream.send(message); queued = []; });
      upstream.on('message', bytes => { if (client.readyState === WebSocket.OPEN) client.send(bytes.toString()); });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    endpoint: `ws://127.0.0.1:${server.address().port}${ticket}`,
    async close() { for (const ws of sockets) ws.terminate(); sockets.clear(); relay.close(); await new Promise(resolve => server.close(resolve)); }
  };
}
module.exports = { passiveDownloadConnection };
