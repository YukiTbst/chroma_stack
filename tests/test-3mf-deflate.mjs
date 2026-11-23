import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/optics.js');
require('../app/js/data-lut.js');
require('../app/js/data-filaments.js');
require('../app/js/engine.js');
globalThis.earcut = require('../app/js/earcut.js');
require('../app/js/zip.js');
require('../app/js/exporter.js');
const { engine, exporter } = globalThis.CS;
const w=80,h=60;
const data=new Uint8ClampedArray(w*h*4);
for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  const p=(y*w+x)*4; let r,g,b;
  if(x<30){r=192;g=13;b=30;} else if(x<40){r=255;g=255;b=255;} else {r=Math.round(40+180*(x-40)/40);g=Math.round(80+120*y/h);b=Math.round(200-140*(x-40)/40);}
  if(y>50){r=0;g=0;b=0;}
  data[p]=r;data[p+1]=g;data[p+2]=b;data[p+3]=255;
}
const plan=await engine.buildPlan({width:w,height:h,data},{engine:'td',palette:[
 {name:'Black',hex:'#000000',td:0.6},{name:'Jade White',hex:'#ffffff',td:5},{name:'Red',hex:'#c00d1e',td:5},{name:'Yellow',hex:'#fce300',td:6},{name:'Blue',hex:'#00358e',td:4}
],foundationIndex:1,widthMm:60,flatTopMm:1.6,reliefMm:0.16,gradLayers:6,families:32,layerHeight:0.08,smoothLevel:2,mergeDeltaE:4,lineProtect:'auto'});
const store=exporter.build3MFBytes(plan,{exportMax:96});
const packed=await exporter.build3MFBytesAsync(plan,{exportMax:96});
fs.writeFileSync('tests/sample-store.3mf',Buffer.from(store.bytes));
fs.writeFileSync('tests/sample-deflate.3mf',Buffer.from(packed.bytes));
console.log('store',store.bytes.length,'deflate',packed.bytes.length,'ratio',(packed.bytes.length/store.bytes.length).toFixed(3));
console.log('signatures',Buffer.from(store.bytes.slice(0,4)).toString('hex'),Buffer.from(packed.bytes.slice(0,4)).toString('hex'));
