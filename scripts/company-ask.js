#!/usr/bin/env node
'use strict';
// 「问公司」命令行入口（2026-10-15）：和 MCP 工具做同一件事，供没挂 MCP 的 Hub 会话在 shell 里调用。
// 会话身份与通行证取 Hub 注入的 HUB_BRIDGE_SESSION_ID / HUB_BRIDGE_SESSION_PASS，回执到了 Hub 会作为新消息发回这个会话。
//
//   node company-ask.js ask --file 问题.md [--title 标题] [--model 模型名]   （模型名按 models 列出的公司模型表选；不填 = 公司默认）
//   node company-ask.js models   （看公司模型表：可用模型、哪个是日常主力、忙闲；2026-10-18 按模型派活）
//   node company-ask.js followup --thread Q-1015-01 --file 追问.md
//   node company-ask.js show [--thread Q-1015-01]
//   node company-ask.js image --thread Q-1017-01 --path D:\test.png [--allow-resize]
//   node company-ask.js images [--thread Q-1017-01]
//   node company-ask.js recollect --thread Q-1015-01   （补收：上一轮没答上时，取回公司会话里已经写好的回答）
//   node company-ask.js --hub-update [--force] | --hub-restart [--force] | --hub-status   （远程让公司 Hub 更新 / 重启 / 报版本）
//   node company-ask.js --diag [machine,processes,hub,pool,logs,codeagent,airview,features] [--lines 80] [--id HA-xxxx]
//     （直查公司电脑与公司 Hub：秒级、不排队、不占公司 CodeAgent；不填段落 = 全部；--id 取之前那次的结果）
//   node company-ask.js --act suspend-idle | kill-orphans --pids 300:1799913600000,... | set-parallel [--mem-floor 5] [--max-parallel 1] [--max-parallel-idle 4] [--restore-hours 2]
//                       | cancel-queued --thread Q-xxxx | retry --thread Q-xxxx   [--id HA-xxxx 取之前那次的结果]
//     （远程维护：会改动公司电脑状态，先 --diag 看清楚再做）
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function arg(name) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; }
function text() {
  const file = arg('file');
  if (file) return fs.readFileSync(file, 'utf8');
  if (arg('text')) return arg('text');
  throw new Error('用 --file <Markdown 文件> 或 --text <文字> 给出内容');
}
async function main() {
  const hubOp = ['update', 'restart', 'status'].find(op => process.argv.includes('--hub-' + op));
  const diag = process.argv.includes('--diag');
  const actOp = process.argv.includes('--act') ? arg('act') : undefined;
  const command = actOp ? 'act' : diag ? 'diag' : hubOp ? 'hub' : process.argv[2];
  if (command === 'models') return showModels();
  const tool = actOp ? 'company_act' : diag ? 'company_diag' : hubOp ? 'company_hub_update' : { ask: 'ask_company', followup: 'followup_company', show: 'company_thread', recollect: 'recollect_company', image: 'send_image_company', images: 'company_images' }[command];
  if (!tool) throw new Error('用法：ask --file q.md [--title t] [--model m] | models | followup --thread Q-xxxx --file f.md | show [--thread Q-xxxx] | recollect --thread Q-xxxx | image --thread Q/H-xxxx --path <本机图片> [--allow-resize] | images [--thread Q/H-xxxx] | --hub-update [--force] | --hub-restart [--force] | --hub-status | --diag [machine,processes,hub,pool,logs,codeagent,airview,features] [--lines N] [--id HA-xxxx] | --act <suspend-idle|kill-orphans|set-parallel|cancel-queued|retry> [...]');
  // 会话身份与通行证由 Hub 在开会话时注入；只能代表本会话提问。
  const session = process.env.HUB_BRIDGE_SESSION_ID, pass = process.env.HUB_BRIDGE_SESSION_PASS;
  if (!session || !pass) throw new Error('这个会话没有家里联动的通行证：请在家里和公司配对之后、由 AI Hub 新开（或重开）的 Codex / Claude 会话里使用');
  const dataDir = process.env.CLAUDE_HUB_DATA_DIR || path.join(os.homedir(), '.claude-session-hub');
  const endpointFile = process.env.HUB_BRIDGE_ENDPOINT_FILE || path.join(dataDir, 'company-bridge', 'mcp-endpoint.json');
  let endpoint;
  try { endpoint = JSON.parse(fs.readFileSync(endpointFile, 'utf8')); } catch { throw new Error('找不到 Hub 的家里联动入口（Hub 没开着，或版本太旧）：' + endpointFile); }
  const diagList = diag ? arg('diag') : undefined;
  const num = name => (arg(name) != null ? Number(arg(name)) : undefined);
  const actArgs = () => {
    const a = { action: actOp };
    if (arg('pids')) a.targets = arg('pids').split(',').map(x => x.trim()).filter(Boolean).map(x => { const [pid, startedAt] = x.split(':').map(Number); return { pid, startedAt }; });
    for (const [flag, key] of [['mem-floor', 'memFloorPct'], ['max-parallel', 'maxParallel'], ['max-parallel-idle', 'maxParallelIdle'], ['restore-hours', 'restoreAfterHours']]) if (num(flag) !== undefined) a[key] = num(flag);
    if (arg('thread')) a.thread = arg('thread');
    if (arg('id')) a.id = arg('id');
    return a;
  };
  const args = actOp ? actArgs() : diag ? { ...(diagList && !diagList.startsWith('--') ? { sections: diagList.split(/[,，]/).map(s => s.trim()).filter(Boolean) } : {}),
      ...(arg('lines') ? { lines: Number(arg('lines')) } : {}), ...(arg('id') ? { id: arg('id') } : {}) }
    : hubOp ? { op: hubOp, force: process.argv.includes('--force') }
    : command === 'ask' ? { question: text(), ...(arg('title') ? { title: arg('title') } : {}), ...(arg('model') ? { model: arg('model') } : {}) }
    : command === 'followup' ? { thread: arg('thread'), question: text() }
    : command === 'image' ? { thread: arg('thread'), path: arg('path'), caption: arg('caption') || '', allow_resize: process.argv.includes('--allow-resize'), ...(arg('round') ? { round: Number(arg('round')) } : {}) }
    : (arg('thread') ? { thread: arg('thread') } : {});
  const response = await fetch(endpoint.url, { method: 'POST', headers: { Authorization: 'Bearer ' + pass, 'Content-Type': 'application/json', 'X-Hub-Bridge-Session': session },
    body: JSON.stringify({ name: tool, arguments: args }), signal: AbortSignal.timeout(diag || actOp ? 90000 : 60000) }); // 直查会等回报最多约 45 秒
  const data = await response.json();
  process.stdout.write(JSON.stringify(data.ok ? { ok: true, ...data.result } : { ok: false, error: data.error }, null, 1) + '\n');
  if (!data.ok) process.exitCode = 1;
}
// 公司模型表：家里 Hub 收到后存在通道目录的 company-models.json（和 MCP 工具描述读同一份）。
function showModels() {
  const dataDir = process.env.CLAUDE_HUB_DATA_DIR || path.join(os.homedir(), '.claude-session-hub');
  const endpointFile = process.env.HUB_BRIDGE_ENDPOINT_FILE || path.join(dataDir, 'company-bridge', 'mcp-endpoint.json');
  let entry = null;
  try { entry = JSON.parse(fs.readFileSync(path.join(path.dirname(endpointFile), 'company-models.json'), 'utf8')); } catch { entry = null; }
  const text = require('../core/company-bridge/model-table-text').modelGuide(entry);
  process.stdout.write(JSON.stringify({ ok: true, known: !!(entry && entry.table && entry.table.models && entry.table.models.length), models: entry ? entry.table.models.map(m => m.id) : [], text }, null, 1) + '\n');
}
main().catch(error => { process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n'); process.exitCode = 1; });
