'use strict';
const { EventEmitter } = require('events');
const path = require('path');
const { ClaudeNativeSession } = require('./claude-native-session');
const { NativeAgentJournal } = require('./native-agent-journal');
const END = new Set(['completed','failed','interrupted']);

function recordSnapshot(record) {
  const {timer,ack,resolve,reject,messages,streams,...fields}=record;
  return {...fields,messages:[...(messages || [])],streams:[...(streams || [])]};
}
function restoreRecord(record) {
  return {...record,messages:new Map(record.messages || []),streams:new Map(record.streams || [])};
}

// Adapt transport only. Claude still validates its own user UUID, receipt,
// approvals, injected activities and recovery; no Codex turn ID is invented.
class ClaudeBrokerSession extends EventEmitter {
  constructor(options) {
    super();this.options=options;this.contentRevision=0;this.changedUsers=new Set();this.historyFile=null;
    const journal=new NativeAgentJournal({directory:path.join(options.hubDataDir,'native-agent-submissions'),sessionId:options.journalSessionId || options.id});
    this.native=new ClaudeNativeSession({...options,
      restoredRecords:journal.list(),restoredActivities:journal.listActivities(),
      persistSubmission:data=>journal.saveSubmission(data),persistLifecycle:event=>journal.saveLifecycle(event),
      persistActivity:data=>journal.saveActivity(data)});
    this.usageService=new (require('../main/usage/session-token-usage-service').SessionTokenUsageService)({
      publish:(_id,usage)=>{this.sessionUsage=usage;this.emit('session-usage',usage);},logger:console});
    for(const event of ['data','diagnostic','action-error','migration-draft','usage','exit']) {
      this.native.on(event,(...args)=>this.emit(event,...args));
    }
    this.native.on('state',snapshot=>{
      if(!this.historyFile || END.has(snapshot.state)) {
        try{this.historyFile=this.native.historyPath();}
        catch(error){this.emit('diagnostic',{type:'history-path-error',message:error.message});}
      }
      if(this.historyFile)this.usageService.bind({id:options.id,kind:'claude',transcriptPath:this.historyFile});
      this.emit('state',this.runtime);
    });
    this.native.on('item',event=>{
      if(event.userMessageId)this.changedUsers.add(event.userMessageId);
      this.contentRevision++;this.emit('items');
    });
    this.native.on('lifecycle',event=>{
      if(event.userMessageId)this.changedUsers.add(event.userMessageId);
      this.contentRevision++;this.emit('lifecycle',event);
    });
  }
  get pid(){return this.native.pid;}
  get runtime(){return {...this.native.runtime,journalSessionId:this.options.journalSessionId || this.options.id,
    nativeStarted:!!(this.native.client || this.native.options.resumeSessionId || this.native.records.size)};}
  get threadId(){return this.native.sessionId;}
  start(){return this.native.start();}
  kill(){this.usageService.dispose();this.native.kill();}
  reconnect(...args){return this.native.reconnect(...args);}
  reconcile(...args){return this.native.reconcile(...args);}
  blocks(){return [];}
  finalText(){return '';}
  readTranscript(){return [];}
  profileOptions(){return this.native.options;}
  pendingWork(){return this.native.queue.length>0 || this.native.activities.pending().length>0 || !!this.native.configurationChange;}
  snapshotExtra({full=false}={}) {
    const records=[...this.native.records.values(),...this.native.activities.records.values()];
    const selected=full?records:records.filter(r=>!END.has(r.status) || r.userMessageId===this.runtime.userMessageId || this.changedUsers.has(r.userMessageId));
    if(!full)this.changedUsers.clear();
    return {nativeRecords:selected.map(recordSnapshot),replaceNativeRecords:full,
      recoveryRecords:this.native.recoveryRecords(),historyFile:this.historyFile,sessionUsage:this.sessionUsage,
      relaunchOptions:{launchArgs:this.native.options.launchArgs?.map(arg=>this.options.relaunchMcpPaths?.[arg] || arg),settingsFile:this.native.options.settingsFile,
        fastMode:this.native.options.fastMode,historyTitle:this.native.options.historyTitle,
        journalSessionId:this.options.journalSessionId || this.options.id}};
  }
  async invoke(action,args){const result=await this.native[action](...args);if(action==='rename')this.emit('renamed',args[0]);return result;}
}
module.exports={ClaudeBrokerSession,recordSnapshot,restoreRecord};
