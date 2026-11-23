import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const board=await readFile(new URL('./board-ui.js',import.meta.url),'utf8');
const submit=board.slice(board.indexOf('const submitStar=async()=>'),board.indexOf('  const triedOpen='));
const makeSubmit=new Function('ctx','sessionId','starBusy','setStarStatus',`${submit}\nreturn submitStar;`);
for(const [name,reply,status] of [
  ['no grant',{ok:true,value:{ok:true,status:'noAuthorization'}},'noAuthorization'],
  ['confirmed',{ok:true,value:{ok:true,status:'starred'}},'starred'],
  ['retry',{ok:true,value:{ok:true,status:'retry'}},'retry'],
  ['gateway failure',{ok:false,error:{message:'offline'}},'retry'],
  ['host failure',{ok:true,value:{ok:false}},'retry']
])test(`star button handles gateway envelope: ${name}`,async()=>{
  const states=[], busy={current:false};
  const ctx={remote:{stickies:{async request(session,request){assert.equal(session,'s1');assert.deepEqual(request,{action:'starRepository'});return reply;}}}};
  await makeSubmit(ctx,'s1',busy,s=>states.push(s))();
  assert.deepEqual(states,['pending',status]);
  assert.equal(busy.current,false);
});

test('only an approved gateway reply shows an invitation',async()=>{
  const start=board.indexOf('  useEffect(()=>{\n    if(!manualOpens');
  const effect=board.slice(start,board.indexOf('  useLayoutEffect(()=>{',start));
  const run=new Function('useEffect','manualOpens','isCollapsed','triedOpen','starRoom','ctx','sessionId','setStarVisible',effect);
  for(const [reply,expected] of [[{ok:true,value:{ok:true,show:true}},[true]],[{ok:true,value:{ok:true,show:false}},[]],[{ok:false},[]]]){
    const shows=[];
    run(fn=>fn(),1,false,{current:0},{current:()=>true},{remote:{stickies:{request:async()=>reply}}},'s1',value=>shows.push(value));
    await Promise.resolve();
    assert.deepEqual(shows,expected);
  }
});
