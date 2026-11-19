/* R5: an offline calibration draft must survive a client restart. The draft is
   persisted per profile (baseRevision, editVersion, data, op incl. pending
   clear); init protects it BEFORE adopting server data — conditional commit
   when the server is unchanged, conflict (both sides kept) when it changed.
   Only the matching draft's successful commit deletes it. Real Promise
   transport with a persistent server model and a toggleable offline flag;
   "restart" = re-run the module IIFE against the SAME localStorage.
   Run: node tests/test-profile-draft.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const DRAFT_KEY = 'chromastack.pending-drafts.v1';
const empty = () => ({ calibrations: {}, lutTdOverrides: {}, lutHexOverrides: {} });
const clone = v => JSON.parse(JSON.stringify(v));
const cal = (id, td) => ({ calibrations: { ['id:' + id]: { id, name: id, hex: '#000000', td } }, lutTdOverrides: {}, lutHexOverrides: {} });
const tdOf = (data, id) => data && data.calibrations && data.calibrations['id:' + id] ? data.calibrations['id:' + id].td : undefined;

let timers = new Map(); let tid = 0;
globalThis.setTimeout = (fn) => { const id = ++tid; timers.set(id, fn); return id; };
globalThis.clearTimeout = (id) => { timers.delete(id); };
function fireTimers() { const fns = [...timers.values()]; timers.clear(); for (const f of fns) f(); }
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
  // A restart kills every in-page timer of the old instance; only localStorage
  // survives. Without this, orphaned debounce timers from earlier scenarios
  // would fire into this world through the shared global fetch stub.
  timers.clear();
  delete globalThis.CS;
  globalThis.localStorage = ls;
  globalThis.fetch = world.fetchStub;
  for (const m of ['../app/js/profiles.js', '../app/js/settings.js']) {
    const resolved = require.resolve(m); delete require.cache[resolved]; require(resolved);
  }
  return globalThis.CS;
}
const mirrorOf = (ls, CS) => JSON.parse(ls.getItem(CS.profiles.MIRROR_KEY));
const draftsOf = ls => { try { return JSON.parse(ls.getItem(DRAFT_KEY)) || {}; } catch (e) { return {}; } };
const saveTd = (CS, id, td) => CS.settings.save({ tdPalette: [{ id, name: id, hex: '#000000', td, brand: 'T', material: 'PLA' }], filamentCalibrations: {}, lutTdOverrides: {}, lutHexOverrides: {} });

/* Transport plumbing only: init may conditionally commit a draft and
   resolveConflict('local') writes, but this harness defers every PUT until
   explicit delivery. Deliver whatever the call issues, then await it.
   All acceptance assertions below are unchanged. */
async function drainPuts(world, id) {
  let put;
  while ((put = world.putsFor(id)[0])) { world.deliver(put); await settle(); }
}
async function runInit(CS, world, id) {
  const p = CS.profiles.init();
  await settle();
  await drainPuts(world, id);
  return p;
}
async function runResolveLocal(CS, world, id) {
  const p = CS.profiles.resolveConflict('local');
  await settle();
  await drainPuts(world, id);
  return p;
}

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

/* ===== 1. offline edit (known base) -> restart online, server unchanged ===== */
{
  const world = makeWorld();
  const P = world.server.create('P', empty());
  const ls = makeLocalStorage(); ls.setItem('chromastack.active-profile.v1', P.id);
  let CS = loadModules(ls, world);
  await CS.profiles.init();                 // online: knows P rev1
  world.offline = true;
  saveTd(CS, 'petg', 3.3);                  // offline edit -> draft + mirror
  await settle();
  check('1 offline draft persisted', !!draftsOf(ls)[P.id] && tdOf(draftsOf(ls)[P.id].data, 'petg') === 3.3, `draft=${JSON.stringify(draftsOf(ls)[P.id] && draftsOf(ls)[P.id].data)}`);
  // restart: same storage, network back, server still rev1 empty
  CS = loadModules(ls, world); world.offline = false;
  const data = await runInit(CS, world, P.id); await settle();
  check('1 draft committed on reconnect', tdOf(world.server.get(P.id).data, 'petg') === 3.3, `server=${tdOf(world.server.get(P.id).data, 'petg')}`);
  check('1 returned data keeps the edit', tdOf(data, 'petg') === 3.3, `returned=${tdOf(data, 'petg')}`);
  check('1 mirror keeps the edit', tdOf(mirrorOf(ls, CS).data, 'petg') === 3.3);
  check('1 draft removed after commit', !draftsOf(ls)[P.id], `draft=${JSON.stringify(draftsOf(ls)[P.id])}`);
  check('1 no conflict', !CS.profiles.hasConflict());
}

/* ===== 2. offline edit from start (unknown base) -> restart, draft preserved ===== */
{
  const world = makeWorld();
  const P = world.server.create('P', empty());
  const ls = makeLocalStorage(); ls.setItem('chromastack.active-profile.v1', P.id);
  world.offline = true;
  let CS = loadModules(ls, world);
  await CS.profiles.init();                 // offline from start: revision unknown
  saveTd(CS, 'petg', 3.3); await settle();
  CS = loadModules(ls, world); world.offline = false;
  const data = await runInit(CS, world, P.id); await settle();
  const m = mirrorOf(ls, CS);
  check('2 draft not silently lost', tdOf(data, 'petg') === 3.3 || CS.profiles.hasConflict(), `returned=${tdOf(data, 'petg')} conflict=${CS.profiles.hasConflict()}`);
  check('2 mirror not emptied by server', tdOf(m.data, 'petg') === 3.3, `mirror=${tdOf(m.data, 'petg')}`);
  check('2 server not blindly overwritten', tdOf(world.server.get(P.id).data, 'petg') === undefined || CS.profiles.hasConflict() === false);
  check('2 draft still persisted until resolved', !!draftsOf(ls)[P.id] || tdOf(world.server.get(P.id).data, 'petg') === 3.3);
  if (CS.profiles.hasConflict()) {
    const kept = await runResolveLocal(CS, world, P.id); await settle();
    check('2 local resolution commits the draft', tdOf(kept, 'petg') === 3.3 && tdOf(world.server.get(P.id).data, 'petg') === 3.3);
    check('2 draft removed after resolution', !draftsOf(ls)[P.id]);
  }
}

/* ===== 3. offline clear -> restart online, server unchanged: clear must win ===== */
{
  const world = makeWorld();
  const P = world.server.create('P', cal('red', 4.4));   // server rev1 holds red
  const ls = makeLocalStorage(); ls.setItem('chromastack.active-profile.v1', P.id);
  let CS = loadModules(ls, world);
  await CS.profiles.init();                 // online: loads red rev1
  world.offline = true;
  await CS.profiles.clearActive();          // offline clear -> pending-clear draft
  await settle();
  const d = draftsOf(ls)[P.id];
  check('3 pending-clear draft recorded', !!d && d.op === 'clear' && tdOf(d.data, 'red') === undefined, `draft=${JSON.stringify(d)}`);
  CS = loadModules(ls, world); world.offline = false;
  const data = await runInit(CS, world, P.id); await settle();
  check('3 clear intent reaches server', tdOf(world.server.get(P.id).data, 'red') === undefined, `server red=${tdOf(world.server.get(P.id).data, 'red')}`);
  check('3 clear intent not revived', tdOf(data, 'red') === undefined && tdOf(CS.profiles.cachedData(), 'red') === undefined);
  check('3 clear draft removed after commit', !draftsOf(ls)[P.id]);
}

/* ===== 4. offline edit, server changed meanwhile -> conflict keeps both ===== */
{
  const world = makeWorld();
  const P = world.server.create('P', empty());
  const ls = makeLocalStorage(); ls.setItem('chromastack.active-profile.v1', P.id);
  let CS = loadModules(ls, world);
  await CS.profiles.init();                 // online rev1
  world.offline = true;
  saveTd(CS, 'petg', 3.3); await settle();  // draft base rev1
  world.server.bump(P.id, cal('blue', 2.2)); // other device -> rev2 blue
  CS = loadModules(ls, world); world.offline = false;
  const data = await runInit(CS, world, P.id); await settle();
  check('4 conflict surfaced', CS.profiles.hasConflict(), `conflict=${CS.profiles.hasConflict()}`);
  check('4 local draft preserved', tdOf(data, 'petg') === 3.3 && tdOf(mirrorOf(ls, CS).data, 'petg') === 3.3);
  check('4 server data not overwritten', tdOf(world.server.get(P.id).data, 'blue') === 2.2 && tdOf(world.server.get(P.id).data, 'petg') === undefined);
  check('4 draft persisted during conflict', !!draftsOf(ls)[P.id]);
  const adopted = await CS.profiles.resolveConflict('server'); await settle();
  check('4 server resolution adopts server', tdOf(adopted, 'blue') === 2.2 && !CS.profiles.hasConflict());
  check('4 draft removed after resolution', !draftsOf(ls)[P.id]);
}

/* ===== 5. edit right after a commit: old success must not delete the new draft ===== */
{
  const world = makeWorld();
  const P = world.server.create('P', empty());
  const ls = makeLocalStorage(); ls.setItem('chromastack.active-profile.v1', P.id);
  const CS = loadModules(ls, world);
  await CS.profiles.init();
  saveTd(CS, 'white', 4.4);                 // draft v1
  fireTimers(); await settle();
  const put1 = world.putsFor(P.id)[0];
  saveTd(CS, 'white', 5.5);                 // draft v2 while v1 in flight
  await settle();
  check('5 newer draft persisted', draftsOf(ls)[P.id] && tdOf(draftsOf(ls)[P.id].data, 'white') === 5.5);
  world.deliver(put1); await settle();      // old commit succeeds
  check('5 old commit keeps newer draft', !!draftsOf(ls)[P.id] && tdOf(draftsOf(ls)[P.id].data, 'white') === 5.5, `draft=${JSON.stringify(draftsOf(ls)[P.id] && draftsOf(ls)[P.id].data)}`);
  CS.profiles.flush(false); fireTimers(); await settle();
  const put2 = world.putsFor(P.id)[0];
  world.deliver(put2); await settle();
  check('5 newer draft committed and removed', tdOf(world.server.get(P.id).data, 'white') === 5.5 && !draftsOf(ls)[P.id], `server=${tdOf(world.server.get(P.id).data, 'white')} draft=${JSON.stringify(draftsOf(ls)[P.id])}`);
}

console.log(failures ? `R5: ${failures} acceptance failures` : 'all R5 offline-draft checks passed');
process.exit(failures ? 1 : 0);