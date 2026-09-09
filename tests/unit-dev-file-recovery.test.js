'use strict';
const assert = require('node:assert/strict');
const { createLoopEngine } = require('../main/groupchat/loop-engine');
async function run() {
  const meeting = { id: 'room', scene: 'dev', groupChat: true, subSessions: ['s1'], slotSpecs: [{memberId:'m1'}], serialWorkflow: {fileFlowVersion:2} };
  const meta = {hubId:'s1', meetingId:'room', kind:'codex', codexSid:'native-123', cwd:'C:/fixture', currentModel:{id:'chosen-model'}, effort:'max', mcpProfile:'selected-profile'};
  let session, restored;
  const engine = createLoopEngine({ meetingManager: {getMeeting:()=>meeting},
    sessionManager: {getSession:()=>session}, loadSessionMeta:()=>meta,
    resumeSession:async value=>{ restored=value; session={...value,id:value.hubId,status:'idle'}; return session; } });
  const ready = await engine.ensureMemberReady(meeting,'m1');
  assert.equal(ready.id, 's1'); assert.deepEqual(restored, meta, 'restore the full saved configuration and native binding');
  await engine.ensureMemberReady(meeting,'m1'); assert.equal(restored,meta);
  console.log('dev-file recovery: missing runtime restored from same-meeting metadata without losing model, cwd or native session');
}
run().catch(e=>{console.error(e);process.exitCode=1});
