'use strict';
const fs=require('fs'),path=require('path');
function realAcpConfig() {
  const root=process.env.ACP_TOOLS_ROOT,keyFile=process.env.ACP_TEST_KEY_FILE;
  if(!root || !keyFile)throw Error('ACP_TOOLS_ROOT and ACP_TEST_KEY_FILE required');
  return {acp:{nodePath:process.env.ACP_NODE_PATH || process.execPath,apiKey:fs.readFileSync(keyFile,'utf8').trim(),providers:{
    qwen:{entryPath:path.join(root,'node_modules/@qwen-code/qwen-code/cli-entry.js'),model:'qwen3.8-max'},
    'deepseek-acp':{entryPath:path.join(root,'node_modules/@deepseek-ai/dsh/lib/bin.js'),model:'deepseek-v4-pro',
      bridgePath:path.join(root,'node_modules/@openma/deepseek-harness-acp')},
    glm:{entryPath:path.join(root,'node_modules/zcode-acp-server/dist/index.js'),model:'glm-5.2',
      backendPath:path.join(root,'zcode-extracted/resources/glm/zcode.cjs')}
  }}};
}
module.exports={realAcpConfig};
