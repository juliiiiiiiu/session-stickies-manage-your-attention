import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const board=await readFile(new URL('./board-ui.js',import.meta.url),'utf8');
const editor=await readFile(new URL('./rich-editor.js',import.meta.url),'utf8');
const commitSource=board.slice(board.indexOf('const commitDraft='),board.indexOf('  const focusNext='));

// Structural guard for React reconciliation, not a simulated renderer.
test('draft row has a stable sibling key as optimistic notes are inserted or archived',()=>{
  assert.match(board,/active\.map\(\(note,index\)=>h\(NoteRow,\{key:note\.id/);
  assert.match(board,/draftVisible\?h\('div',\{key:'draft',className:'st-row st-draft-row'/);
  assert.match(board,/onEnter:\(\)=>commitDraft\(\)\.catch/);
  assert.doesNotMatch(commitSource,/\.focus\(|setDraftVisible\(|document\.activeElement/);
});

function fixture(text='第一条任务'){
  const draftValue={current:text},marksValue={current:[{start:0,end:2,bold:true}]};
  const settings={style:'bullet',fontSize:12,color:'default'},card={id:'card-a'};
  const created=[],pending=[],selections=[];
  const saveDraft=patch=>{draftValue.current=patch.text;marksValue.current=patch.marks;};
  const store={create(note){created.push(note);return new Promise((resolve,reject)=>pending.push({resolve,reject}));}};
  const commit=Function('draftValue','marksValue','settings','card','saveDraft','store','onSelection',commitSource+';return commitDraft;')(draftValue,marksValue,settings,card,saveDraft,store,value=>selections.push(value));
  return {commit,draftValue,marksValue,created,pending,selections};
}

test('Enter clears the draft immediately and accepts the next task before saving finishes',async()=>{
  const f=fixture(),first=f.commit();
  assert.equal(f.created.length,1);
  assert.equal(f.created[0].text,'第一条任务');
  assert.equal(f.created[0].cardId,'card-a');
  assert.deepEqual(f.created[0].marks,[{start:0,end:2,bold:true}]);
  assert.equal(f.draftValue.current,'');
  assert.deepEqual(f.marksValue.current,[]);
  f.draftValue.current='第二条任务';
  const second=f.commit();
  assert.deepEqual(f.created.map(n=>n.text),['第一条任务','第二条任务']);
  assert.notEqual(f.created[0].id,f.created[1].id);
  f.draftValue.current='第三条，尚未提交';
  f.pending.forEach(p=>p.resolve());
  await Promise.all([first,second]);
  assert.equal(f.draftValue.current,'第三条，尚未提交');
  assert.deepEqual(f.selections,[null,null]);
});

test('empty Enter and a blur immediately after submission cannot create duplicates',async()=>{
  const f=fixture(),first=f.commit();
  await f.commit();
  f.draftValue.current=' \n ';
  await f.commit();
  assert.equal(f.created.length,1);
  f.pending[0].resolve();
  await first;
});

test('failed save leaves the next draft untouched while the store owns recovery',async()=>{
  const f=fixture(),first=f.commit();
  f.draftValue.current='接着写';
  f.pending[0].reject(new Error('offline'));
  await first;
  assert.equal(f.draftValue.current,'接着写');
  assert.equal(f.created.length,1);
});

test('Enter still respects IME and Shift+Enter inserts a literal newline',()=>{
  assert.match(editor,/if\(e\.nativeEvent\.isComposing\|\|composing\.current\|\|e\.keyCode===229\)return/);
  assert.match(editor,/if\(e\.key==='Enter'\)\{e\.preventDefault\(\);if\(e\.shiftKey\)insertText\('\\n'\);else callbacks\.current\.onEnter\?\.\(\);\}/);
});
