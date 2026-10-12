'use strict';

// Refresh the Codex model catalog from DeepSeek's official Windows setup script.
// The Hub vendors only the default Codex model (deepseek-flash = V4.1 Flash) and
// derives V4 Pro from it, so normal session startup never depends on downloading
// configuration from the internet.
//
// 2026-10-13 note: the official 1.4.0 entry for deepseek-flash also declares image
// input and a search tool. The vendored entry keeps the text-only, no-search shape
// the Hub has verified; review those fields before committing a refreshed file.

const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const SOURCE_URL = 'https://cdn.deepseek.com/api-docs/codex-deepseek-setup-en.ps1';
const MODEL_SLUG = 'deepseek-flash';
const TARGET = path.resolve(__dirname, '..', 'core', 'deepseek-codex-model-catalog.json');

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        fetchText(new URL(response.headers.location, url).toString()).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`DeepSeek catalog download failed: HTTP ${response.statusCode}`));
        return;
      }
      response.setEncoding('utf8');
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

async function main() {
  const script = await fetchText(SOURCE_URL);
  const match = script.match(/\$ModelsJson = @'\r?\n([\s\S]*?)\r?\n'@/);
  if (!match) throw new Error('DeepSeek setup script no longer contains $ModelsJson');
  const upstream = JSON.parse(match[1]);
  const model = Array.isArray(upstream.models)
    ? upstream.models.find(item => item && item.slug === MODEL_SLUG)
    : null;
  if (!model) throw new Error(`${MODEL_SLUG} is missing from the official catalog`);
  if (model.minimal_client_version !== '0.144.0') {
    throw new Error(`unexpected minimum Codex version: ${model.minimal_client_version || '(missing)'}`);
  }
  fs.writeFileSync(TARGET, `${JSON.stringify({ models: [model] }, null, 2)}\n`, 'utf8');
  console.log(`Updated ${TARGET} from ${SOURCE_URL}`);
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
