/* F-EXP-02 contract: export3MF must only fall back to the serial compat path for a
   Worker-unsupported/startup failure. Runtime mesh/assembly errors and timeouts must
   STOP (no full main-thread recompute). Extracts export3MF from app.js and runs it with
   stubbed dependencies, counting serial build3MFBlobAsync calls per error class.
   Run: node tests/test-m63-export-fallback-class.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(root, 'app', 'js', 'app.js'), 'utf8');
const start = src.indexOf('function export3MF()');
const end = src.indexOf('function exportPreview()');
assert.ok(start >= 0 && end > start, 'export3MF found');
const fnSrc = src.slice(start, end);

async function runCase(makeErr, expectSerial) {
  let serialCalls = 0, downloaded = 0, pending = null;
  const ctx = vm.createContext({
    console,
    state: { plan: { w: 10, h: 10 }, dirty: false, analyzing: false },
    toast: () => {}, showProgress: () => {}, hideProgress: () => {},
    downloadBlob: () => { downloaded++; }, filenameBase: () => 'x', exportConfirmMessage: () => null,
    X: {
      build3MFBlobAsync: async () => { serialCalls++; return { blob: {}, exportChange: null }; },
      exportGridFor: () => ({ downscaled: false, width: 10, height: 10 })
    },
    build3MFParallel: async () => { throw makeErr(); },
    Worker: function () {}, location: { protocol: 'http:' }, window: { confirm: () => true },
    setTimeout: (fn) => { pending = fn; }
  });
  ctx.globalThis = ctx;
  vm.runInContext(fnSrc + '\nexport3MF();', ctx);
  assert.ok(pending, 'export scheduled');
  await pending();
  assert.equal(serialCalls, expectSerial, 'serial recompute count for ' + (makeErr().message || 'error'));
  return downloaded;
}

const tagged = (flag, msg) => () => { const e = new Error(msg); e[flag] = true; return e; };

/* startup failure -> serial compat fallback (1), downloads. */
assert.equal(await runCase(tagged('workerStartup', 'worker unsupported'), 1), 1);
/* runtime / timeout failures -> STOP, no serial recompute (0), no download. */
assert.equal(await runCase(tagged('meshRuntime', 'mesh algorithm error'), 0), 0);
assert.equal(await runCase(tagged('assemblyRuntime', 'assembly ok:false'), 0), 0);
assert.equal(await runCase(tagged('meshTimeout', 'mesh timeout'), 0), 0);
assert.equal(await runCase(tagged('exportTimeout', 'assembly timeout'), 0), 0);
/* untagged runtime error -> STOP (not treated as startup). */
assert.equal(await runCase(() => new Error('untagged runtime'), 0), 0);

console.log('all export fallback classification checks passed');