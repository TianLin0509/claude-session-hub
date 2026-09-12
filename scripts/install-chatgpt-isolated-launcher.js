'use strict';
// Pin and isolate an already installed upstream launcher; never modify its source installation.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const asar = require('@electron/asar');
const source = 'C:\\DevTools\\CodexWebGPT';
const destination = 'C:\\DevTools\\CodexWebGPT-AIHub';
const root = 'C:\\VibeData\\CodexChatGPTWeb\\ai-hub-isolated';
const archive = path.join(source, 'resources', 'app.asar');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if (fs.existsSync(destination)) throw new Error('Existing isolated launcher requires inspection; refusing overwrite');
require('../core/chatgpt-isolation').isolatedPaths({});
const version = JSON.parse(asar.extractFile(archive, 'package.json')).version;
if (version !== '5.0.6') throw new Error('Upstream version has changed; review isolation patches before installing');
fs.cpSync(source, destination, { recursive: true, force: false, errorOnExist: true });
const appRoot = path.join(destination, 'resources', 'app');
asar.extractAll(path.join(destination, 'resources', 'app.asar'), appRoot);
const replace = (file, before, after) => {
  const target = path.join(appRoot, file), text = fs.readFileSync(target, 'utf8');
  if (text.split(before).length !== 2) throw new Error('Patch anchor changed: ' + file);
  fs.writeFileSync(target, text.replace(before, after));
};
fs.copyFileSync(path.join(__dirname, '../core/chatgpt-isolation.js'), path.join(appRoot, 'electron', 'ai-hub-isolation.cjs'));
replace('electron/profile.cjs', 'const os = require("node:os");', `const isolated = require('./ai-hub-isolation.cjs').launcherEnvironment({});
for (const key of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET|^OPENAI_BASE_URL$/.test(key)) delete process.env[key];
if (isolated.HTTPS_PROXY) { process.env.HTTPS_PROXY=isolated.HTTPS_PROXY; process.env.HTTP_PROXY=isolated.HTTP_PROXY; process.env.NO_PROXY=isolated.NO_PROXY; }
process.env.CODEX_HOME = isolated.CODEX_HOME;
process.env.CODEX_CHATGPT_WEB_HOME = isolated.CODEX_CHATGPT_WEB_HOME;
process.env.CODEX_WEB_GPT_LAUNCHER_DATA_DIR = isolated.CODEX_WEB_GPT_LAUNCHER_DATA_DIR;
if (process.argv.includes('--dev-profile')) throw new Error('AI Hub launcher requires its fixed isolated profile');
const os = require("node:os");`);
replace('electron/profile.cjs', 'displayName: "Codex Web GPT",', 'displayName: "Codex Web GPT · AI Hub",');
replace('electron/main.cjs', 'if (!launcherSmokeTest) void updateController.checkOnce();', '// AI Hub pinned launcher: updates require revalidation of the isolation boundary.');
replace('electron/main.cjs', 'if (!updateController) throw new Error("Launcher updates are unavailable");', 'throw new Error("AI Hub 隔离版需通过专用安装流程更新，已阻止运行通用安装器");');
fs.writeFileSync(path.join(appRoot, 'electron', 'autostart.cjs'), `'use strict';
module.exports = {
  getAutostart: () => ({supported:false,enabled:false}),
  setAutostart: (_app, enabled) => { if(enabled) throw new Error('AI Hub 隔离版由专用入口启动，不注册通用开机启动项'); return {supported:false,enabled:false}; }
};\n`);
// Delete only the new copy's archive, so Electron loads the patched extracted app.
require('./chatgpt-isolated-ui-copy')(appRoot);
fs.unlinkSync(path.join(destination, 'resources', 'app.asar'));
fs.writeFileSync(path.join(destination, 'ai-hub-isolation-install.json'), JSON.stringify({ version:1, upstreamVersion:version, sourceArchiveSha256:hash(archive), root, pinned:true }, null, 2));
console.log(JSON.stringify({ destination, upstreamVersion:version, sourceArchiveSha256:hash(archive) }));
