'use strict';

const { AgentLeagueRuntimeStore } = require('../../core/agent-league-runtime-store.js');

const root = process.argv[2];
const ownerId = process.argv[3];
const store = new AgentLeagueRuntimeStore({ root, leagueId: 'multiprocess-test' });
let lease = null;

function reply(id, work) {
  try { process.send({ id, ok: true, value: work() }); }
  catch (error) { process.send({ id, ok: false, error: error.message, code: error.code || '' }); }
}

process.on('message', (message = {}) => {
  const { id, command, args = {} } = message;
  if (command === 'claim') return reply(id, () => {
    const result = store.claimLeadership({ ownerId, ownerPid: process.pid }, { ttlMs: args.ttlMs });
    if (result.ok) lease = result.lease;
    return result;
  });
  if (command === 'start-task') return reply(id, () => {
    store.ensureRun({
      runKey: args.runKey,
      phase: 'decision',
      decisionDate: args.decisionDate,
      snapshotId: 'snapshot-multi',
      participants: ['agent-a'],
    }, lease);
    return store.claimTask(`${args.runKey}:agent:agent-a`, lease, { ttlMs: args.taskTtlMs });
  });
  if (command === 'recover') return reply(id, () => store.recoverOrphanedTasks(lease));
  if (command === 'claim-task') return reply(id, () => store.claimTask(args.taskKey, lease, { ttlMs: args.taskTtlMs }));
  if (command === 'checkpoint') return reply(id, () => store.checkpointTask(
    args.taskKey,
    args.attemptId,
    args.checkpoint,
    args.useStoredLease === false ? args.lease : lease,
    { nextStage: args.nextStage, terminal: args.terminal === true },
  ));
  if (command === 'close') return reply(id, () => {
    store.close();
    setImmediate(() => process.exit(0));
    return true;
  });
  return reply(id, () => { throw new Error(`unknown command: ${command}`); });
});

process.send({ ready: true, ownerId, pid: process.pid });
