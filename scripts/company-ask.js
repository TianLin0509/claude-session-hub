#!/usr/bin/env node
'use strict';
// 「问公司」命令行入口（2026-10-15）：和 MCP 工具做同一件事，供没挂 MCP 的 Hub 会话在 shell 里调用。
// 会话身份取 Hub 注入的 CLAUDE_HUB_SESSION_ID，回执到了 Hub 会作为新消息发回这个会话。
//
//   node company-ask.js ask --file 问题.md [--title 标题]
//   node company-ask.js followup --thread Q-1015-01 --file 追问.md
//   node company-ask.js show [--thread Q-1015-01]
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
  const command = process.argv[2];
  const tool = { ask: 'ask_company', followup: 'followup_company', show: 'company_thread' }[command];
  if (!tool) throw new Error('用法：ask --file q.md [--title t] | followup --thread Q-xxxx --file f.md | show [--thread Q-xxxx]');
  const session = arg('session') || process.env.HUB_BRIDGE_SESSION_ID || process.env.CLAUDE_HUB_SESSION_ID;
  if (!session) throw new Error('不在 AI Hub 会话里（没有 CLAUDE_HUB_SESSION_ID），回执无处投递；请在 Hub 打开的会话里使用');
  const dataDir = process.env.CLAUDE_HUB_DATA_DIR || path.join(os.homedir(), '.claude-session-hub');
  const endpointFile = process.env.HUB_BRIDGE_ENDPOINT_FILE || path.join(dataDir, 'company-bridge', 'mcp-endpoint.json');
  let endpoint;
  try { endpoint = JSON.parse(fs.readFileSync(endpointFile, 'utf8')); } catch { throw new Error('找不到 Hub 的家里联动入口（Hub 没开着，或版本太旧）：' + endpointFile); }
  const args = command === 'ask' ? { question: text(), ...(arg('title') ? { title: arg('title') } : {}) }
    : command === 'followup' ? { thread: arg('thread'), question: text() }
    : (arg('thread') ? { thread: arg('thread') } : {});
  const response = await fetch(endpoint.url, { method: 'POST', headers: { Authorization: 'Bearer ' + endpoint.token, 'Content-Type': 'application/json', 'X-Hub-Bridge-Session': session },
    body: JSON.stringify({ name: tool, arguments: args }), signal: AbortSignal.timeout(60000) });
  const data = await response.json();
  process.stdout.write(JSON.stringify(data.ok ? { ok: true, ...data.result } : { ok: false, error: data.error }, null, 1) + '\n');
  if (!data.ok) process.exitCode = 1;
}
main().catch(error => { process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n'); process.exitCode = 1; });
