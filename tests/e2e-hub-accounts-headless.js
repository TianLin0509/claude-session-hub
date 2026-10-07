'use strict';
// Real Chrome and real profile persistence; website contents are local deterministic fixtures.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), assert = require('node:assert/strict');
const { HubChrome } = require('../core/hub-chrome');
const { CDP } = require('../core/web-roundtable/cdp');
const { acquire } = require('../core/web-roundtable/store');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-headless-'));
const out = path.resolve('artifacts/accounts-headless'); fs.mkdirSync(out, { recursive: true });
try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
(async () => {
  const server = http.createServer((_req, res) => res.end('<html><button data-testid="user-avatar">Fixture user</button></html>'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port;
  const hub = new HubChrome({ root, env: { ...process.env, HUB_CHROME_ROOT: root } });
  hub.inspectionOwner = true;
  const release = acquire('account-check', path.join(root, 'locks'));
  const evidence = { passed: false, root, checks: [] };
  try {
    for (const identity of ['main', 'alt']) {
      const ep = await hub.ensure({ headless: true, identityId: identity });
      assert.equal(ep.headless, true, 'actual browser UA proves headless mode');
      const cdp = await CDP.connect(ep.ws, ep.port);
      const mark = await hub.marker(identity, cdp); cdp.close();
      const marker = await hub.page(mark.targetId);
      const cookies = (await marker.call('Network.getCookies', { urls: [url] })).cookies;
      assert.equal(cookies.length, 0, 'profiles do not share the other account cookie');
      await marker.call('Network.setCookie', { url, name: 'fixture_identity', value: identity, expires: Date.now() / 1000 + 3600 }); marker.close();
      const realSite = hub.site.bind(hub); hub.site = key => key === 'deepseek' ? { name: 'Fixture', url } : realSite(key);
      const result = await hub.liveStatus(identity, 'deepseek', { timeoutMs: 5000 });
      assert.equal(result.state, 'signed_in');
      hub.site = realSite;
      await assert.rejects(new HubChrome({ root }).waitForCheck(1000), /没有及时让出/);
      assert.equal(await hub.closeIfIdle(), true);
      assert.equal(await hub.running(), false);
      evidence.checks.push(identity + ': headless confirmed, correct isolated cookie jar, probe completed, resources released');
    }
    evidence.passed = true;
  } catch (e) { evidence.error = e.stack; throw e; }
  finally { await hub.close(); release(); server.close(); fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(evidence, null, 2)); }
  console.log(JSON.stringify(evidence, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; });
