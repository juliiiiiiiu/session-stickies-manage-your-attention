import test from 'node:test';
import assert from 'node:assert/strict';
import { registerRemote, StickiesHost, toolDefinition } from './host.js';

test('only an authenticated Host owner invokes the star adapter', async () => {
  let calls=0;
  const host=new StickiesHost({}, {}, {}, undefined, async()=>{calls++;return {ok:true,status:'starred'};});
  const ctx={typert:{register(){}}};
  class Remote{constructor(context,name){this.ctx=context;context[name]=this;}}
  registerRemote(ctx,host,Remote);
  const agent={id:'session'}, request={action:'starRepository',principal:{kind:'owner'}};
  for(const principal of [undefined,{kind:'guest'}]) {
    ctx.invocation=principal?{peer:{principal}}:undefined;
    assert.deepEqual(await ctx.stickies.request(agent,request),{ok:true,status:'noAuthorization'});
    assert.deepEqual(await ctx.stickies.request(agent,{action:'claimStarInvite'}),{ok:true,show:false});
  }
  assert.equal(calls,0);
  ctx.invocation={peer:{principal:{kind:'owner'}}};
  assert.deepEqual(await ctx.stickies.request(agent,request),{ok:true,status:'starred'});
  assert.equal(calls,1);
  assert.equal((await toolDefinition(host).execute(request,{agent})).error.code,'INVALID_ACTION');
  assert.equal(calls,1);
});
