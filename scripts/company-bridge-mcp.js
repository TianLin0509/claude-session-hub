'use strict';
// 「问公司」MCP（2026-10-15）：家里的 Agent 请公司电脑上的 CodeAgent 办事（查代码、查公司本地信息）。JSON-RPC over stdio。
// 只转发给本机 Hub：地址在环境变量指向的文件里，会话通行证在环境变量里（只能代表本会话），都不出现在工具输出；本身不联网、不执行命令。
const readline = require('node:readline');
const fs = require('node:fs');
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
const tools = [
  {
    name: 'ask_company',
    description: '请公司电脑上的 CodeAgent 新开一个会话办事，回执是 Markdown 文字说明，不含源码。它在公司内网里，能读公司代码（如 AirView、L2 的实际实现）、'
      + '查公司电脑上的文件、文档和环境、运行查询类命令；不改动公司电脑。'
      + '适合：核对家里实现与公司代码的差异；确认公司代码里某个算法、参数、流程的具体做法；用户要你「问一下公司的 CodeAgent」「让公司那边查一下」的任何事。'
      + '内容要自包含（对方看不到你的上下文）：写清目的、要它做的事或要问的点（编号列出）、已知的线索（家里现在的做法、建议去看的目录或关键词）、回复要求。'
      + '调用后立即返回编号；公司一个来回通常 10 分钟以上，回执到达后 Hub 会把它作为一条新消息自动发到本会话。发出后请结束本轮，或先做不依赖回执的工作，不要循环等待或反复查询。',
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: schema({ question: { type: 'string', description: 'Markdown 格式的完整问题' }, title: { type: 'string', description: '一句话标题（可选，20 字内）' } }, ['question']),
  },
  {
    name: 'followup_company',
    description: '对同一编号追问。公司那边是同一个 CodeAgent 会话，记得上一轮做过、读过的内容。'
      + '回执存疑时使用：把握程度低、没读到关键部分、与家里的证据矛盾、或需要更细的细节。指出哪里不可信、请它再读哪里。'
      + '次数不限，由你判断信息是否已经足够。上一轮回执到达前不能追问。',
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: schema({ thread: { type: 'string', description: '编号，如 Q-1015-01' }, question: string }, ['thread', 'question']),
  },
  {
    name: 'company_thread',
    description: '查看本会话向公司提过的问题和全部回执（不传 thread 时列出本会话最近 10 个），以及公司电脑是否在线。回执会自动送达，一般不需要调用。',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: schema({ thread: string }),
  },
];

async function handle(request) {
  if (request.method === 'initialize') return { protocolVersion: request.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'company-bridge', version: '0.1.0' } };
  if (request.method === 'ping') return {};
  if (request.method === 'tools/list') return { tools };
  if (request.method === 'tools/call') {
    if (!tools.some(t => t.name === request.params?.name)) throw new Error('未知工具');
    const endpoint = JSON.parse(fs.readFileSync(process.env.HUB_BRIDGE_ENDPOINT_FILE, 'utf8'));
    const response = await fetch(endpoint.url, { method: 'POST', headers: { Authorization: 'Bearer ' + (process.env.HUB_BRIDGE_SESSION_PASS || ''), 'Content-Type': 'application/json', 'X-Hub-Bridge-Session': process.env.HUB_BRIDGE_SESSION_ID || '' },
      body: JSON.stringify(request.params), signal: AbortSignal.timeout(60000) });
    const data = await response.json();
    return { content: [{ type: 'text', text: JSON.stringify(data.ok ? data.result : { error: data.error }, null, 1) }], isError: !data.ok };
  }
  throw new Error('未知方法');
}
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', async line => {
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
