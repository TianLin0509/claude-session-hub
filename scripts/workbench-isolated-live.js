'use strict';
// 本轮真实手机验收用：只启动自己的隔离 Hub；连接码不进报告。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), crypto = require('node:crypto');
const { launchIsolatedHub, gracefulQuit } = require('../tests/helpers/hub-launcher');
const { connectFirstPage } = require('../tests/helpers/cdp-client');
const app = process.env.WORKBENCH_APP_ROOT || 'D:/AIWork/20261007-assistant-workbenchA-app-codex2';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hash = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
async function main() {
 const resumeRoot = process.env.WORKBENCH_RESUME_ROOT;
 const root = resumeRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-phone-live-workbenchA-'));
 if (resumeRoot && (!path.basename(root).startsWith('aihub-phone-live-workbenchA-') || path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()))) throw Error('只能恢复本轮自建的隔离目录');
 const dataDir = path.join(root, 'data'), claude = path.join(root, 'claude'), home = path.join(root, 'home'), workspace = path.join(root, 'workspace');
 const out = path.join(app, 'artifacts/workbench-evidence'), priv = path.join(app, 'private');
 for (const d of [dataDir, claude, home, workspace, out, priv]) fs.mkdirSync(d, { recursive: true });
 const auth = path.join(os.homedir(), '.claude/.credentials.json'), before = hash(auth);
 fs.copyFileSync(auth, path.join(claude, '.credentials.json'));
 fs.writeFileSync(path.join(claude, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, skipDangerousModePermissionPrompt: true, projects: {} }));
 const hooks = require('../core/claude-hook-integration').ensureClaudeHookIntegration({ claudeDir: claude, sourceScriptsDir: path.resolve('scripts'), logger: { log() {}, warn() {} } });
 if (hooks.errors.length) throw Error('隔离 Claude hook 未就绪');
 const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude-session-hub/config.json'), 'utf8'));
 fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ models: { defaults: { claude: 'claude-sonnet-5-5' } }, providers: { claude: cfg.providers.claude } }));
 const voice = resumeRoot ? path.join(priv, 'workbench-voice-encrypted.json') : path.join(os.homedir(), '.claude-session-hub/voice-input.json'); if (fs.existsSync(voice)) fs.copyFileSync(voice, path.join(dataDir, 'voice-input.json'));
 const { AssistantStore } = require('../core/hub-assistant/store'); const store = new AssistantStore(path.join(dataDir, 'assistant'));
 store.set('assistantDefaultsVersion', 2); store.set('backendKind', 'claude'); store.set('profile:claude', { model: 'claude-sonnet-5-5', effort: 'low' });
 // 自动定时器的单测另行覆盖；此真实验收不随墙钟触发额外任务。
 store.set('workbench.config', { enabled: false, lesson: true, morning: '08:00', evening: '21:00', timezone: 'Asia/Shanghai' }); store.close();
 const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
 let hub, cdp; const result = { passed: false, scope: '真实隔离 Hub UI + 真云中继 + Android 正式签名候选 + Claude Sonnet 5.5；定时时钟另由单测验证', root, checks: [] };
 try {
  hub = await launchIsolatedHub({ dataDir, port, windowMode: 'background', label: 'workbenchA-codex2', allowExternalState: true, extraEnv: { CLAUDE_HUB_HOME_DIR: home, CLAUDE_CONFIG_DIR: claude, AI_HUB_WORKSPACE_ROOT: workspace, CLAUDE_HUB_AGENT_RUNTIME: 'pty', CLAUDE_HUB_NO_FAST: '1', CLAUDE_HUB_E2E: '1', ANTHROPIC_API_KEY: '', DEEPSEEK_API_KEY: '', HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'empty') } });
  cdp = await connectFirstPage(hub); const j = JSON.stringify;
  const until = async (label, fn, ms = 120000) => { for (let end = Date.now() + ms; Date.now() < end;) { const v = await fn(); if (v) return v; await sleep(250); } throw Error(label + ' timeout'); };
  const invoke = (name, arg = {}) => cdp.eval(`ipcRenderer.invoke(${j('assistant:' + name)},${j(arg)})`);
  const click = async selector => { const p = await until(selector, () => cdp.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e||e.disabled)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return r.width?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`)); for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 }); };
  await until('renderer', () => cdp.eval('typeof assistantPanel!=="undefined"'));
  if (await cdp.eval('document.getElementById("app-container").classList.contains("rail-hidden")')) await click('#btn-toggle-navigation');
  await click('#btn-assistant'); await click('[data-ap="view-today"]'); await click('[data-aw="refresh"]');
  result.checks.push('隔离 Hub 真实鼠标打开今日工作台、手动刷新');
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'hub-workbenchA.png'), Buffer.from(shot.data, 'base64'));
  const taskWorkspace = path.join(workspace, '20261007-workbenchA-qa-codex2'); fs.mkdirSync(taskWorkspace, { recursive: true });
  const old = resumeRoot ? JSON.parse(fs.readFileSync(path.join(priv, 'workbench-runtime.json'))) : null;
  const target = old ? { id: old.targetId } : await cdp.eval(`ipcRenderer.invoke('create-session',{kind:'claude',opts:{title:'工作台验收会话',cwd:${j(taskWorkspace)},mcpProfile:'none'}})`); result.targetSessionId = target.id;
  const ready = await invoke('ensure-session'); if (!ready.ok) throw Error(ready.error || '助理未就绪'); result.sessionId = ready.sessionId;
  // 使用真正的手机连接按钮，注册独立云通道。
  await click('#btn-assistant');
  await click('[data-ap="more"]'); await click('.ap-menu [data-pick="phone"]'); await click('[data-phone="pair"]');
  const code = await until('relay paired', () => cdp.eval('document.querySelector(".phone-code")?.value||null'));
  fs.writeFileSync(path.join(priv, 'workbench-connect.txt'), code, { mode: 0o600 }); await click('[data-phone="close"]');
  fs.writeFileSync(path.join(priv, 'workbench-runtime.json'), JSON.stringify({ root, pid: hub.pid, port, sessionId: ready.sessionId, targetId: target.id }));
  console.log(JSON.stringify({ event: 'workbench-real-ready', pid: hub.pid, port, sessionId: ready.sessionId, setupFile: 'private/workbench-connect.txt' }));
  const stop = path.join(priv, 'workbench-stop'); if (fs.existsSync(stop)) fs.unlinkSync(stop);
  const end = Date.now() + 45 * 60000;
  while (Date.now() < end && !fs.existsSync(stop)) {
   fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n'));
   fs.writeFileSync(path.join(out, 'workbench-live.json'), JSON.stringify(await invoke('workbench'), null, 2));
   fs.writeFileSync(path.join(out, 'phone-status.json'), JSON.stringify(await invoke('phone-status')));
   await sleep(2000);
  }
  result.productionCredentialsUnchanged = hash(auth) === before; result.passed = result.productionCredentialsUnchanged;
 } catch (e) { result.error = e.stack; process.exitCode = 1; }
 finally { cdp?.close(); if (hub) { result.exit = await gracefulQuit(hub); fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n')); } for (const f of [path.join(claude, '.credentials.json'), path.join(dataDir, 'voice-input.json')]) if (fs.existsSync(f)) fs.unlinkSync(f); fs.writeFileSync(path.join(out, 'hub-runtime-result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ event: 'workbench-runtime-ended', ...result })); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
