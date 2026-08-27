'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { isBlockingModalOpen, isElementOpen } = require('../renderer/modal-layer-guard.js');

function element(id, { display = '', hiddenClass = false, connected = true } = {}) {
  return {
    id,
    hidden: false,
    isConnected: connected,
    style: { display },
    classList: { contains: name => name === 'hidden' && hiddenClass },
  };
}

test('legacy and aria modals share one visibility decision', () => {
  const config = element('config-modal');
  const hiddenSearch = element('search-modal', { display: 'none' });
  const dynamic = element('dynamic-modal');
  const byId = new Map([[config.id, config], [hiddenSearch.id, hiddenSearch]]);
  const documentRef = {
    getElementById: id => byId.get(id) || null,
    querySelectorAll: () => [dynamic],
  };
  assert.equal(isElementOpen(hiddenSearch), false);
  assert.equal(isBlockingModalOpen(documentRef), true);
  assert.equal(isBlockingModalOpen(documentRef, { exceptIds: ['config-modal', 'dynamic-modal'] }), false);
});

test('detached or hidden modal nodes never block shortcuts', () => {
  const detached = element('config-modal', { connected: false });
  const hidden = element('memory-panel', { hiddenClass: true });
  const documentRef = {
    getElementById: id => id === detached.id ? detached : id === hidden.id ? hidden : null,
    querySelectorAll: () => [],
  };
  assert.equal(isBlockingModalOpen(documentRef), false);
});

test('modal descendants inherit hidden ancestors and excepted modal roots', () => {
  const outer = element('preview-quick-open', { display: 'none' });
  const inner = element('');
  inner.parentElement = outer;
  const documentRef = {
    getElementById: id => id === outer.id ? outer : null,
    querySelectorAll: () => [inner],
  };
  assert.equal(isBlockingModalOpen(documentRef), false);
  outer.style.display = 'flex';
  assert.equal(isBlockingModalOpen(documentRef), true);
  assert.equal(isBlockingModalOpen(documentRef, { exceptIds: ['preview-quick-open'] }), false);
});
