'use strict';
// Current acceptance lives in the A sidebar suite; shared account fixtures remain
// in helpers/usage-refresh-fixture.js. The former ring has moved to the sidebar.
require('./e2e-sidebar-quota-cdp').run().catch(error => {
  console.error(error); process.exitCode = 1;
});
