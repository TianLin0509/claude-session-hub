'use strict';
// 定时请求编号、固定助理权限和真实 MCP 登记的传输验收；不声称模拟时钟是墙钟推送。
const fs = require('node:fs'), path = require('node:path');
const { connectFirstPage } = require('../tests/helpers/cdp-client');
const { AssistantStore } = require('../core/hub-assistant/store');
const { dayOf } = require('../core/hub-assistant/workbench');
const app = 'D:/AIWork/20261007-assistant-workbenchA-app-codex2';
const runtime = JSON.parse(fs.readFileSync(path.join(app, 'private/workbench-runtime.json')));
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
 let c; const result = { passed: false, scope: '真实 Sonnet + daily 请求编号 + MCP 日总结登记；不是墙钟定时推送' };
 try {
  c = await connectFirstPage({ cdpHttpBase: 'http://127.0.0.1:' + runtime.port });
  const invoke = (name, value = {}) => c.eval(`ipcRenderer.invoke(${JSON.stringify('assistant:' + name)},${JSON.stringify(value)})`);
  for (let end = Date.now() + 8 * 60000; Date.now() < end;) { const s = await invoke('get-overview'); if (!s.submissionPending && !['running', 'waiting'].includes(s.status)) break; await wait(1000); }
  const day = dayOf(Date.now()), key = day + ':summary', requestId = 'daily-' + key;
  const store = new AssistantStore(path.join(runtime.root, 'data/assistant'));
  const jobs = store.get('secretary.jobs') || {}; jobs[key] = { day, key, kind: 'summary', requestId, state: 'dispatching', createdAt: Date.now(), dueAt: Date.now() }; store.set('secretary.jobs', jobs); store.close();
  const r = await invoke('send', { requestId, text: `这是本轮每日秘书日总结的真实链路验收。请先读 workbench_status，按已经确认的计划勾选和真实会话状态，调用 publish_daily_brief 登记 kind=summary、day=${day}、text 写简洁今日总结和明天第一件事。不要改变备忘或派发任务；未读与空闲不算业务完成。登记后只回复「今日总结已保存」。` });
  if (!r.ok) throw Error(r.receipt?.message || '真实请求未被接受');
  for (let end = Date.now() + 180000; Date.now() < end;) { const w = await invoke('workbench'); if (w.summary && w.jobs.some(j => j.key === key && j.state === 'ready')) { result.passed = true; result.summary = w.summary; result.requestId = requestId; break; } await wait(1000); }
  if (!result.passed) throw Error('日总结未登记，保留失败证据');
 } catch (e) { result.error = e.message; process.exitCode = 1; } finally { c?.close(); fs.writeFileSync(path.join(app, 'artifacts/workbench-evidence/real-summary.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); }
})();
