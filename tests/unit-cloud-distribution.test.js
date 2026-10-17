'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {applyStripMarkers}=require('../scripts/community/strip-markers');
const {globToRegExp}=require('../scripts/community/export-community');
const {registerCloudIpc}=require('../main/ipc/cloud-handlers');
const root=path.join(__dirname,'..');
test('company/public cannot register local cloud IPC even when a service is supplied',()=>{
  for(const target of ['company','public']){const channels=[];registerCloudIpc({handle:name=>channels.push(name)},{service:{enabled:true},distribution:{personalModules:false,target}});assert.deepEqual(channels,[]);}
});
test('exports remove page wiring, catalog, collector and backend together',()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'community/manifest.json'),'utf8'));
  for(const file of ['core/cloud/catalog.json','core/cloud/remote.ps1','core/cloud/transport.js','core/cloud/service.js','main/ipc/cloud-handlers.js','renderer/cloud-page.js','renderer/styles/cloud-page.css'])assert.ok(manifest.drop.some(g=>globToRegExp(g).test(file)),file);
  for(const file of ['main.js','renderer/renderer.js','renderer/index.html']){
    const exported=applyStripMarkers(fs.readFileSync(path.join(root,file),'utf8'),file).text;
    assert.ok(!exported.includes("require('./core/cloud/")&&!exported.includes("require('./cloud-page')")&&!exported.includes('id="btn-cloud"')&&!exported.includes('href="styles/cloud-page.css"'),file);
  }
});
