/* R6: restoring a calibration backup is a user action, but a 409 means another
   device advanced the profile. The client must keep BOTH the backup and the
   remote version, enter the existing conflict UI, and never auto-upgrade to the
   latest revision to retry. Only after the user re-checks and confirms may the
   backup overwrite; if the remote moved again since the conflict was shown, it
   must conflict again instead of silently overwriting the newer remote data.
   Real Promise transport with a persistent server model; PUTs are deferred until
   explicitly delivered so we can count exactly how many writes the client issues.
   Run: node tests/test-profile-restore-conflict.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const empty = () => ({ calibrations: {}, lutTdOverrides: {}, lutHexOverrides: {} });
const clone = v => JSON.parse(JSON.stringify(v));
const cal = (id, td) => ({ calibrations: { ['id:' + id]: { id, name: id, hex: '#000000', td } }, lutTdOverrides: {}, lutHexOverrides: {} });
const tdOf = (data, id) => data && data.calibrations && data.calibrations['id:' + id] ? data.calibrations['id:' + id].td : undefined;

let timers = new Map(); let tid = 0;
globalThis.setTimeout = (fn) => { const id = ++tid; timers.set(id, fn); return id; };
globalThis.clearTimeout = (id) => { timers.delete(id); };
const tick = () => new Promise(r => setImmediate(r));
async function settle() { for (let i = 0; i < 12; i++) await tick(); }

function makeWorld() {
  const profiles = new Map(); let seq = 0; const puts = [];
  const sanitize = d => { const out = empty(); for (const k of Object.keys(out)) { const v = d && d[k]; if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = v; } return out; };
  const full = p => ({ id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt, revision: p.revision, data: clone(p.data) });
  const meta = p => ({ id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt, revision: p.revision });
  const server = {
    create(name, data) { const id = 'p-' + (++seq); const now = Date.now(); const p = { id, name: (name || '默认标定').trim(), createdAt: now, updatedAt: now, revision: 1, data: sanitize(data) }; profiles.set(id, p); return p; },
    get(id) { return profiles.get(id) || null; },
    bump(id, data) { const p = profiles.get(id); p.revision++; p.data = sanitize(data); p.updatedAt = Date.now(); return p; }
  };
  function handle(method, parts, body) {
    if (parts[0] === 'profiles' && parts.length === 1) {
      if (method === 'GET') return { status: 200, payload: { profiles: [...profiles.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).map(meta) } };
      if (method === 'POST') return { status: 201, payload: full(server.create(body.name, body.data)) };
    }
    if (parts[0] === 'profiles' && parts.length === 2) {
      const id = parts[1]; const p = profiles.get(id);
      if (method === 'GET') return p ? { status: 200, payload: full(p) } : { status: 404, payload: { error: 'profile 不存在' } };
      if (method === 'DELETE') { if (!p) return { status: 404, payload: { error: 'profile 不存在' } }; profiles.delete(id); return { status: 200, payload: { ok: true } }; }
      if (method === 'PUT') {
        if (!p) return { status: 404, payload: { error: 'profile 不存在' } };
        const rev = p.revision || 1; const expected = body.expectedRevision;
        if (expected != null && Number(expected) !== rev) return { status: 409, payload: { error: 'profile 已被其他设备修改', revision: rev, name: p.name, updatedAt: p.updatedAt } };
        if (body.data !== undefined && expected == null) return { status: 428, payload: { error: '缺少 expectedRevision', revision: rev } };
        if (body.name !== undefined) p.name = body.name.trim();
        if (body.data !== undefined) p.data = sanitize(body.data);
        p.revision = rev + 1; p.updatedAt = Date.now();
        return { status: 200, payload: full(p) };
      }
    }
    return { status: 404, payload: { error: 'not found' } };
  }
  const response = (status, payload) => ({ ok: status < 400, status, json: async () => payload });
  const world = {
    server, puts, offline: false,
    putsFor(id) { return puts.filter(p => p.id === id && !p.delivered); },
    deliver(entry) { entry.delivered = true; entry.resolve(response(entry.status, entry.payload)); },
    fetchStub(url, opts = {}) {
      if (world.offline) return Promise.reject(new Error('offline'));
      const path = String(url).replace(/^https?:\/\/[^/]+\//, '').replace(/^api\//, '');
      const parts = path.split('/').filter(Boolean);
      const method = (opts.method || 'GET').toUpperCase();
      const body = opts.body ? JSON.parse(opts.body) : undefined;
      const r = handle(method, parts, body);
      if (method === 'PUT') {
        let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        const entry = { id: parts[1], body, status: r.status, payload: r.payload, resolve, reject, delivered: false };
        puts.push(entry); return promise;
      }
      return Promise.resolve(response(r.status, r.payload));
    }
  };
  return world;
}
function makeLocalStorage() {
  const store = new Map();
  return { store, getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
}
function loadModules(ls, world) {
  timers.clear();
  delete globalThis.CS;
  globalThis.localStorage = ls;
  globalThis.fetch = world.fetchStub;
  for (const m of ['../app/js/profiles.js', '../app/js/settings.js']) {
    const resolved = require.resolve(m); delete require.cache[resolved]; require(resolved);
  }
  return globalThis.CS;
}
async function drainPuts(world, id) { let put; while ((put = world.putsFor(id)[0])) { world.deliver(put); await settle(); } }

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

/* Build a client whose local backup is old=2.2 while another device has already
   written other=7.7, so the restore's conditional write is stale (409). */
async function setupRestoreConflict() {
  const world = makeWorld();
  const P = world.server.create('P', cal('old', 2.2));   // rev1 holds the backup source
  const ls = makeLocalStorage(); ls.setItem('chromastack.active-profile.v1', P.id);
  const CS = loadModules(ls, world);
  await CS.profiles.init();                              // online: knows rev1, lastData=old
  const statuses = []; CS.profiles.onStatus = s => statuses.push(s);
  const backup = CS.profiles.backupActive('test');       // backup old=2.2 @ rev1
  world.server.bump(P.id, cal('other', 7.7));            // another device -> rev2 other=7.7
  return { world, P, ls, CS, statuses, backup };
}

/* ===== 1. first 409: no second auto PUT, server keeps other, conflict shown ===== */
{
  const { world, P, CS, statuses, backup } = await setupRestoreConflict();
  const restoreP = CS.profiles.restoreBackup();
  await settle();
  await drainPuts(world, P.id);                          // deliver the single stale PUT (409)
  const returned = await restoreP;
  await settle();
  const srv = world.server.get(P.id);
  check('1 exactly one PUT issued (no auto retry)', world.puts.length === 1, `puts=${world.puts.length}`);
  check('1 server still holds the other device data', tdOf(srv.data, 'other') === 7.7 && tdOf(srv.data, 'old') === undefined, `server=${JSON.stringify(srv.data.calibrations)} rev=${srv.revision}`);
  check('1 conflict surfaced', CS.profiles.hasConflict() && statuses.includes('conflict'), `conflict=${CS.profiles.hasConflict()} statuses=${statuses.join(',')}`);
  check('1 conflict keeps the backup as local side', tdOf(CS.profiles.conflictInfo() && CS.profiles.cachedData(), 'old') === 2.2, `cached=${JSON.stringify(CS.profiles.cachedData().calibrations)}`);
  check('1 conflict records the remote revision', CS.profiles.conflictInfo() && CS.profiles.conflictInfo().serverRevision === srv.revision, `serverRevision=${CS.profiles.conflictInfo() && CS.profiles.conflictInfo().serverRevision} remote=${srv.revision}`);
  check('1 backup is preserved', !!CS.profiles.lastBackup() && tdOf(CS.profiles.lastBackup().data, 'old') === 2.2);
  check('1 restore reports no silent success', returned == null, `returned=${JSON.stringify(returned && returned.calibrations)}`);
}

/* ===== 2. user confirms while remote unchanged: backup overwrites once ===== */
{
  const { world, P, CS } = await setupRestoreConflict();
  const restoreP = CS.profiles.restoreBackup(); await settle(); await drainPuts(world, P.id); await restoreP; await settle();
  const before = world.puts.length;
  const keptP = CS.profiles.resolveConflict('local'); await settle(); await drainPuts(world, P.id);
  const kept = await keptP; await settle();
  const srv = world.server.get(P.id);
  check('2 confirmation issues exactly one write', world.puts.length === before + 1, `puts=${world.puts.length} before=${before}`);
  check('2 confirmed backup reached the server', tdOf(srv.data, 'old') === 2.2 && tdOf(srv.data, 'other') === undefined, `server=${JSON.stringify(srv.data.calibrations)}`);
  check('2 conflict cleared after confirmation', !CS.profiles.hasConflict() && tdOf(kept, 'old') === 2.2);
}

/* ===== 3. remote moves again after the conflict: confirm must re-conflict ===== */
{
  const { world, P, CS } = await setupRestoreConflict();
  const restoreP = CS.profiles.restoreBackup(); await settle(); await drainPuts(world, P.id); await restoreP; await settle();
  const putsAfterRestore = world.puts.length;
  world.server.bump(P.id, cal('other2', 9.9));           // remote advances again -> rev3
  const keptP = CS.profiles.resolveConflict('local'); await settle(); await drainPuts(world, P.id);
  const kept = await keptP; await settle();
  const srv = world.server.get(P.id);
  check('3 re-conflict issues no write', world.puts.length === putsAfterRestore, `puts=${world.puts.length} afterRestore=${putsAfterRestore}`);
  check('3 newer remote data is not overwritten', tdOf(srv.data, 'other2') === 9.9 && tdOf(srv.data, 'old') === undefined, `server=${JSON.stringify(srv.data.calibrations)} rev=${srv.revision}`);
  check('3 conflict re-entered at the new revision', CS.profiles.hasConflict() && CS.profiles.conflictInfo().serverRevision === srv.revision && kept == null, `serverRevision=${CS.profiles.conflictInfo() && CS.profiles.conflictInfo().serverRevision} remote=${srv.revision}`);
  // A second confirmation against the now-stable remote finally overwrites.
  const kept2P = CS.profiles.resolveConflict('local'); await settle(); await drainPuts(world, P.id);
  const kept2 = await kept2P; await settle();
  const srv2 = world.server.get(P.id);
  check('3 second confirmation overwrites the stable remote', tdOf(srv2.data, 'old') === 2.2 && !CS.profiles.hasConflict() && tdOf(kept2, 'old') === 2.2, `server=${JSON.stringify(srv2.data.calibrations)}`);
}

console.log(failures ? `R6: ${failures} acceptance failures` : 'all R6 backup-restore conflict checks passed');
process.exit(failures ? 1 : 0);