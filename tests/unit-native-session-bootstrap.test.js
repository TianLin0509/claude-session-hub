'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createNativeSessionBootstrap} = require('../renderer/native-session-bootstrap');
const row = (epoch, revision, connection, extras = {}) => ({id:'a',runtimeBackend:'claude-stream-json',
  nativeRuntime:{epoch,revision,connection}, ...extras});

test('ready event before the initial list replaces its stale connecting snapshot', () => {
  const boot=createNativeSessionBootstrap();
  boot.record(row(3,2,'connected'));
  assert.equal(boot.merge(row(3,1,'connecting')).nativeRuntime.connection,'connected');
});
test('epoch and revision keep newer failures and connections authoritative', () => {
  const boot=createNativeSessionBootstrap();
  boot.record(row(4,1,'disconnected'));
  boot.record(row(3,100,'connected'));
  boot.record(row(4,0,'connecting'));
  assert.deepEqual(boot.merge(row(3,1,'connecting')).nativeRuntime,row(4,1,'disconnected').nativeRuntime);
});
test('an already registered session keeps newer runtime and local read acknowledgement', () => {
  const boot=createNativeSessionBootstrap();
  boot.record(row(2,4,'connected',{unreadCount:5}));
  const current=row(2,5,'disconnected',{unreadCount:0});
  const merged=boot.merge(row(2,1,'connecting',{title:'saved title'}),current);
  assert.equal(merged.nativeRuntime.connection,'disconnected');
  assert.equal(merged.unreadCount,0);assert.equal(merged.title,'saved title');
});
test('equal revision metadata updates are retained without regressing runtime', () => {
  const boot=createNativeSessionBootstrap();
  boot.record(row(2,4,'connected',{contextPct:20}));
  boot.record(row(2,4,'connected',{contextPct:30}));
  assert.equal(boot.merge(row(2,1,'connecting')).contextPct,30);
});

test('buffered updates preserve local UI fields when they advance an existing row', () => {
  const boot=createNativeSessionBootstrap();
  boot.record(row(2,4,'connected',{unreadCount:5}));
  const merged=boot.merge(row(2,1,'connecting'),row(2,2,'connecting',{
    unreadCount:0,_importedNativeDraft:'local draft',
  }));
  assert.equal(merged.nativeRuntime.connection,'connected');
  assert.equal(merged.unreadCount,0);
  assert.equal(merged._importedNativeDraft,'local draft');
});

test('the same ordering protects Codex native snapshots', () => {
  const boot=createNativeSessionBootstrap();
  boot.record(row(2,4,'connected',{runtimeBackend:'codex-app-server'}));
  const restored=boot.merge(row(2,1,'connecting',{runtimeBackend:'codex-app-server'}));
  assert.equal(restored.nativeRuntime.connection,'connected');
  assert.equal(restored.runtimeBackend,'codex-app-server');
});
test('close during initial loading cannot resurrect the session; explicit creation can reopen it', () => {
  const boot=createNativeSessionBootstrap();
  boot.record(row(2,4,'connected'));boot.remove('a');boot.record(row(2,5,'connected'));
  assert.equal(boot.merge(row(2,1,'connecting')),null);assert.equal(boot.removed('a'),true);
  boot.record(row(3,0,'connecting'),{created:true});
  assert.equal(boot.merge(row(2,1,'connecting')).nativeRuntime.epoch,3);
});
test('finish discards the temporary buffer and does not retain later events', () => {
  const boot=createNativeSessionBootstrap();boot.record(row(2,4,'connected'));boot.finish();
  boot.record(row(2,5,'connected'));boot.remove('a');
  assert.equal(boot.merge(row(2,1,'connecting')).nativeRuntime.connection,'connecting');
  assert.equal(boot.removed('a'),false);
});
