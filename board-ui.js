// Embedded in the mounted Stickies Client context; only plugin-owned DOM is measured.
const DEFAULT_STICKY_CARD={id:'default',title:'Stickies'};
const isMacSticky=()=>/Mac|iPhone|iPad/.test(navigator.userAgentData?.platform||navigator.platform||'');
const stickyShortcutLabel=()=>isMacSticky()?'⌘⌥⇧N':'Ctrl+Alt+Shift+N';
function stickyReadLocal(key,fallback){try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}}
function stickyWriteLocal(key,value){try{localStorage.setItem(key,JSON.stringify(value));}catch{}}

function StickyTitle({card,store,count,onDeleteCard,deleting}){
  const t=useLanguage(),[editing,setEditing]=useState(false),[title,setTitle]=useState(card.title),[error,setError]=useState(''),[pending,setPending]=useState(false);
  const ref=useRef(null),cancel=useRef(false),saving=useRef(null),headerRef=useRef(null);
  const [deleteOpen,setDeleteOpen]=useState(false);
  useEffect(()=>{if(!deleteOpen)return;const outside=e=>{if(!deleting&&!headerRef.current?.contains(e.target))setDeleteOpen(false);},key=e=>{if(e.key==='Escape'&&!deleting)setDeleteOpen(false);};document.addEventListener('pointerdown',outside);document.addEventListener('keydown',key);return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',key);};},[deleteOpen,deleting]);
  useEffect(()=>{if(!editing&&!error&&!pending)setTitle(card.title);},[card.title,editing,error,pending]);
  useLayoutEffect(()=>{if(editing){ref.current?.focus({preventScroll:true});ref.current?.select();}},[editing]);
  const save=async()=>{
    if(cancel.current){cancel.current=false;return;}
    const next=title.trim();
    if(!next){setTitle(card.title);setEditing(false);return;}
    if(saving.current)return;
    if(next===card.title){setEditing(false);setError('');return;}
    saving.current=next;setPending(true);setTitle(next);setEditing(false);
    try{await store.run({action:'renameCard',id:card.id,title:next});setError('');}
    catch(e){setError(e.message);}
    finally{saving.current=null;setPending(false);}
  };
  return h('header',{ref:headerRef,className:'st-header st-card-header'},
    h('div',{className:'st-title-group'},editing?
      h('input',{ref,className:'st-title-input',value:title,maxLength:200,'aria-label':t('renameSticky'),onChange:e=>setTitle(e.target.value),onBlur:()=>save(),onKeyDown:e=>{
        if(e.nativeEvent.isComposing||e.keyCode===229)return;
        if(e.key==='Enter'){e.preventDefault();save();}
        if(e.key==='Escape'){e.preventDefault();cancel.current=true;setTitle(card.title);setError('');setEditing(false);}
      }}):
      h(Button,{className:'st-card-title'+(error?' st-title-error':''),disabled:pending,label:error?title+' · '+error:title,'aria-label':t('renameSticky')+': '+title,onClick:()=>{cancel.current=false;setEditing(true);},'data-title-editor':card.id},title),
      count>0&&h('span',{className:'st-count'},count)),
    h(Button,{className:'st-card-delete',label:t('deleteSticky'),icon:'trash','aria-expanded':deleteOpen,disabled:deleting||pending,onClick:()=>setDeleteOpen(v=>!v)}),
    deleteOpen&&h('div',{className:'st-card-delete-confirm',role:'alertdialog','aria-label':t('deleteSticky')+': '+card.title},h('p',null,t('deleteStickyAsk')),h('div',null,h(Button,{label:t('cancel'),disabled:deleting,onClick:()=>setDeleteOpen(false)},t('cancel')),h(Button,{className:'st-confirm-delete',label:t('deleteSticky'),disabled:deleting,onClick:onDeleteCard},deleting?'…':t('confirmDelete')))));

}

function StickyColors({value,onChange}){
  const t=useLanguage();
  const colors={default:'var(--st-ink)',accent:'var(--st-accent)',success:'var(--dsw-alias-state-success-primary)',warn:'var(--dsw-alias-state-warn-primary)',error:'var(--dsw-alias-state-error-primary)'};
  return h('div',{className:'st-color-swatches',role:'group','aria-label':t('color')},...Object.entries(colors).map(([color,background])=>h(Button,{key:color,className:'st-color-dot',style:{background},label:t(color==='error'?'danger':color),'aria-pressed':value===color,onMouseDown:e=>e.preventDefault(),onClick:()=>onChange(color)})));
}
function StickySelectionTools({selection,toolsRef}){
  const t=useLanguage();if(!selection)return null;
  return h('div',{ref:toolsRef,className:'st-selection-tools',role:'toolbar','aria-label':t('format'),style:{left:Math.max(8,Math.min(selection.rect.left,window.innerWidth-220)),top:selection.rect.top>76?selection.rect.top-70:selection.rect.bottom+6}},
    h('select',{'aria-label':t('format'),value:selection.fontSize||12,onChange:e=>selection.apply({fontSize:Number(e.target.value)})},...[10,12,14,16,20,24,32].map(size=>h('option',{key:size,value:size},size))),
    h(StickyColors,{value:selection.color||'default',onChange:color=>selection.apply({color})}),
    h(Button,{label:t('bold'),icon:'bold','aria-pressed':!!selection.bold,onMouseDown:e=>e.preventDefault(),onClick:()=>selection.apply({bold:!selection.bold})}));
}

function StickyCard({sessionId,card,cardIndex,palette,store,state,width,savedSize,maxWidth,maxHeight,onSize,onSelection,selection,toolsRef,onRenameFocus,onFocusConsumed}){
  const t=useLanguage(),rootRef=useRef(null),draftRef=useRef(null),runButtonRef=useRef(null),runPopoverRef=useRef(null),resize=useRef(null);
  const settingsKey='dsh-stickies-draft-settings:'+sessionId+':'+card.id;
  const [formatOpen,setFormatOpen]=useState(false),[focused,setFocused]=useState(null),[settings,setSettings]=useState(()=>{const v=stickyReadLocal(settingsKey,{}),migrationKey=settingsKey+':bullet-default-v1';const migrated=stickyReadLocal(migrationKey,false);if(!migrated){if(v.style==='checkbox')v.style='bullet';stickyWriteLocal(migrationKey,true);}return {style:['text','checkbox','bullet','numbered'].includes(v?.style)?v.style:'bullet',fontSize:Number.isInteger(v?.fontSize)&&v.fontSize>=10&&v.fontSize<=32?v.fontSize:12,color:['default','accent','success','warn','error'].includes(v?.color)?v.color:'default'};});
  useEffect(()=>stickyWriteLocal(settingsKey,settings),[settingsKey,settings]);
  const [runOpen,setRunOpen]=useState(false),[runAnchor,setRunAnchor]=useState(null),[runMode,setRunMode]=useState('execute'),[busy,setBusy]=useState(false);
  const [drag,setDrag]=useState(null),[drop,setDrop]=useState(null),[footerPinned,setFooterPinned]=useState(false),[deleting,setDeleting]=useState(false);
  useLayoutEffect(()=>{
    const node=rootRef.current,scroll=node?.parentElement;if(!scroll?.classList.contains('st-board-scroll'))return;
    const update=()=>{const r=node.getBoundingClientRect(),v=scroll.getBoundingClientRect();setFooterPinned(stickyShouldPinFooter({height:node.offsetHeight,top:r.top,bottom:r.bottom},{height:scroll.clientHeight,top:v.top,bottom:v.bottom}));};
    const observer=new ResizeObserver(update);observer.observe(node);observer.observe(scroll);scroll.addEventListener('scroll',update,{passive:true});update();
    return()=>{observer.disconnect();scroll.removeEventListener('scroll',update);};
  },[]);
  // Keep legacy default-card draft keys, so upgrades cannot strand existing drafts.
  const suffix=sessionId+(card.id==='default'?'':':'+card.id),draftKey='dsh-stickies-draft:'+suffix,marksKey='dsh-stickies-draft-marks:'+suffix;
  const [draft,setDraft]=useState(()=>{try{return localStorage.getItem(draftKey)||'';}catch{return '';}}),draftValue=useRef(draft);
  const [marks,setMarks]=useState(()=>stickyReadLocal(marksKey,[])),marksValue=useRef(marks);
  const deleteCard=async()=>{
    if(deleting)return;setDeleting(true);onSelection(null);setRunOpen(false);
    try{await store.flushAll();await store.run({action:'deleteCard',id:card.id});for(const key of [draftKey,marksKey,settingsKey,settingsKey+':bullet-default-v1']){try{localStorage.removeItem(key);}catch{}}onSize(card.id,null);}
    finally{setDeleting(false);}
  };
  const draftId='draft:'+card.id;
  const active=state.notes.filter(n=>!n.archivedAt&&(n.cardId||'default')===card.id),count=active.filter(n=>n.text.trim()).length;
  const manualHeight=Number.isFinite(savedSize?.height)?stickyClamp(savedSize.height,formatOpen?174:112,maxHeight):undefined;
  const saveDraft=patch=>{draftValue.current=patch.text;marksValue.current=patch.marks||[];setDraft(patch.text);setMarks(marksValue.current);try{localStorage.setItem(draftKey,patch.text);}catch{}stickyWriteLocal(marksKey,marksValue.current);};
  const commitDraft=async(focusNext=false)=>{
    const origin=document.activeElement,text=draftValue.current;if(!text.trim())return;
    const note={id:crypto.randomUUID(),cardId:card.id,text,marks:marksValue.current,...settings,checked:false,archivedAt:null,createdAt:Date.now(),updatedAt:Date.now()};
    saveDraft({text:'',marks:[]});onSelection(null);
    try{await store.create(note);if(focusNext&&document.activeElement===origin&&rootRef.current?.contains(origin))draftRef.current?.focus();}catch{/* Recovery journal owns failed optimistic creates. */}
  };
  const focusNext=async id=>{
    const origin=document.activeElement;await store.flush(id);
    if(document.activeElement!==origin||!rootRef.current?.contains(origin))return;
    const index=active.findIndex(n=>n.id===id),next=active[index+1];
    if(next)rootRef.current.querySelector(`[data-note-id="${next.id}"] [contenteditable]`)?.focus();else draftRef.current?.focus();
  };
  const move=async(id,delta)=>{const ids=active.map(n=>n.id),index=ids.indexOf(id),target=index+delta;if(index<0||target<0||target>=ids.length)return;[ids[index],ids[target]]=[ids[target],ids[index]];await store.run({action:'reorder',cardId:card.id,ids});};
  useEffect(()=>{
    if(!drag)return;
    const end=()=>{if(drop&&drop!==drag){const ids=active.map(n=>n.id);ids.splice(ids.indexOf(drag),1);ids.splice(ids.indexOf(drop),0,drag);store.run({action:'reorder',cardId:card.id,ids}).catch(()=>{});}setDrag(null);setDrop(null);};
    window.addEventListener('pointerup',end,{once:true});return()=>window.removeEventListener('pointerup',end);
  },[drag,drop,active.map(n=>n.id).join('|'),store,card.id]);
  useEffect(()=>{
    if(!runOpen)return;
    const outside=e=>{if(!runButtonRef.current?.contains(e.target)&&!runPopoverRef.current?.contains(e.target)&&!busy)setRunOpen(false);};
    const close=()=>setRunOpen(false);const key=e=>{if(e.key==='Escape'&&!busy)close();};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',key);window.addEventListener('resize',close);window.addEventListener('scroll',close,true);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',key);window.removeEventListener('resize',close);window.removeEventListener('scroll',close,true);};
  },[runOpen,busy]);
  useLayoutEffect(()=>{
    if(!onRenameFocus||onRenameFocus.id!==card.id)return;
    if(document.activeElement===onRenameFocus.origin){rootRef.current?.scrollIntoView({block:'nearest',inline:'nearest'});rootRef.current?.querySelector('[data-title-editor]')?.click();}
    onFocusConsumed();
  },[onRenameFocus,card.id]);
  const applyFormat=(key,value)=>{if(focused)store.change(focused,{[key]:value});else setSettings(s=>({...s,[key]:value}));};
  const focusedNote=active.find(n=>n.id===focused)||settings;
  const toolbar=formatOpen&&h('div',{className:'st-toolbar'},
    h('select',{'aria-label':t('format'),value:focusedNote.fontSize,onChange:e=>applyFormat('fontSize',Number(e.target.value))},...[12,14,16].map(size=>h('option',{key:size,value:size},size))),
    h('div',{className:'st-style-buttons',role:'group','aria-label':t('style')},...Object.entries({checkbox:'list-todo',bullet:'list-bullet',numbered:'list-numbered',text:'plain-text'}).map(([style,icon])=>h(Button,{key:style,icon,label:t(style),'aria-pressed':focusedNote.style===style,onMouseDown:e=>e.preventDefault(),onClick:()=>applyFormat('style',style)}))),
    h(StickyColors,{value:focusedNote.color,onChange:color=>applyFormat('color',color)}));
  const startResize=(e,edge)=>{
    if(e.button!==0)return;e.preventDefault();e.stopPropagation();const r=rootRef.current.getBoundingClientRect();
    resize.current={pointer:e.pointerId,edge,x:e.clientX,y:e.clientY,width:r.width,height:r.height};
    onSelection(null);setRunOpen(false);e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveResize=e=>{
    const start=resize.current;if(!start||start.pointer!==e.pointerId)return;e.preventDefault();
    const next=stickyResizeCard(start,start.edge,e.clientX-start.x,e.clientY-start.y,{minWidth:Math.min(156,maxWidth),maxWidth,minHeight:formatOpen?174:112,maxHeight});
    onSize(card.id,{width:next.width,...(start.edge.includes('s')?{height:next.height}:Number.isFinite(savedSize?.height)?{height:savedSize.height}:{})});
  };
  const endResize=e=>{if(resize.current?.pointer!==e.pointerId)return;resize.current=null;if(e.currentTarget.hasPointerCapture?.(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);};
  const handles=['e','s','se'].map(edge=>h('div',{key:edge,className:'st-resize st-resize-'+edge,role:'button',tabIndex:0,'aria-label':t('resizeSticky')+' '+edge,title:t('resizeSticky'),onPointerDown:e=>startResize(e,edge),onPointerMove:moveResize,onPointerUp:endResize,onPointerCancel:endResize,onLostPointerCapture:endResize,onDoubleClick:()=>onSize(card.id,null),onKeyDown:e=>{
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();const r=rootRef.current.getBoundingClientRect(),step=e.shiftKey?24:8;
    const next=stickyResizeCard(r,edge,e.key==='ArrowLeft'?-step:e.key==='ArrowRight'?step:0,e.key==='ArrowUp'?-step:e.key==='ArrowDown'?step:0,{minWidth:Math.min(156,maxWidth),maxWidth,minHeight:formatOpen?174:112,maxHeight});
    onSize(card.id,{width:next.width,...(edge.includes('s')?{height:next.height}:Number.isFinite(savedSize?.height)?{height:savedSize.height}:{})});setRunOpen(false);onSelection(null);
  }}));
  const cardNoteIds=new Set(state.notes.filter(n=>(n.cardId||'default')===card.id).map(n=>n.id));
  const queueItems=state.queue?.items?.filter(i=>cardNoteIds.has(i.noteId))||[];
  const queueActive=queueItems.some(i=>['pending','running','dispatching'].includes(i.status));
  const queueBlocked=['armed','running'].includes(state.queue?.status)||state.queue?.items?.some(i=>['pending','running','dispatching'].includes(i.status));
  const switchOn=queueActive&&state.queue?.status!=='paused';
  const toggleAuto=async()=>{
    if(busy)return;setBusy(true);setRunOpen(false);
    try{
      if(switchOn){
        await store.run({action:'pause'});
        for(const item of store.get().queue.items.filter(i=>cardNoteIds.has(i.noteId)&&i.status==='pending'))await store.run({action:'cancelItem',id:item.id});
      }else{
        await commitDraft();await store.flushAll();
        const notes=store.get().notes.filter(n=>(n.cardId||'default')===card.id&&!n.archivedAt&&!n.checked&&n.text.trim());
        if(!notes.length||notes.length>100)return;
        await store.run({action:'queue',replacePending:false,items:notes.map(n=>({id:n.id,mode:runMode}))});
      }
    }finally{setBusy(false);}
  };
  const runPopover=runOpen&&runAnchor&&h('div',{ref:runPopoverRef,className:'st-mode-menu',role:'menu','aria-label':'Auto mode',style:{left:runAnchor.left,bottom:runAnchor.bottom}},...['execute','answer'].map(mode=>h(Button,{key:mode,role:'menuitemradio','aria-checked':runMode===mode,label:mode==='execute'?'Auto execute':'Answer only',onClick:()=>{setRunMode(mode);setRunOpen(false);}},mode==='execute'?'Auto execute':'Answer only')));
  return h(React.Fragment,null,
    h('section',{ref:rootRef,className:'st-panel st-card',inert:deleting?true:undefined,'aria-busy':deleting,'data-card-id':card.id,'data-style':palette,'data-palette':cardIndex%6,'data-footer-pinned':footerPinned,'data-sized':manualHeight!==undefined,style:{width,height:manualHeight,minHeight:manualHeight===undefined?width:formatOpen?174:112,maxHeight:'none'},'aria-label':card.title},
      h(StickyTitle,{card,store,count,onDeleteCard:deleteCard,deleting}),toolbar,
      h('div',{className:'st-scroll st-card-body'},...active.map((note,index)=>h(NoteRow,{key:note.id,note,index,store,onFocus:setFocused,onEnter:id=>focusNext(id).catch(()=>{}),onMove:(id,delta)=>move(id,delta).catch(()=>{}),onSelection,drag,setDrag,drop,setDrop})),
        h('div',{className:'st-row','data-style':settings.style},settings.style==='checkbox'?h('span',{className:'st-mark st-draft-check','aria-hidden':true}):h('span',{className:'st-mark','aria-hidden':true},settings.style==='bullet'?'✿':settings.style==='numbered'?`${active.length+1}.`:''),h(RichEditor,{editorRef:draftRef,note:{id:draftId,text:draft,marks,...settings},placeholder:count?'':t('empty'),ariaLabel:card.title+' '+t('empty'),onFocus:()=>setFocused(null),onChange:saveDraft,onBlur:e=>{if(e.relatedTarget?.closest?.('.st-selection-tools'))return;commitDraft().catch(()=>{});},onEnter:()=>commitDraft(true).catch(()=>{}),onSelection:value=>onSelection(prev=>value||(toolsRef.current?.contains(document.activeElement)?prev:prev?.noteId===draftId?null:prev))}))),
      h('footer',{className:'st-footer st-footer-minimal'},
        h('div',{className:'st-footer-controls'},h('div',{className:'st-auto-controls'},h(Button,{className:'st-auto-switch',role:'switch','aria-checked':switchOn,label:switchOn?'Turn off and cancel pending follow-ups; running work continues':'Authorize current notes only; starts after the current turn, or immediately if idle',disabled:busy||(!switchOn&&(queueBlocked||(!active.some(n=>!n.checked&&n.text.trim())&&!draft.trim())||active.filter(n=>!n.checked&&n.text.trim()).length>100)),onClick:toggleAuto},h('span',{'aria-hidden':true})),
          h('div',{ref:runButtonRef,className:'st-mode-anchor'},h(Button,{className:'st-auto-run',label:runMode==='execute'?'Auto execute':'Answer only','aria-haspopup':'menu','aria-expanded':runOpen,disabled:busy||switchOn,onClick:()=>{const r=runButtonRef.current?.getBoundingClientRect();if(r)setRunAnchor({left:Math.max(8,Math.min(r.left,window.innerWidth-160)),bottom:window.innerHeight-r.top+4});setRunOpen(v=>!v);}},runMode==='execute'?'Auto execute':'Answer only',h(Icon,{name:'down'})))),
        h(Button,{className:'st-format-toggle',label:t('format'),icon:'type','aria-expanded':formatOpen,onClick:()=>setFormatOpen(v=>!v)}))),...handles),runPopover);
}

function Widget({sessionId,geometry}){
  const t=useLanguage(),store=sessionStore(sessionId),state=useSyncExternalStore(store.subscribe,store.get);
  const [collapsed,setCollapsed]=useState(null),[selection,setSelection]=useState(null),[creating,setCreating]=useState(false),[focusCard,setFocusCard]=useState(null);
  const paletteKey='dsh-stickies-palette', readPalette=()=>{const value=stickyReadLocal(paletteKey,'classic');return ['classic','morandi','bold'].includes(value)?value:'classic';};
  const [palette,setPalette]=useState(readPalette),[paletteOpen,setPaletteOpen]=useState(false);
  const toolsRef=useRef(null),rootRef=useRef(null),newCardId=useRef(null),creatingRef=useRef(false),paletteRef=useRef(null),paletteButtonRef=useRef(null);
  useEffect(()=>{const sync=()=>setPalette(readPalette());window.addEventListener('storage',sync);window.addEventListener('dsh-stickies-palette',sync);return()=>{window.removeEventListener('storage',sync);window.removeEventListener('dsh-stickies-palette',sync);};},[]);
  useEffect(()=>{if(!paletteOpen)return;const outside=e=>{if(!paletteRef.current?.contains(e.target))setPaletteOpen(false);};const key=e=>{if(e.key==='Escape'){setPaletteOpen(false);paletteButtonRef.current?.focus();}};document.addEventListener('pointerdown',outside);document.addEventListener('keydown',key);return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',key);};},[paletteOpen]);
  const choosePalette=value=>{stickyWriteLocal(paletteKey,value);setPalette(value);window.dispatchEvent(new Event('dsh-stickies-palette'));setPaletteOpen(false);paletteButtonRef.current?.focus();};
  const sizeKey='dsh-stickies-cards-size:'+sessionId;
  const [sizes,setSizes]=useState(()=>stickyReadLocal(sizeKey,{}));
  const cards=Array.isArray(state.cards)?state.cards:[DEFAULT_STICKY_CARD];
  const layout=stickyBoardLayout(cards,sizes,geometry,{width:window.innerWidth,height:window.innerHeight});
  const isCollapsed=stickyIsCollapsed(collapsed,geometry.narrow);
  const count=state.notes.filter(n=>!n.archivedAt&&n.text.trim()).length;
  useLayoutEffect(()=>{setCollapsed(null);setSelection(null);},[geometry.narrow]);
  useEffect(()=>{store.refresh().then(()=>store.flushAll()).catch(()=>{});},[store]);
  useEffect(()=>{const focus=()=>store.refresh();window.addEventListener('focus',focus);return()=>window.removeEventListener('focus',focus);},[store]);
  const queueInFlight=state.queue?.items?.some(item=>['running','dispatching'].includes(item.status));
  const pendingItems=state.queue?.items?.filter(item=>item.status==='pending')||[];
  useEffect(()=>{const timer=setInterval(()=>{if(document.visibilityState!=='hidden')store.refresh();},queueInFlight||['armed','running'].includes(state.queue?.status)?1500:5000);return()=>clearInterval(timer);},[queueInFlight,state.queue?.status,store]);
  useEffect(()=>{
    const outside=e=>{if(!toolsRef.current?.contains(e.target)&&!e.target.closest?.('[data-rich-editor]'))setSelection(null);};
    const key=e=>{if(e.key==='Escape')setSelection(null);},clear=()=>setSelection(null);document.addEventListener('pointerdown',outside);document.addEventListener('keydown',key);window.addEventListener('scroll',clear,true);window.addEventListener('resize',clear);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',key);window.removeEventListener('scroll',clear,true);window.removeEventListener('resize',clear);};
  },[]);
  const changeSize=(id,size)=>setSizes(current=>{const next={...current};if(size)next[id]=size;else delete next[id];stickyWriteLocal(sizeKey,next);return next;});
  const newSticky=async()=>{
    if(creatingRef.current||state.loading||cards.length>=50)return;
    const origin=document.activeElement;creatingRef.current=true;setCreating(true);
    const id=newCardId.current||crypto.randomUUID();newCardId.current=id;
    try{await store.flushAll();await store.run({action:'createCard',id,title:'Stickies'});newCardId.current=null;setFocusCard({id,origin});}
    finally{creatingRef.current=false;setCreating(false);}
  };
  useEffect(()=>{
    if(isCollapsed)return;
    const key=e=>{if(!stickyNewShortcut(e,isMacSticky())||creatingRef.current||state.loading||cards.length>=50||e.target.closest?.('dialog,[role=dialog],[role=alertdialog]'))return;e.preventDefault();e.stopPropagation();newSticky().catch(()=>{});};
    document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);
  },[isCollapsed,state.loading,cards.length,store]);
  const toggle=()=>{setCollapsed(v=>!stickyIsCollapsed(v,geometry.narrow));setSelection(null);};
  const preview=h('div',{className:'st-preview'},...state.notes.filter(n=>!n.archivedAt&&n.text.trim()).slice(0,3).map(n=>h('p',{key:n.id},n.text)),!count&&h('p',null,t('empty')));
  return h(React.Fragment,null,h('div',{ref:rootRef,className:'st-position',style:{left:isCollapsed?geometry.left:geometry.left-3,top:isCollapsed?geometry.top-42:geometry.top,width:isCollapsed?82.08:layout.width}},
    isCollapsed?h('div',{className:'st-collapsed'},h(Button,{className:'st-dog-button',label:t('expand')+(count?' · '+count:''),'aria-expanded':false,onClick:toggle},h('img',{src:COLLAPSED_DOG,alt:'',draggable:false}),h('span',{className:'st-expand-mark'},h(Icon,{name:'expand'})),count>0&&h('span',{className:'st-badge'},count)),preview):
      h('div',{className:'st-board',style:{height:layout.height},'aria-label':t('boardLabel')},
        h('div',{className:'st-board-tools',style:{width:layout.cardWidths[cards[0]?.id]||geometry.width}},h('div',{className:'st-board-actions'},h(Button,{className:'st-new-sticky',label:t('newSticky')+' · '+stickyShortcutLabel(),'aria-keyshortcuts':isMacSticky()?'Meta+Alt+Shift+N':'Control+Alt+Shift+N',icon:'new-sticky',disabled:creating||state.loading||cards.length>=50,onClick:newSticky}),h('div',{className:'st-palette-anchor',ref:paletteRef},h('button',{ref:paletteButtonRef,type:'button',className:'st-palette-button',title:t('palette'),'aria-label':t('palette'),'aria-expanded':paletteOpen,'aria-haspopup':'true',onClick:()=>setPaletteOpen(v=>!v)},h(Icon,{name:'palette'})),paletteOpen&&h('div',{className:'st-palette-menu',role:'group','aria-label':t('palette')},...['classic','morandi','bold'].map(value=>h(Button,{key:value,className:'st-palette-option',label:t(value==='classic'?'paletteClassic':value==='morandi'?'paletteMorandi':'paletteBold'),'aria-pressed':palette===value,onClick:()=>choosePalette(value)},h('span',{className:'st-palette-samples','data-style':value,'aria-hidden':true},...[0,1,2].map(i=>h('i',{key:i}))),h('span',null,t(value==='classic'?'paletteClassic':value==='morandi'?'paletteMorandi':'paletteBold')),palette===value&&h(Icon,{name:'check'})))))),h('img',{className:'st-board-dog',src:DOG,alt:'',draggable:false}),h(Button,{className:'st-muted st-collapse-all',label:t('collapse'),'aria-expanded':true,icon:'collapse',onClick:toggle})),
        h('div',{className:'st-board-scroll'},...cards.map((card,index)=>h(StickyCard,{key:card.id,sessionId,card,cardIndex:index,palette,store,state,width:layout.cardWidths[card.id],savedSize:sizes?.[card.id],maxWidth:layout.maxCardWidth,maxHeight:layout.maxCardHeight,onSize:changeSize,onSelection:setSelection,selection,toolsRef,onRenameFocus:focusCard,onFocusConsumed:()=>setFocusCard(null)}))),
        (pendingItems.length>0||queueInFlight)&&h('div',{className:'st-board-notice'},h('span',null,t('sharedQueue')),h(Button,{label:t('pause'),icon:'pause',disabled:state.queue.status==='paused',onClick:()=>store.run({action:'pause'})}),pendingItems.length>0&&h(Button,{label:t('cancelPending'),onClick:async()=>{await store.run({action:'pause'});for(const item of store.get().queue.items.filter(i=>i.status==='pending'))await store.run({action:'cancelItem',id:item.id});}},t('cancelPending'))),
        state.error&&h('div',{className:'st-error',role:'alert'},state.error,h(Button,{label:t('retry'),onClick:async()=>{await store.flushAll();if(store.get().storageError)await store.run({action:'pause'});await store.refresh();}},t('retry'))))),
    !isCollapsed&&h(StickySelectionTools,{selection,toolsRef}));
}
