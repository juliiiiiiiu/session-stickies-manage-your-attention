import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {initialState,operate} from './model.js';
const source = await readFile(new URL('./rich-editor.js', import.meta.url), 'utf8');
const pure = source.split('// PURE HELPERS START')[1].split('// PURE HELPERS END')[0];
const {stickyNormalizeMarks:normalize,stickyPackMarks:pack,stickyApplyMarks:apply,stickyReplaceText:replace,stickyReconcileText:reconcile,stickyEditorPolicy:policy} = Function(pure+';return {stickyNormalizeMarks,stickyPackMarks,stickyApplyMarks,stickyReplaceText,stickyReconcileText,stickyEditorPolicy};')();

test('256 legal overlapping marks serialize 511 render runs losslessly back into Host limit',()=>{
  const text='x'.repeat(512),marks=[{start:0,end:512,bold:true},...Array.from({length:255},(_,i)=>({start:2*i+1,end:2*i+2,color:'error'}))];
  const render=normalize(text,marks);assert.equal(render.length,511);
  const serialized=pack(text,render);assert.equal(serialized.length,256);assert.deepEqual(normalize(text,serialized),render);
  let state=operate(initialState(),{action:'create',text,marks});const id=state.notes[0].id;
  state=operate(state,{action:'update',id,patch:{text,marks:serialized}});
  assert.deepEqual(normalize(text,state.notes[0].marks),render);
  // A native insertion still serializes compactly; no unchanged-source shortcut is needed.
  const edited=replace(text,render,512,512,'犬');const next=pack(edited.text,edited.marks,marks);
  assert.equal(next.length,256);
  state=operate(state,{action:'update',id,patch:{text:edited.text,marks:next}});
  assert.deepEqual(normalize(edited.text,state.notes[0].marks),edited.marks);
});
test('packing combines identical bounds, preserves false and does not bridge inherited gaps',()=>{
  const text='abcdef',marks=[{start:0,end:2,bold:false,fontSize:16},{start:3,end:6,bold:false,fontSize:16}];
  assert.deepEqual(pack(text,marks),marks);
  assert.deepEqual(normalize(text,pack(text,marks)),normalize(text,marks));
  const mixed=[{start:0,end:6,bold:true},{start:2,end:4,color:'accent'}];
  assert.equal(pack(text,normalize(text,mixed)).length,2);
});
test('packing chooses canonical when splitting properties would increase range count',()=>{
  const marks=[{start:0,end:1,bold:true,color:'error'},{start:1,end:2,bold:true,color:'accent'},{start:2,end:3,bold:false,color:'accent'}];
  assert.deepEqual(pack('abc',marks),marks);
});
test('equivalent compact source is retained, but stale source never restores removed formatting',()=>{
  const text='abcde',original=[{start:0,end:5,color:'accent'},{start:2,end:3,color:'error'}];
  assert.deepEqual(pack(text,normalize(text,original),original),original);
  const cleared=apply(text,original,0,5,{color:null});
  assert.deepEqual(pack(text,cleared,original),[]);
});
test('genuine excess formatting is retained and Host explicitly rejects rather than silently dropping it',()=>{
  const text='x'.repeat(514),marks=Array.from({length:257},(_,i)=>({start:2*i,end:2*i+1,bold:true}));
  const serialized=pack(text,marks);assert.equal(serialized.length,257);assert.deepEqual(serialized,marks);
  assert.throws(()=>operate(initialState(),{action:'create',text,marks:serialized}),error=>error.code==='INVALID_MARKS');
});
test('random packing is semantically equal and does not mutate canonical, source or edited data',()=>{
  let seed=947;const random=n=>{seed=(seed*1664525+1013904223)>>>0;return seed%n;};
  for(let iteration=0;iteration<350;iteration++){
    const text='犬🐶abc'.repeat(8),marks=Array.from({length:20},()=>{
      const start=random(text.length),end=start+1+random(text.length-start);
      return {start,end,...(random(2)?{bold:!!random(2)}:{}),...(random(2)?{fontSize:10+random(23)}:{}),...(random(2)?{color:['default','accent','success','warn','error'][random(5)]}:{})};
    });
    const canonical=normalize(text,marks),before=JSON.stringify({marks,canonical});
    const serialized=pack(text,canonical,marks);
    assert.deepEqual(normalize(text,serialized),canonical);
    assert.equal(JSON.stringify({marks,canonical}),before);
    assert.ok(serialized.length<=canonical.length);
    const at=random(text.length+1),edited=replace(text,canonical,at,at,'文');
    assert.deepEqual(normalize(edited.text,pack(edited.text,edited.marks,marks)),edited.marks);
  }
});

test('blur never restores selection even while activeElement still points to editor',()=>{
  for(const editorActive of [false,true])for(const toolsActive of [false,true])for(const composing of [false,true]) {
    assert.deepEqual(policy({reason:'blur',editorActive,toolsActive,composing,selectionOwned:true}),{
      restoreSelection:false,reportSelection:false,commitNative:true,
    });
  }
});
test('delayed props cannot use lingering selection to steal external input focus',()=>{
  assert.equal(policy({reason:'props',editorActive:false,selectionOwned:true}).restoreSelection,false);
  assert.equal(policy({reason:'props',editorActive:false,selectionOwned:true,toolsActive:true}).restoreSelection,false);
  assert.equal(policy({reason:'props',editorActive:true}).restoreSelection,true);
});
test('active editor input preserves caret but input arriving after blur cannot restore it',()=>{
  assert.deepEqual(policy({reason:'input',editorActive:true}),{restoreSelection:true,reportSelection:true,commitNative:true});
  assert.deepEqual(policy({reason:'input',editorActive:false,selectionOwned:true}),{restoreSelection:false,reportSelection:false,commitNative:true});
});
test('explicit selection-tool formatting may restore focus, unrelated updates may not',()=>{
  assert.equal(policy({reason:'format',editorActive:false,selectionOwned:true,toolsActive:true}).restoreSelection,true);
  assert.equal(policy({reason:'input',editorActive:false,selectionOwned:true,toolsActive:true}).restoreSelection,false);
  assert.equal(policy({reason:'format',editorActive:false,composing:true}).restoreSelection,false);
});
test('only own active selection tools can retain an inactive editor selection report',()=>{
  assert.equal(policy({editorActive:false,selectionOwned:true,toolsActive:true}).reportSelection,true);
  assert.equal(policy({editorActive:false,selectionOwned:false,toolsActive:true}).reportSelection,false);
  assert.equal(policy({editorActive:false,selectionOwned:true,toolsActive:false}).reportSelection,false);
});
test('IME blur saves visible text and marks; later finalization remains non-focusing',()=>{
  assert.equal(policy({reason:'input',editorActive:true,composing:true}).commitNative,false);
  const blur=policy({reason:'blur',editorActive:false,composing:true});
  const saved=blur.commitNative?reconcile('a中z',[{start:1,end:2,bold:true}],'a中文z'):null;
  assert.deepEqual(saved,{text:'a中文z',marks:[{start:1,end:3,bold:true}]});
  assert.equal(blur.restoreSelection,false);
  const final=policy({reason:'input',editorActive:false,composing:false,selectionOwned:true});
  assert.equal(final.commitNative,true);assert.equal(final.restoreSelection,false);assert.equal(final.reportSelection,false);
});

test('later marks override individual attributes, never discard unrelated attributes',()=>{
  assert.deepEqual(normalize('abcdef',[{start:0,end:6,bold:true,color:'accent'},{start:2,end:4,color:'error'}]),[
    {start:0,end:2,color:'accent',bold:true},{start:2,end:4,color:'error',bold:true},{start:4,end:6,color:'accent',bold:true},
  ]);
});
test('normalization clamps, drops invalid values and merges adjacent identical runs',()=>{
  assert.deepEqual(normalize('abcd',[null,{start:-9,end:2,fontSize:14},{start:2,end:99,fontSize:14},{start:0,end:3,color:'url(javascript:x)'},{start:0,end:4,fontSize:999},{start:NaN,end:2,bold:true}]),[{start:0,end:4,fontSize:14}]);
  assert.deepEqual(normalize('',[{start:0,end:1,bold:true}]),[]);
});
test('selected formatting splits existing runs and null removes only that attribute',()=>{
  const marks=[{start:0,end:6,fontSize:14,color:'success',bold:true}];
  assert.deepEqual(apply('abcdef',marks,2,4,{fontSize:20,bold:false}),[
    {start:0,end:2,fontSize:14,color:'success',bold:true},{start:2,end:4,fontSize:20,color:'success',bold:false},{start:4,end:6,fontSize:14,color:'success',bold:true},
  ]);
  assert.deepEqual(apply('abcdef',marks,0,6,{fontSize:null,bold:null}),[{start:0,end:6,color:'success'}]);
});
test('collapsed selection does not create phantom formatting',()=>{
  assert.deepEqual(apply('abc',[],1,1,{bold:true}),[]);
});
test('insertion inherits left style, shifts untouched suffix, and merges',()=>{
  assert.deepEqual(replace('abcd',[{start:0,end:2,bold:true},{start:2,end:4,color:'error'}],2,2,'XY'),{
    text:'abXYcd',marks:[{start:0,end:4,bold:true},{start:4,end:6,color:'error'}],
  });
});
test('replacement inherits selected first character, not preceding run',()=>{
  assert.deepEqual(replace('abcd',[{start:0,end:2,bold:true},{start:2,end:4,color:'error'}],2,3,'XYZ'),{
    text:'abXYZd',marks:[{start:0,end:2,bold:true},{start:2,end:6,color:'error'}],
  });
});
test('deletion preserves surviving attributes across multiple runs',()=>{
  assert.deepEqual(replace('abcdef',[{start:0,end:2,bold:true},{start:2,end:4,color:'error'},{start:4,end:6,fontSize:16}],1,5,''),{
    text:'af',marks:[{start:0,end:1,bold:true},{start:1,end:2,fontSize:16}],
  });
});
test('UTF16 offsets preserve emoji and CJK code units',()=>{
  assert.deepEqual(replace('a🐶中文',[{start:1,end:3,bold:true},{start:3,end:5,color:'accent'}],1,3,'猫'),{
    text:'a猫中文',marks:[{start:1,end:2,bold:true},{start:2,end:4,color:'accent'}],
  });
});
test('paste normalizes CRLF; text resembling HTML remains literal',()=>{
  assert.deepEqual(replace('',[],0,0,'<img src=x>\r\n犬\r猫'),{text:'<img src=x>\n犬\n猫',marks:[]});
});
test('native reconciliation preserves suffix and existing unaffected mark ranges',()=>{
  assert.deepEqual(reconcile('hello world',[{start:6,end:11,bold:true}],'hello brave world'),{
    text:'hello brave world',marks:[{start:12,end:17,bold:true}],
  });
  assert.deepEqual(reconcile('abc',[{start:0,end:3,bold:true}],'abc'),{text:'abc',marks:[{start:0,end:3,bold:true}]});
});
test('composition commit replaces one range without corrupting remote formatting',()=>{
  assert.deepEqual(reconcile('a中文z',[{start:1,end:3,fontSize:16},{start:3,end:4,color:'error'}],'a中国文字z'),{
    text:'a中国文字z',marks:[{start:1,end:5,fontSize:16},{start:5,end:6,color:'error'}],
  });
});
test('normalization is idempotent and outputs sorted bounded nonoverlapping runs',()=>{
  let seed=173;
  const random=n=>{seed=(seed*1664525+1013904223)>>>0;return seed%n;};
  for(let iteration=0;iteration<250;iteration++){
    const text='abcdefghijklmnop';
    const marks=Array.from({length:12},()=>({start:random(22)-3,end:random(22),...(random(2)?{bold:!!random(2)}:{color:['error','accent','success'][random(3)]})}));
    const runs=normalize(text,marks);
    assert.deepEqual(normalize(text,runs),runs);
    for(let i=0;i<runs.length;i++){
      assert.ok(runs[i].start>=0&&runs[i].end<=text.length&&runs[i].start<runs[i].end);
      if(i)assert.ok(runs[i-1].end<=runs[i].start);
    }
    const a=random(text.length),b=a+random(text.length-a+1),next=replace(text,runs,a,b,'🐶');
    assert.equal(next.text,text.slice(0,a)+'🐶'+text.slice(b));
    assert.deepEqual(normalize(next.text,next.marks),next.marks);
  }
});
