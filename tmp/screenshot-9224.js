'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { connectCDP } = require('../tests/helpers/cdp-client');

(async () => {
  const list = await new Promise((r) => {
    http.get('http://127.0.0.1:9224/json/list', (res) => {
      let buf=''; res.on('data',c=>buf+=c); res.on('end',()=>{ try{r(JSON.parse(buf))}catch{r([])} });
    }).on('error',()=>r([]));
  });
  const main = list.find(t => t.type === 'page' && t.url.includes('index.html'));
  const client = await connectCDP(main.webSocketDebuggerUrl);
  const shotPath = path.join(__dirname, 'live-9224-' + Date.now() + '.png');
  const shot = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  console.log(shotPath);
  await client.close();
})();
