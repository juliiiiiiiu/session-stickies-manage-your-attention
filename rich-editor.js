/* Embedded inside the Stickies Client factory. No imports or user HTML. */
// PURE HELPERS START
function stickyMarkStyle(input) {
  const out = {};
  if (Number.isInteger(input?.fontSize) && input.fontSize >= 10 && input.fontSize <= 32) out.fontSize = input.fontSize;
  if (['default','accent','success','warn','error'].includes(input?.color)) out.color = input.color;
  if (typeof input?.bold === 'boolean') out.bold = input.bold;
  return out;
}
function stickySameStyle(a, b) {
  return a.fontSize === b.fontSize && a.color === b.color && a.bold === b.bold;
}
/** Canonical nonoverlapping UTF-16 runs; later marks override only their declared attributes. */
function stickyNormalizeMarks(text, marks) {
  const length = String(text ?? '').length;
  const valid = (Array.isArray(marks) ? marks : []).filter(m => m && Number.isFinite(m.start) && Number.isFinite(m.end)).map(m => ({
    start: Math.max(0, Math.min(length, Math.trunc(m.start))),
    end: Math.max(0, Math.min(length, Math.trunc(m.end))),
    ...stickyMarkStyle(m),
  })).filter(m => m.end > m.start && Object.keys(stickyMarkStyle(m)).length);
  const bounds = [...new Set([0,length,...valid.flatMap(m => [m.start,m.end])])].sort((a,b) => a-b);
  const result = [];
  for (let i=0; i<bounds.length-1; i++) {
    const start=bounds[i], end=bounds[i+1];
    const style = Object.assign({}, ...valid.filter(m => m.start <= start && m.end >= end).map(stickyMarkStyle));
    if (!Object.keys(style).length) continue;
    const prev=result[result.length-1];
    if (prev && prev.end === start && stickySameStyle(prev,style)) prev.end=end;
    else result.push({start,end,...style});
  }
  return result;
}
/**
 * Lossless wire representation: join each property's adjacent equal intervals,
 * then combine matching bounds. Rendering still uses canonical runs. No cap or
 * truncation: a remaining >256 result must reach the Host's explicit error.
 * This chooses among lossless candidates; it is not a global minimum solver.
 * A semantically equal original representation is another candidate, never an
 * authority to restore formatting removed by a later edit.
 */
function stickyPackMarks(text, marks, originalMarks) {
  const canonical=stickyNormalizeMarks(text,marks), combined=new Map();
  for(const property of ['fontSize','color','bold']) {
    const intervals=[];
    for(const run of canonical) {
      if(!Object.hasOwn(run,property))continue;
      const previous=intervals[intervals.length-1];
      if(previous&&previous.end===run.start&&previous[property]===run[property])previous.end=run.end;
      else intervals.push({start:run.start,end:run.end,[property]:run[property]});
    }
    for(const interval of intervals) {
      const key=interval.start+':'+interval.end;
      if(combined.has(key))Object.assign(combined.get(key),interval);
      else combined.set(key,{...interval});
    }
  }
  const packed=[...combined.values()].sort((a,b)=>a.start-b.start||a.end-b.end);
  let best=packed.length<canonical.length?packed:canonical;
  const original=Array.isArray(originalMarks)?originalMarks.filter(m=>m&&Number.isInteger(m.start)&&Number.isInteger(m.end)&&m.start>=0&&m.start<m.end&&m.end<=text.length).map(m=>({start:m.start,end:m.end,...stickyMarkStyle(m)})).filter(m=>Object.keys(m).length>2):null;
  if(original&&original.length<best.length&&JSON.stringify(stickyNormalizeMarks(text,original))===JSON.stringify(canonical))best=original;
  return best;
}
function stickyStyleAt(text, marks, offset) {
  return stickyMarkStyle(stickyNormalizeMarks(text,marks).find(m => m.start <= offset && offset < m.end));
}
/** null removes an override, false is a real bold override. */
function stickyApplyMarks(text, marks, start, end, patch) {
  start=Math.max(0,Math.min(text.length,Math.trunc(start))); end=Math.max(start,Math.min(text.length,Math.trunc(end)));
  const runs=stickyNormalizeMarks(text,marks);
  if (end === start) return runs;
  const bounds=[...new Set([0,text.length,start,end,...runs.flatMap(m=>[m.start,m.end])])].sort((a,b)=>a-b);
  const next=[];
  for(let i=0;i<bounds.length-1;i++) {
    const a=bounds[i],b=bounds[i+1]; const style=stickyMarkStyle(runs.find(m=>m.start<=a&&m.end>=b));
    if(a>=start&&b<=end) for(const key of ['fontSize','color','bold']) {
      if(patch?.[key]===null) delete style[key];
      else if(Object.hasOwn(stickyMarkStyle(patch),key)) style[key]=patch[key];
    }
    next.push({start:a,end:b,...style});
  }
  return stickyNormalizeMarks(text,next);
}
/** Replace a known range, retaining surviving formatting and inheriting the insertion-point style. */
function stickyReplaceText(text, marks, start, end, inserted) {
  start=Math.max(0,Math.min(text.length,Math.trunc(start))); end=Math.max(start,Math.min(text.length,Math.trunc(end)));
  inserted=String(inserted).replace(/\r\n?/g,'\n');
  const runs=stickyNormalizeMarks(text,marks), delta=inserted.length-(end-start), next=[];
  for(const run of runs) {
    if(run.start<start) next.push({...run,end:Math.min(run.end,start)});
    if(run.end>end) next.push({...run,start:Math.max(run.start,end)+delta,end:run.end+delta});
  }
  const inherit=stickyStyleAt(text,runs,start<end?start:(start>0?start-1:start));
  if(inserted.length) next.push({start,end:start+inserted.length,...inherit});
  const value=text.slice(0,start)+inserted+text.slice(end);
  return {text:value,marks:stickyNormalizeMarks(value,next)};
}
/** Reconcile a native edit, including IME: one maximal common prefix/suffix change. */
function stickyReconcileText(previous, marks, next) {
  if(previous===next) return {text:next,marks:stickyNormalizeMarks(next,marks)};
  let start=0, oldEnd=previous.length, newEnd=next.length;
  while(start<oldEnd&&start<newEnd&&previous[start]===next[start]) start++;
  while(oldEnd>start&&newEnd>start&&previous[oldEnd-1]===next[newEnd-1]) {oldEnd--;newEnd--;}
  return stickyReplaceText(previous,marks,start,oldEnd,next.slice(start,newEnd));
}
/** Focus is authority: a lingering document Selection never authorizes refocusing an editor. */
function stickyEditorPolicy({reason='input',editorActive=false,composing=false,selectionOwned=false,toolsActive=false}={}) {
  return {
    restoreSelection: !composing && reason!=='blur' && (reason==='format'||editorActive),
    reportSelection: !composing && reason!=='blur' && (editorActive||(selectionOwned&&toolsActive)),
    commitNative: !composing || reason==='blur',
  };
}
// PURE HELPERS END

function RichEditor({note,onChange,onFocus,onBlur,onEnter,onMoveKey,onSelection,editorRef,placeholder,ariaLabel}) {
  const element=useRef(null), composing=useRef(false), pendingSelection=useRef(null), ownedSelection=useRef(false), blurred=useRef(false);
  const value=useRef({text:note.text||'',marks:stickyNormalizeMarks(note.text||'',note.marks)});
  const callbacks=useRef({}); callbacks.current={onChange,onFocus,onBlur,onEnter,onMoveKey,onSelection,note};
  const history=useRef({undo:[],redo:[]}), nativeEdit=useRef(null), renderStamp=useRef('');
  const colors={default:'var(--dsw-alias-label-primary)',accent:'var(--dsw-alias-brand-primary)',success:'var(--dsw-alias-state-success-primary)',warn:'var(--dsw-alias-state-warn-primary)',error:'var(--dsw-alias-state-error-primary)'};
  function editorPolicy(reason='input') {
    const root=element.current, active=root?.ownerDocument.activeElement;
    const tools=active?.closest?.('.st-selection-tools'), scope=root?.closest('.dsh-sticky-root');
    return stickyEditorPolicy({reason,composing:composing.current,
      editorActive:!blurred.current&&!!root&&(active===root||root.contains(active)),
      selectionOwned:ownedSelection.current,
      toolsActive:!!tools&&!!scope&&tools.closest('.dsh-sticky-root')===scope,
    });
  }
  // Newlines are literal text nodes under pre-wrap; paste/Enter never inject HTML or block nodes.
  function readDOM() {
    const root=element.current;
    let text=''; const positions=new Map();
    function visit(node) {
      if(node.nodeType===3) {positions.set(node,text.length);text+=node.data;return;}
      const offsets=[]; positions.set(node,offsets);
      const children=[...node.childNodes];
      children.forEach((child,index)=>{
        offsets[index]=text.length;
        const block=child.nodeType===1&&['DIV','P','LI'].includes(child.nodeName);
        if(block&&text.length&&!text.endsWith('\n')) text+='\n';
        if(child.nodeType===1&&child.nodeName==='BR') {
          // Browsers use a sole <br> as the empty-editable placeholder.
          positions.set(child,[text.length]);
          if(!(children.length===1&&text.length===0)) text+='\n';
        } else visit(child);
      });
      offsets[children.length]=text.length;
    }
    if(root) visit(root);
    return {text,positions};
  }
  function selectionOffsets(dom=readDOM()) {
    const root=element.current, s=root?.ownerDocument.getSelection();
    if(!s?.rangeCount||!root.contains(s.anchorNode)||!root.contains(s.focusNode)) return null;
    const offset=(node,n)=>{const found=dom.positions.get(node);return typeof found==='number'?found+n:Array.isArray(found)?found[Math.min(n,found.length-1)]:undefined;};
    const a=offset(s.anchorNode,s.anchorOffset),b=offset(s.focusNode,s.focusOffset);
    if(a===undefined||b===undefined)return null;
    return {start:Math.min(a,b),end:Math.max(a,b),backward:a>b};
  }
  function restoreSelection(selection,reason='input') {
    const root=element.current;if(!root?.isConnected||!selection||!editorPolicy(reason).restoreSelection)return;
    const document=root.ownerDocument, nodes=[];
    const walk=document.createTreeWalker(root,4);let n;while((n=walk.nextNode()))nodes.push(n);
    function at(offset) {let remaining=Math.max(0,Math.min(value.current.text.length,offset));for(const node of nodes){if(remaining<=node.data.length)return [node,remaining];remaining-=node.data.length;}return nodes.length?[nodes[nodes.length-1],nodes[nodes.length-1].data.length]:[root,0];}
    const [a,ao]=at(selection.start),[b,bo]=at(selection.end),s=document.getSelection();
    const range=document.createRange();range.setStart(a,ao);range.setEnd(b,bo);s.removeAllRanges();s.addRange(range);
    if(selection.backward&&s.setBaseAndExtent)s.setBaseAndExtent(b,bo,a,ao);
  }
  function draw(selection,reason='input') {
    const root=element.current;if(!root||composing.current)return;
    const current=value.current, stamp=JSON.stringify(current);
    root.dataset.empty=String(!current.text);
    if(renderStamp.current!==stamp) {
      const document=root.ownerDocument,fragment=document.createDocumentFragment();let cursor=0;
      for(const mark of current.marks){
        if(mark.start>cursor)fragment.append(document.createTextNode(current.text.slice(cursor,mark.start)));
        const span=document.createElement('span');span.textContent=current.text.slice(mark.start,mark.end);
        if(mark.fontSize!==undefined)span.style.fontSize=mark.fontSize+'px';
        if(mark.color!==undefined)span.style.color=colors[mark.color];
        if(mark.bold!==undefined)span.style.fontWeight=mark.bold?'700':'400';
        fragment.append(span);cursor=mark.end;
      }
      if(cursor<current.text.length)fragment.append(document.createTextNode(current.text.slice(cursor)));
      if(!current.text.length)fragment.append(document.createTextNode(''));
      root.replaceChildren(fragment);renderStamp.current=stamp;
    }
    if(selection)restoreSelection(selection,reason);
  }
  function reportSelection() {
    if(composing.current)return;
    if(!editorPolicy().reportSelection){
      if(ownedSelection.current){ownedSelection.current=false;callbacks.current.onSelection?.(null);}return;
    }
    const selected=selectionOffsets(),root=element.current;
    if(!selected||selected.start===selected.end){
      if(ownedSelection.current){ownedSelection.current=false;callbacks.current.onSelection?.(null);}return;
    }
    ownedSelection.current=true;
    const r=root.ownerDocument.getSelection().getRangeAt(0).getBoundingClientRect();
    const rect={left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};
    const currentNote=callbacks.current.note, selectedStyle=stickyStyleAt(value.current.text,value.current.marks,selected.start);
    callbacks.current.onSelection?.({noteId:currentNote.id,start:selected.start,end:selected.end,rect,marks:value.current.marks,fontSize:selectedStyle.fontSize??currentNote.fontSize??12,color:selectedStyle.color??currentNote.color??'default',bold:selectedStyle.bold??false,apply(patch){
      if(composing.current||!element.current?.isConnected)return;
      const current=value.current;
      const next={text:current.text,marks:stickyApplyMarks(current.text,current.marks,selected.start,selected.end,patch)};
      // Formatting is an explicit user action, unlike blur or a delayed Host response.
      commit(next,null);element.current.focus({preventScroll:true});restoreSelection(selected,'format');reportSelection();
    }});
  }
  function commit(next,selection,record=true,reason='input') {
    const previous=value.current;
    next={text:next.text,marks:stickyNormalizeMarks(next.text,next.marks)};
    if(JSON.stringify(next)!==JSON.stringify(previous)) {
      if(record){history.current.undo.push({value:previous,selection:pendingSelection.current||selectionOffsets()});if(history.current.undo.length>100)history.current.undo.shift();history.current.redo=[];}
      value.current=next;
      callbacks.current.onChange?.({text:next.text,marks:stickyPackMarks(next.text,next.marks,callbacks.current.note.marks)});
    }
    // Native edits mutate DOM even when the canonical model is unchanged.
    renderStamp.current='';draw(selection,reason);pendingSelection.current=null;
  }
  function syncNative(reason='input') {
    if(!editorPolicy(reason).commitNative)return;
    const dom=readDOM(),selection=editorPolicy(reason).restoreSelection?selectionOffsets(dom):null,edit=nativeEdit.current;nativeEdit.current=null;
    let next;
    // Known selection disambiguates edits to repeated characters at style boundaries.
    if(edit&&dom.text.startsWith(value.current.text.slice(0,edit.start))&&dom.text.endsWith(value.current.text.slice(edit.end))) {
      const insertedLength=dom.text.length-(value.current.text.length-(edit.end-edit.start));
      next=insertedLength>=0?stickyReplaceText(value.current.text,value.current.marks,edit.start,edit.end,dom.text.slice(edit.start,edit.start+insertedLength)):null;
    }
    commit(next||stickyReconcileText(value.current.text,value.current.marks,dom.text),selection,true,reason);
    if(reason!=='blur')reportSelection();
  }
  function insertText(text) {
    const selected=selectionOffsets()||{start:value.current.text.length,end:value.current.text.length};
    const next=stickyReplaceText(value.current.text,value.current.marks,selected.start,selected.end,text);
    const offset=selected.start+String(text).replace(/\r\n?/g,'\n').length;
    pendingSelection.current=selected;commit(next,{start:offset,end:offset});reportSelection();
  }
  function undo(redo=false) {
    const h=history.current,from=redo?h.redo:h.undo,to=redo?h.undo:h.redo,entry=from.pop();if(!entry)return;
    to.push({value:value.current,selection:selectionOffsets()});commit(entry.value,entry.selection,false);reportSelection();
  }
  useLayoutEffect(()=>{
    const next={text:note.text||'',marks:stickyNormalizeMarks(note.text||'',note.marks)};
    if(composing.current)return;
    if(JSON.stringify(next)!==JSON.stringify(value.current)){const selected=editorPolicy('props').restoreSelection?selectionOffsets():null;value.current=next;history.current={undo:[],redo:[]};draw(selected,'props');}
    else draw();
  },[note.text,note.marks]);
  useEffect(()=>{
    const root=element.current,document=root.ownerDocument;
    const beforeInput=e=>{
      if(composing.current||e.isComposing)return;
      if(e.inputType==='historyUndo'||e.inputType==='historyRedo'){e.preventDefault();undo(e.inputType==='historyRedo');return;}
      if(e.inputType==='insertParagraph'){e.preventDefault();callbacks.current.onEnter?.();return;}
      if(e.inputType==='insertLineBreak'){e.preventDefault();insertText('\n');return;}
      if(e.inputType?.startsWith('format')){e.preventDefault();return;}
      const selection=selectionOffsets();pendingSelection.current=selection;
      let edit=selection&&{...selection};
      if(edit&&edit.start===edit.end){
        const text=value.current.text;
        const high=n=>n>=0xD800&&n<=0xDBFF,low=n=>n>=0xDC00&&n<=0xDFFF;
        if(e.inputType==='deleteContentBackward'&&edit.start>0){edit.start--;if(edit.start>0&&low(text.charCodeAt(edit.start))&&high(text.charCodeAt(edit.start-1)))edit.start--;}
        if(e.inputType==='deleteContentForward'&&edit.end<text.length){if(high(text.charCodeAt(edit.end))&&low(text.charCodeAt(edit.end+1)))edit.end+=2;else edit.end++;}
      }
      nativeEdit.current=edit;
    };
    document.addEventListener('selectionchange',reportSelection);root.addEventListener('beforeinput',beforeInput);
    return()=>{document.removeEventListener('selectionchange',reportSelection);root.removeEventListener('beforeinput',beforeInput);};
  },[]);
  return h('div',{
    ref:node=>{element.current=node;if(typeof editorRef==='function')editorRef(node);else if(editorRef)editorRef.current=node;},className:'st-text st-rich-editor',contentEditable:true,suppressContentEditableWarning:true,
    'data-rich-editor':true,'data-placeholder':placeholder||'','data-empty':!value.current.text,
    role:'textbox','aria-multiline':true,'aria-label':ariaLabel||tr('title'),'aria-placeholder':placeholder,spellCheck:true,
    style:{fontSize:note.fontSize||12,color:colors[note.color]||colors.default,whiteSpace:'pre-wrap',overflowWrap:'anywhere',minHeight:'1.5em',outline:'none'},
    onFocus:e=>{blurred.current=false;callbacks.current.onFocus?.(e);reportSelection();},
    onBlur:e=>{
      // activeElement may still be the old editor during focusout: revoke authority first.
      blurred.current=true;
      // Persist even an in-progress IME snapshot, without rebuilding its composing DOM.
      // A later compositionend reconciles the final text but may not move focus back.
      syncNative('blur');callbacks.current.onBlur?.(e);
    },
    onInput:()=>{if(!composing.current)syncNative();},
    onCompositionStart:()=>{composing.current=true;nativeEdit.current=selectionOffsets();pendingSelection.current=nativeEdit.current;},
    onCompositionEnd:()=>{composing.current=false;syncNative();},
    onPaste:e=>{e.preventDefault();if(!composing.current)insertText(e.clipboardData.getData('text/plain'));},
    onDragOver:e=>e.preventDefault(),onDrop:e=>{e.preventDefault();},
    onKeyDown:e=>{
      if(e.nativeEvent.isComposing||composing.current||e.keyCode===229)return;
      if(e.altKey&&['ArrowUp','ArrowDown'].includes(e.key)){callbacks.current.onMoveKey?.(e);return;}
      if((e.metaKey||e.ctrlKey)&&!e.altKey&&e.key.toLowerCase()==='z'){e.preventDefault();undo(e.shiftKey);return;}
      if(e.ctrlKey&&!e.metaKey&&e.key.toLowerCase()==='y'){e.preventDefault();undo(true);return;}
      if(e.key==='Enter'){e.preventDefault();if(e.shiftKey)insertText('\n');else callbacks.current.onEnter?.();}
    },
  });
}
