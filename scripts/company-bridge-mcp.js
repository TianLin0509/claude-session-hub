'use strict';
// 「问公司」MCP（2026-10-15）：家里的 Agent 请公司电脑上的 CodeAgent 办事（查代码、查公司本地信息）。JSON-RPC over stdio。
// 只转发给本机 Hub：地址在环境变量指向的文件里，会话通行证在环境变量里（只能代表本会话），都不出现在工具输出；本身不联网、不执行命令。
const readline = require('node:readline');
const fs = require('node:fs');
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
const tools = [
  {
    name: 'send_image_company',
    description: '明确需要传图片时，将本机 PNG/JPEG/WebP 图片发送到已有的公司问答线程。Hub 在本机压缩和加密，完整文字消息小于 60000 字节；默认保留分辨率，allow_resize=true 才允许缩小。请先用 ask_company 建立线程。只传路径，不把图片编码放入问题。返回待发送或已发送不等于对端已收到，可用 company_images 查校验和通知状态。',
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: schema({ thread: string, path: { type: 'string', description: '本机图片绝对路径' }, round: { type: 'integer', minimum: 1 }, caption: string, allow_resize: { type: 'boolean', default: false } }, ['thread', 'path']),
  },
  { name: 'company_images', description: '查看属于当前会话的通道图片：大小、压缩方式、对端校验、通知状态和本机路径。', annotations: { readOnlyHint: true, openWorldHint: false }, inputSchema: schema({ thread: string }) },
  {
    name: 'ask_company',
    description: '请公司电脑上的 CodeAgent 新开一个会话办事，回执是 Markdown 文字说明，不含源码。它在公司内网里，能读公司代码（如 AirView、L2 的实际实现）、'
      + '查公司电脑上的文件、文档和环境、运行查询类命令；不改动公司电脑。'
      + '适合：核对家里实现与公司代码的差异；确认公司代码里某个算法、参数、流程的具体做法；用户要你「问一下公司的 CodeAgent」「让公司那边查一下」的任何事。'
      + '内容要自包含（对方看不到你的上下文）：写清目的、要它做的事或要问的点（编号列出）、已知的线索（家里现在的做法、建议去看的目录或关键词）、回复要求。'
      + '调用后立即返回编号；公司一个来回通常 10 分钟以上，回执到达后 Hub 会把它作为一条新消息自动发到本会话。发出后请结束本轮，或先做不依赖回执的工作，不要循环等待或反复查询。',
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: schema({ question: { type: 'string', description: 'Markdown 格式的完整问题' }, title: { type: 'string', description: '一句话标题（可选，20 字内）' },
      model: { type: 'string', description: '公司那边用哪个模型（可选，按工具描述里的模型表选；不填 = 公司默认）' } }, ['question']),
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
    name: 'recollect_company',
    description: '补收：上一轮回执报「没答上」（例如「会话停下了，但一直没读到回答」「未能唯一核对……」），或发出 20 分钟以上还没有回执时，'
      + '请公司 Hub 把那个公司会话在这一轮之后写下的最新回答直接取回来，不让 CodeAgent 重答一遍。取回的文字开头会注明是补收、没有逐条核对归属，请据内容判断是否对题；'
      + '取不到会回一条说明，那时再用 followup_company 重问。',
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: schema({ thread: { type: 'string', description: '编号，如 Q-1016-02' } }, ['thread']),
  },
  {
    name: 'company_hub_update',
    description: '远程让公司电脑上的 AI Hub 自己更新或重启（用户说「让公司 Hub 更新 / 重启」「看看公司 Hub 什么版本」时用）。'
      + 'op=update：公司 Hub 从发行源查新版本、下载校验，等手上的任务答完后重启替换，失败自动回滚；'
      + 'op=restart：等任务答完后重启（不换版本）；op=status：只回报公司 Hub 的版本与更新状态。'
      + '默认最多等 3 分钟（公司端可设），到时还在跑的任务先记下、中断，重启后自动恢复会话接着做，通道里的问题照常回执；force=true 不等，立即这样做。'
      + '调用后立即返回指令编号和公司最近的回报；进度与结果以 Hub 通知送达，稍后可用 op=status 查，不要循环等待。',
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: schema({ op: { type: 'string', enum: ['update', 'restart', 'status'] }, force: { type: 'boolean', description: '不等手上的任务，马上重启（在跑的任务先记下，重启后自动接着做；默认 false）' } }, ['op']),
  },
  {
    name: 'company_thread',
    description: '查看本会话向公司提过的问题和全部回执（不传 thread 时列出本会话最近 10 个），以及公司电脑是否在线。回执会自动送达，一般不需要调用。',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: schema({ thread: string }),
  },
];

// ask_company 的描述带上公司模型表（2026-10-18 按模型派活）：家里 Hub 收到公司的模型表后写在通道目录的 company-models.json，
// 每次列工具时现读；没有时写明「模型表未知」。模型表的写法与家里一端共用（core/company-bridge/model-table-text.js）。
function readModels(env = process.env) {
  if (!env.HUB_BRIDGE_ENDPOINT_FILE) return null;
  try { return JSON.parse(fs.readFileSync(require('node:path').join(require('node:path').dirname(env.HUB_BRIDGE_ENDPOINT_FILE), 'company-models.json'), 'utf8')); }
  catch { return null; }
}
function listTools(env = process.env) {
  let guide;
  try { guide = require('../core/company-bridge/model-table-text').modelGuide(readModels(env)); }
  catch { guide = '模型表未知：可以不填 model，用公司默认。'; }
  return tools.map(t => t.name === 'ask_company' ? { ...t, description: t.description + '\n\n发问前先看公司模型表，按任务难度和忙闲选 model：\n' + guide } : t);
}

async function handle(request) {
  if (request.method === 'initialize') return { protocolVersion: request.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'company-bridge', version: '0.1.0' } };
  if (request.method === 'ping') return {};
  if (request.method === 'tools/list') return { tools: listTools() };
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
module.exports = { listTools, readModels };
if (require.main !== module) return;
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
