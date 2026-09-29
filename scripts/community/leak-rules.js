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

const RULES = [
  { id: 'identity-name', re: /立花道雪|道雪|田哥|林田/ },
  { id: 'identity-login', re: /lintian|TianLin0509\/claude-session-hub|lt17210720082|17210720082|fudan\.edu/i },
  { id: 'private-gateway', re: /3\.142\.133\.116|packyapi|packycode|lthub\.xyz|meridian/i },
  { id: 'personal-project', re: /chuxin|初心|lindang/i },
  // 已删除模块在通用代码里留下的死分支与注释（不含个人数据）：只统计、不拦截，逐步清理。
  { id: 'module-residue', re: /agent-league|投资联赛|投委会|research-mcp|arena-research/i, severity: 'residue' },
  { id: 'personal-research-sites', re: /雪球|韭研|问财|xueqiu|jiuyangongshe|iwencai|kline-screener|Stock_test|Stock_top10|funtop10|tushare/i },
  { id: 'personal-preference', re: /昇腾|华为|huawei|英灵|spirit-lens|spirit-registry/i },
  { id: 'personal-tools', re: /chatgpt-bridge|chatgpt_bridge|company-drop|company_drop|公司中转|公司 ChatGPT|同步到公司|语雀|yuque|tiange-voice|kongkou|superran|channel-sim|xiaobei/i },
  { id: 'personal-machine-layout', re: /C:[\\/]{1,2}(?:Vibe(?:Data)?|DevTools|AIWork)\b|VibeData|CodexWebGPT/i },
  { id: 'secret-openai-anthropic', re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b/ },
  { id: 'secret-github', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/ },
  { id: 'secret-aws', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'secret-private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

// 按文件名判断的私人模块（即使内容被改干净，文件名本身也不该出现）。
const NAME_RULE = /(?:^|\/)[^/]*(?:chuxin|study|agent-league|committee|lindang|research-mcp|spirit|screener|chatgpt-bridge|company-drop)[^/]*$/i;

const TEXT_EXT = /\.(?:js|cjs|mjs|json|md|html|css|ps1|bat|cmd|py|yml|yaml|txt|svg|toml)$/i;

function scanText(text, file) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      const match = rule.re.exec(line);
      if (match) hits.push({ file, line: index + 1, rule: rule.id, severity: rule.severity || 'block', match: match[0], text: line.trim().slice(0, 160) });
    }
  });
  return hits;
}

function scanTree(root, files) {
  const hits = [];
  for (const file of files) {
    if (NAME_RULE.test(file)) hits.push({ file, line: 0, rule: 'personal-module-file', severity: 'block', match: path.basename(file) });
    if (!TEXT_EXT.test(file)) continue;
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    if (text.includes('\uFFFD')) hits.push({ file, line: 0, rule: 'invalid-utf8', severity: 'block', match: 'U+FFFD' });
    hits.push(...scanText(text, file));
  }
  return hits;
}

module.exports = { RULES, NAME_RULE, scanText, scanTree };
