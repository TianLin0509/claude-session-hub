'use strict';
// 公司版「论坛」：站点地址、认热帖、摘要核对出处、同步与登录流程（core/company-forum/）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../core/company-forum/sites');
const X = require('../core/company-forum/extract');
const M = require('../core/company-forum/summary');
const { CompanyForum } = require('../core/company-forum/service');

const jx = S.siteById('jx'), xs = S.siteById('xinsheng');
const JX = 'https://jx.corp.example', XS = 'https://xinsheng.corp.example';

test('站点地址：域名取自公司邮箱；测试可指到本机假站点（必须有隔离数据目录）', () => {
  assert.equal(S.domainFromEmail('user001@Corp.Example'), 'corp.example');
  assert.equal(S.domainFromEmail('不是邮箱'), '');
  assert.equal(S.normalizeDomain('https://corp.example/path'), 'corp.example');
  assert.equal(S.normalizeDomain('乱填'), '');
  assert.deepEqual(S.siteBases('corp.example', {}), { jx: JX, xinsheng: XS });
  assert.deepEqual(S.siteBases('', {}), {});
  const env = { CLAUDE_HUB_FORUM_SITES: JSON.stringify({ jx: 'http://127.0.0.1:9/' }), CLAUDE_HUB_DATA_DIR: 'x' };
  assert.equal(S.siteBases('corp.example', env).jx, 'http://127.0.0.1:9');
  assert.equal(S.siteBases('corp.example', { CLAUDE_HUB_FORUM_SITES: env.CLAUDE_HUB_FORUM_SITES }).jx, JX, '没有隔离数据目录时不认测试开关');
  assert.equal(S.detailUrl(jx, JX, 'p1'), JX + '/community/comgroup/postsDetails?postId=p1&noTop=true&type=freePost');
});

test('数字与时间：1.2万、3k、4,432、秒/毫秒时间戳都认', () => {
  assert.equal(X.count('1.2万'), 12000);
  assert.equal(X.count('3k'), 3000);
  assert.equal(X.count('4,432'), 4432);
  assert.equal(X.count('很多'), null);
  assert.equal(X.timeOf(1760000000), 1760000000000);
  assert.equal(X.timeOf('2026-10-18 09:30'), Date.parse('2026-10-18T09:30'));
});

const jxCapture = () => ({
  finalUrl: JX + '/?_grapKey=abc',
  sections: [{ heading: '热点', found: true, links: [] }],
  links: [
    { href: '/community/comgroup/postsDetails?postId=101&noTop=true&type=freePost', text: '关于新一代基站功耗的讨论' },
    { href: '/community/comgroup/postsDetails?postId=102&noTop=true&type=freePost', text: '大模型落地研发流程的三点体会' },
    { href: '/community/comgroup/postsDetails?postId=103&noTop=true&type=freePost', text: '新员工入职第一年的成长复盘' },
    { href: '/about', text: '关于我们页面' },
  ],
  // 形状照公司真机回执 Q-1018-01 第 2 轮：推荐流、热门话题（卡片里套帖子）、本周热榜三个接口都会截到。
  json: [
    { url: JX + '/jxService/v1/djx/home/recommendations/query', json: { status: 'ok', result: [1, 2, 3].map(i => ({ id: 'r' + i, title: '推荐流里的普通帖子' + i, browseCount: 5 })) } },
    { url: JX + '/jxService/v1/jxhome/hot/topics/list', json: { status: 'ok', result: { expertList: [1, 2, 3].map(i => ({ tag: '话题' + i, tagId: i, resourceList: [1, 2, 3].map(k => ({ resourceId: 't' + i + k, title: '话题里的帖子标题' + i + k })) })) } } },
    { url: JX + '/jxService/v1/jxhome/homeHotResources?type=hotRecommend_1Week&pageNo=1&pageSize=20', json: { status: 'ok', result: { dataList: [
      { resourceId: '101', title: '关于新一代基站功耗的讨论', browseCount: 4432, commentCount: 86, favoriteCount: 33, upvoteCount: 12, createTime: '2026-10-17 10:00', submitUsers: [{ userNameCn: '作者甲' }] },
      { resourceId: '102', title: '大模型落地研发流程的三点体会', browseCount: '1.2万', commentCount: 120 },
      { resourceId: '103', title: '新员工入职第一年的成长复盘', browseCount: 900 },
    ] } } },
  ],
});

test('稼先：「热点」优先用像热榜的接口数据（顺序即站点排行），只有编号时按详情页格式补链接；接口没截到时用页面上的帖子链接', () => {
  const [hot] = X.postsForSite(jx, jxCapture(), { base: JX });
  assert.equal(hot.key, 'hot');
  assert.equal(hot.from, 'api');
  assert.deepEqual(hot.posts.map(p => p.id), ['101', '102', '103']);
  assert.equal(hot.posts[0].views, 4432);
  assert.equal(hot.posts[0].replies, 86);
  assert.equal(hot.posts[0].likes, 12);
  assert.equal(hot.posts[0].favs, 33);
  assert.equal(hot.posts[0].author, '作者甲');
  assert.equal(hot.posts[1].views, 12000);
  assert.equal(hot.posts[0].url, JX + '/community/comgroup/postsDetails?postId=101&noTop=true&type=freePost');
  assert.equal(hot.posts[2].rank, 3);
  const [fromLinks] = X.postsForSite(jx, { ...jxCapture(), json: [] }, { base: JX });
  assert.equal(fromLinks.from, 'page-links');
  assert.deepEqual(fromLinks.posts.map(p => p.id), ['101', '102', '103']);
  assert.equal(fromLinks.posts[0].views, null);
});

test('心声（真机形状）：两个排行是同一个卡片接口里的两张卡片，按榜名找卡片，不把卡片当帖子；数字从详情接口补', () => {
  const card = (title, ids) => ({ id: 'c-' + title, cardType: 'HOT_LIST', title, link: '/more', list: ids.map(i => ({ postId: 'u' + i, title: `心声排行里的帖子第${i}条`, link: `/next/detail/#/index?uuid=u${i}&uniqueType=homeRanking` })) });
  const right = { status: '200', message: 'ok', data: [card('公司人最新文章', [91, 92, 93]), card('公司人热门文章', [94, 95, 96]), card('管理优化最新', [97, 98, 99]), card('管理优化热门', [81, 82, 83]),
    card('24小时点击排行', [1, 2, 3, 4]), card('24小时回复排行', [5, 6, 7])] };
  const cap = { finalUrl: XS + '/next/index/#/home', links: [], sections: [{ heading: '24小时点击排行', found: true, links: [] }, { heading: '24小时回复排行', found: true, links: [] }],
    json: [{ url: XS + '/xsrecommend/user/v1/cards/recommends/home/right', json: right }] };
  const [click, reply] = X.postsForSite(xs, cap, { base: XS });
  assert.equal(click.from, 'api-card');
  assert.deepEqual(click.posts.map(p => p.id), ['u1', 'u2', 'u3', 'u4']);
  assert.deepEqual(reply.posts.map(p => p.id), ['u5', 'u6', 'u7']);
  assert.equal(click.posts[0].url, XS + '/next/detail/#/index?uuid=u1&uniqueType=homeRanking');
  assert.equal(X.postArrays(right).some(a => a.some(p => p.id === 'c-24小时点击排行')), false, '卡片本身不当帖子');
  assert.deepEqual(X.countsFromJson([{ status: '200', data: { title: 'x', readCount: 3200, replyCount: 45, likeCount: 9, createTime: 1760000000000 } }]), { views: 3200, replies: 45, likes: 9, time: 1760000000000 });
});

test('心声：页面上没有帖子链接时，按接口网址分出「24小时点击 / 24小时回复」两个榜；都没有时退到板块文字', () => {
  const item = (i, extra) => ({ tid: 't' + i, subject: `心声帖子标题第${i}条比较长`, ...extra });
  const cap = {
    finalUrl: XS + '/next/index/#/home',
    sections: [{ heading: '24小时点击排行', found: true, links: [] }, { heading: '24小时回复排行', found: true, links: [] }],
    links: [],
    json: [
      { url: XS + '/xsapi/v1/topic/clickRank', json: { data: [1, 2, 3, 4].map(i => item(i, { clickCount: 100 * i })) } },
      { url: XS + '/xsapi/v1/topic/replyRank', json: { data: [5, 6, 7].map(i => item(i, { replyCount: i })) } },
    ],
  };
  const [click, reply] = X.postsForSite(xs, cap, { base: XS });
  assert.equal(click.from, 'api');
  assert.deepEqual(click.posts.map(p => p.id), ['t1', 't2', 't3', 't4']);
  assert.equal(click.posts[1].views, 200);
  assert.deepEqual(reply.posts.map(p => p.id), ['t5', 't6', 't7']);
  assert.equal(reply.posts[0].replies, 5);

  const textOnly = { finalUrl: cap.finalUrl, links: [], json: [], sections: [
    { heading: '24小时点击排行', found: true, links: [], lines: ['1 第一条心声热帖的标题 1.2万', '2 第二条心声热帖的标题 800', '3 第三条心声热帖的标题', '查看更多'] },
    { heading: '24小时回复排行', found: false, links: [], lines: [] }] };
  const [c2, r2] = X.postsForSite(xs, textOnly, { base: XS });
  assert.equal(c2.from, 'text');
  assert.deepEqual(c2.posts.map(p => p.title), ['第一条心声热帖的标题', '第二条心声热帖的标题', '第三条心声热帖的标题']);
  assert.equal(c2.posts[0].url, '');
  assert.equal(r2.posts.length, 0);
});

test('登录页识别：跳到别的域名，或页面是登录表单', () => {
  assert.equal(X.looksLikeLogin({ finalUrl: 'https://login.corp.example/sso', text: '欢迎', textLength: 10 }, JX), true);
  assert.equal(X.looksLikeLogin({ finalUrl: JX + '/', text: '账号登录 扫码登录 忘记密码', textLength: 30 }, JX), true);
  assert.equal(X.looksLikeLogin({ finalUrl: JX + '/', text: '首页 热点 推荐 '.repeat(50), textLength: 3000 }, JX), false);
});

test('摘要：两站轮流挑帖子；AI 回来的条目对不上编号就删掉', () => {
  const snap = { sites: [
    { id: 'jx', name: '稼先社区', ok: true, lists: [{ label: '热点', posts: [{ title: 'A1' }, { title: 'A2' }, { title: 'A3' }] }] },
    { id: 'xinsheng', name: '心声社区', ok: true, lists: [{ label: '24小时点击', posts: [{ title: 'B1' }] }, { label: '24小时回复', posts: [{ title: 'B2' }, { title: 'B1' }] }] },
  ] };
  const picked = M.pickForSummary(snap, 4);
  assert.deepEqual(picked.map(x => x.source + ':' + x.post.title), ['P1:A1', 'P2:B1', 'P3:A2', 'P4:B2']);
  const prompt = M.summaryPrompt(picked, { day: '2026-10-18' });
  assert.match(prompt, /\[P2\] B1（心声社区 · 24小时点击）/);
  const reply = '好的\n```json\n{"overview":[{"text":"大家在聊功耗 [P1]","sources":["P1"]},{"text":"编的","sources":["P9"]}],"items":[{"source":"P1","summary":"讲功耗"},{"source":"P7","summary":"不存在"},{"source":"p2","summary":"讲心声"}]}\n```';
  const parsed = M.parseSummary(reply, picked);
  assert.deepEqual(parsed.items, { P1: '讲功耗', P2: '讲心声' });
  assert.deepEqual(parsed.overview, [{ text: '大家在聊功耗', sources: ['P1'] }]);
  assert.equal(parsed.dropped, 2);
  assert.equal(M.parseSummary('没有 JSON', picked), null);
  const leaky = M.parseSummary('{"overview":[{"text":"只有 P1、P3 讲了功耗 [P1]","sources":["P1"]}],"items":[]}', picked);
  assert.equal(leaky.overview[0].text, '只有讲了功耗', '句子里不留编号');
});

// ---- 服务：假浏览器 + 假 CodeAgent ----
function harness(t, { email = 'user001@corp.example', login = {}, now = new Date(2026, 9, 19, 8, 40).getTime() } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-forum-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const calls = [], prompts = [], finals = [];
  let clock = now;
  const needLogin = { ...login };
  const browser = {
    async capture({ url }) {
      calls.push(['capture', url]);
      if (url.startsWith(JX)) return needLogin.jx ? { finalUrl: 'https://login.corp.example/', text: '账号登录', textLength: 4, links: [], sections: [], json: [] } : jxCapture();
      return { finalUrl: url, links: [], json: [], sections: [{ heading: '24小时点击排行', found: true, links: [
        { href: XS + '/next/index/#/detail?tid=901', text: '心声第一热帖的标题' }, { href: XS + '/next/index/#/detail?tid=902', text: '心声第二热帖的标题' }, { href: XS + '/next/index/#/detail?tid=903', text: '心声第三热帖的标题' }] },
      { heading: '24小时回复排行', found: true, links: [] }] };
    },
    async detail({ url }) { calls.push(['detail', url]); return { text: '正文：' + url, textLength: 100 }; },
    async login({ url }) { calls.push(['login', url]); needLogin.jx = false; return { ok: true }; },
  };
  const sessions = new Map();
  const forum = new CompanyForum({
    dataDir, now: () => clock, noTimer: true, noCollect: true, browser, env: {},
    accountEmail: () => email,
    createSession: async (kind, opts) => { sessions.set(opts.id, { id: opts.id, kind, opts, status: 'idle' }); return { id: opts.id }; },
    getSession: id => sessions.get(id),
    sendPrompt: async (id, text) => { prompts.push(text); return { ok: true }; },
    readFinals: () => finals,
  });
  forum.start();
  return { forum, calls, prompts, finals, dataDir, sessions, tick: ms => { clock += ms; }, setNow: v => { clock = v; } };
}

test('同步：两站取热帖、读前几条正文、交给整理会话写摘要；摘要回来挂到帖子上，看点指回帖子', async t => {
  const h = harness(t);
  const snap = await h.forum.sync();
  assert.deepEqual(h.calls.filter(c => c[0] === 'capture').map(c => c[1]), [JX + '/?menuKey=hot', XS + '/next/index/#/home']);
  assert.deepEqual(snap.sites.map(s => [s.id, s.ok]), [['jx', true], ['xinsheng', true]]);
  assert.equal(snap.domain.from, 'email');
  assert.equal(h.calls.filter(c => c[0] === 'detail').length, 6, '默认前 10 条，两站共 6 条有链接');
  assert.match(snap.sites[0].lists[0].posts[0].excerpt, /正文：/);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0], /只依据提问里给出的帖子标题和正文摘录写/);
  assert.match(h.prompts[0], /\[P1\] 关于新一代基站功耗的讨论/);
  const session = [...h.sessions.values()][0];
  assert.equal(session.opts.purpose, 'company-forum');
  assert.equal(h.forum.status().snapshot.summarizing, true);
  h.finals.push({ id: 'f1', text: '{"overview":[{"text":"功耗和大模型最热","sources":["P1","P3"]}],"items":[{"source":"P1","summary":"讨论基站功耗"},{"source":"P2","summary":"心声第一"}]}' });
  await h.forum.collectJob();
  const done = h.forum.status().snapshot;
  assert.equal(done.summarizing, false);
  assert.equal(done.sites[0].lists[0].posts[0].summary, '讨论基站功耗');
  assert.equal(done.sites[1].lists[0].posts[0].summary, '心声第一');
  assert.deepEqual(done.overview[0].refs.map(r => r.title), ['关于新一代基站功耗的讨论', '大模型落地研发流程的三点体会']);
  assert.equal(h.forum.allowedUrl(JX + '/community/x'), true);
  assert.equal(h.forum.allowedUrl('https://evil.example/'), false);
  assert.equal(h.forum.allowedUrl('file:///C:/x'), false);
});

test('没登录：那一栏提示登录；点登录后只重新同步这个站，另一个站沿用', async t => {
  const h = harness(t, { login: { jx: true } });
  const snap = await h.forum.sync();
  const jxEntry = snap.sites.find(s => s.id === 'jx');
  assert.equal(jxEntry.needsLogin, true);
  assert.match(jxEntry.error, /需要登录/);
  assert.equal(snap.sites.find(s => s.id === 'xinsheng').ok, true);
  h.calls.length = 0;
  const r = await h.forum.login('jx');
  assert.equal(r.state, 'waiting');
  await new Promise(r2 => setTimeout(r2, 20));
  while (h.forum.syncing) await h.forum.syncing;
  assert.deepEqual(h.calls.filter(c => c[0] !== 'detail').map(c => c[0] + ' ' + c[1]), ['login ' + JX + '/?menuKey=hot', 'capture ' + JX + '/?menuKey=hot']);
  const after = h.forum.status().snapshot;
  assert.equal(after.sites.find(s => s.id === 'jx').ok, true);
  assert.equal(h.forum.status().sites.find(s => s.id === 'jx').login, 'ok');
});

test('不知道域名：不打开任何网页，提示去设置里填；填了就能同步', async t => {
  const h = harness(t, { email: '' });
  const snap = await h.forum.sync();
  assert.equal(h.calls.length, 0);
  assert.match(snap.sites[0].error, /设置/);
  assert.throws(() => h.forum.setSettings({ domain: '乱填' }), /域名格式/);
  h.forum.setSettings({ domain: 'corp.example' });
  assert.equal(h.forum.status().domainFrom, 'settings');
  const again = await h.forum.sync();
  assert.equal(again.sites[0].ok, true);
});

test('定时：工作日到点且当天没同步才同步；有站点失败 30 分钟后重试', async t => {
  const h = harness(t, { login: { jx: true }, now: new Date(2026, 9, 19, 8, 0).getTime() }); // 周一 08:00
  await h.forum.tick();
  assert.equal(h.calls.length, 0, '还没到 08:30');
  h.setNow(new Date(2026, 9, 19, 8, 31).getTime());
  await h.forum.tick();
  assert.equal(h.calls.filter(c => c[0] === 'capture').length, 2);
  h.calls.length = 0;
  h.tick(10 * 60000);
  await h.forum.tick();
  assert.equal(h.calls.length, 0, '10 分钟内不重试');
  h.tick(25 * 60000);
  await h.forum.tick();
  assert.equal(h.calls.filter(c => c[0] === 'capture').length, 2, '稼先没登录，30 分钟后再试');
  h.setNow(new Date(2026, 9, 18, 9, 0).getTime()); // 周日
  h.calls.length = 0;
  fs.rmSync(path.join(h.dataDir, 'company-forum', 'forum-2026-10-18.json'), { force: true });
  await h.forum.tick();
  assert.equal(h.calls.length, 0, '周末不自动同步');
});

test('关掉定时同步（CLAUDE_HUB_FORUM_TIMER=0）时，收 AI 回答的循环照样跑', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-forum-'));
  const forum = new CompanyForum({ dataDir, noTimer: true, getSession: () => null });
  forum.start();
  t.after(() => { forum.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  assert.equal(forum.timers.length, 1, '只剩收回答的那个循环');
});

test('整理会话不挂 Hub 的 MCP、不挂「问家里」', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');
  assert.match(src, /\['company-bridge', 'company-assistant', 'company-forum'\]\.includes\(opts\.purpose\)/);
  const home = fs.readFileSync(path.join(__dirname, '..', 'core', 'company-bridge', 'ask-home.js'), 'utf8');
  assert.match(home, /opts\.purpose === 'company-forum'/);
});
