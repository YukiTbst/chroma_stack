/* R1 phase2 UI wiring + LUT retirement regression. Static checks on index/app plus a
   functional check that fixTopLayer preserves the height map (view-colour-only mode).
   Run: node tests/test-m69-layer-swap-ui.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.earcut = require('../app/js/earcut.js');
for (const m of ['color', 'optics', 'height-curve', 'data-filaments', 'layer-swap']) require('../app/js/' + m + '.js');
const LS = globalThis.CS.layerSwap;
const html = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../app/js/app.js', import.meta.url), 'utf8');

// LUT retired: no lut entry/field/script; strategy switch present.
assert.ok(!html.includes('data-engine="lut"'), 'no LUT engine button');
assert.ok(!html.includes('id="lutSelect"') && !html.includes('id="lutField"'), 'no LUT selector/field');
assert.ok(!html.includes('js/data-lut.js'), 'data-lut script removed');
assert.ok(html.includes('data-engine="layerSwap"') && html.includes('data-engine="td"'), 'strategy switch present');
// layerSwap panel present.
for (const id of ['lsPanel', 'lsSegments', 'lsAddSeg', 'lsFirst', 'lsRest', 'lsMin', 'lsSmooth', 'lsFixHeights', 'btnLsOptimize', 'lsChangeList']) {
  assert.ok(html.includes(`id="${id}"`), 'panel control ' + id);
}
// app wiring.
assert.ok(app.includes('CS.layerSwap.buildPlan'), 'analyze uses layerSwap builder');
assert.ok(app.includes('bindLsPanel()'), 'panel bound at init');
assert.ok(app.includes('renderLsChangeList()'), 'change list rendered after plan');
assert.ok(app.includes('fixTopLayer'), 'fix-heights mode wired');
assert.ok(app.includes('optimizeSegmentLengths'), 'F-05 optimize wired');
assert.ok(!app.includes('currentLutPalette'), 'currentLutPalette removed');
// TD calibration preserved in app + settings + profiles.
assert.ok(app.includes('state.filamentCalibrations'), 'TD filament calibration kept');
assert.ok(app.includes('calibrationV2'), 'TD v2 calibration kept');
const settings = fs.readFileSync(new URL('../app/js/settings.js', import.meta.url), 'utf8');
assert.ok(settings.includes('calibrations') && !settings.includes('lutTdOverrides'), 'settings snapshot calibration-only');

// functional: fixTopLayer preserves heights while recolouring.
const db = (globalThis.CS.FILAMENT_DB && CS.FILAMENT_DB.filaments) || [];
const pick = n => db.find(f => f.brand === 'BambuLab Basic' && f.material === 'PLA' && f.name === n);
const palette = ['Black', 'Jade White', 'Red', 'Yellow', 'Blue'].map(pick).filter(Boolean).map(f => ({ id: f.name, name: f.name, hex: f.hex, td: f.td }));
const w = 12, h = 8, d = new Uint8ClampedArray(w * h * 4);
for (let i = 0; i < w * h; i++) d.set([180, 80, 80, 255], i * 4);
const segs = [{ materialId: 'Black', layerCount: 2 }, { materialId: 'Jade White', layerCount: 2 }, { materialId: 'Red', layerCount: 2 }];
const base = { palette, firstLayerMm: 0.2, layerMm: 0.08, boundary: { linearRgb: { r: 1, g: 1, b: 1 } }, widthMm: 100, seed: 3 };
const p1 = LS.buildPlan({ width: w, height: h, data: d }, { ...base, segments: segs });
const segs2 = [{ materialId: 'Black', layerCount: 3 }, { materialId: 'Jade White', layerCount: 2 }, { materialId: 'Red', layerCount: 2 }];
const p2 = LS.buildPlan({ width: w, height: h, data: d }, { ...base, segments: segs2, fixTopLayer: p1.topLayer });
assert.deepEqual(Array.from(p2.topLayer), Array.from(p1.topLayer), 'fixTopLayer preserves heights');
assert.notDeepEqual(Array.from(p2.preview), Array.from(p1.preview), 'preview recoloured on new sequence');
console.log('m69 passed: layerSwap UI wired + LUT retired + TD calibration preserved + fix-heights mode');