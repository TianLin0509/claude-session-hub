'use strict';
// AI 编排员的 MCP 工具（JSON-RPC over stdio）。身份来自 Hub 写入的环境变量，
// 每次调用把参数转交 Hub，由 Hub 校验身份并执行；这里不执行任何命令。
const readline = require('node:readline');
const fs = require('node:fs');
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
const kinds = { type: 'string', enum: ['claude', 'codex', 'gemini', 'deepseek', 'kimi', 'qwen', 'glm'] };
const tiers = { type: 'string', enum: ['fast', 'standard', 'deep'] };
const efforts = { type: 'string', enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] };
const presets = { type: 'string', enum: ['development', 'research', 'roundtable', 'custom'] };
const tools = [
  { name: 'orch_status', annotations: { readOnlyHint: true },
    description: '读取本群计划账本：状态、额度、计划、队伍（成员编号、后端、模型、角色、忙闲）、各工作段进度与审核结论文件路径、单独提问的回答路径。每次被唤醒先调用它。',
    inputSchema: schema({}) },
  { name: 'orch_propose_plan',
    description: '提交或更新计划（新版本）。team 写打算组建的队伍（不含你自己，最多 3 位）；segments 写各工作段的模板、目标与验收标准。需要田哥确认时，提交后等确认，同时在回答里把计划讲给田哥。',
    inputSchema: schema({
      summary: string,
      team: { type: 'array', items: schema({ role: string, kind: kinds, tier: tiers, model: string, effort: efforts, reason: string }, ['role']) },
      segments: { type: 'array', items: schema({ name: string, preset: presets, goal: string, acceptance: string }, ['name', 'preset', 'acceptance']) },
      estimateRounds: { type: 'number' },
    }, ['summary', 'segments']) },
  { name: 'orch_add_member',
    description: '按已确认计划新建一位成员（同时最多 3 位）。tier：fast=Sonnet 5.5 / GPT-6 Luna 低思考，standard=GPT-6.1 Sol / Opus 5.5 中思考，deep=Hub 默认最强；点名 model/effort 时以点名为准。返回成员编号（如 m2），派活时用这个编号。',
    inputSchema: schema({ role: string, kind: kinds, tier: tiers, model: string, effort: efforts }, ['role', 'kind']) },
  { name: 'orch_start_workflow',
    description: '为一个工作段启动 Hub 交付工作流（同一时间只能有一段在跑）。development：members=[开发位, 审核位]，开题→实现与自测→独立审查，审核位判定通过/返工；research / roundtable：members 为 2–3 位，最后一位收口；custom：用 rounds 自定义 1–6 轮（每轮 name、prompt、members、after=next|end）。goal 写清任务，acceptance 写验收标准。',
    inputSchema: schema({
      name: string, preset: presets, goal: string, acceptance: string,
      members: { type: 'array', items: string },
      rounds: { type: 'array', items: schema({ name: string, prompt: string, members: { type: 'array', items: string }, after: { type: 'string', enum: ['next', 'end'] } }, ['name', 'prompt', 'members']) },
      sameKindReason: string,
    }, ['name', 'preset', 'goal', 'acceptance', 'members']) },
  { name: 'orch_control_workflow',
    description: '控制当前工作段：continue 续跑暂停的工作流（会消耗额度），remind 提醒未交付成员补交（可带 note），pause 暂停，cancel 取消本段。',
    inputSchema: schema({ action: { type: 'string', enum: ['continue', 'remind', 'pause', 'cancel'] }, note: string }, ['action']) },
  { name: 'orch_ask_member',
    description: '单独问某位成员一个问题（澄清、调研、复核），成员把回答写进群聊回答文件，Hub 回答后通知你。回答只作参考，不能当工作段的完成证据。成员正在工作流里干活时不能打断。',
    inputSchema: schema({ memberId: string, question: string }, ['memberId', 'question']) },
  { name: 'orch_report',
    description: '记录给田哥的汇报。progress=阶段进展；need_decision=需要田哥决定（额度用满、没有进展、目标要改时必须用它，Hub 会在界面上请田哥决定）；final=全部完成（只有每个工作段都有审核结论时才会被接受）。summary 用白话写现在做到哪、卡在哪、建议与理由，引用结论附文件路径。',
    inputSchema: schema({ kind: { type: 'string', enum: ['progress', 'need_decision', 'final'] }, summary: string }, ['kind', 'summary']) },
];
async function handle(request) {
  if (request.method === 'initialize') return { protocolVersion: request.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'hub-orchestrator', version: '0.1.0' } };
  if (request.method === 'ping') return {};
  if (request.method === 'tools/list') return { tools };
  if (request.method === 'tools/call') {
    if (!tools.some(t => t.name === request.params?.name)) throw new Error('未知工具');
    const endpoint = JSON.parse(fs.readFileSync(process.env.HUB_ORCH_ENDPOINT_FILE, 'utf8'));
    const response = await fetch(endpoint.url, { method: 'POST', headers: { Authorization: 'Bearer ' + endpoint.token, 'Content-Type': 'application/json', 'X-Hub-Orchestrator-Session': process.env.HUB_ORCH_SESSION_ID || '' }, body: JSON.stringify(request.params), signal: AbortSignal.timeout(120000) });
    const data = await response.json();
    return { content: [{ type: 'text', text: JSON.stringify(data.ok ? data.result : { error: data.error }) }], isError: !data.ok };
  }
  throw new Error('未知方法');
}
if (require.main === module) readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async line => {
  let request;
  try {
    request = JSON.parse(line);
    if (request.id == null) return;
    const result = await handle(request);
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32000, message: error.message } }) + '\n');
  }
});
module.exports = { tools };
