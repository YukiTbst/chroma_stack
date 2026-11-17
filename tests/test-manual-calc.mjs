import fs from 'node:fs';
import assert from 'node:assert/strict';

const app = fs.readFileSync(new URL('../app/js/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');

assert.ok(!app.includes('scheduleAnalyze'), 'legacy debounce-to-analyze entry must be removed');
assert.ok(!app.includes('analyzeTimer'), 'no timer may silently start a calculation after edits');
assert.ok(!app.includes('setTimeout(analyze, 80)'), 'queued analysis cannot consume later edits after a timer gap');
assert.ok(app.includes('const request = ++state.analysisRequest'), 'each analysis request has an identity');
assert.ok(app.includes('if (request !== state.analysisRequest) return;'), 'stale analysis results are discarded');
assert.ok(app.includes('if (loadId !== imageLoadSerial) return;'), 'an older image load cannot replace a newer selection');
const dirtyStart = app.indexOf('function markDirty');
const dirtyEnd = app.indexOf('function analyze()', dirtyStart);
const dirtyBody = app.slice(dirtyStart, dirtyEnd);
assert.ok(dirtyBody.includes('state.editVersion++'), 'each edit advances the pending parameter version');
assert.ok(dirtyBody.includes('state.dirty = true'), 'edits mark the plan as pending');
assert.ok(dirtyBody.includes('setExportEnabled(false)'), 'pending edits disable stale exports');
assert.ok(!dirtyBody.includes('analyze('), 'markDirty itself never starts analysis');
assert.ok(app.includes('state.dirty = state.editVersion !== version'), 'edits during analysis remain pending after it finishes');
assert.ok(app.includes('setExportEnabled(!state.dirty)'), 'export availability follows the applied parameter version');
assert.ok(app.includes('X.build3MFBlobAsync(p)'), '3MF export uses the clicked plan snapshot');
assert.ok(app.includes("downloadBlob(blob, filenameBase(p) + '_预览.png')"), 'preview content and filename use the same plan snapshot');
assert.ok(app.includes('state.lutTdOverrides[state.lutKey]'), 'LUT calibration overrides are partitioned by LUT key');
assert.ok(app.includes("$('btnAnalyze').addEventListener('click', () => analyze())"), 'sidebar button starts calculation explicitly');
assert.ok(app.includes("$('btnAnalyzeStage').addEventListener('click', () => analyze())"), 'stage button starts calculation explicitly');

const setImage = app.slice(app.indexOf('function setImage'), app.indexOf('function makeSyntheticSample'));
assert.ok(setImage.includes('analyze()'), 'a newly uploaded image still gets its initial automatic calculation');
assert.ok(setImage.includes('state.dirty = false'), 'new image starts from a clean initial state');
const addFilament = app.slice(app.indexOf('function addFilamentToTd'), app.indexOf('function applyGamutSuggestion'));
assert.ok(addFilament.includes('markDirty(false)'), 'filament addition marks pending changes');
assert.ok(!addFilament.includes('analyze()'), 'adding several filaments never triggers analysis per item');

assert.ok(/<input[^>]*type="number"[^>]*id="smoothMm"/.test(html), 'smoothness is a precise numeric millimetre input');
assert.ok(!/<input[^>]*type="range"[^>]*id="smoothMm"/.test(html), 'smoothness slider is removed');
assert.ok(html.includes('id="btnAnalyzeStage"'), 'stage calculation button exists');
assert.ok(html.includes('id="dirtyHint"'), 'pending-change explanation exists');
assert.ok(!html.includes('松开后自动重算'), 'brush help no longer promises automatic recomputation');
assert.ok(html.includes('松开后标记修改，点击计算生效'), 'brush help explains the manual workflow');
assert.ok(app.includes("lineProtect: 'strong'"), 'web default promotes continuous dark strokes to direct filament for crisp text');
assert.ok(html.includes('value="strong" selected'), 'strong line protection is the selected default in the UI');
assert.ok(app.includes('Math.min(1.8, WORK_MAX / Math.max(sw, sh))'), 'small images receive a high-quality working raster instead of staying at low resolution');
assert.ok(app.includes("$('smoothMm').addEventListener('change'"), 'out-of-range smoothness is normalized on commit');
const beginBrush = app.slice(app.indexOf('function beginBrush'), app.indexOf('function moveBrush'));
assert.ok(beginBrush.includes('markDirty(false)'), 'starting a brush stroke immediately disables stale exports');
console.log('all manual-calculation and numeric-smoothness checks passed');
