import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/engine.js');
const { engine } = globalThis.CS;

let failures = 0;
const check = (ok, msg) => {
  if (!ok) { failures++; console.error('FAIL', msg); }
  else console.log('ok  ', msg);
};
const near = (a, b) => Math.abs(a - b) < 1e-9;

// At 150 mm wide / 640 px, one pixel is ~0.234 mm. A 0.8 mm minimum feature
// should use a 2 px majority radius (2r ≈ 0.94 mm) and 1 px on the flat mask.
const p1 = engine.physicalSmoothParams(0.8, 150 / 640);
check(p1.familyR === 2 && p1.flatR === 1, '150 mm / 640 px: 0.8 mm → family r2, flat r1');

// Same physical size at 150 mm / 240 px is only 0.625 mm per pixel; the
// smallest meaningful radius is 1 px (2r ≈ 1.25 mm).
const p2 = engine.physicalSmoothParams(0.8, 150 / 240);
check(p2.familyR === 1 && p2.flatR === 1, '150 mm / 240 px: 0.8 mm → r1 (pixel-limited)');

// Smaller print: 75 mm / 600 px → 0.125 mm/px, 0.8 mm is about 3 px.
const p3 = engine.physicalSmoothParams(0.8, 75 / 600);
check(p3.familyR === 3 && p3.flatR === 2, '75 mm / 600 px: 0.8 mm → family r3, flat r2');

// The former hard cap of 8 px silently turned 3 mm into 2.13 mm here.
const p4 = engine.physicalSmoothParams(3, 75 / 600);
check(p4.familyR === 12 && p4.flatR === 6, '75 mm / 600 px: 3 mm keeps its full r12, not capped at r8');

// Off and absurdly coarse output.
check(engine.physicalSmoothParams(0, 0.2).familyR === 0, '0 mm disables smoothing');
check(engine.physicalSmoothParams(0.8, 2.5).familyR === 0, '0.8 mm below one 2.5 mm pixel rounds to no-op');

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall physical-smoothing checks passed');
