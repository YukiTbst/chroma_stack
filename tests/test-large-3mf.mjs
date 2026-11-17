import {createRequire} from 'module'; import fs from 'fs';
const require=createRequire(import.meta.url);
require('../app/js/color.js');require('../app/js/data-lut.js');require('../app/js/data-filaments.js');require('../app/js/engine.js');require('../app/js/zip.js');globalThis.earcut=require('../app/js/earcut.js');require('../app/js/exporter.js');
const {engine,exporter}=globalThis.CS;
const w=240,h=160;const data=new Uint8ClampedArray(w*h*4);
for(let y=0;y<h;y++)for(let x=0;x<w;x++){const p=(y*w+x)*4;let r,g,b;if(x<80){r=192;g=13;b=30;}else if(x<110){r=250;g=250;b=245;}else{const t=(x-110)/(w-110),u=y/h;r=Math.round(30+220*t);g=Math.round(80+120*u+40*Math.sin(t*6));b=Math.round(180-140*t);}if(y>130){r=12;g=16;b=20;}data[p]=r;data[p+1]=g;data[p+2]=b;data[p+3]=255;}
const plan=engine.buildPlan({width:w,height:h,data},{engine:'lut',lutKey:'bambu_8',widthMm:150,flatTopMm:1.6,reliefMm:0.16,families:96});
console.log('plan meanDE',plan.stats.meanDE.toFixed(2),'families',plan.stats.familyCount,'swaps',plan.stats.toolChanges);
const t=performance.now();const out=exporter.build3MFBytes(plan,{exportMax:300});const dt=performance.now()-t;
fs.writeFileSync('tests/large.3mf',Buffer.from(out.bytes));
console.log('time ms',dt.toFixed(0),'bytes',out.bytes.length,'grid',out.ew,out.eh,'objects',out.objects.length,'tris',out.meta.triangles);
