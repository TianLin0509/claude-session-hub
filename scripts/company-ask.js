#!/usr/bin/env node
'use strict';
// 「问公司」命令行入口（2026-10-15）：和 MCP 工具做同一件事，供没挂 MCP 的 Hub 会话在 shell 里调用。
// 会话身份与通行证取 Hub 注入的 HUB_BRIDGE_SESSION_ID / HUB_BRIDGE_SESSION_PASS，回执到了 Hub 会作为新消息发回这个会话。
//
//   node company-ask.js ask --file 问题.md [--title 标题]
//   node company-ask.js followup --thread Q-1015-01 --file 追问.md
//   node company-ask.js show [--thread Q-1015-01]
//   node company-ask.js image --thread Q-1017-01 --path D:\test.png [--allow-resize]
//   node company-ask.js images [--thread Q-1017-01]
//   node company-ask.js recollect --thread Q-1015-01   （补收：上一轮没答上时，取回公司会话里已经写好的回答）
//   node company-ask.js --hub-update [--force] | --hub-restart [--force] | --hub-status   （远程让公司 Hub 更新 / 重启 / 报版本）
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
  const command = hubOp ? 'hub' : process.argv[2];
  const tool = hubOp ? 'company_hub_update' : { ask: 'ask_company', followup: 'followup_company', show: 'company_thread', recollect: 'recollect_company', image: 'send_image_company', images: 'company_images' }[command];
  if (!tool) throw new Error('用法：ask --file q.md [--title t] | followup --thread Q-xxxx --file f.md | show [--thread Q-xxxx] | recollect --thread Q-xxxx | image --thread Q/H-xxxx --path <本机图片> [--allow-resize] | images [--thread Q/H-xxxx] | --hub-update [--force] | --hub-restart [--force] | --hub-status');
  // 会话身份与通行证由 Hub 在开会话时注入；只能代表本会话提问。
  const session = process.env.HUB_BRIDGE_SESSION_ID, pass = process.env.HUB_BRIDGE_SESSION_PASS;
  if (!session || !pass) throw new Error('这个会话没有家里联动的通行证：请在家里和公司配对之后、由 AI Hub 新开（或重开）的 Codex / Claude 会话里使用');
  const dataDir = process.env.CLAUDE_HUB_DATA_DIR || path.join(os.homedir(), '.claude-session-hub');
  const endpointFile = process.env.HUB_BRIDGE_ENDPOINT_FILE || path.join(dataDir, 'company-bridge', 'mcp-endpoint.json');
  let endpoint;
  try { endpoint = JSON.parse(fs.readFileSync(endpointFile, 'utf8')); } catch { throw new Error('找不到 Hub 的家里联动入口（Hub 没开着，或版本太旧）：' + endpointFile); }
  const args = hubOp ? { op: hubOp, force: process.argv.includes('--force') }
    : command === 'ask' ? { question: text(), ...(arg('title') ? { title: arg('title') } : {}) }
    : command === 'followup' ? { thread: arg('thread'), question: text() }
    : command === 'image' ? { thread: arg('thread'), path: arg('path'), caption: arg('caption') || '', allow_resize: process.argv.includes('--allow-resize'), ...(arg('round') ? { round: Number(arg('round')) } : {}) }
    : (arg('thread') ? { thread: arg('thread') } : {});
  const response = await fetch(endpoint.url, { method: 'POST', headers: { Authorization: 'Bearer ' + pass, 'Content-Type': 'application/json', 'X-Hub-Bridge-Session': session },
    body: JSON.stringify({ name: tool, arguments: args }), signal: AbortSignal.timeout(60000) });
  const data = await response.json();
  process.stdout.write(JSON.stringify(data.ok ? { ok: true, ...data.result } : { ok: false, error: data.error }, null, 1) + '\n');
  if (!data.ok) process.exitCode = 1;
}
main().catch(error => { process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n'); process.exitCode = 1; });
