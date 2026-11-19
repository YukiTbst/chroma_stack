/* Calibration write paths: a scalar TD edit is uniform coverage and must
   replace any per-channel calibration; stored records without channels must
   not leave stale channels from another profile in charge. Run:
   node tests/test-calibration-channels.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/settings.js');
require('../app/js/engine.js');
const C = globalThis.CS.color, S = globalThis.CS.settings, E = globalThis.CS.engine;

/* Uniform writer. */
assert.deepEqual(S.uniformTd(12.4), { td: 12.4, tdR: 12.4, tdG: 12.4, tdB: 12.4 });
assert.deepEqual(S.uniformTd(99), { td: 20, tdR: 20, tdG: 20, tdB: 20 }, 'TD is clamped');
assert.deepEqual(S.uniformTd(-3), { td: 0.1, tdR: 0.1, tdG: 0.1, tdB: 0.1 }, 'TD lower bound');

/* A scalar wedge result overwrites channels left by photo/matrix calibration. */
const red = { name: 'Red', hex: '#c00d1e', td: 5, tdR: 16, tdG: 12, tdB: 4 };
const out = S.applyRecord(red, { hex: red.hex, td: 12.4 });
assert.equal(out.td, 12.4);
assert.equal(out.tdR, 12.4, 'scalar record clears the old red channel');
assert.equal(out.tdG, 12.4);
assert.equal(out.tdB, 12.4);

/* Per-channel records are preserved exactly. */
const tri = S.applyRecord(red, { hex: red.hex, td: 9.1, tdR: 16.1, tdG: 12.2, tdB: 4.3 });
assert.deepEqual([tri.td, tri.tdR, tri.tdG, tri.tdB], [9.1, 16.1, 12.2, 4.3]);

/* A missing record must not keep channels from the previous profile. */
const noSaved = S.applyRecord(red, null);
assert.deepEqual([noSaved.td, noSaved.tdR, noSaved.tdG, noSaved.tdB], [5, 5, 5, 5]);

/* Model really responds to the scalar edit after the record is applied. */
const seq = [0, 0, 0];
const beforeP = E.buildUserPalette([red]);
const afterP = E.buildUserPalette([out]);
for (const p of afterP) {
  assert.ok(Math.abs(p.hdR - 1.24) < 1e-9 && Math.abs(p.hdG - 1.24) < 1e-9 && Math.abs(p.hdB - 1.24) < 1e-9, 'uniform TD reaches the engine');
}
const white = { r: 1, g: 1, b: 1 };
const beforeHex = C.linearToHex(E.compositeLinear(white, seq, beforeP, 0.08));
const afterHex = C.linearToHex(E.compositeLinear(white, seq, afterP, 0.08));
console.log('stack colour before scalar calibration', beforeHex, 'after', afterHex);
assert.notEqual(beforeHex, afterHex, 'a scalar TD change must change the predicted stack colour');

/* Wiring: every scalar entry point goes through the shared writer. */
const app = fs.readFileSync(new URL('../app/js/app.js', import.meta.url), 'utf8');
assert.ok(app.includes('CS.settings.applyRecord('), 'record application uses the shared normalizer');
assert.ok((app.match(/CS\.settings\.uniformTd\(/g) || []).length >= 3, 'manual input, wedge calibration and reset all use the uniform writer');
assert.ok(!app.includes('state.tdPalette[i].td ='), 'no scalar-only TD assignment remains');
console.log('all calibration-channel checks passed');