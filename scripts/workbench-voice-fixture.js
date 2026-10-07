'use strict';
// 私有隔离语音配置：只在内存解密本机已有 Key，再交本轮隔离 Hub 重新加密。
// 不输出/另存 Key，不调用生产 Hub，不改生产配置。
const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process');
const { connectFirstPage } = require('../tests/helpers/cdp-client');
const app = 'D:/AIWork/20261007-assistant-workbenchA-app-codex2';
(async () => {
 const runtime = JSON.parse(fs.readFileSync(path.join(app, 'private/workbench-runtime.json')));
 const py = `import sys,json,base64,pathlib\nsys.path.insert(0,${JSON.stringify(path.join(app, 'scripts'))})\nfrom fixture_hub import dpapi\nfrom cryptography.hazmat.primitives.ciphers.aead import AESGCM\nroot=pathlib.Path.home()/'.claude-session-hub'\nls=json.loads((pathlib.Path.home()/'AppData'/'Roaming'/'ai-group-chat-hub'/'Local State').read_text(encoding='utf-8'))\nk=base64.b64decode(ls['os_crypt']['encrypted_key'])\nkey=dpapi(k[5:])\nv=json.loads((root/'voice-input.json').read_text(encoding='utf-8'))\nb=base64.b64decode(v['encryptedKey'])\nassert b[:3]==b'v10'\nsys.stdout.write(AESGCM(key).decrypt(b[3:15],b[15:],None).decode('utf-8'))`;
 const apiKey = execFileSync('python', ['-c', py], { windowsHide: true, maxBuffer: 4096, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
 const c = await connectFirstPage({ cdpHttpBase: 'http://127.0.0.1:' + runtime.port });
 try { const r = await c.eval('ipcRenderer.invoke("voice:save-config",' + JSON.stringify({ apiKey, region: 'beijing', project: runtime.root + '/workspace', profile: {} }) + ')'); console.log(JSON.stringify({ isolatedVoiceConfigured: r.keySet === true })); }
 finally { c.close(); }
})().catch(() => { console.error('隔离语音配置失败，密钥未输出'); process.exitCode = 1; });
