'use strict';
// Native lifecycle evidence only. No credentials, network calls or model content.
const fs = require('fs');
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const file = process.env.AI_HUB_ANTIGRAVITY_EVENTS_FILE;
    const hubSessionId = process.env.AI_HUB_ANTIGRAVITY_SESSION_ID;
    if (file && hubSessionId) {
      const v = JSON.parse(raw);
      const event = {event:process.argv[2], hubSessionId, observedAt:Date.now(),
        conversationId:v.conversationId, transcriptPath:v.transcriptPath, workspacePaths:v.workspacePaths,
        modelName:v.modelName, invocationNum:v.invocationNum, executionNum:v.executionNum,
        fullyIdle:v.fullyIdle, terminationReason:v.terminationReason, error:v.error};
      fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
    }
    process.stdout.write('{}');
  } catch (error) {
    process.stderr.write('AI Hub lifecycle capture failed: ' + error.message + '\n');
    process.stdout.write('{}');
    process.exitCode = 1;
  }
});
