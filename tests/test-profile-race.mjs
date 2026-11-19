/* R4: calibration requests must be bound to their profile + session + draft
   version. A response that arrives after the active profile changed (or after
   a newer local edit) must never write into the new session's mirror/revision.
   Uses a REAL Promise-based transport whose completion timing is controlled
   (writes apply on receipt; the response is delivered on demand) and stubbed
   timers so the debounce is deterministic — not a synchronous mock.
   Run: node tests/test-profile-race.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const empty = () => ({ calibrations: {}, lutTdOverrides: {}, lutHexOverrides: {} });
const clone = v => JSON.parse(JSON.stringify(v));
const cal = (id, td) => ({ calibrations: { ['id:' + id]: { id, name: id, hex: '#000000', td } }, lutTdOverrides: {}, lutHexOverrides: {} });
const tdOf = (data, id) => data && data.calibrations && data.calibrations['id:' + id] ? data.calibrations['id:' + id].td : undefined;

/* ---- controllable timers (debounce never auto-fires) ---- */
let timers = new Map(); let tid = 0;
globalThis.setTimeout = (fn) => { const id = ++tid; timers.set(id, fn); return id; };
globalThis.clearTimeout = (id) => { timers.delete(id); };
function fireTimers() { const fns = [...timers.values()]; timers.clear(); for (const f of fns) f(); }
const tick = () => new Promise(r => setImmediate(r));
async function settle() { for (let i = 0; i < 12; i++) await tick(); }

/* ---- in-memory server model + controllable fetch ---- */
function makeWorld() {
  const profiles = new Map(); let seq = 0;
  const puts = [];
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
  function fetchStub(url, opts = {}) {
    const path = String(url).replace(/^https?:\/\/[^/]+\//, '').replace(/^api\//, '');
    const parts = path.split('/').filter(Boolean);
    const method = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    const r = handle(method, parts, body);
    if (method === 'PUT') {
      // The server already applied the write on receipt; only the response
      // delivery is delayed, exactly like a slow network round-trip.
      let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      const entry = { id: parts[1], body, status: r.status, payload: r.payload, resolve, reject, delivered: false };
      puts.push(entry);
      return promise;
    }
    return Promise.resolve(response(r.status, r.payload));
  }
  return {
    server, puts, fetchStub,
    putsFor(id) { return puts.filter(p => p.id === id && !p.delivered); },
    deliver(entry) { entry.delivered = true; entry.resolve(response(entry.status, entry.payload)); },
    fail(entry, err) { entry.delivered = true; entry.reject(err || new Error('network down')); }
  };
}

function makeLocalStorage() {
  const store = new Map();
  return { store, getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
}
function loadModules(ls, world) {
  delete globalThis.CS;
  globalThis.localStorage = ls;
  globalThis.fetch = world.fetchStub;
  for (const m of ['../app/js/profiles.js', '../app/js/settings.js']) {
    const resolved = require.resolve(m);
    delete require.cache[resolved];
    require(resolved);
  }
  return globalThis.CS;
}
const mirrorOf = (ls, CS) => JSON.parse(ls.getItem(CS.profiles.MIRROR_KEY));
function setup(pointerName) {
  const world = makeWorld();
  const A = world.server.create('A', empty());
  const B = world.server.create('B', empty());
  const ls = makeLocalStorage();
  const pointer = pointerName === 'A' ? A : B;
  ls.setItem('chromastack.active-profile.v1', pointer.id);
  const CS = loadModules(ls, world);
  const statuses = [];
  CS.profiles.onStatus = s => statuses.push(s);
  return { world, ls, CS, A, B, statuses };
}
const saveTd = (CS, id, td) => CS.settings.save({ tdPalette: [{ id, name: id, hex: '#000000', td, brand: 'T', material: 'PLA' }], filamentCalibrations: {}, lutTdOverrides: {}, lutHexOverrides: {} });

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

/* ===== 1. background B push in flight, then switchTo(A): must serialize ===== */
{
  const { world, ls, CS, A, B } = setup('B');
  await CS.profiles.init();
  saveTd(CS, 'white', 4.4);
  fireTimers();                       // debounce fires -> B PUT in flight
  await settle();
  const bPut = world.putsFor(B.id)[0];
  check('1 precondition B PUT in flight', !!bPut && CS.profiles.activeId() === B.id);
  const sw = CS.profiles.switchTo(A.id);   // must wait for the in-flight B push
  await settle();
  const waited = CS.profiles.activeId() === B.id;
  world.deliver(bPut);
  const switched = await sw;
  await settle();
  const m = mirrorOf(ls, CS);
  check('1 switch waits for in-flight push', waited, `activeId before deliver=${waited ? 'B (waiting)' : 'A (ran ahead)'}`);
  check('1 mirror belongs to A after switch', m.profileId === A.id && tdOf(m.data, 'white') === undefined, `mirror profile=${m.profileId} white=${tdOf(m.data, 'white')}`);
  check('1 revision is A server revision', CS.profiles.revision() === world.server.get(A.id).revision, `client=${CS.profiles.revision()} server=${world.server.get(A.id).revision}`);
  check('1 switched data is A empty', tdOf(switched, 'white') === undefined);
  // a normal subsequent A edit must not raise a false conflict
  saveTd(CS, 'red', 3);
  fireTimers(); await settle();
  const aPut = world.putsFor(A.id)[0];
  world.deliver(aPut); await settle();
  check('1 no false conflict on next A edit', !CS.profiles.hasConflict() && tdOf(world.server.get(A.id).data, 'red') === 3, `conflict=${CS.profiles.hasConflict()}`);
}

/* ===== 2. keepalive B push not awaited, re-init to A, B returns late ===== */
{
  const { world, ls, CS, A, B } = setup('B');
  await CS.profiles.init();
  saveTd(CS, 'white', 4.4);
  const kp = CS.profiles.flush(true);   // keepalive push, deliberately not awaited
  await settle();
  const bPut = world.putsFor(B.id)[0];
  ls.setItem('chromastack.active-profile.v1', A.id);
  await CS.profiles.init();             // new session loads A while B still in flight
  await settle();
  world.deliver(bPut);                  // stale B response arrives under session A
  await kp; await settle();
  const m = mirrorOf(ls, CS);
  check('2 stale B response does not pollute A mirror', m.profileId === A.id && tdOf(m.data, 'white') === undefined, `mirror profile=${m.profileId} white=${tdOf(m.data, 'white')}`);
  check('2 revision stays A', CS.profiles.revision() === world.server.get(A.id).revision, `client=${CS.profiles.revision()}`);
  check('2 cached data is A empty', tdOf(CS.profiles.cachedData(), 'white') === undefined);
}

/* ===== 3. a newer edit during upload must not be reverted by the old success ===== */
{
  const { world, ls, CS, B } = setup('B');
  await CS.profiles.init();
  saveTd(CS, 'white', 4.4);             // draft 1
  fireTimers(); await settle();
  const put1 = world.putsFor(B.id)[0];
  saveTd(CS, 'white', 5.5);             // draft 2 edited while draft 1 in flight
  await settle();
  world.deliver(put1);                  // old success arrives
  await settle();
  check('3 cached data keeps newest draft', tdOf(CS.profiles.cachedData(), 'white') === 5.5, `cached=${tdOf(CS.profiles.cachedData(), 'white')}`);
  const m = mirrorOf(ls, CS);
  check('3 mirror keeps newest draft', tdOf(m.data, 'white') === 5.5, `mirror=${tdOf(m.data, 'white')}`);
  CS.profiles.flush(false); fireTimers(); await settle();
  const put2 = world.putsFor(B.id)[0];
  check('3 newer draft is pushed', !!put2 && put2.body.expectedRevision === 2, `expectedRevision=${put2 && put2.body.expectedRevision}`);
  world.deliver(put2); await settle();
  check('3 server ends at newest draft', tdOf(world.server.get(B.id).data, 'white') === 5.5 && CS.profiles.revision() === 3, `server=${tdOf(world.server.get(B.id).data, 'white')} rev=${CS.profiles.revision()}`);
}

/* ===== 4. a stale 409 from the old profile must not create a conflict on A ===== */
{
  const { world, ls, CS, A, B } = setup('B');
  await CS.profiles.init();
  world.server.bump(B.id, cal('blue', 2.2));   // another device advances B to rev2
  saveTd(CS, 'white', 4.4);                    // local draft still based on rev1
  const kp = CS.profiles.flush(true);
  await settle();
  const bPut = world.putsFor(B.id)[0];
  check('4 precondition B PUT will 409', bPut && bPut.status === 409, `status=${bPut && bPut.status}`);
  ls.setItem('chromastack.active-profile.v1', A.id);
  await CS.profiles.init();
  await settle();
  world.deliver(bPut);                         // stale 409 arrives under session A
  await kp.catch(() => {}); await settle();
  const m = mirrorOf(ls, CS);
  check('4 no conflict imported into A', !CS.profiles.hasConflict(), `conflict=${CS.profiles.hasConflict()}`);
  check('4 A mirror untouched', m.profileId === A.id && tdOf(m.data, 'white') === undefined, `mirror white=${tdOf(m.data, 'white')}`);
  check('4 revision stays A', CS.profiles.revision() === world.server.get(A.id).revision, `client=${CS.profiles.revision()}`);
}

console.log(failures ? `R4: ${failures} acceptance failures` : 'all R4 profile-race checks passed');
process.exit(failures ? 1 : 0);