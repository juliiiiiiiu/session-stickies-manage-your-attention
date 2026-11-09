import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('./client-source.js',import.meta.url),'utf8');
const start=source.indexOf('      function sessionStore(id){');
const end=source.indexOf('      ctx.effect(()=>()=>sessions.forEach',start);
const factory=new Function('sessions','transport','localStorage',source.slice(start,end)+';return sessionStore;');
const memory=()=>{const values=new Map();return {getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)};};
const note={id:'note1',text:'original',style:'checkbox',fontSize:12,checked:false,archivedAt:null};
const state=notes=>({notes,queue:{status:'idle',items:[]},revision:1});
const tick=()=>new Promise(r=>setImmediate(r));
test('in-flight edits survive older list and update responses',async()=>{
 const pending=[];const store=factory(new Map(),(_id,request)=>new Promise(resolve=>pending.push({request,resolve})),memory())('s');
 const list=store.refresh();await tick();pending.shift().resolve(state([note]));await list;
 store.change('note1',{text:'first edit'});const first=store.flush('note1');await tick();
 store.change('note1',{text:'newer edit'});pending.shift().resolve(state([{...note,text:'first edit'}]));await first;
 assert.equal(store.get().notes[0].text,'newer edit');
 const last=store.flush('note1');await tick();pending.shift().resolve(state([{...note,text:'newer edit'}]));await last;
 assert.equal(store.get().notes[0].text,'newer edit');assert.equal(store.get().unsaved,0);store.dispose();
});
test('optimistic creates survive an earlier list response',async()=>{
 const pending=[];const store=factory(new Map(),(_id,request)=>new Promise(resolve=>pending.push({request,resolve})),memory())('s');
 const list=store.refresh();await tick();const create=store.create(note);pending.shift().resolve(state([]));await list;await tick();
 assert.equal(store.get().notes[0].id,'note1');pending.shift().resolve(state([note]));await create;store.dispose();
});
test('failed creates retain recovery and retry idempotently',async()=>{
 const storage=memory();let fail=true;const calls=[];
 const transport=async(_id,req)=>{calls.push(req);if(fail)throw Error('offline');return state([note]);};
 const store=factory(new Map(),transport,storage)('s');await assert.rejects(store.create(note));
 assert.equal(store.get().notes[0].text,'original');assert.equal(JSON.parse(storage.getItem('dsh-stickies-recovery:s')).creates.length,1);
 fail=false;await store.flushAll();assert.equal(store.get().unsaved,0);assert.equal(calls[0].id,calls[1].id);store.dispose();
});
test('recovery journals are scoped by session and survive a new store',async()=>{
 const storage=memory();const offline=factory(new Map(),async()=>{throw Error('offline');},storage)('a');
 await assert.rejects(offline.create(note));offline.dispose();
 const stores=factory(new Map(),async()=>state([]),storage);const a=stores('a'),b=stores('b');await a.refresh();await b.refresh();
 assert.equal(a.get().notes.length,1);assert.equal(b.get().notes.length,0);a.dispose();b.dispose();
});
test('list responses retain an explicit Host storage fault until a real recovery',async()=>{
 let fault=true;
 const store=factory(new Map(),async()=>({...state([note]),storageError:fault?{code:'IO',message:'disk unavailable'}:null}),memory())('s');
 await store.refresh();assert.equal(store.get().error,'disk unavailable');assert.equal(store.get().notes[0].text,'original');
 await store.refresh();assert.equal(store.get().error,'disk unavailable');
 fault=false;await store.refresh();assert.equal(store.get().error,null);store.dispose();
});
test('failed multi-card creates retain card ownership across recovery and metadata refreshes',async()=>{
 const storage=memory(),owned={...note,cardId:'second'};let fail=true;const calls=[];
 const transport=async(_id,req)=>{calls.push(req);if(fail)throw Error('offline');return {...state(req.action==='create'?[owned]:[]),cards:[{id:'default',title:'Stickies'},{id:'second',title:'Project'}]};};
 const first=factory(new Map(),transport,storage)('s');await assert.rejects(first.create(owned));first.dispose();
 fail=false;const reloaded=factory(new Map(),transport,storage)('s');await reloaded.refresh();assert.equal(reloaded.get().notes[0].cardId,'second');assert.equal(reloaded.get().cards[1].title,'Project');
 await reloaded.flushAll();assert.equal(calls.at(-1).cardId,'second');assert.equal(reloaded.get().unsaved,0);reloaded.dispose();
});
test('successful polling does not hide a failed write still in recovery',async()=>{
 let fail=true;const store=factory(new Map(),async(_id,req)=>{if(req.action==='create'&&fail)throw Error('save failed');return state(req.action==='create'?[note]:[]);},memory())('s');
 await assert.rejects(store.create(note));await store.refresh();assert.equal(store.get().error,'save failed');assert.equal(store.get().notes[0].id,note.id);
 fail=false;await store.flushAll();assert.equal(store.get().error,null);store.dispose();
});
