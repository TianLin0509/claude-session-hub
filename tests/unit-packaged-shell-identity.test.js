'use strict';
// 安装版的任务栏身份（2026-10-09 公司真机：任务栏图标是白色文档）。
//   1. 开始菜单快捷方式的图标不能指向 app.asar 里的 .ico：Hub 读得到，Windows 资源管理器读不到，
//      显示成白色文档。安装版改用 exe 自己内嵌的图标，并且不做运行时 exe 品牌化（打包时已做）。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
assert.match(main, /const hubIconPath = HUB_IS_PACKAGED \? process\.execPath : path\.join\(__dirname, 'claude-wx\.ico'\);/,
  '安装版快捷方式图标用 exe 内嵌图标');
assert.match(main, /const brandingState = HUB_IS_PACKAGED \? \{ healthy: true \} : describeBrandingHealth\(brandingOptions\);/,
  '安装版不做运行时品牌化');
assert.match(main, /startShellIntegration\(HUB_IS_PACKAGED \? process\.execPath : resolveHubLaunchExePath\(brandingOptions\)\)/,
  '安装版快捷方式指向自己的 exe');

// 社区 / 公司版的 AUMID 与快捷方式名由导出脚本的文本替换给出（com.ai-hub.community / AI Hub Community.lnk），
// 与主 Hub 互不干扰；这里不重复验证。

console.log('unit-packaged-shell-identity: OK');
