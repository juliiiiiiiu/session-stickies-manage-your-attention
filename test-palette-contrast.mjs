import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
const source=readFileSync(new URL('./client-source.js',import.meta.url),'utf8');
const channel=c=>{c=parseInt(c,16)/255;return c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4;};
const luminance=hex=>0.2126*channel(hex.slice(1,3))+0.7152*channel(hex.slice(3,5))+0.0722*channel(hex.slice(5,7));
const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);};
const ink=['#202a28','#194a80','#14552f','#694600','#85202e'];
for(const style of ['morandi','bold'])for(let i=0;i<6;i++)test(`${style} ${i+1}: text and formatting colors meet WCAG AA`,()=>{
  const match=source.match(new RegExp(`\\[data-style="${style}"\\]\\[data-palette="${i}"\\]\\{--st-paper:(#[a-f0-9]{6})\\}`));
  assert.ok(match,'paper color exists');
  for(const color of ink)assert.ok(contrast(color,match[1])>=4.5,`${color} on ${match[1]}: ${contrast(color,match[1])}`);
  assert.ok(contrast('#40504a',match[1])>=3,'control boundary contrast');
});
