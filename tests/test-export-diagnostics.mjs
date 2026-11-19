/* Export grid + diagnostics: one shared grid function for preview/summary/3MF,
   and per-group colour error / hole-fill audit. Run:
   node tests/test-export-diagnostics.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
globalThis.earcut = require('../app/js/earcut.js');
require('../app/js/engine.js');
require('../app/js/exporter.js');
require('../app/js/zip.js');
const E = globalThis.CS.engine, X = globalThis.CS.exporter;

const w = 120, h = 120;
const data = new Uint8ClampedArray(w * h * 4);
for (let i = 0; i < w * h; i++) data.set([255, 255, 255, 255], i * 4);
const rect = (x, y, ww, hh, rgb) => {
  for (let yy = y; yy < y + hh; yy++) for (let xx = x; xx < x + ww; xx++) data.set([...rgb, 255], (yy * w + xx) * 4);
};
rect(30, 30, 2, 2, [140, 140, 142]);   // real detail: must be rejected by the fill gate
rect(80, 80, 2, 2, [244, 244, 244]);   // tiny near-white noise: still absorbed
const plan = E.buildPlan({ width: w, height: h, data }, {
  engine: 'td', palette: [
    { name: 'Black', hex: '#000000', td: 0.6 },
    { name: 'Jade White', hex: '#ffffff', td: 5 },
    { name: 'Red', hex: '#c00d1e', td: 5 }
  ],
  widthMm: 60, flatTopMm: 1.6, reliefMm: 0.16, layerHeight: 0.08,
  gradLayers: 6, foundationIndex: 1, stdThreshold: 0, residualThreshold: 5,
  minFlatPercent: 0.6, smoothMm: 0, lineWidthMm: 0.42, smoothLevel: 0,
  mergeDeltaE: 0, heightMergeDeltaE: 1.5, edgeClean: 0, vectorFlat: false,
  lineProtect: 'off', families: 12, backgroundMode: 'off'
});

assert.ok(plan.diagnostics, 'plan carries diagnostics');
const dg = plan.diagnostics;
console.log('fill', dg.fill, 'coverage', dg.coverage, 'groups', dg.groups);
assert.ok(dg.fill.rejectedPixels >= 25, 'the grey detail patch is counted as a rejected hole');
assert.ok(dg.fill.filledPixels >= 10, 'near-white noise is still absorbed');
assert.ok(dg.groups.flat.pixels > 0 && dg.groups.gradient.pixels > 0, 'flat and gradient groups are measured');
assert.equal(dg.groups.line.pixels, 0, 'no line group without line protection');
const sumPixels = dg.groups.line.pixels + dg.groups.flat.pixels + dg.groups.gradient.pixels;
assert.ok(sumPixels > 0 && sumPixels <= w * h, 'group pixel counts stay inside the image');
assert.ok(dg.groups.gradient.meanDE > 0, 'rejected detail keeps a measurable gradient error');

/* One shared export grid for summary, UI and 3MF. */
const native = X.exportGridFor(plan);
assert.deepEqual({ w: native.width, h: native.height, d: native.downscaled }, { w: 120, h: 120, d: false });
const capped = X.exportGridFor({ w: 2560, h: 2560 });
assert.deepEqual({ w: capped.width, h: capped.height, d: capped.downscaled }, { w: 1280, h: 1280, d: true });
const custom = X.exportGridFor({ w: 800, h: 600 }, 300);
assert.deepEqual({ w: custom.width, h: custom.height, d: custom.downscaled }, { w: 300, h: 225, d: true });

const summary = X.planSummary(plan);
assert.deepEqual(summary.exportGrid, { width: 120, height: 120, sourceWidth: 120, sourceHeight: 120, downscaled: false });
assert.ok(summary.diagnostics && summary.diagnostics.groups, 'summary exposes diagnostics');
const md = X.buildPlanMarkdown(plan);
assert.ok(md.includes('导出网格') && md.includes('分组色差'), 'markdown explains export grid and grouped errors');

const out3mf = X.build3MFBytes(plan);
assert.deepEqual([out3mf.ew, out3mf.eh], [native.width, native.height], '3MF uses the shared export grid');
console.log('all export/diagnostics checks passed');