'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createGroupMemberSplit}=require('../renderer/group-member-split');
class El {
 constructor(tag='div'){this.tag=tag;this.children=[];this.dataset={};this.attributes={};this.events={};this.style={setProperty(){}};this.hidden=false;const values=new Set();this.classList={toggle:(k,on)=>on?values.add(k):values.delete(k),contains:k=>values.has(k),add:k=>values.add(k),remove:k=>values.delete(k)};}
 append(...nodes){for(const n of nodes){n.remove();n.parentElement=this;this.children.push(n);}}
 insertBefore(node,before){node.remove();node.parentElement=this;const i=this.children.indexOf(before);if(i<0)this.children.push(node);else this.children.splice(i,0,node);}
 remove(){if(this.parentElement){this.parentElement.children=this.parentElement.children.filter(n=>n!==this);this.parentElement=null;}}
 replaceChildren(...nodes){for(const n of [...this.children])n.remove();this.append(...nodes);}
 setAttribute(k,v){this.attributes[k]=v;}
 addEventListener(k,fn){this.events[k]=fn;}
 focus(){this.events.focusin?.({});}
}
function fixture(){
 const host=new El(),before=new El();host.append(before);const records=new Map(['a','b','c'].map(id=>[id,{id,status:'idle'}]));
 const made=[],disposed=[],restored=[];const meeting={id:'room1',focusedSub:'a',subSessions:['a','b','c'],participants:[0,2]};
 const services={members:m=>m.subSessions.map(sid=>({sid,label:sid,kind:'codex'})),session:id=>records.get(id),logo:()=>'',status:s=>s?.status||'',running:()=>false,stop:async()=>{},resume:async()=>{},createView:(sid,panel)=>{made.push(sid);return{turns:new Map(),setVisible(v){panel.shown=v;},updateStatus(){},toggleMode(){},mode:()=> 'card',captureReading:()=>({sid,scroll:{top:55}}),restoreReading:s=>restored.push([sid,s]),dispose:()=>disposed.push(sid)};}};
 const layout=createGroupMemberSplit({document:{createElement:t=>new El(t)},host,before,services});
 const panes=layout.root.children[1].children.filter(n=>n.className==='gms-pane');
 const select=(index,id)=>{const el=panes[index].children[0].children[1];el.value=id;el.events.change();};
 return{layout,meeting,records,made,disposed,restored,select,panes};
}
test('overview default does not mount members; split mounts only two without changing recipients',()=>{const f=fixture();f.layout.open(f.meeting);assert.equal(f.layout.mode(),'overview');assert.deepEqual(f.made,[]);f.layout.setMode('two');assert.deepEqual(f.made,['a','b']);assert.deepEqual(f.meeting.participants,[0,2]);});
test('selecting an already visible member focuses it without duplicating or replacing either pane',()=>{const f=fixture();f.layout.open(f.meeting);f.layout.setMode('two');f.select(1,'a');assert.deepEqual(f.made,['a','b']);assert(f.panes[0].classList.contains('focused'));assert.equal(f.panes[1].children[0].children[1].value,'b');});
test('third member replaces just one pane; overview keeps member views and reading positions',()=>{const f=fixture();f.layout.open(f.meeting);f.layout.setMode('two');f.select(1,'c');assert.deepEqual(f.made,['a','b','c']);assert.equal(f.panes[0].children[0].children[1].value,'a');assert.deepEqual(f.meeting.participants,[0,2]);f.layout.setMode('overview');assert.deepEqual(f.disposed,[]);f.layout.setMode('two');assert(f.restored.some(([sid,s])=>sid==='c'&&s?.scroll.top===55));});
test('navigation releases view resources, keeps per-room layout, and a new controller defaults to overview',()=>{const f=fixture();f.layout.open(f.meeting);f.layout.setMode('two');f.layout.close();assert.deepEqual(f.disposed,['a','b']);f.layout.open({...f.meeting,id:'other'});assert.equal(f.layout.mode(),'overview');f.layout.open(f.meeting);assert.equal(f.layout.mode(),'two');assert(f.restored.some(([sid,s])=>sid==='a'&&s?.scroll.top===55));const fresh=fixture();fresh.layout.open(f.meeting);assert.equal(fresh.layout.mode(),'overview');});
test('sleeping or removed members release their view without stopping another member',()=>{const f=fixture();f.layout.open(f.meeting);f.layout.setMode('two');f.records.get('b').status='dormant';f.layout.refresh(f.meeting);assert.deepEqual(f.disposed,['b']);f.records.get('b').status='idle';f.layout.refresh(f.meeting);assert.equal(f.made.filter(id=>id==='b').length,2);f.layout.refresh({...f.meeting,subSessions:['a','c']});assert.equal(f.panes[1].children[0].children[1].value,'c');});

test('closing from overview retains the last visible reading snapshot of hidden members',()=>{
 const f=fixture();f.layout.open(f.meeting);f.layout.setMode('two');
 const panel=f.panes[0].children[2].children.find(el=>el.dataset.groupMember==='a');
 panel._memberView.captureReading=()=>({scroll:{top:panel.hidden?0:123}});
 f.layout.setMode('overview');f.layout.close();f.layout.open(f.meeting);f.layout.setMode('two');
 assert.equal(f.restored.filter(([sid,s])=>sid==='a'&&s).at(-1)[1].scroll.top,123);
});
