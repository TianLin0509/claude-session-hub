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
      model: { type: 'string', description: '公司那边用哪个模型（可选，按工具描述里的模型表选；不填 = 公司默认）' },
      account: { type: 'string', description: '公司那边用哪个号（可选，代称如「个人」「号 1」，见工具描述里的各号；默认不填，交给自动路由避开额度用完的号，有明确理由才指定）' } }, ['question']),
  },
  {
    name: 'followup_company',
    description: '对同一编号追问。公司那边是同一个 CodeAgent 会话，记得上一轮做过、读过的内容。'
      + '回执存疑时使用：把握程度低、没读到关键部分、与家里的证据矛盾、或需要更细的细节。指出哪里不可信、请它再读哪里。'
      + '次数不限，由你判断信息是否已经足够。上一轮回执到达前不能追问。'
      + '原会话所在的号额度用完时，公司会自动换号新开会话并带上前几轮问答，不用你处理；account（可选）指定换到哪个号，同样新开会话带上下文。',
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: schema({ thread: { type: 'string', description: '编号，如 Q-1015-01' }, question: string,
      account: { type: 'string', description: '可选：换到这个号（代称）新开会话追问；默认不填，沿用原会话' } }, ['thread', 'question']),
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
    name: 'company_diag',
    description: '直查公司电脑和公司 AI Hub 的状态：秒级、不排队、不占公司 CodeAgent（公司 Hub 主进程直接读系统信息和自身状态，压缩后经加密通道回报，不开会话）。'
      + '适合查：内存为什么紧、谁占了内存（按内存排的进程、CodeAgent 进程数与总内存、Hub 自身占用、不在 Hub 进程树里的 CodeAgent/node/electron 残留进程）、'
      + '通道队列为什么排队（并行上限及受什么限制、每个问题在跑还是排队、排队原因、会话在不在、记录最后写入时间）、Hub 里的会话、号池各号状态与模型、通道与 Hub 日志尾部。'
      + 'sections 可选 machine（内存/CPU/开机时长/磁盘）、processes、hub、pool（含每个号的避让状态与 Credit）、logs、codeagent（版本、登录、额度、避让中的号）、airview（Python/MATLAB/AirView 进程与结果目录里最近更新的文件名）、features（论坛、简报、手机对话、桌宠下载最近一次成功/错误）、'
      + 'errors（最近 N 条 CodeAgent 会话里识别到 / 疑似的 API 报错原文片段，已脱敏，用来核对额度报错的识别规则），不填 = 全部。调用后最多等约 45 秒、拿到就直接返回结果；'
      + '公司检查通道的间隔是 10 秒，空闲时按公司设置（默认 30 秒），等不到会返回编号，稍后带 id 再调一次取结果（不要反复发新的直查，公司 30 秒内只处理一次）。'
      + '只读：不改动公司电脑、不读源码；号身份已换成「个人 / 号 1 / 号 2」，日志已脱敏。要读公司代码或文件内容仍用 ask_company。',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: schema({
      sections: { type: 'array', items: { type: 'string', enum: ['machine', 'processes', 'hub', 'pool', 'logs', 'codeagent', 'airview', 'features', 'errors'] }, description: '要查的段落，不填 = 全部' },
      lines: { type: 'integer', minimum: 1, maximum: 200, description: '日志每份取最后几行（默认 80）' },
      errors: { type: 'integer', minimum: 1, maximum: 50, description: 'errors 段取最近几条（默认 20）' },
      id: { type: 'string', description: '取之前那次直查的结果（不发新的）' },
    }),
  },
  {
    name: 'company_files',
    description: '读取公司电脑上的文本文件：秒级、不排队、不占公司 CodeAgent（公司 Hub 主进程直接读盘，gzip 压缩后经加密通道回报；不开会话、不问模型）。'
      + '用户说「把公司电脑上的某个文件 / AirView 的输出文本拿到本地」「查一下公司那份文档里怎么写的」时用；拿回来的正文可以直接在本地读、写进 SuperRAN 的设计里，比走 ask_company（要排队、要等模型，中位数 5 分钟以上）快得多。'
      + 'action：list（列目录，dir 给路径或相对路径，depth 0–4 递归，默认只列可读的文本文件并报整棵子树的文件数与总大小，用来估传输量）；'
      + 'search（找文件：name 文件名、支持 * 和 ?，或 content 正文里的词，root 可限定在哪棵目录下，limit 默认 50）；'
      + 'read（file 给文件路径，from 起始行、lines 最多 4000 行、chars 最多 60000 字，返回这段正文和总行数；没读完时结果里的 next 是下次的 from）。'
      + '能读的目录是公司端设置好的仿真结果目录 + 代码位置 + 额外可读目录；只读、永不写；文本文件一律可读、不挑后缀（2026-10-20 起：工程配置 .runcfg/.cmp/.pro/.vcxproj 这类原来被白名单挡着的现在都能读），密钥类后缀和二进制直接拒绝；凭据（口令、令牌、私钥）自动隐去。'
      + '调用后最多等约 45 秒拿到结果；公司检查通道的间隔是 10 秒，空闲时按公司设置（默认 30 秒），等不到会返回编号，稍后带 id 再调一次取结果（不要反复发同一条，公司按动作限频）。'
      + '大文件不要一次读完：先 list 看有几个、多大，再按 from/lines 分段读，读完一段再要下一段。',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: schema({
      action: { type: 'string', enum: ['list', 'search', 'read'] },
      dir: { type: 'string', description: 'list：目录路径（绝对路径，或在可读目录里的相对路径），默认第一个可读目录' },
      depth: { type: 'integer', minimum: 0, maximum: 4, description: 'list / search：递归几层（list 默认 0 只看这一层，search 默认 4）' },
      all: { type: 'boolean', description: 'list：true = 连不可读的文件也列出来（只给名字、大小和不可读的原因）' },
      root: { type: 'string', description: 'search：限定在哪棵可读目录下找（不填 = 全部可读目录）' },
      name: { type: 'string', description: 'search：文件名，支持 * 和 ?（如 *.txt、*result*）' },
      content: { type: 'string', description: 'search：文件正文里的词（只搜 2 MB 以内的文件）' },
      maxKB: { type: 'number', description: 'search：按内容搜索时单个文件的大小上限 KB（默认 2048）' },
      file: { type: 'string', description: 'read：文件路径（绝对路径，或在可读目录里的相对路径）' },
      from: { type: 'integer', minimum: 1, description: 'read：从第几行开始（1 起，默认 1）' },
      lines: { type: 'integer', minimum: 1, maximum: 4000, description: 'read：读多少行（默认 600）' },
      chars: { type: 'integer', minimum: 1000, maximum: 60000, description: 'read：这段最多多少字（默认 30000）' },
      id: { type: 'string', description: '取之前那一次的结果（不发新的）' },
    }, ['action']),
  },
  {
    name: 'company_act',
    description: '远程维护公司电脑上的 AI Hub：会改动公司电脑状态，仅在用户要求或诊断明确指向时使用，先用 company_diag 看清楚再 act。'
      + 'action：suspend-idle（让答完空着的通道会话休眠，人自己开的会话不动）；kill-orphans（结束最近一次 company_diag 列为「可结束」的残留进程，targets 填那次结果里的 pid 和 startedAt，5 分钟内有效，只按 PID 结束，Hub 进程树永远不动）；'
      + 'set-parallel（临时改 memFloorPct 5–50 / maxParallel 1–8 / maxParallelIdle 1–12，usePool true/false：false = 通道新开的会话只用公司个人账号、不用号池，restoreAfterHours 0.25–24 小时后恢复原值；maxParallel 只管工作日忙时，闲时上限取两者较大的，要整体收紧就两个一起改）；cancel-queued（取消还在排队的问题，thread 填编号）；retry（重试失败的问题）；'
      + 'pause-account（手动让一个号避让，account 填代称如「号 1」，hours 0.25–72 小时后自动恢复、不填 = 直到手动恢复；单个号额度用完时优先用它，比整体停用号池更细）；resume-account（解除一个号的避让，含自动识别到额度报错的，之后照常派活）；'
      + 'set-personal-model（修正公司个人账号的默认模型：model 必须在个人账号的权限清单里，如 GLM-5.2-WX-Auto，company_diag 的 pool 段个人账号一行若有「默认模型和权限不符」就用它给的模型；只改个人配置目录 settings.json 的 model 一项，改前备份、写后核对，只影响之后新开的会话；权限要有依据（清单经过探测，或个人账号实际用它作答过），都没有时拒绝，force:true 跳过这一条；restore:true 撤销上一次修改；用户明确要求时才用）。'
      + '公司端可在设置里关掉「远程维护」，关了回 refused；每个动作有限频。调用后最多等约 45 秒直接返回结果和前后对比（如内存释放多少）；等不到就返回编号，稍后带 id 再取，不要重复发同一个动作。',
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    inputSchema: schema({
      action: { type: 'string', enum: ['suspend-idle', 'kill-orphans', 'set-parallel', 'cancel-queued', 'retry', 'pause-account', 'resume-account', 'set-personal-model'] },
      model: { type: 'string', description: 'set-personal-model：改成哪个模型（必须在公司个人账号的权限清单里）' },
      restore: { type: 'boolean', description: 'set-personal-model：true = 撤销上一次修改（用最近一次备份里的值），不填 model' },
      force: { type: 'boolean', description: 'set-personal-model：true = 跳过权限校验（个人账号的权限清单没经过探测、也没有实际作答记录时才需要；回报和审计会标「未经权限校验」），只在用户明确同意时用' },
      account: { type: 'string', description: 'pause-account / resume-account：号的代称，如「个人」「号 1」（company_diag 的 pool 段里看）' },
      hours: { type: 'number', minimum: 0.25, maximum: 72, description: 'pause-account：多少小时后自动恢复（不填 = 直到手动恢复）' },
      reason: { type: 'string', description: 'pause-account：原因（可选，60 字内）' },
      targets: { type: 'array', items: schema({ pid: { type: 'integer' }, startedAt: { type: 'integer' } }, ['pid', 'startedAt']), description: 'kill-orphans：要结束的进程（取自 company_diag 的 processes.leftovers 里 killable 为 true 的项）' },
      thread: { type: 'string', description: 'cancel-queued / retry：问题编号，如 Q-1018-03' },
      memFloorPct: { type: 'integer', minimum: 5, maximum: 50 }, maxParallel: { type: 'integer', minimum: 1, maximum: 8 }, maxParallelIdle: { type: 'integer', minimum: 1, maximum: 12 },
      usePool: { type: 'boolean', description: 'set-parallel：false = 通道新开的会话只用个人账号，不用号池；true = 恢复用号池' },
      restoreAfterHours: { type: 'number', minimum: 0.25, maximum: 24, description: 'set-parallel：多少小时后恢复原值（不填 = 不自动恢复）' },
      id: { type: 'string', description: '取之前那次远程维护的结果（不发新的）' },
    }),
  },  {
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
      body: JSON.stringify(request.params), signal: AbortSignal.timeout(['company_diag', 'company_act'].includes(request.params?.name) ? 90000 : 60000) }); // 直查会等回报最多约 45 秒
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
