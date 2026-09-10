'use strict';
const {createNativeRuntime}=require('../../core/codex-native-runtime');
// Explicit native state fixtures for consumer tests. No inference from screen,
// heartbeat, attention or raw session.status.
function nativeSnapshot(state, fields={}) {
  return {...createNativeRuntime(),connection:'connected',state,threadId:'thread-fixture',
    turnId:state === 'idle' ? null : 'turn-fixture',revision:1,reason:null,...fields};
}
module.exports={nativeSnapshot};
