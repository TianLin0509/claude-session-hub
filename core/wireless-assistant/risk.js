'use strict';
// 自动派发前的安全预检：提案正文（含红灯测试代码）里出现删除、上传、读凭据这类操作时，
// 不自动交给 Agent，先停在「待你放行」，由田哥看过再放行。宁可多停一次，不让组员写的代码
// 在这台装着各类登录凭据的电脑上无人值守地执行破坏性操作。
const RULES = [
  { re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, why: '递归强制删除（rm -rf）' },
  { re: /Remove-Item\b[^\n]*-Recurse|\brmdir\s+\/s\b|\brd\s+\/s\b|\bdel\s+\/[sq]\b/i, why: '递归删除目录' },
  { re: /shutil\.rmtree|os\.(remove|unlink|rmdir)\s*\(|Path\([^)]*\)\.unlink\(|\.rmtree\(/i, why: 'Python 删除文件' },
  { re: /\.ssh\b|id_rsa|id_ed25519|authorized_keys|known_hosts/i, why: '读取 SSH 密钥' },
  { re: /\b(credential|credentials|passwd|keychain|cookies?\.sqlite|Login Data)\b/i, why: '读取登录凭据' },
  { re: /requests\.(post|put)\s*\(|urllib\.request\.urlopen\([^)]*data=|Invoke-WebRequest\b[^\n]*-Method\s+(Post|Put)|\bcurl\b[^\n]*\s(-T|--upload-file|-F|--form|-d|--data)\b/i, why: '向外上传数据' },
  { re: /\breg\s+(add|delete)\b|Set-ItemProperty\s+[^\n]*HK(LM|CU)|\bformat\s+[a-z]:|\bdiskpart\b|\bbcdedit\b/i, why: '修改系统设置' },
  { re: /\bgit\s+push\b[^\n]*(--force|-f\b)|\bgit\s+reset\s+--hard\s+origin/i, why: '强推或重置远端' },
];

function scanProposal(p) {
  const text = [p?.markdown, p?.spec, p?.plan].filter(s => typeof s === 'string').join('\n');
  const hits = [];
  for (const rule of RULES) {
    const m = text.match(rule.re);
    if (m && !hits.some(h => h.why === rule.why)) hits.push({ why: rule.why, sample: m[0].slice(0, 80) });
  }
  return hits;
}

module.exports = { scanProposal, RULES };
