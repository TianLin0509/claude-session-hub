'use strict';
const fs = require('node:fs');
const path = require('node:path');

let defaults = [];
// @community-strip 私人团队工具；公司发行目标通过独立 overlay 提供已批准入口。
defaults = [
  { id: 'tools', name: '团队工具台', url: 'https://me.lt-stockpartner.tech/tools/' },
  { id: 'captain', name: '管理晴雨表', url: 'https://me.lt-stockpartner.tech/captain/' },
  { id: 'weekly', name: '小组周报', url: 'https://ai.lt-stockpartner.tech/weekly/' },
  { id: 'ai-team', name: 'AI 特战队周报', url: 'https://ai.lt-stockpartner.tech/ai-team/ui/' },
  { id: 'reports', name: '周报中心', url: 'https://ai.lt-stockpartner.tech/reports/' },
  { id: 'style', name: '工作风格地图', url: 'https://me.lt-stockpartner.tech/style/' },
];
// @community-end

function toolsCatalog() {
  let list = defaults;
  const file = path.join(__dirname, 'sites.json');
  if (fs.existsSync(file)) list = JSON.parse(fs.readFileSync(file, 'utf8'));
  return list.filter(item => {
    try { const u = new URL(item.url); return /^[a-z-]{1,30}$/.test(item.id) && u.protocol === 'https:' && !u.username && !u.password; }
    catch { return false; }
  }).map(item => Object.freeze({ id: item.id, name: item.name, url: item.url }));
}
function teamEnabled(env = process.env, distribution = require('../distribution')) {
  if (env.CLAUDE_HUB_E2E === '1' && env.CLAUDE_HUB_DATA_DIR && env.CLAUDE_HUB_TEAM === '1') return true;
  return distribution.personalModules || (distribution.target === 'company' && distribution.featureEnabled('teamWorkspace'));
}
module.exports = { toolsCatalog, teamEnabled };
