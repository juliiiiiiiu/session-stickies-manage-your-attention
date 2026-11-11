import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('./board-ui.js',import.meta.url),'utf8');
const start=source.indexOf('  const toggleAuto=async(confirmed=false)=>{');
const end=source.indexOf('  const runPopover=',start);
assert.ok(start>=0&&end>start);
const code=source.slice(start,end);
function fixture({draft='',switchOn=false,seen=false,failQueue=false}={}){
 const actions=[],value={current:draft},state={visible:true,confirmed:false,seen};
 const store={get:()=>({notes:[],queue:{items:[]}}),run:async r=>{actions.push(r);if(failQueue&&r.action==='queue')throw Error('offline');},flushAll:async()=>{}};
 const toggle=new Function('busy','switchOn','draftValue','setDraftVisible','setConfirmAuto','setBusy','setRunOpen','store','cardNoteIds','commitDraft','card','runMode','stickyReadLocal','stickyWriteLocal',code+';return toggleAuto;')(
  false,switchOn,value,v=>{state.visible=v;},v=>{state.confirmed=v;},()=>{},()=>{},store,new Set(),async()=>{value.current='';},{id:'default'},'execute',()=>state.seen,(_key,v)=>{state.seen=v;});
 return {toggle,actions,value,state};
}
test('toggle hides the blank input without creating a note',async()=>{
 const f=fixture();await f.toggle();
 assert.equal(f.state.visible,false);assert.equal(f.state.confirmed,true);assert.deepEqual(f.actions,[]);
});
test('toggle leaves non-empty and whitespace drafts untouched before confirmation',async()=>{
 for(const text of ['important',' ']){const f=fixture({draft:text});await f.toggle();assert.equal(f.state.visible,true);assert.equal(f.value.current,text);assert.deepEqual(f.actions,[]);}
});
test('confirmation is remembered only after successful authorization',async()=>{
 const first=fixture();await first.toggle();assert.equal(first.state.seen,false);
 await first.toggle(true);assert.equal(first.state.seen,true);assert.equal(first.actions[0].action,'queue');
 const failure=fixture({failQueue:true});await assert.rejects(failure.toggle(true));assert.equal(failure.state.seen,false);
 const later=fixture({seen:true});await later.toggle();assert.equal(later.state.confirmed,false);assert.equal(later.actions[0].action,'queue');
});
test('turning off does not create a blank note',async()=>{
 const f=fixture({switchOn:true});await f.toggle();assert.equal(f.state.visible,false);assert.deepEqual(f.actions,[{action:'pause'}]);
});
