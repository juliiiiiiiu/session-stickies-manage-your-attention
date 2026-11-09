import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('./client-source.js',import.meta.url),'utf8');
test('full-height transparent shells pass clicks through while content-sized scrolling and controls remain interactive',()=>{
 assert.match(source,/\.st-position\{[^}]*pointer-events:none/);
 assert.match(source,/\.st-board\{[^}]*pointer-events:none/);
 assert.match(source,/\.st-board-scroll\{[^}]*pointer-events:auto;flex:0 1 auto;/);
 for(const name of ['st-board-tools','st-board-notice'])assert.match(source,new RegExp('\\.'+name+'\\{[^}]*pointer-events:auto'));
 assert.match(source,/\.st-board>\.st-error\{[^}]*pointer-events:auto/);
});
const code=source.split('// PANEL GEOMETRY START')[1].split('\n').slice(1).join('\n').split('// PANEL GEOMETRY END')[0];
const {stickyBoardLayout,stickyResizeCard,stickyNewShortcut,stickyShouldPinFooter,stickyColumnLeft}=new Function(code+';return {stickyBoardLayout,stickyResizeCard,stickyNewShortcut,stickyShouldPinFooter,stickyColumnLeft};')();
const viewport={width:1512,height:949},geometry={left:300,top:160,width:170,composerBottom:900};
const cards=[{id:'default'},{id:'second'}];
test('blank and active sessions keep a 16px sidebar gap independently of centered composer position',()=>{
 for(const sidebarEdge of [0,56,280,420])assert.equal(stickyColumnLeft(sidebarEdge+20),sidebarEdge+16);
 assert.equal(stickyColumnLeft(300),296); // Hero's dock may be at 500; the column still starts at 296.
 assert.equal(stickyColumnLeft(-20),16);
});
test('board bottom follows measured composer bottom rather than a fixed height',()=>{
 for(const bottom of [620,780,900]){const result=stickyBoardLayout(cards,{}, {...geometry,composerBottom:bottom},viewport);assert.equal(geometry.top+result.height,bottom);}
});
test('composer alignment clamps stale measurements to the window and never makes a negative height',()=>{
 assert.equal(stickyBoardLayout(cards,{}, {...geometry,composerBottom:1200},viewport).height,viewport.height-geometry.top);
 assert.equal(stickyBoardLayout(cards,{}, {...geometry,composerBottom:100},viewport).height,0);
});
test('missing composer marker temporarily falls back to the available full-column height',()=>{
 for(const composerBottom of [undefined,NaN,Infinity])assert.equal(stickyBoardLayout(cards,{}, {...geometry,composerBottom},viewport).height,viewport.height-12-geometry.top);
});
test('empty board retains usable New sticky controls without inventing a card',()=>{
 const result=stickyBoardLayout([],{},geometry,viewport);
 assert.deepEqual(result.cardWidths,{});assert.equal(result.width,190);assert.equal(result.height,740);
});
test('tall active cards pin their footer without covering the next card header',()=>{
 const view={top:100,bottom:310,height:210};
 assert.equal(stickyShouldPinFooter({top:103,bottom:503,height:400},view),true);
 assert.equal(stickyShouldPinFooter({top:285,bottom:685,height:400},view),false);
 assert.equal(stickyShouldPinFooter({top:103,bottom:273,height:170},view),false);
 assert.equal(stickyShouldPinFooter({top:-100,bottom:300,height:400},view),false);
});
test('default card remains square-sized inside a composer-bottom-aligned board',()=>{
 const result=stickyBoardLayout([cards[0]],{},geometry,viewport);
 assert.equal(result.cardWidths.default,170);assert.equal(result.height,740);assert.equal(result.width,190);
});
test('container hugs the largest independently sized card plus scrollbar/handle space',()=>{
 const result=stickyBoardLayout(cards,{default:{width:156},second:{width:310,height:600}},geometry,viewport);
 assert.deepEqual(result.cardWidths,{default:156,second:310});assert.equal(result.width,330);assert.equal(result.height,740);
 const smaller=stickyBoardLayout([cards[0]],{default:{width:156}},geometry,viewport);
 assert.equal(smaller.width,176);
});
test('saved card sizes adapt to a smaller window without widening the chat column',()=>{
 const result=stickyBoardLayout(cards,{default:{width:800},second:{width:NaN}},geometry,{width:480,height:400});
 assert.equal(result.maxCardWidth,148);assert.equal(result.width,168);assert.deepEqual(result.cardWidths,{default:148,second:148});
 assert.equal(result.height,400-geometry.top);assert.equal(result.maxCardHeight,340);
});
test('invalid saved widths fall back safely and optional sizes may be absent',()=>{
 assert.equal(stickyBoardLayout(cards,null,geometry,viewport).cardWidths.second,170);
 assert.equal(stickyBoardLayout(cards,{default:{width:-20}},geometry,viewport).cardWidths.default,156);
 assert.equal(stickyBoardLayout(cards,{default:{width:Infinity}},geometry,viewport).cardWidths.default,170);
});
const bounds={minWidth:156,maxWidth:1180,minHeight:112,maxHeight:889};
test('right-only resize changes width without locking or shortening natural height',()=>{
 const start={width:170,height:1300};const result=stickyResizeCard(start,'e',100,200,bounds);
 assert.deepEqual(result,{width:270,height:1300});assert.deepEqual(start,{width:170,height:1300});
});
test('bottom and corner card resizing respect usable dimensions and window bounds',()=>{
 assert.deepEqual(stickyResizeCard({width:170,height:170},'s',100,80,bounds),{width:170,height:250});
 assert.deepEqual(stickyResizeCard({width:170,height:170},'se',9999,9999,bounds),{width:1180,height:889});
 assert.deepEqual(stickyResizeCard({width:170,height:170},'se',-9999,-9999,bounds),{width:156,height:112});
});
const event={code:'KeyN',key:'˜',altKey:true,shiftKey:true,metaKey:true,ctrlKey:false,isComposing:false,repeat:false,defaultPrevented:false};
test('Mac shortcut uses Command rather than the conflicting VoiceOver Control chord',()=>{
 assert.equal(stickyNewShortcut(event,true),true);
 assert.equal(stickyNewShortcut({...event,metaKey:false,ctrlKey:true},true),false);
 assert.equal(stickyNewShortcut({...event,shiftKey:false},true),false);
 assert.equal(stickyNewShortcut({...event,ctrlKey:true},true),false);
});
test('Windows shortcut is exact Control+Alt+Shift+N and does not take DSH new-session',()=>{
 const win={...event,metaKey:false,ctrlKey:true};
 assert.equal(stickyNewShortcut(win,false),true);
 assert.equal(stickyNewShortcut({...win,shiftKey:false},false),false);
 assert.equal(stickyNewShortcut({...win,metaKey:true},false),false);
 assert.equal(stickyNewShortcut({...win,code:'KeyM'},false),false);
});
test('shortcut leaves composition, key repeat, handled events and AltGraph untouched',()=>{
 for(const patch of [{isComposing:true},{keyCode:229},{repeat:true},{defaultPrevented:true},{getModifierState:k=>k==='AltGraph'}])assert.equal(stickyNewShortcut({...event,...patch},true),false);
});
