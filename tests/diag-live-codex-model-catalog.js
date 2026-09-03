'use strict';

const { readCodexModelList } = require('../main/codex-model-catalog-service.js');

readCodexModelList({ timeoutMs: 10000 })
  .then(models => {
    console.log(JSON.stringify({
      count: models.length,
      models: models.filter(model => !model.hidden).map(model => ({
        id: model.id,
        displayName: model.displayName,
        defaultReasoningEffort: model.defaultReasoningEffort,
        efforts: (model.supportedReasoningEfforts || []).map(item => item.reasoningEffort),
      })),
    }, null, 2));
  })
  .catch(error => {
    console.error(error && (error.stack || error.message));
    process.exit(1);
  });
