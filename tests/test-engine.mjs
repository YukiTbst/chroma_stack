import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/data-lut.js');
require('../app/js/data-filaments.js');
require('../app/js/engine.js');
globalThis.earcut = require('../app/js/earcut.js');
const { engine, LUT_DATA } = globalThis.CS;

const w = 240, h = 160;
const data = new Uint8ClampedArray(w*h*4);
function px(x,y,r,g,b){ const p=(y*w+x)*4; data[p]=r; data[p+1]=g; data[p+2]=b; data[p+3]=255; }
for (let y=0;y<h;y++) for (let x=0;x<w;x++) {
  let r,g,b;
  if (x < 80) { r=192; g=13; b=30; }            // flat red block
  else if (x < 110) { r=250; g=250; b=245; }    // flat white strip
  else {
    const t = (x-110)/(w-110), u=y/h;
    r = Math.round(30 + 220*t);
    g = Math.round(80 + 120*u + 40*Math.sin(t*6));
    b = Math.round(180 - 140*t);
  }
  if (y > 130) { r=12; g=16; b=20; }             // flat black bar
  px(x,y,r,g,b);
}
const image = { width:w, height:h, data };
for (const mode of ['lut8','lut4','td']) {
  const t0 = performance.now();
  const opts = mode==='td'
    ? { engine:'td', palette:[
        {name:'Black',hex:'#000000',td:0.6,brand:'BambuLab Basic',material:'PLA'},
        {name:'Jade White',hex:'#ffffff',td:5,brand:'BambuLab Basic',material:'PLA'},
        {name:'Red',hex:'#c00d1e',td:5,brand:'BambuLab Basic',material:'PLA'},
        {name:'Yellow',hex:'#fce300',td:6,brand:'BambuLab Basic',material:'PLA'},
        {name:'Blue',hex:'#00358e',td:4,brand:'BambuLab Basic',material:'PLA'}],
        foundationIndex:1, widthMm:150, flatTopMm:1.6, reliefMm:0.16, gradLayers:6, families:48, layerHeight:0.08 }
    : { engine:'lut', lutKey: mode==='lut8'?'bambu_8':'bambu_cmyw', widthMm:150, flatTopMm:1.6, reliefMm:0.16, families:64 };
  const plan = engine.buildPlan(image, opts);
  const dt = performance.now()-t0;
  console.log(`\n=== ${mode} ${dt.toFixed(0)}ms ===`);
  console.log('palette', plan.palette.map(p=>p.name).join(', '));
  console.log('layers flat/start/top/max', plan.flatLayers, plan.gradStartLayer, plan.gradTopLayer, plan.maxLayers, 'relief', plan.reliefMm.toFixed(3));
  console.log('stats', { meanDE:+plan.stats.meanDE.toFixed(2), p90:plan.stats.p90, flat:+plan.stats.flatPercent.toFixed(1), grad:+plan.stats.gradPercent.toFixed(1), families:plan.stats.familyCount, swaps:plan.stats.toolChanges, under5:+plan.stats.under5.toFixed(1) });
  console.log('warnings', plan.warnings);
  console.log('top families');
  plan.families.filter(f=>f.pixelCount>0).sort((a,b)=>b.pixelCount-a.pixelCount).slice(0,5).forEach(f=>console.log(' ', f.pixelCount, f.targetHex, '->', f.predictedHex, 'dE', f.deltaE.toFixed(1), 'recipe', f.recipe));
  // check filamentAt is valid
  let bad=0;
  for (let y=0;y<h;y+=7) for (let x=0;x<w;x+=7) for (let z=0;z<plan.maxLayers;z++) {
    const fi = engine.filamentAt(plan,x,y,z);
    const idx = y*w+x;
    const f = plan.familyId[idx];
    const top = plan.flatMask[idx]
      ? plan.flatLayers
      : plan.gradStartLayer + (f >= 0 ? plan.families[f].recipe.length : 0);
    const expected = z >= 0 && z < top;
    if (expected && (fi<0 || fi>=plan.palette.length)) bad++;
  }
  console.log('invalid filament slots', bad);
}
