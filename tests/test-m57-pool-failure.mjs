/* R3 contract: a failed plan-worker must be marked permanently dead so later calls
   reject immediately (not hang to the outer timeout); calls have their own timeout;
   destroy() rejects in-flight calls. Run: node tests/test-m57-pool-failure.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

class MockWorker {
  constructor(url) { this.url = url; this.onmessage = null; this.onerror = null; this.fail = false; this.silent = false; }
  postMessage(msg) {
    if (this.fail) { setTimeout(() => this.onerror && this.onerror({ message: 'script load failed' }), 0); return; }
    if (this.silent) return; // never replies -> per-call timeout
    setTimeout(() => this.onmessage && this.onmessage({ data: { id: msg.id, ok: true } }), 0);
  }
  terminate() {}
}

const ctx = vm.createContext({ console, setTimeout, clearTimeout, Worker: MockWorker });
ctx.globalThis = ctx;
vm.runInContext(fs.readFileSync(path.join(root, 'app', 'js', 'parallel.js'), 'utf8'), ctx);
const CS = ctx.CS;

const pool = CS.parallel.makePool(f => f, 2, 200);

/* normal call resolves */
const ok = await pool.call(1, { op: 'ping' });
assert.equal(ok.ok, true);

/* worker 0 errors -> the in-flight call rejects */
pool.workers[0].fail = true;
await assert.rejects(() => pool.call(0, { op: 'x' }), /failed/);

/* R3 core: a later call to the dead worker rejects FAST, not after the timeout */
const t0 = Date.now();
await assert.rejects(() => pool.call(0, { op: 'y' }), /permanently failed/);
assert.ok(Date.now() - t0 < 100, 'dead-worker call must reject immediately, took ' + (Date.now() - t0) + 'ms');

/* per-call timeout: a silent worker rejects after the call timeout */
pool.workers[1].silent = true;
await assert.rejects(() => pool.call(1, { op: 'z' }), /timeout|unresponsive/);

/* destroy rejects in-flight calls */
const pool2 = CS.parallel.makePool(f => f, 1, 5000);
pool2.workers[0].silent = true;
const inflight = pool2.call(0, { op: 'pending' });
pool2.destroy();
await assert.rejects(() => inflight, /destroyed/);

pool.destroy();
console.log('all pool failure-recovery checks passed');