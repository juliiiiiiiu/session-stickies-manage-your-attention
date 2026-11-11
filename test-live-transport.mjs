import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('./client-source.js',import.meta.url),'utf8');
const start=source.indexOf('      async function transport(sessionId,request){');
const end=source.indexOf('      function sessionStore(id){',start);
const factory=new Function('ctx','tr',source.slice(start,end)+';return transport;');
function fixture(){
 const commands=[],requests=[];
 const ctx={remote:{commands:{execute:async(_session,line)=>{const command=JSON.parse(line.slice('/stickies '.length));commands.push(command);return {ok:true,value:{result:{text:JSON.stringify({ok:true,...(command.action==='liveCapabilities'?{liveQueue:1}:{})})}}};}},stickies:{request:async(_session,request)=>{requests.push(request);return {ok:true,value:{ok:true,state:{notes:[],queue:{status:'idle',items:[]}}}};}}}};
 return {transport:factory(ctx,x=>x),commands,requests};
}
test('user-created notes and card reorders use human command path',async()=>{
 const f=fixture();
 await f.transport('s',{action:'create',id:'id',cardId:'c',text:'task',style:'bullet',fontSize:12,color:'default',checked:false,createdAt:123});
 await f.transport('s',{action:'reorder',cardId:'c',ids:['id']});
 assert.deepEqual(f.commands,[{action:'liveCreate',note:{id:'id',cardId:'c',text:'task',style:'bullet',fontSize:12,color:'default',checked:false}},{action:'liveReorder',cardId:'c',ids:['id']}]);
 assert.deepEqual(f.requests,[{action:'list'},{action:'list'}]);
});
test('old host retains ordinary editing but refuses live authorization',async()=>{
 const requests=[];const ctx={remote:{commands:{execute:async()=>({ok:true,value:{result:{text:JSON.stringify({ok:false,error:{code:'COMMAND_ACTION'}})}}})},stickies:{request:async(_session,req)=>{requests.push(req);return {ok:true,value:{ok:true,state:{notes:[]}}};}}}};
 const transport=factory(ctx,x=>x);
 await transport('s',{action:'create',id:'x',cardId:'c',text:'text',style:'text',fontSize:12,color:'default',checked:false});
 assert.equal(requests[0].action,'create');
 await assert.rejects(transport('s',{action:'queue',liveCardId:'c',liveMode:'execute',items:[]}),/liveNeedsRestart/);
});
test('authorization uses human command and updates remain ordinary requests',async()=>{
 const f=fixture();
 await f.transport('s',{action:'queue',liveCardId:'c',liveMode:'execute',items:[]});
 await f.transport('s',{action:'update',id:'id',patch:{text:'edited'}});
 assert.deepEqual(f.commands[0],{action:'liveCapabilities'}); assert.equal(f.commands[1].liveCardId,'c');
 assert.deepEqual(f.requests,[{action:'list'},{action:'update',id:'id',patch:{text:'edited'}}]);
});
