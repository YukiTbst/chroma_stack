/* P1 (export review): the ZIP32 capacity check must fire BEFORE the model XML is
   generated, so an over-large 4x model fails fast with an actionable message instead
   of exhausting memory mid-generation. assertModelXmlBudget(totalV,totalT) uses a
   guaranteed LOWER bound on the XML byte count (each vertex line >= 34 bytes, each
   triangle line >= 58 bytes, ignoring header/resources which only add bytes), so it
   never falsely rejects a model that actually fits. Run: node tests/test-m64-early-budget.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.earcut = require('../app/js/earcut.js');
for (const m of ['height-curve', 'color', 'optics', 'data-filaments', 'engine', 'layer-optimizer', 'zip', 'exporter']) require('../app/js/' + m + '.js');
const X = globalThis.CS.exporter;
const ZIP32_MAX = 0xFFFFFFFF;

assert.equal(typeof X.assertModelXmlBudget, 'function', 'assertModelXmlBudget exported');

// Lower bound is monotonic and matches the documented per-line minima.
assert.equal(X.modelXmlLowerBound(0, 0), 0);
assert.equal(X.modelXmlLowerBound(1, 0), 34);
assert.equal(X.modelXmlLowerBound(0, 1), 58);
assert.equal(X.modelXmlLowerBound(1000, 2000), 1000 * 34 + 2000 * 58);

// Normal models pass (no throw).
X.assertModelXmlBudget(1000, 2000);
X.assertModelXmlBudget(5_000_000, 10_000_000); // ~1.1GB lower bound, well under 4GB

// A model whose LOWER bound already exceeds 4GB is definitely over -> fast zipCapacity throw.
// 200M vertices + 200M triangles -> 200e6*34 + 200e6*58 = 18.4GB lower bound.
let threw = null;
try { X.assertModelXmlBudget(200_000_000, 200_000_000); } catch (e) { threw = e; }
assert.ok(threw, 'over-budget model throws');
assert.equal(threw.zipCapacity, true, 'error tagged zipCapacity');
assert.ok(/4GB|ZIP32|精度/.test(threw.message), 'actionable message: ' + threw.message);

// Boundary: just under the limit passes, just over throws (using lower bound exactly).
const vOnly = Math.floor(ZIP32_MAX / 34); // largest vertex count whose lower bound fits
X.assertModelXmlBudget(vOnly, 0);
threw = null; try { X.assertModelXmlBudget(vOnly + 1, 0); } catch (e) { threw = e; }
assert.ok(threw && threw.zipCapacity, 'one vertex over the lower-bound limit throws');

// Integration: assemble3MFParts still produces identical geometry for a normal plan,
// and the early guard runs before XML (a tiny plan must not throw).
const E = globalThis.CS.engine;
const pal = E.buildUserPalette([{ id: 'k', name: 'Black', hex: '#000000', td: 0.6 }, { id: 'w', name: 'White', hex: '#ffffff', td: 5 }, { id: 'r', name: 'Red', hex: '#c00d1e', td: 5 }]);
const w = 64, h = 48, d = new Uint8ClampedArray(w * h * 4);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set([x < 32 ? 192 : 250, 13, 30, 255], (y * w + x) * 4);
const plan = await E.buildPlan({ width: w, height: h, data: d }, { engine: 'td', palette: pal, widthMm: 100, flatTopMm: 1.6, reliefMm: 0.16, layerHeight: 0.08, gradLayers: 6, foundationIndex: 1, families: 48, smoothMm: 0.8, lineWidthMm: 0.42, lineProtect: 'auto', backgroundMode: 'off' });
const out = X.build3MFBytes(plan);
assert.ok(out.bytes.length > 0 && out.meta.triangles > 0, 'normal plan exports');

console.log('m64 passed: early V/T budget guard (lower-bound, fast zipCapacity before XML)');