import { createRequire } from 'module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
require('../app/js/settings.js');
const settings = globalThis.CS.settings;

/* Snapshot purity: calibration only, never project/image state. */
const state = {
  widthMm: 75, backgroundMode: 'auto', engine: 'td', threeMode: 'stack',
  tdPalette: [{ id: 'black', name: 'Black', hex: '#000000', td: 0.6, brand: 'Test', material: 'PLA' }],
  filamentCalibrations: {},
  backgroundHoleIds: new Set([123, 456]),
  imageData: new Uint8ClampedArray(400), plan: { large: 'analysis-cache' }
};
const snapshot = settings.snapshot(state);
assert.equal(snapshot.calibrations['id:black'].td, 0.6, 'filament TD is serialized by model ID');
assert.ok(!('widthMm' in snapshot) && !('backgroundMode' in snapshot) && !('threeMode' in snapshot), 'project parameters are not persisted');
assert.ok(!('tdPalette' in snapshot), 'selected project palette is not persisted as a project');
assert.ok(!('imageData' in snapshot) && !('plan' in snapshot), 'image and analysis cache are never serialized');
assert.ok(!('backgroundHoleIds' in snapshot), 'image-specific hole IDs remain session-only');
assert.equal(settings.filamentKey(state.tdPalette[0]), 'id:black', 'filament model key is stable');

/* Without the profile layer, save reports failure instead of throwing. */
assert.equal(settings.save(state), false, 'missing profile layer is reported');
assert.ok(globalThis.CS.settingsLastError.includes('profiles'), 'failure reason is retained');

/* With a stub profile layer, save/load/clear delegate to server profiles. */
const calls = { saved: [], cleared: 0 };
let cached = null;
globalThis.CS.profiles = {
  save(data) { calls.saved.push(data); cached = data; return true; },
  cachedData() { return cached ? JSON.parse(JSON.stringify(cached)) : null; },
  clearActive() { calls.cleared++; cached = { calibrations: {} }; return Promise.resolve(); }
};
assert.equal(settings.save(state), true, 'calibration saves through the profile layer');
assert.equal(calls.saved.length, 1, 'one push queued per save');
assert.equal(calls.saved[0].calibrations['id:black'].td, 0.6);
const loaded = settings.load();
assert.equal(loaded.calibrations['id:black'].td, 0.6);
loaded.calibrations['id:black'].td = 9;
assert.equal(state.tdPalette[0].td, 0.6, 'stored snapshots are detached copies');
settings.clear();
assert.equal(calls.cleared, 1, 'clear resets the active server profile');

/* Static wiring checks. */
const app = fs.readFileSync(new URL('../app/js/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
assert.ok(app.includes('restoreSettings(await CS.profiles.init())'), 'startup loads the active server profile');
assert.ok(app.includes('applyCalibrationRecord'), 'new filaments inherit stored model calibration');
assert.ok(app.includes('syncControlsFromState()'), 'controls are synchronized with restored state');
assert.ok(app.includes('CS.profiles.flush(true)'), 'last-minute edits are flushed on page hide');
assert.ok(app.includes('CS.settings.save(state)'), 'edits and 3D controls trigger persistence');
assert.ok(!app.includes('factoryDefaults'), 'project defaults are not restored from storage');
assert.ok(html.includes('id="btnResetSettings"') && html.includes('js/settings.js'), 'calibration reset control and settings script exist');
assert.ok(html.includes('id="profileSelect"') && html.includes('id="btnNewProfile"') && html.includes('id="btnRenameProfile"') && html.includes('id="btnDeleteProfile"'), 'profile selector and CRUD controls exist');
assert.ok(html.indexOf('js/profiles.js') < html.indexOf('js/settings.js'), 'profile module loads before settings');
assert.ok(html.indexOf('js/settings.js') < html.indexOf('js/app.js'), 'settings module loads before the application');
console.log('all filament-calibration persistence checks passed');