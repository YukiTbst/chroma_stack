/* m49 LC1: luminance-height (painting) mode. Per-pixel total height = minTop +
   round(curve(sourceLuma) * reliefLayers); colour occupies the top N layers, foundation
   fills the body. Invert curve raises dark strokes on a bright ground (line art).
   Run: node tests/test-m49-luminance-height.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
for (const m of ['height-curve', 'color', 'optics', 'data-filaments', 'earcut', 'engine', 'layer-optimizer', 'zip', 'exporter']) require('../app/js/' + m + '.js');
const C = globalThis.CS.color, E = globalThis.CS.engine, HC = globalThis.CS.heightCurve;

// Curve helpers.
assert.equal(HC.evalCurve(HC.defaultCurve(), 0.25), 0.25, 'linear curve');
assert.equal(HC.evalCurve(HC.invertCurve(), 0), 1, 'invert: dark -> high');
assert.equal(HC.evalCurve(HC.invertCurve(), 1), 0, 'invert: bright -> low');
assert.equal(HC.evalCurve([{ x: 0, y: 0 }, { x: 0.5, y: 0.8 }, { x: 1, y: 1 }], 0.25), 0.4, 'piecewise interpolation');
assert.equal(HC.validateCurve([{ x: 0, y: 0 }, { x: 1, y: 1 }]).ok, true);
assert.equal(HC.validateCurve([{ x: 0, y: 0 }]).ok, false, 'needs >=2 points');
assert.equal(HC.validateCurve([{ x: 0, y: 0 }, { x: 1, y: NaN }]).ok, false, 'non-finite rejected');
assert.equal(HC.validateCurve([{ x: 0, y: 0 }, { x: 1, y: 2 }]).ok, false, 'out of range rejected');

// Line art: white ground + 1px black vertical line, invert curve -> black raised.
const w = 40, h = 30, d = new Uint8ClampedArray(w * h * 4);
for (let i = 0; i < w * h; i++) d.set([255, 255, 255, 255], i * 4);
for (let y = 5; y < 25; y++) d.set([0, 0, 0, 255], (y * w + 20) * 4);
const pal = E.buildUserPalette([{ id: 'k', name: 'Black', hex: '#000000', td: 0.6 }, { id: 'w', name: 'White', hex: '#ffffff', td: 5 }, { id: 'r', name: 'Red', hex: '#c00d1e', td: 5 }]);
const opts = { engine: 'td', palette: pal, widthMm: 40, flatTopMm: 0.8, reliefMm: 0.8, layerHeight: 0.08, gradLayers: 4, foundationIndex: 1, stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.1, smoothMm: 0, lineWidthMm: 0.42, mergeDeltaE: 0, heightMergeDeltaE: 1.5, edgeClean: 0, vectorFlat: false, lineProtect: 'off', families: 16, backgroundMode: 'off', luminanceHeight: true, luminanceCurve: HC.invertCurve() };
const p = await E.buildPlan({ width: w, height: h, data: d }, opts);

assert.equal(p.luminanceHeight, true, 'plan flags luminance mode');
assert.ok(p.topLayer && p.topLayer.length === w * h, 'per-pixel height field present');
const minTop = p.gradStartLayer + p.colorLayers;
const reliefLayers = Math.round(0.8 / 0.08);
const lineI = 15 * w + 20, bgI = 2 * w + 2;
assert.equal(E.filamentAt(p, 20, 15, p.topLayer[lineI] - 1), 0, 'black line top colour is black');
assert.ok(p.flatMask[bgI] && p.flatFilament[bgI] === 1, 'ground is flat white');
assert.equal(p.topLayer[bgI], minTop, 'bright ground at minimum top (invert curve -> 0)');
assert.equal(p.topLayer[lineI], minTop + reliefLayers, 'dark line raised by full relief (invert curve -> 1)');
assert.ok(p.topLayer[lineI] > p.topLayer[bgI], 'black line raised above white ground');
assert.equal(p.maxLayers, minTop + reliefLayers, 'maxLayers is the tallest column');

// Colour preserved at the top; foundation body below; air above.
const N = p.colorLayers;
const csLine = p.topLayer[lineI] - N, csBg = p.topLayer[bgI] - N;
assert.equal(E.filamentAt(p, 20, 15, p.topLayer[lineI] - 1), 0, 'line top layer is black');
assert.equal(E.filamentAt(p, 20, 15, csLine), 0, 'line colour band starts black');
assert.equal(E.filamentAt(p, 20, 15, csLine - 1), p.foundationIndex, 'below colour band is foundation');
assert.equal(E.filamentAt(p, 20, 15, p.topLayer[lineI]), -1, 'above line top is air');
assert.equal(E.filamentAt(p, 2, 2, p.topLayer[bgI] - 1), 1, 'ground top layer is white');
assert.equal(E.filamentAt(p, 2, 2, p.topLayer[bgI]), -1, 'above ground top is air');
// every printed column is solid from z=0 (no overhang)
for (let z = 0; z < p.topLayer[lineI]; z++) assert.ok(E.filamentAt(p, 20, 15, z) >= 0, `line column solid at z=${z}`);
assert.ok(p.stats.grams.reduce((a, b) => a + b, 0) > 0, 'material grams counted');
assert.ok(p.stats.toolChanges >= 0, 'tool changes counted');
console.log(`LC1 passed: invert curve raises black line to ${p.topLayer[lineI]} vs ground ${p.topLayer[bgI]} (minTop ${minTop}, +${reliefLayers} layers), colour preserved`);