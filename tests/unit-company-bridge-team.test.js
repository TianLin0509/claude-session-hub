'use strict';
// 特战队团队入口（2026-10-18）：邀请码、通道地址优先级、组长管理成员、团队版 skill 只新增不覆盖。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeInvite, parseInvite, TeamAdmin } = require('../core/company-bridge/team-link');
const { installTeamSkills, MARK } = require('../core/company-bridge/team-skills');
const { parsePairingCode } = require('../core/company-bridge/crypto');
const { rig, pair } = require('./helpers/company-bridge-rig');

const KEY = 'k'.repeat(43);
const TEAM_URL = `https://relay.example.test/hub-link/${KEY}/api`;
const tmpDir = (t, prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test('邀请码：往返、只认团队入口地址、错贴配对码有明确提示', () => {
  const code = makeInvite(TEAM_URL, '同事');
  assert.match(code, /^AIHUB-TZ-1\./);
  assert.deepEqual(parseInvite('前后有字也行 ' + code + ' \n'), { url: TEAM_URL, label: '同事' });
  assert.throws(() => makeInvite('https://relay.example.test/drop/tok/api', 'x'), /不是团队入口/);
  assert.throws(() => makeInvite(`http://relay.example.test/hub-link/${KEY}/api`, 'x'), /https/);
  assert.throws(() => parseInvite('AIHUB-LINK-1.abcdefghijklmnopqrstuvwxyz'), /这是配对码/);
  assert.throws(() => parseInvite('随便一段字'), /AIHUB-TZ-1/);
  assert.throws(() => parseInvite(code.slice(0, 60)), /不完整/);
  const bad = 'AIHUB-TZ-1.' + Buffer.from(JSON.stringify({ u: 'https://relay.example.test/drop/tok/api' })).toString('base64url');
  assert.throws(() => parseInvite(bad), /通道地址不对/);
});

test('同事电脑：没有收件箱时先要邀请码；保存后配对码带团队入口地址、默认挂给所有会话', async t => {
  const home = tmpDir(t, 'hub-team-home-');
  const r = rig(t, { homeDeps: { relayBaseUrl: () => null, homeDir: home } });
  let st = r.home.status();
  assert.equal(st.team.needsInvite, true);
  assert.equal(st.team.inbox, false);
  assert.equal(st.settings.attach, 'wireless');
  assert.throws(() => r.home.createPairing(), /先粘贴组长发的邀请码/);
  st = r.home.setInvite(makeInvite(TEAM_URL, '同事'));
  assert.equal(st.team.needsInvite, false);
  assert.deepEqual(st.team.invite, { label: '同事', host: 'relay.example.test', savedAt: r.clock.now });
  assert.equal(st.settings.attach, 'all');
  assert.ok(!st.baseUrl.includes(KEY), '状态里不露钥匙');
  const { code } = r.home.createPairing();
  assert.equal(parsePairingCode(code).baseUrl, TEAM_URL);
  // 换邀请码要先取消配对码；同一个邀请码重贴不报错
  assert.throws(() => r.home.setInvite(makeInvite(`https://relay.example.test/hub-link/${'z'.repeat(43)}/api`, '另一个')), /先解除配对/);
  r.home.setInvite(makeInvite(TEAM_URL, '同事'));
  assert.throws(() => r.home.clearInvite(), /先解除配对/);
  r.home.unpair();
  assert.equal(r.home.clearInvite().team.needsInvite, true);
  // 手动选过挂载范围的，以手动为准
  r.home.setSettings({ attach: 'wireless' });
  r.home.setInvite(makeInvite(TEAM_URL, '同事'));
  assert.equal(r.home.status().settings.attach, 'wireless');
});

test('同事电脑：经团队入口地址完成配对，公司一端不用改', async t => {
  const home = tmpDir(t, 'hub-team-home-');
  const r = rig(t, { homeDeps: { relayBaseUrl: () => null, homeDir: home } });
  const seen = [];
  const fetch0 = r.relay.fetch;
  r.relay.fetch = async (url, init) => { seen.push(new URL(url).pathname); return fetch0(url, init); };
  r.home.link.fetchImpl = r.relay.fetch; r.company.link.fetchImpl = r.relay.fetch;
  r.home.setInvite(makeInvite(TEAM_URL, '同事'));
  await pair(r);
  assert.ok(seen.length > 0 && seen.every(p => p.startsWith(`/hub-link/${KEY}/api/bridge/`)), '两端都走团队入口');
  assert.equal(r.company.link.config().baseUrl, TEAM_URL);
});

test('组长电脑：有收件箱配置时照旧，不装团队 skill', async t => {
  const home = tmpDir(t, 'hub-team-home-');
  const r = rig(t, { homeDeps: { homeDir: home } });
  const st = r.home.status();
  assert.equal(st.team.needsInvite, false);
  assert.equal(st.team.inbox, true);
  assert.equal(st.team.invite, null);
  assert.equal(st.baseUrl, 'https://relay.example.test/drop/tok/api');
  assert.equal(r.home.installSkills(), null);
  assert.equal(fs.existsSync(path.join(home, '.claude')), false);
});

test('团队版 skill：装到两处；没改过的随 Hub 升级；改过的和别人的同名 skill 原样保留', t => {
  const home = tmpDir(t, 'hub-team-skill-home-');
  const src = tmpDir(t, 'hub-team-skill-src-');
  fs.mkdirSync(path.join(src, 'tezhan-ask-company'));
  fs.mkdirSync(path.join(src, 'other-skill'));
  fs.writeFileSync(path.join(src, 'tezhan-ask-company', 'SKILL.md'), 'v1\n');
  fs.writeFileSync(path.join(src, 'other-skill', 'SKILL.md'), 'mine?\n');
  // 用户自己已有一个同名的 other-skill（不是 Hub 装的）
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'other-skill'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'other-skill', 'SKILL.md'), '用户自己的\n');

  let r = installTeamSkills({ homeDir: home, sourceRoot: src });
  assert.deepEqual(r.installed.sort(), [path.join('.agents', 'skills', 'other-skill'), path.join('.agents', 'skills', 'tezhan-ask-company'), path.join('.claude', 'skills', 'tezhan-ask-company')].sort());
  assert.deepEqual(r.kept, [path.join('.claude', 'skills', 'other-skill')]);
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'skills', 'other-skill', 'SKILL.md'), 'utf8'), '用户自己的\n');
  assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'tezhan-ask-company', MARK)));

  r = installTeamSkills({ homeDir: home, sourceRoot: src });
  assert.equal(r.installed.length + r.updated.length, 0);

  // Hub 升级带来 v2：没改过的两处都升级；用户改过 .agents 那份后就不再碰
  fs.writeFileSync(path.join(home, '.agents', 'skills', 'tezhan-ask-company', 'SKILL.md'), 'v1 + 我的批注\n');
  fs.writeFileSync(path.join(src, 'tezhan-ask-company', 'SKILL.md'), 'v2\n');
  r = installTeamSkills({ homeDir: home, sourceRoot: src });
  assert.deepEqual(r.updated, [path.join('.claude', 'skills', 'tezhan-ask-company')]);
  assert.ok(r.kept.includes(path.join('.agents', 'skills', 'tezhan-ask-company')));
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'skills', 'tezhan-ask-company', 'SKILL.md'), 'utf8'), 'v2\n');
  assert.equal(fs.readFileSync(path.join(home, '.agents', 'skills', 'tezhan-ask-company', 'SKILL.md'), 'utf8'), 'v1 + 我的批注\n');
});

test('随 Hub 打包的团队版 skill：有 frontmatter、不提组长个人项目', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'core', 'company-bridge', 'team-skills', 'tezhan-ask-company', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(text, /^---\nname: tezhan-ask-company\ndescription: .+\n---\n/);
  assert.doesNotMatch(text, /SuperRAN|AirView|田哥|airview-company-dev/);
});

test('邀请码保存后 Hub 装上团队 skill，并记在状态里', async t => {
  const home = tmpDir(t, 'hub-team-home-');
  const r = rig(t, { homeDeps: { relayBaseUrl: () => null, homeDir: home } });
  const st = r.home.setInvite(makeInvite(TEAM_URL, '同事'));
  assert.equal(st.team.skills.installed.length, 2);
  assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'tezhan-ask-company', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(home, '.agents', 'skills', 'tezhan-ask-company', 'SKILL.md')));
  assert.doesNotMatch(fs.readFileSync(path.join(home, '.claude', 'skills', 'tezhan-ask-company', 'SKILL.md'), 'utf8'), /\r/, '装出来的统一是 LF');
  // 同事自己删掉 Claude 那份：Hub 重启后不再装回去，Codex 那份照旧
  fs.rmSync(path.join(home, '.claude', 'skills', 'tezhan-ask-company'), { recursive: true, force: true });
  const again = r.home.installSkills();
  assert.deepEqual(again.removed, [path.join('.claude', 'skills', 'tezhan-ask-company')]);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'skills', 'tezhan-ask-company')), false);
  assert.ok(fs.existsSync(path.join(home, '.agents', 'skills', 'tezhan-ask-company', 'SKILL.md')));
  assert.equal(r.home.installSkills().removed.length, 1, '之后每次都记得');
});

test('组长管理成员：带口令调管理接口，新建得到可用的邀请码，收回校验编号', async t => {
  const calls = [];
  const json = body => ({ ok: true, status: 200, type: 'basic', headers: { get: () => 'application/json' }, text: async () => JSON.stringify(body) });
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method, auth: init.headers?.Authorization, body: init.body });
    if (url.endsWith('/members') && init.method === 'POST') return json({ ok: true, member: { id: 'm0123abcd', label: JSON.parse(init.body).label }, key: KEY });
    if (url.endsWith('/members')) return json({ ok: true, members: [{ id: 'm0123abcd', label: '同事' }] });
    return json({ ok: true, member: { id: 'm0123abcd', revoked_at: '2026-10-18T12:00:00Z' } });
  };
  const none = new TeamAdmin({ teamAdmin: () => null, fetchImpl });
  assert.equal(none.available(), false);
  await assert.rejects(none.members(), /管理口令/);
  const admin = new TeamAdmin({ teamAdmin: () => ({ apiUrl: 'https://relay.example.test/hub-link-admin/api', origin: 'https://relay.example.test', token: 'T0KEN' }), fetchImpl });
  assert.equal(admin.available(), true);
  const created = await admin.create(' 同事 ');
  assert.deepEqual(parseInvite(created.invite), { url: TEAM_URL, label: '同事' });
  assert.equal(calls[0].auth, 'Bearer T0KEN');
  assert.equal(calls[0].url, 'https://relay.example.test/hub-link-admin/api/members');
  assert.equal((await admin.members()).length, 1);
  await assert.rejects(admin.revoke('../x'), /成员编号无效/);
  assert.ok((await admin.revoke('m0123abcd')).revoked_at);
  assert.equal(calls.at(-1).url, 'https://relay.example.test/hub-link-admin/api/members/m0123abcd/revoke');
});
