'use strict';
// Audited dependencies, not keyword-based authentication guesses. Unknown tools
// remain unknown. Skills may use several services; installing a plugin is not login.
const SERVICES = {
  images: { name: 'ChatGPT 网页生图', kind: 'browser', site: 'chatgpt', binding: 'images', help: '生图 MCP、插件和技能共用队列；每组车道绑定一个 Hub 账号。' },
  bridge: { name: 'ChatGPT 公司中转', kind: 'browser', site: 'chatgpt', binding: 'bridge', help: '必须绑定原中转会话所属账号；保留会话和收取进度。' },
  roundtable: { name: 'AI 网页圆桌', kind: 'browser', help: 'DeepSeek、Kimi、千问共用 Hub 主账号；会话还需启用网页 MCP。', sites: ['deepseek', 'kimi', 'qwen'] },
  playwright: { name: 'Playwright 浏览器工具', kind: 'browser', help: '通用浏览器有自己的资料目录；迁移前须确认页面归属和原扩展依赖。' },
  hostBrowser: { name: '客户端内置浏览器', kind: 'host', help: 'browser-use 由原生客户端提供浏览器；目前没有 Hub Chrome 接入接口。' },
  hostImage: { name: '客户端内置生图', kind: 'host', help: 'image_gen 使用客户端自己的授权；和 ChatGPT 网页生图是不同入口。' },
  bailian: { name: '阿里云百炼', kind: 'credential', help: '百炼技能与抖音转写使用 API 授权；千问网页登录不能替代百炼密钥。', files: [['.bailian', 'config.json']], env: ['DASHSCOPE_API_KEY'], fields: ['api_key', 'access_token', 'access_key_id'] },
  github: { name: 'GitHub', kind: 'credential', help: '复用 GitHub CLI / Git 的原生授权；浏览器登录不等于仓库访问授权。', files: [['AppData', 'Roaming', 'GitHub CLI', 'hosts.yml'], ['.config', 'gh', 'hosts.yml']], env: ['GH_TOKEN', 'GITHUB_TOKEN'] },
  yuque: { name: '语雀中转', kind: 'browser', help: '旧工具直接使用保存的 Cookie，尚未改为 Hub 网页操作；不能把打开官网标为迁移完成。', files: [['tools', 'chat_sync', 'config.json']], fields: ['yuque_session'] },
  social: { name: '社交网站采集', kind: 'browser', help: '抖音、雪球、小红书、X、LinkedIn 等按站点授权；各采集器仍需逐个适配。', files: [['.config', 'yt-dlp', 'douyin_cookies.txt'], ['.douyin-profile'], ['.agent-reach', 'config.yaml']] },
  tushare: { name: 'Tushare 行情数据', kind: 'credential', help: '投研可选数据源使用 TUSHARE_TOKEN；不会因 AI 网页登录而获得数据权限。', env: ['TUSHARE_TOKEN'] },
  sftp: { name: '公司文件中转', kind: 'credential', help: 'company-drop 使用 SFTP 私钥，由原工具保管；与 ChatGPT 文字中转独立。' },
  mediaPublish: { name: '视频发布服务', kind: 'credential', help: '视频技能使用 R2 / SSH 发布授权；仅登记依赖，不自动发布。', files: [['.ai-daily-r2.json']], fields: ['access_key_id', 'secret_access_key'] },
  openaiApi: { name: 'OpenAI API', kind: 'credential', help: '仅 imagegen 显式选择 API 模式时使用；ChatGPT 网页订阅不替代 API Key。', env: ['OPENAI_API_KEY'] },
};
const DEPENDENCIES = {
  'chatgpt-web-images': ['images'], 'chatgpt-bridge': ['bridge'], web_roundtable: ['roundtable'],
  playwright: ['playwright'], browser: ['hostBrowser'], 'browser-use': ['hostBrowser'],
  'bailian-cli': ['bailian'], 'bailian-gen': ['bailian'], 'bailian-protocol': ['bailian'], douyin: ['bailian'],
  'agent-reach': ['social', 'github', 'bailian'], yuque: ['yuque'], 'company-drop': ['sftp'],
  'a-share-roundtable-stock-analysis': ['tushare'], 'funtop10': ['tushare'],
  'stock-news-daily': ['social', 'mediaPublish'], 'ai-daily-video': ['mediaPublish'],
  imagegen: ['hostImage', 'openaiApi'], 'huawei-ppt': ['hostImage'], 'gen-ppt-image': ['hostImage'],
  'skill-installer': ['github'], 'commit-commands': ['github'], 'superran-lead': ['github'], 'superran-member-task': ['github'],
};
const LOCAL = new Set(('channel-sim chinese-tech-writing claude-md-improver claude-md-management code-review content-research-writer design-review documents feature-dev frontend-design grill-me grilling humanizer-zh img2ppt-lite kongkou-video openai-docs plugin-creator plugin-management post-refactor-verify ppt-templates-gen presentations project-prep pyright-lsp review review-agent skill-creator spreadsheets superran arena-research tiange-voice ui-ux-pro-max brainstorming diagnosing-superpowers dispatching-parallel-agents executing-plans finishing-a-development-branch receiving-code-review requesting-code-review subagent-driven-development superpowers systematic-debugging test-driven-development using-git-worktrees using-superpowers verification-before-completion writing-plans writing-skills').split(' '));
function dependencyFor(row, rows = [], seen = new Set()) {
  if (seen.has(row.id)) return { state: 'unknown', services: [] };
  seen.add(row.id);
  const name = row.name.split('@')[0].toLowerCase();
  if (Object.hasOwn(DEPENDENCIES, name)) return { state: 'reviewed', services: [...DEPENDENCIES[name]] };
  if (row.type === 'plugin') {
    const children = rows.filter(r => r.sources?.some(s => s.plugin === row.name));
    if (children.length) {
      const deps = children.map(r => dependencyFor(r, rows, new Set(seen)));
      return { state: deps.some(d => d.state === 'unknown') ? 'unknown' : 'reviewed', services: [...new Set(deps.flatMap(d => d.services))] };
    }
  }
  return { state: LOCAL.has(name) ? 'reviewed' : 'unknown', services: [] };
}
module.exports = { SERVICES, dependencyFor };
