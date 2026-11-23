/* GPU5 contract: a deploy must not leave returning users on a stale cached worker.
   The worker script URL and every importScripts dep carry the app asset version,
   derived from the worker's own location.search. Run: node tests/test-m51-worker-cache.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/* Load a worker with a stubbed importScripts that records the requested URLs.
   location.search simulates the version query app.js appends to the worker URL. */
function importUrls(file, search) {
  const urls = [];
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout,
    location: { search },
    importScripts: (...files) => { urls.push(...files); },
    postMessage: () => {}
  });
  ctx.self = ctx;
  vm.runInContext(fs.readFileSync(path.join(root, 'app', 'js', file), 'utf8'), ctx);
  return urls;
}

const workers = ['compute-worker.js', 'mesh-worker.js'];

/* With a version query every dependency must be cache-busted with that version. */
for (const f of workers) {
  const urls = importUrls(f, '?v=TESTV123');
  assert.ok(urls.length > 0, f + ' imports engine scripts');
  for (const u of urls) {
    assert.ok(u.endsWith('?v=TESTV123'), f + ' dep must carry version, got: ' + u);
  }
}

/* Without a version (dev / file:) bare filenames still resolve. */
for (const f of workers) {
  const urls = importUrls(f, '');
  assert.ok(urls.length > 0, f + ' imports engine scripts');
  for (const u of urls) {
    assert.ok(!u.includes('?v='), f + ' no version -> bare filename, got: ' + u);
  }
}

/* app.js must build both worker URLs with the asset version, not bare filenames. */
const appSrc = fs.readFileSync(path.join(root, 'app', 'js', 'app.js'), 'utf8');
assert.ok(!/new Worker\('js\/compute-worker\.js'\)/.test(appSrc), 'compute worker URL must be versioned');
assert.ok(!/new Worker\('js\/mesh-worker\.js'\)/.test(appSrc), 'mesh worker URL must be versioned');
assert.ok(/script\[src\*="js\/app\.js"\]/.test(appSrc), 'app.js derives version from its own script tag');

console.log('all worker cache-busting checks passed');