import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/optics.js');
require('../app/js/data-filaments.js');
require('../app/js/engine.js');
globalThis.earcut = require('../app/js/earcut.js');
require('../app/js/zip.js');
require('../app/js/exporter.js');
const { engine, exporter } = globalThis.CS;

const w=64,h=48;
const data=new Uint8ClampedArray(w*h*4);
for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  const p=(y*w+x)*4; let r,g,b;
  if(x<24){r=192;g=13;b=30;} else if(x<32){r=255;g=255;b=255;} else {r=Math.round(40+180*(x-32)/32);g=Math.round(80+120*y/h);b=Math.round(200-140*(x-32)/32);}
  if(y>40){r=0;g=0;b=0;}
  data[p]=r;data[p+1]=g;data[p+2]=b;data[p+3]=255;
}
const image={width:w,height:h,data};
const palette=[
  { name: 'Black', hex: '#000000', td: 0.6, brand: 'BambuLab Basic', material: 'PLA' },
  { name: 'Jade White', hex: '#ffffff', td: 5, brand: 'BambuLab Basic', material: 'PLA' },
  { name: 'Red', hex: '#c00d1e', td: 5, brand: 'BambuLab Basic', material: 'PLA' },
  { name: 'Yellow', hex: '#fce300', td: 6, brand: 'BambuLab Basic', material: 'PLA' },
  { name: 'Blue', hex: '#00358e', td: 4, brand: 'BambuLab Basic', material: 'PLA' }
];
const plan=await engine.buildPlan(image,{engine:'td',palette,foundationIndex:1,widthMm:60,flatTopMm:1.6,reliefMm:0.16,families:24});
console.log('plan',plan.stats.meanDE, plan.flatLayers, plan.gradStartLayer, plan.gradTopLayer, plan.maxLayers);
const out=exporter.build3MFBytes(plan,{exportMax:96});
fs.writeFileSync('tests/sample.3mf',Buffer.from(out.bytes));
fs.writeFileSync('tests/sample-plan.json',JSON.stringify(exporter.planSummary(plan),null,2));
fs.writeFileSync('tests/sample-plan.md',exporter.buildPlanMarkdown(plan));
console.log('3mf bytes',out.bytes.length,'meta',out.meta,'objects',out.objects);
console.log('zip signature',Buffer.from(out.bytes.slice(0,4)).toString('hex'));
