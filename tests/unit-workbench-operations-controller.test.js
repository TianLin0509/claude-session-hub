'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createWorkbenchOperationsController } = require('../renderer/workbench-operations-controller.js');

test('a forced refresh queued behind startup refresh scans hydrated workspaces again', async () => {
  let resolveStartup;
  let calls = 0;
  const controller = createWorkbenchOperationsController({
    document: {
      activeElement: null,
      getElementById: () => null,
      querySelectorAll: () => [],
    },
    ipcRenderer: {
      invoke: async channel => {
        assert.equal(channel, 'workbench:get-overview');
        calls += 1;
        if (calls === 1) return new Promise(resolve => { resolveStartup = resolve; });
        return { repos: [], scanErrors: [], summary: { files: 2, scanErrors: 0 } };
      },
    },
  });

  const startup = controller.refresh(false);
  const hydrated = controller.refresh(true);
  resolveStartup({ repos: [], scanErrors: [], summary: { files: 0, scanErrors: 0 } });
  await startup;
  const hydratedResult = await hydrated;

  assert.equal(calls, 2);
  assert.equal(hydratedResult.summary.files, 2);
  assert.equal(controller.getSnapshot().summary.files, 2);
});
