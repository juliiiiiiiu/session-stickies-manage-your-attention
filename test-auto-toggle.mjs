import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('./board-ui.js',import.meta.url),'utf8');
const start=source.indexOf('  const toggleAuto=async(confirmed=false)=>{');
const end=source.indexOf('  const runPopover=',start);
assert.ok(start>=0&&end>start);
const code=source.slice(start,end);
const policyCode=source.split('// AUTO QUEUE POLICY START')[1].split('// AUTO QUEUE POLICY END')[0];
const autoState=new Function(policyCode+';return stickyAutoState;')();
const retryQueue={status:'paused',liveCardId:'default',liveMode:'answer',items:[{noteId:'failed',status:'failed'},{noteId:'waiting',status:'pending'}]};
function fixture({draft='',seen=false,failQueue=false,queue={items:[]},notes=[],card={id:'default'},selectedMode}={}){
 const actions=[],value={current:draft},state={visible:true,confirmed:null,seen};
 const store={get:()=>({notes,queue}),run:async r=>{actions.push(r);if(failQueue&&r.action==='queue')throw Error('offline');},flushAll:async()=>{}};
 const cardNoteIds=new Set(notes.filter(n=>(n.cardId||'default')===card.id).map(n=>n.id));
 const {switchOn,queueBlocked,retryPaused,priorMode}=autoState(queue,card.id,cardNoteIds);
 const compile=new Function('busy','switchOn','cannotEnable','retryPaused','enableKind','confirmAuto','draftValue','setDraftVisible','setConfirmAuto','setBusy','setRunOpen','store','cardNoteIds','commitDraft','card','runMode','stickyReadLocal','stickyWriteLocal',code+';return toggleAuto;');
 const toggle=confirmed=>compile(false,switchOn,queueBlocked,retryPaused,retryPaused?'retry':'enable',state.confirmed,value,v=>{state.visible=v;},v=>{state.confirmed=v;},()=>{},()=>{},store,cardNoteIds,async()=>{value.current='';},card,selectedMode??priorMode,()=>state.seen,(_key,v)=>{state.seen=v;})(confirmed);
 return {toggle,actions,value,state};
}
test('toggle hides the blank input without creating a note',async()=>{
 const f=fixture();await f.toggle();
 assert.equal(f.state.visible,false);assert.equal(f.state.confirmed,'enable');assert.deepEqual(f.actions,[]);
});
test('toggle leaves non-empty and whitespace drafts untouched before confirmation',async()=>{
 for(const text of ['important',' ']){const f=fixture({draft:text});await f.toggle();assert.equal(f.state.visible,true);assert.equal(f.value.current,text);assert.deepEqual(f.actions,[]);}
});
test('confirmation is remembered only after successful authorization',async()=>{
 const first=fixture();await first.toggle();assert.equal(first.state.seen,false);
 await first.toggle(true);assert.equal(first.state.seen,true);assert.equal(first.actions[0].action,'queue');
 const failure=fixture({failQueue:true});await failure.toggle();await assert.rejects(failure.toggle(true));assert.equal(failure.state.seen,false);
 const later=fixture({seen:true});await later.toggle();assert.equal(later.state.confirmed,null);assert.equal(later.actions[0].action,'queue');
});
test('turning off does not create a blank note',async()=>{
 const f=fixture({queue:{status:'armed',liveCardId:'default',items:[]}});await f.toggle();assert.equal(f.state.visible,false);assert.deepEqual(f.actions,[{action:'pause'}]);
});
test('paused owner can confirm a retry in visible order without upgrading Answer only',async()=>{
 const notes=[{id:'waiting',text:'second in old queue'},{id:'done',text:'done',checked:true},{id:'archived',text:'archived',archivedAt:1},{id:'failed',text:'first in old queue'}];
 const f=fixture({queue:retryQueue,notes,seen:true});
 await f.toggle();assert.equal(f.state.confirmed,'retry');assert.deepEqual(f.actions,[]);
 await f.toggle(true);
 assert.deepEqual(f.actions,[{action:'queue',replacePending:false,retryPaused:true,liveCardId:'default',liveMode:'answer',items:[{id:'waiting',mode:'answer'},{id:'failed',mode:'answer'}]}]);
 const changed=fixture({queue:retryQueue,notes,seen:true,selectedMode:'execute'});await changed.toggle();await changed.toggle(true);
 assert.equal(changed.actions[0].liveMode,'execute');
});
test('retry does not release another card or override in-flight and uncertain work',async()=>{
 const other=fixture({queue:retryQueue,card:{id:'other'},seen:true});await other.toggle();assert.deepEqual(other.actions,[]);assert.equal(other.state.confirmed,null);
 for(const status of ['running','dispatching','uncertain']){
  const queue={...retryQueue,items:[...retryQueue.items,{noteId:'guarded',status}]};
  const f=fixture({queue,seen:true});await f.toggle();assert.equal(f.state.confirmed,null);assert.deepEqual(f.actions,[]);
 }
});
