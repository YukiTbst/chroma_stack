/* Server-backed calibration profiles: real API process + browser profile layer.
   Run from project root: node tests/test-profile-api.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 18124;
const BASE = `http://127.0.0.1:${PORT}/`;
const DATA_DIR = path.join(root, 'tests', '.tmp-profile-data');
fs.rmSync(DATA_DIR, { recursive: true, force: true });

const server = spawn(process.execPath, [path.join(root, 'server', 'profile-api.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; });
server.stderr.on('data', d => { serverLog += d; });

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + 'health'); if (r.ok) return; } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('API did not start: ' + serverLog);
}

async function req(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function makeLocalStorage() {
  const store = new Map();
  return {
    store,
    getItem: k => store.has(k) ? store.get(k) : null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k)
  };
}

const require = createRequire(import.meta.url);
function loadBrowserModules(ls) {
  delete globalThis.CS;
  globalThis.localStorage = ls;
  for (const m of ['../app/js/profiles.js', '../app/js/settings.js']) {
    const resolved = require.resolve(m);
    delete require.cache[resolved]; // re-run the IIFE against the fresh storage stub
    require(resolved);
  }
  return globalThis.CS;
}

try {
  await waitReady();

  /* ---- raw API ---- */
  assert.equal((await req('GET', 'profiles')).body.profiles.length, 0, 'starts empty');
  assert.equal((await req('POST', 'profiles', { name: '  ' })).status, 400, 'blank name rejected');
  assert.equal((await req('POST', 'profiles', { name: 'x'.repeat(41) })).status, 400, 'overlong name rejected');
  const created = await req('POST', 'profiles', { name: '测试套', data: { calibrations: { 'id:black': { td: 0.5 } }, junk: 1 } });
  assert.equal(created.status, 201);
  assert.equal(created.body.revision, 1, 'profile starts at revision 1');
  const id = created.body.id;
  assert.ok(!('junk' in created.body.data), 'unknown data fields are dropped');
  assert.equal((await req('GET', 'profiles/' + id)).body.data.calibrations['id:black'].td, 0.5);
  assert.equal((await req('GET', 'profiles/nope')).status, 404);
  assert.equal((await req('PUT', 'profiles/' + id, { name: '改名', data: { calibrations: { 'id:red': { td: 3 } } } })).status, 428, 'data write without expectedRevision is refused');
  const putOk = await req('PUT', 'profiles/' + id, { name: '改名', data: { calibrations: { 'id:red': { td: 3 } } }, expectedRevision: 1 });
  assert.equal(putOk.status, 200);
  assert.equal(putOk.body.revision, 2, 'successful write bumps the revision');
  const stale = await req('PUT', 'profiles/' + id, { data: { calibrations: { 'id:yellow': { td: 7 } } }, expectedRevision: 1 });
  assert.equal(stale.status, 409, 'stale revision is rejected');
  const afterPut = (await req('GET', 'profiles/' + id)).body;
  assert.equal(afterPut.name, '改名');
  assert.ok(!('id:black' in afterPut.data.calibrations), 'PUT replaces data wholesale');
  assert.equal(afterPut.data.calibrations['id:red'].td, 3, 'stale write left the data intact');
  assert.equal((await req('GET', 'profiles')).body.profiles[0].revision, 2, 'profile list exposes the revision');
  assert.equal((await req('PUT', 'profiles/' + id, { name: '' })).status, 400, 'blank rename rejected');
  const files = fs.readdirSync(path.join(DATA_DIR, 'profiles'));
  assert.deepEqual(files, [id + '.json'], 'one JSON file per profile, no tmp leftovers');
  assert.equal((await req('DELETE', 'profiles/' + id)).status, 200);
  assert.equal((await req('GET', 'profiles/' + id)).status, 404);
  assert.equal((await req('DELETE', 'profiles/' + id)).status, 404);
  console.log('raw API checks passed');

  /* ---- browser layer: first run migrates legacy localStorage ---- */
  const lsPhone = makeLocalStorage();
  lsPhone.setItem('chromastack.filament-calibrations.v1', JSON.stringify({
    version: 1, data: { calibrations: { 'id:black': { id: 'black', name: 'Black', hex: '#000000', td: 0.42, source: 'photo' } }, lutTdOverrides: {}, lutHexOverrides: {} }
  }));
  lsPhone.setItem('chromastack.api-base', BASE);
  let CS = loadBrowserModules(lsPhone);
  const statuses = [];
  CS.profiles.onStatus = (s) => statuses.push(s);
  const migrated = await CS.profiles.init();
  assert.equal(migrated.calibrations['id:black'].td, 0.42, 'legacy calibration migrated to server');
  assert.equal(lsPhone.getItem('chromastack.filament-calibrations.v1'), null, 'legacy key removed after migration');
  const firstId = CS.profiles.activeId();
  assert.equal(lsPhone.getItem(CS.profiles.ACTIVE_KEY), firstId, 'browser persists only the active pointer');
  assert.equal(CS.profiles.list()[0].name, '默认标定');
  assert.ok(statuses.includes('synced'));

  /* edits flow to the server through settings.save + flush */
  const state = {
    tdPalette: [{ id: 'black', name: 'Black', hex: '#000000', td: 0.55, brand: 'Test', material: 'PLA' }],
    filamentCalibrations: {}, lutTdOverrides: {}, lutHexOverrides: {}
  };
  assert.equal(CS.settings.save(state), true);
  await CS.profiles.flush(false);
  assert.equal((await req('GET', 'profiles/' + firstId)).body.data.calibrations['id:black'].td, 0.55, 'edit reached the server');

  /* second profile + switching; pointer is the only browser-side choice */
  const p2 = await CS.profiles.create('第二套', { calibrations: { 'id:red': { td: 3.1 } }, lutTdOverrides: {}, lutHexOverrides: {} });
  const switched = await CS.profiles.switchTo(p2.id);
  assert.equal(switched.calibrations['id:red'].td, 3.1);
  assert.ok(!('id:black' in switched.calibrations), 'profiles are isolated');
  assert.equal(lsPhone.getItem(CS.profiles.ACTIVE_KEY), p2.id);

  /* ---- another device (fresh browser storage) sees the same data ---- */
  const lsDesktop = makeLocalStorage();
  lsDesktop.setItem('chromastack.api-base', BASE);
  lsDesktop.setItem('chromastack.active-profile.v1', p2.id);
  CS = loadBrowserModules(lsDesktop);
  const desktopData = await CS.profiles.init();
  assert.equal(desktopData.calibrations['id:red'].td, 3.1, 'phone and desktop share the selected profile');
  assert.equal(CS.profiles.list().length, 2, 'both profiles visible on the second device');

  /* reset clears the active profile content, keeps the profile */
  await CS.profiles.clearActive();
  assert.deepEqual((await req('GET', 'profiles/' + p2.id)).body.data.calibrations, {});
  assert.equal(CS.profiles.list().length, 2);

  /* deleting the active profile falls back to a remaining one */
  const removed = await CS.profiles.remove(p2.id);
  assert.equal(removed.activeId, firstId, 'falls back to the remaining profile');
  assert.equal(removed.data.calibrations['id:black'].td, 0.55);
  /* deleting the last profile auto-creates a fresh default */
  const removedLast = await CS.profiles.remove(firstId);
  assert.ok(removedLast.activeId && removedLast.activeId !== firstId);
  assert.equal(CS.profiles.list().length, 1);
  assert.deepEqual(removedLast.data.calibrations, {});

  /* ---- offline fallback: mirror keeps edits, pointer still respected ---- */
  const lsOffline = makeLocalStorage();
  lsOffline.setItem('chromastack.api-base', 'http://127.0.0.1:1/'); // unreachable
  lsOffline.setItem(CS.profiles.MIRROR_KEY, JSON.stringify({ profileId: 'p-x', data: { calibrations: { 'id:blue': { td: 2.2 } }, lutTdOverrides: {}, lutHexOverrides: {} }, updatedAt: Date.now() }));
  lsOffline.setItem('chromastack.active-profile.v1', 'p-x');
  CS = loadBrowserModules(lsOffline);
  let offlineSeen = false;
  CS.profiles.onStatus = s => { if (s === 'offline') offlineSeen = true; };
  const offlineData = await CS.profiles.init();
  assert.equal(offlineData.calibrations['id:blue'].td, 2.2, 'offline init serves the mirror');
  assert.ok(offlineSeen, 'offline status reported');
  assert.equal(CS.profiles.isOnline(), false);
  console.log('browser profile-layer checks passed');

  /* ---- optimistic concurrency: a stale client gets 409 and keeps its draft ---- */
  const lsCon = makeLocalStorage();
  lsCon.setItem('chromastack.api-base', BASE);
  lsCon.setItem('chromastack.active-profile.v1', removedLast.activeId);
  CS = loadBrowserModules(lsCon);
  const conId = removedLast.activeId;
  await CS.profiles.init();
  const rev0 = (await req('GET', 'profiles/' + conId)).body.revision;
  const other = { calibrations: { 'id:blue': { id: 'blue', name: 'Blue', hex: '#00358e', td: 2.2 } }, lutTdOverrides: {}, lutHexOverrides: {} };
  assert.equal((await req('PUT', 'profiles/' + conId, { data: other, expectedRevision: rev0 })).status, 200, 'other device writes');
  const statusesC = [];
  CS.profiles.onStatus = s => statusesC.push(s);
  const localRed = { tdPalette: [{ id: 'red', name: 'Red', hex: '#c00d1e', td: 4.4, brand: 'Test', material: 'PLA' }], filamentCalibrations: {}, lutTdOverrides: {}, lutHexOverrides: {} };
  CS.settings.save(localRed);
  await CS.profiles.flush(false);
  assert.ok(statusesC.includes('conflict'), 'stale write reports a conflict');
  assert.ok(CS.profiles.hasConflict());
  assert.equal((await req('GET', 'profiles/' + conId)).body.data.calibrations['id:blue'].td, 2.2, 'other device data is not overwritten');
  assert.equal(CS.profiles.cachedData().calibrations['id:red'].td, 4.4, 'local draft is retained');
  const adopted = await CS.profiles.resolveConflict('server');
  assert.equal(adopted.calibrations['id:blue'].td, 2.2, 'server resolution adopts server data');
  assert.equal(CS.profiles.hasConflict(), false);

  /* after resolving, a new edit writes normally */
  CS.settings.save(localRed);
  await CS.profiles.flush(false);
  assert.equal((await req('GET', 'profiles/' + conId)).body.data.calibrations['id:red'].td, 4.4, 'writes resume after resolution');

  /* local resolution overwrites with a fresh precondition */
  const cur = (await req('GET', 'profiles/' + conId)).body;
  await req('PUT', 'profiles/' + conId, { data: { calibrations: { 'id:yellow': { td: 7 } }, lutTdOverrides: {}, lutHexOverrides: {} }, expectedRevision: cur.revision });
  const localBlue = { tdPalette: [{ id: 'blue', name: 'Blue', hex: '#00358e', td: 3.3, brand: 'Test', material: 'PLA' }], filamentCalibrations: {}, lutTdOverrides: {}, lutHexOverrides: {} };
  CS.settings.save(localBlue);
  await CS.profiles.flush(false);
  assert.ok(CS.profiles.hasConflict(), 'second stale write conflicts again');
  const kept = await CS.profiles.resolveConflict('local');
  assert.equal(kept.calibrations['id:blue'].td, 3.3, 'local resolution keeps the draft');
  const srv = (await req('GET', 'profiles/' + conId)).body;
  assert.equal(srv.data.calibrations['id:blue'].td, 3.3, 'local resolution reached the server');
  assert.ok(!('id:yellow' in srv.data.calibrations), 'local resolution replaced the server snapshot');

  /* ---- offline clear is queued, not reported as synced ---- */
  CS.settings.save(localRed);
  await CS.profiles.flush(false);
  const statusesClear = [];
  CS.profiles.onStatus = s => statusesClear.push(s);
  lsCon.setItem('chromastack.api-base', 'http://127.0.0.1:1/');
  await CS.profiles.clearActive();
  assert.ok(statusesClear.includes('offline'), 'offline clear reports pending');
  assert.ok(!statusesClear.includes('synced'), 'offline clear is not reported as synced');
  assert.equal((await req('GET', 'profiles/' + conId)).body.data.calibrations['id:red'].td, 4.4, 'server untouched while offline');
  lsCon.setItem('chromastack.api-base', BASE);
  await CS.profiles.flush(false);
  assert.equal((await req('GET', 'profiles/' + conId)).body.data.calibrations['id:red'], undefined, 'pending clear reaches the server after reconnect');
  assert.ok(statusesClear.includes('synced'), 'clear confirms after the server acknowledges');

  /* ---- calibration backup survives an accidental reset ---- */
  CS.settings.save(localRed);
  await CS.profiles.flush(false);
  const backup = CS.profiles.backupActive('test');
  assert.ok(backup && CS.profiles.lastBackup(), 'backup is stored locally');
  await CS.profiles.clearActive();
  assert.equal((await req('GET', 'profiles/' + conId)).body.data.calibrations['id:red'], undefined, 'reset cleared the server');
  const restored = await CS.profiles.restoreBackup();
  assert.equal(restored.calibrations['id:red'].td, 4.4, 'backup restores the calibration');
  assert.equal((await req('GET', 'profiles/' + conId)).body.data.calibrations['id:red'].td, 4.4, 'restored data reached the server');

  /* ---- a mirror from another profile is never loaded ---- */
  const lsMix = makeLocalStorage();
  lsMix.setItem('chromastack.api-base', 'http://127.0.0.1:1/');
  lsMix.setItem('chromastack.active-profile.v1', 'p-x');
  lsMix.setItem(CS.profiles.MIRROR_KEY, JSON.stringify({
    profileId: 'p-y', revision: 2,
    data: { calibrations: { 'id:blue': { td: 2.2 } }, lutTdOverrides: {}, lutHexOverrides: {} },
    updatedAt: Date.now()
  }));
  CS = loadBrowserModules(lsMix);
  const mixed = await CS.profiles.init();
  assert.deepEqual(mixed.calibrations, {}, 'mirror for another profile is ignored');
  console.log('profile concurrency checks passed');

  /* ---- P1/C08: profile-v2 calibration block round-trips; unknown schema rejected ---- */
  const v2prof = (await req('POST', 'profiles', { name: 'v2', data: {} })).body;
  const goodV2 = { schemaVersion: 2, materials: { k: { hex: '#000000' } }, models: [{ modelId: 'm1', params: { k: { hdR: 0.04 } }, status: 'published' }], activeModelId: 'm1', observations: [{ sessionId: 's1', manifestHash: 'abc' }], legacyIndex: {} };
  const r2 = await req('PUT', 'profiles/' + v2prof.id, { data: { calibrationV2: goodV2 }, expectedRevision: v2prof.revision });
  assert.equal(r2.status, 200, 'valid v2 accepted');
  const back = (await req('GET', 'profiles/' + v2prof.id)).body;
  assert.deepEqual(back.data.calibrationV2, goodV2, 'v2 round-trips without field loss');
  const badSchema = await req('PUT', 'profiles/' + v2prof.id, { data: { calibrationV2: { schemaVersion: 99 } }, expectedRevision: back.revision });
  assert.equal(badSchema.status, 400, 'unknown schema rejected');
  const badActive = await req('PUT', 'profiles/' + v2prof.id, { data: { calibrationV2: { schemaVersion: 2, models: [], activeModelId: 'nope' } }, expectedRevision: back.revision });
  assert.equal(badActive.status, 400, 'dangling activeModelId rejected');
  const still = (await req('GET', 'profiles/' + v2prof.id)).body;
  assert.deepEqual(still.data.calibrationV2, goodV2, 'rejected writes do not clobber stored v2');
  console.log('profile-v2 schema checks passed');
} finally {
  server.kill();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}
console.log('all calibration-profile checks passed');
process.exit(0);