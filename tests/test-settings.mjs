import { createRequire } from 'module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
require('../app/js/settings.js');
const settings = globalThis.CS.settings;
const store = new Map();
globalThis.localStorage = {
  getItem: key => store.has(key) ? store.get(key) : null,
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: key => store.delete(key)
};

const state = {
  widthMm: 75, backgroundMode: 'auto', engine: 'td', threeMode: 'stack',
  tdPalette: [{ id: 'black', name: 'Black', hex: '#000000', td: 0.6, brand: 'Test', material: 'PLA' }],
  filamentCalibrations: {},
  lutTdOverrides: { bambu_8: { 2: 4.5 }, cmyw_4: { 0: 3.2 } },
  lutHexOverrides: { bambu_8: { 1: '#112233' } },
  backgroundHoleIds: new Set([123, 456]),
  imageData: new Uint8ClampedArray(400), plan: { large: 'analysis-cache' }
};
const snapshot = settings.snapshot(state);
assert.equal(snapshot.calibrations['id:black'].td, 0.6, 'filament TD is serialized by model ID');
assert.deepEqual(snapshot.lutTdOverrides.bambu_8, { 2: 4.5 }, 'LUT overrides remain partitioned by key');
assert.ok(!('widthMm' in snapshot) && !('backgroundMode' in snapshot) && !('threeMode' in snapshot), 'project parameters are not persisted');
assert.ok(!('tdPalette' in snapshot), 'selected project palette is not persisted as a project');
assert.ok(!('imageData' in snapshot) && !('plan' in snapshot), 'image and analysis cache are never serialized');
assert.ok(!('backgroundHoleIds' in snapshot), 'image-specific hole IDs remain session-only');
assert.equal(settings.filamentKey(state.tdPalette[0]), 'id:black', 'filament model key is stable');

assert.equal(settings.save(state), true, 'valid calibration saves successfully');
const loaded = settings.load();
assert.equal(loaded.calibrations['id:black'].td, 0.6);
assert.equal(loaded.lutTdOverrides.cmyw_4[0], 3.2);
loaded.calibrations['id:black'].td = 9;
assert.equal(state.tdPalette[0].td, 0.6, 'stored snapshots are detached copies');

store.set(settings.KEY, '{broken json');
assert.equal(settings.load(), null, 'malformed JSON falls back to defaults without throwing');
store.set(settings.KEY, JSON.stringify({ version: 0, data: { widthMm: 99 } }));
assert.equal(settings.load(), null, 'unsupported schema version is rejected');
settings.clear();
assert.equal(settings.load(), null, 'clear removes persisted calibration');

globalThis.localStorage.setItem = () => { throw new Error('quota exceeded'); };
assert.equal(settings.save(state), false, 'quota/security failures are reported without crashing edits');
assert.ok(globalThis.CS.settingsLastError.includes('quota'), 'storage failure reason is retained');

const app = fs.readFileSync(new URL('../app/js/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
assert.ok(app.includes('restoreSettings(CS.settings.load())'), 'startup restores saved calibration');
assert.ok(app.includes('applyCalibrationRecord'), 'new filaments inherit stored model calibration');
assert.ok(app.includes('syncControlsFromState()'), 'controls are synchronized with restored state');
assert.ok(app.includes('window.addEventListener(\'pagehide\''), 'last-minute edits are saved on page hide');
assert.ok(app.includes('CS.settings.save(state)'), 'edits and 3D controls trigger persistence');
assert.ok(!app.includes('factoryDefaults'), 'project defaults are not restored from storage');
assert.ok(html.includes('id="btnResetSettings"') && html.includes('js/settings.js'), 'calibration reset control and settings script exist');
assert.ok(html.indexOf('js/settings.js') < html.indexOf('js/app.js'), 'settings module loads before the application');
console.log('all filament-calibration persistence checks passed');
