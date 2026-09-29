'use strict';
// Run only after tests and packaging have passed in an independent checkout.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{execFileSync}=require('child_process');
const root=path.resolve(__dirname,'..'),dist=path.join(root,'dist');
const {version}=require('../package.json');
for(const file of ['community-gui/report.json','community-packaged-gui/report.json','official-codex/report.json']) {
  const evidence=JSON.parse(fs.readFileSync(path.join(root,'artifacts',file),'utf8'));
  if(evidence.passed!==true)throw Error('Release verification not passed: '+file);
}
const sha=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
for(const name of [`AIHubCommunity-${version}-win-x64.zip`,`AIHubCommunity-Setup-${version}.exe`])if(!fs.existsSync(path.join(dist,name)))throw Error('Missing release asset: '+name);
execFileSync('git',['archive','--format=zip','-o',path.join(dist,`AIHubCommunity-source-${version}.zip`),'HEAD'],{cwd:root});
fs.copyFileSync(path.join(root,'scripts/install-release.ps1'),path.join(dist,'install-release.ps1'));
const names=[`AIHubCommunity-${version}-win-x64.zip`,`AIHubCommunity-Setup-${version}.exe`,`AIHubCommunity-source-${version}.zip`,'install-release.ps1'];
const assets=names.map(name=>({name,bytes:fs.statSync(path.join(dist,name)).size,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(dist,name))).digest('hex')}));
fs.writeFileSync(path.join(dist,'release-manifest.json'),JSON.stringify({schemaVersion:1,version,sourceSha:sha,platform:'win32-x64',upstream:require('../community-edition.json'),assets,evidence:{ci:true,simulatedCliGui:true,powershellHookRelay:true,realCodexHandshake:true,realProviderLogin:false,realModelReply:false},agentGuide:'docs/AGENT-QUICKSTART.md',customizationGuide:'docs/CUSTOMIZE.md'},null,2));
const manifestHash=crypto.createHash('sha256').update(fs.readFileSync(path.join(dist,'release-manifest.json'))).digest('hex');
fs.writeFileSync(path.join(dist,'SHA256SUMS.txt'),assets.map(a=>a.sha256+'  '+a.name).concat(manifestHash+'  release-manifest.json').join('\n')+'\n');
console.log(JSON.stringify({version,sha,assets}));
