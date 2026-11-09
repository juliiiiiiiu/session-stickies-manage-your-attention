import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('./client-source.js',import.meta.url),'utf8');
const code=source.split('// PANEL GEOMETRY START')[1].split('\n').slice(1).join('\n').split('// PANEL GEOMETRY END')[0];
const {stickyPanelRect,stickyResizeRect,stickyGutterGeometry,stickyIsCollapsed}=new Function(code+';return {stickyPanelRect,stickyResizeRect,stickyGutterGeometry,stickyIsCollapsed};')();
const base={left:300,top:160,width:170,maxWidth:220,maxHeight:300};
const viewport={width:1512,height:949};
const bounds=stickyPanelRect(null,base,viewport);
const start={left:300,top:160,width:170,height:190};
test('narrow gutters default to collapsed but explicit expansion wins',()=>{
 const g=stickyGutterGeometry(300,160,70,viewport);
 assert.equal(g.narrow,true);assert.equal(g.width,170);
 assert.equal(stickyIsCollapsed(null,g.narrow),true);
 assert.equal(stickyIsCollapsed(false,g.narrow),false);
 assert.equal(stickyIsCollapsed(true,false),true);
 assert.equal(stickyIsCollapsed(null,false),false);
});
test('manual expansion may cover chat, bounded by the window rather than gutter',()=>{
 const g=stickyGutterGeometry(300,160,70,viewport);
 const panel=stickyPanelRect({width:700,height:600,topOffset:0},g,viewport);
 assert.equal(panel.width,700);assert.equal(panel.height,600);assert.equal(panel.left,300);
 assert.equal(g.maxWidth,1200);
 const huge=stickyResizeRect(start,'se',9999,9999,panel);
 assert.equal(huge.width,1200);assert.equal(huge.height,777);
});
test('wide gutters retain the ordinary compact expanded layout',()=>{
 const g=stickyGutterGeometry(300,160,215,viewport);
 assert.equal(g.narrow,false);assert.equal(g.width,170);assert.equal(g.maxHeight,300);
});
test('default remains content-sized; saved dimensions stay inside configured bounds',()=>{
 assert.equal(bounds.height,undefined);assert.equal(bounds.width,170);
 const saved=stickyPanelRect({width:600,height:900,topOffset:0},base,viewport);
 assert.equal(saved.width,220);assert.equal(saved.left,300);assert.equal(saved.height,777);
});
test('right edge and lower corner resize without moving the left or top edge',()=>{
 assert.deepEqual(stickyResizeRect(start,'e',30,99,bounds),{...start,width:200});
 assert.deepEqual(stickyResizeRect(start,'se',30,80,bounds),{...start,width:200,height:270});
});
test('upper corner preserves bottom; left corners are vertical-only',()=>{
 const ne=stickyResizeRect(start,'ne',20,-50,bounds);
 assert.equal(ne.left,300);assert.equal(ne.width,190);assert.equal(ne.top,110);assert.equal(ne.top+ne.height,350);
 assert.deepEqual(stickyResizeRect(start,'nw',400,-50,bounds),{...start,top:110,height:240});
 assert.deepEqual(stickyResizeRect(start,'sw',400,40,bounds),{...start,height:230});
});
test('dragging past limits clamps usable minimum and viewport bounds',()=>{
 const small=stickyResizeRect(start,'se',-1000,-1000,bounds);
 assert.equal(small.width,156);assert.equal(small.height,112);
 const big=stickyResizeRect(start,'ne',1000,-1000,bounds);
 assert.equal(big.width,220);assert.equal(big.top,48);assert.equal(big.left,300);
 assert.equal(stickyResizeRect(start,'s',0,10000,bounds).height,777);
});
test('saved geometry adapts to a smaller viewport and expanded format controls',()=>{
 const r=stickyPanelRect({width:200,height:700,topOffset:400},{...base,maxWidth:150,minHeight:174},{width:900,height:500});
 assert.equal(r.left,300);assert.equal(r.width,150);assert.ok(r.top+r.height<=488);assert.equal(r.height,174);
});
test('all handle paths keep the left edge invariant',()=>{
 for(const edge of ['n','e','s','ne','se','nw','sw'])for(const dx of [-500,0,500])for(const dy of [-500,0,500]){
  const r=stickyResizeRect(start,edge,dx,dy,bounds);
  assert.equal(r.left,start.left);assert.ok(r.width>=bounds.minWidth&&r.width<=bounds.maxWidth);
  assert.ok(r.height>=bounds.minHeight);assert.ok(r.top>=bounds.minTop&&r.top+r.height<=bounds.bottom);
 }
});
