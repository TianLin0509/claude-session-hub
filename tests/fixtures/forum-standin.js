'use strict';
// 两个假的公司论坛站（「论坛」页端到端用，tests/e2e-company-forum-real.js）：都是前端渲染的单页应用，数据从 JSON 接口取，
// 接口路径和字段照公司真机回执 Q-1018-01 第 2 轮：
//   稼先：要登录（没登录接口回 401、页面跳到 /login 的「账号登录」页，测兜底的登录窗口）；首页 /?menuKey=hot 是热点页，
//         同时取推荐流 djx/home/recommendations/query、热门话题 jxhome/hot/topics/list（话题里套帖子）和本周热榜
//         jxhome/homeHotResources（result.dataList）；帖子详情 /community/comgroup/postsDetails?postId=…，正文走 /jxService/v1/post/query/<id>。
//   心声：不用登录；首页 /next/index/#/home 的两块排行来自卡片接口 /xsrecommend/user/v1/cards/recommends/home/right（data[4]、data[5]，
//         每条只有 postId、title、link），页面上的条目是点击跳转、没有链接；详情 /next/detail/#/index?uuid=…，数字在 /xsapi/user/posts/<id>。
// 帖子都是占位内容。log 记下每个请求（路径和有没有登录），测试据此核对。
const http = require('node:http');

const hot = [...Array(8)].map((_, i) => ({ resourceId: 'jx' + (101 + i), title: ['关于新一代基站功耗优化的讨论', '大模型辅助研发流程的三点体会', '新员工入职第一年的成长复盘', '跨部门协作中最容易踩的坑',
  '仿真平台提速经验分享', '一次线上故障的复盘与反思', '如何写好一页纸方案', '读书会：系统思考'][i], browseCount: 9000 - i * 700, commentCount: 120 - i * 9, favoriteCount: 40 - i * 3, upvoteCount: 30 - i, createTime: Date.now() - (i + 1) * 3600000, submitUsers: [{ userNameCn: '作者' + (i + 1) }], resourceType: 'post' }));
const recommend = [...Array(5)].map((_, i) => ({ id: 'rc' + i, title: '推荐流里的普通帖子第' + (i + 1) + '篇', browseCount: 50 }));
const topics = [...Array(3)].map((_, i) => ({ tag: '话题' + i, tagId: i, resourceList: [...Array(3)].map((__, k) => ({ resourceId: 'tp' + i + k, title: '热门话题里的帖子' + i + k })) }));
const click = [...Array(10)].map((_, i) => ({ postId: 'xs' + (901 + i), title: ['公司食堂新菜单意见征集', '园区班车调整说明讨论', '老员工谈二十年变化', '年度优秀团队风采', '关于加班文化的看法',
  '新园区健身房开放了', '摄影大赛作品展', '年轻人怎么规划职业', '家属开放日回顾', '一线工程师的海外故事'][i] }));
const reply = click.slice(0, 6).map((_, i) => click[(i * 3) % 10]);
const counts = id => { const i = click.findIndex(x => x.postId === id); return { readCount: 30000 - i * 2500, replyCount: 300 - i * 20, likeCount: 50 - i }; };
const card = (title, list) => ({ id: 'card-' + title, cardType: 'HOT_LIST', title, hideTitle: false, link: '/more', resourceType: 'post',
  list: list.map(x => ({ postId: x.postId, title: x.title, link: '/next/detail/#/index?uuid=' + x.postId + '&uniqueType=homeRanking' })) });
const right = [card('公司人最新文章', click.slice(6)), card('公司人热门文章', click.slice(3, 6)), card('管理优化最新', click.slice(0, 3)), card('管理优化热门', click.slice(2, 5)),
  card('24小时点击排行', click), card('24小时回复排行', reply)];
const body = (title, n) => `${title}。` + '这是一段占位正文，用来模拟帖子详情页的内容，讲述背景、做法和结论，还有大家在评论区里的不同看法。'.repeat(n);

const shell = (title, script) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font:14px sans-serif;margin:20px}a{display:block;margin:4px 0}</style></head><body><div id="app">加载中…</div><script>${script}</script></body></html>`;

const JX_APP = `
(async () => {
  const app = document.getElementById('app');
  const j = async u => (await fetch(u, { credentials: 'include' })).json();
  const me = await j('/jxService/v1/user/current');
  if (me.status === 'error') { location.href = '/login?redirect=' + encodeURIComponent(location.pathname + location.search); return; }
  const detail = new URLSearchParams(location.search).get('postId');
  if (location.pathname.includes('postsDetails') && detail) {
    await new Promise(r => setTimeout(r, 600));
    const d = await j('/jxService/v1/post/query/' + encodeURIComponent(detail));
    app.innerHTML = '<header><a href="/">稼先社区首页</a></header><article><h1></h1><div class="content"></div></article><aside>相关推荐</aside>';
    app.querySelector('h1').textContent = d.data.title; app.querySelector('.content').textContent = d.data.content;
    return;
  }
  app.innerHTML = '<nav><span class="tab" id="t-rec">推荐</span> <span class="tab" id="t-hot">热点</span> <span class="tab">稼问</span></nav><div id="list"></div><footer>版权所有</footer>';
  const list = document.getElementById('list');
  // 条目是点击跳转（Vue 写法），页面上没有帖子链接
  const render = items => { list.innerHTML = ''; for (const p of items) { const d = document.createElement('div'); d.className = 'item'; d.textContent = p.title + '  ' + (p.browseCount || 0) + ' ' + (p.commentCount || 0); d.onclick = () => { location.href = '/community/comgroup/postsDetails?postId=' + (p.resourceId || p.id) + '&noTop=true&type=freePost'; }; list.append(d); } };
  // 单页应用渲染慢：推荐流、热门话题、热榜陆续到
  await new Promise(r => setTimeout(r, 1200));
  const rec = j('/jxService/v1/djx/home/recommendations/query'), tp = j('/jxService/v1/jxhome/hot/topics/list');
  const showHot = async () => render((await j('/jxService/v1/jxhome/homeHotResources?type=hotRecommend_1Week&pageNo=1&pageSize=20')).result.dataList);
  await rec; await tp;
  if (new URLSearchParams(location.search).get('menuKey') === 'hot') await showHot(); else render((await rec).result);
  document.getElementById('t-hot').onclick = () => { void showHot(); };
})();`;
const JX_LOGIN = `
document.getElementById('app').innerHTML = '<h2>账号登录</h2><p>扫码登录 · 密码登录</p><input placeholder="请输入账号"><input type="password" placeholder="密码"><button id="go">登录</button><a href="#">忘记密码</a>';
document.getElementById('go').onclick = async () => { await fetch('/login', { method: 'POST', credentials: 'include' }); location.href = new URLSearchParams(location.search).get('redirect') || '/'; };`;
const XS_APP = `
(async () => {
  const app = document.getElementById('app');
  const j = async u => (await fetch(u)).json();
  const route = () => {
    const uuid = /[?&]uuid=([\\w-]+)/.exec(location.hash);
    if (location.pathname.startsWith('/next/detail') && uuid) return j('/xsapi/user/posts/' + uuid[1]).then(d => { app.innerHTML = '<a href="/next/index/#/home">心声首页</a><h1></h1><div class="post"></div><div class="side">相关推荐</div>'; app.querySelector('h1').textContent = d.data.title; app.querySelector('.post').textContent = d.data.content; });
    app.innerHTML = '<div class="nav">公司家事 公司文件 七彩生活</div><div class="box"><h3>24小时点击排行</h3><ul id="click"></ul></div><div class="box"><h3>24小时回复排行</h3><ul id="reply"></ul></div>';
    // 条目是点击跳转（Vue 写法），没有链接
    const fill = (id, card) => { const ul = document.getElementById(id); for (const r of card.list) { const li = document.createElement('li'); li.textContent = r.title; li.onclick = () => { location.href = r.link; }; ul.append(li); } };
    return Promise.all([j('/xsrecommend/user/v1/cards/recommends/home/right'), j('/xsrecommend/user/v1/cards/recommends/home/left')]).then(([r]) => { fill('click', r.data[4]); fill('reply', r.data[5]); });
  };
  window.addEventListener('hashchange', route);
  await new Promise(r => setTimeout(r, 800));
  await route();
})();`;

function startForumStandin() {
  const log = [];
  const send = (res, code, type, text, headers = {}) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers }); res.end(text); };
  const json = (res, v, headers) => send(res, 200, 'application/json; charset=utf-8', JSON.stringify(v), headers);
  const jx = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), loggedIn = /(?:^|;\s*)sso=ok/.test(req.headers.cookie || '');
    log.push({ site: 'jx', path: u.pathname, loggedIn });
    if (u.pathname === '/login' && req.method === 'POST') return send(res, 200, 'text/plain', 'ok', { 'Set-Cookie': 'sso=ok; Path=/; HttpOnly' });
    if (u.pathname === '/login') return send(res, 200, 'text/html; charset=utf-8', shell('统一身份认证', JX_LOGIN));
    if (u.pathname.startsWith('/jxService/v1/')) {
      if (!loggedIn) return json(res, { error: { code: '401', reason: 'The user has not logged in.' }, status: 'error' });
      if (u.pathname.endsWith('/user/current')) return json(res, { status: 'ok', data: { name: '测试用户' } });
      if (u.pathname.includes('recommendations')) return json(res, { status: 'ok', result: recommend });
      if (u.pathname.endsWith('/jxhome/hot/topics/list')) return json(res, { status: 'ok', result: { expertList: topics } });
      if (u.pathname.endsWith('/jxhome/homeHotResources')) return json(res, { status: 'ok', result: { dataList: hot, total: hot.length } });
      if (u.pathname.startsWith('/jxService/v1/post/query/')) { const p = hot.find(x => x.resourceId === u.pathname.split('/').pop()) || hot[0]; return json(res, { status: 'ok', result: { title: p.title, content: body(p.title, 12) } }); }
      return json(res, { status: 'ok', data: {} });
    }
    return send(res, 200, 'text/html; charset=utf-8', shell('稼先社区', JX_APP));
  });
  const xs = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    log.push({ site: 'xinsheng', path: u.pathname });
    if (u.pathname === '/xsrecommend/user/v1/cards/recommends/home/right') return json(res, { status: '200', message: 'ok', data: right });
    if (u.pathname === '/xsrecommend/user/v1/cards/recommends/home/left') return json(res, { status: '200', message: 'ok', data: [card('左侧推荐', click.slice(0, 4))] });
    if (u.pathname.startsWith('/xsapi/user/posts/')) { const id = u.pathname.split('/').pop(), p = click.find(x => x.postId === id) || click[0]; return json(res, { status: '200', message: 'ok', data: { title: p.title, content: body(p.title, 10), ...counts(p.postId), createTime: Date.now() - 7200000 } }); }
    return send(res, 200, 'text/html; charset=utf-8', shell('心声社区', XS_APP));
  });
  const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + s.address().port)));
  return Promise.all([listen(jx), listen(xs)]).then(([jxBase, xsBase]) => ({ jxBase, xsBase, log, hot, click, reply,
    close: () => Promise.all([jx, xs].map(s => new Promise(r => { s.closeAllConnections?.(); s.close(() => r()); }))) }));
}

module.exports = { startForumStandin };
