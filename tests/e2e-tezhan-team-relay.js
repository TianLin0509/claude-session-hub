'use strict';
// 特战队团队入口端到端（2026-10-18）：本机起真实的 relay_server.py，两组「家里 + 公司」经团队入口同时配对、往返，
// 核对互不串；收回其中一把钥匙后该组立即报错、另一组照常。不碰线上服务器。
// 跑法：node --test tests/e2e-tezhan-team-relay.js（通道服务位置用 TEZHAN_RELAY_SERVER 指定，默认组长本机 company-drop 目录）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { TeamAdmin } = require('../core/company-bridge/team-link');
const { rig, pair } = require('./helpers/company-bridge-rig');

const SERVER = process.env.TEZHAN_RELAY_SERVER || path.join(os.homedir(), 'company-drop', 'server', 'relay_server.py');
const ADMIN = 'e2e-admin-token-0123456789abcdefghij';

const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

async function startRelay(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tezhan-relay-'));
  fs.mkdirSync(path.join(root, 'team'));
  fs.writeFileSync(path.join(root, 'team', 'admin.json'), JSON.stringify({ token_sha256: createHash('sha256').update(ADMIN).digest('hex') }));
  const port = await freePort();
  const child = spawn(process.env.PYTHON || 'python', ['-u', SERVER, '--root', root, '--port', String(port)], { windowsHide: true, stdio: 'ignore' });
  t.after(() => { child.kill(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base + '/health')).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  return { base, root };
}

function member(t, relay, homeDir) {
  return rig(t, {
    homeDeps: { fetchImpl: fetch, relayBaseUrl: () => null, homeDir },
    companyDeps: { fetchImpl: fetch },
  });
}

test('两组同事经真实团队入口同时配对、往返，互不串；收回一把钥匙只影响他自己', { timeout: 60000 }, async t => {
  assert.ok(fs.existsSync(SERVER), '找不到 relay_server.py：' + SERVER);
  const relay = await startRelay(t);
  const admin = new TeamAdmin({ teamAdmin: () => ({ apiUrl: relay.base + '/hub-link-admin/api', origin: relay.base, token: ADMIN }), fetchImpl: fetch });
  const ia = await admin.create('同事甲');
  const ib = await admin.create('同事乙');
  const homes = [fs.mkdtempSync(path.join(os.tmpdir(), 'tezhan-a-')), fs.mkdtempSync(path.join(os.tmpdir(), 'tezhan-b-'))];
  t.after(() => homes.forEach(d => fs.rmSync(d, { recursive: true, force: true })));
  const A = member(t, relay, homes[0]), B = member(t, relay, homes[1]);
  A.home.setInvite(ia.invite); B.home.setInvite(ib.invite);
  await pair(A); await pair(B);

  // 各自的通道落在各自的成员目录里
  const dirs = id => fs.readdirSync(path.join(relay.root, 'team', id)).filter(n => /^[a-f0-9]{32}$/.test(n));
  assert.ok(dirs(ia.member.id).length >= 1 && dirs(ib.member.id).length >= 1);
  assert.equal(dirs(ia.member.id).filter(n => dirs(ib.member.id).includes(n)).length, 0, '两人没有共用通道');
  assert.deepEqual(fs.existsSync(path.join(relay.root, 'bridge')) ? fs.readdirSync(path.join(relay.root, 'bridge')) : [], [], '组长的旧通道目录里没有同事的消息');

  // 甲提问：只有甲的公司收到并作答，乙的公司什么都没收到
  A.hs.map.set('a-s1', { id: 'a-s1', kind: 'claude', status: 'idle', title: '甲的会话' });
  const asked = await A.home.invoke({ name: 'ask_company', callerSessionId: 'a-s1', arguments: { question: '## 目的\n核对一个参数\n## 问题\n1. 默认值是多少？', title: '甲的问题' } });
  await A.company.checkNow(); await B.company.checkNow();
  assert.equal(A.cs.created.length, 1);
  assert.equal(B.cs.created.length, 0, '乙的公司没有收到甲的问题');
  const sid = A.cs.created[0].opts.id;
  A.cs.finals.set(sid, [{ id: 'f1', text: '## 结论\n默认值 8。\n把握程度：高' }]);
  await A.company.checkNow();
  await A.home.checkNow(); await A.home.checkNow();
  assert.equal(A.hs.sent.length, 1);
  assert.match(A.hs.sent[0].text, new RegExp(`【公司回执 ${asked.thread} · 第 1 轮】[\\s\\S]*默认值 8`));
  await B.home.checkNow();
  assert.equal(B.hs.sent.length, 0);

  // 收回乙：乙两端立即报钥匙被收回；甲照常
  await admin.revoke(ib.member.id);
  await B.home.checkNow(); await B.company.checkNow();
  assert.match(B.home.status().net.lastError?.message || '', /已被收回/);
  assert.match(B.company.status().net.lastError?.message || '', /已被收回/);
  await A.home.checkNow();
  assert.equal(A.home.status().net.lastError, null);
  const list = await admin.members();
  assert.deepEqual(list.map(m => [m.label, !!m.revoked_at]), [['同事甲', false], ['同事乙', true]]);
});
