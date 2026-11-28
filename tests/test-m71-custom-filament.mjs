/* Custom-filament creation support: UI wiring + custom material params flow through the
   shared effective-param entry and both print strategies. Run: node tests/test-m71-custom-filament.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.earcut = require('../app/js/earcut.js');
for (const m of ['color', 'optics', 'height-curve', 'data-filaments', 'engine', 'layer-swap', 'zip', 'exporter']) require('../app/js/' + m + '.js');
const C = globalThis.CS.color, E = globalThis.CS.engine, LS = globalThis.CS.layerSwap;
const html = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../app/js/app.js', import.meta.url), 'utf8');

// UI wiring: create form + custom filter + persistence.
for (const id of ['cfName', 'cfHex', 'cfTd', 'cfMaterial', 'btnCreateFilament']) assert.ok(html.includes(`id="${id}"`), 'create control ' + id);
assert.ok(html.includes('data-brand="custom"'), 'custom filter chip');
assert.ok(app.includes('createCustomFilament') && app.includes('loadCustomFilaments') && app.includes('chromastack.customFilaments.v1'), 'create + persistence wired');

// Custom material (not in library) flows through effectivePalette + layerSwap.
const custom = { id: 'custom-my-matte-black', name: '我的哑光黑', hex: '#202020', td: 3, tdR: 3, tdG: 3.4, tdB: 3.8, brand: '自定义', material: 'PLA', custom: true };
const white = { id: 'w', name: 'White', hex: '#ffffff', td: 5, tdR: 5, tdG: 5, tdB: 5 };
const eff = E.effectivePalette([custom, white], {}, 0.08);
assert.ok(Math.abs(eff.palette[0].hdR - 0.3) < 1e-9, 'custom per-channel TD normalized to hd');
const img = (w, h) => { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) d.set([90, 90, 90, 255], i * 4); return { width: w, height: h, data: d }; };
const segs = [{ materialId: custom.id, layerCount: 2 }, { materialId: 'w', layerCount: 2 }, { materialId: custom.id, layerCount: 1 }];
const p = LS.buildPlan(img(8, 8), { palette: [custom, white], segments: segs, firstLayerMm: 0.2, layerMm: 0.08, boundary: { linearRgb: { r: 1, g: 1, b: 1 } }, widthMm: 100, seed: 1 });
assert.equal(p.layerMaterialId[0], custom.id, 'custom id resolves in layerSwap');
assert.equal(p.segments.length, 3, 'repeat custom segment preserved');
// changing custom per-channel TD changes prefixes (shared effective params).
const custom2 = { ...custom, tdR: 6 };
const p2 = LS.buildPlan(img(8, 8), { palette: [custom2, white], segments: segs, firstLayerMm: 0.2, layerMm: 0.08, boundary: { linearRgb: { r: 1, g: 1, b: 1 } }, widthMm: 100, seed: 1 });
assert.ok(C.deltaE2000(p.prefixPrediction[2].lab, p2.prefixPrediction[2].lab) > 0.5, 'custom TD change alters prefix');
console.log('m71 passed: custom filament creation wired + flows through both strategies');