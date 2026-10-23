'use strict';

// 社区版泄露闸门：导出树里出现下列任何一条就判失败。
//
// 这份规则只留在主仓库：它本身写着需要防的名字、路径和服务，放进公开库等于
// 把清单公开。公开库里另有只查通用密钥形态的 scripts/audit-public.js。
//
// 规则分三类：身份（名字、账号、邮箱、本机用户目录）、私人服务与私人模块
// （网关、投研站点、公司中转等关键词）、通用密钥形态。命中后修源头（删文件、剥离
// 标记、脱敏规则或把默认值改成中性的），不要在这里加豁免。
// severity 缺省为 block（导出失败）；residue 只进报告。

const fs = require('fs');
const path = require('path');

// 唯一的例外（2026-10-12 用户决定）：公开版、公司版的「规则」页从这个地址拉通用规则，
// 地址必须随发行版公开。只放行这一个完整前缀，同一行的其他内容照常检查；别的地址不要加进来。
// 2026-10-13 用户同意公司版一键更新从阿里云下载，更新目录同理随发行版公开。
const ALLOWED_PUBLIC_URLS = ['https://me.lt-stockpartner.tech/hub-rules/', 'https://me.lt-stockpartner.tech/hub-update/'];

// 团队工具是本次用户明确要求接入的入口。仅公司目标的专用目录文件放行这六个
// 完整 JSON 字符串；公开目标、其他文件、子路径和同一行其他内容仍按原规则检查。
const COMPANY_TEAM_URLS = [
  'https://me.lt-stockpartner.tech/tools/', 'https://me.lt-stockpartner.tech/captain/',
  'https://me.lt-stockpartner.tech/style/', 'https://ai.lt-stockpartner.tech/weekly/',
  'https://ai.lt-stockpartner.tech/ai-team/ui/', 'https://ai.lt-stockpartner.tech/reports/',
];

// 发行目标可以放行自己的产品显示名（target.json 的 leakAllow；2026-10-13 用户选定公司版叫
// 「AI HUB-Huawei」并公开发布）。只放行带 Huawei/华为 的完整产品名整串，同一行其余内容照常检查；
// 社区版和主仓库不传这个参数，拦截不变。
function checkedAllowLiterals(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error('leakAllow 必须是字符串数组');
  for (const item of list) {
    if (typeof item !== 'string' || item.length < 8 || !/huawei|华为/i.test(item)) throw new Error(`leakAllow 只能放行带 Huawei/华为 的完整产品名（至少 8 个字符）：${item}`);
  }
  return [...list].sort((a, b) => b.length - a.length);
}

const RULES = [
  { id: 'identity-name', re: /立花道雪|道雪|田哥|林田/ },
  { id: 'identity-login', re: /lintian|TianLin0509\/claude-session-hub|lt17210720082|17210720082|fudan\.edu/i },
  { id: 'private-gateway', re: /3\.142\.133\.116|packyapi|packycode|lthub\.xyz|stockpartner|meridian/i },
  { id: 'personal-project', re: /chuxin|初心|lindang/i },
  // 已删除模块在通用代码里留下的死分支与注释（不含个人数据）：只统计、不拦截，逐步清理。
  { id: 'module-residue', re: /agent-league|投资联赛|投委会|research-mcp|arena-research/i, severity: 'residue' },
  { id: 'personal-research-sites', re: /雪球|韭研|问财|xueqiu|jiuyangongshe|iwencai|kline-screener|Stock_test|Stock_top10|funtop10|tushare/i },
  { id: 'personal-preference', re: /昇腾|华为|huawei/i },
  { id: 'personal-tools', re: /chatgpt-bridge|chatgpt_bridge|company-drop|company_drop|公司中转|公司 ChatGPT|同步到公司|语雀|yuque|tiange-voice|kongkou|superran|channel-sim|xiaobei/i },
  { id: 'personal-machine-layout', re: /C:[\\/]{1,2}(?:Vibe(?:Data)?|DevTools|AIWork)\b|VibeData|CodexWebGPT/i },
  { id: 'secret-openai-anthropic', re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b/ },
  { id: 'secret-github', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/ },
  { id: 'secret-aws', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'secret-private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

// 按文件名判断的私人模块（即使内容被改干净，文件名本身也不该出现）。
const NAME_RULE = /(?:^|\/)[^/]*(?:chuxin|study|agent-league|committee|lindang|research-mcp|screener|chatgpt-bridge|company-drop)[^/]*$/i;

const TEXT_EXT = /\.(?:js|cjs|mjs|json|md|html|css|ps1|bat|cmd|py|yml|yaml|txt|svg|toml)$/i;

function scanText(text, file, options = {}) {
  const hits = [];
  const allow = checkedAllowLiterals(options.allowLiterals);
  const teamUrls = options.target === 'company' && file.replace(/\\/g, '/') === 'core/team-workspace/sites.json'
    ? COMPANY_TEAM_URLS.map(url => JSON.stringify(url)) : [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const checked = [...ALLOWED_PUBLIC_URLS, ...allow, ...teamUrls].reduce((text, literal) => text.split(literal).join(' '), line);
    for (const rule of RULES) {
      const match = rule.re.exec(checked);
      if (match) hits.push({ file, line: index + 1, rule: rule.id, severity: rule.severity || 'block', match: match[0], text: line.trim().slice(0, 160) });
    }
  });
  return hits;
}

function scanTree(root, files, options = {}) {
  const hits = [];
  for (const file of files) {
    if (NAME_RULE.test(file)) hits.push({ file, line: 0, rule: 'personal-module-file', severity: 'block', match: path.basename(file) });
    if (!TEXT_EXT.test(file)) continue;
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    if (text.includes('\uFFFD')) hits.push({ file, line: 0, rule: 'invalid-utf8', severity: 'block', match: 'U+FFFD' });
    hits.push(...scanText(text, file, options));
  }
  return hits;
}

module.exports = { RULES, NAME_RULE, scanText, scanTree };
